/**
 * Type Provider for Type-C
 * 
 * This module provides the main type inference engine for Type-C.
 * It lazily computes types from AST nodes and caches results using Langium's infrastructure.
 * 
 * Key features:
 * - Lazy evaluation: types are computed on-demand
 * - Caching: results are memoized to avoid recomputation
 * - Recursive type support: handles recursive types like generic classes
 * - Integration with Langium: uses Langium's linking and scoping
 */

import type { TypeCServices } from '../type-c-module.js';
import * as ast from '../generated/ast.js';
import { AstNode, AstUtils } from 'langium';
import { 
    TypeDescription, 
    TypeKind, 
    GenericTypeDescription, 
    MethodType,
    PrototypeMethodType,
    StructFieldType,
    isClassType,
    isStructType,
    isInterfaceType,
    isUnionType,
    isJoinType,
    isArrayType,
    isFunctionType,
    isNullableType,
    isTupleType,
    isReferenceType,
    isPrototypeType
} from './type-c-types.js';
import * as factory from './type-factory.js';
import { simplifyType, substituteGenerics } from './type-utils.js';

/**
 * Main type provider service.
 * Provides type inference for all AST nodes in Type-C.
 */
export class TypeCTypeProvider {
    /** Cache for computed types, keyed by AST node */
    private readonly typeCache = new WeakMap<AstNode, TypeDescription>();
    
    /** Services for accessing Langium infrastructure */
    protected readonly services: TypeCServices;
    
    /** Built-in prototype types (array, coroutine) */
    private readonly builtinPrototypes = new Map<string, TypeDescription>();

    constructor(services: TypeCServices) {
        this.services = services;
    }

    // ========================================================================
    // Main Type Inference Entry Points
    // ========================================================================

    /**
     * Gets the type of any AST node with caching.
     * 
     * **This is the main entry point for type inference.**
     * 
     * **How it works:**
     * 1. Checks type cache (WeakMap) for previously computed result
     * 2. If not cached, delegates to `computeType()` to infer the type
     * 3. Caches result for future lookups
     * 4. Returns the type description
     * 
     * **Used by:**
     * - Hover providers (to show type info)
     * - Scope providers (to resolve member access)
     * - Validators (to check type compatibility)
     * - Recursively during type inference
     * 
     * @param node AST node to get type for (can be undefined for safety)
     * @returns TypeDescription representing the inferred type
     * 
     * @example
     * ```typescript
     * const varDecl = ... // VariableDeclaration node
     * const type = typeProvider.getType(varDecl);
     * console.log(type.toString()); // "u32"
     * ```
     */
    getType(node: AstNode | undefined): TypeDescription {
        if (!node) {
            return factory.createErrorType('Node is undefined');
        }

        // Check cache first
        const cached = this.typeCache.get(node);
        if (cached) {
            return cached;
        }

        // Compute type based on node type
        const type = this.computeType(node);
        
        // Cache result
        this.typeCache.set(node, type);
        
        return type;
    }

    /**
     * Invalidates the type cache for a node and its descendants.
     * Call this when an AST node changes.
     */
    invalidateCache(node: AstNode): void {
        this.typeCache.delete(node);
        // Also invalidate children
        for (const child of AstUtils.streamAllContents(node)) {
            this.typeCache.delete(child);
        }
    }

    /**
     * Public method to get expression types.
     * Used by scope provider for member access completions.
     */
    getExpressionType(expr: ast.Expression): TypeDescription {
        return this.inferExpression(expr);
    }

    /**
     * Gets identifiable fields from a type for scope resolution and auto-completion.
     * 
     * **Purpose:**
     * Returns AST nodes that can be referenced in member access expressions (`obj.member`).
     * Used by the scope provider to populate auto-completion suggestions and enable
     * "Go to Definition" navigation.
     * 
     * **How it works:**
     * 1. Resolves reference types to their actual definitions
     * 2. For arrays: fetches built-in prototype methods (length, slice, etc.)
     * 3. For classes: returns attribute and method AST nodes
     * 4. For structs: returns field AST nodes
     * 5. For interfaces: returns method AST nodes
     * 6. For prototypes: returns builtin symbol AST nodes
     * 
     * **Why return AST nodes?**
     * - Langium's scope provider expects AST nodes for cross-references
     * - Nodes contain source location for "Go to Definition"
     * - Nodes can be used to generate hover information
     * 
     * **Important:** Generic substitutions are NOT applied here. They're applied later
     * in `inferMemberAccess()` to provide context-specific types (e.g., `Array<u32>` vs `Array<T>`).
     * 
     * @param type The type description to extract members from
     * @returns Array of AST nodes representing accessible members
     * 
     * @example
     * ```typescript
     * // For: class Person { let name: string; fn greet() -> void }
     * const fields = getIdentifiableFields(personType);
     * // Returns: [ClassAttributeDecl("name"), ClassMethod("greet")]
     * 
     * // For: u32[]
     * const fields = getIdentifiableFields(arrayType);
     * // Returns: [BuiltinSymbolID("length"), BuiltinSymbolFn("slice"), ...]
     * ```
     */
    getIdentifiableFields(type: TypeDescription): AstNode[] {
        const nodes: AstNode[] = [];
        
        // Reference types - resolve and recurse
        if (isReferenceType(type)) {
            const resolvedType = this.resolveReference(type);
            // Recursively get fields from the resolved type
            return this.getIdentifiableFields(resolvedType);
        }
        
        // Nullable types - unwrap and get fields from base type
        // Example: Array<u32>? → get fields from Array<u32>
        if (isNullableType(type)) {
            return this.getIdentifiableFields(type.baseType);
        }
        
        // Array types - get prototype methods (length, push, pop, etc.)
        if (isArrayType(type)) {
            const prototypeType = this.getArrayPrototype();
            if (prototypeType.node && ast.isBuiltinDefinition(prototypeType.node)) {
                // Return the builtin symbols (methods/properties) as identifiable nodes
                nodes.push(...prototypeType.node.symbols);
            }
        }
        
        // Class members (attributes and methods)
        if (isClassType(type) && type.node && ast.isClassType(type.node)) {
            // Get attributes from the AST node
            if (type.node.attributes) {
                nodes.push(...type.node.attributes);
            }
            // Get methods from the AST node
            // Note: Each method can have multiple names (operator overloading), but we return
            // the method node itself. The scope provider will handle exposing all names.
            if (type.node.methods) {
                nodes.push(...type.node.methods);
            }
        }
        
        // Struct fields
        if (isStructType(type) && type.node && ast.isStructType(type.node)) {
            nodes.push(...type.node.fields);
        }
        
        // Interface methods
        if (isInterfaceType(type) && type.node && ast.isInterfaceType(type.node)) {
            nodes.push(...type.node.methods);
        }
        
        // Prototype methods (for direct prototype access, though usually accessed via array/coroutine)
        if (isPrototypeType(type)) {
            if (type.node && ast.isBuiltinDefinition(type.node)) {
                nodes.push(...type.node.symbols);
            }
        }
        
        return nodes;
    }

