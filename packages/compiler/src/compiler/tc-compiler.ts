/**
 * LIR Generator for Type-C
 * Generates Low-Level Intermediate Representation from Type-C AST
 */

import { AstNode, AstUtils, LangiumDocument } from 'langium';
import * as ast from 'type-c-language/ast';
import { TypeCServices } from 'type-c-language';
import {
    BinaryOp,
    DataType,
    FunctionArg,
    LIRFunction,
    LIRProgram,
    UnaryOp,
    arrayType,
    basicType,
    boolLiteral,
    floatLiteral,
    intLiteral,
    nullableType,
    stringLiteral
} from '../ir/index.js';
import {
    TypeDescription,
    isGenericType,
    isArrayType,
    isNullableType,
    isTupleType,
    isReferenceType,
    isStructType,
    isFunctionType,
    isUnionType,
    isJoinType
} from 'type-c-language/types';
import {
    TypeCTypeProvider,
    MonomorphizationRegistry,
    TypeCTypeUtils
} from 'type-c-language/services';
import { FFIRegistery } from './ffi-registry.js';
import { GlobalVariablesRegistery } from './global-vars-registry.js';
import { CallableRegistry } from './callable-registry.js';
import { serializeFunction } from '../ir/serializer.js';

/**
 * Context for tracking code generation state
 */
interface GenerationContext {
    /** Current function being generated */
    currentFunction: LIRFunction | null;
    /** Variable name to LIR register mapping */
    variables: Map<string, string>;
    /** Counter for generating unique temporary variables */
    tempCounter: number;
    /** Counter for generating unique labels */
    labelCounter: number;
    /** Stack of loop contexts for break/continue */
    loopStack: Array<{ breakLabel: string; continueLabel: string }>;
    /** Current scope depth for variable naming */
    scopeDepth: number;
}

/**
 * Result of expression generation
 */
interface ExpressionResult {
    /** The register/variable name holding the result */
    register: string;
    /** The type of the result (optional) */
    type?: DataType;
}

/**
 * LIR Generator
 * Converts Type-C AST nodes into LIR instructions
 */
export class LIRGenerator {
    private program: LIRProgram;
    private context: GenerationContext;
    readonly typeProvider: TypeCTypeProvider;
    readonly monoMorph: MonomorphizationRegistry;
    readonly typeUtils: TypeCTypeUtils;

    ffiRegistery: FFIRegistery = new FFIRegistery();
    
    
    globalVariablesRegistry: GlobalVariablesRegistery = new GlobalVariablesRegistery()
    G(node: AstNode, name?: string){
        return this.globalVariablesRegistry.G(node, name)
    }

    callableRegistry!: CallableRegistry;
    /**
     * Get mangled name for a callable (function or method).
     * For generic callables, use the specific methods in callableRegistry instead.
     */
    C(node: AstNode, name?: string){
        return this.callableRegistry.C(node, name)
    }

    /**
     * Despite this being wrapped as a function, is it a global init entry that will be unwrapped from the function during
     * code gen later on
     */
    globalFunc: LIRFunction = new LIRFunction("$G", [], undefined);

    /**
     * Stack of generic substitutions.
     * Each entry maps generic parameter names to concrete types.
     * The stack allows nested generic contexts (e.g., generic class with generic methods).
     */
    private substitutionStack: Map<string, TypeDescription>[] = [];

    constructor(services: TypeCServices) {
        this.program = new LIRProgram();
        this.context = this.createContext();
        this.typeProvider = services.typing.TypeProvider;
        this.monoMorph = services.typing.MonomorphizationRegistry;
        this.typeUtils = services.typing.TypeUtils;
        this.callableRegistry = new CallableRegistry(this.monoMorph);
    }

    /**
     * Push a new substitution context onto the stack,
     * Used to generate generic functions/classes
     */
    private pushSubstitutions(substitutions: Map<string, TypeDescription>): void {
        this.substitutionStack.push(substitutions);
    }

    /**
     * Pop the current substitution context from the stack
     */
    private popSubstitutions(): void {
        this.substitutionStack.pop();
    }

    /**
     * Get the current active substitutions (merging all levels in the stack)
     */
    private getCurrentSubstitutions(): Map<string, TypeDescription> {
        if (this.substitutionStack.length === 0) {
            return new Map();
        }
        
        // Merge all substitutions from bottom to top (later entries override earlier ones)
        const merged = new Map<string, TypeDescription>();
        for (const subs of this.substitutionStack) {
            for (const [key, value] of subs.entries()) {
                merged.set(key, value);
            }
        }
        return merged;
    }

