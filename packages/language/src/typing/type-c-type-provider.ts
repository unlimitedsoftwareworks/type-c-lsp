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

import { AstNode, AstUtils, DocumentCache, URI } from 'langium';
import { ArrayPrototypeBuiltin, StringPrototypeBuiltin } from '../builtins/index.js';
import * as ast from '../generated/ast.js';
import type { TypeCServices } from '../type-c-module.js';
import { isAssignmentOperator } from './operator-utils.js';
import {
    ErrorTypeDescription,
    FunctionTypeDescription,
    GenericTypeDescription,
    isArrayType,
    isClassType,
    isCoroutineType,
    isEnumType,
    isErrorType,
    isFFIType,
    isFunctionType,
    isGenericType,
    isInterfaceType,
    isJoinType,
    isMetaClassType,
    isMetaEnumType,
    isMetaVariantConstructorType,
    isMetaVariantType,
    isNamespaceType,
    isNullableType,
    isPrototypeType,
    isReferenceType,
    isStringEnumType,
    isStringLiteralType,
    isStringType,
    isStructType,
    isTupleType,
    isUnionType,
    isVariantConstructorType,
    isVariantType,
    MethodType,
    PrototypeMethodType,
    StructFieldType,
    TypeDescription,
    TypeKind,
    VariantConstructorTypeDescription
} from './type-c-types.js';
import * as factory from './type-factory.js';
import { areTypesEqual, isAssignable, simplifyType, substituteGenerics } from './type-utils.js';

/**
 * Main type provider service.
 * Provides type inference for all AST nodes in Type-C.
 */
export class TypeCTypeProvider {
    /** Cache for computed types, keyed by AST node */
    private readonly typeCache: DocumentCache<AstNode, TypeDescription>;

    /** Cache for expected types, keyed by AST node */
    private readonly expectedTypeCache: DocumentCache<AstNode, TypeDescription | undefined>;

    /**
     * Tracks functions currently being inferred to prevent infinite recursion.
     *
     * When inferring recursive functions like `fn fib(n) = fib(n-1) + fib(n-2)`,
     * we need to detect when we're already inferring the same function to avoid
     * stack overflow.
     */
    private readonly inferringFunctions = new Set<AstNode>();

    /** Services for accessing Langium infrastructure */
    protected readonly services: TypeCServices;

    /** Built-in prototype types (array, coroutine) */
    private readonly builtinPrototypes = new Map<string, TypeDescription>();

    constructor(services: TypeCServices) {
        this.services = services;
        this.typeCache = new DocumentCache(services.shared);
        this.expectedTypeCache = new DocumentCache(services.shared);
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

        const documentUri = AstUtils.getDocument(node).uri;
        
        // Get from cache or compute if not cached
        return this.typeCache.get(documentUri, node, () => this.computeType(node));
    }

    /**
     * Invalidates the type cache for a node and its descendants.
     * Call this when an AST node changes.
     */
    invalidateCache(node: AstNode): void {
        const documentUri = AstUtils.getDocument(node).uri;
        this.typeCache.clear(documentUri);
        this.expectedTypeCache.clear(documentUri);
    }

    /**
     * Public method to get expression types.
     * Used by scope provider for member access completions.
     */
    getExpressionType(expr: ast.Expression): TypeDescription {
        return this.inferExpression(expr);
    }

    /**
     * Gets the expected type for an expression based on its context.
     * 
     * **Purpose:**
     * Determines what type is expected in a given context for:
     * - Type checking (is inferred type compatible with expected?)
     * - Context-sensitive scoping (variant constructors, enum cases)
     * - Generic type inference
     * 
     * **Contexts where expected type exists:**
     * 1. Variable declarations with annotations: `let x: T = expr` → T
     * 2. Function arguments: `foo(expr)` → parameter type
     * 3. Return statements: `return expr` → function return type
     * 4. Assignment: `x = expr` → type of x
     * 5. Binary operations: `x + expr` → type compatible with x
     * 
     * @param node The expression node to get expected type for
     * @returns The expected type, or undefined if no expectation exists
     * 
     * @example
     * ```typescript
     * let x: Option<u32> = Some(42)
     *                      ^^^^^^^^
     * getExpectedType(Some(42)) → Option<u32>
     * 
     * foo(bar)  // where foo(param: i32)
     *     ^^^
     * getExpectedType(bar) → i32
     * ```
     */
    getExpectedType(node: AstNode): TypeDescription | undefined {
        const documentUri = AstUtils.getDocument(node).uri;
        
        // Get from cache or compute if not cached
        return this.expectedTypeCache.get(documentUri, node, () => this.computeExpectedType(node));
    }

