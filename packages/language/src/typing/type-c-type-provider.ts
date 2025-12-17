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
    FunctionTypeDescription,
    GenericTypeDescription,
    InterfaceTypeDescription,
    isArrayType,
    isClassType,
    isCoroutineType,
    isEnumType,
    isErrorType,
    isFFIType,
    isFunctionType,
    isGenericType,
    isImplementationType,
    isIntegerType,
    isJoinType,
    isMetaClassType,
    isMetaEnumType,
    isMetaVariantConstructorType,
    isMetaVariantType,
    isNamespaceType,
    isNeverType,
    isNullableType,
    isPrototypeType,
    isReferenceType,
    isStringEnumType,
    isStringLiteralType,
    isStringType,
    isTupleType,
    isUnionType,
    isVariantConstructorType,
    isVariantType,
    MethodType,
    PrototypeMethodType,
    ReferenceTypeDescription,
    StructFieldType,
    TypeDescription,
    TypeKind,
    VariantConstructorTypeDescription
} from './type-c-types.js';
import { TypeCTypeFactory } from './type-factory.js';
import { TypeCTypeUtils } from './type-utils.js';

/**
 * Main type provider service.
 * Provides type inference for all AST nodes in Type-C.
 */
export class TypeCTypeProvider {
    /** Cache for computed types, keyed by AST node */
    private readonly typeCache: DocumentCache<AstNode, TypeDescription>;

    /** Cache for expected types, keyed by AST node */
    private readonly expectedTypeCache: DocumentCache<AstNode, TypeDescription | undefined>;

    /** Cache for pattern validation errors detected during type inference */
    private readonly patternValidationErrorCache: DocumentCache<AstNode, { message: string } | undefined>;

    /** Type Utils service */
    private readonly typeUtils: TypeCTypeUtils;

    /** Type Factory service */
    private readonly typeFactory: TypeCTypeFactory;
    /**
     * Tracks functions currently being inferred to prevent infinite recursion.
     *
     * When inferring recursive functions like `fn fib(n) = fib(n-1) + fib(n-2)`,
     * we need to detect when we're already inferring the same function to avoid
     * stack overflow.
     */
    private readonly inferringFunctions = new Set<AstNode>();

    /**
     * Tracks classes currently being inferred to prevent infinite recursion.
     *
     * When inferring class methods that reference `this` (e.g., `fn serialize() = this`),
     * we need to detect when we're already inferring the same class to avoid
     * stack overflow.
     */
    private readonly inferringClasses = new Set<ast.ClassType>();

    /**
     * Tracks class methods currently being inferred to prevent infinite recursion.
     *
     * This is critical for handling cycles like:
     * ```
     * fn getValue() { return this.value }
     * ```
     *
     * Where inferring the method's return type requires accessing class members,
     * which triggers scope resolution, which triggers type inference again.
     *
     * Maps method node to its containing class node for cycle detection.
     */
    private readonly inferringMethods = new Map<ast.ClassMethod, ast.ClassType>();

    /**
     * Tracks implementation types currently being inferred to prevent infinite recursion.
     *
     * Similar to inferringClasses, this handles cycles when impl methods reference `this`
     * or access other members within the implementation type.
     */
    private readonly inferringImplementations = new Set<ast.ImplementationType>();

    /**
     * Tracks impl methods currently being inferred to prevent infinite recursion.
     *
     * Similar to inferringMethods for classes, but for implementation type methods.
     * Maps method node to its containing implementation type for cycle detection.
     * Note: Impl methods in the AST use ClassMethod nodes, hence the type here.
     */
    private readonly inferringImplMethods = new Map<ast.ClassMethod, ast.ImplementationType>();

    /** Services for accessing Langium infrastructure */
    protected readonly services: TypeCServices;

    /** Built-in prototype types (array, coroutine) */
    private readonly builtinPrototypes = new Map<string, TypeDescription>();

    constructor(services: TypeCServices) {
        this.services = services;
        this.typeCache = new DocumentCache(services.shared);
        this.expectedTypeCache = new DocumentCache(services.shared);
        this.patternValidationErrorCache = new DocumentCache(services.shared);
        this.typeUtils = services.typing.TypeUtils;
        // Use lazy getter to avoid circular dependency
        this.typeFactory = services.typing.TypeFactory;
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
            return this.typeFactory.createErrorType('Node is undefined');
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
        this.patternValidationErrorCache.clear(documentUri);
    }

    /**
     * Gets a pattern validation error if one was detected during type inference.
     * Returns undefined if no error was detected.
     */
    getPatternValidationError(node: AstNode): { message: string } | undefined {
        const documentUri = AstUtils.getDocument(node).uri;
        return this.patternValidationErrorCache.get(documentUri, node, () => undefined);
    }