    /**
     * Main type computation dispatcher.
     * Routes to appropriate type inference method based on AST node type.
     */
    private computeType(node: AstNode): TypeDescription {
        // DataType nodes (explicit type annotations)
        if (ast.isArrayType(node)) return this.inferArrayType(node);
        if (ast.isNullableType(node)) return this.inferNullableType(node);
        if (ast.isUnionType(node)) return this.inferUnionType(node);
        if (ast.isJoinType(node)) return this.inferJoinType(node);
        // Tuple types are represented directly in grammar, not as separate AST nodes
        if (node.$type === 'TupleType') return this.inferTupleTypeFromDataType(node as any);
        if (ast.isPrimitiveType(node)) return factory.createPrimitiveTypeFromAST(node);
        if (ast.isStructType(node)) return this.inferStructType(node);
        if (ast.isVariantType(node)) return this.inferVariantType(node);
        if (ast.isEnumType(node)) return this.inferEnumType(node);
        if (ast.isStringEnumType(node)) return this.inferStringEnumType(node);
        if (ast.isInterfaceType(node)) return this.inferInterfaceType(node);
        if (ast.isClassType(node)) return this.inferClassType(node);
        if (ast.isImplementationType(node)) return this.inferImplementationType(node);
        if (ast.isFunctionType(node)) return this.inferFunctionType(node);
        if (ast.isCoroutineType(node)) return this.inferCoroutineType(node);
        if (ast.isReturnType(node)) return this.inferReturnType(node);
        if (ast.isReferenceType(node)) return this.inferReferenceType(node);

        // Declarations
        if (ast.isTypeDeclaration(node)) return this.getType(node.definition);
        if (ast.isFunctionDeclaration(node)) return this.inferFunctionDeclaration(node);
        if (ast.isVariableDeclaration(node)) return this.inferVariableDeclaration(node);
        if (ast.isClassAttributeDecl(node)) return this.getType(node.type);
        if (ast.isFunctionParameter(node)) return this.getType(node.type);
        if (ast.isGenericType(node)) return this.inferGenericType(node);
        if (ast.isNamespaceDecl(node)) return factory.createNamespaceType(node.name, node, node);
        if (ast.isExternFFIDecl(node)) return this.inferFFIDecl(node);
        
        // Class/Interface members
        if (ast.isMethodHeader(node)) return this.inferMethodHeaderAsType(node);
        if (ast.isClassMethod(node)) return this.inferMethodHeaderAsType(node.method);

        // Expressions
        if (ast.isExpression(node)) return this.inferExpression(node);

        // Enum and Variant members
        if (ast.isEnumCase(node)) {
            const enumType = AstUtils.getContainerOfType(node, ast.isEnumType);
            return enumType ? this.getType(enumType) : factory.createErrorType('Enum case outside enum', undefined, node);
        }
        if (ast.isVariantConstructor(node)) {
            const variantType = AstUtils.getContainerOfType(node, ast.isVariantType);
            return variantType ? this.getType(variantType) : factory.createErrorType('Variant constructor outside variant', undefined, node);
        }

        // Built-in prototypes
        if (ast.isBuiltinDefinition(node)) return this.inferBuiltinDefinition(node);
        
        // Built-in symbols
        if (ast.isBuiltinSymbolID(node)) return this.getType(node.type);
        if (ast.isBuiltinSymbolFn(node)) {
            const params = node.args.map(arg => factory.createFunctionParameterType(
                arg.name,
                this.getType(arg.type),
                arg.isMut
            ));
            return factory.createFunctionType(params, this.getType(node.returnType), 'fn', [], node);
        }

        return factory.createErrorType(`Cannot infer type for ${node.$type}`, undefined, node);
    }

    // ========================================================================
    // DataType Inference
    // ========================================================================

    private inferArrayType(node: ast.ArrayType): TypeDescription {
        const elementType = this.getType(node.arrayOf);
        return factory.createArrayType(elementType, node);
    }

    private inferNullableType(node: ast.NullableType): TypeDescription {
        const baseType = this.getType(node.baseType);
        return factory.createNullableType(baseType, node);
    }

    private inferUnionType(node: ast.UnionType): TypeDescription {
        const left = this.getType(node.left);
        const right = this.getType(node.right);
        
        // Flatten nested unions
        const types: TypeDescription[] = [];
        if (isUnionType(left)) {
            types.push(...left.types);
        } else {
            types.push(left);
        }
        if (isUnionType(right)) {
            types.push(...right.types);
        } else {
            types.push(right);
        }
        
        return simplifyType(factory.createUnionType(types, node));
    }

    private inferJoinType(node: ast.JoinType): TypeDescription {
        const left = this.getType(node.left);
        const right = this.getType(node.right);
        
        // Flatten nested joins (intersections)
        const types: TypeDescription[] = [];
        if (isJoinType(left)) {
            types.push(...left.types);
        } else {
            types.push(left);
        }
        if (isJoinType(right)) {
            types.push(...right.types);
        } else {
            types.push(right);
        }
        
        return simplifyType(factory.createJoinType(types, node));
    }