    /**
     * Computes the expected type for an expression based on its context.
     * This is the internal implementation that actually performs the computation.
     */
    private computeExpectedType(node: AstNode): TypeDescription | undefined {
        const parent = node.$container;

        // Variable declaration with annotation
        // let x: T = expr
        if (ast.isVariableDeclaration(parent) && parent.annotation && parent.initializer === node) {
            return this.getType(parent.annotation);
        }

        // Function call argument
        // foo(expr)
        if (ast.isFunctionCall(parent)) {
            const fnType = this.inferExpression(parent.expr);
            if (isFunctionType(fnType)) {
                // Find which argument position this is
                const argIndex = parent.args?.findIndex(arg => arg === node);
                if (argIndex !== undefined && argIndex >= 0 && argIndex < fnType.parameters.length) {
                    return fnType.parameters[argIndex].type;
                }
            }
        }

        // Return statement
        // return expr
        if (ast.isReturnStatement(parent)) {
            // Find the containing function
            const fn = AstUtils.getContainerOfType(parent, ast.isFunctionDeclaration);
            if (fn && fn.header.returnType) {
                return this.getType(fn.header.returnType);
            }
        }

        // Binary expressions: use the other operand's type as context
        // This enables: n < 2 (where n is u32) → 2 is inferred as u32
        if (ast.isBinaryExpression(parent)) {
            // Assignment operators: right side uses left's type
            const assignmentOps = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='];
            if (assignmentOps.includes(parent.op) && parent.right === node) {
                return this.inferExpression(parent.left);
            }

            // Comparison and arithmetic operators: use the OTHER operand's type
            // BUT: Only use contextual typing for literals to avoid infinite recursion
            const binaryOps = ['<', '>', '<=', '>=', '==', '!=', '+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'];
            if (binaryOps.includes(parent.op) && (ast.isIntegerLiteral(node) || ast.isFloatingPointLiteral(node))) {
                // This is a literal - try to use the other operand's type
                const otherOperand = parent.right === node ? parent.left : parent.right;

                // Only infer from the other operand if it's NOT also a literal (avoid circular inference)
                if (!ast.isIntegerLiteral(otherOperand) && !ast.isFloatingPointLiteral(otherOperand)) {
                    return this.inferExpression(otherOperand);
                }
            }
        }

        // No expected type found
        return undefined;
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

        if (isNamespaceType(type)) {
            return type.declaration.definitions;
        }

        // Nullable types - unwrap and get fields from base type
        // Example: Array<u32>? → get fields from Array<u32>
        if (isNullableType(type)) {
            return this.getIdentifiableFields(type.baseType);
        }

        // FFI
        if (isFFIType(type)) {
            return (type.node as ast.ExternFFIDecl)?.methods ?? [];
        }

        if (isMetaEnumType(type)) {
            return (type.baseEnum.node as ast.EnumType).cases;
        }

        // Array types, string types, and string literals - get prototype methods (length, push, pop, etc.)
        if (isArrayType(type) || isStringType(type) || isStringLiteralType(type)) {
            const prototypeType = isArrayType(type) ? this.getArrayPrototype() : this.getStringPrototype();
            if (prototypeType.node && ast.isBuiltinDefinition(prototypeType.node)) {
                // check if attribute or method
                for (const symbol of prototypeType.node.symbols) {
                    if (ast.isBuiltinSymbolID(symbol)) {
                        nodes.push(symbol);
                    } else if (ast.isBuiltinSymbolFn(symbol)) {
                        for (const name of symbol.names) {
                            nodes.push({ name, ...symbol } as AstNode);
                        }
                    }
                }
            }
        }

        // Class members (attributes and methods)
        if (isClassType(type) && type.node && ast.isClassType(type.node)) {
            // Get attributes from the AST node
            if (type.node.attributes) {
                // Remove static attributes
                nodes.push(...type.node.attributes.filter(a => !a.isStatic));
            }
            // Get methods from the AST node
            // Note: Each method can have multiple names (operator overloading), but we return
            // the method node itself. The scope provider will handle exposing all names.
            if (type.node.methods) {
                nodes.push(...type.node.methods.filter(m => !m.isStatic));
            }

            // A class must implement all methods of its super types
            // Therefor supertypes will not be added to the nodes list.
            /*for(const superType of type.superTypes) {
                nodes.push(...this.getIdentifiableFields(superType));
            }*/

            return nodes;
        }
        else if (isMetaClassType(type)) {
            nodes.push(...((type?.baseClass?.node as ast.ClassType)?.attributes.filter(a => a.isStatic) ?? []));
            nodes.push(...((type?.baseClass?.node as ast.ClassType)?.methods.filter(m => m.isStatic) ?? []));
            return nodes;
        }

        // Struct fields
        if (isStructType(type)) {
            if (type.node && ast.isStructType(type.node)) {
                // Named struct type - has AST nodes for fields
                nodes.push(...type.node.fields);
            } else if (type.node && ast.isStructFieldExprList(type.node)) {
                // Duck-typed struct from literal - extract StructFieldKeyValuePair nodes
                const fieldNodes = type.node.fields.filter(f => ast.isStructFieldKeyValuePair(f));
                nodes.push(...fieldNodes);
            }
        }

        if (isMetaVariantType(type)) {
            nodes.push(...(type.baseVariant.node as ast.VariantType).constructors);
        }

        // Interface methods
        if (isInterfaceType(type) && type.node && ast.isInterfaceType(type.node)) {
            nodes.push(...type.node.methods);
            for(const superType of type.superTypes) {
                nodes.push(...this.getIdentifiableFields(superType));
            }
        }

        // Prototype methods (for direct prototype access, though usually accessed via array/coroutine)
        if (isPrototypeType(type)) {
            if (type.node && ast.isBuiltinDefinition(type.node)) {
                nodes.push(...type.node.symbols);
            }
        }

        if (isVariantConstructorType(type)) {
            nodes.push(...(type.parentConstructor?.params ?? []));
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
        if (ast.isTupleType(node)) return this.inferTupleTypeFromDataType(node);
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
            if (!variantType) {
                return factory.createErrorType('Variant constructor outside variant', undefined, node);
            }

            // Get the variant's type declaration to create a proper reference
            const variantDecl = AstUtils.getContainerOfType(variantType, ast.isTypeDeclaration);
            if (!variantDecl) {
                return factory.createErrorType('Variant type without declaration', undefined, node);
            }

            // Get the resolved variant type
            // We need VariantTypeDescription, not ReferenceType
            const resolvedVariant = this.getType(variantDecl.definition);
            if (!isVariantType(resolvedVariant)) {
                return factory.createErrorType('Expected variant type', undefined, node);
            }

            // Create a VariantConstructorType as the return type
            const constructorReturnType = factory.createVariantConstructorType(
                resolvedVariant,
                node.name,
                node,
                [], // Generic args will be inferred during function call
                node,
                variantDecl  // Pass the declaration for display purposes
            );

            // Create a function type for the constructor
            // The parameters come from the constructor definition (node.params)
            const params = node.params.map((p: ast.VariantConstructorField) =>
                factory.createFunctionParameterType(p.name, this.getType(p.type))
            );

            return factory.createFunctionType(
                params,
                constructorReturnType,
                'fn',
                [], // Generic parameters handled specially for variant constructors
                node
            );
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
        if (ast.isDestructuringElement(node)) return this.inferDestructuringElement(node);
        if (ast.isVariantConstructorField(node)) return this.inferVariantConstructorField(node);
        if (ast.isStructFieldKeyValuePair(node)) return this.inferStructFieldKeyValuePair(node);
        if (ast.isStructField(node)) return this.inferStructField(node);
        if (ast.isFFIMethodHeader(node)) return this.inferFFIMethodHeader(node);

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

    private inferTupleTypeFromDataType(node: ast.TupleType): TypeDescription {
        // Tuple types have a 'types' property with array of DataType
        const elementTypes = node.types.map(t => this.getType(t));
        return factory.createTupleType(elementTypes, node);
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
        // Langium parser already strips quotes from STRING terminals, use values directly
        return factory.createStringEnumType(node.cases, node);
    }

    private inferInterfaceType(node: ast.InterfaceType): TypeDescription {
        const methods = node.methods.map(m => this.inferMethodHeader(m));
        const superTypes = node.superTypes?.map(t => this.getType(t)) ?? [];
        return factory.createInterfaceType(methods, superTypes, node);
    }

    private inferClassType(node: ast.ClassType): TypeDescription {
        // node.attributes is directly an Array<ClassAttributeDecl>
        const attributes = node.attributes?.map(attrDecl =>
            factory.createAttributeType(
                attrDecl.name,
                this.getType(attrDecl.type),
                attrDecl.isStatic ?? false,
                attrDecl.isConst ?? false,
                attrDecl.isLocal ?? false
            )
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
            arg?.name ?? '[anonymous]',
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
        // For coroutine type annotations: coroutine<fn(params) -> YieldType>
        // The "returnType" in the header actually represents the yield type
        const yieldType = node.header?.returnType
            ? this.getType(node.header.returnType)
            : factory.createVoidType(node);

        return factory.createCoroutineType(params, yieldType, node);
    }

    private inferReturnType(node: ast.ReturnType): TypeDescription {
        const returnType = this.getType(node.returnType);
        return factory.createReturnType(returnType, node);
    }

    private inferReferenceType(node: ast.ReferenceType): TypeDescription {
        const declaration: AstNode | undefined = node?.field?.ref;
        if (!declaration) {
            return factory.createErrorType('Unresolved type reference', undefined, node);
        }


        /** Resolve */

        // Handle references to generic type parameters (e.g., T in Array<T>)
        if (ast.isGenericType(declaration)) {
            // This is a reference to a generic type parameter
            // We already have the type computed for it, just return it
            return this.getType(declaration);
        }

        // Handle references to type declarations (e.g., Array, MyClass, etc.)
        if (ast.isTypeDeclaration(declaration)) {
            let genericArgs = node.genericArgs?.map(arg => this.getType(arg)) ?? [];
            // Regular type reference (e.g., Option, Array<T>)
            return factory.createReferenceType(declaration, genericArgs, node);
        }

        // We could also reference a variant constructor directly
        if (ast.isVariantConstructor(declaration) && node.parent) {
            let baseVariant = this.resolveReference(this.inferReferenceType(node.parent));
            if (isVariantType(baseVariant)) {
                let genericArgs = node.genericArgs?.map(arg => this.getType(arg)) ?? [];
                return factory.createVariantConstructorType(baseVariant, declaration.name, declaration, genericArgs, node, baseVariant.node?.$container as ast.TypeDeclaration);
            }
            return factory.createErrorType(
                `Expected variant type`,
                undefined,
                node
            );
        }

        // Handle any other identifiable references that might be types
        const declType = declaration.$type || 'unknown';
        return factory.createErrorType(
            `Reference does not point to a type declaration or generic parameter (found: ${declType})`,
            undefined,
            node
        );
    }

    /**
     * Resolves a reference type to its actual type definition.
     * Handles generic substitution.
     *
     * Note: We don't cache at this level because different generic instantiations
     * need different resolved types, and the main typeCache handles AST node caching.
     */
    resolveReference(refType: TypeDescription): TypeDescription {
        if (!isReferenceType(refType)) {
            return refType;
        }

        // Check if already resolved in actualType property
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

            return substituteGenerics(actualType, substitutions);
        }

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
                symbol.names.forEach(name => {
                    methods.push({
                        name,
                        functionType
                    });
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

    /**
     * Infers the type of a function declaration.
     *
     * **For recursive functions:**
     * - If return type is explicitly annotated → use it
     * - If not annotated → try to infer from non-recursive paths (base cases)
     * - If inference fails (no base cases) → ERROR
     *
     * **For coroutines:**
     * - Return type represents the yield type (what the coroutine yields)
     * - Inferred from yield expressions instead of return statements
     *
     * Examples:
     * ```
     * fn fib(n: u32) -> u32 = ...        // ✅ Explicit type
     * fn fib(n: u32) = if n < 2 => n ... // ✅ Can infer u32 from base case
     * fn fib(n: u32) = fib(n-1)          // ❌ Error: no base case to infer from
     *
     * cfn gen() -> u32 { yield 1; yield 2; } // ✅ Yields u32
     * cfn gen() { yield 1; yield 2; }        // ✅ Can infer u32 from yields
     * ```
     */
    private inferFunctionDeclaration(node: ast.FunctionDeclaration): TypeDescription {
        const genericParams = node.genericParameters?.map(g => this.inferGenericType(g)) as GenericTypeDescription[] ?? [];
        const params = node.header?.args?.map(arg => factory.createFunctionParameterType(
            arg.name,
            this.getType(arg.type),
            arg.isMut
        )) ?? [];

        const isCoroutine = node.fnType === 'cfn';

        // For recursive functions: use explicit type if available
        if (this.inferringFunctions.has(node)) {
            if (node.header?.returnType) {
                // Explicit return type provided - use it
                const returnType = this.getType(node.header.returnType);
                return factory.createFunctionType(params, returnType, node.fnType, genericParams, node);
            } else {
                // In recursive call - return an error placeholder to break cycle
                // The actual return type will be inferred from non-recursive paths
                // Using error type instead of void so validators ignore it
                return factory.createFunctionType(
                    params,
                    factory.createErrorType('__recursion_placeholder__', undefined, node),
                    node.fnType,
                    genericParams,
                    node
                );
            }
        }

        // Mark this function as being inferred
        this.inferringFunctions.add(node);

        try {
            let returnType: TypeDescription;
            
            if (node.header?.returnType) {
                // Explicit return/yield type provided
                returnType = this.getType(node.header.returnType);
            } else {
                // Infer type from body
                if (isCoroutine) {
                    // For coroutines: infer from yield expressions
                    returnType = this.inferYieldTypeFromBody(node.body, node.expr);
                } else {
                    // For regular functions: infer from return statements
                    returnType = this.inferReturnTypeFromBody(node.body, node.expr);
                }
            }

            return factory.createFunctionType(params, returnType, node.fnType, genericParams, node);
        } finally {
            // Always remove from the set, even if inference fails
            this.inferringFunctions.delete(node);
        }
    }

    /**
     * Infer return type from function body or expression.
     *
     * Strategy:
     * 1. If expression-body function: use expression type
     * 2. If block-body function: collect all return statements (only from this function!)
     * 3. Find common type of all returns
     * 4. If no returns → void
     */
    private inferReturnTypeFromBody(body?: ast.BlockStatement, expr?: ast.Expression): TypeDescription {
        // Expression-body function: fn foo() = expr
        if (expr) {
            return this.getType(expr);
        }

        // Block-body function: fn foo() { ... }
        if (body) {
            const returnStatements = this.collectReturnStatements(body);

            if (returnStatements.length === 0) {
                return factory.createVoidType();
            }

            // Get types of all return expressions
            const allReturnTypes = returnStatements
                .map(stmt => stmt.expr ? this.getType(stmt.expr) : factory.createVoidType());

            // Filter out recursion placeholders (error types with specific message)
            const nonPlaceholderTypes = allReturnTypes.filter(type => {
                if (type.kind === TypeKind.Error) {
                    const errorType = type as ErrorTypeDescription;
                    return errorType.message !== '__recursion_placeholder__';
                }
                return true; // Keep non-error types
            });

            // Use non-placeholder types if available, otherwise all types
            const returnTypes = nonPlaceholderTypes.length > 0 ? nonPlaceholderTypes : allReturnTypes;

            if (returnTypes.length === 0) {
                return factory.createVoidType();
            }

            // Find common type
            return this.getCommonType(returnTypes);
        }

        return factory.createVoidType();
    }

    /**
     * Infer yield type from coroutine body or expression.
     *
     * Strategy:
     * 1. If expression-body coroutine: use expression type (treating it as a yield)
     * 2. If block-body coroutine: collect all yield expressions (only from this coroutine!)
     * 3. Find common type of all yields
     * 4. If no yields → void
     */
    private inferYieldTypeFromBody(body?: ast.BlockStatement, expr?: ast.Expression): TypeDescription {
        // Expression-body coroutine: cfn foo() = expr (expression is implicitly yielded)
        if (expr) {
            return this.getType(expr);
        }

        // Block-body coroutine: cfn foo() { ... }
        if (body) {
            const yieldExpressions = this.collectYieldExpressions(body);

            if (yieldExpressions.length === 0) {
                return factory.createVoidType();
            }

            // Get types of all yield expressions
            const allYieldTypes = yieldExpressions
                .map(yieldExpr => yieldExpr.expr ? this.getType(yieldExpr.expr) : factory.createVoidType());

            // Filter out recursion placeholders (error types with specific message)
            const nonPlaceholderTypes = allYieldTypes.filter(type => {
                if (type.kind === TypeKind.Error) {
                    const errorType = type as ErrorTypeDescription;
                    return errorType.message !== '__recursion_placeholder__';
                }
                return true; // Keep non-error types
            });

            // Use non-placeholder types if available, otherwise all types
            const yieldTypes = nonPlaceholderTypes.length > 0 ? nonPlaceholderTypes : allYieldTypes;

            if (yieldTypes.length === 0) {
                return factory.createVoidType();
            }

            // Find common type
            return this.getCommonType(yieldTypes);
        }

        return factory.createVoidType();
    }

    /**
     * Collect all return statements from a block, but ONLY from this function level.
     * Does NOT collect returns from nested functions!
     */
    private collectReturnStatements(block: ast.BlockStatement): ast.ReturnStatement[] {
        const returns: ast.ReturnStatement[] = [];

        const visit = (node: AstNode) => {
            // Stop if we hit a nested function - don't collect its returns!
            if (ast.isFunctionDeclaration(node)) {
                return; // Don't traverse into nested functions
            }

            if (ast.isReturnStatement(node)) {
                returns.push(node);
            }

            // Traverse children
            for (const child of AstUtils.streamContents(node)) {
                visit(child);
            }
        };

        // Visit all statements in the block
        for (const stmt of block.statements || []) {
            visit(stmt);
        }

        return returns;
    }

    /**
     * Collect all yield expressions from a block, but ONLY from this coroutine level.
     * Does NOT collect yields from nested coroutines!
     */
    private collectYieldExpressions(block: ast.BlockStatement): ast.YieldExpression[] {
        const yields: ast.YieldExpression[] = [];

        const visit = (node: AstNode) => {
            // Stop if we hit a nested function/coroutine - don't collect its yields!
            if (ast.isFunctionDeclaration(node)) {
                return; // Don't traverse into nested functions
            }

            if (ast.isYieldExpression(node)) {
                yields.push(node);
            }

            // Traverse children
            for (const child of AstUtils.streamContents(node)) {
                visit(child);
            }
        };

        // Visit all statements in the block
        for (const stmt of block.statements || []) {
            visit(stmt);
        }

        return yields;
    }

    /**
     * Find the common type of multiple types.
     * 
     * Used for:
     * - Return type inference (all return statements)
     * - Array literal inference (all elements)
     * - Match expression inference (all arms)
     * 
     * Strategy:
     * 1. If all types are identical → use that type
     * 2. If all are structs → find common fields (structural subtyping)
     * 3. If types are compatible via coercion → use the wider type (TODO)
     * 4. Otherwise → error type
     */
    private getCommonType(types: TypeDescription[]): TypeDescription {
        if (types.length === 0) {
            return factory.createVoidType();
        }

        if (types.length === 1) {
            return types[0];
        }

        // Check if all types are identical
        const firstType = types[0];
        const allIdentical = types.every(t => t.toString() === firstType.toString());

        if (allIdentical) {
            return firstType;
        }

        // Check if all are struct types - use structural subtyping
        const allStructs = types.every(t => isStructType(t));
        if (allStructs) {
            return this.getCommonStructType(types);
        }

        // Check if all are references to the same declaration (e.g., Result<i32, never> and Result<never, string>)
        // This handles arrays of variant constructor calls: [Result.Ok(1), Result.Err("error")]
        const allReferences = types.every(t => isReferenceType(t));
        if (allReferences) {
            const referenceTypes = types as any[]; // All verified to be ReferenceType
            const firstDecl = referenceTypes[0].declaration;

            // Check if all references point to the same declaration
            const allSameDecl = referenceTypes.every(ref => ref.declaration === firstDecl);
            if (allSameDecl) {
                // Unify generic arguments across all references
                return this.getCommonReferenceType(referenceTypes);
            }
        }

        // Check if all are variant constructors - unify generic arguments
        const allVariantConstructors = types.every(t => isVariantConstructorType(t));
        if (allVariantConstructors) {
            return this.getCommonVariantConstructorType(types as VariantConstructorTypeDescription[]);
        }

        // TODO: Implement numeric type widening (e.g., i32 + u32 → i64)
        // For now, if types differ, it's an error
        return factory.createErrorType(
            `Cannot infer common type: found ${types.map(t => t.toString()).join(', ')}`,
            undefined,
            firstType.node
        );
    }

    /**
     * Find the common type for references to the same declaration with different generic arguments.
     *
     * This handles arrays like:
     * ```
     * [Result.Ok(1), Result.Err("error")]
     * → [Result<i32, never>, Result<never, string>]
     * → Result<i32, string>[]
     * ```
     *
     * Strategy:
     * - For each generic parameter position, collect all types
     * - Replace `never` with concrete types from other elements
     * - All concrete types in a position must be identical
     */
    private getCommonReferenceType(types: any[]): TypeDescription {
        const firstRef = types[0];
        const declaration = firstRef.declaration;
        const numGenericParams = firstRef.genericArgs.length;

        // If no generic parameters, all types are identical
        if (numGenericParams === 0) {
            return firstRef;
        }

        // Unify generic arguments across all references
        const unifiedGenericArgs: TypeDescription[] = [];

        for (let i = 0; i < numGenericParams; i++) {
            // Collect all types at this position
            const typesAtPosition = types.map(ref => ref.genericArgs[i]);

            // Filter out never types
            const concreteTypes = typesAtPosition.filter(t => t.kind !== TypeKind.Never);

            if (concreteTypes.length === 0) {
                // All are never - keep never
                unifiedGenericArgs.push(factory.createNeverType());
            } else {
                // Check if all concrete types are identical
                const firstConcreteType = concreteTypes[0];
                const allIdentical = concreteTypes.every(t => t.toString() === firstConcreteType.toString());

                if (allIdentical) {
                    // All concrete types match - use that type
                    unifiedGenericArgs.push(firstConcreteType);
                } else {
                    // Multiple different concrete types - error
                    return factory.createErrorType(
                        `Cannot infer common type: generic parameter at position ${i + 1} has incompatible types: ${concreteTypes.map(t => t.toString()).join(', ')}`,
                        undefined,
                        firstRef.node
                    );
                }
            }
        }

        // Create a reference to the same declaration with unified generic arguments
        return factory.createReferenceType(declaration, unifiedGenericArgs, firstRef.node);
    }

    /**
     * Find the common struct type (intersection of fields).
     * 
     * Type-C uses structural subtyping for structs:
     * - `{x: u32, y: u32, z: u32}` is compatible with `{x: u32, y: u32}`
     * - Common fields must have EXACT matching types (u32 ≠ u64)
     * 
     * Example:
     * ```
     * {x: 1u32, y: 2u32}         // struct { x: u32, y: u32 }
     * {x: 3u32, y: 4u32, z: 5u32} // struct { x: u32, y: u32, z: u32 }
     * → struct { x: u32, y: u32 }  // Common fields only
     * ```
     */
    private getCommonStructType(types: TypeDescription[]): TypeDescription {
        const structTypes = types as any[]; // All verified to be StructTypeDescription

        // Get all field names from each struct
        const allFieldSets = structTypes.map(st => {
            const fields = new Map<string, TypeDescription>();
            if (st.fields) {
                for (const field of st.fields) {
                    fields.set(field.name, field.type);
                }
            }
            return fields;
        });

        // Find common field names (intersection)
        const firstFieldSet = allFieldSets[0];
        const commonFieldNames = new Set<string>();

        for (const fieldName of firstFieldSet.keys()) {
            const isPresentInAll = allFieldSets.every(fieldSet => fieldSet.has(fieldName));
            if (isPresentInAll) {
                commonFieldNames.add(fieldName);
            }
        }

        if (commonFieldNames.size === 0) {
            return factory.createErrorType(
                `Cannot infer common struct type: no common fields found`,
                undefined,
                types[0].node
            );
        }

        // Check that all common fields have EXACT same types
        const commonFields: StructFieldType[] = [];

        for (const fieldName of commonFieldNames) {
            const firstFieldType = allFieldSets[0].get(fieldName)!;

            // Check if all structs have this field with the EXACT same type
            const allMatch = allFieldSets.every(fieldSet => {
                const fieldType = fieldSet.get(fieldName);
                return fieldType && fieldType.toString() === firstFieldType.toString();
            });

            if (!allMatch) {
                return factory.createErrorType(
                    `Cannot infer common struct type: field '${fieldName}' has different types across branches`,
                    undefined,
                    types[0].node
                );
            }

            commonFields.push({
                name: fieldName,
                type: firstFieldType
            });
        }

        // Create the common struct type (not anonymous - show 'struct' keyword)
        return factory.createStructType(commonFields, false, types[0].node);
    }

    /**
     * Find the common type for variant constructors by unifying their generic arguments.
     *
     * Type-C allows variant constructors to be subtypes of their base variant:
     * - `Result.Ok<i32, never>` is a subtype of `Result<i32, E>` for any E
     * - `Result.Err<never, string>` is a subtype of `Result<T, string>` for any T
     *
     * When constructors are in an array, we unify their generic arguments:
     * - `never` is replaced by concrete types from other constructors
     * - All concrete types in a position must be identical or one must be never
     *
     * Example:
     * ```
     * [Result.Ok(1), Result.Err("error")]
     * → [Result<i32, never>.Ok, Result<never, string>.Err]
     * → Result<i32, string>[]
     * ```
     */
    private getCommonVariantConstructorType(types: VariantConstructorTypeDescription[]): TypeDescription {
        const firstConstructor = types[0];

        // Extract base variant declaration (prefer variantDeclaration field)
        let baseVariantDecl: ast.TypeDeclaration | undefined = firstConstructor.variantDeclaration;

        // Fallback to extracting from baseVariant.node if declaration not available
        if (!baseVariantDecl) {
            const variantAstNode = firstConstructor.baseVariant.node;
            if (variantAstNode && ast.isVariantType(variantAstNode)) {
                baseVariantDecl = AstUtils.getContainerOfType(variantAstNode, ast.isTypeDeclaration);
            }
        }

        if (!baseVariantDecl) {
            return factory.createErrorType(
                'Cannot infer common type: variant constructor has no base variant declaration',
                undefined,
                firstConstructor.node
            );
        }

        // Check that all constructors belong to the same base variant
        const allSameBase = types.every(constructor => {
            // Prefer variantDeclaration field for comparison
            const constructorDecl = constructor.variantDeclaration;
            if (constructorDecl) {
                return constructorDecl === baseVariantDecl;
            }
            // Fallback to node comparison
            const constructorVariantNode = constructor.baseVariant.node;
            if (constructorVariantNode && ast.isVariantType(constructorVariantNode)) {
                const decl = AstUtils.getContainerOfType(constructorVariantNode, ast.isTypeDeclaration);
                return decl === baseVariantDecl;
            }
            return false;
        });

        if (!allSameBase) {
            return factory.createErrorType(
                `Cannot infer common type: variant constructors from different variants: ${types.map(t => t.toString()).join(', ')}`,
                undefined,
                firstConstructor.node
            );
        }

        // Unify generic arguments across all constructors
        // For each generic parameter position, collect all types and merge
        const numGenericParams = firstConstructor.genericArgs.length;
        const unifiedGenericArgs: TypeDescription[] = [];

        for (let i = 0; i < numGenericParams; i++) {
            // Collect all types at this position
            const typesAtPosition = types.map(constructor => constructor.genericArgs[i]);

            // Filter out never types
            const concreteTypes = typesAtPosition.filter(t => t.kind !== TypeKind.Never);

            if (concreteTypes.length === 0) {
                // All are never - keep never
                unifiedGenericArgs.push(factory.createNeverType());
            } else {
                // Check if all concrete types are identical
                const firstConcreteType = concreteTypes[0];
                const allIdentical = concreteTypes.every(t => t.toString() === firstConcreteType.toString());

                if (allIdentical) {
                    // All concrete types match - use that type
                    unifiedGenericArgs.push(firstConcreteType);
                } else {
                    // Multiple different concrete types - error
                    return factory.createErrorType(
                        `Cannot infer common type: generic parameter at position ${i + 1} has incompatible types: ${concreteTypes.map(t => t.toString()).join(', ')}`,
                        undefined,
                        firstConstructor.node
                    );
                }
            }
        }

        // Create a reference to the base variant with unified generic arguments
        return factory.createReferenceType(baseVariantDecl, unifiedGenericArgs, firstConstructor.node);
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
        if (ast.isVariableDeclSingle(node) && node.isNullable) {
            return factory.createNullableType(inferredType, node);
        }

        return inferredType;
    }

    // ========================================================================
    // Expression Type Inference
    // ========================================================================

    private inferExpression(node: ast.Expression): TypeDescription {
        // References
        if (ast.isQualifiedReference(node)) {
            const res = this.inferQualifiedReference(node);
            return res;
        }
        // Literals
        if (ast.isIntegerLiteral(node)) return this.inferIntegerLiteral(node);
        if (ast.isFloatingPointLiteral(node)) return this.inferFloatLiteral(node);
        if (ast.isStringLiteralExpression(node)) {
            // STRING terminal includes quotes, so we need to strip them
            // node.value = "red" (with quotes) -> we want "red" (without quotes)
            const stringValue = node.value.startsWith('"') && node.value.endsWith('"')
                ? node.value.substring(1, node.value.length - 1)
                : node.value;
            
            // Use contextual typing to determine if we should keep as literal or widen to string
            let expectedType = this.getExpectedType(node);
            expectedType = expectedType && isReferenceType(expectedType)? this.resolveReference(expectedType) : expectedType;
            
            // If expected type is a string enum, keep as literal for validation
            if (expectedType && isStringEnumType(expectedType)) {
                return factory.createStringLiteralType(stringValue, node);
            }
            
            // Otherwise, widen to string type (for better compatibility with generic inference)
            // This includes: expected type is string, expected type is generic, or no expected type
            return factory.createStringType(node);
        }
        if (ast.isBinaryStringLiteralExpression(node)) {
            return factory.createArrayType(factory.createU8Type(node), node);
        }
        if (ast.isTrueBooleanLiteral(node) || ast.isFalseBooleanLiteral(node)) {
            return factory.createBoolType(node);
        }
        if (ast.isNullLiteralExpression(node)) return factory.createNullType(node);


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
        if (ast.isDestructuringElement(node)) return this.inferDestructuringElement(node);

        return factory.createErrorType(`Cannot infer type for expression: ${node.$type}`, undefined, node);
    }

    /**
     * Infer the type of an integer literal.
     * 
     * Uses contextual typing when available:
     * - `let x: u32 = 10` → infers 10 as u32
     * - `n < 2` where n is u32 → infers 2 as u32
     * - `10u32` → explicit suffix overrides context
     * - `let x = 10` → defaults to i32
     * 
     * This makes compiled language semantics work naturally without explicit suffixes everywhere.
     */
    private inferIntegerLiteral(node: ast.IntegerLiteral): TypeDescription {
        // Extract type suffix if present
        const value = node.value;
        const suffixMatch = value.match(/([iu])(8|16|32|64)$/);

        if (suffixMatch) {
            // Explicit suffix always takes precedence
            const typeStr = suffixMatch[0];
            return factory.createIntegerTypeFromString(typeStr, node)
                ?? factory.createI32Type(node);
        }

        // Try to use contextual typing
        const expectedType = this.getExpectedType(node);
        if (expectedType && this.isIntegerType(expectedType)) {
            // Use the expected integer type
            return expectedType;
        }

        // Default to i32 for decimal literals without suffix
        return factory.createI32Type(node);
    }

    /**
     * Check if a type is an integer type (not float).
     */
    private isIntegerType(type: TypeDescription): boolean {
        const integerKinds = [
            TypeKind.U8, TypeKind.U16, TypeKind.U32, TypeKind.U64,
            TypeKind.I8, TypeKind.I16, TypeKind.I32, TypeKind.I64
        ];
        return integerKinds.includes(type.kind);
    }

    /**
     * Infer the type of a floating-point literal.
     * 
     * Uses contextual typing when available:
     * - `let x: f32 = 3.14` → infers 3.14 as f32
     * - `let x = 3.14` → defaults to f64
     * - Explicit suffix overrides context: `3.14f` → always f32
     */
    private inferFloatLiteral(node: ast.FloatingPointLiteral): TypeDescription {
        // If there's an explicit 'f' suffix, it's f32
        if (ast.isFloatLiteral(node)) {
            return factory.createF32Type(node);
        }

        // Try to use contextual typing
        const expectedType = this.getExpectedType(node);
        if (expectedType && expectedType.kind === TypeKind.F32) {
            return factory.createF32Type(node);
        }

        // Default to f64 (double precision)
        return factory.createF64Type(node);
    }

    private inferQualifiedReference(node: ast.QualifiedReference): TypeDescription {
        // Langium cross-references have a .ref property pointing to the target AST node
        const ref = node.reference;
        if (!ref || !('ref' in ref) || !ref.ref) {
            return factory.createErrorType('Unresolved reference', undefined, node);
        }

        // Type assertion needed because Langium references are dynamically typed
        let type = this.getType(ref.ref as AstNode);
        const originalType = type;
        if(isReferenceType(type)) {
            type = this.resolveReference(type);
        }


        if (isVariantType(type) && ast.isTypeDeclaration(node.reference.ref)) {
            // Generics are pushed to the constuctor i.e Option.Some<T>
            return factory.createMetaVariantType(type, [], node);
        }

        if(isEnumType(type) && ast.isTypeDeclaration(node.reference.ref)) {
            return factory.createMetaEnumType(type, node);
        }

        if(isClassType(type) && ast.isTypeDeclaration(node.reference.ref)) {
            return factory.createMetaClassType(type, node);
        }

        return originalType;
    }

    private inferBinaryExpression(node: ast.BinaryExpression): TypeDescription {
        const left = this.inferExpression(node.left);
        const right = this.inferExpression(node.right);

        // If either operand is an error type, propagate it
        if (left.kind === TypeKind.Error) return left;
        if (right.kind === TypeKind.Error) return right;

        // Assignment operators return the type of the right operand
        if (isAssignmentOperator(node.op)) {
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

        // If base type is nullable, unwrap it for member lookup
        if (isNullableType(baseType)) {
            // arr?: Array<u32> with arr?.member → unwrap to Array<u32>
            // arr?: Array<u32> with arr.member → auto-unwrap (should be validation error)
            baseType = baseType.baseType;
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

        // If base type is a variant constructor type (e.g., Option<u32>.Some), extract generic substitutions
        if (isVariantConstructorType(baseType)) {
            const constructorType = baseType;
            // Get the variant declaration to extract generic parameter names
            const variantAstNode = constructorType.baseVariant.node;
            if (variantAstNode && ast.isVariantType(variantAstNode)) {
                const variantDecl = AstUtils.getContainerOfType(variantAstNode, ast.isTypeDeclaration);
                if (variantDecl && variantDecl.genericParameters && constructorType.genericArgs.length > 0) {
                    genericSubstitutions = new Map();
                    variantDecl.genericParameters.forEach((param, i) => {
                        if (i < constructorType.genericArgs.length) {
                            genericSubstitutions!.set(param.name, constructorType.genericArgs[i]);
                        }
                    });
                }
            }
        }

        // Variable to hold the resolved member type
        let memberType: TypeDescription | undefined;

        // Get the target node
        const targetRef = node.element.ref;
        if (!targetRef) {
            return factory.createErrorType(`Member '${memberName}' not found`, undefined, node);
        }

        const targetType = this.getType(targetRef);

        // Apply generic substitutions if we have them (e.g., T -> u32 in Array<u32>)
        if (genericSubstitutions) {
            memberType = substituteGenerics(targetType, genericSubstitutions);
        } else {
            memberType = targetType;
        }

        // Post process the member type
        // If the element is a type-decl, we wrap it in a meta type!
        if (ast.isTypeDeclaration(targetRef)) {
            if (isVariantType(memberType)) {
                memberType = factory.createMetaVariantType(memberType);
            }
            else if (isVariantConstructorType(memberType)) {
                memberType = factory.createMetaVariantConstructorType(memberType, [], targetRef);
            }
            else if (isEnumType(memberType)) {
                memberType = factory.createMetaEnumType(memberType, targetRef);
            }
            else if (isClassType(memberType)) {
                memberType = factory.createMetaClassType(memberType, targetRef);
            }
        }

        if(node.isNullable) {
            memberType = factory.createNullableType(memberType, node);
        }
        return memberType;
    }

    private inferFunctionCall(node: ast.FunctionCall): TypeDescription {
        let fnType = this.inferExpression(node.expr);

        // Resolve reference types first
        if (isReferenceType(fnType)) {
            fnType = this.resolveReference(fnType);
        }

        // Handle coroutine types - calling a coroutine instance yields its yieldType
        if (isCoroutineType(fnType)) {
            // Coroutine instances are callable and yield their yieldType
            // No need to apply generic substitutions here - already done in coroutine creation
            return fnType.yieldType;
        }

        // Handle regular function types
        if (isFunctionType(fnType)) {
            // Check if the return type is a VariantConstructorType
            // If so, we need to infer generics from the call arguments
            if (isVariantConstructorType(fnType.returnType)) {
                return this.inferVariantConstructorCall(fnType.returnType, node);
            }

            const genericParams = fnType.genericParameters || [];
            let substitutions: Map<string, TypeDescription> | undefined;

            // Handle explicit generic type arguments
            if (node.genericArgs && node.genericArgs.length > 0) {
                if (node.genericArgs.length === genericParams.length) {
                    // Build substitution map: generic parameter name -> concrete type
                    const explicitSubstitutions = new Map<string, TypeDescription>();
                    genericParams.forEach((param, index) => {
                        const concreteType = this.getType(node.genericArgs[index]);
                        explicitSubstitutions.set(param.name, concreteType);
                    });
                    substitutions = explicitSubstitutions;
                }
            }
            // Attempt automatic generic inference if no explicit type arguments provided
            else if (genericParams.length > 0) {
                const args = node.args || [];

                // Get concrete types of all arguments
                const argumentTypes = args.map(arg => this.inferExpression(arg));

                // Get parameter types (which may contain generic references)
                const parameterTypes = fnType.parameters.map(p => p.type);

                // Infer generics from the arguments
                const genericParamNames = genericParams.map(p => p.name);
                substitutions = this.inferGenericsFromArguments(
                    genericParamNames,
                    parameterTypes,
                    argumentTypes
                );
            }

            // Apply substitutions to return type if we have any
            if (substitutions && substitutions.size > 0) {
                return substituteGenerics(fnType.returnType, substitutions);
            }

            return fnType.returnType;
        }

        // Handle variant constructor calls (e.g., Result.Ok(42))
        // This is the key feature: infer generics from arguments and create a properly typed constructor
        if (isVariantConstructorType(fnType)) {
            return this.inferVariantConstructorCall(fnType, node);
        }

        // Handle old-style variant constructor calls (backward compatibility)
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

        if (isMetaVariantConstructorType(fnType)) {
            return this.inferVariantConstructorCall(fnType.baseVariantConstructor, node);
        }

        return factory.createErrorType(
            `Cannot call value of type '${fnType.toString()}'. Only functions, callable classes/interfaces, and variant constructors can be called.`,
            undefined,
            node
        );
    }

    /**
     * Infers the type when calling a variant constructor.
     *
     * Key responsibilities:
     * 1. Infer generic parameters from the constructor's argument types
     * 2. Fill uninferrable generics with `never` type
     * 3. Return a VariantConstructorTypeDescription with inferred generics
     *
     * Example:
     * - Result.Ok(42) → Result<i32, never>.Ok
     * - Result.Err("error") → Result<never, string>.Err
     *
     * @param constructorType The variant constructor type (e.g., Result.Ok)
     * @param callNode The function call AST node
     * @returns A VariantConstructorTypeDescription with inferred generic args
     */
    private inferVariantConstructorCall(
        constructorType: VariantConstructorTypeDescription,
        callNode: ast.FunctionCall
    ): TypeDescription {
        // Get the base variant (always a VariantTypeDescription now)
        const baseVariant = constructorType.baseVariant;

        // Get the variant declaration to extract generic parameter names
        const variantAstNode = baseVariant.node;
        let genericParamNames: string[] = [];
        let variantDecl: ast.TypeDeclaration | undefined;

        if (variantAstNode && ast.isVariantType(variantAstNode)) {
            variantDecl = AstUtils.getContainerOfType(variantAstNode, ast.isTypeDeclaration);
            if (variantDecl) {
                genericParamNames = variantDecl.genericParameters?.map(p => p.name) ?? [];
            }
        }

        if (!variantDecl) {
            return factory.createErrorType(
                `Could not find variant declaration for constructor ${constructorType.constructorName}`,
                undefined,
                callNode
            );
        }

        // Find the specific constructor definition
        const constructorDef = baseVariant.constructors.find(
            c => c.name === constructorType.constructorName
        );

        if (!constructorDef) {
            return factory.createErrorType(
                `Constructor '${constructorType.constructorName}' not found in variant`,
                undefined,
                callNode
            );
        }

        // Build a map of generic parameters to their inferred types
        let genericMap = new Map<string, TypeDescription>();

        // Infer generic types from the constructor arguments
        const callArgs = callNode.args ?? [];
        const constructorParams = constructorDef.parameters;


        if(callNode.genericArgs && callNode.genericArgs.length > 0) {
            // Build substitution map: generic parameter name -> concrete type
            genericParamNames.forEach((param, index) => {
                const concreteType = this.getType(callNode.genericArgs[index]);
                genericMap.set(param, concreteType);
            });
        }
        else {
            // Infer generics from the constructor arguments
            const argumentTypes = callArgs.map(arg => this.inferExpression(arg));
            genericMap = this.inferGenericsFromArguments(
                genericParamNames,
                constructorParams.map(p => p.type),
                argumentTypes
            );
        }

        // Create a ReferenceType with the inferred generic arguments
        const variantRefWithGenerics = factory.createReferenceType(
            variantDecl,
            // Sort names per the original declaration order
            genericParamNames.map(name => genericMap.get(name) ?? factory.createNeverType()),
            callNode
        );

        // Resolve the reference to get the actual VariantType with substituted generics
        const resolvedVariant = this.resolveReference(variantRefWithGenerics);
        if (!isVariantType(resolvedVariant)) {
            return factory.createErrorType(
                `Failed to resolve variant type for ${constructorType.constructorName}`,
                undefined,
                callNode
            );
        }

        // Return a VariantConstructorType (subtype of the variant)
        // Example: Result.Ok(42) returns Result<i32, never>.Ok
        // This represents that the value is specifically an Ok constructor,
        // which is a subtype of Result<i32, never>
        return factory.createVariantConstructorType(
            resolvedVariant,
            constructorType.constructorName,
            constructorType.parentConstructor,
            genericParamNames.map(name => genericMap.get(name) ?? factory.createNeverType()),
            callNode,
            variantDecl  // Pass the declaration for display purposes
        );
    }

    private inferIndexAccess(node: ast.IndexAccess): TypeDescription {
        let baseType = this.inferExpression(node.expr);
        if(isReferenceType(baseType)) {
            baseType = this.resolveReference(baseType);
        }

        if (isArrayType(baseType)) {
            return baseType.elementType;
        }

        if (isClassType(baseType)) {
            // TODO: find the method with the name '[]'
            const method = baseType.methods.find(m => m.names.includes('[]'));
            if (method) {
                return method.returnType;
            }
            return factory.createErrorType('Class does not implement index access operator `[]`', undefined, node);
        }

        return factory.createErrorType('Invalid index access on type ' + baseType.toString(), undefined, node);
    }

    private inferIndexSet(node: ast.IndexSet): TypeDescription {
        return this.inferExpression(node.value);
    }

    /**
     * Infer the type of an array construction expression (e.g., `[1, 2, 3]` or `[]`).
     *
     * For non-empty arrays, infers element type by computing common type across all elements.
     * For empty arrays, uses contextual typing from the expected type (if available).
     *
     * Examples:
     * - `[1, 2, 3]` → `i32[]` (inferred from elements)
     * - `[Result.Ok(1), Result.Err("error")]` → `Result<i32, string>[]` (unified variant)
     * - `let x: u32[] = []` → `u32[]` (from context)
     * - `let x = []` → ERROR (cannot infer type)
     */
    private inferArrayConstruction(node: ast.ArrayConstructionExpression): TypeDescription {
        if (!node.values || node.values.length === 0) {
            // Empty array - try to get type from context
            const expectedType = this.getExpectedType(node);

            if (expectedType && isArrayType(expectedType)) {
                // Use the expected element type
                return expectedType;
            }

            // No context available - cannot infer type
            return factory.createErrorType(
                'Cannot infer type of empty array literal. Provide a type annotation (e.g., let x: T[] = [])',
                undefined,
                node
            );
        }

        // Infer element types from all elements and find common type
        const elementTypes = node.values.map(v => this.inferExpression(v.expr));
        const commonType = this.getCommonType(elementTypes);
        return factory.createArrayType(commonType, node);
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
        
        const isCoroutine = node.fnType === 'cfn';
        
        let returnType: TypeDescription;
        if (node.header.returnType) {
            // Explicit return/yield type provided
            returnType = this.getType(node.header.returnType);
        } else {
            // Infer type from body
            if (isCoroutine) {
                // For coroutine lambdas: infer from yield expressions
                returnType = this.inferYieldTypeFromBody(node.body, node.expr);
            } else {
                // For regular function lambdas: infer from return statements
                returnType = this.inferReturnTypeFromBody(node.body, node.expr);
            }
        }

        return factory.createFunctionType(params, returnType, node.fnType, [], node);
    }

    /**
     * Infer the type of a conditional expression (if-then-else).
     * 
     * In a compiled language, all branches must return the SAME type (or compatible types).
     * Uses `getCommonType` to find the common type of all branches.
     * 
     * Example:
     * ```
     * if n < 2 => n else fib(n-1) + fib(n-2)  // all u32
     * ```
     */
    private inferConditionalExpression(node: ast.ConditionalExpression): TypeDescription {
        const thenTypes = node.thens?.map(t => this.inferExpression(t)) ?? [];
        const elseType = node.elseExpr ? this.inferExpression(node.elseExpr) : undefined;

        const allTypes = elseType ? [...thenTypes, elseType] : thenTypes;

        if (allTypes.length === 0) {
            return factory.createVoidType(node);
        }

        // Filter out recursion placeholders
        const nonPlaceholders = allTypes.filter(type => {
            if (type.kind === TypeKind.Error) {
                const errorType = type as ErrorTypeDescription;
                return errorType.message !== '__recursion_placeholder__';
            }
            return true;
        });

        const typesToUse = nonPlaceholders.length > 0 ? nonPlaceholders : allTypes;

        // Find the common type (not a union!)
        return this.getCommonType(typesToUse);
    }

    /**
     * Infer the type of a match expression.
     * 
     * In a compiled language, all arms must return the SAME type (or compatible types).
     * Uses `getCommonType` to find the common type of all arms.
     * 
     * Example:
     * ```
     * match n {
     *     0 => 0u32,        // u32
     *     1 => 1u32,        // u32
     *     _ => fib(n-1),    // u32 (from base cases)
     * }  // → u32
     * ```
     */
    private inferMatchExpression(node: ast.MatchExpression): TypeDescription {
        // Get types from all match arms
        const caseTypes = node.cases?.map(c => this.inferExpression(c.body)) ?? [];
        const defaultType = node.defaultExpr ? this.inferExpression(node.defaultExpr) : undefined;

        const allTypes = defaultType ? [...caseTypes, defaultType] : caseTypes;

        if (allTypes.length === 0) {
            return factory.createVoidType(node);
        }

        // Filter out recursion placeholders - use non-placeholder types for inference
        const nonPlaceholders = allTypes.filter(type => {
            if (type.kind === TypeKind.Error) {
                const errorType = type as ErrorTypeDescription;
                return errorType.message !== '__recursion_placeholder__';
            }
            return true;
        });

        const typesToUse = nonPlaceholders.length > 0 ? nonPlaceholders : allTypes;

        // Find the common type (not a union!)
        return this.getCommonType(typesToUse);
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
            // The coroutine expression wraps a function and creates a coroutine instance
            // For coroutines, the function's returnType is actually the yieldType
            return factory.createCoroutineType(
                fnType.parameters,
                fnType.returnType,  // This is the yield type for coroutines
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

    private inferDestructuringElement(node: ast.DestructuringElement): TypeDescription {
        /**
         * let (a, b) = (1, 2) 
         * let (a, _, c) = f() where f() -> (u32, u32, u32)
         */
        // Check if underscore -> return never
        if (node.name === undefined) {
            return factory.createNeverType();
        }

        const index = node.$containerIndex;
        const initializer = node.$container.initializer;
        // Unreachable, but create an error, you never know these days
        if (index == undefined || !ast.isVariableDeclaration(node.$container) || !initializer) {
            return factory.createErrorType('Invalid destructuring element', undefined, node);
        }

        /**
         * Wraps a node with a nullable type if the node is nullable
         */
        function wrapNode(node: ast.DestructuringElement, t: TypeDescription): TypeDescription {
            return node.isNullable ? factory.createNullableType(t, node) : t;
        }

        // Infer the type of the initializer
        const initializerType = this.inferExpression(initializer);
        /**
         * There are are couple of cases, we need to handle:
         * 1. Initializer is an array
         * 2. Initializer is a tuple
         * 3. Initializer is a struct
         */

        if (isArrayType(initializerType)) {
            if (node.isSpread) {
                return wrapNode(node, factory.createArrayType(initializerType.elementType, node));
            }
            else {
                return wrapNode(node, initializerType.elementType);
            }
        }
        else if (isTupleType(initializerType)) {
            return wrapNode(node, initializerType.elementTypes[index]);
        }
        else if (isStructType(initializerType)) {
            /**
             * We need to base struct + we need to remove the previously 
             */
            const structType = initializerType;
            // check if we have a destructuring

            if (node.isSpread) {
                const structFields = structType.fields;
                // Grab all previous elements, not including the current one
                const fieldsToRemove = (node.$container.elements ?? []).slice(0, index).map(e => e.originalName ?? e.name);
                const newStructType = factory.createStructType(structFields.filter(f => !fieldsToRemove.includes(f.name)), false, node);
                return wrapNode(node, newStructType);
            }
            else {
                // find the field by name
                const field = structType.fields.find(f => f.name === (node.originalName ?? node.name));
                if (field) {
                    return wrapNode(node, field.type);
                }
                else {
                    return factory.createErrorType(`Field '${node.name}' not found`, undefined, node);
                }
            }
        }

        return factory.createErrorType('Invalid destructuring element', undefined, node);
    }

    private inferVariantConstructorField(node: ast.VariantConstructorField): TypeDescription {
        return this.getType(node.type);
    }

    private inferStructFieldKeyValuePair(node: ast.StructFieldKeyValuePair): TypeDescription {
        return this.getType(node.expr);
    }

    private inferStructField(node: ast.StructField): TypeDescription {
        return this.getType(node.type);
    }
    
    private inferFFIMethodHeader(node: ast.FFIMethodHeader): TypeDescription {
        return factory.createFunctionType(
            node.header.args?.map(arg => factory.createFunctionParameterType(
                arg.name,
                this.getType(arg.type),
                arg.isMut
            )) ?? [],
            node.header.returnType ? this.getType(node.header.returnType) : factory.createVoidType(node),
            'fn',
            [],
            node
        );
    }


    // ========================================================================
    // Built-in Prototypes
    // ========================================================================

    private getArrayPrototype(): TypeDescription {
        if (this.builtinPrototypes.has('array')) {
            return this.builtinPrototypes.get('array')!;
        }

        // Find array prototype definition in builtins
        const document = this.services.shared.workspace.LangiumDocuments.getDocument(URI.parse(ArrayPrototypeBuiltin));
        if (document) {
            // There should be only one definition in the document
            const prototype = (document.parseResult.value as ast.Module).definitions[0] as ast.BuiltinDefinition;
            this.builtinPrototypes.set('array', this.getType(prototype));
            return this.builtinPrototypes.get('array')!;
        }

        // Return empty prototype if not found
        return factory.createPrototypeType('array', [], []);
    }

    private getStringPrototype(): TypeDescription {
        if (this.builtinPrototypes.has('string')) {
            return this.builtinPrototypes.get('string')!;
        }

        // Find array prototype definition in builtins
        const document = this.services.shared.workspace.LangiumDocuments.getDocument(URI.parse(StringPrototypeBuiltin));
        if (document) {
            const prototype = (document.parseResult.value as ast.Module).definitions[0] as ast.BuiltinDefinition;
            this.builtinPrototypes.set('string', this.getType(prototype));
            return this.builtinPrototypes.get('string')!;
        }

        // Return empty prototype if not found
        return factory.createPrototypeType('array', [], []);
    }

    /**
     * Returns the indexes of all valid targets for a function call
     * @param args 
     * @param functions 
     * @returns The indexes of all valid targets for a function call
     */
    resolveFunctionCall(args: ast.Expression[], functions: FunctionTypeDescription[]): number[] {
        const expressionTypes = args.map(arg => this.inferExpression(arg));
        const argBasedCandidates = functions.filter(fn => fn.parameters.length === expressionTypes.length);


        if (argBasedCandidates.length === 1) {
            return [functions.indexOf(argBasedCandidates[0])];
        }


        const finalCandidates = [];
        // First prio is exact match
        for (const fn of functions) {
            if (fn.parameters.every((param, index) => areTypesEqual(expressionTypes[index], param.type).success)) {
                finalCandidates.push(fn);
            }
        }

        // Second prio is assignable match
        if (finalCandidates.length === 0) {
            for (const fn of argBasedCandidates) {
                if (fn.parameters.every((param, index) => isAssignable(expressionTypes[index], param.type).success)) {
                    finalCandidates.push(fn);
                }
            }
        }
        return finalCandidates.map(fn => functions.indexOf(fn));
    }

    /**
     * G
     * Generic Utilities
     * G
     */


    /**
     * Infer generic type parameters from function call arguments.
     *
     * Given a function with generic parameters and a list of argument types,
     * this function attempts to infer the concrete types for all generics.
     *
     * @param genericParamNames Names of the generic parameters (e.g., ['T', 'U'])
     * @param parameterTypes Function parameter types (may contain generic references)
     * @param argumentTypes Concrete types of the call arguments
     * @returns Map of generic parameter names to inferred concrete types
     *
     * @example
     * ```
     * fn map<U, V>(xs: U[], f: fn(a: U) -> V) -> V[]
     *
     * // Call: map([1u32, 2u32], fn(a: u32) -> f32 { ... })
     * this.inferGenericsFromArguments(
     *   ['U', 'V'],
     *   [U[], fn(U) -> V],
     *   [u32[], fn(u32) -> f32]
     * )
     * // Returns: Map { 'U' => u32, 'V' => f32 }
     * ```
     */
    public inferGenericsFromArguments(
        genericParamNames: string[],
        parameterTypes: TypeDescription[], // Arguments in decl
        argumentTypes: TypeDescription[] // Arguments in call
    ): Map<string, TypeDescription> {
        // Initialize all generics with `never` (uninferrable by default)
        const inferredGenerics = new Map<string, TypeDescription[]>();
        for (const paramName of genericParamNames) {
            inferredGenerics.set(paramName, []);
        }

        // Infer generics from each argument
        const numArgs = Math.min(parameterTypes.length, argumentTypes.length);
        for (let i = 0; i < numArgs; i++) {
            this.extractGenericArgsFromTypeDescription(parameterTypes[i], argumentTypes[i], inferredGenerics);
        }

        // Need to find the common super type of the inferred generics
        const finalMap = new Map<string, TypeDescription>();
        for (const [key, values] of inferredGenerics) {
            if (values.length === 0) {
                finalMap.set(key, factory.createNeverType());
                continue;
            }
            const commonType = this.getCommonType(values);
            finalMap.set(key, commonType);
        }

        return finalMap;
    }


    /**
     * Extract generic arguments from a data type, for example:
     * ```fn<T>(x: T) -> T fn(1u32) -> {T: [u32]}``` where T is a generic parameter name.
     * ```fn<T>(x: {key: string, value: T}) -> T fn({key: "x", value: "y"}) -> {T: [string]}``` 
     * @param parameterType: The parameter type from the declaration
     * @param argumentType: The argument type from the call
     * @param genericMap: The map to store the inferred generic parameters
     */
    private extractGenericArgsFromTypeDescription(parameterType: TypeDescription, argumentType: TypeDescription, genericMap: Map<string, TypeDescription[]>) {
        function SET(genericMap: Map<string, TypeDescription[]>, key: string, value: TypeDescription) {
            const existing = genericMap.get(key);
            if (existing) {
                existing.push(value);
            } else {
                genericMap.set(key, [value]);
            }
        }


        if (isGenericType(parameterType)) {
            SET(genericMap, parameterType.name, argumentType);
        }

        const resolvedParameterType = isReferenceType(parameterType) ? this.resolveReference(parameterType) : parameterType;
        const resolvedArgumentType = isReferenceType(argumentType) ? this.resolveReference(argumentType) : argumentType;

        // Ignore error types
        if (isErrorType(resolvedParameterType) || isErrorType(resolvedArgumentType)) {
            return;
        }
        
        if (isStructType(resolvedParameterType) && isStructType(resolvedArgumentType)) {
            for (const field of resolvedParameterType.fields) {
                const fieldInArgumentType = resolvedArgumentType.fields.find(f => f.name === field.name);
                if (fieldInArgumentType) {
                    this.extractGenericArgsFromTypeDescription(field.type, fieldInArgumentType.type, genericMap);
                }
            }
        }

        if (isArrayType(resolvedParameterType) && isArrayType(resolvedArgumentType)) {
            this.extractGenericArgsFromTypeDescription(resolvedParameterType.elementType, resolvedArgumentType.elementType, genericMap);
        }

        if(isNullableType(resolvedParameterType) && isNullableType(resolvedArgumentType)) {
            this.extractGenericArgsFromTypeDescription(resolvedParameterType.baseType, resolvedArgumentType.baseType, genericMap);
        }

        if(isFunctionType(resolvedParameterType) && isFunctionType(resolvedArgumentType)) {
            for (let i = 0; i < Math.min(resolvedParameterType.parameters.length, resolvedArgumentType.parameters.length); i++) {
                this.extractGenericArgsFromTypeDescription(resolvedParameterType.parameters[i].type, resolvedArgumentType.parameters[i].type, genericMap);
            }
            this.extractGenericArgsFromTypeDescription(resolvedParameterType.returnType, resolvedArgumentType.returnType, genericMap);
        }

        // TODO: add more cases as needed (variant types, function types, etc.)
    }
}

