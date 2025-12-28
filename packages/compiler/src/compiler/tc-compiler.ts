/**
 * LIR Generator for Type-C
 * Generates Low-Level Intermediate Representation from Type-C AST
 */

import { AstNode } from 'langium';
import * as ast from 'type-c-language';
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
import { TypeCTypeProvider } from '../../../language/src/typing/type-c-type-provider.js';

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

    constructor(typeProvider: TypeCTypeProvider) {
        this.program = new LIRProgram();
        this.context = this.createContext();
        this.typeProvider = typeProvider;
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
    public generate(module: ast.Module): LIRProgram {
        this.visitModule(module);
        return this.program;
    }

    // ============================================================================
    // Module & Program Level
    // ============================================================================

    private visitModule(node: ast.Module): void {
        // TODO: Process imports
        for (const imp of node.imports) {
            this.visitImport(imp);
        }

        // Process all definitions
        for (const def of node.definitions) {
            this.visitDefinition(def);
        }
    }

    private visitImport(node: ast.Import): void {
        // TODO: Handle imports (may need module linking)
        console.warn('Import handling not yet implemented');
    }

    private visitDefinition(node: AstNode): void {
        if (ast.isFunctionDeclaration(node)) {
            this.visitFunctionDeclaration(node);
        } else if (ast.isVariableDeclarationStatement(node)) {
            this.visitGlobalVariableDeclaration(node);
        } else if (ast.isTypeDeclaration(node)) {
            this.visitTypeDeclaration(node);
        } else if (ast.isNamespaceDecl(node)) {
            this.visitNamespaceDecl(node);
        } else if (ast.isClassType(node)) {
            this.visitClassType(node);
        } else if (ast.isImplementationType(node)) {
            this.visitImplementationType(node);
        } else if (ast.isExternFFIDecl(node)) {
            this.visitExternFFIDecl(node);
        } else if (ast.isBuiltinDefinition(node)) {
            this.visitBuiltinDefinition(node);
        }

        throw "Invalid node "+node.$type;
    }

    // ============================================================================
    // Declarations
    // ============================================================================

    private visitFunctionDeclaration(node: ast.FunctionDeclaration): void {
        const funcName = this.getFunctionName(node);
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
            const result = this.visitExpression(node.expr);
            lirFunc.ret(result.register);
        }

        // Restore previous context
        this.context.currentFunction = prevFunction;
    }

    private visitGlobalVariableDeclaration(node: ast.VariableDeclarationStatement): void {
        // TODO: Handle global variables
        // May require global storage instructions
        for (const varDecl of node.declarations.variables) {
            const globalId = this.getGlobalVariableName(varDecl);
            // TODO: Generate global_store instructions if initialized
        }
    }

    private visitTypeDeclaration(node: ast.TypeDeclaration): void {
        // TODO: Register type definitions (may be needed for struct/class allocation)
        console.warn('Type declaration handling not yet fully implemented');
    }

    private visitNamespaceDecl(node: ast.NamespaceDecl): void {
        // TODO: Handle namespace definitions
        // Process nested definitions with namespace prefix
        for (const def of node.definitions) {
            this.visitDefinition(def);
        }
    }

    private visitClassType(node: ast.ClassType): void {
        // TODO: Generate class metadata and methods
        console.warn('Class type generation not yet implemented');
    }

    private visitImplementationType(node: ast.ImplementationType): void {
        // TODO: Generate implementation methods
        console.warn('Implementation type generation not yet implemented');
    }

    private visitExternFFIDecl(node: ast.ExternFFIDecl): void {
        // TODO: Register FFI declarations
        console.warn('FFI declaration handling not yet implemented');
    }

    private visitBuiltinDefinition(node: ast.BuiltinDefinition): void {
        // TODO: Handle builtin prototypes (array, coroutine, string)
        console.warn('Builtin definition handling not yet implemented');
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
            this.visitExpression(node.expr);
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
                const result = this.visitExpression(varDecl.initializer);
                const varReg = this.allocateVariable(varDecl.name);
                this.context.currentFunction?.set(varReg, result.register);
            }
            // TODO: Handle destructuring patterns
        }
    }

    private visitReturnStatement(node: ast.ReturnStatement): void {
        if (node.expr) {
            const result = this.visitExpression(node.expr);
            this.context.currentFunction?.ret(result.register);
        } else {
            this.context.currentFunction?.ret();
        }
    }

    private visitIfStatement(node: ast.IfStatement): void {
        const func = this.context.currentFunction;
        if (!func) return;

        const condition = this.visitExpression(node.condition);
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
        const condition = this.visitExpression(node.condition);
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
        const condition = this.visitExpression(node.condition);
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
            const condition = this.visitExpression(node.condition);
            func.br(condition.register, loopBody, loopEnd);
        }

        // Loop body
        func.label(loopBody);
        this.visitBlockStatement(node.body);

        // Update
        func.label(loopUpdate);
        if (node.update) {
            this.visitExpression(node.update);
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

    private visitExpression(node: ast.Expression): ExpressionResult {
        // Literal expressions
        if (ast.isDecimalIntegerLiteral(node) || 
            ast.isHexadecimalIntegerLiteral(node) || 
            ast.isBinaryIntegerLiteral(node) || 
            ast.isOctalIntegerLiteral(node)) {
            return this.visitIntegerLiteral(node);
        }
        if (ast.isFloatLiteral(node) || ast.isDoubleLiteral(node)) {
            return this.visitFloatingPointLiteral(node);
        }
        if (ast.isTrueBooleanLiteral(node) || ast.isFalseBooleanLiteral(node)) {
            return this.visitBooleanLiteral(node);
        }
        if (ast.isStringLiteralExpression(node)) {
            return this.visitStringLiteral(node);
        }
        if (ast.isNullLiteralExpression(node)) {
            return this.visitNullLiteral(node);
        }

        // Binary operations
        if (ast.isBinaryExpression(node)) {
            return this.visitBinaryExpression(node);
        }

        // Unary operations
        if (ast.isUnaryExpression(node)) {
            return this.visitUnaryExpression(node);
        }

        // Variable reference
        if (ast.isQualifiedReference(node)) {
            return this.visitQualifiedReference(node);
        }

        // Function call
        if (ast.isFunctionCall(node)) {
            return this.visitFunctionCall(node);
        }

        // Member access
        if (ast.isMemberAccess(node)) {
            return this.visitMemberAccess(node);
        }

        // Array/Index access
        if (ast.isIndexAccess(node)) {
            return this.visitIndexAccess(node);
        }

        // Array construction
        if (ast.isArrayConstructionExpression(node)) {
            return this.visitArrayConstruction(node);
        }

        // Struct construction
        if (ast.isNamedStructConstructionExpression(node) || 
            ast.isAnonymousStructConstructionExpression(node)) {
            return this.visitStructConstruction(node);
        }

        // Control flow expressions
        if (ast.isConditionalExpression(node)) {
            return this.visitConditionalExpression(node);
        }

        if (ast.isMatchExpression(node)) {
            return this.visitMatchExpression(node);
        }

        if (ast.isLetInExpression(node)) {
            return this.visitLetInExpression(node);
        }

        // Special expressions
        if (ast.isThisExpression(node)) {
            return this.visitThisExpression(node);
        }

        if (ast.isNewExpression(node)) {
            return this.visitNewExpression(node);
        }

        if (ast.isLambdaExpression(node)) {
            return this.visitLambdaExpression(node);
        }

        if (ast.isDoExpression(node)) {
            return this.visitDoExpression(node);
        }

        if (ast.isThrowExpression(node)) {
            return this.visitThrowExpression(node);
        }

        if (ast.isYieldExpression(node)) {
            return this.visitYieldExpression(node);
        }

        if (ast.isCoroutineExpression(node)) {
            return this.visitCoroutineExpression(node);
        }

        if (ast.isTupleExpression(node)) {
            return this.visitTupleExpression(node);
        }

        // Type operations
        if (ast.isInstanceCheckExpression(node)) {
            return this.visitInstanceCheckExpression(node);
        }

        if (ast.isTypeCastExpression(node)) {
            return this.visitTypeCastExpression(node);
        }

        // Default: return a placeholder
        const temp = this.generateTemp();
        this.context.currentFunction?.undef(temp);
        return { register: temp };
    }

    private visitIntegerLiteral(node: ast.IntegerLiteral): ExpressionResult {
        const temp = this.generateTemp();
        const value = this.parseIntegerLiteral(node.value);
        this.context.currentFunction?.const(temp, intLiteral(value), basicType('i32'));
        return { register: temp, type: basicType('i32') };
    }

    private visitFloatingPointLiteral(node: ast.FloatingPointLiteral): ExpressionResult {
        const temp = this.generateTemp();
        const value = parseFloat(node.value);
        const type = ast.isFloatLiteral(node) ? basicType('f32') : basicType('f64');
        this.context.currentFunction?.const(temp, floatLiteral(value), type);
        return { register: temp, type };
    }

    private visitBooleanLiteral(node: ast.BooleanLiteral): ExpressionResult {
        const temp = this.generateTemp();
        const value = ast.isTrueBooleanLiteral(node);
        this.context.currentFunction?.const(temp, boolLiteral(value), basicType('bool'));
        return { register: temp, type: basicType('bool') };
    }

    private visitStringLiteral(node: ast.StringLiteralExpression): ExpressionResult {
        const temp = this.generateTemp();
        const value = node.value.slice(1, -1); // Remove quotes
        this.context.currentFunction?.const(temp, stringLiteral(value), basicType('string'));
        return { register: temp, type: basicType('string') };
    }

    private visitNullLiteral(node: ast.NullLiteralExpression): ExpressionResult {
        const temp = this.generateTemp();
        this.context.currentFunction?.const(temp, intLiteral(0)); // Represent null as 0
        return { register: temp };
    }

    private visitBinaryExpression(node: ast.BinaryExpression): ExpressionResult {
        const left = this.visitExpression(node.left);
        const right = this.visitExpression(node.right);
        const temp = this.generateTemp();
        const op = this.convertBinaryOp(node.op);

        this.context.currentFunction?.binaryOp(temp, op, left.register, right.register);
        return { register: temp };
    }

    private visitUnaryExpression(node: ast.UnaryExpression): ExpressionResult {
        const operand = this.visitExpression(node.expr);
        const temp = this.generateTemp();
        const op = this.convertUnaryOp(node.op);

        this.context.currentFunction?.unaryOp(temp, op, operand.register);
        return { register: temp };
    }

    private visitQualifiedReference(node: ast.QualifiedReference): ExpressionResult {
        // Look up variable in context
        const ref = node.reference?.ref;
        const varName = this.getReferenceName(ref) ?? 'unknown';
        const register = this.context.variables.get(varName) ?? varName;
        return { register };
    }

    private visitFunctionCall(node: ast.FunctionCall): ExpressionResult {
        const func = this.context.currentFunction;
        if (!func) return { register: 'undefined' };

        // Evaluate function expression
        const funcExpr = this.visitExpression(node.expr);

        // Evaluate arguments
        const argRegs: string[] = [];
        if (node.args) {
            for (const arg of node.args) {
                const argResult = this.visitExpression(arg);
                argRegs.push(argResult.register);
            }
        }

        // Generate call
        const temp = this.generateTemp();
        func.call(funcExpr.register, argRegs, temp);
        return { register: temp };
    }

    private visitMemberAccess(node: ast.MemberAccess): ExpressionResult {
        // TODO: Generate struct_get, class_get, or array access
        const obj = this.visitExpression(node.expr);
        const ref = node.element?.ref;
        const memberName = this.getReferenceName(ref) ?? 'unknown';
        const temp = this.generateTemp();
        
        // Placeholder: assume struct access
        this.context.currentFunction?.structGet(temp, obj.register, memberName);
        return { register: temp };
    }

    private visitIndexAccess(node: ast.IndexAccess): ExpressionResult {
        const array = this.visitExpression(node.expr);
        const temp = this.generateTemp();
        
        if (node.indexes && node.indexes.length > 0) {
            const index = this.visitExpression(node.indexes[0]);
            this.context.currentFunction?.arrayGet(temp, array.register, index.register);
        }
        
        return { register: temp };
    }

    private visitArrayConstruction(node: ast.ArrayConstructionExpression): ExpressionResult {
        // TODO: Implement array construction
        // Need to allocate array and set elements
        const temp = this.generateTemp();
        return { register: temp };
    }

    private visitStructConstruction(node: ast.Expression): ExpressionResult {
        // TODO: Implement struct construction
        const temp = this.generateTemp();
        return { register: temp };
    }

    private visitConditionalExpression(node: ast.ConditionalExpression): ExpressionResult {
        // TODO: Implement if expression (different from if statement)
        const temp = this.generateTemp();
        return { register: temp };
    }

    private visitMatchExpression(node: ast.MatchExpression): ExpressionResult {
        // TODO: Implement match expression
        const temp = this.generateTemp();
        return { register: temp };
    }

    private visitLetInExpression(node: ast.LetInExpression): ExpressionResult {
        // TODO: Implement let-in expression
        const temp = this.generateTemp();
        return { register: temp };
    }

    private visitThisExpression(node: ast.ThisExpression): ExpressionResult {
        // Return 'this' register
        return { register: 'this' };
    }

    private visitNewExpression(node: ast.NewExpression): ExpressionResult {
        // TODO: Generate class_alloc or struct_alloc
        const temp = this.generateTemp();
        return { register: temp };
    }

    private visitLambdaExpression(node: ast.LambdaExpression): ExpressionResult {
        // TODO: Generate closure_alloc
        const temp = this.generateTemp();
        return { register: temp };
    }

    private visitDoExpression(node: ast.DoExpression): ExpressionResult {
        this.visitBlockStatement(node.body);
        // TODO: Capture block result
        const temp = this.generateTemp();
        return { register: temp };
    }

    private visitThrowExpression(node: ast.ThrowExpression): ExpressionResult {
        const expr = this.visitExpression(node.expr);
        this.context.currentFunction?.throw(expr.register);
        const temp = this.generateTemp();
        return { register: temp };
    }

    private visitYieldExpression(node: ast.YieldExpression): ExpressionResult {
        // TODO: Generate coro_yield
        const temp = this.generateTemp();
        return { register: temp };
    }

    private visitCoroutineExpression(node: ast.CoroutineExpression): ExpressionResult {
        // TODO: Generate coro_alloc
        const temp = this.generateTemp();
        return { register: temp };
    }

    private visitTupleExpression(node: ast.TupleExpression): ExpressionResult {
        // TODO: Handle tuple expressions (multiple values)
        if (node.expressions.length === 1) {
            return this.visitExpression(node.expressions[0]);
        }
        const temp = this.generateTemp();
        return { register: temp };
    }

    private visitInstanceCheckExpression(node: ast.InstanceCheckExpression): ExpressionResult {
        // TODO: Generate type check instruction
        const temp = this.generateTemp();
        return { register: temp };
    }

    private visitTypeCastExpression(node: ast.TypeCastExpression): ExpressionResult {
        const expr = this.visitExpression(node.left);
        const temp = this.generateTemp();
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

    private getFunctionName(node: ast.FunctionDeclaration): string {
        // Prefix with @ for main-like functions, or use qualified name
        return node.name === 'main' ? '@main' : node.name;
    }

    private getGlobalVariableName(node: ast.VariableDeclaration): string {
        return `@global_${node.name}`;
    }

    private generateTemp(): string {
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
    private getReferenceName(ref: ast.IdentifiableReference | undefined): string | undefined {
        if (!ref) return undefined;
        
        // Most reference types have a 'name' property
        if ('name' in ref && typeof ref.name === 'string') {
            return ref.name;
        }
        
        // ClassMethod has nested structure
        if (ast.isClassMethod(ref) && ref.method) {
            // Methods can have multiple names (overloaded operators)
            return ref.method.names?.[0];
        }
        
        return undefined;
    }
}