    private inferTupleTypeFromDataType(node: any): TypeDescription {
        // Tuple types have a 'types' property with array of DataType
        if (node.types && Array.isArray(node.types)) {
            const elementTypes = node.types.map((t: any) => this.getType(t));
            return factory.createTupleType(elementTypes, node);
        }
        return factory.createErrorType('Invalid tuple type', undefined, node);
    }

    private inferStructType(node: ast.StructType): TypeDescription {
        const fields = node.fields.map(f => factory.createStructField(
            f.name,
            this.getType(f.type)
        ));
        return factory.createStructType(fields, !node.name, node);
    }

    private inferVariantType(node: ast.VariantType): TypeDescription {
        const constructors = node.constructors.map(c => factory.createVariantConstructor(
            c.name,
            c.params?.map(p => factory.createStructField(p.name, this.getType(p.type))) ?? []
        ));
        return factory.createVariantType(constructors, node);
    }

    private inferEnumType(node: ast.EnumType): TypeDescription {
        const cases = node.cases.map(c => factory.createEnumCase(
            c.name,
            c.init ? this.evalIntegerLiteral(c.init) : undefined
        ));
        
        const encoding = node.encoding 
            ? factory.createIntegerTypeFromString(node.encoding, node)
            : undefined;
        
        return factory.createEnumType(cases, encoding, node);
    }

    private evalIntegerLiteral(node: ast.IntegerLiteral): number | undefined {
        // Simple integer literal evaluation
        // In a full implementation, this would handle all integer formats
        try {
            if (ast.isDecimalIntegerLiteral(node)) {
                return parseInt(node.value.replace(/[iu]\d+$/, ''), 10);
            }
            if (ast.isHexadecimalIntegerLiteral(node)) {
                return parseInt(node.value.replace(/^0x|[iu]\d+$/g, ''), 16);
            }
            if (ast.isBinaryIntegerLiteral(node)) {
                return parseInt(node.value.replace(/^0b|[iu]\d+$/g, ''), 2);
            }
            if (ast.isOctalIntegerLiteral(node)) {
                return parseInt(node.value.replace(/^0o|[iu]\d+$/g, ''), 8);
            }
        } catch {
            return undefined;
        }
        return undefined;
    }

    private inferStringEnumType(node: ast.StringEnumType): TypeDescription {
        // Remove quotes from string literals
        const values = node.cases.map(c => c.substring(1, c.length - 1));
        return factory.createStringEnumType(values, node);
    }

    private inferInterfaceType(node: ast.InterfaceType): TypeDescription {
        const methods = node.methods.map(m => this.inferMethodHeader(m));
        const superTypes = node.superTypes?.map(t => this.getType(t)) ?? [];
        return factory.createInterfaceType(methods, superTypes, node);
    }

    private inferClassType(node: ast.ClassType): TypeDescription {
        const attributes = node.attributes?.flatMap((attrDecl: any) => 
            (attrDecl.attributes || []).map((a: any) => factory.createAttributeType(
                a.name,
                this.getType(a.type),
                a.isStatic ?? false,
                a.isConst ?? false,
                a.isLocal ?? false
            ))
        ) ?? [];

        const methods = node.methods?.map(m => {
            const methodHeader = this.inferMethodHeader(m.method);
            return {
                ...methodHeader,
                isStatic: m.isStatic ?? false,
                isOverride: m.isOverride ?? false,
                isLocal: m.isLocal ?? false
            };
        }) ?? [];

        const superTypes = node.superTypes?.map(t => this.getType(t)) ?? [];
        
        const implementations = node.implementations?.map(impl => this.getType(impl.type)) ?? [];

        return factory.createClassType(attributes, methods, superTypes, implementations, node);
    }

    private inferImplementationType(node: ast.ImplementationType): TypeDescription {
        const attributes = node.attributes?.map(a => factory.createAttributeType(
            a.name,
            this.getType(a.type),
            a.isStatic ?? false,
            a.isConst ?? false,
            false
        )) ?? [];

        const methods = node.methods?.map(m => {
            const methodHeader = this.inferMethodHeader(m.method);
            return {
                ...methodHeader,
                isStatic: m.isStatic ?? false,
                isOverride: false,
                isLocal: false
            };
        }) ?? [];

        const targetType = node.superType ? this.getType(node.superType) : undefined;

        return factory.createImplementationType(attributes, methods, targetType, node);
    }

    private inferMethodHeader(node: ast.MethodHeader): MethodType {
        const genericParams = node.genericParameters?.map(g => this.inferGenericType(g)) as GenericTypeDescription[] ?? [];
        const params = node.header?.args?.map(arg => factory.createFunctionParameterType(
            arg.name,
            this.getType(arg.type),
            arg.isMut
        )) ?? [];
        const returnType = node.header?.returnType 
            ? this.getType(node.header.returnType)
            : factory.createVoidType(node);

        return factory.createMethodType(
            node.names,
            params,
            returnType,
            genericParams
        );
    }

    /**
     * Converts a MethodHeader to a FunctionType for type display and checking.
     * This is used when hovering over a method or getting its type for other purposes.
     */
    private inferMethodHeaderAsType(node: ast.MethodHeader): TypeDescription {
        const methodType = this.inferMethodHeader(node);
        return factory.createFunctionType(
            methodType.parameters,
            methodType.returnType,
            'fn',
            methodType.genericParameters,
            node
        );
    }

    private inferFunctionType(node: ast.FunctionType): TypeDescription {
        const params = node.header?.args?.map(arg => factory.createFunctionParameterType(
            arg.name,
            this.getType(arg.type),
            arg.isMut
        )) ?? [];
        const returnType = node.header?.returnType 
            ? this.getType(node.header.returnType)
            : factory.createVoidType(node);

        return factory.createFunctionType(params, returnType, node.fnType, [], node);
    }