    /**
     * Get the type of an AST node with automatic generic substitution from the stack.
     *
     * This method:
     * 1. Gets the type from the type provider
     * 2. Applies substitutions from the current stack
     * 3. Validates that all generics are resolved
     * 4. Throws an error if any generic remains unresolved
     *
     * @param node The AST node to get the type for
     * @returns The fully resolved type with all generics substituted
     * @throws Error if any generic type parameters remain unresolved
     *
     * @example
     * ```typescript
     * // In context where T → u32
     * const type = this.getType(paramNode);  // Returns u32, not T
     * ```
     */
    private getType(node: AstNode): TypeDescription {
        // Get the type from the type provider
        const type = this.typeProvider.getType(node);
        

        if(isGenericType(type)){

            // Get current substitutions from stack
            const substitutions = this.getCurrentSubstitutions();
            
            // If we have substitutions, apply them
            if (substitutions.size > 0) {
                const resolvedType = this.typeUtils.substituteGenerics(type, substitutions);
                
                // Check if there are still unresolved generics
                const unresolvedGenerics = this.getUnresolvedGenerics(resolvedType);
                if (unresolvedGenerics.length > 0) {
                    throw new Error(
                        `Unresolved generic type parameters in ${node.$type}: ${unresolvedGenerics.join(', ')}. ` +
                        `Available substitutions: ${Array.from(substitutions.keys()).join(', ') || 'none'}`
                    );
                }
                
                return resolvedType;
            }
            
            // No substitutions - check if type contains any generics (which would be an error)
            const unresolvedGenerics = this.getUnresolvedGenerics(type);
            if (unresolvedGenerics.length > 0) {
                throw new Error(
                    `Found generic type parameters but no substitution context: ${unresolvedGenerics.join(', ')} in ${node.$type}`
                );
            }
        }
        
        return type;
    }

    /**
     * Recursively find all unresolved generic type parameters in a type.
     *
     * @param type The type to check
     * @returns Array of generic parameter names that are not yet resolved
     */
    private getUnresolvedGenerics(type: TypeDescription): string[] {
        const generics: string[] = [];
        
        const traverse = (t: TypeDescription): void => {
            if (isGenericType(t)) {
                // Found an unresolved generic
                generics.push(t.name);
            } else if (isArrayType(t)) {
                traverse(t.elementType);
            } else if (isNullableType(t)) {
                traverse(t.baseType);
            } else if (isTupleType(t)) {
                t.elementTypes.forEach(traverse);
            } else if (isUnionType(t)) {
                t.types.forEach(traverse);
            } else if (isJoinType(t)) {
                t.types.forEach(traverse);
            } else if (isReferenceType(t)) {
                t.genericArgs.forEach(traverse);
            } else if (isStructType(t)) {
                t.fields.forEach(field => traverse(field.type));
            } else if (isFunctionType(t)) {
                t.parameters.forEach(param => traverse(param.type));
                traverse(t.returnType);
            }
            // Add more composite types as needed
        };
        
        traverse(type);
        
        // Return unique generic names
        return Array.from(new Set(generics));
    }

    /**
     * Create a fresh generation context
     */
    private createContext(): GenerationContext {
        return {
            currentFunction: null,
            variables: new Map(),
            tempCounter: 0,
            labelCounter: 0,
            loopStack: [],
            scopeDepth: 0
        };
    }

    /**
     * Generate LIR from a Type-C module
     */
    public generate(documents: LangiumDocument<AstNode>[]): LIRProgram {
        // Visits each module and generates code for each one.
        for(const doc of documents) {
            if(!ast.isModule(doc.parseResult.value)){
                // Unreachable .. in theory.
                console.log("Invalid node")
                continue;
            }

            this.visitModule(doc.parseResult.value)
        }
        return this.program;
    }

    // ============================================================================
    // Module & Program Level
    // ============================================================================

    private visitModule(node: ast.Module | ast.NamespaceDecl): void {
        /**
         * Generate code for all:
         * 1. Global variabels initializations
         * 2. All FFI loads
         * 1. Classes (class methods)
         * 2. Functions
         */

        this.generateFFILoads(node);

        for(const n of node.definitions) {
            if(ast.isNamespaceDecl(n)) {
                this.visitModule(n)
            }
        }
        this.generateGlobalSymbols(node);
        this.generateClasses(node);
        this.generateFunctions(node);
    }

    /**
     * Generate bytecode to load all FFI
     */
    private generateFFILoads(node: ast.Module | ast.NamespaceDecl){
        const ffiDecls = AstUtils.streamAllContents(node).filter(ast.isExternFFIDecl).toArray();

        for(const decl of ffiDecls) {
            const libname = decl.dynlib;
            if(this.ffiRegistery.has(libname)) {
                continue;
            }

            const id = this.ffiRegistery.register(libname);
            this.globalFunc.ffiRegister(libname, id);
        }
    }

    private generateGlobalSymbols(node: ast.Module | ast.NamespaceDecl) {
        const globals = AstUtils.streamContents(node).filter(ast.isVariableDeclarationStatement);
        for(const gvar of globals) {
            for(const variable of gvar.declarations.variables) {
                if(ast.isVariableDeclSingle(variable)) {
                    const exprResult = this.tmp();
                    this.assert(variable.initializer != undefined, `No initializer for variable ${variable.name}`)
                    this.visitExpression(variable.initializer!, exprResult);
                    this.globalFunc.globalStore(
                        this.G(variable),
                        exprResult
                    )
                }
                else {
                    throw "Not implemented"
                }
            }
        }
    }

    private generateClasses(node: ast.Module | ast.NamespaceDecl) {
        const classes = AstUtils.streamContents(node)
            .filter(n => ast.isTypeDeclaration(n) && (ast.isClassType(n.definition)))
            .map(e => e as ast.TypeDeclaration)

        for (const classDecl of classes) {
            if(classDecl.genericParameters.length > 0) {
                // Generic class - generate code for each instantiation
                this.generateGenericClassInstantiations(classDecl);
            }
            else {
                // Non-generic class - generate directly
                const classType = classDecl.definition as ast.ClassType;
                this.generateClass(classDecl, classType);
            }
        }
    }