    /**
     * Sets a pattern validation error detected during type inference.
     * This allows us to report pattern type mismatches at the pattern level
     * rather than on each individual element.
     */
    private setPatternValidationError(node: AstNode, message: string): void {
        const documentUri = AstUtils.getDocument(node).uri;
        this.patternValidationErrorCache.set(documentUri, node, { message });
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

        // Function parameter inference: fn(x) -> ... where lambda is expected to have type fn(T) -> U
        // Special handling for FunctionParameter nodes
        if (ast.isFunctionParameter(node)) {
            // Parent is FunctionHeader, grandparent might be LambdaExpression
            const header = parent;
            if (header && ast.isFunctionHeader(header)) {
                const lambda = header.$container;
                if (lambda && ast.isLambdaExpression(lambda)) {
                    const expectedLambdaType = this.getExpectedType(lambda);
                    if (expectedLambdaType && isFunctionType(expectedLambdaType)) {
                        // Find parameter index
                        const paramIndex = header.args?.findIndex(arg => arg === node);
                        if (paramIndex !== undefined && paramIndex >= 0 && paramIndex < expectedLambdaType.parameters.length) {
                            return expectedLambdaType.parameters[paramIndex].type;
                        }
                    }
                }
            }
        }

        // Variable declaration with annotation
        // let x: T = expr
        if (ast.isVariableDeclaration(parent) && parent.annotation && parent.initializer === node) {
            return this.getType(parent.annotation);
        }

        // Expression-body function: fn foo() -> T = expr
        if (ast.isFunctionDeclaration(parent) && parent.expr === node && parent.header?.returnType) {
            return this.getType(parent.header.returnType);
        }

        // Expression-body method: fn foo() -> T = expr (in class)
        if (ast.isClassMethod(parent) && parent.expr === node && parent.method?.header?.returnType) {
            return this.getType(parent.method.header.returnType);
        }

        // Function call argument
        // foo(expr)
        if (ast.isFunctionCall(parent)) {
            let fnType = this.inferExpression(parent.expr);

            // Resolve reference types first
            fnType = this.typeUtils.resolveIfReference(fnType);

            // Handle variant constructor calls (e.g., Result.Ok(42) where Result<u32, string> is expected)
            // This enables contextual typing for constructor arguments
            // Variant constructors are FunctionTypes with VariantConstructorType as return type
            if (isFunctionType(fnType) && isVariantConstructorType(fnType.returnType)) {
                const constructorType = fnType.returnType;

                // Get the expected type for the whole call (e.g., Result<u32, string>)
                const expectedCallType = this.getExpectedType(parent);

                if (expectedCallType) {
                    // Extract generic substitutions from the expected type
                    let substitutions: Map<string, TypeDescription> | undefined;

                    if (isReferenceType(expectedCallType) && expectedCallType.genericArgs.length > 0) {
                        // Build substitution map from the expected type's generic args
                        const variantDecl = constructorType.variantDeclaration;
                        if (variantDecl && variantDecl.genericParameters) {
                            substitutions = new Map<string, TypeDescription>();
                            variantDecl.genericParameters.forEach((param, i) => {
                                if (i < expectedCallType.genericArgs.length) {
                                    substitutions!.set(param.name, expectedCallType.genericArgs[i]);
                                }
                            });
                        }
                    }

                    // Find the parameter type for this argument
                    const argIndex = parent.args?.findIndex(arg => arg === node);
                    if (argIndex !== undefined && argIndex >= 0 && argIndex < fnType.parameters.length) {
                        // Get the parameter type from the function (which has generic types like T)
                        let paramType = fnType.parameters[argIndex].type;

                        // Apply generic substitutions if we have them
                        if (substitutions && substitutions.size > 0) {
                            paramType = this.typeUtils.substituteGenerics(paramType, substitutions);
                        }

                        return paramType;
                    }
                }
            }

            if (isFunctionType(fnType)) {
                // Find which argument position this is
                const argIndex = parent.args?.findIndex(arg => arg === node);
                if (argIndex !== undefined && argIndex >= 0 && argIndex < fnType.parameters.length) {
                    let expectedParamType = fnType.parameters[argIndex].type;

                    // If the function has generic parameters and we're inferring an expression that needs context,
                    // perform iterative partial generic inference from other arguments
                    const genericParams = fnType.genericParameters || [];
                    const needsContext = ast.isExpression(node) && this.expressionNeedsContextualTyping(node);

                    if (genericParams.length > 0 && needsContext) {
                        const args = parent.args || [];
                        const parameterTypes = fnType.parameters.map(p => p.type);
                        const genericParamNames = genericParams.map(p => p.name);

                        // Iterative inference: keep trying to infer more generics until we can't make progress
                        let substitutions = new Map<string, TypeDescription>();
                        let madeProgress = true;
                        let maxIterations = args.length; // Prevent infinite loops
                        let iteration = 0;

                        while (madeProgress && iteration < maxIterations) {
                            madeProgress = false;
                            iteration++;

                            const argumentTypes: TypeDescription[] = [];

                            // Collect types of arguments, using current substitutions
                            for (let i = 0; i < args.length; i++) {
                                if (i === argIndex) {
                                    // Skip the current argument
                                    argumentTypes.push(this.typeFactory.createErrorType('__contextual_placeholder__', undefined, node));
                                } else if (this.expressionNeedsContextualTyping(args[i])) {
                                    // Try to infer contextual argument with current substitutions
                                    // Apply current substitutions to parameter type
                                    const paramTypeWithSubs = this.typeUtils.substituteGenerics(
                                        parameterTypes[i],
                                        substitutions
                                    );

                                    // For lambdas, only check if PARAMETER types have unresolved generics
                                    // Return type generics are fine - they'll be inferred from the lambda body
                                    let hasUnresolvedGenerics: boolean;
                                    if (isFunctionType(paramTypeWithSubs)) {
                                        // Only check lambda parameter types, not return type
                                        hasUnresolvedGenerics = paramTypeWithSubs.parameters.some(p =>
                                            this.typeContainsGenerics(p.type, genericParamNames)
                                        );
                                    } else {
                                        // For non-function types, check the entire type
                                        hasUnresolvedGenerics = this.typeContainsGenerics(paramTypeWithSubs, genericParamNames);
                                    }

                                    if (hasUnresolvedGenerics) {
                                        // Still has unresolved generics - skip for now
                                        argumentTypes.push(this.typeFactory.createErrorType('__contextual_placeholder__', undefined, args[i]));
                                    } else {
                                        // All generics resolved - try to infer this argument's type
                                        // Temporarily set the expected type for contextual expressions
                                        const argType = this.inferExpressionWithContext(args[i], paramTypeWithSubs);
                                        argumentTypes.push(argType);

                                        // If we successfully inferred a non-error type, we made progress
                                        if (!isErrorType(argType) || !argType.message.includes('placeholder')) {
                                            madeProgress = true;
                                        }
                                    }
                                } else {
                                    // Non-contextual argument - infer normally
                                    argumentTypes.push(this.inferExpression(args[i]));
                                }
                            }

                            // Infer generics from current argument types
                            const newSubstitutions = this.inferGenericsFromArguments(
                                genericParamNames,
                                parameterTypes,
                                argumentTypes
                            );

                            // Check if we learned anything new
                            for (const [key, value] of newSubstitutions) {
                                const existing = substitutions.get(key);
                                if (!existing || existing.kind === TypeKind.Never) {
                                    if (value.kind !== TypeKind.Never) {
                                        substitutions.set(key, value);
                                        madeProgress = true;
                                    }
                                }
                            }
                        }

                        // Apply final substitutions to the expected parameter type
                        expectedParamType = this.typeUtils.substituteGenerics(expectedParamType, substitutions);
                    }

                    return expectedParamType;
                }
            }
        }

        // Return statement
        // return expr
        if (ast.isReturnStatement(parent)) {
            // Check if we're in a do expression first (before checking functions)
            // Do expressions use contextual typing from their usage context
            const doExpr = this.getContainingDoExpression(parent);
            if (doExpr) {
                // Use the expected type of the do expression as the hint
                const expectedDoType = this.getExpectedType(doExpr);
                if (expectedDoType) {
                    return expectedDoType;
                }
                // If no expected type, return undefined (do expressions without context)
                return undefined;
            }

            // Find the containing function
            const fn = AstUtils.getContainerOfType(parent, ast.isFunctionDeclaration);
            if (fn && fn.header.returnType) {
                return this.getType(fn.header.returnType);
            }

            // Also check for class methods
            const classMethod = AstUtils.getContainerOfType(parent, ast.isClassMethod);
            if (classMethod && classMethod.method?.header?.returnType) {
                return this.getType(classMethod.method.header.returnType);
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

            // Nullish coalescing operator: RHS uses LHS type (unwrapped if nullable)
            // This enables: d?.getValue() ?? 0 where getValue() returns u64 → 0 is inferred as u64
            if (parent.op === '??' && parent.right === node) {
                const leftType = this.inferExpression(parent.left);
                // Unwrap nullable to get the base type for contextual typing
                return isNullableType(leftType) ? leftType.baseType : leftType;
            }

            // Comparison and arithmetic operators: use the OTHER operand's type
            // BUT: Only use contextual typing for literals to avoid infinite recursion
            // AND: Only for primitive types (not classes/interfaces with operator overloads)
            const binaryOps = ['<', '>', '<=', '>=', '==', '!=', '+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'];
            if (binaryOps.includes(parent.op) && (ast.isIntegerLiteral(node) || ast.isFloatingPointLiteral(node))) {
                // This is a literal - try to use the other operand's type
                const otherOperand = parent.right === node ? parent.left : parent.right;

                // Only infer from the other operand if it's NOT also a literal (avoid circular inference)
                if (!ast.isIntegerLiteral(otherOperand) && !ast.isFloatingPointLiteral(otherOperand)) {
                    const otherType = this.inferExpression(otherOperand);
                    // Resolve references to check for class/interface types
                    const resolvedOtherType = this.typeUtils.resolveIfReference(otherType);

                    // Only use as context if it's a primitive type (not class/interface with operator overloads)
                    if (!isClassType(resolvedOtherType) && !this.typeUtils.asInterfaceType(resolvedOtherType)) {
                        return otherType;
                    }
                }
            }
        }

        // Array element in array construction: [expr1, expr2, ...]
        // If parent array has expected type T[], propagate T to elements
        if (parent && ast.isArrayElementExpression(parent)) {
            const arrayExpr = parent.$container;
            if (ast.isArrayConstructionExpression(arrayExpr)) {
                const expectedArrayType = this.getExpectedType(arrayExpr);
                if (expectedArrayType && isArrayType(expectedArrayType)) {
                    return expectedArrayType.elementType;
                }
            }
        }

        // Match expression case body: match x { pattern => expr }
        // If match has expected type, propagate to all case bodies
        if (parent && ast.isMatchCaseExpression(parent) && parent.body === node) {
            const matchExpr = parent.$container;
            if (ast.isMatchExpression(matchExpr)) {
                const expectedMatchType = this.getExpectedType(matchExpr);
                if (expectedMatchType) {
                    return expectedMatchType;
                }
            }
        }

        // Match expression default body: match x { _ => expr }
        if (parent && ast.isMatchExpression(parent) && parent.defaultExpr === node) {
            const expectedMatchType = this.getExpectedType(parent);
            if (expectedMatchType) {
                return expectedMatchType;
            }
        }

        // Conditional expression branches: if cond => expr1 else expr2
        // If conditional has expected type, propagate to all branches
        if (parent && ast.isConditionalExpression(parent)) {
            // Check if node is one of the then expressions or the else expression
            const isExpr = ast.isExpression(node);
            if (isExpr) {
                const isThenExpr = parent.thens?.some(thenExpr => thenExpr === node);
                const isElseExpr = parent.elseExpr === node;

                if (isThenExpr || isElseExpr) {
                    const expectedCondType = this.getExpectedType(parent);
                    if (expectedCondType) {
                        return expectedCondType;
                    }
                }
            }
        }

        // Struct field in named struct construction: {x: expr, y: expr}
        // If the struct has expected type, propagate field types
        if (parent && ast.isStructFieldKeyValuePair(parent)) {
            const structExpr = parent.$container;
            if (ast.isNamedStructConstructionExpression(structExpr)) {
                const expectedStructType = this.getExpectedType(structExpr);
                if (expectedStructType) {
                    // Resolve reference types
                    const resolvedExpected = isReferenceType(expectedStructType)
                        ? this.resolveReference(expectedStructType)
                        : expectedStructType;

                    // Get the struct type (handles both direct structs and join types)
                    const structType = this.typeUtils.asStructType(resolvedExpected);
                    if (structType) {
                        // Find the field with this name
                        const field = structType.fields.find(f => f.name === parent.name);
                        if (field) {
                            return field.type;
                        }
                    }
                }
            }
        }

        // Anonymous struct field: {expr1, expr2, ...}
        // If the struct has expected type, propagate field types by position
        if (parent && ast.isAnonymousStructConstructionExpression(parent)) {
            const expectedStructType = this.getExpectedType(parent);
            if (expectedStructType) {
                // Resolve reference types
                const resolvedExpected = isReferenceType(expectedStructType)
                    ? this.resolveReference(expectedStructType)
                    : expectedStructType;

                // Get the struct type
                const structType = this.typeUtils.asStructType(resolvedExpected);
                if (structType && ast.isExpression(node)) {
                    // Find the index of this expression
                    const index = parent.expressions?.indexOf(node);
                    if (index !== undefined && index >= 0 && index < structType.fields.length) {
                        return structType.fields[index].type;
                    }
                }
            }
        }

        // Tuple element: (expr1, expr2, ...)
        // If tuple has expected type (T1, T2, ...), propagate types by position
        if (parent && ast.isTupleExpression(parent)) {
            const expectedTupleType = this.getExpectedType(parent);
            if (expectedTupleType && isTupleType(expectedTupleType) && ast.isExpression(node)) {
                // Find the index of this expression
                const index = parent.expressions.indexOf(node);
                if (index >= 0 && index < expectedTupleType.elementTypes.length) {
                    return expectedTupleType.elementTypes[index];
                }
            }
        }

        // Let-in expression body: let x = ... in expr
        // The final expression uses the expected type of the let-in
        if (parent && ast.isLetInExpression(parent) && parent.expr === node) {
            const expectedLetInType = this.getExpectedType(parent);
            if (expectedLetInType) {
                return expectedLetInType;
            }
        }

        // New expression arguments: new MyClass(arg1, arg2, ...)
        // Arguments should match init method parameters
        if (parent && ast.isNewExpression(parent) && parent.args && ast.isExpression(node)) {
            // Check if this node is one of the arguments
            const argIndex = parent.args.findIndex(arg => arg === node);
            if (argIndex >= 0 && parent.instanceType) {
                // Get the class type being instantiated
                const classRefType = this.getType(parent.instanceType);

                // Resolve reference types to get the actual class
                const resolvedClassType = isReferenceType(classRefType)
                    ? this.resolveReference(classRefType)
                    : classRefType;

                // Check if it's a class type - if not, return error for validation
                if (!isClassType(resolvedClassType)) {
                    // Return error type that will be caught by validations
                    // This allows the validation system to report proper error messages
                    return this.typeFactory.createErrorType(
                        `Cannot use 'new' with non-class type '${resolvedClassType.toString()}'`,
                        undefined,
                        parent
                    );
                }

                // Look for init methods
                const initMethods = resolvedClassType.methods.filter(m => m.names.includes('init'));

                // Filter by argument count to find matching candidates
                const argCount = parent.args.length;
                const candidates = initMethods.filter(m => m.parameters.length === argCount);

                // Context-driven inference strategy:
                // - If exactly 1 candidate: use expected type from that candidate's parameters
                // - If 0 or 2+ candidates: don't provide expected type (infer without context)
                if (candidates.length === 1) {
                    const initMethod = candidates[0];
                    if (argIndex < initMethod.parameters.length) {
                        let paramType = initMethod.parameters[argIndex].type;

                        // Apply generic substitutions if we have them
                        if (isReferenceType(classRefType) && classRefType.genericArgs.length > 0) {
                            const substitutions = this.buildGenericSubstitutions(classRefType);
                            if (substitutions && substitutions.size > 0) {
                                paramType = this.typeUtils.substituteGenerics(paramType, substitutions);
                            }
                        }

                        return paramType;
                    }
                }

                // If we have 0 or 2+ candidates, don't provide expected type
                // This allows arguments to be inferred without context first,
                // then we can resolve overloads based on inferred types
            }
        }

        // Lambda parameter inference: fn(x) -> ... where lambda is expected to have type fn(T) -> U
        // If the lambda is passed to a function expecting a specific function type, use that
        if (parent && ast.isLambdaExpression(parent)) {
            const expectedLambdaType = this.getExpectedType(parent);
            if (expectedLambdaType && isFunctionType(expectedLambdaType)) {
                // Check if this node is one of the lambda's parameters
                const paramIndex = parent.header.args?.findIndex(arg => arg === node);
                if (paramIndex !== undefined && paramIndex >= 0 && paramIndex < expectedLambdaType.parameters.length) {
                    return expectedLambdaType.parameters[paramIndex].type;
                }
            }
        }

        // Lambda body expression: fn(x) = expr where lambda is expected to have return type U
        // If the lambda has an expected function type, propagate return type to body expression
        if (parent && ast.isLambdaExpression(parent) && parent.expr === node) {
            const expectedLambdaType = this.getExpectedType(parent);
            if (expectedLambdaType && isFunctionType(expectedLambdaType)) {
                // Return the expected return type for the lambda's body expression
                return expectedLambdaType.returnType;
            }
        }

        // Yield expression: yield expr in coroutine
        // Should use the coroutine's declared yield type
        if (parent && ast.isYieldExpression(parent) && parent.expr === node) {
            // Find the containing coroutine (function or lambda with cfn type)
            const containingFn = AstUtils.getContainerOfType(parent, ast.isFunctionDeclaration);
            if (containingFn && containingFn.fnType === 'cfn' && containingFn.header.returnType) {
                // For coroutines, returnType is actually the yield type
                return this.getType(containingFn.header.returnType);
            }

            const containingLambda = AstUtils.getContainerOfType(parent, ast.isLambdaExpression);
            if (containingLambda && containingLambda.fnType === 'cfn' && containingLambda.header.returnType) {
                // For coroutine lambdas, returnType is actually the yield type
                return this.getType(containingLambda.header.returnType);
            }
        }

        // Do expression final value: do { ... expr }
        // The final expression should match the expected type of the do expression
        if (parent && ast.isDoExpression(parent)) {
            // Check if this is the last statement/expression in the block
            // For now, we'll propagate the do expression's expected type to all expressions
            const expectedDoType = this.getExpectedType(parent);
            if (expectedDoType) {
                return expectedDoType;
            }
        }

        // Object update field expression: vec.{x: expr, y: expr}
        // If the field exists in the base type, use its type as expected type
        if (parent && ast.isKeyValuePair(parent)) {
            const objectUpdate = parent.$container;
            if (objectUpdate && ast.isObjectUpdate(objectUpdate)) {
                let baseType = this.getType(objectUpdate.expr);

                // Resolve reference types
                if (isReferenceType(baseType)) {
                    baseType = this.resolveReference(baseType);
                }

                // Unwrap nullable types
                if (isNullableType(baseType)) {
                    baseType = baseType.baseType;
                }

                // Get field/attribute type using the helper
                const fieldType = this.getFieldType(baseType, parent.name);
                if (fieldType) {
                    return fieldType;
                }
            }
        }

        // ForRangeIterator step expression: foreach x in start, end, step { ... }
        // The step should always be u64 (positive integer)
        if (parent && ast.isForRangeIterator(parent) && parent.step === node) {
            return this.typeFactory.createU64Type(node);
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

        // CRITICAL: Handle generic types with constraints for auto-completion
        // If type is a generic type parameter (e.g., T in fn<T: ComparableObject>),
        // use its constraint to get available fields for auto-completion
        // Example: T: ComparableObject → auto-complete shows eq() and toString()
        const resolvedGeneric = this.typeUtils.resolveIfGeneric(type);
        if (resolvedGeneric !== type) {
            return this.getIdentifiableFields(resolvedGeneric);
        }

        // FFI
        if (isFFIType(type) && ast.isExternFFIDecl(type.node)) {
            return type.node?.methods ?? [];
        }

        if (isMetaEnumType(type) && type.baseEnum.node && ast.isEnumType(type.baseEnum.node)) {
            return type.baseEnum.node.cases;
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
                            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
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

            // Add impl method nodes for auto-completion (excluding shadowed methods)
            // Shadowed methods are those overridden by class methods with the 'override' flag
            const classMethods = type.node.methods?.filter(m => ast.isClassMethod(m)) ?? [];
            
            for (const implDecl of type.node.implementations ?? []) {
                let implType = this.getType(implDecl.type);
                if (isReferenceType(implType)) {
                    implType = this.resolveReference(implType)
                }
                if (isImplementationType(implType) && implType.node && ast.isImplementationType(implType.node)) {
                    for (const implMethod of implType.node.methods ?? []) {
                        // Check if this impl method is shadowed by an override method
                        const isShadowed = this.isMethodShadowedByOverride(
                            implMethod.method,
                            classMethods
                        );
                        
                        if (!isShadowed) {
                            nodes.push(implMethod);
                        }
                    }
                }
            }

            return nodes;
        }
        else if (isMetaClassType(type)) {
            const classNode = type?.baseClass?.node;
            if (classNode && ast.isClassType(classNode)) {
                nodes.push(...(classNode.attributes.filter(a => a.isStatic) ?? []));
                nodes.push(...(classNode.methods.filter(m => m.isStatic) ?? []));
            }
            return nodes;
        }

        // Implementation type members (attributes and methods)
        // Similar to classes, impl types have attributes and methods that can be accessed via `this`
        if (isImplementationType(type) && type.node && ast.isImplementationType(type.node)) {
            // Get attributes from the implementation type
            if (type.node.attributes) {
                nodes.push(...type.node.attributes);
            }
            // Get methods from the implementation type
            if (type.node.methods) {
                nodes.push(...type.node.methods);
            }

            // Add non-shadowed interface methods
            // When an impl extends an interface, the interface methods should be accessible
            // unless they're shadowed by impl methods with the same signature
            for (const superType of type.targetTypes) {
                // Resolve reference types first
                const resolvedSuperType = this.typeUtils.resolveIfReference(superType);
                const interfaceType = this.typeUtils.asInterfaceType(resolvedSuperType);
                
                if (interfaceType) {
                    // Get all interface methods
                    for (const interfaceMethod of interfaceType.methods) {
                        // Check if this interface method is shadowed by an impl method
                        const isShadowed = this.isInterfaceMethodShadowedByImpl(
                            interfaceMethod,
                            type.methods
                        );
                        
                        // Only add non-shadowed interface methods
                        if (!isShadowed && interfaceMethod.node) {
                            nodes.push(interfaceMethod.node);
                        }
                    }
                    
                    // Also recursively add methods from interface supertypes
                    for (const ifaceSuperType of interfaceType.superTypes) {
                        nodes.push(...this.getIdentifiableFields(ifaceSuperType));
                    }
                }
            }
            
            return nodes;
        }

        // Struct fields (including join types that resolve to structs)
        const structType = this.services.typing.TypeUtils.asStructType(type);
        if (structType) {
            nodes.push(...structType.fields.map(e => e.node))
        }

        if (isMetaVariantType(type)) {
            const variantNode = type.baseVariant.node;
            if (variantNode && ast.isVariantType(variantNode)) {
                nodes.push(...variantNode.constructors);
            }
        }

        // Interface methods (including join types that resolve to interfaces)
        const interfaceType = this.services.typing.TypeUtils.asInterfaceType(type);
        if (interfaceType) {
            const filtered: MethodType[] = interfaceType.methods.filter(m => m.node !== undefined);
            nodes.push(...filtered.map(m => m.node!));
            for (const superType of interfaceType.superTypes) {
                nodes.push(...this.getIdentifiableFields(superType))
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
        if (ast.isTypeGuard(node)) return this.inferTypeGuard(node);
        if (ast.isPrimitiveType(node)) return this.typeFactory.createPrimitiveTypeFromAST(node);
        if (ast.isStructType(node)) return this.inferStructType(node);
        if (ast.isVariantType(node)) return this.inferVariantType(node);
        if (ast.isEnumType(node)) return this.inferEnumType(node);
        if (ast.isStringEnumType(node)) return this.inferStringEnumType(node);
        if (ast.isInterfaceType(node)) return this.inferInterfaceType(node);
        if (ast.isClassType(node)) return this.inferClassType(node);
        if (ast.isImplementationType(node)) return this.inferImplementationType(node);
        if (ast.isFunctionType(node)) return this.inferFunctionType(node);
        if (ast.isCoroutineType(node)) return this.inferCoroutineType(node);
        if (ast.isReferenceType(node)) return this.inferReferenceType(node);

        // Declarations
        if (ast.isTypeDeclaration(node)) return this.getType(node.definition);
        if (ast.isFunctionDeclaration(node)) return this.inferFunctionDeclaration(node);
        if (ast.isVariableDeclaration(node)) return this.inferVariableDeclaration(node);
        if (ast.isClassAttributeDecl(node)) return this.getType(node.type);
        if (ast.isImplementationAttributeDecl(node)) return this.getType(node.type);
        if (ast.isFunctionParameter(node)) {
            // If parameter has explicit type annotation, use it
            if (node.type) {
                return this.getType(node.type);
            }

            // Otherwise, try to infer from context (lambda passed to function expecting specific function type)
            const expectedType = this.getExpectedType(node);
            if (expectedType) {
                return expectedType;
            }

            // If we can't infer type from context, return error
            return this.typeFactory.createErrorType(
                `Parameter '${node.name}' requires type annotation or must be in a context where type can be inferred`,
                undefined,
                node
            );
        }
        if (ast.isGenericType(node)) return this.inferGenericType(node);
        if (ast.isNamespaceDecl(node)) return this.typeFactory.createNamespaceType(node.name, node, node);
        if (ast.isExternFFIDecl(node)) return this.inferFFIDecl(node);

        // Class/Interface members
        if (ast.isClassMethod(node)) return this.inferClassMethod(node);
        if (ast.isMethodHeader(node)) return this.inferMethodHeaderAsType(node);

        // Expressions
        if (ast.isExpression(node)) return this.inferExpression(node);

        // Enum and Variant members
        if (ast.isEnumCase(node)) {
            const enumType = AstUtils.getContainerOfType(node, ast.isEnumType);
            return enumType ? this.getType(enumType) : this.typeFactory.createErrorType('Enum case outside enum', undefined, node);
        }
        if (ast.isVariantConstructor(node)) {
            const variantType = AstUtils.getContainerOfType(node, ast.isVariantType);
            if (!variantType) {
                return this.typeFactory.createErrorType('Variant constructor outside variant', undefined, node);
            }

            // Get the variant's type declaration to create a proper reference
            const variantDecl = AstUtils.getContainerOfType(variantType, ast.isTypeDeclaration);
            if (!variantDecl) {
                return this.typeFactory.createErrorType('Variant type without declaration', undefined, node);
            }

            // Get the resolved variant type
            // We need VariantTypeDescription, not ReferenceType
            const resolvedVariant = this.getType(variantDecl.definition);
            if (!isVariantType(resolvedVariant)) {
                return this.typeFactory.createErrorType('Expected variant type', undefined, node);
            }

            // Create a VariantConstructorType as the return type
            const constructorReturnType = this.typeFactory.createVariantConstructorType(
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
                this.typeFactory.createFunctionParameterType(p.name, this.getType(p.type))
            );

            return this.typeFactory.createFunctionType(
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
            const params = node.args.map(arg => this.typeFactory.createFunctionParameterType(
                arg.name,
                this.getType(arg.type),
                arg.isMut
            ));
            return this.typeFactory.createFunctionType(params, this.getType(node.returnType), 'fn', [], node);
        }
        if (ast.isDestructuringElement(node)) return this.inferDestructuringElement(node);
        if (ast.isVariantConstructorField(node)) return this.inferVariantConstructorField(node);
        if (ast.isStructFieldKeyValuePair(node)) return this.inferStructFieldKeyValuePair(node);
        if (ast.isStructField(node)) return this.inferStructField(node);
        if (ast.isFFIMethodHeader(node)) return this.inferFFIMethodHeader(node);
        if (ast.isIteratorVar(node)) return this.inferIteratorVar(node);
        if (ast.isVariablePattern(node)) return this.inferVariablePattern(node);
        if (ast.isKeyValuePair(node)) return this.inferKeyValuePair(node);

        return this.typeFactory.createErrorType(`Cannot infer type for ${node.$type}`, undefined, node);
    }

    // ========================================================================
    // DataType Inference
    // ========================================================================

    private inferArrayType(node: ast.ArrayType): TypeDescription {
        const elementType = this.getType(node.arrayOf);
        return this.typeFactory.createArrayType(elementType, node);
    }

    private inferNullableType(node: ast.NullableType): TypeDescription {
        const baseType = this.getType(node.baseType);
        return this.typeFactory.createNullableType(baseType, node);
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

        return this.typeUtils.simplifyType(this.typeFactory.createUnionType(types, node));
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

        return this.typeUtils.simplifyType(this.typeFactory.createJoinType(types, node));
    }

    private inferTupleTypeFromDataType(node: ast.TupleType): TypeDescription {
        // Tuple types have a 'types' property with array of DataType
        const elementTypes = node.types.map(t => this.getType(t));
        return this.typeFactory.createTupleType(elementTypes, node);
    }

    private inferTypeGuard(node: ast.TypeGuard): TypeDescription {
        // TypeGuard: param=[FunctionParameter:ID] 'is' type=DataType<false>
        const paramRef = node.param?.ref;
        if (!paramRef) {
            return this.typeFactory.createErrorType('Unresolved type guard parameter reference', undefined, node);
        }

        const parameterName = paramRef.name;

        // Get the parameter index from the AST
        // The parameter should have a $containerIndex property that gives its position
        const parameterIndex = paramRef.$containerIndex ?? -1;

        if (parameterIndex === -1) {
            return this.typeFactory.createErrorType('Could not determine parameter index for type guard', undefined, node);
        }

        const guardedType = this.getType(node.type);

        if (!parameterName) {
            return this.typeFactory.createErrorType("Cannot guard parameter without a name");
        }

        return this.typeFactory.createTypeGuardType(parameterName, parameterIndex, guardedType, node);
    }

    private inferStructType(node: ast.StructType): TypeDescription {
        const fields = node.fields.map(f => this.typeFactory.createStructField(
            f.name,
            this.getType(f.type),
            f
        ));
        return this.typeFactory.createStructType(fields, !node.name, node);
    }

    private inferVariantType(node: ast.VariantType): TypeDescription {
        const constructors = node.constructors.map(c => this.typeFactory.createVariantConstructor(
            c.name,
            c.params?.map(p => this.typeFactory.createStructField(p.name, this.getType(p.type), p)) ?? []
        ));
        return this.typeFactory.createVariantType(constructors, node);
    }

    private inferEnumType(node: ast.EnumType): TypeDescription {
        const cases = node.cases.map(c => this.typeFactory.createEnumCase(
            c.name,
            c.init ? this.evalIntegerLiteral(c.init) : undefined
        ));

        const encoding = node.encoding
            ? this.typeFactory.createIntegerTypeFromString(node.encoding, node)
            : undefined;

        return this.typeFactory.createEnumType(cases, encoding, node);
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
        return this.typeFactory.createStringEnumType(node.cases, node);
    }

    private inferInterfaceType(node: ast.InterfaceType): TypeDescription {
        const methods = node.methods.map(m => this.inferMethodHeader(m));
        const superTypes = node.superTypes?.map(t => this.getType(t)) ?? [];
        return this.typeFactory.createInterfaceType(methods, superTypes, node);
    }

    private inferClassType(node: ast.ClassType): TypeDescription {
        // Check if we're already inferring this class (to handle methods that reference `this`)
        if (this.inferringClasses.has(node)) {
            // Return a partial class type with attributes and stub methods
            // This allows `this` expressions to get the class type without infinite recursion
            // Stub methods have void return types to break cycles
            const attributes = node.attributes?.map(attrDecl =>
                this.typeFactory.createAttributeType(
                    attrDecl.name,
                    this.getType(attrDecl.type),
                    attrDecl.isStatic ?? false,
                    attrDecl.isConst ?? false,
                    attrDecl.isLocal ?? false
                )
            ) ?? [];

            // Create stub methods to allow method-to-method calls during inference
            // Use explicit return types when available, void as placeholder otherwise
            const stubMethods = node.methods?.map(m => {
                const methodHeader = m.method;
                const genericParams = (methodHeader.genericParameters?.map(g => this.inferGenericType(g)).filter((g): g is GenericTypeDescription => isGenericType(g)) ?? []);
                const params = methodHeader.header?.args?.map(arg => this.typeFactory.createFunctionParameterType(
                    arg.name,
                    this.getType(arg.type),
                    arg.isMut
                )) ?? [];

                // If method has explicit return type, use it for better accuracy
                // Otherwise use void as placeholder to break cycles
                const returnType = methodHeader.header?.returnType
                    ? this.getType(methodHeader.header.returnType)
                    : this.typeFactory.createVoidType(m);

                return {
                    names: methodHeader.names,
                    parameters: params,
                    returnType: returnType,
                    node: methodHeader,
                    genericParameters: genericParams,
                    isStatic: m.isStatic ?? false,
                    isOverride: m.isOverride ?? false,
                    isLocal: m.isLocal ?? false
                };
            }) ?? [];

            const superTypes = node.superTypes?.map(t => this.getType(t)) ?? [];
            const implementations = node.implementations?.map(impl => this.getType(impl.type)) ?? [];

            // Return class with stub methods to break recursion
            // Note: During recursion, we don't filter shadowed impl methods for simplicity
            return this.typeFactory.createClassType(attributes, stubMethods, superTypes, implementations, node);
        }

        // Mark this class as being inferred
        this.inferringClasses.add(node);

        try {
            // node.attributes is directly an Array<ClassAttributeDecl>
            const attributes = node.attributes?.map(attrDecl =>
                this.typeFactory.createAttributeType(
                    attrDecl.name,
                    this.getType(attrDecl.type),
                    attrDecl.isStatic ?? false,
                    attrDecl.isConst ?? false,
                    attrDecl.isLocal ?? false
                )
            ) ?? [];

            // Infer class-defined methods (these can override impl methods)
            const methods = node.methods?.map(m => {
                const methodHeader = m.method;
                const genericParams = (methodHeader.genericParameters?.map(g => this.inferGenericType(g)).filter((g): g is GenericTypeDescription => isGenericType(g)) ?? []);
                const params = methodHeader.header?.args?.map(arg => this.typeFactory.createFunctionParameterType(
                    arg.name,
                    this.getType(arg.type),
                    arg.isMut
                )) ?? [];

                // Check if we're already inferring this method (cycle detection)
                // This prevents infinite recursion when method body accesses class members
                if (this.inferringMethods.has(m)) {
                    // Return a placeholder method with void return type to break the cycle
                    // The actual return type will be inferred later if needed
                    return {
                        names: methodHeader.names,
                        parameters: params,
                        returnType: this.typeFactory.createVoidType(m),
                        node: methodHeader,
                        genericParameters: genericParams,
                        isStatic: m.isStatic ?? false,
                        isOverride: m.isOverride ?? false,
                        isLocal: m.isLocal ?? false
                    };
                }

                // Mark this method as being inferred
                this.inferringMethods.set(m, node);

                try {
                    // Infer return type - check if explicit, otherwise infer from body/expression
                    let returnType: TypeDescription;
                    if (methodHeader.header?.returnType) {
                        // Explicit return type provided
                        returnType = this.getType(methodHeader.header.returnType);
                    } else {
                        // Infer return type from method body or expression
                        if (m.expr) {
                            // Expression-body method: fn foo() = expr
                            returnType = this.getType(m.expr);
                        } else if (m.body) {
                            // Block-body method: fn foo() { ... }
                            returnType = this.inferReturnTypeFromBody(m.body);
                        } else {
                            // No body or expression (abstract method or interface method)
                            returnType = this.typeFactory.createVoidType(m);
                        }
                    }

                    return {
                        names: methodHeader.names,
                        parameters: params,
                        returnType: returnType,
                        node: methodHeader,
                        genericParameters: genericParams,
                        isStatic: m.isStatic ?? false,
                        isOverride: m.isOverride ?? false,
                        isLocal: m.isLocal ?? false
                    };
                } finally {
                    // Always remove from the set, even if inference fails
                    this.inferringMethods.delete(m);
                }
            }) ?? [];

            const superTypes = node.superTypes?.map(t => this.getType(t)) ?? [];
            const implementations = node.implementations?.map(impl => this.getType(impl.type)) ?? [];

            // Note: We don't add impl methods to the class type here because they're accessed
            // separately through the implementations array. The type utils and other code
            // that needs all methods (including impl) should iterate through implementations.
            return this.typeFactory.createClassType(attributes, methods, superTypes, implementations, node);
        } finally {
            // Always remove from the set, even if inference fails
            this.inferringClasses.delete(node);
        }
    }

    private inferImplementationType(node: ast.ImplementationType): TypeDescription {
        // Check if we're already inferring this implementation type (to handle methods that reference `this`)
        if (this.inferringImplementations.has(node)) {
            // Return a partial implementation type with attributes and stub methods
            // This allows `this` expressions to get the impl type without infinite recursion
            // Stub methods have void return types to break cycles
            const attributes = node.attributes?.map(attrDecl =>
                this.typeFactory.createAttributeType(
                    attrDecl.name,
                    this.getType(attrDecl.type),
                    attrDecl.isStatic ?? false,
                    attrDecl.isConst ?? false,
                    false
                )
            ) ?? [];

            // Create stub methods to allow method-to-method calls during inference
            // Use explicit return types when available, void as placeholder otherwise
            const stubMethods = node.methods?.map(m => {
                const methodHeader = m.method;
                const genericParams = (methodHeader.genericParameters?.map(g => this.inferGenericType(g)).filter((g): g is GenericTypeDescription => isGenericType(g)) ?? []);
                const params = methodHeader.header?.args?.map(arg => this.typeFactory.createFunctionParameterType(
                    arg.name,
                    this.getType(arg.type),
                    arg.isMut
                )) ?? [];

                // If method has explicit return type, use it for better accuracy
                // Otherwise use void as placeholder to break cycles
                const returnType = methodHeader.header?.returnType
                    ? this.getType(methodHeader.header.returnType)
                    : this.typeFactory.createVoidType(m);

                return {
                    names: methodHeader.names,
                    parameters: params,
                    returnType: returnType,
                    node: methodHeader,
                    genericParameters: genericParams,
                    isStatic: m.isStatic ?? false,
                    isOverride: false,
                    isLocal: false
                };
            }) ?? [];

            const targetTypes = node.superTypes ? node.superTypes.map(st => this.getType(st)) : [];

            // Return impl type with stub methods to break recursion
            return this.typeFactory.createImplementationType(attributes, stubMethods, targetTypes, node);
        }

        // Mark this implementation type as being inferred
        this.inferringImplementations.add(node);

        try {
            const attributes = node.attributes?.map(attrDecl =>
                this.typeFactory.createAttributeType(
                    attrDecl.name,
                    this.getType(attrDecl.type),
                    attrDecl.isStatic ?? false,
                    attrDecl.isConst ?? false,
                    false
                )
            ) ?? [];

            // Infer impl methods (with body/expression inference support)
            const methods = node.methods?.map(m => {
                const methodHeader = m.method;
                const genericParams = (methodHeader.genericParameters?.map(g => this.inferGenericType(g)).filter((g): g is GenericTypeDescription => isGenericType(g)) ?? []);
                const params = methodHeader.header?.args?.map(arg => this.typeFactory.createFunctionParameterType(
                    arg.name,
                    this.getType(arg.type),
                    arg.isMut
                )) ?? [];

                // Check if we're already inferring this method (cycle detection)
                // This prevents infinite recursion when method body accesses impl members
                if (this.inferringImplMethods.has(m)) {
                    // Return a placeholder method with void return type to break the cycle
                    // The actual return type will be inferred later if needed
                    return {
                        names: methodHeader.names,
                        parameters: params,
                        returnType: this.typeFactory.createVoidType(m),
                        node: methodHeader,
                        genericParameters: genericParams,
                        isStatic: m.isStatic ?? false,
                        isOverride: false,
                        isLocal: false
                    };
                }

                // Mark this method as being inferred
                this.inferringImplMethods.set(m, node);

                try {
                    // Infer return type - check if explicit, otherwise infer from body/expression
                    let returnType: TypeDescription;
                    if (methodHeader.header?.returnType) {
                        // Explicit return type provided
                        returnType = this.getType(methodHeader.header.returnType);
                    } else {
                        // Infer return type from method body or expression
                        if (m.expr) {
                            // Expression-body method: fn foo() = expr
                            returnType = this.getType(m.expr);
                        } else if (m.body) {
                            // Block-body method: fn foo() { ... }
                            returnType = this.inferReturnTypeFromBody(m.body);
                        } else {
                            // No body or expression (should not happen in impl, but handle it)
                            returnType = this.typeFactory.createVoidType(m);
                        }
                    }

                    return {
                        names: methodHeader.names,
                        parameters: params,
                        returnType: returnType,
                        node: methodHeader,
                        genericParameters: genericParams,
                        isStatic: m.isStatic ?? false,
                        isOverride: false,
                        isLocal: false
                    };
                } finally {
                    // Always remove from the set, even if inference fails
                    this.inferringImplMethods.delete(m);
                }
            }) ?? [];

            const targetTypes = node.superTypes ? node.superTypes.map(st => this.getType(st)) : [];

            return this.typeFactory.createImplementationType(attributes, methods, targetTypes, node);
        } finally {
            // Always remove from the set, even if inference fails
            this.inferringImplementations.delete(node);
        }
    }

    private inferMethodHeader(node: ast.MethodHeader): MethodType {
        const genericParams = (node.genericParameters?.map(g => this.inferGenericType(g)).filter((g): g is GenericTypeDescription => isGenericType(g)) ?? []);
        const params = node.header?.args?.map(arg => this.typeFactory.createFunctionParameterType(
            arg.name,
            this.getType(arg.type),
            arg.isMut
        )) ?? [];
        const returnType = node.header?.returnType
            ? this.getType(node.header.returnType)
            : this.typeFactory.createVoidType(node);

        return this.typeFactory.createMethodType(
            node.names,
            params,
            returnType,
            node,
            genericParams
        );
    }

    /**
     * Infers the type of a class method with body/expression inference support.
     *
     * Similar to function declaration inference, but for class methods.
     * If the method has an explicit return type annotation, use it.
     * Otherwise, infer from the method body or expression.
     */
    private inferClassMethod(node: ast.ClassMethod): TypeDescription {
        const methodHeader = node.method;
        const genericParams = (methodHeader.genericParameters?.map(g => this.inferGenericType(g)).filter((g): g is GenericTypeDescription => isGenericType(g)) ?? []);
        const params = methodHeader.header?.args?.map(arg => this.typeFactory.createFunctionParameterType(
            arg.name,
            this.getType(arg.type),
            arg.isMut
        )) ?? [];

        // Check if we're already inferring this method (cycle detection)
        // This prevents infinite recursion when method body accesses class members
        const containingClass = AstUtils.getContainerOfType(node, ast.isClassType);
        if (containingClass && this.inferringMethods.has(node)) {
            // Return a placeholder function type with void return type to break the cycle
            return this.typeFactory.createFunctionType(params, this.typeFactory.createVoidType(node), 'fn', genericParams, node);
        }

        // Mark this method as being inferred
        if (containingClass) {
            this.inferringMethods.set(node, containingClass);
        }

        try {
            let returnType: TypeDescription;

            if (methodHeader.header?.returnType) {
                // Explicit return type provided
                returnType = this.getType(methodHeader.header.returnType);
            } else {
                // Infer return type from method body or expression
                // Note: Methods cannot be coroutines directly, but method headers can specify coroutine types

                if (node.expr) {
                    // Expression-body method: fn foo() = expr
                    returnType = this.getType(node.expr);
                } else if (node.body) {
                    // Block-body method: fn foo() { ... }
                    returnType = this.inferReturnTypeFromBody(node.body);
                } else {
                    // No body or expression (abstract method or interface method)
                    returnType = this.typeFactory.createVoidType(node);
                }
            }

            return this.typeFactory.createFunctionType(params, returnType, 'fn', genericParams, node);
        } finally {
            // Always remove from the set, even if inference fails
            this.inferringMethods.delete(node);
        }
    }

    /**
     * Converts a MethodHeader to a FunctionType for type display and checking.
     * This is used when hovering over a method or getting its type for other purposes.
     *
     * **IMPORTANT FIX:**
     * If the MethodHeader is part of a ClassMethod, we need to get the type from the
     * ClassMethod instead, which properly infers return types from method bodies/expressions.
     * Otherwise, direct method calls (without `this.` or `ClassName.`) would get void
     * return types instead of the inferred type.
     */
    private inferMethodHeaderAsType(node: ast.MethodHeader): TypeDescription {
        // Check if this MethodHeader is part of a ClassMethod
        // If so, get the inferred type from the ClassMethod (which includes body inference)
        if (node.$container && ast.isClassMethod(node.$container)) {
            return this.inferClassMethod(node.$container);
        }

        // Otherwise, use the MethodHeader directly (for interfaces, etc.)
        const methodType = this.inferMethodHeader(node);
        return this.typeFactory.createFunctionType(
            methodType.parameters,
            methodType.returnType,
            'fn',
            methodType.genericParameters,
            node
        );
    }

    private inferFunctionType(node: ast.FunctionType): TypeDescription {
        const params = node.header?.args?.map(arg => this.typeFactory.createFunctionParameterType(
            arg?.name ?? '_',
            this.getType(arg.type),
            arg.isMut
        )) ?? [];
        const returnType = node.header?.returnType
            ? this.getType(node.header.returnType)
            : this.typeFactory.createVoidType(node);

        return this.typeFactory.createFunctionType(params, returnType, node.fnType, [], node);
    }

    private inferCoroutineType(node: ast.CoroutineType): TypeDescription {
        const params = node.header?.args?.map(arg => this.typeFactory.createFunctionParameterType(
            arg.name,
            this.getType(arg.type),
            arg.isMut
        )) ?? [];
        // For coroutine type annotations: coroutine<fn(params) -> YieldType>
        // The "returnType" in the header actually represents the yield type
        const yieldType = node.header?.returnType
            ? this.getType(node.header.returnType)
            : this.typeFactory.createVoidType(node);

        return this.typeFactory.createCoroutineType(params, yieldType, node);
    }

    private inferReferenceType(node: ast.ReferenceType): TypeDescription {
        const declaration: AstNode | undefined = node?.field?.ref;
        if (!declaration) {
            return this.typeFactory.createErrorType('Unresolved type reference', undefined, node);
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
            return this.typeFactory.createReferenceType(declaration, genericArgs, node);
        }

        // We could also reference a variant constructor directly
        if (ast.isVariantConstructor(declaration) && node.parent) {
            let baseVariant = this.resolveReference(this.inferReferenceType(node.parent));
            if (isVariantType(baseVariant)) {
                let genericArgs = node.genericArgs?.map(arg => this.getType(arg)) ?? [];
                const variantContainer = baseVariant.node?.$container;
                const typeDecl = variantContainer && ast.isTypeDeclaration(variantContainer) ? variantContainer : undefined;
                return this.typeFactory.createVariantConstructorType(baseVariant, declaration.name, declaration, genericArgs, node, typeDecl);
            }
            return this.typeFactory.createErrorType(
                `Expected variant type`,
                undefined,
                node
            );
        }

        // Handle any other identifiable references that might be types
        const declType = declaration.$type || 'unknown';
        return this.typeFactory.createErrorType(
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

            return this.typeUtils.substituteGenerics(actualType, substitutions);
        }

        return actualType;
    }

    private inferGenericType(node: ast.GenericType): TypeDescription {
        const constraint = node.constraint ? this.getType(node.constraint) : undefined;
        return this.typeFactory.createGenericType(node.name, constraint, node, node);
    }

    private inferFFIDecl(node: ast.ExternFFIDecl): TypeDescription {
        const methods = node.methods?.map(m => {
            const params = m.header.args?.map(arg => this.typeFactory.createFunctionParameterType(
                arg.name,
                this.getType(arg.type),
                arg.isMut
            )) ?? [];
            const returnType = m.header.returnType
                ? this.getType(m.header.returnType)
                : this.typeFactory.createVoidType(m);

            return this.typeFactory.createMethodType([m.name], params, returnType, undefined);
        }) ?? [];

        return this.typeFactory.createFFIType(
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
                const genericParams = (symbol.genericParameters?.map(g => this.inferGenericType(g)).filter((g): g is GenericTypeDescription => isGenericType(g)) ?? []);

                const params = symbol.args.map(arg => this.typeFactory.createFunctionParameterType(
                    arg.name,
                    this.getType(arg.type),
                    arg.isMut
                ));
                const returnType = this.getType(symbol.returnType);

                // Create function type WITH generic parameters from the AST
                const functionType = this.typeFactory.createFunctionType(params, returnType, 'fn', genericParams, symbol);
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
                    type: this.getType(symbol.type),
                    node: symbol
                });
            }
        }

        return this.typeFactory.createPrototypeType(node.name, methods, properties, node);
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
        const genericParams = (node.genericParameters?.map(g => this.inferGenericType(g)).filter((g): g is GenericTypeDescription => isGenericType(g)) ?? []);
        const params = node.header?.args?.map(arg => this.typeFactory.createFunctionParameterType(
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
                return this.typeFactory.createFunctionType(params, returnType, node.fnType, genericParams, node);
            } else {
                // In recursive call - return an error placeholder to break cycle
                // The actual return type will be inferred from non-recursive paths
                // Using error type instead of void so validators ignore it
                return this.typeFactory.createFunctionType(
                    params,
                    this.typeFactory.createErrorType('__recursion_placeholder__', undefined, node),
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

            return this.typeFactory.createFunctionType(params, returnType, node.fnType, genericParams, node);
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
                return this.typeFactory.createVoidType();
            }

            // Get types of all return expressions
            const allReturnTypes = returnStatements
                .map(stmt => stmt.expr ? this.getType(stmt.expr) : this.typeFactory.createVoidType());

            // Filter out recursion placeholders (error types with specific message)
            const nonPlaceholderTypes = allReturnTypes.filter(type => {
                if (isErrorType(type)) {
                    return type.message !== '__recursion_placeholder__';
                }
                return true; // Keep non-error types
            });

            // Use non-placeholder types if available, otherwise all types
            const returnTypes = nonPlaceholderTypes.length > 0 ? nonPlaceholderTypes : allReturnTypes;

            if (returnTypes.length === 0) {
                return this.typeFactory.createVoidType();
            }

            // Find common type
            return this.typeUtils.getCommonType(returnTypes);
        }

        return this.typeFactory.createVoidType();
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
                return this.typeFactory.createVoidType();
            }

            // Get types of all yield expressions
            const allYieldTypes = yieldExpressions
                .map(yieldExpr => yieldExpr.expr ? this.getType(yieldExpr.expr) : this.typeFactory.createVoidType());

            // Filter out recursion placeholders (error types with specific message)
            const nonPlaceholderTypes = allYieldTypes.filter(type => {
                if (isErrorType(type)) {
                    return type.message !== '__recursion_placeholder__';
                }
                return true; // Keep non-error types
            });

            // Use non-placeholder types if available, otherwise all types
            const yieldTypes = nonPlaceholderTypes.length > 0 ? nonPlaceholderTypes : allYieldTypes;

            if (yieldTypes.length === 0) {
                return this.typeFactory.createVoidType();
            }

            // Find common type
            return this.typeUtils.getCommonType(yieldTypes);
        }

        return this.typeFactory.createVoidType();
    }

    /**
     * Collect all return statements from a block, but ONLY from this function level.
     * Does NOT collect returns from nested functions OR do expressions!
     */
    private collectReturnStatements(block: ast.BlockStatement): ast.ReturnStatement[] {
        const returns: ast.ReturnStatement[] = [];

        const visit = (node: AstNode) => {
            // Stop if we hit a nested function - don't collect its returns!
            if (ast.isFunctionDeclaration(node)) {
                return; // Don't traverse into nested functions
            }

            // Stop if we hit a do expression - it has its own return scope
            if (ast.isDoExpression(node)) {
                return; // Don't traverse into do expressions
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
     * Does NOT collect yields from nested coroutines OR do expressions!
     */
    private collectYieldExpressions(block: ast.BlockStatement): ast.YieldExpression[] {
        const yields: ast.YieldExpression[] = [];

        const visit = (node: AstNode) => {
            // Stop if we hit a nested function/coroutine - don't collect its yields!
            if (ast.isFunctionDeclaration(node)) {
                return; // Don't traverse into nested functions
            }

            // Stop if we hit a do expression - it has its own scope
            if (ast.isDoExpression(node)) {
                return; // Don't traverse into do expressions
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
            return this.typeFactory.createErrorType('Variable has no type annotation or initializer', undefined, node);
        }

        // Check if variable is marked as nullable with the `?` suffix
        // Example: let arr? = new Array<u32>(10) → Array<u32>?
        if (ast.isVariableDeclSingle(node) && node.isNullable) {
            return this.typeFactory.createNullableType(inferredType, node);
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
            expectedType = expectedType ? this.typeUtils.resolveIfReference(expectedType) : expectedType;

            // If expected type is a string enum, keep as literal for validation
            if (expectedType && isStringEnumType(expectedType)) {
                return this.typeFactory.createStringLiteralType(stringValue, node);
            }

            // Otherwise, widen to string type (for better compatibility with generic inference)
            // This includes: expected type is string, expected type is generic, or no expected type
            return this.typeFactory.createStringType(node);
        }
        if (ast.isBinaryStringLiteralExpression(node)) {
            return this.typeFactory.createArrayType(this.typeFactory.createU8Type(node), node);
        }
        if (ast.isTrueBooleanLiteral(node) || ast.isFalseBooleanLiteral(node)) {
            return this.typeFactory.createBoolType(node);
        }
        if (ast.isNullLiteralExpression(node)) return this.typeFactory.createNullType(node);


        // Operations
        if (ast.isBinaryExpression(node)) return this.inferBinaryExpression(node);
        if (ast.isUnaryExpression(node)) return this.inferUnaryExpression(node);

        // Member access
        if (ast.isMemberAccess(node)) return this.inferMemberAccess(node);
        if (ast.isFunctionCall(node)) return this.inferFunctionCall(node);
        if (ast.isIndexAccess(node)) return this.inferIndexAccess(node);
        if (ast.isIndexSet(node)) return this.inferIndexSet(node);
        if (ast.isReverseIndexAccess(node)) return this.inferReverseIndexAccess(node);
        if (ast.isReverseIndexSet(node)) return this.inferReverseIndexSet(node);
        if (ast.isPostfixOp(node)) return this.inferPostfixOp(node);
        if (ast.isObjectUpdate(node)) return this.inferObjectUpdate(node);

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
        if (ast.isInstanceCheckExpression(node)) return this.typeFactory.createBoolType(node);

        // Special
        if (ast.isThisExpression(node)) return this.inferThisExpression(node);
        if (ast.isThrowExpression(node)) return this.typeFactory.createNeverType(node);
        if (ast.isUnreachableExpression(node)) return this.typeFactory.createNeverType(node);
        if (ast.isYieldExpression(node)) return this.inferYieldExpression(node);
        if (ast.isCoroutineExpression(node)) return this.inferCoroutineExpression(node);
        if (ast.isDenullExpression(node)) return this.inferDenullExpression(node);
        if (ast.isTupleExpression(node)) return this.inferTupleExpression(node);
        if (ast.isWildcardExpression(node)) return this.typeFactory.createAnyType(node);
        if (ast.isDestructuringElement(node)) return this.inferDestructuringElement(node);

        if (node == undefined) {
            console.log("undefined node")
        }
        return this.typeFactory.createErrorType(`Cannot infer type for expression: ${node.$type}`, undefined, node);
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
            return this.typeFactory.createIntegerTypeFromString(typeStr, node)
                ?? this.typeFactory.createI32Type(node);
        }

        // Try to use contextual typing
        let expectedType = this.getExpectedType(node);
        // Resolve reference types (e.g., type aliases like `type int = u32`)
        if (expectedType && isReferenceType(expectedType)) {
            expectedType = this.resolveReference(expectedType);
        }
        if (expectedType && this.isIntegerType(expectedType)) {
            // Use the expected integer type
            return expectedType;
        }

        // Default to i32 for decimal literals without suffix
        return this.typeFactory.createI32Type(node);
    }

    /**
     * Check if a type is an integer type (not float).
     * Note: This expects a resolved type (not a ReferenceType).
     */
    private isIntegerType(type: TypeDescription): boolean {
        const integerKinds = [
            TypeKind.U8, TypeKind.U16, TypeKind.U32, TypeKind.U64,
            TypeKind.I8, TypeKind.I16, TypeKind.I32, TypeKind.I64
        ];
        return integerKinds.includes(type.kind);
    }

    /**
     * Check if a type is a float type (f32 or f64).
     * Note: This expects a resolved type (not a ReferenceType).
     */
    private isFloatType(type: TypeDescription): boolean {
        return type.kind === TypeKind.F32 || type.kind === TypeKind.F64;
    }

    /**
     * Infer the type of a floating-point literal.
     *
     * Uses contextual typing when available:
     * - `let x: f32 = 3.14` → infers 3.14 as f32
     * - `let x: f64 = 3.14` → infers 3.14 as f64
     * - `let x = 3.14` → defaults to f64
     * - Explicit suffix overrides context: `3.14f` → always f32
     */
    private inferFloatLiteral(node: ast.FloatingPointLiteral): TypeDescription {
        // If there's an explicit 'f' suffix, it's f32
        if (ast.isFloatLiteral(node)) {
            return this.typeFactory.createF32Type(node);
        }

        // Try to use contextual typing
        let expectedType = this.getExpectedType(node);
        // Resolve reference types (e.g., type aliases like `type float = f32`)
        if (expectedType && isReferenceType(expectedType)) {
            expectedType = this.resolveReference(expectedType);
        }
        if (expectedType && this.isFloatType(expectedType)) {
            // Use the expected float type (f32 or f64)
            return expectedType;
        }

        // Default to f64 (double precision)
        return this.typeFactory.createF64Type(node);
    }

    private inferQualifiedReference(node: ast.QualifiedReference): TypeDescription {
        // Langium cross-references have a .ref property pointing to the target AST node
        const ref = node.reference;
        if (!ref || !('ref' in ref) || !ref.ref) {
            return this.typeFactory.createErrorType('Unresolved reference', undefined, node);
        }

        const refNode = ref.ref;
        if (!refNode) {
            return this.typeFactory.createErrorType('Invalid reference node', undefined, node);
        }
        let type = this.getType(refNode);
        const originalType = type;
        if (isReferenceType(type)) {
            type = this.resolveReference(type);
        }

        // Handle generic instantiation: fn<T>(...) -> ... becomes fn<u32>(...) -> ...
        // When we have genericArgs on the QualifiedReference (e.g., isArrayOf<u32>)
        if (node.genericArgs && node.genericArgs.length > 0) {
            // Only function types can be generically instantiated in this context
            if (isFunctionType(type)) {
                const genericParams = type.genericParameters || [];

                if (genericParams.length !== node.genericArgs.length) {
                    return this.typeFactory.createErrorType(
                        `Generic argument count mismatch: expected ${genericParams.length}, got ${node.genericArgs.length}`,
                        undefined,
                        node
                    );
                }

                // Build substitution map and validate constraints
                const substitutions = new Map<string, TypeDescription>();
                
                for (let index = 0; index < genericParams.length; index++) {
                    const param = genericParams[index];
                    const concreteType = this.getType(node.genericArgs[index]);
                    
                    // Validate that the concrete type satisfies the generic parameter's constraint
                    const constraintCheck = this.typeUtils.validateGenericConstraint(concreteType, param.constraint);
                    if (!constraintCheck.success) {
                        return this.typeFactory.createErrorType(
                            constraintCheck.message || `Type argument does not satisfy generic constraint`,
                            undefined,
                            node
                        );
                    }
                    
                    substitutions.set(param.name, concreteType);
                }

                // Apply substitutions to the function type
                return this.typeUtils.substituteGenerics(type, substitutions);
            }

            // If not a function type, having generic args is an error
            return this.typeFactory.createErrorType(
                `Cannot apply generic arguments to non-generic type '${type.toString()}'`,
                undefined,
                node
            );
        }

        if (isVariantType(type) && ast.isTypeDeclaration(node.reference.ref)) {
            // Generics are pushed to the constuctor i.e Option.Some<T>
            return this.typeFactory.createMetaVariantType(type, [], node);
        }

        if (isEnumType(type) && ast.isTypeDeclaration(node.reference.ref)) {
            return this.typeFactory.createMetaEnumType(type, node);
        }

        if (isClassType(type) && ast.isTypeDeclaration(node.reference.ref)) {
            return this.typeFactory.createMetaClassType(type, node);
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
            return this.typeFactory.createBoolType(node);
        }

        // Logical operators
        if (['&&', '||'].includes(node.op)) {
            return this.typeFactory.createBoolType(node);
        }

        // Null coalescing
        if (node.op === '??') {
            // The result type is the RHS type
            // - T? ?? U → U
            // - T? ?? U? → U?
            // - T ?? U → U (but LHS is always returned if not null, so result is effectively T)
            // For non-nullable LHS, the RHS is never evaluated at runtime, but we still use RHS type
            // This allows: string ?? string? → string?
            return right;
        }

        // Check for operator overloads on classes/interfaces
        // Only classes and interfaces can have operator overloads
        const operatorOverload = this.resolveOperatorOverload(left, node.op, [right], node);
        if (operatorOverload) {
            return operatorOverload;
        }

        // Arithmetic operators - use left operand's type (simplified)
        // In a full implementation, this would have proper type promotion rules
        return left;
    }

    private inferUnaryExpression(node: ast.UnaryExpression): TypeDescription {
        const exprType = this.inferExpression(node.expr);

        if (node.op === '!') {
            return this.typeFactory.createBoolType(node);
        }

        // Check for operator overloads on classes/interfaces BEFORE checking for errors
        const operatorOverload = this.resolveOperatorOverload(exprType, node.op, [], node);
        if (operatorOverload) {
            return operatorOverload;
        }

        // Check if unary minus is being applied to unsigned integer type
        if (node.op === '-') {
            // Resolve reference types to get the actual type
            const resolvedType = this.typeUtils.resolveIfReference(exprType);

            // Check if it's an unsigned integer type (u8, u16, u32, u64)
            // Use the type guard properly to narrow the type
            if (isIntegerType(resolvedType)) {
                if (!resolvedType.signed) {
                    return this.typeFactory.createErrorType(
                        `Cannot apply unary minus to unsigned type '${resolvedType.toString()}'. Use explicit cast to signed type if negation is intended: -(x as i${resolvedType.bits})`,
                        undefined,
                        node
                    );
                }
            }
        }

        // Other unary operators preserve the type
        return exprType;
    }

    /**
     * Resolves operator overloads for binary and unary expressions.
     *
     * **How it works:**
     * 1. Check if the LHS (left-hand side) type is a class or interface
     * 2. Find all methods with the operator name (e.g., '+', '-', '[]')
     * 3. Use the same resolution mechanism as function calls to find the best match
     * 4. Return the return type of the selected method
     *
     * **Example:**
     * ```
     * class Vector {
     *     fn +(other: Vector) -> Vector { ... }
     *     fn +(scalar: f32) -> Vector { ... }
     * }
     *
     * let v1: Vector = ...
     * let v2: Vector = ...
     * v1 + v2  // Resolves to Vector.+(Vector) -> Vector
     * v1 + 2.0 // Resolves to Vector.+(f32) -> Vector
     * ```
     *
     * @param lhsType Type of the left-hand side operand (or the only operand for unary)
     * @param operator The operator string (e.g., '+', '-', '!', '[]')
     * @param rhsTypes Array of right-hand side operand types (empty for unary operators)
     * @param node The expression node (for error reporting)
     * @returns The return type if an overload is found, undefined otherwise
     */
    private resolveOperatorOverload(
        lhsType: TypeDescription,
        operator: string,
        rhsTypes: TypeDescription[],
        node: AstNode
    ): TypeDescription | undefined {
        // Resolve reference types first
        let resolvedLhs = this.typeUtils.resolveIfReference(lhsType);

        // Unwrap nullable types
        if (isNullableType(resolvedLhs)) {
            resolvedLhs = resolvedLhs.baseType;
        }

        // CRITICAL: Handle generic types with constraints for operator overloads
        // If LHS is a generic type parameter (e.g., T in fn<T: Addable>),
        // use its constraint for operator overload resolution
        // Example: T: Addable where Addable has fn +(other: Addable) -> Addable
        resolvedLhs = this.typeUtils.resolveIfGeneric(resolvedLhs);

        // Keep track of generic substitutions if we have a reference type with concrete args
        let genericSubstitutions: Map<string, TypeDescription> | undefined;
        if (isReferenceType(lhsType)) {
            genericSubstitutions = this.buildGenericSubstitutions(lhsType);
        }

        // Check if it's a class or interface type (only these can have operator overloads)
        const classType = isClassType(resolvedLhs) ? resolvedLhs : undefined;
        const interfaceType = this.typeUtils.asInterfaceType(resolvedLhs);

        if (!classType && !interfaceType) {
            // Not a class or interface, no operator overload possible
            return undefined;
        }

        // Collect all methods with the operator name
        const methods: MethodType[] = [];

        if (classType) {
            for (const method of classType.methods) {
                if (method.names.includes(operator)) {
                    methods.push(method);
                }
            }
        }

        if (interfaceType) {
            for (const method of interfaceType.methods) {
                if (method.names.includes(operator)) {
                    methods.push(method);
                }
            }
        }

        if (methods.length === 0) {
            // No operator overload found
            return undefined;
        }

        // Use the same resolution logic as function calls
        // Filter by argument count first
        const argBasedCandidates = methods.filter(method => method.parameters.length === rhsTypes.length);

        if (argBasedCandidates.length === 0) {
            return undefined;
        }

        if (argBasedCandidates.length === 1) {
            const selectedMethod = argBasedCandidates[0];
            let returnType = selectedMethod.returnType;

            // Apply generic substitutions if we have them
            if (genericSubstitutions && genericSubstitutions.size > 0) {
                returnType = this.typeUtils.substituteGenerics(returnType, genericSubstitutions);
            }

            return returnType;
        }

        // Multiple candidates - find best match
        // First try exact match
        for (const method of argBasedCandidates) {
            if (method.parameters.every((param, index) => this.typeUtils.areTypesEqual(rhsTypes[index], param.type).success)) {
                let returnType = method.returnType;

                // Apply generic substitutions if we have them
                if (genericSubstitutions && genericSubstitutions.size > 0) {
                    returnType = this.typeUtils.substituteGenerics(returnType, genericSubstitutions);
                }

                return returnType;
            }
        }

        // Then try assignable match
        for (const method of argBasedCandidates) {
            if (method.parameters.every((param, index) => this.typeUtils.isAssignable(rhsTypes[index], param.type).success)) {
                let returnType = method.returnType;

                // Apply generic substitutions if we have them
                if (genericSubstitutions && genericSubstitutions.size > 0) {
                    returnType = this.typeUtils.substituteGenerics(returnType, genericSubstitutions);
                }

                return returnType;
            }
        }

        // No matching overload found
        return undefined;
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

        // Track if the base is nullable (for optional chaining propagation)
        // In TypeScript, a?.b.c.e means all accesses after a?. are nullable
        let baseIsNullable = false;

        // If base type is nullable, unwrap it for member lookup
        if (isNullableType(baseType)) {
            baseIsNullable = true;
            // arr?: Array<u32> with arr?.member → unwrap to Array<u32>
            // arr?: Array<u32> with arr.member → auto-unwrap (should be validation error)
            baseType = baseType.baseType;
        }

        // CRITICAL: Handle generic types with constraints
        // If base type is a generic type parameter (e.g., T in fn<T: ComparableObject>),
        // use its constraint for member access resolution
        // Example: T: ComparableObject → T.eq() resolves to ComparableObject.eq()
        baseType = this.typeUtils.resolveIfGeneric(baseType);

        // Keep track of generic substitutions if we have a reference type with concrete args
        let genericSubstitutions: Map<string, TypeDescription> | undefined;

        // CRITICAL FIX: Check if reference type points to a class or impl being inferred BEFORE resolving
        // This prevents triggering full inference of nested classes/impls during member access
        if (isReferenceType(baseType)) {
            const refDecl = baseType.declaration;
            
            // Check if this reference points to a class currently being inferred
            if (refDecl && ast.isTypeDeclaration(refDecl) && ast.isClassType(refDecl.definition)) {
                const targetClassNode = refDecl.definition;
                if (this.inferringClasses.has(targetClassNode)) {
                    // The referenced class is currently being inferred
                    // Get its partial type directly from the cache (which includes stub methods)
                    const partialClassType = this.getType(targetClassNode);
                    if (isClassType(partialClassType)) {
                        // Build generic substitutions for the partial type
                        genericSubstitutions = this.buildGenericSubstitutions(baseType);

                        // Apply substitutions to the partial class type
                        if (genericSubstitutions && genericSubstitutions.size > 0) {
                            baseType = this.typeUtils.substituteGenerics(partialClassType, genericSubstitutions);
                        } else {
                            baseType = partialClassType;
                        }

                        // Now continue with member lookup on the partial type
                        // This will use the stub methods, preventing the cycle
                    }
                } else {
                    // Normal case: resolve the reference fully
                    const refType = baseType;
                    genericSubstitutions = this.buildGenericSubstitutions(refType);
                    baseType = this.resolveAndSubstituteReference(refType);
                }
            }
            // Check if this reference points to an implementation type currently being inferred
            else if (refDecl && ast.isTypeDeclaration(refDecl) && ast.isImplementationType(refDecl.definition)) {
                const targetImplNode = refDecl.definition;
                if (this.inferringImplementations.has(targetImplNode)) {
                    // The referenced implementation type is currently being inferred
                    // Get its partial type directly from the cache (which includes stub methods)
                    const partialImplType = this.getType(targetImplNode);
                    if (isImplementationType(partialImplType)) {
                        // Build generic substitutions for the partial type
                        genericSubstitutions = this.buildGenericSubstitutions(baseType);

                        // Apply substitutions to the partial impl type
                        if (genericSubstitutions && genericSubstitutions.size > 0) {
                            baseType = this.typeUtils.substituteGenerics(partialImplType, genericSubstitutions);
                        } else {
                            baseType = partialImplType;
                        }

                        // Now continue with member lookup on the partial type
                        // This will use the stub methods, preventing the cycle
                    }
                } else {
                    // Normal case: resolve the reference fully
                    const refType = baseType;
                    genericSubstitutions = this.buildGenericSubstitutions(refType);
                    baseType = this.resolveAndSubstituteReference(refType);
                }
            }
            else {
                // Not a class or impl reference - resolve normally
                const refType = baseType;
                genericSubstitutions = this.buildGenericSubstitutions(refType);
                baseType = this.resolveAndSubstituteReference(refType);
            }
        }

        // If base type is a variant constructor type (e.g., Option<u32>.Some), extract generic substitutions
        if (isVariantConstructorType(baseType)) {
            const constructorType = baseType;
            // Create a temporary reference type to use the helper method
            if (constructorType.variantDeclaration && constructorType.genericArgs.length > 0) {
                const tempRef = this.typeFactory.createReferenceType(
                    constructorType.variantDeclaration,
                    constructorType.genericArgs,
                    constructorType.node
                );
                genericSubstitutions = this.buildGenericSubstitutions(tempRef);
            }
        }

        // Variable to hold the resolved member type
        let memberType: TypeDescription | undefined;

        // CRITICAL FIX: Resolve from type when we're inferring METHOD bodies
        // This prevents Langium's linker cycle detection when accessing class/impl members
        // during method inference. For normal cases, we use Langium's ref which handles overloads correctly.
        const isInMethodInferenceContext = this.inferringMethods.size > 0 || this.inferringImplMethods.size > 0;

        if (isClassType(baseType) && isInMethodInferenceContext) {
            // We're accessing a member of a class type while inferring ANY class
            // Resolve directly from the type to avoid Langium's cycle detection

            // Check attributes first
            const attribute = baseType.attributes.find(a => a.name === memberName);
            if (attribute) {
                memberType = attribute.type;
                // Apply generic substitutions if we have them
                if (genericSubstitutions && genericSubstitutions.size > 0) {
                    memberType = this.typeUtils.substituteGenerics(memberType, genericSubstitutions);
                }
                // Wrap in nullable if using optional chaining
                // BUT: Don't wrap basic types - they can't be nullable
                if (node.isNullable || baseIsNullable) {
                    if (!this.typeUtils.isTypeBasic(memberType)) {
                        memberType = this.typeFactory.createNullableType(memberType, node);
                    }
                }
                return memberType;
            }

            // Check methods - note: may return stub methods during inference
            const method = baseType.methods.find(m => m.names.includes(memberName));
            if (method) {
                // Convert method to function type
                memberType = this.typeFactory.createFunctionType(
                    method.parameters,
                    method.returnType,
                    'fn',
                    method.genericParameters,
                    method.node
                );
                // Apply generic substitutions if we have them
                if (genericSubstitutions && genericSubstitutions.size > 0) {
                    memberType = this.typeUtils.substituteGenerics(memberType, genericSubstitutions);
                }
                // Wrap in nullable if using optional chaining
                // BUT: Don't wrap basic types - they can't be nullable
                if (node.isNullable || baseIsNullable) {
                    if (!this.typeUtils.isTypeBasic(memberType)) {
                        memberType = this.typeFactory.createNullableType(memberType, node);
                    }
                }
                return memberType;
            }

            // Member not found in the class type
            return this.typeFactory.createErrorType(`Member '${memberName}' not found`, undefined, node);
        }

        // Handle implementation types during method inference
        if (isImplementationType(baseType) && isInMethodInferenceContext) {
            // We're accessing a member of an impl type while inferring ANY impl
            // Resolve directly from the type to avoid Langium's cycle detection

            // Check attributes first
            const attribute = baseType.attributes.find(a => a.name === memberName);
            if (attribute) {
                memberType = attribute.type;
                // Apply generic substitutions if we have them
                if (genericSubstitutions && genericSubstitutions.size > 0) {
                    memberType = this.typeUtils.substituteGenerics(memberType, genericSubstitutions);
                }
                // Wrap in nullable if using optional chaining
                // BUT: Don't wrap basic types - they can't be nullable
                if (node.isNullable || baseIsNullable) {
                    if (!this.typeUtils.isTypeBasic(memberType)) {
                        memberType = this.typeFactory.createNullableType(memberType, node);
                    }
                }
                return memberType;
            }

            // Check methods - note: may return stub methods during inference
            const method = baseType.methods.find(m => m.names.includes(memberName));
            if (method) {
                // Convert method to function type
                memberType = this.typeFactory.createFunctionType(
                    method.parameters,
                    method.returnType,
                    'fn',
                    method.genericParameters,
                    method.node
                );
                // Apply generic substitutions if we have them
                if (genericSubstitutions && genericSubstitutions.size > 0) {
                    memberType = this.typeUtils.substituteGenerics(memberType, genericSubstitutions);
                }
                // Wrap in nullable if using optional chaining
                // BUT: Don't wrap basic types - they can't be nullable
                if (node.isNullable || baseIsNullable) {
                    if (!this.typeUtils.isTypeBasic(memberType)) {
                        memberType = this.typeFactory.createNullableType(memberType, node);
                    }
                }
                return memberType;
            }

            // Check interface methods from target types
            // When an impl extends an interface, interface methods should be accessible
            // unless they're shadowed by impl methods with the same signature
            for (const targetType of baseType.targetTypes) {
                // Resolve reference types first - use provider's resolveReference for consistency
                let resolvedTargetType = targetType;
                if (isReferenceType(targetType)) {
                    resolvedTargetType = this.resolveReference(targetType);
                }
                const interfaceType = this.typeUtils.asInterfaceType(resolvedTargetType);
                
                if (interfaceType) {
                    // Find the method in the interface
                    const interfaceMethod = interfaceType.methods.find(m => m.names.includes(memberName));
                    if (interfaceMethod) {
                        // Check if this interface method is shadowed by an impl method
                        const isShadowed = this.isInterfaceMethodShadowedByImpl(
                            interfaceMethod,
                            baseType.methods
                        );
                        
                        if (!isShadowed) {
                            // Convert interface method to function type
                            memberType = this.typeFactory.createFunctionType(
                                interfaceMethod.parameters,
                                interfaceMethod.returnType,
                                'fn',
                                interfaceMethod.genericParameters,
                                interfaceMethod.node
                            );
                            // Apply generic substitutions if we have them
                            if (genericSubstitutions && genericSubstitutions.size > 0) {
                                memberType = this.typeUtils.substituteGenerics(memberType, genericSubstitutions);
                            }
                            // Wrap in nullable if using optional chaining
                            if (node.isNullable || baseIsNullable) {
                                if (!this.typeUtils.isTypeBasic(memberType)) {
                                    memberType = this.typeFactory.createNullableType(memberType, node);
                                }
                            }
                            return memberType;
                        }
                    }
                    
                    // Also check interface supertypes recursively
                    for (const ifaceSuperType of interfaceType.superTypes) {
                        const resolvedSuperType = this.typeUtils.resolveIfReference(ifaceSuperType);
                        const superInterface = this.typeUtils.asInterfaceType(resolvedSuperType);
                        if (superInterface) {
                            const superMethod = superInterface.methods.find(m => m.names.includes(memberName));
                            if (superMethod) {
                                const isShadowed = this.isInterfaceMethodShadowedByImpl(
                                    superMethod,
                                    baseType.methods
                                );
                                
                                if (!isShadowed) {
                                    memberType = this.typeFactory.createFunctionType(
                                        superMethod.parameters,
                                        superMethod.returnType,
                                        'fn',
                                        superMethod.genericParameters,
                                        superMethod.node
                                    );
                                    if (genericSubstitutions && genericSubstitutions.size > 0) {
                                        memberType = this.typeUtils.substituteGenerics(memberType, genericSubstitutions);
                                    }
                                    if (node.isNullable || baseIsNullable) {
                                        if (!this.typeUtils.isTypeBasic(memberType)) {
                                            memberType = this.typeFactory.createNullableType(memberType, node);
                                        }
                                    }
                                    return memberType;
                                }
                            }
                        }
                    }
                }
            }

            // Member not found in the impl type or its interfaces
            return this.typeFactory.createErrorType(`Member '${memberName}' not found`, undefined, node);
        }

        // For impl types (even outside method inference context), check interface methods
        // This handles the case where we access interface methods from impl instances
        if (isImplementationType(baseType)) {
            for (const targetType of baseType.targetTypes) {
                // Resolve reference types first
                let resolvedTargetType = targetType;
                if (isReferenceType(targetType)) {
                    resolvedTargetType = this.resolveReference(targetType);
                }
                const interfaceType = this.typeUtils.asInterfaceType(resolvedTargetType);
                
                if (interfaceType) {
                    // Find the method in the interface
                    const interfaceMethod = interfaceType.methods.find(m => m.names.includes(memberName));
                    if (interfaceMethod) {
                        // Check if this interface method is shadowed by an impl method
                        const isShadowed = this.isInterfaceMethodShadowedByImpl(
                            interfaceMethod,
                            baseType.methods
                        );
                        
                        if (!isShadowed && interfaceMethod.node) {
                            // Use the interface method node
                            const targetRef = interfaceMethod.node;
                            memberType = this.getType(targetRef);
                            
                            // Apply generic substitutions if we have them
                            if (genericSubstitutions && genericSubstitutions.size > 0) {
                                memberType = this.typeUtils.substituteGenerics(memberType, genericSubstitutions);
                            }
                            
                            // Wrap in nullable if using optional chaining
                            if (node.isNullable || baseIsNullable) {
                                if (!this.typeUtils.isTypeBasic(memberType)) {
                                    memberType = this.typeFactory.createNullableType(memberType, node);
                                }
                            }
                            return memberType;
                        }
                    }
                }
            }
        }

        // Normal case: Get the target node via Langium's linker (handles overload resolution)
        const targetRef = node.element.ref;
        if (!targetRef) {
            return this.typeFactory.createErrorType(`Member '${memberName}' not found`, undefined, node);
        }

        /**
         * CRITICAL FIX: Look up interface methods from the substituted type, not the AST.
         *
         * **Why this is needed:**
         * When accessing methods on interfaces with generic supertypes, we must use the
         * already-substituted baseType instead of getting the method from the original AST node.
         * The AST node has the original generic type (e.g., `T`), but the baseType has been
         * substituted with concrete types (e.g., `string`).
         *
         * **Example:**
         * ```
         * type Serializable<T> = interface {
         *     fn serialize() -> T
         * }
         * type Entity = Drawable & Serializable<string>
         * let e: Entity = ...
         * e.serialize()  // Should return `string`, not `T`
         * ```
         *
         * **What happens:**
         * 1. baseType is `JoinType{Drawable, Serializable<string>}` (already substituted)
         * 2. We find `serialize()` method in `Serializable<string>`
         * 3. Method's return type is `string` (substituted), not `T` ✓
         *
         * **Recursive supertype handling:**
         * We also recursively search through interface supertypes, handling cases where
         * supertypes are themselves generic references (e.g., `interface Foo extends Bar<T>`).
         * For each supertype reference, we:
         * 1. Extract its generic arguments
         * 2. Resolve the reference to get the actual interface definition
         * 3. Substitute generics in the resolved interface
         * 4. Search for the method recursively
         */
        const baseInterface = this.typeUtils.asInterfaceType(baseType);
        if (baseInterface && ast.isMethodHeader(targetRef)) {
            // Recursive helper to find methods in interface hierarchy
            const findMethodInInterface = (iface: InterfaceTypeDescription): MethodType | undefined => {
                // First check methods directly defined in this interface
                const method = iface.methods.find((m: MethodType) => m.names.includes(memberName));
                if (method) {
                    return method;
                }

                // Then check supertypes recursively
                for (const superType of iface.superTypes) {
                    // If superType is a ReferenceType with generic args, resolve and substitute
                    // Otherwise, use it as-is
                    const resolvedSuperType = (isReferenceType(superType) && superType.genericArgs.length > 0)
                        ? this.resolveAndSubstituteReference(superType)
                        : superType;

                    // Convert resolved supertype to interface and search recursively
                    const superInterface = this.typeUtils.asInterfaceType(resolvedSuperType);
                    if (superInterface) {
                        const superMethod = findMethodInInterface(superInterface);
                        if (superMethod) {
                            return superMethod;
                        }
                    }
                }
                return undefined;
            };

            const method = findMethodInInterface(baseInterface);
            if (method) {
                // Convert method to function type for return
                // The method already has substituted types (e.g., return type is `string`, not `T`)
                memberType = this.typeFactory.createFunctionType(
                    method.parameters,
                    method.returnType,
                    'fn',
                    method.genericParameters,
                    targetRef
                );
            }
        }

        // If we didn't find it in the interface, fall back to getting from AST
        if (!memberType) {
            let targetType = this.getType(targetRef);

            // Check if this method comes from an impl block and apply impl generic substitutions
            // This handles cases like: impl Default3DImpl<vec3>(pos, scale, rot)
            // where methods should have T substituted with vec3
            if (ast.isClassMethod(targetRef) && isClassType(baseType)) {
                const methodNode = targetRef;
                const implTypeNode = methodNode.$container;
                
                // Check if this method is from an impl block (not directly in a class)
                if (implTypeNode && ast.isImplementationType(implTypeNode)) {
                    const classNode = baseType.node;
                    if (classNode && ast.isClassType(classNode)) {
                        // Find the ClassImplementationMethodDecl that references this impl
                        for (const implDecl of classNode.implementations ?? []) {
                            const implRefType = this.getType(implDecl.type);
                            
                            // Check if this impl reference points to our impl type
                            if (isReferenceType(implRefType)) {
                                const resolvedImplType = this.resolveReference(implRefType);
                                if (isImplementationType(resolvedImplType) && resolvedImplType.node === implTypeNode) {
                                    // Found the matching impl declaration in the class!
                                    // Build substitutions from the impl's generic arguments
                                    const implSubstitutions = this.buildGenericSubstitutions(implRefType);
                                    
                                    // Merge impl substitutions with existing substitutions
                                    if (implSubstitutions && implSubstitutions.size > 0) {
                                        if (!genericSubstitutions) {
                                            genericSubstitutions = implSubstitutions;
                                        } else {
                                            // Merge the maps - impl substitutions take precedence
                                            for (const [key, value] of implSubstitutions) {
                                                genericSubstitutions.set(key, value);
                                            }
                                        }
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            // Apply generic substitutions if we have them (e.g., T -> u32 in Array<u32>)
            if (genericSubstitutions) {
                memberType = this.typeUtils.substituteGenerics(targetType, genericSubstitutions);
            } else {
                memberType = targetType;
            }
        }

        // Post process the member type
        // If the element is a type-decl, we wrap it in a meta type!
        if (ast.isTypeDeclaration(targetRef)) {
            if (isVariantType(memberType)) {
                memberType = this.typeFactory.createMetaVariantType(memberType);
            }
            else if (isVariantConstructorType(memberType)) {
                memberType = this.typeFactory.createMetaVariantConstructorType(memberType, [], targetRef);
            }
            else if (isEnumType(memberType)) {
                memberType = this.typeFactory.createMetaEnumType(memberType, targetRef);
            }
            else if (isClassType(memberType)) {
                memberType = this.typeFactory.createMetaClassType(memberType, targetRef);
            }
        }

        // Wrap in nullable if:
        // 1. Current node uses optional chaining (?.)
        // 2. OR base was nullable (propagate nullability through chain: a?.b.c → c is nullable)
        // BUT: Don't wrap basic types - they can't be nullable
        if (node.isNullable || baseIsNullable) {
            if (!this.typeUtils.isTypeBasic(memberType)) {
                memberType = this.typeFactory.createNullableType(memberType, node);
            }
        }
        return memberType;
    }

    private inferFunctionCall(node: ast.FunctionCall): TypeDescription {
        let fnType = this.inferExpression(node.expr);

        // Resolve reference types first
        fnType = this.typeUtils.resolveIfReference(fnType);

        // Only unwrap nullable function types if they come from optional chaining
        // Check if ANY part of the expression chain uses optional chaining (?.)
        let isOptionalCall = false;
        if (isNullableType(fnType)) {
            // Check if optional chaining was used anywhere in the chain
            // e.g., a?.b.c() should work (a?.b uses ?.)
            const isFromOptionalChaining = this.hasOptionalChaining(node.expr);

            if (isFromOptionalChaining) {
                isOptionalCall = true;
                fnType = fnType.baseType;
            }
            // Otherwise, leave as nullable and it will error below
        }

        // Handle coroutine types - calling a coroutine instance yields its yieldType
        if (isCoroutineType(fnType)) {
            // Coroutine instances are callable and yield their yieldType
            // No need to apply generic substitutions here - already done in coroutine creation
            // Don't wrap basic types with nullable
            if (isOptionalCall && !this.typeUtils.isTypeBasic(fnType.yieldType)) {
                return this.typeFactory.createNullableType(fnType.yieldType, node);
            }
            return fnType.yieldType;
        }

        // Handle regular function types
        if (isFunctionType(fnType)) {
            // Check if the return type is a VariantConstructorType
            // If so, we need to infer generics from the call arguments
            if (isVariantConstructorType(fnType.returnType)) {
                const returnType = this.inferVariantConstructorCall(fnType.returnType, node);
                // Don't wrap basic types with nullable
                if (isOptionalCall && !this.typeUtils.isTypeBasic(returnType)) {
                    return this.typeFactory.createNullableType(returnType, node);
                }
                return returnType;
            }

            const genericParams = fnType.genericParameters || [];
            let substitutions: Map<string, TypeDescription> | undefined;

            // Handle explicit generic type arguments
            if (node.genericArgs && node.genericArgs.length > 0) {
                if (node.genericArgs.length === genericParams.length) {
                    // Build substitution map and validate constraints
                    const explicitSubstitutions = new Map<string, TypeDescription>();
                    
                    for (let index = 0; index < genericParams.length; index++) {
                        const param = genericParams[index];
                        const concreteType = this.getType(node.genericArgs[index]);
                        
                        // Validate that the concrete type satisfies the generic parameter's constraint
                        const constraintCheck = this.typeUtils.validateGenericConstraint(concreteType, param.constraint);
                        if (!constraintCheck.success) {
                            // Return error immediately if constraint not satisfied
                            return this.typeFactory.createErrorType(
                                constraintCheck.message || `Type argument does not satisfy generic constraint`,
                                undefined,
                                node
                            );
                        }
                        
                        explicitSubstitutions.set(param.name, concreteType);
                    }
                    
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
                
                // Validate that inferred types satisfy constraints
                for (let i = 0; i < genericParams.length; i++) {
                    const param = genericParams[i];
                    const inferredType = substitutions.get(param.name);
                    
                    if (inferredType && !isNeverType(inferredType)) {
                        const constraintCheck = this.typeUtils.validateGenericConstraint(inferredType, param.constraint);
                        if (!constraintCheck.success) {
                            return this.typeFactory.createErrorType(
                                constraintCheck.message || `Inferred type does not satisfy generic constraint`,
                                undefined,
                                node
                            );
                        }
                    }
                }
            }

            // Apply substitutions to return type if we have any
            let returnType = fnType.returnType;
            if (substitutions && substitutions.size > 0) {
                returnType = this.typeUtils.substituteGenerics(fnType.returnType, substitutions);
            }

            // Wrap return type in nullable if this was an optional call
            // Don't wrap basic types with nullable
            if (isOptionalCall && !this.typeUtils.isTypeBasic(returnType)) {
                return this.typeFactory.createNullableType(returnType, node);
            }
            return returnType;
        }

        // Handle variant constructor calls (e.g., Result.Ok(42))
        // This is the key feature: infer generics from arguments and create a properly typed constructor
        if (isVariantConstructorType(fnType)) {
            const returnType = this.inferVariantConstructorCall(fnType, node);
            return isOptionalCall ? this.typeFactory.createNullableType(returnType, node) : returnType;
        }

        // Handle old-style variant constructor calls (backward compatibility)
        if (fnType.kind === TypeKind.Variant) {
            return isOptionalCall ? this.typeFactory.createNullableType(fnType, node) : fnType;
        }

        // Handle callable classes/interfaces (with () operator overload)
        // Only check this if fnType is a class or interface, not if it's already a function
        const baseClassType = isClassType(fnType) ? fnType : undefined;
        const baseInterfaceType = this.typeUtils.asInterfaceType(fnType);

        if (baseClassType || baseInterfaceType) {
            // Use operator overload resolution for () operator
            // This handles multiple overloads correctly
            const args = node.args || [];
            const argTypes = args.map(arg => this.inferExpression(arg));

            const operatorOverload = this.resolveOperatorOverload(fnType, '()', argTypes, node);
            if (operatorOverload) {
                return isOptionalCall ? this.typeFactory.createNullableType(operatorOverload, node) : operatorOverload;
            }

            // If no call operator found, this is an error
            const typeName = baseClassType ? 'Class' : 'Interface';
            return this.typeFactory.createErrorType(
                `${typeName} type does not have a call operator '()'. ${baseClassType ? "Use 'new' for constructors." : ''}`,
                undefined,
                node
            );
        }

        if (isMetaVariantConstructorType(fnType)) {
            const returnType = this.inferVariantConstructorCall(fnType.baseVariantConstructor, node);
            return isOptionalCall ? this.typeFactory.createNullableType(returnType, node) : returnType;
        }

        return this.typeFactory.createErrorType(
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
            return this.typeFactory.createErrorType(
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
            return this.typeFactory.createErrorType(
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


        if (callNode.genericArgs && callNode.genericArgs.length > 0) {
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
        const variantRefWithGenerics = this.typeFactory.createReferenceType(
            variantDecl,
            // Sort names per the original declaration order
            genericParamNames.map(name => genericMap.get(name) ?? this.typeFactory.createNeverType()),
            callNode
        );

        // Resolve the reference to get the actual VariantType with substituted generics
        const resolvedVariant = this.resolveReference(variantRefWithGenerics);
        if (!isVariantType(resolvedVariant)) {
            return this.typeFactory.createErrorType(
                `Failed to resolve variant type for ${constructorType.constructorName}`,
                undefined,
                callNode
            );
        }

        // Return a VariantConstructorType (subtype of the variant)
        // Example: Result.Ok(42) returns Result<i32, never>.Ok
        // This represents that the value is specifically an Ok constructor,
        // which is a subtype of Result<i32, never>
        return this.typeFactory.createVariantConstructorType(
            resolvedVariant,
            constructorType.constructorName,
            constructorType.parentConstructor,
            genericParamNames.map(name => genericMap.get(name) ?? this.typeFactory.createNeverType()),
            callNode,
            variantDecl  // Pass the declaration for display purposes
        );
    }

    private inferIndexAccess(node: ast.IndexAccess): TypeDescription {
        let baseType = this.inferExpression(node.expr);
        if (isReferenceType(baseType)) {
            baseType = this.resolveReference(baseType);
        }

        // CRITICAL: Handle generic types with constraints for index operators
        // If base type is a generic type parameter (e.g., T in fn<T: Indexable<K, V>>),
        // use its constraint for operator resolution
        // Example: T: Indexable<K, V> → T[key] resolves to Indexable<K, V>.[]
        baseType = this.typeUtils.resolveIfGeneric(baseType);

        if (isArrayType(baseType)) {
            return baseType.elementType;
        }

        // Check for operator overload on classes/interfaces
        const indexTypes = node.indexes?.map(idx => this.inferExpression(idx)) ?? [];
        const operatorOverload = this.resolveOperatorOverload(baseType, '[]', indexTypes, node);
        if (operatorOverload) {
            return operatorOverload;
        }

        return this.typeFactory.createErrorType('Type does not implement index access operator `[]`', undefined, node);
    }

    private inferIndexSet(node: ast.IndexSet): TypeDescription {
        let baseType = this.inferExpression(node.expr);
        if (isReferenceType(baseType)) {
            baseType = this.resolveReference(baseType);
        }

        // CRITICAL: Handle generic types with constraints for index operators
        // If base type is a generic type parameter (e.g., T in fn<T: Indexable<K, V>>),
        // use its constraint for operator resolution
        baseType = this.typeUtils.resolveIfGeneric(baseType);

        // Check for operator overload on classes/interfaces
        // []=  operator takes index types + value type as parameters
        const indexTypes = node.indexes?.map(idx => this.inferExpression(idx)) ?? [];
        const valueType = this.inferExpression(node.value);
        const allArgTypes = [...indexTypes, valueType];

        const operatorOverload = this.resolveOperatorOverload(baseType, '[]=', allArgTypes, node);
        if (operatorOverload) {
            return operatorOverload;
        }

        // Default: return the value type
        return valueType;
    }

    private inferReverseIndexAccess(node: ast.ReverseIndexAccess): TypeDescription {
        let baseType = this.inferExpression(node.expr);
        if (isReferenceType(baseType)) {
            baseType = this.resolveReference(baseType);
        }

        // CRITICAL: Handle generic types with constraints for index operators
        // If base type is a generic type parameter (e.g., T in fn<T: Indexable<K, V>>),
        // use its constraint for operator resolution
        baseType = this.typeUtils.resolveIfGeneric(baseType);

        if (isArrayType(baseType)) {
            return baseType.elementType;
        }

        // Check for operator overload on classes/interfaces
        const indexType = this.inferExpression(node.index);
        const operatorOverload = this.resolveOperatorOverload(baseType, '[-]', [indexType], node);
        if (operatorOverload) {
            return operatorOverload;
        }

        return this.typeFactory.createErrorType('Type does not implement reverse index access operator `[-]`', undefined, node);
    }

    private inferReverseIndexSet(node: ast.ReverseIndexSet): TypeDescription {
        let baseType = this.inferExpression(node.expr);
        if (isReferenceType(baseType)) {
            baseType = this.resolveReference(baseType);
        }

        // CRITICAL: Handle generic types with constraints for index operators
        // If base type is a generic type parameter (e.g., T in fn<T: Indexable<K, V>>),
        // use its constraint for operator resolution
        baseType = this.typeUtils.resolveIfGeneric(baseType);

        // Check for operator overload on classes/interfaces
        // [-]= operator takes index type + value type as parameters
        const indexType = this.inferExpression(node.index);
        const valueType = this.inferExpression(node.value);

        const operatorOverload = this.resolveOperatorOverload(baseType, '[-]=', [indexType, valueType], node);
        if (operatorOverload) {
            return operatorOverload;
        }

        // Default: return the value type
        return valueType;
    }

    private inferPostfixOp(node: ast.PostfixOp): TypeDescription {
        const exprType = this.inferExpression(node.expr);

        // Check for operator overload on classes/interfaces
        // ++ and -- are unary operators (no parameters)
        const operatorOverload = this.resolveOperatorOverload(exprType, node.op, [], node);
        if (operatorOverload) {
            return operatorOverload;
        }

        // Default: preserve the type
        return exprType;
    }

    /**
     * Infer the type of an object update expression.
     *
     * The object update expression (e.g., `vec.{x: 1, y: 2}`) returns the same type
     * as the base expression since it updates fields in place and returns the updated object.
     *
     * Handles nullable chaining: `obj?.{field: value}` returns the type wrapped in nullable.
     *
     * Examples:
     * - `vec.{x: 1}` where vec is `{x: u32, y: u32}` → `{x: u32, y: u32}`
     * - `vec?.{x: 1}` where vec is `{x: u32, y: u32}?` → `{x: u32, y: u32}?`
     */
    private inferObjectUpdate(node: ast.ObjectUpdate): TypeDescription {
        let baseType = this.inferExpression(node.expr);

        // Track if the base is nullable (for optional chaining propagation)
        let baseIsNullable = false;

        // If base type is nullable, unwrap it for member lookup
        if (isNullableType(baseType)) {
            baseIsNullable = true;
            baseType = baseType.baseType;
        }

        // The result type is the same as the base type
        // (the expression updates fields and returns the updated object)
        let resultType = baseType;

        // Wrap in nullable if:
        // 1. Current node uses optional chaining (?.)
        // 2. OR base was nullable (propagate nullability through chain)
        // BUT: Don't wrap basic types - they can't be nullable
        if (node.isNullable || baseIsNullable) {
            if (!this.typeUtils.isTypeBasic(resultType)) {
                resultType = this.typeFactory.createNullableType(resultType, node);
            }
        }

        return resultType;
    }

    /**
     * Infer the type of an array construction expression (e.g., `[1, 2, 3]` or `[]`).
     *
     * For non-empty arrays, infers element type by computing common type across all elements.
     * For empty arrays, uses contextual typing from the expected type (if available).
     * Handles array spread expressions (e.g., `[...arr, 1, 2]`) by extracting element types.
     *
     * Examples:
     * - `[1, 2, 3]` → `i32[]` (inferred from elements)
     * - `[...arr, 1, 2]` where `arr: u32[]` → `u32[]` (spread contributes u32 elements)
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
            return this.typeFactory.createErrorType(
                'Cannot infer type of empty array literal. Provide a type annotation (e.g., let x: T[] = [])',
                undefined,
                node
            );
        }

        // Infer element types from all elements, handling spread expressions specially
        const elementTypes = node.values.map(v => {
            // Check if this is an array spread expression (...arr)
            if (ast.isArraySpreadExpression(v)) {
                // Infer the type of the spread expression
                const spreadType = this.inferExpression(v.expr);

                // The spread expression should be an array - extract its element type
                if (isArrayType(spreadType)) {
                    return spreadType.elementType;
                }

                // If not an array, return an error type (will be validated separately)
                return this.typeFactory.createErrorType(
                    `Array spread requires an array type, but got '${spreadType.toString()}'`,
                    undefined,
                    v
                );
            }

            // Regular expression element
            return this.inferExpression(v.expr);
        });

        const commonType = this.typeUtils.getCommonType(elementTypes);

        // If getCommonType returns an error, return it directly instead of wrapping in array
        // This ensures type errors are properly propagated to validation
        if (isErrorType(commonType)) {
            return commonType;
        }

        return this.typeFactory.createArrayType(commonType, node);
    }

    private inferNamedStructConstruction(node: ast.NamedStructConstructionExpression): TypeDescription {
        const fields = node.fields?.flatMap(f => {
            if (ast.isStructFieldKeyValuePair(f)) {
                return [this.typeFactory.createStructField(f.name, this.inferExpression(f.expr), f)];
            }
            // Handle struct spread: {...base}
            if (ast.isStructSpreadExpression(f)) {
                const spreadType = this.inferExpression(f.expression);

                // Resolve reference types to get the actual struct
                let resolvedType = this.typeUtils.resolveIfReference(spreadType);

                // Get struct type (handles both direct structs and join types)
                const structType = this.typeUtils.asStructType(resolvedType);

                if (structType) {
                    // Return all fields from the spread struct
                    return structType.fields;
                }

                // If spread expression is not a struct, return empty (validation will catch this error)
                return [];
            }
            return [];
        }) ?? [];

        return this.typeFactory.createStructType(fields, false, node);
    }

    private inferAnonymousStructConstruction(node: ast.AnonymousStructConstructionExpression): TypeDescription {
        // Get the expected type from context
        const expectedType = this.getExpectedType(node);

        // Resolve reference types if needed
        let resolvedExpectedType = expectedType;
        if (expectedType && isReferenceType(expectedType)) {
            resolvedExpectedType = this.resolveReference(expectedType);
        }

        // Check if expected type is a struct (could be a struct or join type resolving to struct)
        const expectedStruct = resolvedExpectedType ? this.typeUtils.asStructType(resolvedExpectedType) : undefined;

        if (expectedStruct) {
            // Infer as anonymous struct based on expected type
            const expressions = node.expressions ?? [];

            // Check if the number of expressions matches the number of fields
            if (expressions.length !== expectedStruct.fields.length) {
                return this.typeFactory.createErrorType(
                    `Anonymous struct has ${expressions.length} value(s), but expected struct type has ${expectedStruct.fields.length} field(s)`,
                    undefined,
                    node
                );
            }

            // Map expressions to struct fields in order
            const fields = expressions.map((expr, index) => {
                const expectedField = expectedStruct.fields[index];
                const inferredType = this.inferExpression(expr);

                return this.typeFactory.createStructField(
                    expectedField.name,  // Use expected field name
                    inferredType,        // Use inferred type (will be validated later)
                    expr                 // Use expression as node
                );
            });

            return this.typeFactory.createStructType(fields, true, node);
        }

        // No expected type or not a struct - cannot infer
        return this.typeFactory.createErrorType(
            `Cannot infer type of anonymous struct literal {${node.expressions?.length ?? 0} values}. ` +
            `Anonymous struct literals require a known struct type context (e.g., from return type or variable annotation)`,
            undefined,
            node
        );
    }

    private inferNewExpression(node: ast.NewExpression): TypeDescription {
        if (node.instanceType) {
            return this.getType(node.instanceType);
        }

        return this.typeFactory.createErrorType('New expression without type', undefined, node);
    }

    private inferLambdaExpression(node: ast.LambdaExpression): TypeDescription {
        // Get expected lambda type for parameter inference
        const expectedLambdaType = this.getExpectedType(node);
        const expectedFnType = expectedLambdaType && isFunctionType(expectedLambdaType) ? expectedLambdaType : undefined;

        const params = node.header.args?.map((arg, index) => {
            let paramType: TypeDescription;

            if (arg.type) {
                // Explicit type annotation
                paramType = this.getType(arg.type);
            } else if (expectedFnType && index < expectedFnType.parameters.length) {
                // Infer from expected function type (with partial generic inference)
                paramType = expectedFnType.parameters[index].type;
            } else {
                // No type available
                paramType = this.typeFactory.createErrorType(
                    `Parameter '${arg.name}' requires type annotation or must be in a context where type can be inferred`,
                    undefined,
                    arg
                );
            }

            return this.typeFactory.createFunctionParameterType(
                arg.name,
                paramType,
                arg.isMut
            );
        }) ?? [];

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

        return this.typeFactory.createFunctionType(params, returnType, node.fnType, [], node);
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
            return this.typeFactory.createVoidType(node);
        }

        // Filter out recursion placeholders
        const nonPlaceholders = allTypes.filter(type => {
            if (isErrorType(type)) {
                return type.message !== '__recursion_placeholder__';
            }
            return true;
        });

        const typesToUse = nonPlaceholders.length > 0 ? nonPlaceholders : allTypes;

        // Find the common type (not a union!)
        return this.typeUtils.getCommonType(typesToUse);
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
            return this.typeFactory.createVoidType(node);
        }

        // Filter out recursion placeholders - use non-placeholder types for inference
        const nonPlaceholders = allTypes.filter(type => {
            if (isErrorType(type)) {
                return type.message !== '__recursion_placeholder__';
            }
            return true;
        });

        const typesToUse = nonPlaceholders.length > 0 ? nonPlaceholders : allTypes;

        // Find the common type (not a union!)
        return this.typeUtils.getCommonType(typesToUse);
    }

    private inferLetInExpression(node: ast.LetInExpression): TypeDescription {
        return node.expr ? this.inferExpression(node.expr) : this.typeFactory.createVoidType(node);
    }

    private inferDoExpression(node: ast.DoExpression): TypeDescription {
        // Do expressions infer their type from return statements within the block
        // Similar to function return type inference, but only for this do block
        if (node.body) {
            const returnStatements = this.collectReturnStatementsFromDo(node.body);

            if (returnStatements.length === 0) {
                return this.typeFactory.createVoidType(node);
            }

            // Get types of all return expressions
            const allReturnTypes = returnStatements
                .map(stmt => stmt.expr ? this.getType(stmt.expr) : this.typeFactory.createVoidType());

            if (allReturnTypes.length === 0) {
                return this.typeFactory.createVoidType(node);
            }

            // Find common type
            return this.typeUtils.getCommonType(allReturnTypes);
        }

        return this.typeFactory.createVoidType(node);
    }

    private inferTypeCastExpression(node: ast.TypeCastExpression): TypeDescription {
        const type = this.getType(node.destType);

        if (node.castType === "as?") {
            let rtype = this.typeUtils.resolveIfReference(type);
            if (!isNullableType(rtype)) {
                return this.typeFactory.createNullableType(rtype);
            }
        }

        return type
    }

    private inferThisExpression(node: ast.ThisExpression): TypeDescription {
        // Find enclosing class
        const classNode = AstUtils.getContainerOfType(node, ast.isClassType);
        if (classNode) {
            return this.getType(classNode);
        }

        // Find enclosing implementation type
        const implNode = AstUtils.getContainerOfType(node, ast.isImplementationType);
        if (implNode) {
            return this.getType(implNode);
        }

        return this.typeFactory.createErrorType('this outside of class or impl', undefined, node);
    }

    private inferYieldExpression(node: ast.YieldExpression): TypeDescription {
        // Yield expression type is void
        return this.typeFactory.createVoidType(node);
    }

    private inferCoroutineExpression(node: ast.CoroutineExpression): TypeDescription {
        const fnType = this.inferExpression(node.fn);

        if (isFunctionType(fnType)) {
            // The coroutine expression wraps a function and creates a coroutine instance
            // For coroutines, the function's returnType is actually the yieldType
            return this.typeFactory.createCoroutineType(
                fnType.parameters,
                fnType.returnType,  // This is the yield type for coroutines
                node
            );
        }

        return this.typeFactory.createErrorType('Coroutine of non-function', undefined, node);
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
        return this.typeFactory.createTupleType(types, node);
    }

    private inferDestructuringElement(node: ast.DestructuringElement): TypeDescription {
        /**
         * let (a, b) = (1, 2) 
         * let (a, _, c) = f() where f() -> (u32, u32, u32)
         */
        // Check if underscore -> return never
        if (node.name === undefined) {
            return this.typeFactory.createNeverType();
        }

        const index = node.$containerIndex;
        const initializer = node.$container.initializer;
        // Unreachable, but create an error, you never know these days
        if (index == undefined || !ast.isVariableDeclaration(node.$container) || !initializer) {
            return this.typeFactory.createErrorType('Invalid destructuring element', undefined, node);
        }

        /**
         * Wraps a node with a nullable type if the node is nullable
         */
        const wrapNode = (node: ast.DestructuringElement, t: TypeDescription): TypeDescription => {
            return node.isNullable ? this.typeFactory.createNullableType(t, node) : t;
        };

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
                return wrapNode(node, this.typeFactory.createArrayType(initializerType.elementType, node));
            }
            else {
                return wrapNode(node, initializerType.elementType);
            }
        }
        else if (isTupleType(initializerType)) {
            return wrapNode(node, initializerType.elementTypes[index]);
        }
        else {
            // Handle structs and join types that resolve to structs
            const structType = this.services.typing.TypeUtils.asStructType(initializerType);
            if (structType) {
                /**
                 * We need to base struct + we need to remove the previously destructured fields
                 */
                // check if we have a destructuring

                if (node.isSpread) {
                    const structFields = structType.fields;
                    // Grab all previous elements, not including the current one
                    const fieldsToRemove = (node.$container.elements ?? []).slice(0, index).map(e => e.originalName ?? e.name);
                    const newStructType = this.typeFactory.createStructType(structFields.filter(f => !fieldsToRemove.includes(f.name)), false, node);
                    return wrapNode(node, newStructType);
                }
                else {
                    // find the field by name
                    const field = structType.fields.find(f => f.name === (node.originalName ?? node.name));
                    if (field) {
                        return wrapNode(node, field.type);
                    }
                    else {
                        return this.typeFactory.createErrorType(`Field '${node.name}' not found`, undefined, node);
                    }
                }
            }
        }

        return this.typeFactory.createErrorType('Invalid destructuring element', undefined, node);
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

    /**
     * Helper method to get the type of a field/attribute from a class or struct type.
     *
     * @param baseType The class or struct type to search in
     * @param fieldName The name of the field/attribute to find
     * @returns The type of the field/attribute, or undefined if not found
     *
     * Examples:
     * - getFieldType(Vector3, "x") → f32
     * - getFieldType(Point2D, "y") → f32
     */
    private getFieldType(baseType: TypeDescription, fieldName: string): TypeDescription | undefined {
        // For classes: get attribute type
        if (isClassType(baseType)) {
            const attribute = baseType.attributes.find(a => a.name === fieldName);
            return attribute?.type;
        }

        // For structs: get field type
        const structType = this.typeUtils.asStructType(baseType);
        if (structType) {
            const field = structType.fields.find(f => f.name === fieldName);
            return field?.type;
        }

        return undefined;
    }

    /**
     * Infers the type of a KeyValuePair in object update expressions.
     * Returns the type of the field/attribute being updated.
     *
     * Examples:
     * - vec.{x: 1.0f} → x has type f32 (from vec's x field)
     * - obj.{count: 10u32} → count has type u32 (from obj's count attribute)
     */
    private inferKeyValuePair(node: ast.KeyValuePair): TypeDescription {
        // Get the parent ObjectUpdate
        const objectUpdate = node.$container;
        if (!objectUpdate || !ast.isObjectUpdate(objectUpdate)) {
            return this.typeFactory.createErrorType('KeyValuePair outside ObjectUpdate', undefined, node);
        }

        // Get the base type being updated
        let baseType = this.getType(objectUpdate.expr);

        // Resolve reference types
        if (isReferenceType(baseType)) {
            baseType = this.resolveReference(baseType);
        }

        // Unwrap nullable types
        if (isNullableType(baseType)) {
            baseType = baseType.baseType;
        }

        // Get field/attribute type using the helper
        const fieldType = this.getFieldType(baseType, node.name);
        if (fieldType) {
            return fieldType;
        }

        // Field not found - return error with appropriate message
        const isClass = isClassType(baseType);
        const fieldKind = isClass ? 'Attribute' : 'Field';
        return this.typeFactory.createErrorType(`${fieldKind} '${node.name}' not found in ${baseType.toString()}`, undefined, node);
    }

    private inferFFIMethodHeader(node: ast.FFIMethodHeader): TypeDescription {
        return this.typeFactory.createFunctionType(
            node.header.args?.map(arg => this.typeFactory.createFunctionParameterType(
                arg.name,
                this.getType(arg.type),
                arg.isMut
            )) ?? [],
            node.header.returnType ? this.getType(node.header.returnType) : this.typeFactory.createVoidType(node),
            'fn',
            [],
            node
        );
    }

    /**
     * Infers the type of a foreach iterator variable (index or value).
     *
     * For arrays (T[]):
     *   - indexVar: u64
     *   - valueVar: T
     *
     * For Iterable<U, V>:
     *   - indexVar: U
     *   - valueVar: V
     */
    private inferIteratorVar(node: ast.IteratorVar): TypeDescription {
        // Get the containing foreach statement
        const foreachStmt = AstUtils.getContainerOfType(node, ast.isForeachStatement);
        if (!foreachStmt) {
            return this.typeFactory.createErrorType('IteratorVar outside foreach statement', undefined, node);
        }

        // Infer the collection type
        if (ast.isForRangeIterator(foreachStmt)) {
            // It is a for .. in A, B
            if (foreachStmt.iterType) {
                return this.getType(foreachStmt.iterType)
            }

            if (!foreachStmt.start || !foreachStmt.end) {
                return this.typeFactory.createErrorType('Unable to infer iterator variable type when no bounds are defined')
            }

            const startType = this.inferExpression(foreachStmt.start);

            return startType;
        }

        if (!ast.isForEachIterator(foreachStmt)) {
            return this.typeFactory.createErrorType('Unknown foreach statement');
        }
        const collectionType = this.inferExpression(foreachStmt.collection);

        // Determine if this is the index or value variable
        const isIndexVar = foreachStmt.indexVar === node;

        // Handle arrays: index is u64, value is element type
        if (isArrayType(collectionType)) {
            if (isIndexVar) {
                return this.typeFactory.createU64Type(node);
            } else {
                return collectionType.elementType;
            }
        }

        // Handle Iterable<U, V> - extract generics U and V
        const iterableInfo = this.extractIterableInterface(collectionType);
        if (iterableInfo) {
            // iterableInfo contains { indexType: U, valueType: V }
            if (isIndexVar) {
                return iterableInfo.indexType; // U
            } else {
                return iterableInfo.valueType; // V
            }
        }

        return this.typeFactory.createErrorType(
            `Type '${collectionType.toString()}' is not iterable. ` +
            `Expected array type or type implementing Iterable<U, V>`,
            undefined,
            node
        );
    }

    /**
     * Infers the type of a variable pattern in match expressions.
     *
     * Pattern variables have their types inferred from the context:
     * - Array patterns: variables get element type, trail gets array type
     * - Struct patterns: variables get field types, trail gets remaining fields
     * - Variant constructor patterns: variables get parameter types
     *
     * Examples:
     * ```
     * match arr: u32[] {
     *     [first, second] => ...           // first: u32, second: u32
     *     [first, ...rest] => ...          // first: u32, rest: u32[]
     * }
     *
     * match person: {name: string, age: u32} {
     *     {name: n, age: a} => ...         // n: string, a: u32
     * }
     *
     * match result: Result<u32, string> {
     *     Result.Ok(value) => ...          // value: u32
     *     Result.Error(msg) => ...         // msg: string
     * }
     * ```
     */
    private inferVariablePattern(node: ast.VariablePattern): TypeDescription {
        /**
         * If we are here, it means the node is not cached, hence not inferred.
         * At this point we can go up in the hierarchy, but that is aweful, we go down as we have gravity.
         *
         * Hence we infer all of pattern variable all at once! using `this.inferMatchCasePattern`
         * And cache their results.
         */

        // Climb to find the root MatchCasePattern (the one directly under MatchCaseExpression/Statement)
        let rootPattern: AstNode = node;

        // Keep climbing while our container is NOT a MatchCaseExpression/Statement
        while (rootPattern.$container &&
            !ast.isMatchCaseExpression(rootPattern.$container) &&
            !ast.isMatchCaseStatement(rootPattern.$container)) {
            rootPattern = rootPattern.$container;
        }

        // Infer all variables in this pattern tree (starting from root)
        if (ast.isMatchCasePattern(rootPattern)) {
            this.inferMatchCasePattern(rootPattern);
        }

        // Return the cached type for this variable
        const documentUri = AstUtils.getDocument(node).uri;
        return this.typeCache.get(documentUri, node, () => this.typeFactory.createErrorType(`Failed to infer type for pattern variable '${node.name}'`));
    }

    /**
     * Infers types for all variables in a match case pattern.
     * Uses downward traversal: starts from the root pattern with the matched expression type,
     * then recursively descends and caches types for all variable bindings.
     *
     * This is called once per pattern and caches all variable types in one pass.
     */
    private inferMatchCasePattern(node: ast.MatchCasePattern): void {
        // Find the parent match case (expression or statement)
        let parentNode = node.$container;
        while (parentNode && !(ast.isMatchCaseExpression(parentNode) || ast.isMatchCaseStatement(parentNode))) {
            parentNode = parentNode.$container;
        }

        if (!parentNode) {
            return; // Invalid structure
        }

        // Get the match target expression
        let baseExpression: ast.Expression | undefined = undefined;
        if (ast.isMatchStatement(parentNode.$container) || ast.isMatchExpression(parentNode.$container)) {
            baseExpression = parentNode.$container.target;
        } else {
            return; // Invalid structure
        }

        // Get the target type - this is what we're matching against
        const targetType = this.getType(baseExpression);

        // Descend into the pattern tree and infer all variable types
        this.inferPatternTypes(node, targetType, 0);
    }

    /**
     * Recursively infers and caches types for all variables in a pattern.
     * This is the core downward traversal that handles all pattern types.
     *
     * @param pattern The pattern to analyze
     * @param contextType The type being matched against at this level
     * @param depth Recursion depth for logging
     */
    private inferPatternTypes(pattern: ast.MatchCasePattern, contextType: TypeDescription, depth: number = 0): void {
        const documentUri = AstUtils.getDocument(pattern).uri;

        if (ast.isVariablePattern(pattern)) {
            // Base case: cache the type for this variable
            const type = contextType;
            this.typeCache.set(documentUri, pattern, type);
        }
        else if (ast.isArrayPattern(pattern)) {
            this.inferArrayPattern(pattern, contextType, depth);
        }
        else if (ast.isStructPattern(pattern)) {
            this.inferStructPattern(pattern, contextType, depth);
        }
        else if (ast.isTypePattern(pattern)) {
            this.inferTypePattern(pattern, contextType, depth);
        }
        else if (ast.isWildCardPattern(pattern)) {
            // Wildcard pattern - no variables to infer
        }
        else if (ast.isLiteralPattern(pattern)) {
            // Literal pattern - no variables to infer
        }
    }

    /**
     * Infers types for array pattern: [first, second, ...rest]
     * - Element patterns get the array's element type
     * - Trail variable (rest) gets the full array type
     */
    private inferArrayPattern(pattern: ast.ArrayPattern, contextType: TypeDescription, depth: number = 0): void {
        const documentUri = AstUtils.getDocument(pattern).uri;

        // Resolve reference types to get actual type
        const resolvedType = this.typeUtils.resolveIfReference(contextType);

        if (!isArrayType(resolvedType)) {
            // Store validation error for the pattern itself
            this.setPatternValidationError(pattern, `Pattern expects array type, but got '${contextType.toString()}'`);

            // Still infer types for sub-patterns to avoid cascading errors
            // Use a placeholder error type that won't create additional validation errors
            const errorType = this.typeFactory.createErrorType(
                `Pattern expects array type, but got '${contextType.toString()}'`,
                undefined,
                pattern
            );
            for (const subPattern of pattern.pattners ?? []) {
                this.inferPatternTypes(subPattern, errorType, depth + 1);
            }
            if (pattern.trailVariable) {
                this.typeCache.set(documentUri, pattern.trailVariable, errorType);
            }
            return;
        }

        const elementType = resolvedType.elementType;

        // Infer types for each element pattern
        for (let i = 0; i < (pattern.pattners?.length ?? 0); i++) {
            this.inferPatternTypes(pattern.pattners![i], elementType, depth + 1);
        }

        // Trail variable (...rest) gets the array type (remaining elements)
        if (pattern.trailVariable) {
            this.typeCache.set(documentUri, pattern.trailVariable, resolvedType);
        }
    }

    /**
     * Infers types for struct pattern: {name: n, age: a, ...rest}
     * - Field patterns get their corresponding field types
     * - Trail variable (rest) gets a struct with remaining fields
     */
    private inferStructPattern(pattern: ast.StructPattern, contextType: TypeDescription, depth: number = 0): void {
        const documentUri = AstUtils.getDocument(pattern).uri;

        // Resolve reference types to get actual type
        const resolvedType = this.typeUtils.resolveIfReference(contextType);

        const structType = this.typeUtils.asStructType(resolvedType);
        if (!structType) {
            // Store validation error for the pattern itself
            this.setPatternValidationError(pattern, `Pattern expects struct type, but got '${contextType.toString()}'`);

            // Still infer types for sub-patterns to avoid cascading errors
            const errorType = this.typeFactory.createErrorType(
                `Pattern expects struct type, but got '${contextType.toString()}'`,
                undefined,
                pattern
            );
            for (const field of pattern.fields ?? []) {
                this.inferPatternTypes(field.pattern, errorType, depth + 1);
            }
            if (pattern.trailVariable) {
                this.typeCache.set(documentUri, pattern.trailVariable, errorType);
            }
            return;
        }

        // Infer types for each field pattern
        for (const fieldPattern of pattern.fields ?? []) {
            const fieldName = fieldPattern.name;
            const structField = structType.fields.find(f => f.name === fieldName);

            if (structField) {
                this.inferPatternTypes(fieldPattern.pattern, structField.type, depth + 1);
            } else {
                // Field not found in struct
                this.inferPatternTypes(fieldPattern.pattern,
                    this.typeFactory.createErrorType(
                        `Field '${fieldName}' not found in struct type`,
                        undefined,
                        fieldPattern
                    ),
                    depth + 1
                );
            }
        }

        // Trail variable (...rest) gets a struct with remaining fields
        if (pattern.trailVariable) {
            const extractedFieldNames = (pattern.fields ?? []).map(f => f.name);
            const remainingFields = structType.fields.filter(f => !extractedFieldNames.includes(f.name));
            const remainingStructType = this.typeFactory.createStructType(remainingFields, false, pattern);
            this.typeCache.set(documentUri, pattern.trailVariable, remainingStructType);
        }
    }

    /**
     * Infers types for type pattern: Result.Ok(value) or Option<u32>.Some(value)
     * This is the most complex case due to generic inference.
     *
     * Key challenge: Extract generic substitutions from the match target type.
     * Example:
     *   match result: Result<u32, string> {
     *       Result.Ok(value) => ...  // value: u32
     *       Result.Err(msg) => ...   // msg: string
     *   }
     */
    private inferTypePattern(pattern: ast.TypePattern, contextType: TypeDescription, depth: number = 0): void {
        // Get the type annotation from the pattern (e.g., Result.Ok)
        // TypePattern grammar: TypeInstancePattern ('(' params... ')')?
        // TypePattern has inline TypeInstancePattern which has a 'type' field
        // We need to safely access it. Check using a helper.
        const hasTypeProperty = (obj: unknown): obj is { type: ast.DataType } => {
            return typeof obj === 'object' && obj !== null && 'type' in obj;
        };

        if (!hasTypeProperty(pattern)) {
            // No type specified - error
            const errorType = this.typeFactory.createErrorType(
                `Type pattern missing type annotation`,
                undefined,
                pattern
            );

            for (const param of pattern.params ?? []) {
                this.inferPatternTypes(param, errorType);
            }

            return;
        }

        const patternType = this.getType(pattern.type);

        // Handle different forms of variant constructor types
        let constructorType: VariantConstructorTypeDescription | undefined;

        if (isVariantConstructorType(patternType)) {
            constructorType = patternType;
        }
        else if (isReferenceType(patternType)) {
            const resolved = this.resolveReference(patternType);
            if (isVariantConstructorType(resolved)) {
                constructorType = resolved;
            }
        }
        else if (isMetaVariantConstructorType(patternType)) {
            constructorType = patternType.baseVariantConstructor;
        }

        if (constructorType) {
            this.inferVariantConstructorPattern(pattern, constructorType, contextType, depth);
        } else {
            // Not a variant constructor - can't destructure parameters
            const errorType = this.typeFactory.createErrorType(
                `Cannot destructure non-variant type '${patternType.toString()}'`,
                undefined,
                pattern
            );
            for (const param of pattern.params ?? []) {
                this.inferPatternTypes(param, errorType, depth + 1);
            }
        }
    }

    /**
     * Handles variant constructor pattern with generic inference.
     *
     * This is the critical part: we need to extract generic substitutions from
     * the context type (the match target) and apply them to constructor parameters.
     *
     * Example:
     *   match result: Result<u32, string> {
     *       Result.Ok(value) => ...
     *       // value should be u32, not T
     *   }
     *
     * Steps:
     * 1. Extract generic args from context type (u32, string)
     * 2. Get constructor parameters (value: T)
     * 3. Substitute T → u32
     * 4. Cache value: u32
     */
    private inferVariantConstructorPattern(
        pattern: ast.TypePattern,
        constructorType: VariantConstructorTypeDescription,
        contextType: TypeDescription,
        depth: number = 0
    ): void {
        // Extract generic substitutions from the context
        const genericSubstitutions = this.extractGenericSubstitutionsFromContext(
            constructorType,
            contextType
        );

        // Find the constructor definition
        const constructor = constructorType.baseVariant.constructors.find(
            c => c.name === constructorType.constructorName
        );

        if (!constructor) {
            // Constructor not found in variant
            const errorType = this.typeFactory.createErrorType(
                `Constructor '${constructorType.constructorName}' not found in variant`,
                undefined,
                pattern
            );
            for (const param of pattern.params ?? []) {
                this.inferPatternTypes(param, errorType, depth + 1);
            }
            return;
        }

        // Match pattern parameters with constructor parameters
        const params = pattern.params ?? [];
        for (let i = 0; i < params.length; i++) {
            if (i < constructor.parameters.length) {
                let paramType = constructor.parameters[i].type;

                // Apply generic substitutions (T → concrete type)
                if (genericSubstitutions.size > 0) {
                    paramType = this.typeUtils.substituteGenerics(paramType, genericSubstitutions);
                }

                this.inferPatternTypes(params[i], paramType, depth + 1);
            } else {
                // Too many parameters in pattern
                this.inferPatternTypes(params[i],
                    this.typeFactory.createErrorType(
                        `Too many parameters in pattern (expected ${constructor.parameters.length})`,
                        undefined,
                        params[i]
                    ),
                    depth + 1
                );
            }
        }
    }

    /**
     * Extracts generic substitutions from the match context type.
     *
     * Handles cases:
     * 1. Context is ReferenceType with generic args: Result<u32, string>
     * 2. Context is VariantConstructorType: Result.Ok<u32, string>
     *
     * Returns a map of generic parameter names to their concrete types.
     */
    private extractGenericSubstitutionsFromContext(
        constructorType: VariantConstructorTypeDescription,
        contextType: TypeDescription
    ): Map<string, TypeDescription> {
        const substitutions = new Map<string, TypeDescription>();
        const variantDecl = constructorType.variantDeclaration;

        if (!variantDecl || !variantDecl.genericParameters) {
            return substitutions;
        }

        const genericParamNames = variantDecl.genericParameters.map(p => p.name);

        // Case 1: Context is a ReferenceType to the same variant with concrete generics
        // Example: contextType = Result<u32, string>
        if (isReferenceType(contextType) && contextType.declaration === variantDecl) {
            genericParamNames.forEach((name, i) => {
                if (i < contextType.genericArgs.length) {
                    substitutions.set(name, contextType.genericArgs[i]);
                }
            });
        }
        // Case 2: Context is a VariantConstructorType with generics
        // Example: contextType = Result.Ok<u32, string>
        else if (isVariantConstructorType(contextType)) {
            if (contextType.variantDeclaration === variantDecl) {
                genericParamNames.forEach((name, i) => {
                    if (i < contextType.genericArgs.length) {
                        substitutions.set(name, contextType.genericArgs[i]);
                    }
                });
            }
        }
        // Case 3: Context is a resolved variant type (shouldn't happen but handle it)
        else if (isVariantType(contextType)) {
            // No generic args available in plain variant type - use never as fallback
            genericParamNames.forEach(name => {
                substitutions.set(name, this.typeFactory.createNeverType());
            });
        }

        return substitutions;
    }


    /**
     * Extracts Iterable<U, V> interface from a type using structural typing.
     * Returns {indexType: U, valueType: V} if the type has a getIterator() method
     * that returns Iterator<U, V>.
     */
    private extractIterableInterface(type: TypeDescription): { indexType: TypeDescription; valueType: TypeDescription } | undefined {

        let resolvedType = this.typeUtils.resolveIfReference(type);

        // For classes: check if they have getIterator() method
        if (isClassType(resolvedType)) {
            const getIteratorMethod = resolvedType.methods.find(m => m.names.includes('getIterator'));
            if (getIteratorMethod) {
                return this.extractIteratorTypes(getIteratorMethod.returnType);
            }
        }

        // For interfaces: check methods (including inherited)
        const interfaceType = this.typeUtils.asInterfaceType(resolvedType);
        if (interfaceType) {
            return this.extractIterableFromInterface(interfaceType);
        }

        return undefined;
    }

    /**
     * Recursively searches for getIterator() method in interface hierarchy.
     */
    private extractIterableFromInterface(interfaceType: InterfaceTypeDescription): { indexType: TypeDescription; valueType: TypeDescription } | undefined {

        // Find getIterator() in this interface
        const getIteratorMethod = interfaceType.methods.find(m => m.names.includes('getIterator'));
        if (getIteratorMethod) {
            return this.extractIteratorTypes(getIteratorMethod.returnType);
        }

        // Check supertypes recursively
        for (const superType of interfaceType.superTypes) {
            const resolvedSuper = this.typeUtils.resolveIfReference(superType);
            const superInterface = this.typeUtils.asInterfaceType(resolvedSuper);
            if (superInterface) {
                const result = this.extractIterableFromInterface(superInterface);
                if (result) return result;
            }
        }

        return undefined;
    }

    /**
     * Extracts index and value types from Iterator<U, V> return type.
     * Supports both nominal (Iterator<U, V>) and structural (has next() -> (U, V)) approaches.
     */
    private extractIteratorTypes(iteratorType: TypeDescription): { indexType: TypeDescription; valueType: TypeDescription } | undefined {

        // If it's a reference to Iterator<U, V>, extract generics directly
        if (isReferenceType(iteratorType) && iteratorType.genericArgs.length === 2) {
            return {
                indexType: iteratorType.genericArgs[0],
                valueType: iteratorType.genericArgs[1]
            };
        }

        // Structural approach: check if it has next() -> (U, V)
        let resolvedType = this.typeUtils.resolveIfReference(iteratorType);
        const interfaceType = this.typeUtils.asInterfaceType(resolvedType);
        if (interfaceType) {
            const nextMethod = interfaceType.methods.find(m => m.names.includes('next'));
            if (nextMethod && isTupleType(nextMethod.returnType) && nextMethod.returnType.elementTypes.length === 2) {
                return {
                    indexType: nextMethod.returnType.elementTypes[0],
                    valueType: nextMethod.returnType.elementTypes[1]
                };
            }
        }

        return undefined;
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
            const parseResult = document.parseResult.value;
            if (!ast.isModule(parseResult)) {
                return this.typeFactory.createPrototypeType('array', [], []);
            }
            const firstDef = parseResult.definitions[0];
            if (!ast.isBuiltinDefinition(firstDef)) {
                return this.typeFactory.createPrototypeType('array', [], []);
            }
            const prototype = firstDef;
            this.builtinPrototypes.set('array', this.getType(prototype));
            return this.builtinPrototypes.get('array')!;
        }

        // Return empty prototype if not found
        return this.typeFactory.createPrototypeType('array', [], []);
    }

    private getStringPrototype(): TypeDescription {
        if (this.builtinPrototypes.has('string')) {
            return this.builtinPrototypes.get('string')!;
        }

        // Find array prototype definition in builtins
        const document = this.services.shared.workspace.LangiumDocuments.getDocument(URI.parse(StringPrototypeBuiltin));
        if (document) {
            const parseResult = document.parseResult.value;
            if (!ast.isModule(parseResult)) {
                return this.typeFactory.createPrototypeType('string', [], []);
            }
            const firstDef = parseResult.definitions[0];
            if (!ast.isBuiltinDefinition(firstDef)) {
                return this.typeFactory.createPrototypeType('string', [], []);
            }
            const prototype = firstDef;
            this.builtinPrototypes.set('string', this.getType(prototype));
            return this.builtinPrototypes.get('string')!;
        }

        // Return empty prototype if not found
        return this.typeFactory.createPrototypeType('array', [], []);
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
            if (fn.parameters.every((param, index) => this.typeUtils.areTypesEqual(expressionTypes[index], param.type).success)) {
                finalCandidates.push(fn);
            }
        }

        // Second prio is assignable match
        if (finalCandidates.length === 0) {
            for (const fn of argBasedCandidates) {
                if (fn.parameters.every((param, index) => this.typeUtils.isAssignable(expressionTypes[index], param.type).success)) {
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
                finalMap.set(key, this.typeFactory.createNeverType());
                continue;
            }
            const commonType = this.typeUtils.getCommonType(values);
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

        // Handle ReferenceType BEFORE resolving - extract generics from generic arguments
        // Example: Result<T, string> vs Result<i32, never> → extract T = i32
        if (isReferenceType(parameterType) && isReferenceType(argumentType)) {
            // Both must reference the same declaration to be comparable
            if (parameterType.declaration === argumentType.declaration) {
                // Extract from each generic argument position
                const numArgs = Math.min(parameterType.genericArgs.length, argumentType.genericArgs.length);
                for (let i = 0; i < numArgs; i++) {
                    this.extractGenericArgsFromTypeDescription(parameterType.genericArgs[i], argumentType.genericArgs[i], genericMap);
                }
                return; // Don't resolve and continue - we've handled this case
            }
        }

        // Handle VariantConstructorType BEFORE resolving
        // Example: Result.Ok<T, string> vs Result.Ok<i32, never> → extract T = i32
        if (isVariantConstructorType(parameterType) && isVariantConstructorType(argumentType)) {
            // Both must be the same constructor to be comparable
            if (parameterType.constructorName === argumentType.constructorName) {
                // Extract from each generic argument position
                const numArgs = Math.min(parameterType.genericArgs.length, argumentType.genericArgs.length);
                for (let i = 0; i < numArgs; i++) {
                    this.extractGenericArgsFromTypeDescription(parameterType.genericArgs[i], argumentType.genericArgs[i], genericMap);
                }
                return; // Don't resolve and continue - we've handled this case
            }
        }

        // Handle MIXED case: ReferenceType (variant) vs VariantConstructorType
        // Example: Result<T, string> vs Result.Ok<i32, never> → extract T = i32, string vs never
        // This is the CRITICAL case for the bug fix!
        if (isReferenceType(parameterType) && isVariantConstructorType(argumentType)) {
            // Check if the ReferenceType points to the same variant declaration as the constructor
            const argVariantDecl = argumentType.variantDeclaration;
            if (argVariantDecl && parameterType.declaration === argVariantDecl) {
                // Extract from each generic argument position
                const numArgs = Math.min(parameterType.genericArgs.length, argumentType.genericArgs.length);
                for (let i = 0; i < numArgs; i++) {
                    this.extractGenericArgsFromTypeDescription(parameterType.genericArgs[i], argumentType.genericArgs[i], genericMap);
                }
                return; // Don't resolve and continue - we've handled this case
            }
        }

        const resolvedParameterType = this.typeUtils.resolveIfReference(parameterType);
        const resolvedArgumentType = this.typeUtils.resolveIfReference(argumentType);

        // Ignore error types
        if (isErrorType(resolvedParameterType) || isErrorType(resolvedArgumentType)) {
            return;
        }

        const paramStruct = this.services.typing.TypeUtils.asStructType(resolvedParameterType);
        const argStruct = this.services.typing.TypeUtils.asStructType(resolvedArgumentType);

        if (paramStruct && argStruct) {
            for (const field of paramStruct.fields) {
                const fieldInArgumentType = argStruct.fields.find(f => f.name === field.name);
                if (fieldInArgumentType) {
                    this.extractGenericArgsFromTypeDescription(field.type, fieldInArgumentType.type, genericMap);
                }
            }
        }

        if (isArrayType(resolvedParameterType) && isArrayType(resolvedArgumentType)) {
            this.extractGenericArgsFromTypeDescription(resolvedParameterType.elementType, resolvedArgumentType.elementType, genericMap);
        }

        if (isNullableType(resolvedParameterType) && isNullableType(resolvedArgumentType)) {
            this.extractGenericArgsFromTypeDescription(resolvedParameterType.baseType, resolvedArgumentType.baseType, genericMap);
        }

        if (isFunctionType(resolvedParameterType) && isFunctionType(resolvedArgumentType)) {
            for (let i = 0; i < Math.min(resolvedParameterType.parameters.length, resolvedArgumentType.parameters.length); i++) {
                this.extractGenericArgsFromTypeDescription(resolvedParameterType.parameters[i].type, resolvedArgumentType.parameters[i].type, genericMap);
            }
            this.extractGenericArgsFromTypeDescription(resolvedParameterType.returnType, resolvedArgumentType.returnType, genericMap);
        }

        // Handle VariantTypes after resolution
        // Example: variant { Ok(value: T), Err(message: string) } vs variant { Ok(value: i32), Err(message: never) }
        // This extracts T = i32 by matching constructor parameters
        if (isVariantType(resolvedParameterType) && isVariantType(resolvedArgumentType)) {
            // Match constructors by name and extract generics from their parameters
            for (const paramConstructor of resolvedParameterType.constructors) {
                const argConstructor = resolvedArgumentType.constructors.find(c => c.name === paramConstructor.name);

                if (argConstructor) {
                    // Extract from each parameter
                    const numParams = Math.min(paramConstructor.parameters.length, argConstructor.parameters.length);
                    for (let i = 0; i < numParams; i++) {
                        this.extractGenericArgsFromTypeDescription(
                            paramConstructor.parameters[i].type,
                            argConstructor.parameters[i].type,
                            genericMap
                        );
                    }
                }
            }
        }
    }

    // ========================================================================
    // Generic Substitution Helpers
    // ========================================================================

    /**
     * Builds a generic substitution map from a reference type.
     *
     * **Purpose:**
     * Extracts the mapping from generic parameter names to their concrete type arguments.
     * This is a common operation when working with instantiated generic types.
     *
     * **Example:**
     * ```
     * type Array<T> = ...
     * let arr: Array<u32> = ...
     *
     * buildGenericSubstitutions(Array<u32>) → Map { "T" → u32 }
     * ```
     *
     * @param refType Reference type with potential generic arguments
     * @returns Map of parameter names to concrete types, or undefined if no generics
     */
    private buildGenericSubstitutions(refType: ReferenceTypeDescription): Map<string, TypeDescription> | undefined {
        if (refType.genericArgs.length > 0 && refType.declaration.genericParameters) {
            const substitutions = new Map<string, TypeDescription>();
            refType.declaration.genericParameters.forEach((param: ast.GenericType, i: number) => {
                if (i < refType.genericArgs.length) {
                    substitutions.set(param.name, refType.genericArgs[i]);
                }
            });
            return substitutions;
        }
        return undefined;
    }

    /**
     * Resolves a reference type and applies generic substitutions from its arguments.
     *
     * **Purpose:**
     * Combines two common operations: resolving a reference and substituting its generics.
     * Used when we need the fully instantiated type (e.g., `Serializable<string>` not `Serializable<T>`).
     *
     * **Example:**
     * ```
     * type Serializable<T> = interface { fn serialize() -> T }
     *
     * resolveAndSubstitute(Serializable<string>) →
     *   interface { fn serialize() -> string }  // T substituted with string
     * ```
     *
     * @param refType Reference type to resolve and substitute
     * @returns Resolved type with generics substituted
     */
    private resolveAndSubstituteReference(refType: ReferenceTypeDescription): TypeDescription {
        const substitutions = this.buildGenericSubstitutions(refType);
        const resolved = this.resolveReference(refType);

        if (substitutions && substitutions.size > 0) {
            return this.typeUtils.substituteGenerics(resolved, substitutions);
        }

        return resolved;
    }

    /**
     * Check if an expression or any of its parent expressions use optional chaining.
     *
     * This recursively checks through the entire expression chain to detect if
     * optional chaining (?.) was used anywhere, matching TypeScript's behavior.
     *
     * Propagates through operations that:
     * - Access members/properties (member access, indexing)
     * - Transform values while maintaining the chain (function calls, type casts)
     * - Return objects via operator overloading (postfix/unary ops)
     *
     * Does NOT propagate through:
     * - Assignments (return assigned value, not container)
     * - Type checks (return boolean, not object)
     * - Denull operator (!) - explicitly exits optional safety
     *
     * @example
     * ```
     * a?.b.c()         // ✅ Propagates (member access with ?.)
     * a?.b()[0].c      // ✅ Propagates (function call + index)
     * (a?.b as T).c    // ✅ Propagates (type cast)
     * (a?.b++).c       // ✅ Propagates (can return object)
     * (a?.b!).c        // ❌ Stops (denull exits optional chain)
     * (a?.b is T).c    // ❌ Stops (returns boolean)
     * (a?.b[0] = x).c  // ❌ Stops (returns assigned value)
     * ```
     */
    private hasOptionalChaining(expr: ast.Expression): boolean {
        // ✅ PROPAGATE: Member access with optional chaining operator
        if (ast.isMemberAccess(expr)) {
            if (expr.isNullable) {
                return true;
            }
            return this.hasOptionalChaining(expr.expr);
        }

        // ✅ PROPAGATE: Function calls - a?.b().c
        if (ast.isFunctionCall(expr)) {
            return this.hasOptionalChaining(expr.expr);
        }

        // ✅ PROPAGATE: Index access - a?.b[0].c
        if (ast.isIndexAccess(expr)) {
            return this.hasOptionalChaining(expr.expr);
        }

        // ✅ PROPAGATE: Reverse index access (Type-C specific) - a?.b[-1].c
        if (ast.isReverseIndexAccess(expr)) {
            return this.hasOptionalChaining(expr.expr);
        }

        // ✅ PROPAGATE: Type casts - (a?.b as T).c
        // Transforms type but continues with same value chain
        if (ast.isTypeCastExpression(expr)) {
            return this.hasOptionalChaining(expr.left);
        }

        // ✅ PROPAGATE: Postfix operators - (a?.b++).c
        // Can return object via operator overloading
        if (ast.isPostfixOp(expr)) {
            return this.hasOptionalChaining(expr.expr);
        }

        // ✅ PROPAGATE: Unary operators - (!a?.b).c
        // Can return object via operator overloading
        if (ast.isUnaryExpression(expr)) {
            return this.hasOptionalChaining(expr.expr);
        }

        // ❌ STOP: Index/Reverse index assignments - return assigned value, not container
        // (a?.b[0] = x) returns x, not a?.b
        // No recursion needed

        // ❌ STOP: Instance checks - return boolean, not object
        // (a?.b is T) returns bool, chain ends
        // No recursion needed

        // ❌ STOP: Denull operator - explicitly exits optional safety
        // a?.b! asserts non-null, subsequent accesses are non-optional
        // No recursion needed

        return false;
    }

    /**
     * Determines if an expression needs contextual typing to be properly inferred.
     *
     * These expressions should be skipped during the first pass of generic inference
     * to avoid circular dependencies.
     *
     * Examples:
     * - Lambda without type annotations: `fn(x) = x * 2`
     * - Empty array literal: `[]`
     * - Array with ambiguous elements that need context: `[1, 2, 3]` when element type is generic
     * - Anonymous struct literal: `{expr1, expr2}`
     */
    private expressionNeedsContextualTyping(expr: ast.Expression): boolean {
        // Lambda expressions without full type annotations
        if (ast.isLambdaExpression(expr)) {
            // Check if any parameter lacks a type annotation
            const hasUntypedParams = expr.header.args?.some(arg => !arg.type) ?? false;
            if (hasUntypedParams) {
                return true;
            }
        }

        // Empty array literals always need context
        if (ast.isArrayConstructionExpression(expr)) {
            if (!expr.values || expr.values.length === 0) {
                return true;
            }
        }

        // Anonymous struct literals always need context
        if (ast.isAnonymousStructConstructionExpression(expr)) {
            return true;
        }

        return false;
    }

    /**
     * Helper to infer an expression's type with a given expected type context.
     * Used during iterative generic inference.
     */
    private inferExpressionWithContext(expr: ast.Expression, expectedType: TypeDescription): TypeDescription {
        // For lambdas, we can infer the full type if we have the expected function type
        if (ast.isLambdaExpression(expr)) {
            if (isFunctionType(expectedType)) {
                // Use the expected type to infer lambda parameters and return type
                return this.inferExpression(expr);
            }
        }

        // For arrays, we can use expected element type
        if (ast.isArrayConstructionExpression(expr)) {
            if (isArrayType(expectedType)) {
                return this.inferExpression(expr);
            }
        }

        // For anonymous structs, use expected struct type
        if (ast.isAnonymousStructConstructionExpression(expr)) {
            const structType = this.typeUtils.asStructType(expectedType);
            if (structType) {
                return this.inferExpression(expr);
            }
        }

        // Default: try to infer normally
        return this.inferExpression(expr);
    }

    /**
     * Check if a type contains any of the specified generic type parameters.
     * Used to determine if we have enough information to infer a contextual expression.
     */
    private typeContainsGenerics(type: TypeDescription, genericNames: string[]): boolean {
        if (isGenericType(type)) {
            return genericNames.includes(type.name);
        }

        if (isArrayType(type)) {
            return this.typeContainsGenerics(type.elementType, genericNames);
        }

        if (isNullableType(type)) {
            return this.typeContainsGenerics(type.baseType, genericNames);
        }

        if (isFunctionType(type)) {
            // Check parameters and return type
            for (const param of type.parameters) {
                if (this.typeContainsGenerics(param.type, genericNames)) {
                    return true;
                }
            }
            return this.typeContainsGenerics(type.returnType, genericNames);
        }

        if (isTupleType(type)) {
            return type.elementTypes.some(t => this.typeContainsGenerics(t, genericNames));
        }

        const structType = this.typeUtils.asStructType(type);
        if (structType) {
            return structType.fields.some(f => this.typeContainsGenerics(f.type, genericNames));
        }

        if (isReferenceType(type)) {
            // Check generic arguments
            return type.genericArgs.some(arg => this.typeContainsGenerics(arg, genericNames));
        }

        // Other types don't contain generics
        return false;
    }

    /**
     * Get the containing do expression if the node is within one (but not within a nested function).
     * Returns undefined if the node is within a function or not within a do expression.
     *
     * This is used to determine if a return statement should use contextual typing from the do expression
     * instead of from a function's return type.
     */
    private getContainingDoExpression(node: AstNode): ast.DoExpression | undefined {
        let current: AstNode | undefined = node.$container;

        while (current) {
            // If we hit a function boundary, stop - we're not in a do expression context
            if (ast.isFunctionDeclaration(current) ||
                ast.isLambdaExpression(current) ||
                ast.isCoroutineExpression(current)) {
                return undefined;
            }

            // Found a do expression
            if (ast.isDoExpression(current)) {
                return current;
            }

            current = current.$container;
        }

        return undefined;
    }

    /**
     * Collect all return statements from a do expression's block, but ONLY from this do level.
     * Does NOT collect returns from nested functions or nested do expressions!
     *
     * This is different from collectReturnStatements which is for functions.
     * Do expressions have their own return scope separate from nested constructs.
     */
    private collectReturnStatementsFromDo(block: ast.BlockStatement): ast.ReturnStatement[] {
        const returns: ast.ReturnStatement[] = [];

        const visit = (node: AstNode) => {
            // Stop if we hit a nested function - don't collect its returns!
            if (ast.isFunctionDeclaration(node) ||
                ast.isLambdaExpression(node) ||
                ast.isCoroutineExpression(node)) {
                return; // Don't traverse into nested functions
            }

            // Stop if we hit a nested do expression - it has its own return scope
            if (ast.isDoExpression(node)) {
                return; // Don't traverse into nested do expressions
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
     * Check if an interface method is shadowed by an impl method.
     * A method is shadowed when an impl method has the same name and signature.
     *
     * @param interfaceMethod The method from an interface
     * @param implMethods The impl methods to check against
     * @returns true if the interface method is shadowed by an impl method
     */
    private isInterfaceMethodShadowedByImpl(
        interfaceMethod: MethodType,
        implMethods: readonly MethodType[]
    ): boolean {
        for (const implMethod of implMethods) {
            // Check if methods share any common name
            const hasCommonName = interfaceMethod.names.some(ifaceName =>
                implMethod.names.includes(ifaceName)
            );
            
            if (!hasCommonName) {
                continue;
            }
            
            // Check if signatures match (same parameter count and types)
            // Different parameter counts -> not equal
            if (interfaceMethod.parameters.length !== implMethod.parameters.length) {
                continue;
            }
            
            // Check each parameter type
            let allParamsMatch = true;
            for (let i = 0; i < interfaceMethod.parameters.length; i++) {
                const ifaceParamType = interfaceMethod.parameters[i].type;
                const implParamType = implMethod.parameters[i].type;
                
                // Use type equality check
                if (!this.typeUtils.areTypesEqual(ifaceParamType, implParamType).success) {
                    allParamsMatch = false;
                    break;
                }
            }
            
            if (allParamsMatch) {
                return true;  // This interface method is shadowed
            }
        }
        
        return false;  // Not shadowed
    }

    /**
     * Check if an impl method is shadowed by a class override method.
     * A method is shadowed when a class method with the override flag has the same signature.
     *
     * @param implMethod The method header from an implementation
     * @param classMethods The class methods to check against
     * @returns true if the impl method is shadowed by an override
     */
    private isMethodShadowedByOverride(
        implMethod: ast.MethodHeader,
        classMethods: ast.ClassMethod[]
    ): boolean {
        // Check if any override method in the class has the same signature
        for (const classMethod of classMethods) {
            // Only override methods can shadow impl methods
            if (!classMethod.isOverride) {
                continue;
            }
            
            const classMethodHeader = classMethod.method;
            
            // Check if methods share any common name
            const hasCommonName = implMethod.names.some(implName =>
                classMethodHeader.names.includes(implName)
            );
            
            if (!hasCommonName) {
                continue;
            }
            
            // Check if signatures match (same generic count and parameter types)
            if (this.methodSignaturesMatch(implMethod, classMethodHeader)) {
                return true;  // This impl method is shadowed
            }
        }
        
        return false;  // Not shadowed
    }

    /**
     * Check if two method headers have the same signature.
     * Used for detecting shadowing and overrides.
     *
     * @param method1 First method header
     * @param method2 Second method header
     * @returns true if signatures match (same generic count and parameter types)
     */
    private methodSignaturesMatch(
        method1: ast.MethodHeader,
        method2: ast.MethodHeader
    ): boolean {
        // Different generic parameter counts -> not equal
        const genericCount1 = method1.genericParameters?.length ?? 0;
        const genericCount2 = method2.genericParameters?.length ?? 0;
        if (genericCount1 !== genericCount2) {
            return false;
        }

        // Different parameter counts -> not equal
        const params1 = method1.header?.args ?? [];
        const params2 = method2.header?.args ?? [];
        if (params1.length !== params2.length) {
            return false;
        }

        // Check each parameter type
        for (let i = 0; i < params1.length; i++) {
            const type1 = this.getType(params1[i].type);
            const type2 = this.getType(params2[i].type);
            
            // Use string comparison for type equality
            if (type1.toString() !== type2.toString()) {
                return false;
            }
        }

        return true;
    }
}