    private inferCoroutineType(node: ast.CoroutineType): TypeDescription {
        const params = node.header?.args?.map(arg => factory.createFunctionParameterType(
            arg.name,
            this.getType(arg.type),
            arg.isMut
        )) ?? [];
        const returnType = node.header?.returnType 
            ? this.getType(node.header.returnType)
            : factory.createVoidType(node);

        // For coroutines, we need to infer the yield type
        // This would require flow analysis - for now, use 'any'
        const yieldType = factory.createAnyType(node);

        return factory.createCoroutineType(params, returnType, yieldType, 'fn', node);
    }

    private inferReturnType(node: ast.ReturnType): TypeDescription {
        const returnType = this.getType(node.returnType);
        return factory.createReturnType(returnType, node);
    }

    private inferReferenceType(node: ast.ReferenceType): TypeDescription {
        if (!node.qname || !node.qname.ref) {
            return factory.createErrorType('Unresolved type reference', undefined, node);
        }

        const declaration = node.qname.ref;
        
        // Handle references to generic type parameters (e.g., T in Array<T>)
        if (ast.isGenericType(declaration)) {
            // This is a reference to a generic type parameter
            // We already have the type computed for it, just return it
            return this.getType(declaration);
        }
        
        // Handle references to type declarations (e.g., Array, MyClass, etc.)
        if (ast.isTypeDeclaration(declaration)) {
            const genericArgs = node.genericArgs?.map(arg => this.getType(arg)) ?? [];
            return factory.createReferenceType(declaration, genericArgs, node);
        }

        // Handle any other identifiable references that might be types
        const declType = (declaration as any).$type || 'unknown';
        return factory.createErrorType(
            `Reference does not point to a type declaration or generic parameter (found: ${declType})`, 
            undefined, 
            node
        );
    }

    /**
     * Resolves a reference type to its actual type definition.
     * Handles generic substitution.
     */
    resolveReference(refType: TypeDescription): TypeDescription {
        if (!isReferenceType(refType)) {
            return refType;
        }

        // Check if already resolved
        if (refType.actualType) {
            return refType.actualType;
        }

        // Get the actual type from the declaration
        const actualType = this.getType(refType.declaration.definition);

        // If there are generic arguments, substitute them
        if (refType.genericArgs.length > 0 && refType.declaration.genericParameters) {
            const substitutions = new Map<string, TypeDescription>();
            refType.declaration.genericParameters.forEach((param, i) => {
                if (i < refType.genericArgs.length) {
                    substitutions.set(param.name, refType.genericArgs[i]);
                }
            });

            const substitutedType = substituteGenerics(actualType, substitutions);
            
            // Cache the resolved type (mutating for caching purposes)
            (refType as any).actualType = substitutedType;
            
            return substitutedType;
        }

        // Cache the resolved type (mutating for caching purposes)
        (refType as any).actualType = actualType;
        
        return actualType;
    }

    private inferGenericType(node: ast.GenericType): TypeDescription {
        const constraint = node.constraint ? this.getType(node.constraint) : undefined;
        return factory.createGenericType(node.name, constraint, node, node);
    }

    private inferFFIDecl(node: ast.ExternFFIDecl): TypeDescription {
        const methods = node.methods?.map(m => {
            const params = m.header.args?.map(arg => factory.createFunctionParameterType(
                arg.name,
                this.getType(arg.type),
                arg.isMut
            )) ?? [];
            const returnType = m.header.returnType 
                ? this.getType(m.header.returnType)
                : factory.createVoidType(m);

            return factory.createMethodType([m.name], params, returnType);
        }) ?? [];

        return factory.createFFIType(
            node.name,
            node.dynlib.substring(1, node.dynlib.length - 1), // Remove quotes
            methods,
            node.isLocal ?? false,
            node
        );
    }

    /**
     * Converts a built-in prototype definition to a PrototypeTypeDescription.
     * 
     * **Purpose:**
     * Parses the built-in prototype syntax (e.g., for arrays and coroutines) and
     * creates a structured type description that can be used for type checking
     * and auto-completion.
     * 
     * **Input format:**
     * ```
     * prototype for array {
     *     length: u64
     *     fn slice<T>(start: u64, end: u64) -> T[]
     * }
     * ```
     * 
     * **Output:**
     * ```
     * PrototypeTypeDescription {
     *   targetKind: 'array',
     *   properties: [{ name: 'length', type: u64 }],
     *   methods: [{ name: 'slice', functionType: fn<T>(u64, u64) -> T[] }]
     * }
     * ```
     * 
     * **How it works:**
     * 1. Iterate through all symbols in the builtin definition
     * 2. Separate into methods (BuiltinSymbolFn) and properties (BuiltinSymbolID)
     * 3. For methods: create FunctionTypeDescription with parameters and return type
     * 4. For properties: extract type directly
     * 5. Package into a PrototypeTypeDescription
     * 
     * **Used by:**
     * - `getArrayPrototype()`: Loads array builtin methods
     * - `getCoroutinePrototype()`: Loads coroutine builtin methods
     * - `getIdentifiableFields()`: Provides AST nodes for auto-completion
     * 
     * @param node BuiltinDefinition AST node from prototypes file
     * @returns PrototypeTypeDescription with methods and properties
     */
    private inferBuiltinDefinition(node: ast.BuiltinDefinition): TypeDescription {
        const methods: PrototypeMethodType[] = [];
        const properties: StructFieldType[] = [];

        for (const symbol of node.symbols) {
            if (ast.isBuiltinSymbolFn(symbol)) {
                // Function/method symbol
                // Extract generic parameters from the function's AST
                const genericParams = symbol.genericParameters?.map(g => this.inferGenericType(g)) as GenericTypeDescription[] ?? [];
                
                const params = symbol.args.map(arg => factory.createFunctionParameterType(
                    arg.name,
                    this.getType(arg.type),
                    arg.isMut
                ));
                const returnType = this.getType(symbol.returnType);
                
                // Create function type WITH generic parameters from the AST
                const functionType = factory.createFunctionType(params, returnType, 'fn', genericParams, symbol);
                
                methods.push({
                    name: symbol.name,
                    functionType
                });
            } else if (ast.isBuiltinSymbolID(symbol)) {
                // Property symbol (e.g., array.length)
                properties.push({
                    name: symbol.name,
                    type: this.getType(symbol.type)
                });
            }
        }

        return factory.createPrototypeType(node.name, methods, properties, node);
    }