    /**
     * Generate code for all instantiations of a generic class
     */
    private generateGenericClassInstantiations(classDecl: ast.TypeDeclaration) {
        // Get all instantiations of this generic class
        const allInstantiations = this.monoMorph.getAllClassInstantiations();
        const classInstantiations = allInstantiations.filter(
            inst => inst.declaration === classDecl
        );

        // Generate code for each instantiation
        for (const instantiation of classInstantiations) {
            // Build substitution map: generic parameter name → concrete type
            const substitutions = new Map<string, TypeDescription>();
            
            classDecl.genericParameters.forEach((param, index) => {
                if (index < instantiation.typeArgs.length) {
                    substitutions.set(param.name, instantiation.typeArgs[index]);
                }
            });

            // Push substitutions onto stack
            this.pushSubstitutions(substitutions);
            
            try {
                // Generate the class with substitutions active
                const classType = classDecl.definition as ast.ClassType;
                this.generateClass(classDecl, classType);
            } finally {
                // Always pop, even if there's an error
                this.popSubstitutions();
            }
        }
    }

    /**
     * Generate code for a class (either non-generic or a specific instantiation of a generic)
     * Uses the current substitution stack for generic types.
     *
     * @param classDecl The class declaration node
     * @param classType The class type node
     */
    private generateClass(
        classDecl: ast.TypeDeclaration,
        classType: ast.ClassType
    ) {
        // Get current substitutions from stack
        const substitutions = this.getCurrentSubstitutions();
        
        // Generate a mangled name for the class
        const className = substitutions.size > 0
            ? this.monoMorph.mangleName(this.makeClassKey(classDecl, substitutions))
            : classDecl.name;

        console.log(`Generating class: ${className}`);

        // Generate methods
        for (const method of classType.methods) {
            if (method.method) {
                this.generateMethod(className, method);
            }
        }
    }

    /**
     * Generate code for a class method using the substitution stack
     */
    private generateMethod(
        className: string,
        classMethod: ast.ClassMethod
    ) {
        if (!classMethod.method) return;
        
        const methodHeader = classMethod.method;
        
        // Use the callable registry to get the mangled method name
        // For generic class instantiations, className is already mangled
        const fullMethodName = this.callableRegistry.getMethodNameForClass(
            className,
            methodHeader
        );
        
        console.log(`  Generating method: ${fullMethodName}`);

        // If method has its own generic parameters, handle them here
        // TODO: Add method-level generic instantiation support

        // Create the LIR function with parameter types resolved
        const args = this.convertMethodParameters(methodHeader);
        const returnType = methodHeader.header.returnType
            ? this.convertTypeWithSubstitution(methodHeader.header.returnType)
            : undefined;

        const lirFunc = this.program.createFunction(fullMethodName, args, returnType);
        const prevFunction = this.context.currentFunction;
        this.context.currentFunction = lirFunc;

        // Reset context for method
        this.context.variables.clear();
        this.context.tempCounter = 0;
        this.context.labelCounter = 0;
        this.context.scopeDepth = 0;

        // Map parameters to registers
        for (const arg of methodHeader.header.args) {
            this.context.variables.set(arg.name, arg.name);
        }

        // Generate method body (substitutions already on stack via getType())
        if (classMethod.body) {
            this.generateMethodBody(classMethod.body);
        } else if (classMethod.expr) {
            const result = this.visitExpression(classMethod.expr, undefined);
            lirFunc.ret(result.register);
        }

        this.context.currentFunction = prevFunction;
    }

    /**
     * Convert method parameters using the substitution stack
     */
    private convertMethodParameters(
        methodHeader: ast.MethodHeader
    ): FunctionArg[] {
        return methodHeader.header.args.map((param: ast.FunctionParameter) => ({
            name: param.name,
            type: param.type
                ? this.convertTypeWithSubstitution(param.type)
                : undefined
        }));
    }

    /**
     * Convert an AST type to IR DataType, applying substitutions from the stack
     * This is THE KEY METHOD that resolves T → u32 or T → SomeObject
     */
    private convertTypeWithSubstitution(
        astType: ast.DataType
    ): DataType | undefined {
        // Get the fully resolved type (with all generics substituted and validated)
        const resolvedType = this.getType(astType);
        
        // Now convert the CONCRETE type to IR DataType
        return this.convertTypeDescriptionToIR(resolvedType);
    }

    /**
     * Convert a Type-C TypeDescription to IR DataType
     * This handles the concrete types after substitution
     */
    private convertTypeDescriptionToIR(type: TypeDescription): DataType | undefined {
        switch (type.kind) {
            case 'u8': return basicType('u8');
            case 'u16': return basicType('u16');
            case 'u32': return basicType('u32');
            case 'u64': return basicType('u64');
            case 'i8': return basicType('i8');
            case 'i16': return basicType('i16');
            case 'i32': return basicType('i32');
            case 'i64': return basicType('i64');
            case 'f32': return basicType('f32');
            case 'f64': return basicType('f64');
            case 'bool': return basicType('bool');
            case 'string': return basicType('string');
            case 'array': {
                const elementType = this.convertTypeDescriptionToIR((type as any).elementType);
                return elementType ? arrayType(elementType) : undefined;
            }
            case 'nullable': {
                const baseType = this.convertTypeDescriptionToIR((type as any).baseType);
                return baseType ? nullableType(baseType) : undefined;
            }
            case 'struct':
            case 'class':
                return basicType('struct'); // Or however you represent objects
            default:
                return undefined;
        }
    }

    private getNodeIRType(node: AstNode) {
        const nodetype = this.getType(node);
        return this.convertTypeDescriptionToIR(nodetype)
    }

    /**
     * Generate method body (substitutions already on stack via getType())
     */
    private generateMethodBody(
        body: ast.BlockStatement
    ): void {
        this.enterScope();
        for (const stmt of body.statements) {
            this.visitStatement(stmt);
        }
        this.exitScope();
    }

    /**
     * Check if a type is a value type (vs reference type)
     */
    private isValueType(type: TypeDescription): boolean {
        const kind = type.kind;
        return kind === 'u8' || kind === 'u16' || kind === 'u32' || kind === 'u64' ||
               kind === 'i8' || kind === 'i16' || kind === 'i32' || kind === 'i64' ||
               kind === 'f32' || kind === 'f64' || kind === 'bool';
    }

    /**
     * Helper to create a class key similar to MonomorphizationRegistry
     */
    private makeClassKey(
        classDecl: ast.TypeDeclaration,
        substitutions: Map<string, TypeDescription>
    ): string {
        if (substitutions.size === 0) {
            return classDecl.name;
        }
        
        const typeArgStrings = classDecl.genericParameters
            .map(param => {
                const type = substitutions.get(param.name);
                return type ? type.toString() : param.name;
            });
            
        return `${classDecl.name}<${typeArgStrings.join(',')}>`;
    }

    // ============================================================================
    // Declarations
    // ============================================================================

    private generateFunctions(node: ast.Module | ast.NamespaceDecl) {
        for( const n of node.definitions) {
            if(ast.isFunctionDeclaration(n)) {
                this.visitFunctionDeclaration(n)
            }
        }
    }

    private visitFunctionDeclaration(node: ast.FunctionDeclaration): void {
        // Use callable registry for function name mangling
        // For generic functions, this should be called with specific type args
        const funcName = this.C(node);
        const args = this.convertFunctionParameters(node.header.args);
        const returnType = node.header.returnType
            ? this.convertType(node.header.returnType)
            : undefined;

        // Create LIR function
        const lirFunc = this.program.createFunction(funcName, args, returnType);
        const prevFunction = this.context.currentFunction;
        this.context.currentFunction = lirFunc;

        // Reset context for function
        this.context.variables.clear();
        this.context.tempCounter = 0;
        this.context.labelCounter = 0;
        this.context.scopeDepth = 0;

        // Map parameters to registers
        for (const arg of node.header.args) {
            this.context.variables.set(arg.name, arg.name);
        }

        // Generate function body
        if (node.body) {
            this.visitBlockStatement(node.body);
        } else if (node.expr) {
            // Expression-bodied function
            const result = this.visitExpression(node.expr, undefined);
            lirFunc.ret(result.register);
        }

        console.log(serializeFunction(this.context.currentFunction));
        // Restore previous context
        this.context.currentFunction = prevFunction;
    }
    // ============================================================================
    // Statements
    // ============================================================================

    private visitBlockStatement(node: ast.BlockStatement): void {
        this.enterScope();
        for (const stmt of node.statements) {
            this.visitStatement(stmt);
        }
        this.exitScope();
    }

    private visitStatement(node: ast.Statement): void {
        if (ast.isExpressionStatement(node)) {
            this.visitExpression(node.expr, undefined);
        } else if (ast.isVariableDeclarationStatement(node)) {
            this.visitLocalVariableDeclaration(node);
        } else if (ast.isReturnStatement(node)) {
            this.visitReturnStatement(node);
        } else if (ast.isIfStatement(node)) {
            this.visitIfStatement(node);
        } else if (ast.isWhileStatement(node)) {
            this.visitWhileStatement(node);
        } else if (ast.isDoWhileStatement(node)) {
            this.visitDoWhileStatement(node);
        } else if (ast.isForStatement(node)) {
            this.visitForStatement(node);
        } else if (ast.isForeachStatement(node)) {
            this.visitForeachStatement(node);
        } else if (ast.isMatchStatement(node)) {
            this.visitMatchStatement(node);
        } else if (ast.isBreakStatement(node)) {
            this.visitBreakStatement(node);
        } else if (ast.isContinueStatement(node)) {
            this.visitContinueStatement(node);
        } else if (ast.isBlockStatement(node)) {
            this.visitBlockStatement(node);
        } else if (ast.isFunctionDeclarationStatement(node)) {
            this.visitFunctionDeclaration(node.fn);
        }
    }