    // ========================================================================
    // Declaration Type Inference
    // ========================================================================

    private inferFunctionDeclaration(node: ast.FunctionDeclaration): TypeDescription {
        const genericParams = node.genericParameters?.map(g => this.inferGenericType(g)) as GenericTypeDescription[] ?? [];
        const params = node.header?.args?.map(arg => factory.createFunctionParameterType(
            arg.name,
            this.getType(arg.type),
            arg.isMut
        )) ?? [];
        const returnType = node.header?.returnType 
            ? this.getType(node.header.returnType)
            : this.inferReturnTypeFromBody(node.body, node.expr);

        return factory.createFunctionType(params, returnType, node.fnType, genericParams, node);
    }

    private inferReturnTypeFromBody(body?: ast.BlockStatement, expr?: ast.Expression): TypeDescription {
        // TODO: Implement full return type inference from function body
        // For now, return void
        if (expr) {
            return this.getType(expr);
        }
        return factory.createVoidType();
    }

    /**
     * Infers the type of a variable declaration.
     * 
     * **Handles three cases:**
     * 1. Explicit annotation: `let x: u32 = ...`
     * 2. Nullable suffix: `let x? = ...` → wraps inferred type in nullable
     * 3. Type inference: `let x = ...` → infers from initializer
     * 
     * **Examples:**
     * ```typescript
     * let x: u32 = 10           → u32
     * let y = 10                → u32 (inferred)
     * let z? = 10               → u32? (nullable)
     * let arr? = new Array<u32> → Array<u32>? (nullable)
     * ```
     * 
     * @param node VariableDeclaration AST node
     * @returns Type of the variable
     */
    private inferVariableDeclaration(node: ast.VariableDeclaration): TypeDescription {
        // If there's an explicit annotation, use it
        if (node.annotation) {
            return this.getType(node.annotation);
        }

        // Infer type from initializer
        let inferredType: TypeDescription;
        if (node.initializer) {
            inferredType = this.inferExpression(node.initializer);
        } else {
            return factory.createErrorType('Variable has no type annotation or initializer', undefined, node);
        }

        // Check if variable is marked as nullable with the `?` suffix
        // Example: let arr? = new Array<u32>(10) → Array<u32>?
        if ((node as any).isNullable) {
            return factory.createNullableType(inferredType, node);
        }

        return inferredType;
    }

    // ========================================================================
    // Expression Type Inference
    // ========================================================================

    private inferExpression(node: ast.Expression): TypeDescription {
        // Literals
        if (ast.isIntegerLiteral(node)) return this.inferIntegerLiteral(node);
        if (ast.isFloatingPointLiteral(node)) return this.inferFloatLiteral(node);
        if (ast.isStringLiteralExpression(node)) return factory.createStringType(node);
        if (ast.isBinaryStringLiteralExpression(node)) {
            return factory.createArrayType(factory.createU8Type(node), node);
        }
        if (ast.isTrueBooleanLiteral(node) || ast.isFalseBooleanLiteral(node)) {
            return factory.createBoolType(node);
        }
        if (ast.isNullLiteralExpression(node)) return factory.createNullType(node);

        // References
        if (ast.isQualifiedReference(node)) return this.inferQualifiedReference(node);
        if (ast.isGenericReferenceExpr(node)) return this.inferGenericReferenceExpr(node);

        // Operations
        if (ast.isBinaryExpression(node)) return this.inferBinaryExpression(node);
        if (ast.isUnaryExpression(node)) return this.inferUnaryExpression(node);
        
        // Member access
        if (ast.isMemberAccess(node)) return this.inferMemberAccess(node);
        if (ast.isFunctionCall(node)) return this.inferFunctionCall(node);
        if (ast.isIndexAccess(node)) return this.inferIndexAccess(node);
        if (ast.isIndexSet(node)) return this.inferIndexSet(node);

        // Construction
        if (ast.isArrayConstructionExpression(node)) return this.inferArrayConstruction(node);
        if (ast.isNamedStructConstructionExpression(node)) return this.inferNamedStructConstruction(node);
        if (ast.isAnonymousStructConstructionExpression(node)) return this.inferAnonymousStructConstruction(node);
        if (ast.isNewExpression(node)) return this.inferNewExpression(node);
        if (ast.isLambdaExpression(node)) return this.inferLambdaExpression(node);

        // Control flow
        if (ast.isConditionalExpression(node)) return this.inferConditionalExpression(node);
        if (ast.isMatchExpression(node)) return this.inferMatchExpression(node);
        if (ast.isLetInExpression(node)) return this.inferLetInExpression(node);
        if (ast.isDoExpression(node)) return this.inferDoExpression(node);

        // Type operations
        if (ast.isTypeCastExpression(node)) return this.inferTypeCastExpression(node);
        if (ast.isInstanceCheckExpression(node)) return factory.createBoolType(node);

        // Special
        if (ast.isThisExpression(node)) return this.inferThisExpression(node);
        if (ast.isThrowExpression(node)) return factory.createNeverType(node);
        if (ast.isUnreachableExpression(node)) return factory.createNeverType(node);
        if (ast.isYieldExpression(node)) return this.inferYieldExpression(node);
        if (ast.isCoroutineExpression(node)) return this.inferCoroutineExpression(node);
        if (ast.isDenullExpression(node)) return this.inferDenullExpression(node);
        if (ast.isTupleExpression(node)) return this.inferTupleExpression(node);
        if (ast.isWildcardExpression(node)) return factory.createAnyType(node);

        return factory.createErrorType(`Cannot infer type for expression: ${node.$type}`, undefined, node);
    }