    private visitLocalVariableDeclaration(node: ast.VariableDeclarationStatement): void {
        for (const varDecl of node.declarations.variables) {
            if (ast.isVariableDeclaration(varDecl) && varDecl.initializer) {
                const result = this.visitExpression(varDecl.initializer, undefined);
                
                // Get the fully resolved type (with all generics substituted automatically by getType)
                const resolvedVarType = this.getType(varDecl);
                
                // Generate the appropriate IR instruction based on the CONCRETE type
                const varReg = this.allocateVariable(varDecl.name);
                
                // Choose the right instruction based on the concrete type
                if (this.isValueType(resolvedVarType)) {
                    // For value types (u32, f64, etc.), use direct assignment
                    this.context.currentFunction?.set(varReg, result.register);
                } else {
                    // For reference types (objects, arrays), might need ref counting or other logic
                    this.context.currentFunction?.set(varReg, result.register);
                    // Could add: this.context.currentFunction?.addRef(varReg);
                }
            }
            // TODO: Handle destructuring patterns
        }
    }

    private visitReturnStatement(node: ast.ReturnStatement): void {
        if (node.expr) {
            const result = this.visitExpression(node.expr, undefined);
            this.context.currentFunction?.ret(result.register);
        } else {
            this.context.currentFunction?.ret();
        }
    }

    private visitIfStatement(node: ast.IfStatement): void {
        const func = this.context.currentFunction;
        if (!func) return;

        const condition = this.visitExpression(node.condition, undefined);
        const thenLabel = this.generateLabel('then');
        const elseLabel = this.generateLabel('else');
        const endLabel = this.generateLabel('endif');

        // Branch on condition
        func.br(condition.register, thenLabel, elseLabel);

        // Then branch
        func.label(thenLabel);
        this.visitBlockStatement(node.body);
        func.jmp(endLabel);

        // Else branch
        func.label(elseLabel);
        if (node.elseBody) {
            this.visitBlockStatement(node.elseBody);
        } else if (node.elseIf && node.elseIf.length > 0) {
            // TODO: Handle else-if chain
            for (const elseIf of node.elseIf) {
                this.visitIfStatement(elseIf);
            }
        }
        func.jmp(endLabel);

        // End label
        func.label(endLabel);
    }

    private visitWhileStatement(node: ast.WhileStatement): void {
        const func = this.context.currentFunction;
        if (!func) return;

        const loopStart = this.generateLabel('while_start');
        const loopBody = this.generateLabel('while_body');
        const loopEnd = this.generateLabel('while_end');

        this.pushLoop(loopEnd, loopStart);

        func.label(loopStart);
        const condition = this.visitExpression(node.condition, undefined);
        func.br(condition.register, loopBody, loopEnd);

        func.label(loopBody);
        this.visitBlockStatement(node.body);
        func.jmp(loopStart);

        func.label(loopEnd);
        this.popLoop();
    }

    private visitDoWhileStatement(node: ast.DoWhileStatement): void {
        const func = this.context.currentFunction;
        if (!func) return;

        const loopStart = this.generateLabel('do_start');
        const loopCheck = this.generateLabel('do_check');
        const loopEnd = this.generateLabel('do_end');

        this.pushLoop(loopEnd, loopCheck);

        func.label(loopStart);
        this.visitBlockStatement(node.body);

        func.label(loopCheck);
        const condition = this.visitExpression(node.condition, undefined);
        func.br(condition.register, loopStart, loopEnd);

        func.label(loopEnd);
        this.popLoop();
    }

    private visitForStatement(node: ast.ForStatement): void {
        const func = this.context.currentFunction;
        if (!func) return;

        const loopStart = this.generateLabel('for_start');
        const loopBody = this.generateLabel('for_body');
        const loopUpdate = this.generateLabel('for_update');
        const loopEnd = this.generateLabel('for_end');

        this.pushLoop(loopEnd, loopUpdate);

        // Initialization
        if (node.init) {
            this.visitStatement(node.init);
        }

        // Condition check
        func.label(loopStart);
        if (node.condition) {
            const condition = this.visitExpression(node.condition, undefined);
            func.br(condition.register, loopBody, loopEnd);
        }

        // Loop body
        func.label(loopBody);
        this.visitBlockStatement(node.body);

        // Update
        func.label(loopUpdate);
        if (node.update) {
            this.visitExpression(node.update, undefined);
        }
        func.jmp(loopStart);

        func.label(loopEnd);
        this.popLoop();
    }

    private visitForeachStatement(node: ast.ForeachStatement): void {
        // TODO: Implement foreach loop
        // May need different handling for ForRangeIterator vs ForEachIterator
        console.warn('Foreach statement not yet implemented');
    }

    private visitMatchStatement(node: ast.MatchStatement): void {
        // TODO: Implement pattern matching
        // Will need to generate comparison logic for each pattern
        console.warn('Match statement not yet implemented');
    }

    private visitBreakStatement(node: ast.BreakStatement): void {
        const loop = this.currentLoop();
        if (loop && this.context.currentFunction) {
            this.context.currentFunction.jmp(loop.breakLabel);
        }
    }

    private visitContinueStatement(node: ast.ContinueStatement): void {
        const loop = this.currentLoop();
        if (loop && this.context.currentFunction) {
            this.context.currentFunction.jmp(loop.continueLabel);
        }
    }

    // ============================================================================
    // Expressions
    // ============================================================================

    private visitExpression(node: ast.Expression, varname?: string): ExpressionResult {
        // Literal expressions
        if (ast.isDecimalIntegerLiteral(node) ||
            ast.isHexadecimalIntegerLiteral(node) ||
            ast.isBinaryIntegerLiteral(node) ||
            ast.isOctalIntegerLiteral(node)) {
            return this.visitIntegerLiteral(node, varname);
        }
        if (ast.isFloatLiteral(node) || ast.isDoubleLiteral(node)) {
            return this.visitFloatingPointLiteral(node, varname);
        }
        if (ast.isTrueBooleanLiteral(node) || ast.isFalseBooleanLiteral(node)) {
            return this.visitBooleanLiteral(node, varname);
        }
        if (ast.isStringLiteralExpression(node)) {
            return this.visitStringLiteral(node, varname);
        }
        if (ast.isNullLiteralExpression(node)) {
            return this.visitNullLiteral(node, varname);
        }

        // Binary operations
        if (ast.isBinaryExpression(node)) {
            return this.visitBinaryExpression(node, varname);
        }

        // Unary operations
        if (ast.isUnaryExpression(node)) {
            return this.visitUnaryExpression(node, varname);
        }

        // Variable reference
        if (ast.isQualifiedReference(node)) {
            return this.visitQualifiedReference(node, varname);
        }

        // Function call
        if (ast.isFunctionCall(node)) {
            return this.visitFunctionCall(node, varname);
        }

        // Member access
        if (ast.isMemberAccess(node)) {
            return this.visitMemberAccess(node, varname);
        }

        // Array/Index access
        if (ast.isIndexAccess(node)) {
            return this.visitIndexAccess(node, varname);
        }

        // Array construction
        if (ast.isArrayConstructionExpression(node)) {
            return this.visitArrayConstruction(node, varname);
        }

        // Struct construction
        if (ast.isNamedStructConstructionExpression(node) ||
            ast.isAnonymousStructConstructionExpression(node)) {
            return this.visitStructConstruction(node, varname);
        }

        // Control flow expressions
        if (ast.isConditionalExpression(node)) {
            return this.visitConditionalExpression(node, varname);
        }

        if (ast.isMatchExpression(node)) {
            return this.visitMatchExpression(node, varname);
        }

        if (ast.isLetInExpression(node)) {
            return this.visitLetInExpression(node, varname);
        }

        // Special expressions
        if (ast.isThisExpression(node)) {
            return this.visitThisExpression(node, varname);
        }

        if (ast.isNewExpression(node)) {
            return this.visitNewExpression(node, varname);
        }

        if (ast.isLambdaExpression(node)) {
            return this.visitLambdaExpression(node, varname);
        }

        if (ast.isDoExpression(node)) {
            return this.visitDoExpression(node, varname);
        }

        if (ast.isThrowExpression(node)) {
            return this.visitThrowExpression(node, varname);
        }

        if (ast.isYieldExpression(node)) {
            return this.visitYieldExpression(node, varname);
        }

        if (ast.isCoroutineExpression(node)) {
            return this.visitCoroutineExpression(node, varname);
        }

        if (ast.isTupleExpression(node)) {
            return this.visitTupleExpression(node, varname);
        }

        // Type operations
        if (ast.isInstanceCheckExpression(node)) {
            return this.visitInstanceCheckExpression(node, varname);
        }

        if (ast.isTypeCastExpression(node)) {
            return this.visitTypeCastExpression(node, varname);
        }

        // Default: return a placeholder
        const temp = this.tmp();
        this.context.currentFunction?.undef(temp);
        return { register: temp };
    }

    private visitIntegerLiteral(node: ast.IntegerLiteral, varname?: string): ExpressionResult {
        const temp = this.tmp();
        const value = this.parseIntegerLiteral(node.value);
        const type = this.convertTypeDescriptionToIR(this.getType(node));
        this.context.currentFunction?.const(temp, intLiteral(value), type);
        return { register: temp, type: type };
    }

    private visitFloatingPointLiteral(node: ast.FloatingPointLiteral, varname?: string): ExpressionResult {
        const temp = this.tmp();
        const value = parseFloat(node.value);
        const type = ast.isFloatLiteral(node) ? basicType('f32') : basicType('f64');
        this.context.currentFunction?.const(temp, floatLiteral(value), type);
        return { register: temp, type };
    }

    private visitBooleanLiteral(node: ast.BooleanLiteral, varname?: string): ExpressionResult {
        const temp = this.tmp();
        const value = ast.isTrueBooleanLiteral(node);
        this.context.currentFunction?.const(temp, boolLiteral(value), basicType('bool'));
        return { register: temp, type: basicType('bool') };
    }

    private visitStringLiteral(node: ast.StringLiteralExpression, varname?: string): ExpressionResult {
        const temp = this.tmp();
        const value = node.value; // Remove quotes
        this.context.currentFunction?.const(temp, stringLiteral(value), basicType('string'));
        return { register: temp, type: basicType('string') };
    }

    private visitNullLiteral(node: ast.NullLiteralExpression, varname?: string): ExpressionResult {
        const temp = this.tmp();
        this.context.currentFunction?.const(temp, intLiteral(0)); // Represent null as 0
        return { register: temp };
    }

    private visitBinaryExpression(node: ast.BinaryExpression, varname?: string): ExpressionResult {
        const left = this.visitExpression(node.left, undefined);
        const right = this.visitExpression(node.right, undefined);
        const temp = this.tmp();
        const op = this.convertBinaryOp(node.op);

        this.context.currentFunction?.binaryOp(temp, op, left.register, right.register);
        return { register: temp };
    }