    private inferIntegerLiteral(node: ast.IntegerLiteral): TypeDescription {
        // Extract type suffix if present
        const value = node.value;
        const suffixMatch = value.match(/([iu])(8|16|32|64)$/);
        
        if (suffixMatch) {
            const typeStr = suffixMatch[0];
            return factory.createIntegerTypeFromString(typeStr, node) 
                ?? factory.createI32Type(node);
        }
        
        // Default to i32 for decimal literals without suffix
        return factory.createI32Type(node);
    }

    private inferFloatLiteral(node: ast.FloatingPointLiteral): TypeDescription {
        if (ast.isFloatLiteral(node)) {
            return factory.createF32Type(node);
        }
        return factory.createF64Type(node);
    }

    private inferQualifiedReference(node: ast.QualifiedReference): TypeDescription {
        const ref = node.reference as any;
        if (!ref || !ref.ref) {
            return factory.createErrorType('Unresolved reference', undefined, node);
        }

        return this.getType(ref.ref);
    }

    private inferGenericReferenceExpr(node: ast.GenericReferenceExpr): TypeDescription {
        const ref = node.reference as any;  // Grammar uses cross-references which are dynamic
        if (!ref || !ref.ref) {
            return factory.createErrorType('Unresolved reference', undefined, node);
        }

        const baseType = this.getType(ref.ref);
        
        // If base type is a generic function or class, substitute generic args
        if (isFunctionType(baseType) && baseType.genericParameters.length > 0) {
            const genericArgs = node.genericArgs?.map(arg => this.getType(arg)) ?? [];
            const substitutions = new Map<string, TypeDescription>();
            baseType.genericParameters.forEach((param, i) => {
                if (i < genericArgs.length) {
                    substitutions.set(param.name, genericArgs[i]);
                }
            });
            
            return substituteGenerics(baseType, substitutions);
        }

        return baseType;
    }

    private inferBinaryExpression(node: ast.BinaryExpression): TypeDescription {
        const left = this.inferExpression(node.left);
        const right = this.inferExpression(node.right);
        
        // Assignment operators return the type of the right operand
        if (node.op === '=' || node.op?.endsWith('=')) {
            return right;
        }
        
        // Comparison operators return bool
        if (['==', '!=', '<', '>', '<=', '>='].includes(node.op)) {
            return factory.createBoolType(node);
        }
        
        // Logical operators
        if (['&&', '||'].includes(node.op)) {
            return factory.createBoolType(node);
        }
        
        // Null coalescing
        if (node.op === '??') {
            // T? ?? T -> T
            if (isNullableType(left)) {
                return left.baseType;
            }
            return left;
        }
        
        // Arithmetic operators - use left operand's type (simplified)
        // In a full implementation, this would have proper type promotion rules
        return left;
    }

    private inferUnaryExpression(node: ast.UnaryExpression): TypeDescription {
        const exprType = this.inferExpression(node.expr);
        
        if (node.op === '!') {
            return factory.createBoolType(node);
        }
        
        // Other unary operators preserve the type
        return exprType;
    }