    private visitUnaryExpression(node: ast.UnaryExpression, varname?: string): ExpressionResult {
        const operand = this.visitExpression(node.expr, undefined);
        const temp = this.tmp();
        const op = this.convertUnaryOp(node.op);

        this.context.currentFunction?.unaryOp(temp, op, operand.register);
        return { register: temp };
    }

    private visitQualifiedReference(node: ast.QualifiedReference, varname?: string): ExpressionResult {
        // Look up variable in context
        const ref = node.reference?.ref;
        this.assert(ref !== undefined, "Invalid refrence");

        // Check if straight symbol: arg, vardecl
        if(ast.isFunctionParameter(ref) || ast.isVariableDeclSingle(ref)) {
            const varName = this.getReferenceName(ref);
            let register: string = ""
            // We need to check if the variable is global
            if(ast.isVariableDeclSingle(ref) && ast.isModule(ref.$container?.$container?.$container) || ast.isNamespaceDecl(ref.$container?.$container?.$container)) {
                register = this.tmp();
                const type = this.getNodeIRType(ref);
                this.context.currentFunction?.globalLoad(register, this.G(ref), type);
            }
            else {
                // No load instruction needed, variables/arguments live in regsiters.
                register = this.context.variables.get(varName) ?? varName;
            }
            return { register };
        }
    
        throw "Not implement for "+ref?.$type;
    }

    private visitFunctionCall(node: ast.FunctionCall, varname?: string): ExpressionResult {
        const func = this.context.currentFunction;
        if (!func) return { register: 'undefined' };

        // Evaluate function expression
        const funcExpr = this.visitExpression(node.expr, undefined);

        // Evaluate arguments
        const argRegs: string[] = [];
        if (node.args) {
            for (const arg of node.args) {
                const argResult = this.visitExpression(arg, undefined);
                argRegs.push(argResult.register);
            }
        }

        // Generate call
        const temp = this.tmp();
        func.call(funcExpr.register, argRegs, temp);
        return { register: temp };
    }

    private visitMemberAccess(node: ast.MemberAccess, varname?: string): ExpressionResult {
        // TODO: Generate struct_get, class_get, or array access
        const obj = this.visitExpression(node.expr, undefined);
        const ref = node.element?.ref;
        const memberName = this.getReferenceName(ref) ?? 'unknown';
        const temp = this.tmp();
        
        // Placeholder: assume struct access
        this.context.currentFunction?.structGet(temp, obj.register, memberName);
        return { register: temp };
    }

    private visitIndexAccess(node: ast.IndexAccess, varname?: string): ExpressionResult {
        const array = this.visitExpression(node.expr, undefined);
        const temp = this.tmp();
        
        if (node.indexes && node.indexes.length > 0) {
            const index = this.visitExpression(node.indexes[0], undefined);
            this.context.currentFunction?.arrayGet(temp, array.register, index.register);
        }
        
        return { register: temp };
    }

    private visitArrayConstruction(node: ast.ArrayConstructionExpression, varname?: string): ExpressionResult {
        // TODO: Implement array construction
        // Need to allocate array and set elements
        const temp = this.tmp();
        return { register: temp };
    }

    private visitStructConstruction(node: ast.Expression, varname?: string): ExpressionResult {
        // TODO: Implement struct construction
        const temp = this.tmp();
        return { register: temp };
    }

    private visitConditionalExpression(node: ast.ConditionalExpression, varname?: string): ExpressionResult {
        // TODO: Implement if expression (different from if statement)
        const temp = this.tmp();
        return { register: temp };
    }

    private visitMatchExpression(node: ast.MatchExpression, varname?: string): ExpressionResult {
        // TODO: Implement match expression
        const temp = this.tmp();
        return { register: temp };
    }

    private visitLetInExpression(node: ast.LetInExpression, varname?: string): ExpressionResult {
        // TODO: Implement let-in expression
        const temp = this.tmp();
        return { register: temp };
    }

    private visitThisExpression(node: ast.ThisExpression, varname?: string): ExpressionResult {
        // Return 'this' register
        return { register: 'this' };
    }

    private visitNewExpression(node: ast.NewExpression, varname?: string): ExpressionResult {
        // TODO: Generate class_alloc or struct_alloc
        const temp = this.tmp();
        return { register: temp };
    }

    private visitLambdaExpression(node: ast.LambdaExpression, varname?: string): ExpressionResult {
        // TODO: Generate closure_alloc
        const temp = this.tmp();
        return { register: temp };
    }

    private visitDoExpression(node: ast.DoExpression, varname?: string): ExpressionResult {
        this.visitBlockStatement(node.body);
        // TODO: Capture block result
        const temp = this.tmp();
        return { register: temp };
    }

    private visitThrowExpression(node: ast.ThrowExpression, varname?: string): ExpressionResult {
        const expr = this.visitExpression(node.expr, undefined);
        this.context.currentFunction?.throw(expr.register);
        const temp = this.tmp();
        return { register: temp };
    }

    private visitYieldExpression(node: ast.YieldExpression, varname?: string): ExpressionResult {
        // TODO: Generate coro_yield
        const temp = this.tmp();
        return { register: temp };
    }

    private visitCoroutineExpression(node: ast.CoroutineExpression, varname?: string): ExpressionResult {
        // TODO: Generate coro_alloc
        const temp = this.tmp();
        return { register: temp };
    }

    private visitTupleExpression(node: ast.TupleExpression, varname?: string): ExpressionResult {
        // TODO: Handle tuple expressions (multiple values)
        if (node.expressions.length === 1) {
            return this.visitExpression(node.expressions[0], varname);
        }
        const temp = this.tmp();
        return { register: temp };
    }

    private visitInstanceCheckExpression(node: ast.InstanceCheckExpression, varname?: string): ExpressionResult {
        // TODO: Generate type check instruction
        const temp = this.tmp();
        return { register: temp };
    }

    private visitTypeCastExpression(node: ast.TypeCastExpression, varname?: string): ExpressionResult {
        /// @ts-ignore
        const expr = this.visitExpression(node.left, undefined);
        const temp = this.tmp();
        // TODO: Generate cast instruction based on castType
        return { register: temp };
    }

    // ============================================================================
    // Type Conversion
    // ============================================================================

    private convertType(node: ast.DataType): DataType | undefined {
        if (ast.isPrimitiveType(node)) {
            if (node.integerType) return basicType(node.integerType);
            if (node.floatType) return basicType(node.floatType);
            if (node.boolType) return basicType('bool');
            if (node.stringType) return basicType('string');
            // void, never, null - handle specially
        }
        
        if (ast.isArrayType(node)) {
            const elementType = this.convertType(node.arrayOf);
            if (elementType) return arrayType(elementType);
        }
        
        if (ast.isNullableType(node)) {
            const baseType = this.convertType(node.baseType);
            if (baseType) return nullableType(baseType);
        }
        
        if (ast.isReferenceType(node)) {
            // TODO: Handle named types (classes, structs, interfaces)
            return basicType('struct');
        }
        
        if (ast.isStructType(node)) {
            return basicType('struct');
        }
        
        if (ast.isClassType(node)) {
            return basicType('class');
        }
        
        if (ast.isInterfaceType(node)) {
            return basicType('interface');
        }
        
        if (ast.isFunctionType(node)) {
            return basicType('function');
        }
        
        if (ast.isCoroutineType(node)) {
            return basicType('coroutine');
        }
        
        return undefined;
    }

    private convertFunctionParameters(params: ast.FunctionParameter[]): FunctionArg[] {
        return params.map(param => ({
            name: param.name,
            type: param.type ? this.convertType(param.type) : undefined
        }));
    }

    private convertBinaryOp(op: string): BinaryOp {
        const opMap: Record<string, BinaryOp> = {
            '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod',
            '<<': 'shl', '>>': 'shr',
            '&': 'band', '|': 'bor', '^': 'bxor',
            '==': 'eq', '!=': 'neq', '<': 'lt', '>': 'gt', '<=': 'le', '>=': 'ge',
            '&&': 'and', '||': 'or'
        };
        return opMap[op] ?? 'add';
    }

    private convertUnaryOp(op: string): UnaryOp {
        const opMap: Record<string, UnaryOp> = {
            '!': 'not', '~': 'bnot', '-': 'neg', '+': 'id'
        };
        return opMap[op] ?? 'id';
    }

    // ============================================================================
    // Helper Methods
    // ============================================================================


    /**
     * @returns a new vregister name
     */

    private tmp(): string {
        return `%t${this.context.tempCounter++}`;
    }

    private generateLabel(prefix: string): string {
        return `${prefix}_${this.context.labelCounter++}`;
    }

    private allocateVariable(name: string): string {
        const varReg = `%${name}_${this.context.scopeDepth}`;
        this.context.variables.set(name, varReg);
        return varReg;
    }

    private enterScope(): void {
        this.context.scopeDepth++;
    }

    private exitScope(): void {
        this.context.scopeDepth--;
        // TODO: Clean up variables from exited scope
    }

    private pushLoop(breakLabel: string, continueLabel: string): void {
        this.context.loopStack.push({ breakLabel, continueLabel });
    }

    private popLoop(): void {
        this.context.loopStack.pop();
    }

    private currentLoop(): { breakLabel: string; continueLabel: string } | undefined {
        return this.context.loopStack[this.context.loopStack.length - 1];
    }

    private parseIntegerLiteral(value: string): number {
        // Remove type suffix if present
        const cleanValue = value.replace(/[ui](8|16|32|64)$/, '');
        
        if (cleanValue.startsWith('0x')) {
            return parseInt(cleanValue, 16);
        } else if (cleanValue.startsWith('0b')) {
            return parseInt(cleanValue.slice(2), 2);
        } else if (cleanValue.startsWith('0o')) {
            return parseInt(cleanValue.slice(2), 8);
        } else {
            return parseInt(cleanValue, 10);
        }
    }

    /**
     * Extract name from various IdentifiableReference types
     */
    private getReferenceName(ref: ast.IdentifiableReference | undefined): string {
        if (!ref) throw "Invalid ref";
        
        // Most reference types have a 'name' property
        if ('name' in ref && typeof ref.name === 'string') {
            return ref.name;
        }
        
        // ClassMethod has nested structure
        if (ast.isClassMethod(ref) && ref.method) {
            // Methods can have multiple names (overloaded operators)
            return ref.method.names?.[0];
        }
        
        throw "Ref has no name attribute!";
    }

    assert(condition: boolean, message: string) {
        if(!condition) {
            throw "Error: "+message
        }
    }
}