    /**
     * Infers the type of member access expressions (e.g., `obj.field`, `arr.length`, `arr?.clone()`).
     * 
     * **This is the most critical method for generic type substitution.**
     * 
     * **How it works:**
     * 1. Infer the type of the base expression (`obj` in `obj.field`)
     * 2. Handle nullable member access (`?.`):
     *    - If base is nullable, unwrap to get inner type
     *    - Perform member lookup on inner type
     *    - Wrap result in nullable (since it may be null)
     * 3. If the base is a reference type with generic args (e.g., `Array<u32>`):
     *    - Extract the generic substitutions (T → u32)
     *    - Resolve to the actual type definition (Array)
     * 4. Look up the member in the appropriate place:
     *    - Arrays: check array prototype (length, slice, etc.)
     *    - Classes: check attributes and methods
     *    - Structs: check fields
     *    - Interfaces: check methods  
     * 5. Apply generic substitutions to the member's type
     * 6. If using `?.`, wrap final result in nullable
     * 7. Return the fully resolved type
     * 
     * **Generic substitution example:**
     * ```
     * arr: Array<u32>
     * arr.clone() where clone is defined as: fn clone() -> Array<T>
     * 
     * 1. Base type: ReferenceType { Array, genericArgs: [u32] }
     * 2. Substitutions: { T → u32 }
     * 3. Member type: fn() -> Array<T>
     * 4. After substitution: fn() -> Array<u32>  ✅
     * ```
     * 
     * **Nullable member access example:**
     * ```
     * arr?: Array<u32>
     * arr?.clone()
     * 
     * 1. Base type: NullableType { baseType: Array<u32> }
     * 2. Using ?.  → Unwrap: Array<u32>
     * 3. Member type: fn() -> Array<u32>
     * 4. Wrap result: fn() -> Array<u32>?  ✅
     * ```
     * 
     * **Why this matters:**
     * - Without substitution: hover shows `fn() -> Array<T>` (generic)
     * - With substitution: hover shows `fn() -> Array<u32>` (concrete)
     * - With `?.`: hover shows nullable result type
     * 
     * @param node MemberAccess AST node (`base.member` or `base?.member`)
     * @returns Type of the accessed member with generics substituted (and wrapped in nullable if using `?.`)
     */
    private inferMemberAccess(node: ast.MemberAccess): TypeDescription {
        let baseType = this.inferExpression(node.expr);
        const memberName = node.element?.$refText || '';
        
        // Check if this is nullable member access (e.g., arr?.clone())
        const isNullableAccess = (node as any).isNullable === true;
        
        // If using nullable member access, unwrap the base type
        let wasNullable = false;
        if (isNullableType(baseType)) {
            if (isNullableAccess) {
                // arr?: Array<u32> with arr?.member → unwrap to Array<u32>
                wasNullable = true;
                baseType = baseType.baseType;
            } else {
                // arr?: Array<u32> with arr.member → error (accessing nullable without ?.)
                // For now, we'll auto-unwrap and continue, but this should ideally be a validation error
                baseType = baseType.baseType;
            }
        }
        
        // Keep track of generic substitutions if we have a reference type with concrete args
        let genericSubstitutions: Map<string, TypeDescription> | undefined;
        
        // If base type is a reference type (e.g., Array<u32>), resolve it but keep the generic args
        if (isReferenceType(baseType)) {
            const refType = baseType;
            // Build substitution map from generic parameters to concrete arguments
            // Example: Array<u32> → { T: u32 }
            if (refType.genericArgs.length > 0 && refType.declaration.genericParameters) {
                genericSubstitutions = new Map();
                refType.declaration.genericParameters.forEach((param, i) => {
                    if (i < refType.genericArgs.length) {
                        genericSubstitutions!.set(param.name, refType.genericArgs[i]);
                    }
                });
            }
            // Resolve to get the actual type definition (Array class with T parameter)
            baseType = this.resolveReference(refType);
        }
        
        // Variable to hold the resolved member type
        let memberType: TypeDescription | undefined;
        
        // Handle array/coroutine built-in prototypes
        if (isArrayType(baseType)) {
            const prototypeType = this.getArrayPrototype();
            if (isPrototypeType(prototypeType)) {
                const member = [...prototypeType.methods, ...prototypeType.properties]
                    .find(m => 'name' in m && m.name === memberName);
                if (member) {
                    if ('functionType' in member) {
                        // Build substitution map from the function's actual generic parameters
                        // Example: fn slice<T>(start: u64, end: u64) -> T[]
                        // Generic parameter name is 'T', substitute with array's element type
                        const substitutions = new Map<string, TypeDescription>();
                        if (member.functionType.genericParameters) {
                            // For array prototypes, substitute the first generic param with element type
                            // This handles both <T> and any other name like <Element>, <E>, etc.
                            member.functionType.genericParameters.forEach((param, i) => {
                                if (i === 0) {
                                    // First generic param represents the array element type
                                    substitutions.set(param.name, baseType.elementType);
                                }
                            });
                        }
                        memberType = substituteGenerics(member.functionType, substitutions);
                    } else {
                        memberType = member.type;
                    }
                }
            }
        }
        
        // Handle struct fields
        if (!memberType && isStructType(baseType)) {
            const field = baseType.fields.find(f => f.name === memberName);
            if (field) {
                // Apply generic substitutions if we have them
                memberType = genericSubstitutions 
                    ? substituteGenerics(field.type, genericSubstitutions)
                    : field.type;
            }
        }
        
        // Handle class attributes and methods
        if (!memberType && isClassType(baseType)) {
            const attr = baseType.attributes.find(a => a.name === memberName);
            if (attr) {
                // Apply generic substitutions if we have them
                memberType = genericSubstitutions 
                    ? substituteGenerics(attr.type, genericSubstitutions)
                    : attr.type;
            } else {
                const method = baseType.methods.find(m => m.names.includes(memberName));
                if (method) {
                    let functionType = factory.createFunctionType(
                        method.parameters,
                        method.returnType,
                        'fn',
                        method.genericParameters
                    );
                    
                    // Apply generic substitutions if we have them (e.g., T -> u32 in Array<u32>)
                    if (genericSubstitutions) {
                        functionType = substituteGenerics(functionType, genericSubstitutions) as any;
                    }
                    
                    memberType = functionType;
                }
            }
        }
        
        // If member not found, return error
        if (!memberType) {
            return factory.createErrorType(`Member '${memberName}' not found`, undefined, node);
        }
        
        // If using nullable member access (?.),  wrap the result in nullable
        // Example: arr?.clone() where arr: Array<u32>? → result is Array<u32>?
        if (isNullableAccess && wasNullable) {
            return factory.createNullableType(memberType, node);
        }
        
        return memberType;
    }

    private inferFunctionCall(node: ast.FunctionCall): TypeDescription {
        let fnType = this.inferExpression(node.expr);
        
        // Resolve reference types first
        if (isReferenceType(fnType)) {
            fnType = this.resolveReference(fnType);
        }
        
        // Handle regular function types
        if (isFunctionType(fnType)) {
            // TODO: Handle generic argument substitution if node.genericArgs is present
            return fnType.returnType;
        }
        
        // Handle variant constructor calls
        if (fnType.kind === TypeKind.Variant) {
            return fnType;
        }
        
        // Handle callable classes (classes with () operator overload)
        if (isClassType(fnType)) {
            // Look for the () operator method
            const callOperator = fnType.methods.find(m => m.names.includes('()'));
            if (callOperator) {
                // TODO: Validate argument types match parameters
                return callOperator.returnType;
            }
            // If no call operator found, this is an error
            return factory.createErrorType(
                `Class type does not have a call operator '()'. Use 'new' for constructors.`,
                undefined,
                node
            );
        }
        
        // Handle callable interfaces (interfaces with () operator overload)
        if (isInterfaceType(fnType)) {
            const callOperator = fnType.methods.find(m => m.names.includes('()'));
            if (callOperator) {
                // TODO: Validate argument types match parameters
                return callOperator.returnType;
            }
            return factory.createErrorType(
                `Interface type does not have a call operator '()'`,
                undefined,
                node
            );
        }
        
        return factory.createErrorType(
            `Cannot call value of type '${fnType.toString()}'. Only functions, callable classes/interfaces, and variant constructors can be called.`,
            undefined,
            node
        );
    }

    private inferIndexAccess(node: ast.IndexAccess): TypeDescription {
        const baseType = this.inferExpression(node.expr);
        
        if (isArrayType(baseType)) {
            return baseType.elementType;
        }
        
        if (isTupleType(baseType) && node.indexes.length === 1) {
            const index = this.evalIntegerLiteral(node.indexes[0] as ast.IntegerLiteral);
            if (index !== undefined && index < baseType.elementTypes.length) {
                return baseType.elementTypes[index];
            }
        }
        
        return factory.createErrorType('Invalid index access', undefined, node);
    }

    private inferIndexSet(node: ast.IndexSet): TypeDescription {
        return this.inferExpression(node.value);
    }

    private inferArrayConstruction(node: ast.ArrayConstructionExpression): TypeDescription {
        if (!node.values || node.values.length === 0) {
            // Empty array - type is T[] where T is unknown
            return factory.createArrayType(factory.createAnyType(node), node);
        }
        
        // Infer element type from first element
        const firstElemType = this.inferExpression(node.values[0].expr);
        return factory.createArrayType(firstElemType, node);
    }

    private inferNamedStructConstruction(node: ast.NamedStructConstructionExpression): TypeDescription {
        const fields = node.fields?.flatMap(f => {
            if (ast.isStructFieldKeyValuePair(f)) {
                return [factory.createStructField(f.name, this.inferExpression(f.expr))];
            }
            return [];
        }) ?? [];
        
        return factory.createStructType(fields, false, node);
    }

    private inferAnonymousStructConstruction(node: ast.AnonymousStructConstructionExpression): TypeDescription {
        // Anonymous struct with just expressions - create tuple
        const types = node.expressions?.map(e => this.inferExpression(e)) ?? [];
        return factory.createTupleType(types, node);
    }

    private inferNewExpression(node: ast.NewExpression): TypeDescription {
        if (node.instanceType) {
            return this.getType(node.instanceType);
        }
        
        return factory.createErrorType('New expression without type', undefined, node);
    }

    private inferLambdaExpression(node: ast.LambdaExpression): TypeDescription {
        const params = node.header.args?.map(arg => factory.createFunctionParameterType(
            arg.name,
            this.getType(arg.type),
            arg.isMut
        )) ?? [];
        const returnType = node.header.returnType 
            ? this.getType(node.header.returnType)
            : this.inferReturnTypeFromBody(node.body, node.expr);

        return factory.createFunctionType(params, returnType, node.fnType, [], node);
    }

    private inferConditionalExpression(node: ast.ConditionalExpression): TypeDescription {
        // Type is the union of all branch types
        const thenTypes = node.thens?.map(t => this.inferExpression(t)) ?? [];
        const elseType = node.elseExpr ? this.inferExpression(node.elseExpr) : undefined;
        
        const allTypes = elseType ? [...thenTypes, elseType] : thenTypes;
        
        if (allTypes.length === 0) {
            return factory.createVoidType(node);
        }
        
        if (allTypes.length === 1) {
            return allTypes[0];
        }
        
        return simplifyType(factory.createUnionType(allTypes, node));
    }

    private inferMatchExpression(node: ast.MatchExpression): TypeDescription {
        // Type is the union of all case body types plus default
        const caseTypes = node.cases?.map(c => this.inferExpression(c.body)) ?? [];
        const defaultType = node.defaultExpr ? this.inferExpression(node.defaultExpr) : factory.createNeverType(node);
        
        const allTypes = [...caseTypes, defaultType];
        
        if (allTypes.length === 1) {
            return allTypes[0];
        }
        
        return simplifyType(factory.createUnionType(allTypes, node));
    }

    private inferLetInExpression(node: ast.LetInExpression): TypeDescription {
        return node.expr ? this.inferExpression(node.expr) : factory.createVoidType(node);
    }

    private inferDoExpression(node: ast.DoExpression): TypeDescription {
        // Type is the type of the last statement in the block
        // TODO: Implement full block type inference
        return factory.createVoidType(node);
    }

    private inferTypeCastExpression(node: ast.TypeCastExpression): TypeDescription {
        return this.getType(node.destType);
    }

    private inferThisExpression(node: ast.ThisExpression): TypeDescription {
        // Find enclosing class
        const classNode = AstUtils.getContainerOfType(node, ast.isClassType);
        if (classNode) {
            return this.getType(classNode);
        }
        
        return factory.createErrorType('this outside of class', undefined, node);
    }

    private inferYieldExpression(node: ast.YieldExpression): TypeDescription {
        // Yield expression type is void
        return factory.createVoidType(node);
    }

    private inferCoroutineExpression(node: ast.CoroutineExpression): TypeDescription {
        const fnType = this.inferExpression(node.fn);
        
        if (isFunctionType(fnType)) {
            return factory.createCoroutineType(
                fnType.parameters,
                fnType.returnType,
                factory.createAnyType(node), // TODO: infer yield type
                fnType.fnType,
                node
            );
        }
        
        return factory.createErrorType('Coroutine of non-function', undefined, node);
    }

    private inferDenullExpression(node: ast.DenullExpression): TypeDescription {
        const exprType = this.inferExpression(node.expr);
        
        if (isNullableType(exprType)) {
            return exprType.baseType;
        }
        
        return exprType;
    }

    private inferTupleExpression(node: ast.TupleExpression): TypeDescription {
        if (node.expressions.length === 1) {
            return this.inferExpression(node.expressions[0]);
        }
        
        const types = node.expressions.map(e => this.inferExpression(e));
        return factory.createTupleType(types, node);
    }

    // ========================================================================
    // Built-in Prototypes
    // ========================================================================

    private getArrayPrototype(): TypeDescription {
        if (this.builtinPrototypes.has('array')) {
            return this.builtinPrototypes.get('array')!;
        }
        
        // Find array prototype definition in builtins
        const documents = this.services.shared.workspace.LangiumDocuments.all.toArray();
        for (const doc of documents) {
            const module = doc.parseResult.value as ast.Module;
            for (const def of module.definitions) {
                if (ast.isBuiltinDefinition(def) && def.name === 'array') {
                    const prototype = this.getType(def);
                    this.builtinPrototypes.set('array', prototype);
                    return prototype;
                }
            }
        }
        
        // Return empty prototype if not found
        return factory.createPrototypeType('array', [], []);
    }
}

