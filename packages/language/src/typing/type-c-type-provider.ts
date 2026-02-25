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
import { ErrorCode } from '../codes/errors.js';
import { WarningCode } from '../codes/warnings.js';
import * as ast from '../generated/ast.js';
import type { TypeCServices } from '../type-c-module.js';
import { isAssignmentOperator, computeBinaryResultType, computeUnaryResultType, computeBinaryResultTypeStrict, computeUnaryResultTypeStrict, isBinaryOpValid, isUnaryOpValid } from './operator-utils.js';
import {
    ArrayTypeDescription,
    FunctionParameterType,
    FunctionTypeDescription,
    GenericTypeDescription,
    getMinArity,
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
    isInterfaceType,
    isJoinType,
    isMetaClassType,
    isMetaEnumType,
    isMetaVariantConstructorType,
    isMetaVariantType,
    isNamespaceType,
    isNeverType,
    isNullableType,
    isNumericType,
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
    ReferenceTypeDescription,
    StructFieldType,
    TypeDescription,
    TypeKind,
    VariantConstructorTypeDescription
} from './type-c-types.js';
import { TypeCTypeFactory } from './type-factory.js';
import { TypeCTypeUtils } from './type-utils.js';
import type { StoredDiagnostic } from './diagnostics/diagnostic-types.js';

// --- Helper functions (moved from diagnostic-validation-helpers.ts during Phase 11 cleanup) ---

/**
 * Check if an expression is a const source that requires const assignment.
 */
function getConstSource(expr: ast.Expression): { description: string } | undefined {
    if (ast.isQualifiedReference(expr)) {
        const ref = expr.reference?.ref;
        if (!ref) return undefined;
        if (ast.isVariableDeclaration(ref) && ref.isConst) {
            return { description: `const variable '${ref.name}'` };
        }
        if (ast.isFunctionParameter(ref) && !ref.isMut) {
            return { description: `immutable parameter '${ref.name}'` };
        }
        return undefined;
    }
    if (ast.isMemberAccess(expr)) {
        const baseConstSource = getConstSource(expr.expr);
        if (baseConstSource) {
            const element = expr.element?.ref;
            const memberName = element && ast.isClassAttributeDecl(element) ? element.name : 'member';
            return { description: `${baseConstSource.description}.${memberName}` };
        }
        return undefined;
    }
    return undefined;
}

/**
 * Helper method to get the name of a referenced entity.
 */
function getReferenceName(ref: AstNode): string {
    if (ast.isVariableDeclaration(ref)) return ref.name;
    if (ast.isFunctionParameter(ref)) return ref.name ?? '';
    if (ast.isClassAttributeDecl(ref)) return ref.name;
    if (ast.isIteratorVar(ref)) return ref.name || 'unknown';
    if (ast.isVariablePattern(ref)) return ref.name || 'unknown';
    return 'unknown';
}

/**
 * Helper method to check if a type (after resolution) is a nullable basic type.
 */
function checkForNullableBasicType(
    typeUtils: TypeCTypeUtils,
    type: TypeDescription
): string | undefined {
    type = typeUtils.resolveIfReference(type);
    if (isNullableType(type) && typeUtils.isTypeBasic(type.baseType)) {
        return `Nullable basic type '${type.toString()}' is not allowed. ` +
               `Basic types cannot be nullable. ` +
               `Consider using a reference type or handling null with the ?? operator.`;
    }
    return undefined;
}

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

    /** General diagnostic store: diagnostics produced as side-effects of type inference */
    private readonly diagnosticStore: DocumentCache<string, StoredDiagnostic[]>;

    private overloadResolutionDepth = 0;

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
        this.diagnosticStore = new DocumentCache(services.shared);
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
            return this.typeFactory.createErrorType('Node is undefined', undefined, undefined, false);
        }

        const documentUri = AstUtils.getDocument(node).uri;

        // Get from cache or compute if not cached
        return this.typeCache.get(documentUri, node, () => this.computeType(node));
    }

    /**
     * Compute type for a node AND store any error diagnostics.
     * Called from the validation walk (triggerTypeInference) to ensure
     * diagnostics are stored for all expression/pattern nodes, even those
     * whose types were pre-cached by batch inference (e.g. pattern variables).
     */
    checkAndStoreErrors(node: AstNode): void {
        const type = this.getType(node);
        this.storeErrorDiagnosticsIfNeeded(node, type);
    }

    /**
     * Validate a class method's return type AFTER all types are cached.
     * This must run separately from inferClassMethod() because calling
     * inferReturnTypeFromBody() during method inference causes cycles
     * when the method body references other methods of the same class.
     */
    validateClassMethodReturnType(node: ast.ClassMethod): void {
        const methodHeader = node.method;
        if (!methodHeader?.header) return;
        if (!node.expr && !node.body) return; // abstract/interface method

        const declaredReturnType = methodHeader.header.returnType
            ? this.getType(methodHeader.header.returnType)
            : undefined;

        if (declaredReturnType) {
            // Infer from body to validate against declared type (all types cached)
            let inferredReturnType: TypeDescription;
            if (node.expr) {
                inferredReturnType = this.getType(node.expr);
            } else {
                inferredReturnType = this.inferReturnTypeFromBody(node.body);
            }

            this.validateReturnYieldSemantics(
                node.body, false, declaredReturnType, inferredReturnType, node,
                node.expr ?? methodHeader.header.returnType!, 'method'
            );

            this.validateReturnStatements(node.body, declaredReturnType, node);
        } else {
            // No declared type — infer and validate
            let inferredReturnType: TypeDescription;
            if (node.expr) {
                inferredReturnType = this.getType(node.expr);
            } else if (node.body) {
                inferredReturnType = this.inferReturnTypeFromBody(node.body);
            } else {
                inferredReturnType = this.typeFactory.createVoidType(node);
            }

            this.validateReturnYieldSemantics(
                node.body, false, undefined, inferredReturnType, node, node, 'method'
            );
        }

        // --- Validation (Phase 8): override + default parameter checks ---
        this.validateClassMethodDeclaration(node);
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
        this.diagnosticStore.clear(documentUri);
    }

    /**
     * Store a diagnostic produced as a side-effect of type inference.
     * Diagnostics are keyed by document URI and stored per-document.
     */
    addDiagnostic(node: AstNode, severity: 'error' | 'warning' | 'info' | 'hint', message: string, code?: string | number, property?: string): void {
        const documentUri = AstUtils.getDocument(node).uri;
        const key = 'inferenceDiagnostics';
        let diagnostics = this.diagnosticStore.get(documentUri, key);
        if (!diagnostics) {
            diagnostics = [];
            this.diagnosticStore.set(documentUri, key, diagnostics);
        }
        diagnostics.push({ severity, message, node, code, property });
    }

    /**
     * Get all diagnostics produced during type inference for a document.
     */
    getDiagnosticsForDocument(documentUri: URI): StoredDiagnostic[] {
        return this.diagnosticStore.get(documentUri, 'inferenceDiagnostics') || [];
    }

    /**
     * Check if a computed type contains errors and store diagnostics.
     * Called as a side-effect after type inference for expression nodes.
     * Replaces all boundCheckExpressionForErrors / boundCheckOptionalChainingBasicType registrations.
     */
    private storeErrorDiagnosticsIfNeeded(node: AstNode, type: TypeDescription): void {
        // Only report errors for expression nodes and VariablePattern (pattern variables)
        if (!ast.isExpression(node) && !ast.isVariablePattern(node)) return;

        // 1. Check if type itself is a reportable error type
        if (isErrorType(type)) {
            if (!type.reportable) return; // Skip internal/fallback errors
            this.addDiagnostic(node, 'error', type.message || 'Type error', ErrorCode.TC_EXPRESSION_TYPE_ERROR);
            return; // Don't check further if type is already error
        }

        const baseExpr = this.typeUtils.resolveIfReference(type);

        // 2. Check errors array (from generic substitution failures etc.)
        if (baseExpr.errors && baseExpr.errors.length > 0) {
            for (const errorMsg of baseExpr.errors) {
                this.addDiagnostic(node, 'error', errorMsg, ErrorCode.TC_EXPRESSION_TYPE_ERROR);
            }
        }

        // 3. Check variant constructor's baseVariant errors
        if (isVariantConstructorType(baseExpr) && baseExpr.baseVariant.errors && baseExpr.baseVariant.errors.length > 0) {
            for (const errorMsg of baseExpr.baseVariant.errors) {
                this.addDiagnostic(node, 'error', errorMsg, ErrorCode.TC_EXPRESSION_TYPE_ERROR);
            }
        }

        // 4. Check optional chaining on basic types (needs ?? operator)
        if (ast.isExpression(node) && this.hasOptionalChaining(node) && this.typeUtils.isTypeBasic(type)) {
            const parent = node.$container;
            const isWrappedWithNullishCoalescing =
                parent &&
                ast.isBinaryExpression(parent) &&
                parent.op === '??' &&
                parent.left === node;

            if (!isWrappedWithNullishCoalescing) {
                this.addDiagnostic(node, 'error',
                    `Optional chaining expression returns basic type '${type.toString()}' which could be null. ` +
                    `Basic types cannot be nullable, so you must handle the null case using the nullish coalescing operator '??'. ` +
                    `Example: ${node.$cstNode?.text || 'expression'} ?? defaultValue`,
                    ErrorCode.TC_OPTIONAL_CHAINING_BASIC_TYPE_REQUIRES_NULLISH_COALESCING
                );
            }
        }

        // 5. MemberAccess-specific validation: optional chaining, local access, variant constructor usage
        if (ast.isMemberAccess(node)) {
            this.validateMemberAccessNode(node);
        }
    }

    // Note: hasOptionalChaining() already exists later in this file (used for inference).
    // The storeErrorDiagnosticsIfNeeded method above reuses it.

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
        if (this.overloadResolutionDepth > 0) {
            return undefined;
        }

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
                    let expectedLambdaType = this.getExpectedType(lambda);
                    if (expectedLambdaType && isNullableType(expectedLambdaType)) {
                        expectedLambdaType = expectedLambdaType.baseType;
                    }
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

        // Function parameter default value: fn foo(x: u32 = expr)
        if (ast.isFunctionParameter(parent) && parent.type && parent.defaultValue === node) {
            return this.getType(parent.type);
        }

        // Variable declaration with annotation
        // let x: T = expr
        if (ast.isVariableDeclaration(parent) && parent.annotation && parent.initializer === node) {
            return this.getType(parent.annotation);
        }
        
        // Class attribute declaration with type annotation
        // let x: T = expr (in class)
        if (ast.isClassAttributeDecl(parent) && parent.type && parent.initializer === node) {
            return this.getType(parent.type);
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

                    // If the FunctionCall has explicit generic args, apply substitutions
                    // to parameter types. This handles method calls like runner.assert_eq<u8>(1, 1)
                    // where genericArgs are on the FunctionCall node (not the callee expression).
                    const genericParams = fnType.genericParameters || [];
                    if (genericParams.length > 0 && parent.genericArgs && parent.genericArgs.length > 0
                        && parent.genericArgs.length === genericParams.length) {
                        const explicitSubs = new Map<string, TypeDescription>();
                        for (let i = 0; i < genericParams.length; i++) {
                            explicitSubs.set(genericParams[i].name, this.getType(parent.genericArgs[i]));
                        }
                        return this.typeUtils.substituteGenerics(expectedParamType, explicitSubs);
                    }

                    // If the function has generic parameters and we're inferring an expression that needs context,
                    // perform iterative partial generic inference from other arguments
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
                                    argumentTypes.push(this.typeFactory.createErrorType('__contextual_placeholder__', undefined, node, false));
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
                                        argumentTypes.push(this.typeFactory.createErrorType('__contextual_placeholder__', undefined, args[i], false));
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

            // Check for lambda expressions first (innermost function-like container)
            // Must come before FunctionDeclaration check because getContainerOfType
            // for FunctionDeclaration walks past lambdas to the outer function
            const lambda = AstUtils.getContainerOfType(parent, ast.isLambdaExpression);
            if (lambda) {
                if (lambda.header?.returnType) {
                    return this.getType(lambda.header.returnType);
                }
                // Lambda without explicit return type -- no contextual type
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

        // Unary numeric expressions: propagate expected type to the operand.
        // This allows contextual typing for negative literals:
        //   assert_eq<i16>(x, -4)  // infer 4 as i16 from the call-site context
        if (parent && ast.isUnaryExpression(parent) && parent.expr === node) {
            if (parent.op === '-' || parent.op === '+') {
                if (ast.isIntegerLiteral(node) || ast.isFloatingPointLiteral(node) || ast.isUnaryExpression(node)) {
                    const unaryContainer = parent.$container;
                    // Keep this contextual typing narrow to function-call arguments.
                    // This fixes generic-call cases like assert_eq<i16>(x, -4) without
                    // altering other contexts (e.g. foreach range-step validation).
                    if (unaryContainer && ast.isFunctionCall(unaryContainer) && unaryContainer.args?.includes(parent)) {
                        return this.getExpectedType(parent);
                    }
                    return undefined;
                }
            }
        }

        // Array element in array construction: [expr1, expr2, ...]
        // If parent array has expected type T[], propagate T to elements
        if (parent && ast.isArrayElementExpression(parent)) {
            const arrayExpr = parent.$container;
            if (ast.isArrayConstructionExpression(arrayExpr)) {
                const expectedArrayType = this.getExpectedArrayContextType(arrayExpr);
                if (expectedArrayType) {
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
                    // Unwrap nullable and resolve reference types
                    let resolvedExpected = expectedStructType;
                    if (isNullableType(resolvedExpected)) {
                        resolvedExpected = resolvedExpected.baseType;
                    }
                    if (isReferenceType(resolvedExpected)) {
                        resolvedExpected = this.resolveReference(resolvedExpected);
                    }
                    if (isNullableType(resolvedExpected)) {
                        resolvedExpected = resolvedExpected.baseType;
                    }

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
                // Unwrap nullable and resolve reference types
                let resolvedExpected = expectedStructType;
                if (isNullableType(resolvedExpected)) {
                    resolvedExpected = resolvedExpected.baseType;
                }
                if (isReferenceType(resolvedExpected)) {
                    resolvedExpected = this.resolveReference(resolvedExpected);
                }
                if (isNullableType(resolvedExpected)) {
                    resolvedExpected = resolvedExpected.baseType;
                }

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

                // Filter by argument count to find matching candidates (accounts for default parameters)
                const argCount = parent.args.length;
                const candidates = initMethods.filter(m => {
                    const minArity = getMinArity(m.parameters);
                    return argCount >= minArity && argCount <= m.parameters.length;
                });

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
            let expectedLambdaType = this.getExpectedType(parent);
            if (expectedLambdaType && isNullableType(expectedLambdaType)) {
                expectedLambdaType = expectedLambdaType.baseType;
            }
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
            let expectedLambdaType = this.getExpectedType(parent);
            if (expectedLambdaType && isNullableType(expectedLambdaType)) {
                expectedLambdaType = expectedLambdaType.baseType;
            }
            if (expectedLambdaType && isFunctionType(expectedLambdaType)) {
                // Return the expected return type for the lambda's body expression
                return expectedLambdaType.returnType;
            }
            // If no expected type from outer context, check lambda's explicit return type
            if (parent.header?.returnType) {
                return this.getType(parent.header.returnType);
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
     * Returns the expected array type for an expression context.
     * Supports both direct arrays (`T[]`) and nullable arrays (`T[]?`).
     */
    private getExpectedArrayContextType(node: AstNode): ArrayTypeDescription | undefined {
        const expectedType = this.getExpectedType(node);
        if (!expectedType) {
            return undefined;
        }

        let resolvedExpectedType = this.typeUtils.resolveIfReference(expectedType);
        if (isNullableType(resolvedExpectedType)) {
            resolvedExpectedType = this.typeUtils.resolveIfReference(resolvedExpectedType.baseType);
        }

        return isArrayType(resolvedExpectedType) ? resolvedExpectedType : undefined;
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
            // Unwrap VariableDeclarationStatement to get named VariableDeclaration nodes
            const fields: AstNode[] = [];
            for (const def of type.declaration.definitions) {
                if (ast.isVariableDeclarationStatement(def)) {
                    fields.push(...def.declarations.variables);
                } else {
                    fields.push(def);
                }
            }
            return fields;
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
        if (ast.isClassAttributeDecl(node)) {
            // If there's an explicit type annotation, use it
            if (node.type) {
                return this.getType(node.type);
            }
            
            // Otherwise, infer type from initializer (if present)
            if (node.initializer) {
                return this.inferExpression(node.initializer);
            }
            
            // No type or initializer - error (will be caught by validation)
            return this.typeFactory.createErrorType(
                `Class attribute '${node.name}' has no type annotation or initializer`,
                undefined,
                node
            );
        }
        if (ast.isImplementationAttributeDecl(node)) return this.getType(node.type);
        if (ast.isFunctionParameter(node)) {
            // If parameter has explicit type annotation, use it
            if (node.type) {
                return this.getType(node.type);
            }

            // If parameter has a default value, infer type from it
            if (node.defaultValue) {
                return this.inferExpression(node.defaultValue);
            }

            // Otherwise, try to infer from context (lambda passed to function expecting specific function type)
            const expectedType = this.getExpectedType(node);
            if (expectedType) {
                return expectedType;
            }

            // If we can't infer type from context, return error
            return this.typeFactory.createErrorType(
                `Parameter '${node.name ?? '<unnamed>'}' requires type annotation or must be in a context where type can be inferred`,
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
                arg.name ?? '',
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

        return this.typeFactory.createErrorType(`Cannot infer type for ${node.$type}`, undefined, node, false);
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

        const result = this.typeUtils.simplifyType(this.typeFactory.createJoinType(types, node));

        // Validate join type constraints
        this.validateJoinType(node);

        return result;
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
                    this.getType(attrDecl),
                    attrDecl.isStatic ?? false,
                    attrDecl.isConst ?? false,
                    attrDecl.isLocal ?? false
                )
            ) ?? [];

            // Create stub methods to allow method-to-method calls during inference
            // Use explicit return types when available, void as placeholder otherwise
            const stubMethods = node.methods?.map(m => {
                const methodHeader = m.method;
                const genericParams = ((methodHeader?.genericParameters ?? [])?.map(g => this.inferGenericType(g)).filter((g): g is GenericTypeDescription => isGenericType(g)) ?? []);
                const params = methodHeader.header?.args?.map(arg => this.typeFactory.createFunctionParameterType(
                    arg.name ?? '',
                    this.getType(arg.type),
                    arg.isMut,
                    !!arg.defaultValue
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
                    this.getType(attrDecl),
                    attrDecl.isStatic ?? false,
                    attrDecl.isConst ?? false,
                    attrDecl.isLocal ?? false
                )
            ) ?? [];

            // Infer class-defined methods (these can override impl methods)
            const methods = node.methods?.map(m => {
                const methodHeader = m.method;
                const genericParams = ((methodHeader?.genericParameters ?? []).map(g => this.inferGenericType(g)).filter((g): g is GenericTypeDescription => isGenericType(g)) ?? []);
                const params = methodHeader.header?.args?.map(arg => this.typeFactory.createFunctionParameterType(
                    arg.name ?? '',
                    this.getType(arg.type),
                    arg.isMut,
                    !!arg.defaultValue
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
                    this.getType(attrDecl),
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
                    arg.name ?? '',
                    this.getType(arg.type),
                    arg.isMut,
                    !!arg.defaultValue
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
                    this.getType(attrDecl),
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
                    arg.name ?? '',
                    this.getType(arg.type),
                    arg.isMut,
                    !!arg.defaultValue
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
            arg.name ?? '',
            arg.type ? this.getType(arg.type) : this.getType(arg.defaultValue),
            arg.isMut,
            !!arg.defaultValue
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
            arg.name ?? '',
            arg.type ? this.getType(arg.type) : this.getType(arg.defaultValue),
            arg.isMut,
            !!arg.defaultValue
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
            const declaredReturnType = methodHeader.header?.returnType ? this.getType(methodHeader.header.returnType) : undefined;

            if (declaredReturnType) {
                // Explicit return type provided
                returnType = declaredReturnType;
            } else {
                // Infer return type from method body or expression

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

            // NOTE: Class method validation is deferred to validateClassMethodReturnType()
            // because running it during inference causes cycles (method A's body references
            // method B which references method A → cycle detection fires prematurely).

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
            arg.name ?? '',
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

        // Handle references to namespaces (e.g., math in math.Animal)
        // Namespaces can contain type declarations that are accessed via member access
        if (ast.isNamespaceDecl(declaration)) {
            // Return the namespace type so member access can continue
            return this.typeFactory.createNamespaceType(declaration.name, declaration, node);
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

        // Handle enum case references (e.g., Response.Ok in match patterns)
        if (ast.isEnumCase(declaration)) {
            const enumType = AstUtils.getContainerOfType(declaration, ast.isEnumType);
            return enumType ? this.getType(enumType) : this.typeFactory.createErrorType('Enum case outside enum', undefined, node);
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
        let actualType = this.getType(refType.declaration.definition);

        // If there are generic arguments, substitute them
        if (refType.genericArgs.length > 0 && refType.declaration.genericParameters) {
            // MONOMORPHIZATION: Register class instantiation
            if (ast.isClassType(refType.declaration.definition)) {
                this.services.typing.MonomorphizationRegistry.registerClassInstantiation(
                    refType.declaration,
                    refType.genericArgs
                );
            }

            const substitutions = new Map<string, TypeDescription>();
            refType.declaration.genericParameters.forEach((param, i) => {
                if (i < refType.genericArgs.length) {
                    substitutions.set(param.name, refType.genericArgs[i]);
                }
            });

            actualType = this.typeUtils.substituteGenerics(actualType, substitutions);
        }

        if(actualType.errors) {
            if(refType.errors){
                refType.errors.push(...(actualType.errors ?? []))
            }
            else {
                refType.errors = [...actualType.errors]
            }
        }

        return actualType;
    }

    /** Tracks generic types currently being inferred to prevent infinite recursion
     *  from self-referential constraints like `T: interface { fn +(T) -> T }`. */
    private readonly inferringGenerics = new Set<ast.GenericType>();

    private inferGenericType(node: ast.GenericType): TypeDescription {
        if (this.inferringGenerics.has(node)) {
            // Cycle: constraint references its own generic param — return without constraint
            return this.typeFactory.createGenericType(node.name, undefined, node, node);
        }
        this.inferringGenerics.add(node);
        try {
            const constraint = node.constraint ? this.getType(node.constraint) : undefined;
            const result = this.typeFactory.createGenericType(node.name, constraint, node, node);
            // Explicitly overwrite the cache entry for this node. During recursive constraint
            // processing (e.g., T: interface { fn +(T) -> T }), the cycle detection path
            // caches a GenericType with constraint=undefined. We must ensure the final
            // result with the correct constraint overwrites that stale cache entry.
            if (constraint) {
                const documentUri = AstUtils.getDocument(node).uri;
                this.typeCache.set(documentUri, node, result);
            }
            return result;
        } finally {
            this.inferringGenerics.delete(node);
        }
    }

    private inferFFIDecl(node: ast.ExternFFIDecl): TypeDescription {
        const methods = node.methods?.map(m => {
            const params = m.header.args?.map(arg => this.typeFactory.createFunctionParameterType(
                arg.name ?? '',
                this.getType(arg.type),
                arg.isMut,
                !!arg.defaultValue
            )) ?? [];
            const returnType = m.header.returnType
                ? this.getType(m.header.returnType)
                : this.typeFactory.createVoidType(m);

            return this.typeFactory.createMethodType([m.name], params, returnType, undefined);
        }) ?? [];

        return this.typeFactory.createFFIType(
            node.name,
            node.dynlib,
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
                    arg.name ?? '',
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
            arg.name ?? '',
            arg.type ? this.getType(arg.type) : this.getType(arg.defaultValue),
            arg.isMut,
            !!arg.defaultValue
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
                    this.typeFactory.createErrorType('__recursion_placeholder__', undefined, node, false),
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
            const declaredReturnType = node.header?.returnType ? this.getType(node.header.returnType) : undefined;

            if (declaredReturnType) {
                // Explicit return/yield type provided
                returnType = declaredReturnType;
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

            // --- Validation (Phase 5): return/yield checks as side-effect of inference ---
            if (declaredReturnType) {
                // Infer from body to validate against declared type (sub-expression types already cached)
                let inferredReturnType: TypeDescription;
                if (node.expr) {
                    inferredReturnType = this.getType(node.expr);
                } else if (node.body) {
                    inferredReturnType = isCoroutine
                        ? this.inferYieldTypeFromBody(node.body, node.expr)
                        : this.inferReturnTypeFromBody(node.body, node.expr);
                } else {
                    inferredReturnType = this.typeFactory.createVoidType(node);
                }

                // Validate structural rules + inferred vs declared mismatch
                this.validateReturnYieldSemantics(
                    node.body, isCoroutine, declaredReturnType, inferredReturnType, node,
                    node.expr ?? node.header!.returnType!, 'function'
                );

                // Validate individual return/yield statements against declared type
                if (isCoroutine) {
                    this.validateYieldExpressions(node.body, declaredReturnType, node);
                } else {
                    this.validateReturnStatements(node.body, declaredReturnType, node);
                }
            } else {
                // No declared type — validate structural rules with inferred type
                this.validateReturnYieldSemantics(
                    node.body, isCoroutine, undefined, returnType, node, node, 'function'
                );
            }

            // --- Validation (Phase 8): default parameter checks as side-effect of inference ---
            this.validateFunctionDefaults(node);

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
            // Stop if we hit a nested function or lambda (fn/cfn) - don't collect its returns!
            if (ast.isFunctionDeclaration(node) || ast.isLambdaExpression(node)) {
                return; // Don't traverse into nested functions/lambdas
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
            // Stop if we hit a nested function or lambda (fn/cfn) - don't collect its yields!
            if (ast.isFunctionDeclaration(node) || ast.isLambdaExpression(node)) {
                return; // Don't traverse into nested functions/lambdas
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

    // ========================================================================
    // Return/Yield Validation (side-effects of inference)
    // ========================================================================

    /**
     * Validate return statements against a declared/inferred return type.
     * Called as a side-effect from inferFunctionDeclaration / inferClassMethod / inferLambdaExpression.
     */
    private validateReturnStatements(body: ast.BlockStatement | undefined, declaredReturnType: TypeDescription, fnNode: AstNode): void {
        if (!body) return;
        const returnStatements = this.collectReturnStatements(body);
        for (const stmt of returnStatements) {
            // Skip returns inside do expressions (they return from the do block, not the function)
            if (this.getContainingDoExpression(stmt)) continue;

            if (stmt.expr) {
                const actualType = this.getType(stmt.expr);
                // Skip non-reportable error types (e.g. recursion placeholders)
                if (isErrorType(actualType) && !actualType.reportable) continue;
                const compatResult = this.typeUtils.isAssignable(actualType, declaredReturnType);
                if (!compatResult.success) {
                    const errorMsg = compatResult.message
                        ? `Return type mismatch: ${compatResult.message}`
                        : `Return type mismatch: Expected '${declaredReturnType.toString()}', but got '${actualType.toString()}'`;
                    this.addDiagnostic(stmt.expr, 'error', errorMsg, ErrorCode.TC_RETURN_TYPE_MISMATCH);
                }
            } else {
                // Return with no value
                if (declaredReturnType.kind !== TypeKind.Void) {
                    this.addDiagnostic(stmt, 'error',
                        `Missing return value: Function declared to return '${declaredReturnType.toString()}', but return statement has no value`,
                        ErrorCode.TC_RETURN_MISSING_VALUE);
                }
            }
        }
    }

    /**
     * Validate yield expressions against a declared yield type.
     * Called as a side-effect from inferFunctionDeclaration / inferLambdaExpression for coroutines.
     */
    private validateYieldExpressions(body: ast.BlockStatement | undefined, declaredYieldType: TypeDescription, fnNode: AstNode): void {
        if (!body) return;
        const yieldExpressions = this.collectYieldExpressions(body);
        for (const yieldExpr of yieldExpressions) {
            if (yieldExpr.expr) {
                const actualType = this.getType(yieldExpr.expr);
                // Skip non-reportable error types (e.g. recursion placeholders)
                if (isErrorType(actualType) && !actualType.reportable) continue;
                const compatResult = this.typeUtils.isAssignable(actualType, declaredYieldType);
                if (!compatResult.success) {
                    const errorMsg = compatResult.message
                        ? `Yield type mismatch: ${compatResult.message}`
                        : `Yield type mismatch: Expected '${declaredYieldType.toString()}', but got '${actualType.toString()}'`;
                    this.addDiagnostic(yieldExpr.expr, 'error', errorMsg, ErrorCode.TC_YIELD_TYPE_MISMATCH);
                }
            } else {
                if (declaredYieldType.kind !== TypeKind.Void) {
                    this.addDiagnostic(yieldExpr, 'error',
                        `Coroutine must yield a value of type '${declaredYieldType.toString()}'`,
                        ErrorCode.TC_YIELD_MISSING_VALUE);
                }
            }
        }
    }

    /**
     * Validate that return statements are not used in coroutines and yield is not used in regular functions.
     * Also validates inferred vs declared return type mismatch.
     * Called as a side-effect from inferFunctionDeclaration / inferLambdaExpression.
     */
    private validateReturnYieldSemantics(
        body: ast.BlockStatement | undefined,
        isCoroutine: boolean,
        declaredReturnType: TypeDescription | undefined,
        inferredReturnType: TypeDescription,
        fnNode: AstNode,
        reportNode: AstNode,
        entityKind: 'function' | 'method' | 'lambda' = 'function'
    ): void {
        if (body) {
            if (isCoroutine) {
                // Return statements not allowed in coroutines
                const returnStatements = this.collectReturnStatements(body);
                for (const stmt of returnStatements) {
                    if (this.getContainingDoExpression(stmt)) continue;
                    this.addDiagnostic(stmt, 'error',
                        `Return statement in coroutine: Coroutines must use 'yield' instead of 'return' to produce values`,
                        ErrorCode.TC_RETURN_IN_COROUTINE);
                }
            } else {
                // Yield expressions not allowed in regular functions
                const yieldExpressions = this.collectYieldExpressions(body);
                for (const yieldExpr of yieldExpressions) {
                    this.addDiagnostic(yieldExpr, 'error',
                        `Yield in regular function: Yield can only be used in coroutines (cfn). Use 'return' in regular functions instead.`,
                        ErrorCode.TC_YIELD_IN_FUNCTION);
                }
            }
        }

        // Validate inferred return type is not error
        if (isErrorType(inferredReturnType) && inferredReturnType.reportable) {
            const message = inferredReturnType.message || (isCoroutine ? 'Cannot infer yield type' : 'Cannot infer return type');
            const errorCode = entityKind === 'method'
                ? ErrorCode.TC_METHOD_RETURN_TYPE_INFERENCE_FAILED
                : isCoroutine ? ErrorCode.TC_COROUTINE_YIELD_TYPE_INFERENCE_FAILED : ErrorCode.TC_FUNCTION_RETURN_TYPE_INFERENCE_FAILED;
            this.addDiagnostic(fnNode, 'error', message, errorCode);
            return;
        }

        // Validate inferred vs declared type mismatch
        if (declaredReturnType && !isErrorType(inferredReturnType)) {
            const compatResult = this.typeUtils.isAssignable(inferredReturnType, declaredReturnType);
            if (!compatResult.success) {
                const typeKind = isCoroutine ? 'yield' : 'return';
                const label = entityKind === 'method' ? 'Method' : entityKind === 'lambda' ? 'Lambda' : isCoroutine ? 'Coroutine' : 'Function';
                const errorCode = entityKind === 'method'
                    ? ErrorCode.TC_METHOD_RETURN_TYPE_MISMATCH
                    : isCoroutine ? ErrorCode.TC_COROUTINE_YIELD_TYPE_MISMATCH : ErrorCode.TC_FUNCTION_RETURN_TYPE_MISMATCH;
                const errorMsg = compatResult.message
                    ? `${label} ${typeKind} type mismatch: ${compatResult.message}`
                    : `${label} ${typeKind} type mismatch: Declared '${declaredReturnType.toString()}', but inferred '${inferredReturnType.toString()}'`;
                this.addDiagnostic(reportNode, 'error', errorMsg, errorCode);
            }
        }
    }

    // ========================================================================
    // Binary Expression Validation (side-effect of inference)
    // ========================================================================

    /**
     * Validate binary expressions. Called from inferBinaryExpression with pre-computed types.
     * Checks: lvalue for assignments, type compatibility, operator overloads, string concat,
     * arithmetic/comparison types, bitwise float warnings, nullish coalescing.
     */
    private validateBinaryExpression(node: ast.BinaryExpression, leftRaw: TypeDescription, rightRaw: TypeDescription): void {
        const leftType = this.typeUtils.resolveIfReference(leftRaw);
        const rightType = this.typeUtils.resolveIfReference(rightRaw);

        // Skip if either side is an error type
        if (isErrorType(leftType) || isErrorType(rightType)) return;

        // Nullish coalescing: check nullable basic type and type compatibility
        if (node.op === '??') {
            if (isNullableType(leftType) && this.typeUtils.isTypeBasic(leftType.baseType)) {
                this.addDiagnostic(node.left, 'error',
                    `Nullish coalescing operator '??' cannot be used with nullable basic type '${leftType.toString()}'. ` +
                    `Basic types cannot be nullable. The expression '${node.left.$cstNode?.text || 'expression'}' ` +
                    `should not produce a nullable basic type.`,
                    ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE);
                return;
            }
            // Type compatibility check for ??
            const compatResult = this.typeUtils.isAssignable(rightType, leftType);
            if (!compatResult.success) {
                this.addDiagnostic(node.right, 'error',
                    compatResult.message
                        ? `Nullish coalescing operator type mismatch: ${compatResult.message}`
                        : `Nullish coalescing operator type mismatch: Left side has base type '${leftType.toString()}', but right side has incompatible base type '${rightType.toString()}'`,
                    ErrorCode.TC_NULLISH_COALESCING_TYPE_MISMATCH);
            }
            return;
        }

        // Assignment operators
        const assignmentOps = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='];
        if (assignmentOps.includes(node.op)) {
            // Lvalue check
            const lvalueError = this.checkLvalue(node.left);
            if (lvalueError) {
                this.addDiagnostic(node.left, 'error', lvalueError.message, lvalueError.code);
                return;
            }

            // Compound assignment: check class operator overloads
            if (node.op !== '=' && isClassType(leftType)) {
                const underlyingOp = node.op.substring(0, node.op.length - 1);
                const operatorMethods = leftType.methods.filter(m => m.names.includes(underlyingOp));

                if (operatorMethods.length === 0) {
                    this.addDiagnostic(node, 'error',
                        `Compound assignment '${node.op}' error: Class '${leftType.toString()}' does not implement operator '${underlyingOp}'`,
                        ErrorCode.TC_BINARY_OP_INCOMPATIBLE_TYPES);
                    return;
                }

                const hasMatchingOverload = operatorMethods.some(method =>
                    method.parameters.length === 1 && this.typeUtils.isAssignable(rightType, method.parameters[0].type).success
                );

                if (!hasMatchingOverload) {
                    const availableOverloads = operatorMethods
                        .map(m => `${underlyingOp}(${m.parameters.map(p => p.type.toString()).join(', ')})`)
                        .join(' or ');
                    this.addDiagnostic(node, 'error',
                        `Compound assignment '${node.op}' error: Class '${leftType.toString()}' has operator '${underlyingOp}', but none match the right operand type '${rightType.toString()}'. Available: ${availableOverloads}`,
                        ErrorCode.TC_BINARY_OP_INCOMPATIBLE_TYPES);
                    return;
                }

                // Check result type assignable back to LHS
                const matchingMethod = operatorMethods.find(method =>
                    method.parameters.length === 1 && this.typeUtils.isAssignable(rightType, method.parameters[0].type).success
                );
                if (matchingMethod) {
                    const resultType = matchingMethod.returnType;
                    const assignableResult = this.typeUtils.isAssignable(resultType, leftType);
                    if (!assignableResult.success) {
                        this.addDiagnostic(node, 'error',
                            assignableResult.message
                                ? `Compound assignment '${node.op}' error: ${assignableResult.message}`
                                : `Compound assignment '${node.op}' error: Operator '${underlyingOp}' returns '${resultType.toString()}', which is not assignable to '${leftType.toString()}'`,
                            ErrorCode.TC_ASSIGNMENT_TYPE_MISMATCH);
                    }
                }
                return;
            }

            // Standard assignment validation
            const compatResult = this.typeUtils.isAssignable(rightType, leftType);
            if (!compatResult.success) {
                this.addDiagnostic(node.right, 'error',
                    compatResult.message
                        ? `Assignment error: ${compatResult.message}`
                        : `Cannot assign type '${rightType.toString()}' to type '${leftType.toString()}'`,
                    ErrorCode.TC_ASSIGNMENT_TYPE_MISMATCH);
            }
            return;
        }

        // Class operator overload validation (non-assignment)
        if (isClassType(leftType)) {
            const operatorMethods = leftType.methods.filter(m => m.names.includes(node.op));
            if (operatorMethods.length > 0) {
                const hasMatchingOverload = operatorMethods.some(method =>
                    method.parameters.length === 1 && this.typeUtils.isAssignable(rightType, method.parameters[0].type).success
                );
                if (!hasMatchingOverload) {
                    const availableOverloads = operatorMethods
                        .map(m => `${node.op}(${m.parameters.map(p => p.type.toString()).join(', ')})`)
                        .join(' or ');
                    this.addDiagnostic(node, 'error',
                        `Binary operator '${node.op}' error: Class '${leftType.toString()}' has operator overloads, but none match the right operand type '${rightType.toString()}'. Available: ${availableOverloads}`,
                        ErrorCode.TC_BINARY_OP_INCOMPATIBLE_TYPES);
                }
                return;
            } else {
                this.addDiagnostic(node, 'error',
                    `Binary operator '${node.op}' error: Class '${leftType.toString()}' does not implement operator '${node.op}'`,
                    ErrorCode.TC_BINARY_OP_INCOMPATIBLE_TYPES);
                return;
            }
        }

        // Generic type constraint checks
        if (isGenericType(leftType)) {
            const constraint = leftType.constraint
                ?? (leftType.declaration?.constraint ? this.getType(leftType.declaration.constraint) : undefined);
            if (constraint && this.constraintDefinesOperator(constraint, node.op)) return;
        }
        if (isGenericType(rightType)) {
            const constraint = rightType.constraint
                ?? (rightType.declaration?.constraint ? this.getType(rightType.declaration.constraint) : undefined);
            if (constraint && this.constraintDefinesOperator(constraint, node.op)) return;
        }
        if (isGenericType(leftType) || isGenericType(rightType)) {
            if (this.findOperatorConstraint(node.op, leftType, rightType, node)) return;
        }

        // String concatenation: + with string operand
        if (node.op === '+') {
            const leftIsString = leftType.kind === TypeKind.String;
            const rightIsString = rightType.kind === TypeKind.String;
            if (leftIsString || rightIsString) {
                if (isGenericType(leftType) || isGenericType(rightType)) return;
                const convertibleTypes = [
                    TypeKind.String, TypeKind.Bool,
                    TypeKind.U8, TypeKind.U16, TypeKind.U32, TypeKind.U64,
                    TypeKind.I8, TypeKind.I16, TypeKind.I32, TypeKind.I64,
                    TypeKind.F32, TypeKind.F64, TypeKind.Enum
                ];
                if (!convertibleTypes.includes(leftType.kind) || !convertibleTypes.includes(rightType.kind)) {
                    this.addDiagnostic(node, 'error',
                        `String concatenation error: Cannot concatenate incompatible types '${leftType.toString()}' and '${rightType.toString()}'. Types must be convertible to string.`,
                        ErrorCode.TC_CONCATENATION_ERROR);
                }
                return;
            }
            if (isNumericType(leftType) && isNumericType(rightType)) return;
            this.addDiagnostic(node, 'error',
                `Binary operator '+' error: Requires numeric or string operands, but got '${leftType.toString()}' and '${rightType.toString()}'`,
                ErrorCode.TC_BINARY_OP_INCOMPATIBLE_TYPES);
            return;
        }

        // Arithmetic operators
        const arithmeticOps = ['-', '*', '/', '%', '<<', '>>', '&', '|', '^'];
        if (arithmeticOps.includes(node.op)) {
            if (!isNumericType(leftType) || !isNumericType(rightType)) {
                this.addDiagnostic(node, 'error',
                    `Arithmetic operator '${node.op}' error: Requires numeric operands, but got '${leftType.toString()}' and '${rightType.toString()}'`,
                    ErrorCode.TC_NUMERIC_OP_REQUIRES_NUMERIC);
                return;
            }
            const bitwiseOps = ['<<', '>>', '&', '|', '^', '%'];
            if (bitwiseOps.includes(node.op)) {
                const leftIsFloat = leftType.kind === TypeKind.F32 || leftType.kind === TypeKind.F64;
                const rightIsFloat = rightType.kind === TypeKind.F32 || rightType.kind === TypeKind.F64;
                if (leftIsFloat || rightIsFloat) {
                    this.addDiagnostic(node, 'warning',
                        `Bitwise operator '${node.op}' used with floating-point type`,
                        undefined);
                }
            }
            return;
        }

        // Comparison operators
        const comparisonOps = ['==', '!=', '<', '>', '<=', '>='];
        if (comparisonOps.includes(node.op)) {
            if (isNumericType(leftType) && isNumericType(rightType)) return;
            const rightToLeft = this.typeUtils.isAssignable(rightType, leftType);
            const leftToRight = this.typeUtils.isAssignable(leftType, rightType);
            if (!rightToLeft.success && !leftToRight.success) {
                this.addDiagnostic(node, 'warning',
                    `Comparison warning: Comparing potentially incompatible types '${leftType.toString()}' and '${rightType.toString()}'. This may not behave as expected.`,
                    ErrorCode.TC_COMPARISON_INCOMPATIBLE_TYPES);
            }
        }
    }

    /**
     * Check if an expression is a valid lvalue (can be assigned to).
     */
    private checkLvalue(expr: ast.Expression): { message: string; code: ErrorCode } | undefined {
        if (ast.isQualifiedReference(expr)) {
            const ref = expr.reference?.ref;
            if (!ref) return { message: `Cannot assign to unresolved reference`, code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET };
            if (ast.isVariableDeclaration(ref)) {
                return ref.isConst ? { message: `Cannot assign to const variable '${ref.name}'`, code: ErrorCode.TC_ASSIGNMENT_TO_CONST } : undefined;
            }
            if (ast.isFunctionParameter(ref)) {
                return !ref.isMut ? { message: `Cannot assign to parameter '${ref.name}'. Parameters are immutable by default. Use 'mut' keyword to make it mutable.`, code: ErrorCode.TC_ASSIGNMENT_TO_CONST } : undefined;
            }
            if (ast.isClassAttributeDecl(ref)) {
                if (ref.isConst) {
                    return this.isInConstructor(expr) ? undefined : { message: `Cannot assign to const attribute '${ref.name}'. Const attributes can only be assigned in constructors (init methods).`, code: ErrorCode.TC_ASSIGNMENT_TO_CONST };
                }
                return undefined;
            }
            if (ast.isIteratorVar(ref)) return { message: `Cannot assign to iterator variable '${ref.name || 'iterator'}'. Iterator variables are immutable.`, code: ErrorCode.TC_ASSIGNMENT_TO_IMMUTABLE };
            if (ast.isVariablePattern(ref)) return { message: `Cannot assign to pattern variable '${ref.name || 'pattern'}'. Pattern variables are immutable.`, code: ErrorCode.TC_ASSIGNMENT_TO_IMMUTABLE };
            return { message: `Cannot assign to '${ref.$type}'. This is not a valid assignment target.`, code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET };
        }
        if (ast.isMemberAccess(expr)) {
            const baseConstError = this.checkIfBaseIsConst(expr.expr);
            if (baseConstError) return baseConstError;
            const element = expr.element?.ref;
            if (element && ast.isClassAttributeDecl(element) && element.isConst) {
                return this.isInConstructor(expr) ? undefined : { message: `Cannot assign to const attribute '${element.name}'. Const attributes can only be assigned in constructors (init methods).`, code: ErrorCode.TC_ASSIGNMENT_TO_CONST };
            }
            return undefined;
        }
        if (ast.isIndexAccess(expr) || ast.isReverseIndexAccess(expr)) return undefined;
        // Specific invalid lvalue messages
        if (ast.isLiteralExpression(expr)) return { message: `Cannot assign to literal value`, code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET };
        // Everything else is an invalid lvalue
        return { message: `Cannot assign to expression result`, code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET };
    }

    private checkIfBaseIsConst(expr: ast.Expression): { message: string; code: ErrorCode } | undefined {
        if (ast.isQualifiedReference(expr)) {
            const ref = expr.reference?.ref;
            if (ref && ast.isVariableDeclaration(ref) && ref.isConst) {
                return { message: `Cannot assign to member of const variable '${ref.name}'. The variable is declared as const, making all its members immutable.`, code: ErrorCode.TC_ASSIGNMENT_TO_CONST };
            }
            if (ref && ast.isFunctionParameter(ref) && !ref.isMut) {
                return { message: `Cannot assign to member of parameter '${ref.name}'. Parameters are immutable by default. Use 'mut' keyword to make it mutable.`, code: ErrorCode.TC_ASSIGNMENT_TO_CONST };
            }
        }
        if (ast.isMemberAccess(expr)) return this.checkIfBaseIsConst(expr.expr);
        return undefined;
    }

    private isInConstructor(expr: AstNode): boolean {
        let current: AstNode | undefined = expr;
        while (current) {
            if (ast.isClassMethod(current)) {
                return current.method?.names.includes('init') ?? false;
            }
            current = current.$container;
        }
        return false;
    }

    private constraintDefinesOperator(constraint: TypeDescription, operatorName: string): boolean {
        const resolvedConstraint = this.typeUtils.resolveIfReference(constraint);
        if (isUnionType(resolvedConstraint)) return resolvedConstraint.types.some(t => this.constraintDefinesOperator(t, operatorName));
        if (isJoinType(resolvedConstraint)) return resolvedConstraint.types.some(t => this.constraintDefinesOperator(t, operatorName));
        if (isInterfaceType(resolvedConstraint)) {
            const allMethods = this.typeUtils.collectAllInterfaceMethods(resolvedConstraint);
            return allMethods.some(method => method.names.includes(operatorName));
        }
        return false;
    }

    // ========================================================================
    // Function Call Validation (migrated from type-system-diagnostics)
    // ========================================================================

    /**
     * Validates coroutine call arguments: argument count and argument types.
     */
    private validateCoroutineCallArgs(node: ast.FunctionCall, coroutineType: { readonly parameters: readonly FunctionParameterType[]; readonly yieldType: TypeDescription }): void {
        const args = node.args || [];

        // Check argument count (accounts for default parameters)
        const coroMinArity = getMinArity(coroutineType.parameters);
        const coroMaxArity = coroutineType.parameters.length;
        if (args.length < coroMinArity || args.length > coroMaxArity) {
            const expected = coroMinArity === coroMaxArity
                ? `${coroMinArity}`
                : `${coroMinArity} to ${coroMaxArity}`;
            this.addDiagnostic(node, 'error',
                `Coroutine call argument count mismatch: Expected ${expected} argument(s), but got ${args.length}`,
                ErrorCode.TC_COROUTINE_CALL_ARG_COUNT_MISMATCH);
            return;
        }

        // Check each argument type
        args.forEach((arg, index) => {
            const expectedType = coroutineType.parameters[index].type;
            const actualType = this.inferExpression(arg);

            const compatResult = this.typeUtils.isAssignable(
                this.typeUtils.resolveIfReference(actualType),
                this.typeUtils.resolveIfReference(expectedType)
            );
            if (!compatResult.success) {
                const errorMsg = compatResult.message
                    ? `Coroutine call argument ${index + 1} type mismatch: ${compatResult.message}`
                    : `Coroutine call argument ${index + 1} type mismatch: Expected '${expectedType.toString()}', but got '${actualType.toString()}'`;
                this.addDiagnostic(arg, 'error', errorMsg, ErrorCode.TC_COROUTINE_CALL_ARG_TYPE_MISMATCH);
            }
        });
    }

    /**
     * Validates function call arguments: argument count and argument types.
     * Called after generic substitutions have been applied to paramTypes.
     */
    private validateFunctionCallArgs(
        node: ast.FunctionCall,
        paramTypes: readonly FunctionParameterType[]
    ): void {
        const args = node.args || [];

        // Check argument count (accounts for default parameters)
        const fnMinArity = getMinArity(paramTypes);
        const fnMaxArity = paramTypes.length;
        if (args.length < fnMinArity || args.length > fnMaxArity) {
            const expected = fnMinArity === fnMaxArity
                ? `${fnMinArity}`
                : `${fnMinArity} to ${fnMaxArity}`;
            this.addDiagnostic(node, 'error',
                `Function call argument count mismatch: Expected ${expected} argument(s), but got ${args.length}`,
                ErrorCode.TC_FUNCTION_CALL_ARG_COUNT_MISMATCH);
            return;
        }

        // Check each argument type (only for provided args)
        args.forEach((arg, index) => {
            const expectedType = paramTypes[index].type;
            const actualType = this.inferExpression(arg);

            const compatResult = this.typeUtils.isAssignable(
                this.typeUtils.resolveIfReference(actualType),
                this.typeUtils.resolveIfReference(expectedType)
            );
            if (!compatResult.success) {
                const errorMsg = compatResult.message
                    ? `Function call argument ${index + 1} type mismatch: ${compatResult.message}`
                    : `Function call argument ${index + 1} type mismatch: Expected '${expectedType.toString()}', but got '${actualType.toString()}'`;
                this.addDiagnostic(arg, 'error', errorMsg, ErrorCode.TC_FUNCTION_CALL_ARG_TYPE_MISMATCH);
            }
        });
    }

    /**
     * Validates variant constructor calls for:
     * 1. Generic parameter count (if explicitly provided)
     * 2. Generic parameter types (if explicitly provided)
     * 3. Argument count
     * 4. Argument types
     *
     * Note: Variants do NOT support overload - each constructor has a unique name.
     */
    private validateVariantConstructorCallArgs(
        node: ast.FunctionCall,
        constructorType: VariantConstructorTypeDescription
    ): void {
        // Get the base variant and constructor definition
        const baseVariant = constructorType.baseVariant;
        const constructorDef = baseVariant.constructors.find(
            c => c.name === constructorType.constructorName
        );

        if (!constructorDef) {
            return; // Should not happen - constructor not found
        }

        const args = node.args || [];
        const constructorParams = constructorDef.parameters;

        // Step 1: Validate explicit generic arguments if provided
        if (node.genericArgs && node.genericArgs.length > 0) {
            // Get the variant declaration to check generic parameter count
            const variantDecl = constructorType.variantDeclaration;
            if (!variantDecl || !variantDecl.genericParameters) {
                // No generic parameters defined but generics provided
                this.addDiagnostic(node, 'error',
                    `Variant constructor '${constructorType.constructorName}' does not take generic arguments`,
                    ErrorCode.TC_VARIANT_CONSTRUCTOR_GENERIC_ARG_COUNT_MISMATCH);
                return;
            }

            const expectedGenericCount = variantDecl.genericParameters.length;
            const providedGenericCount = node.genericArgs.length;

            if (providedGenericCount !== expectedGenericCount) {
                this.addDiagnostic(node, 'error',
                    `Variant constructor '${constructorType.constructorName}' expects ${expectedGenericCount} generic argument(s), but got ${providedGenericCount}`,
                    ErrorCode.TC_VARIANT_CONSTRUCTOR_GENERIC_ARG_COUNT_MISMATCH);
                return;
            }

            // Build substitution map from explicit generic arguments
            const substitutions = new Map<string, TypeDescription>();
            variantDecl.genericParameters.forEach((param, i) => {
                const concreteType = this.getType(node.genericArgs[i]);
                substitutions.set(param.name, concreteType);
            });

            // Step 2: Validate explicit generic types against argument types
            // Apply substitutions to constructor parameters
            const substitutedParams = constructorParams.map(p =>
                this.typeUtils.substituteGenerics(p.type, substitutions)
            );

            // Check argument count
            if (args.length !== substitutedParams.length) {  // Variant constructors don't support defaults, so exact match
                this.addDiagnostic(node, 'error',
                    `Variant constructor '${constructorType.constructorName}' expects ${substitutedParams.length} argument(s), but got ${args.length}`,
                    ErrorCode.TC_VARIANT_CONSTRUCTOR_ARG_COUNT_MISMATCH);
                return;
            }

            // Check each argument type against substituted parameter type
            args.forEach((arg, index) => {
                const expectedType = substitutedParams[index];
                const actualType = this.inferExpression(arg);

                const compatResult = this.typeUtils.isAssignable(
                    this.typeUtils.resolveIfReference(actualType),
                    this.typeUtils.resolveIfReference(expectedType)
                );
                if (!compatResult.success) {
                    const errorMsg = compatResult.message
                        ? `Variant constructor '${constructorType.constructorName}' argument ${index + 1} type mismatch: ${compatResult.message}`
                        : `Variant constructor '${constructorType.constructorName}' argument ${index + 1} type mismatch: Expected '${expectedType.toString()}', but got '${actualType.toString()}'`;
                    this.addDiagnostic(arg, 'error', errorMsg, ErrorCode.TC_VARIANT_CONSTRUCTOR_ARG_TYPE_MISMATCH);
                }
            });

            // Additionally, verify that the explicit generics are consistent with inferred types
            // This catches cases like Option.Some<string>(200u32) where the explicit generic doesn't match
            const inferredGenerics = this.inferGenericsFromArguments(
                variantDecl.genericParameters.map(p => p.name),
                constructorParams.map(p => p.type),
                args.map(arg => this.inferExpression(arg))
            );

            // Compare explicit generics with inferred generics
            variantDecl.genericParameters.forEach((param, i) => {
                const explicitType = this.getType(node.genericArgs[i]);
                const inferredType = inferredGenerics.get(param.name);

                // Skip if inferred type is never (couldn't be inferred)
                if (inferredType && inferredType.kind !== TypeKind.Never) {
                    const compatResult = this.typeUtils.areTypesEqual(explicitType, inferredType);
                    if (!compatResult.success) {
                        this.addDiagnostic(node.genericArgs[i], 'error',
                            `Variant constructor '${constructorType.constructorName}' generic argument '${param.name}' mismatch: Explicitly specified as '${explicitType.toString()}', but inferred as '${inferredType.toString()}' from arguments`,
                            ErrorCode.TC_VARIANT_CONSTRUCTOR_GENERIC_ARG_TYPE_MISMATCH);
                    }
                }
            });

            return;
        }

        // Step 3: No explicit generics - just validate argument count and types
        // The type provider will infer generics from arguments

        // Check argument count
        if (args.length !== constructorParams.length) {
            this.addDiagnostic(node, 'error',
                `Variant constructor '${constructorType.constructorName}' expects ${constructorParams.length} argument(s), but got ${args.length}`,
                ErrorCode.TC_VARIANT_CONSTRUCTOR_ARG_COUNT_MISMATCH);
            return;
        }

        // Check each argument type
        // Note: We use the original parameter types here (with generic placeholders like T)
        // because the type provider will perform generic inference during type inference
        args.forEach((arg, index) => {
            const expectedType = constructorParams[index].type;
            const actualType = this.inferExpression(arg);

            // For generic parameters, we can't validate directly - skip validation
            // The type system will handle generic inference
            if (isGenericType(expectedType)) {
                return;
            }

            const compatResult = this.typeUtils.isAssignable(
                this.typeUtils.resolveIfReference(actualType),
                this.typeUtils.resolveIfReference(expectedType)
            );
            if (!compatResult.success) {
                const errorMsg = compatResult.message
                    ? `Variant constructor '${constructorType.constructorName}' argument ${index + 1} type mismatch: ${compatResult.message}`
                    : `Variant constructor '${constructorType.constructorName}' argument ${index + 1} type mismatch: Expected '${expectedType.toString()}', but got '${actualType.toString()}'`;
                this.addDiagnostic(arg, 'error', errorMsg, ErrorCode.TC_VARIANT_CONSTRUCTOR_ARG_TYPE_MISMATCH);
            }
        });
    }

    /**
     * Validates operator constraints at the call site of a generic function.
     * Self-sufficient: builds its own substitutions from QualifiedReference.genericArgs
     * when the caller's substitutions are unavailable (e.g., the type provider already
     * specialized the function type from the QualifiedReference).
     */
    private validateOperatorConstraintsAtCallSite(
        node: ast.FunctionCall,
        substitutions: Map<string, TypeDescription> | undefined
    ): void {
        // Find the function declaration and its operator constraints
        let constraints: ast.OperatorConstraint[] | undefined;
        let genericParams: ast.GenericType[] | undefined;

        if (ast.isQualifiedReference(node.expr)) {
            const ref = node.expr.reference?.ref;
            if (ast.isFunctionDeclaration(ref)) {
                constraints = ref.operatorConstraints;
                genericParams = ref.genericParameters;
            }
        } else if (ast.isMemberAccess(node.expr)) {
            const ref = node.expr.element?.ref;
            if (ast.isClassMethod(ref)) {
                constraints = ref.method?.operatorConstraints;
                genericParams = ref.method?.genericParameters;
            }
        }

        if (!constraints || constraints.length === 0) return;

        // Build substitutions from QualifiedReference.genericArgs if not provided.
        // This handles the case where the type provider already specialized the function
        // (e.g., `addVars<string, i32, i32>("hi", 1)` -- generic args are on the reference,
        // so fnType.genericParameters is empty and the caller didn't build substitutions).
        if ((!substitutions || substitutions.size === 0) && genericParams && genericParams.length > 0) {
            if (ast.isQualifiedReference(node.expr)) {
                const qualRef = node.expr;
                if (qualRef.genericArgs?.length === genericParams.length) {
                    substitutions = new Map<string, TypeDescription>();
                    genericParams.forEach((param, index) => {
                        substitutions!.set(param.name, this.getType(qualRef.genericArgs[index]));
                    });
                }
            }
        }

        if (!substitutions || substitutions.size === 0) return;

        this.validateOperatorConstraints(constraints, substitutions, node);
    }

    /**
     * Validates operator constraints against concrete substitutions.
     * Shared implementation used by both FunctionCall and NewExpression validation.
     */
    private validateOperatorConstraints(
        constraints: ast.OperatorConstraint[],
        substitutions: Map<string, TypeDescription>,
        node: AstNode
    ): void {
        for (const constraint of constraints) {
            if (constraint.isBinary && constraint.leftType && constraint.rightType) {
                let leftConcreteType = this.getType(constraint.leftType);
                let rightConcreteType = this.getType(constraint.rightType);

                leftConcreteType = this.typeUtils.substituteGenerics(leftConcreteType, substitutions);
                rightConcreteType = this.typeUtils.substituteGenerics(rightConcreteType, substitutions);

                // If after substitution an operand is still generic, the caller is forwarding
                // its own generic type parameter. Check if the caller's enclosing context
                // already guarantees this operator constraint (via || or : syntax).
                if (isGenericType(leftConcreteType) || isGenericType(rightConcreteType)) {
                    const genericType = isGenericType(leftConcreteType) ? leftConcreteType : rightConcreteType as GenericTypeDescription;
                    if (genericType.declaration) {
                        // Check || syntax: enclosing function's operator constraints
                        if (this.hasMatchingOperatorConstraint(constraint.op, leftConcreteType, rightConcreteType, genericType.declaration)) {
                            continue;
                        }
                        // Check : syntax: interface constraint that defines this operator
                        const genConstraint = genericType.constraint
                            ?? (genericType.declaration.constraint ? this.getType(genericType.declaration.constraint) : undefined);
                        if (genConstraint && this.constraintDefinesOperator(genConstraint, constraint.op)) {
                            continue;
                        }
                    }
                }

                if (!this.isBinaryOperatorValidForConstraint(constraint.op, leftConcreteType, rightConcreteType)) {
                    this.addDiagnostic(node, 'error',
                        `Operator constraint not satisfied: Type '${leftConcreteType.toString()}' does not support binary operator '${constraint.op}' with '${rightConcreteType.toString()}'`,
                        ErrorCode.TC_OPERATOR_CONSTRAINT_NOT_SATISFIED);
                } else {
                    // Operator is valid -- now check that the actual result type matches the declared constraint result type.
                    // Skip if expectedResultType is `never`: this means the result type param was inferred from the
                    // operator constraint itself (not from explicit type args), so it matches by construction.
                    let expectedResultType = this.getType(constraint.resultType);
                    expectedResultType = this.typeUtils.substituteGenerics(expectedResultType, substitutions);
                    if (!isNeverType(expectedResultType)) {
                        const actualResultType = this.resolveOperatorResultType(constraint.op, leftConcreteType, rightConcreteType, node);
                        if (actualResultType) {
                            const compatResult = this.typeUtils.isAssignable(
                                this.typeUtils.resolveIfReference(actualResultType),
                                this.typeUtils.resolveIfReference(expectedResultType)
                            );
                            if (!compatResult.success) {
                                this.addDiagnostic(node, 'error',
                                    `Operator constraint result type mismatch: '${leftConcreteType.toString()}' ${constraint.op} '${rightConcreteType.toString()}' produces '${actualResultType.toString()}', but constraint declares '${expectedResultType.toString()}'`,
                                    ErrorCode.TC_OPERATOR_CONSTRAINT_NOT_SATISFIED);
                            }
                        }
                    }
                }
            } else if (!constraint.isBinary && constraint.operandType) {
                let operandConcreteType = this.getType(constraint.operandType);

                operandConcreteType = this.typeUtils.substituteGenerics(operandConcreteType, substitutions);

                // Same as binary: if the operand is still generic, check caller's context
                if (isGenericType(operandConcreteType)) {
                    if (operandConcreteType.declaration) {
                        if (this.hasMatchingOperatorConstraint(constraint.op, operandConcreteType, undefined, operandConcreteType.declaration)) {
                            continue;
                        }
                        const genConstraint = operandConcreteType.constraint
                            ?? (operandConcreteType.declaration.constraint ? this.getType(operandConcreteType.declaration.constraint) : undefined);
                        if (genConstraint && this.constraintDefinesOperator(genConstraint, constraint.op)) {
                            continue;
                        }
                    }
                }

                if (!this.isUnaryOperatorValidForConstraint(constraint.op, operandConcreteType)) {
                    this.addDiagnostic(node, 'error',
                        `Operator constraint not satisfied: Type '${operandConcreteType.toString()}' does not support unary operator '${constraint.op}'`,
                        ErrorCode.TC_OPERATOR_CONSTRAINT_NOT_SATISFIED);
                } else {
                    let expectedResultType = this.getType(constraint.resultType);
                    expectedResultType = this.typeUtils.substituteGenerics(expectedResultType, substitutions);
                    if (!isNeverType(expectedResultType)) {
                        const actualResultType = this.resolveOperatorResultType(constraint.op, operandConcreteType, undefined, node);
                        if (actualResultType) {
                            const compatResult = this.typeUtils.isAssignable(
                                this.typeUtils.resolveIfReference(actualResultType),
                                this.typeUtils.resolveIfReference(expectedResultType)
                            );
                            if (!compatResult.success) {
                                this.addDiagnostic(node, 'error',
                                    `Operator constraint result type mismatch: ${constraint.op}'${operandConcreteType.toString()}' produces '${actualResultType.toString()}', but constraint declares '${expectedResultType.toString()}'`,
                                    ErrorCode.TC_OPERATOR_CONSTRAINT_NOT_SATISFIED);
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Checks if a binary operator is valid for the given concrete types.
     */
    private isBinaryOperatorValidForConstraint(op: string, leftType: TypeDescription, rightType: TypeDescription): boolean {
        return isBinaryOpValid(op, leftType, rightType, this.typeUtils, isNumericType);
    }

    /**
     * Checks if a unary operator is valid for the given concrete type.
     */
    private isUnaryOperatorValidForConstraint(op: string, operandType: TypeDescription): boolean {
        return isUnaryOpValid(op, operandType, this.typeUtils, isNumericType);
    }

    /**
     * Gets operator constraints from the enclosing function/method/type declaration.
     */
    private getOperatorConstraints(node: AstNode): ast.OperatorConstraint[] | undefined {
        let current: AstNode | undefined = node;
        while (current) {
            if (ast.isFunctionDeclaration(current)) {
                if (current.operatorConstraints && current.operatorConstraints.length > 0) {
                    return current.operatorConstraints;
                }
            } else if (ast.isClassMethod(current)) {
                const methodConstraints = current.method?.operatorConstraints;
                if (methodConstraints && methodConstraints.length > 0) {
                    return methodConstraints;
                }
            } else if (ast.isTypeDeclaration(current)) {
                return current.operatorConstraints;
            }
            current = current.$container;
        }
        return undefined;
    }

    /**
     * Checks if a matching operator constraint exists in the enclosing declaration.
     * Used for definition-site validation of binary/unary operations on generic types.
     */
    private hasMatchingOperatorConstraint(op: string, leftType: TypeDescription, rightType: TypeDescription | undefined, node: AstNode): boolean {
        const constraints = this.getOperatorConstraints(node);
        if (!constraints || constraints.length === 0) return false;

        for (const constraint of constraints) {
            if (constraint.op !== op) continue;

            if (rightType !== undefined) {
                // Binary check
                if (!constraint.isBinary || !constraint.leftType || !constraint.rightType) continue;

                const constraintLeftType = this.getType(constraint.leftType);
                const constraintRightType = this.getType(constraint.rightType);

                const leftMatch = this.typeUtils.areTypesEqual(leftType, constraintLeftType);
                const rightMatch = this.typeUtils.areTypesEqual(rightType, constraintRightType);

                if (leftMatch.success && rightMatch.success) {
                    return true;
                }
            } else {
                // Unary check
                if (constraint.isBinary || !constraint.operandType) continue;

                const constraintOperandType = this.getType(constraint.operandType);
                const match = this.typeUtils.areTypesEqual(leftType, constraintOperandType);

                if (match.success) {
                    return true;
                }
            }
        }
        return false;
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
        // Strip function defaults when member access is used as a value (not a call target)
        if (ast.isMemberAccess(node)) {
            const memberType = this.inferMemberAccess(node);
            if (!this.isInCalleePosition(node)) {
                return this.typeFactory.stripFunctionDefaults(memberType);
            }
            return memberType;
        }
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
        if (ast.isInstanceCheckExpression(node)) return this.inferInstanceCheckExpression(node);

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
        return this.typeFactory.createErrorType(`Cannot infer type for expression: ${node.$type}`, undefined, node, false);
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
        if (expectedType && isNullableType(expectedType)) {
            expectedType = expectedType.baseType;
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
        if (expectedType && isNullableType(expectedType)) {
            expectedType = expectedType.baseType;
        }
        if (expectedType && this.isFloatType(expectedType)) {
            // Use the expected float type (f32 or f64)
            return expectedType;
        }

        // Default to f64 (double precision)
        return this.typeFactory.createF64Type(node);
    }

    /**
     * Check whether an expression node is in callee position (i.e., the `expr` of a FunctionCall).
     * When a function reference is used as a value (not being called), we strip hasDefault
     * from its parameters since default expansion is a declaration-site feature.
     */
    private isInCalleePosition(node: ast.Expression): boolean {
        return ast.isFunctionCall(node.$container) && node.$container.expr === node;
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
                const typeArgs: TypeDescription[] = [];
                
                for (let index = 0; index < genericParams.length; index++) {
                    const param = genericParams[index];
                    const concreteType = this.getType(node.genericArgs[index]);

                    // Add substitution before validating constraint, so self-referential
                    // constraints like T: interface { fn +(T) -> T } can resolve T
                    substitutions.set(param.name, concreteType);
                    typeArgs.push(concreteType);

                    // Substitute generics in the constraint before validating
                    const constraint = param.constraint
                        ? this.typeUtils.substituteGenerics(param.constraint, substitutions)
                        : param.constraint;
                    const constraintCheck = this.typeUtils.validateGenericConstraint(concreteType, constraint);
                    if (!constraintCheck.success) {
                        return this.typeFactory.createErrorType(
                            constraintCheck.message || `Type argument does not satisfy generic constraint`,
                            undefined,
                            node
                        );
                    }
                }

                // MONOMORPHIZATION: Register function instantiation with explicit generic args
                if (refNode && ast.isFunctionDeclaration(refNode) && refNode.genericParameters && refNode.genericParameters.length > 0) {
                    this.services.typing.MonomorphizationRegistry.registerFunctionInstantiation(
                        refNode,
                        typeArgs
                    );
                }

                // Apply substitutions to the function type
                const substituted = this.typeUtils.substituteGenerics(type, substitutions);
                // Strip defaults when function reference is used as a value (not direct call)
                if (!this.isInCalleePosition(node)) {
                    return this.typeFactory.stripFunctionDefaults(substituted);
                }
                return substituted;
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

        // Strip defaults when function reference is used as a value (not direct call)
        if (!this.isInCalleePosition(node)) {
            return this.typeFactory.stripFunctionDefaults(originalType);
        }
        return originalType;
    }

    private inferBinaryExpression(node: ast.BinaryExpression): TypeDescription {
        const left = this.inferExpression(node.left);
        const right = this.inferExpression(node.right);

        this.validateBinaryExpression(node, left, right);

        // If either operand is an error type, propagate it
        if (left.kind === TypeKind.Error) return left;
        if (right.kind === TypeKind.Error) return right;

        // Assignment operators return the type of the right operand
        if (isAssignmentOperator(node.op)) {
            return right;
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

        // Check for operator overloads on classes/interfaces FIRST
        // Classes/interfaces can override the return type of any operator
        const operatorOverload = this.resolveOperatorOverload(left, node.op, [right], node);
        if (operatorOverload) {
            return operatorOverload;
        }

        // Check for operator constraints on generic types
        const resolvedLeftForConstraint = this.typeUtils.resolveIfReference(left);
        const resolvedRightForConstraint = this.typeUtils.resolveIfReference(right);
        if (isGenericType(resolvedLeftForConstraint) || isGenericType(resolvedRightForConstraint)) {
            const constraintResult = this.findOperatorConstraint(node.op, resolvedLeftForConstraint, resolvedRightForConstraint, node);
            if (constraintResult) return constraintResult;
        }

        // Primitive fallback: comparison→bool, logical→bool, string concat→string,
        // arithmetic→common numeric, bitwise→common numeric
        const primitiveResult = computeBinaryResultType(node.op, left, right, this.typeUtils, this.typeFactory, node);
        if (primitiveResult) return primitiveResult;

        return left;
    }

    private inferUnaryExpression(node: ast.UnaryExpression): TypeDescription {
        const exprType = this.inferExpression(node.expr);

        // Check for operator overloads on classes/interfaces FIRST
        // Classes/interfaces can override the return type of any operator (including !)
        const operatorOverload = this.resolveOperatorOverload(exprType, node.op, [], node);
        if (operatorOverload) {
            return operatorOverload;
        }

        // Check for operator constraints on generic types
        const resolvedExpr = this.typeUtils.resolveIfReference(exprType);
        if (isGenericType(resolvedExpr)) {
            const constraintResult = this.findOperatorConstraint(node.op, resolvedExpr, undefined, node);
            if (constraintResult) return constraintResult;
        }

        // Primitive fallback: !→bool, unsigned negation→error, -/~→preserve type
        const primitiveResult = computeUnaryResultType(node.op, exprType, this.typeUtils, this.typeFactory, node);
        if (primitiveResult) return primitiveResult;

        // Other unary operators preserve the type
        return exprType;
    }

    /**
     * Finds a matching operator constraint in the enclosing generic function/method/type declaration.
     * Walks up the AST to find operator constraints declared with the `||` syntax.
     *
     * @param operator The operator string (e.g., '+', '-', '!')
     * @param leftType The left operand type (or only operand for unary)
     * @param rightType The right operand type (undefined for unary)
     * @param node The expression node for context
     * @returns The result type if a matching constraint is found, undefined otherwise
     */
    private findOperatorConstraint(
        operator: string,
        leftType: TypeDescription,
        rightType: TypeDescription | undefined,
        node: AstNode
    ): TypeDescription | undefined {
        let current: AstNode | undefined = node;
        while (current) {
            let constraints: ast.OperatorConstraint[] | undefined;

            if (ast.isFunctionDeclaration(current)) {
                constraints = current.operatorConstraints;
            } else if (ast.isClassMethod(current)) {
                constraints = current.method?.operatorConstraints;
            } else if (ast.isTypeDeclaration(current)) {
                constraints = current.operatorConstraints;
            } else if (ast.isLambdaExpression(current)) {
                // Lambdas don't have their own operator constraints, skip
            }

            if (constraints && constraints.length > 0) {
                for (const constraint of constraints) {
                    if (constraint.op !== operator) continue;

                    if (rightType !== undefined) {
                        // Binary constraint check
                        if (!constraint.isBinary || !constraint.leftType || !constraint.rightType) continue;

                        const constraintLeftType = this.getType(constraint.leftType);
                        const constraintRightType = this.getType(constraint.rightType);

                        if (this.typeUtils.areTypesEqual(leftType, constraintLeftType).success &&
                            this.typeUtils.areTypesEqual(rightType, constraintRightType).success) {
                            return this.getType(constraint.resultType);
                        }
                    } else {
                        // Unary constraint check
                        if (constraint.isBinary || !constraint.operandType) continue;

                        const constraintOperandType = this.getType(constraint.operandType);

                        if (this.typeUtils.areTypesEqual(leftType, constraintOperandType).success) {
                            return this.getType(constraint.resultType);
                        }
                    }
                }
            }

            current = current.$container;
        }

        return undefined;
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
     * Determines the result type of `leftType op rightType` (or `op operandType` for unary)
     * without requiring an AST expression node. Used to resolve generic return types
     * from operator constraints at call sites.
     */
    public resolveOperatorResultType(
        operator: string,
        leftType: TypeDescription,
        rightType: TypeDescription | undefined,
        node: AstNode
    ): TypeDescription | undefined {
        if (rightType !== undefined) {
            // Binary operator
            // 1. Try class/interface operator overload
            const overload = this.resolveOperatorOverload(leftType, operator, [rightType], node);
            if (overload) return overload;

            // 2-6. Primitive fallbacks (shared with inferBinaryExpression)
            return computeBinaryResultTypeStrict(operator, leftType, rightType, this.typeUtils, this.typeFactory, node);
        } else {
            // Unary operator
            const overload = this.resolveOperatorOverload(leftType, operator, [], node);
            if (overload) return overload;

            // Primitive fallbacks (shared with inferUnaryExpression)
            return computeUnaryResultTypeStrict(operator, leftType, this.typeUtils, this.typeFactory, node);
        }
    }

    /**
     * Resolves still-`never` generic parameters by evaluating operator constraints.
     * For example, given `fn<U, V, W || (U + V) -> W>`, if U=string and V=u32 are
     * already inferred but W is `never`, this evaluates `string + u32 → string` and
     * sets W=string.
     */
    private resolveGenericsFromOperatorConstraints(
        constraints: ast.OperatorConstraint[],
        substitutions: Map<string, TypeDescription>,
        genericParamNames: string[],
        node: AstNode
    ): void {
        for (const constraint of constraints) {
            const resultType = this.getType(constraint.resultType);
            if (!isGenericType(resultType)) continue;
            if (!genericParamNames.includes(resultType.name)) continue;

            const currentValue = substitutions.get(resultType.name);
            if (currentValue && !isNeverType(currentValue)) continue;

            if (constraint.isBinary && constraint.leftType && constraint.rightType) {
                let leftType = this.getType(constraint.leftType);
                let rightType = this.getType(constraint.rightType);
                leftType = this.typeUtils.substituteGenerics(leftType, substitutions);
                rightType = this.typeUtils.substituteGenerics(rightType, substitutions);

                if (isGenericType(leftType) || isGenericType(rightType)) continue;
                if (isNeverType(leftType) || isNeverType(rightType)) continue;

                const resolved = this.resolveOperatorResultType(constraint.op, leftType, rightType, node);
                if (resolved) {
                    substitutions.set(resultType.name, resolved);
                }
            } else if (!constraint.isBinary && constraint.operandType) {
                let operandType = this.getType(constraint.operandType);
                operandType = this.typeUtils.substituteGenerics(operandType, substitutions);

                if (isGenericType(operandType) || isNeverType(operandType)) continue;

                const resolved = this.resolveOperatorResultType(constraint.op, operandType, undefined, node);
                if (resolved) {
                    substitutions.set(resultType.name, resolved);
                }
            }
        }
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

            // Validate coroutine call args (count + types)
            this.validateCoroutineCallArgs(node, fnType);

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
                // Validate variant constructor call args
                this.validateVariantConstructorCallArgs(node, fnType.returnType);

                const returnType = this.inferVariantConstructorCall(fnType.returnType, node);
                // Don't wrap basic types with nullable
                if (isOptionalCall && !this.typeUtils.isTypeBasic(returnType)) {
                    return this.typeFactory.createNullableType(returnType, node);
                }
                return returnType;
            }

            const genericParams = fnType.genericParameters || [];
            let substitutions: Map<string, TypeDescription> | undefined;
            let operatorConstraintsValidated = false;

            // Handle explicit generic type arguments
            if (node.genericArgs && node.genericArgs.length > 0) {
                if (node.genericArgs.length === genericParams.length) {
                    // Build substitution map and validate constraints
                    const explicitSubstitutions = new Map<string, TypeDescription>();
                    
                    for (let index = 0; index < genericParams.length; index++) {
                        const param = genericParams[index];
                        const concreteType = this.getType(node.genericArgs[index]);

                        // Add substitution before validating constraint, so self-referential
                        // constraints like T: interface { fn +(T) -> T } can resolve T
                        explicitSubstitutions.set(param.name, concreteType);

                        // Substitute generics in the constraint before validating
                        const constraint = param.constraint
                            ? this.typeUtils.substituteGenerics(param.constraint, explicitSubstitutions)
                            : param.constraint;
                        const constraintCheck = this.typeUtils.validateGenericConstraint(concreteType, constraint);
                        if (!constraintCheck.success) {
                            // Return error immediately if constraint not satisfied
                            return this.typeFactory.createErrorType(
                                constraintCheck.message || `Type argument does not satisfy generic constraint`,
                                undefined,
                                node
                            );
                        }
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

                // Two-pass inference for unsuffixed numeric literals:
                // If any inferred generic is an error (e.g., getCommonType failed for [u8, i32]),
                // check if some arguments are unsuffixed literals that could adapt.
                // Use the non-error type directly for those literals.
                const hasErrorSubstitution = Array.from(substitutions.values()).some(t => isErrorType(t));
                if (hasErrorSubstitution) {
                    // Identify which arguments are unsuffixed numeric literals
                    const isUnsuffixedLiteral = (arg: ast.Expression): boolean => {
                        if (ast.isIntegerLiteral(arg)) {
                            return !arg.value.match(/([iu])(8|16|32|64)$/);
                        }
                        if (ast.isFloatingPointLiteral(arg)) {
                            return !ast.isFloatLiteral(arg); // FloatLiteral has 'f' suffix
                        }
                        return false;
                    };

                    // Collect non-literal (suffixed/concrete) types per generic parameter
                    const concreteTypes = new Map<string, TypeDescription>();
                    for (let i = 0; i < Math.min(args.length, parameterTypes.length); i++) {
                        if (!isUnsuffixedLiteral(args[i])) {
                            const paramType = parameterTypes[i];
                            if (isGenericType(paramType) && genericParamNames.includes(paramType.name)) {
                                if (!concreteTypes.has(paramType.name)) {
                                    concreteTypes.set(paramType.name, argumentTypes[i]);
                                }
                            }
                        }
                    }

                    // Replace unsuffixed literal types with the concrete type from other args
                    if (concreteTypes.size > 0) {
                        let needsReInference = false;
                        const newArgumentTypes = [...argumentTypes];
                        for (let i = 0; i < Math.min(args.length, parameterTypes.length); i++) {
                            if (isUnsuffixedLiteral(args[i])) {
                                const paramType = parameterTypes[i];
                                if (isGenericType(paramType) && concreteTypes.has(paramType.name)) {
                                    const contextType = concreteTypes.get(paramType.name)!;
                                    if ((this.isIntegerType(contextType) || this.isFloatType(contextType))
                                        && !isErrorType(contextType)) {
                                        // Use the concrete type directly for the unsuffixed literal
                                        newArgumentTypes[i] = contextType;
                                        needsReInference = true;
                                    }
                                }
                            }
                        }

                        if (needsReInference) {
                            substitutions = this.inferGenericsFromArguments(
                                genericParamNames,
                                parameterTypes,
                                newArgumentTypes
                            );
                        }
                    }
                }

                // Resolve remaining generics from operator constraints
                // e.g., fn<U, V, W || (U + V) -> W>(...) — infer W from what U + V produces
                if (ast.isQualifiedReference(node.expr)) {
                    const funcRef = node.expr.reference?.ref;
                    if (funcRef && ast.isFunctionDeclaration(funcRef) && funcRef.operatorConstraints?.length) {
                        this.resolveGenericsFromOperatorConstraints(
                            funcRef.operatorConstraints,
                            substitutions,
                            genericParamNames,
                            node
                        );
                    }
                }

                // Run operator constraint validation BEFORE generic constraint
                // validation (which may return early with ErrorType), so we always
                // report operator constraint errors even when generic constraint fails.
                this.validateOperatorConstraintsAtCallSite(node, substitutions);
                operatorConstraintsValidated = true;

                // Validate that inferred types satisfy constraints
                for (let i = 0; i < genericParams.length; i++) {
                    const param = genericParams[i];
                    const inferredType = substitutions.get(param.name);

                    if (inferredType && !isNeverType(inferredType)) {
                        // Substitute generics in the constraint before validating, so
                        // self-referential constraints like T: interface { fn +(T) -> T } can resolve T
                        const constraint = param.constraint
                            ? this.typeUtils.substituteGenerics(param.constraint, substitutions)
                            : param.constraint;
                        const constraintCheck = this.typeUtils.validateGenericConstraint(inferredType, constraint);
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

            // If inference produced an ErrorType substitution, fail fast and avoid
            // registering invalid monomorphization entries.
            if (substitutions) {
                const firstErrorSubstitution = Array.from(substitutions.entries())
                    .find(([, type]) => isErrorType(type));
                if (firstErrorSubstitution) {
                    const [genericName, candidateType] = firstErrorSubstitution;
                    const errorType = isErrorType(candidateType) ? candidateType : undefined;
                    return this.typeFactory.createErrorType(
                        errorType?.message || `Cannot infer type argument for generic parameter '${genericName}'`,
                        undefined,
                        node
                    );
                }
            }

            // MONOMORPHIZATION: Register method or function instantiation
            // IMPORTANT: Skip during method inference to avoid cyclic reference errors
            const isInMethodInferenceContext = this.inferringMethods.size > 0 || this.inferringImplMethods.size > 0;
            const hasErrorTypeArgs = (types: readonly TypeDescription[]): boolean => types.some(t => isErrorType(t));
            
            // Handle method calls on generic class instances
            if (ast.isMemberAccess(node.expr) && !isInMethodInferenceContext) {
                // Get the base type - we need to find the underlying class and its generic args
                let baseType = this.inferExpression(node.expr.expr);
                let classDeclaration: ast.TypeDeclaration | undefined;
                let classGenericArgs: TypeDescription[] = [];
                
                // Helper to extract class info from a reference type (handles aliases)
                const extractClassInfo = (refType: ReferenceTypeDescription): boolean => {
                    const def = refType.declaration.definition;
                    if (ast.isClassType(def)) {
                        // Direct class reference
                        classDeclaration = refType.declaration;
                        classGenericArgs = [...refType.genericArgs];
                        return true;
                    } else if (ast.isReferenceType(def)) {
                        // Type alias - get the aliased type and recurse
                        const aliasedType = this.getType(def);
                        if (isReferenceType(aliasedType)) {
                            return extractClassInfo(aliasedType);
                        }
                    }
                    return false;
                };
                
                // Check if it's a ReferenceType
                if (isReferenceType(baseType)) {
                    extractClassInfo(baseType);
                } else if (isMetaClassType(baseType)) {
                    // Static method call on a class (e.g., Z.callme2(...))
                    const classNode = baseType.baseClass.node;
                    if (classNode && ast.isClassType(classNode) && classNode.$container && ast.isTypeDeclaration(classNode.$container)) {
                        classDeclaration = classNode.$container;
                    } else if (classNode && ast.isTypeDeclaration(classNode)) {
                        classDeclaration = classNode;
                    }
                }
                
                // Register if we have a generic class instantiation
                if (classDeclaration && classGenericArgs.length > 0 && !hasErrorTypeArgs(classGenericArgs)) {
                    // Register the class instantiation
                    const classKey = this.services.typing.MonomorphizationRegistry.registerClassInstantiation(
                        classDeclaration,
                        classGenericArgs
                    );

                    // Get the method declaration from the member access
                    const methodRef = node.expr.element.ref;
                    let methodHeader: ast.MethodHeader | undefined;

                    // The ref could be a ClassMethod or a MethodHeader directly
                    if (methodRef && ast.isClassMethod(methodRef)) {
                        methodHeader = methodRef.method;
                    } else if (methodRef && ast.isMethodHeader(methodRef)) {
                        methodHeader = methodRef;
                    }

                    if (methodHeader) {
                        // Extract method's generic parameters from substitutions if it has any
                        // For non-generic methods, pass empty array (they still need monomorphization since class is generic)
                        const methodTypeArgs = (substitutions && substitutions.size > 0)
                            ? Array.from(substitutions.values())
                            : [];
                        if (!hasErrorTypeArgs(methodTypeArgs)) {
                            this.services.typing.MonomorphizationRegistry.registerMethodInstantiation(
                                classKey,
                                methodHeader,
                                methodTypeArgs
                            );
                        }
                    }
                }

                // Register generic method instantiations on non-generic classes
                // e.g., TestUnit.assert_eq<u64>(...) where TestUnit is non-generic but assert_eq has type params
                if (classDeclaration && classGenericArgs.length === 0 && substitutions && substitutions.size > 0) {
                    const methodRef = node.expr.element.ref;
                    let methodHeader: ast.MethodHeader | undefined;

                    if (methodRef && ast.isClassMethod(methodRef)) {
                        methodHeader = methodRef.method;
                    } else if (methodRef && ast.isMethodHeader(methodRef)) {
                        methodHeader = methodRef;
                    }

                    if (methodHeader && methodHeader.genericParameters && methodHeader.genericParameters.length > 0) {
                        const classKey = classDeclaration.name;
                        const methodTypeArgs = Array.from(substitutions.values());
                        if (!hasErrorTypeArgs(methodTypeArgs)) {
                            this.services.typing.MonomorphizationRegistry.registerMethodInstantiation(
                                classKey,
                                methodHeader,
                                methodTypeArgs,
                                classDeclaration
                            );
                        }
                    }
                }
            }
            
            // Handle direct function calls (not methods) with generic instantiation
            if (substitutions && substitutions.size > 0) {
                if (ast.isQualifiedReference(node.expr)) {
                    const funcRef = node.expr.reference?.ref;
                    if (funcRef && ast.isFunctionDeclaration(funcRef) && funcRef.genericParameters && funcRef.genericParameters.length > 0) {
                        const typeArgs = Array.from(substitutions.values());
                        if (!hasErrorTypeArgs(typeArgs)) {
                            this.services.typing.MonomorphizationRegistry.registerFunctionInstantiation(
                                funcRef,
                                typeArgs
                            );
                        }
                    }
                }
            }

            // Apply substitutions to return type and parameter types if we have any
            let returnType = fnType.returnType;
            let resolvedParamTypes: readonly FunctionParameterType[] = fnType.parameters;
            if (substitutions && substitutions.size > 0) {
                returnType = this.typeUtils.substituteGenerics(fnType.returnType, substitutions);
                const finalSubstitutions = substitutions;
                resolvedParamTypes = fnType.parameters.map(param => ({
                    name: param.name,
                    type: this.typeUtils.substituteGenerics(param.type, finalSubstitutions),
                    isMut: param.isMut,
                    hasDefault: param.hasDefault
                }));

                // Validate operator constraints at call site (skip if already done in auto-inference path)
                if (!operatorConstraintsValidated) {
                    this.validateOperatorConstraintsAtCallSite(node, finalSubstitutions);
                }
            } else if (ast.isQualifiedReference(node.expr) && (node.expr.genericArgs?.length ?? 0) > 0) {
                // Only invoke fallback when explicit generic args exist but substitutions weren't built
                // (because the type provider already specialized the function type).
                if (!operatorConstraintsValidated) {
                    this.validateOperatorConstraintsAtCallSite(node, undefined);
                }
            }

            // Validate function call arg count and types
            this.validateFunctionCallArgs(node, resolvedParamTypes);

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
            // Validate variant constructor call args
            this.validateVariantConstructorCallArgs(node, fnType);

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
            // Validate variant constructor call args
            this.validateVariantConstructorCallArgs(node, fnType.baseVariantConstructor);

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

        // Validate multiple indices on basic types
        this.validateIndexAccessMultipleIndices(node);

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

        // Validate index set type compatibility and multiple indices
        this.validateIndexSet(node, baseType);
        this.validateIndexAccessMultipleIndices(node);

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

        // Validate reverse index set type compatibility
        this.validateReverseIndexSet(node, baseType);

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

        // Validate object update fields
        this.validateObjectUpdateFields(node);

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
            const expectedType = this.getExpectedArrayContextType(node);

            if (expectedType) {
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
        let elementTypes = node.values.map(v => {
            // Check if this is an array spread expression (...arr)
            if (ast.isArraySpreadExpression(v)) {
                // Infer the type of the spread expression
                const spreadType = this.inferExpression(v.expr);

                // Resolve reference types
                const resolvedSpreadType = this.typeUtils.resolveIfReference(spreadType);

                // The spread expression should be an array - extract its element type
                if (isArrayType(resolvedSpreadType)) {
                    return resolvedSpreadType.elementType;
                }

                // Validate: report array spread on non-array type
                this.addDiagnostic(v.expr, 'error',
                    `Array spread requires an array type, but got '${resolvedSpreadType.toString()}'. Only arrays can be spread in array literals.`,
                    ErrorCode.TC_ARRAY_SPREAD_REQUIRES_ARRAY
                );

                // Return a non-reportable error type for common type computation
                return this.typeFactory.createErrorType(
                    `Array spread requires an array type, but got '${resolvedSpreadType.toString()}'`,
                    undefined,
                    v,
                    false
                );
            }

            // Regular expression element
            return this.inferExpression(v.expr);
        });

        // Try contextual typing: if expected type is an array, check if all
        // elements are assignable to the expected element type
        const expectedType = this.getExpectedArrayContextType(node);
        if (expectedType) {
            const expectedElementType = expectedType.elementType;
            const allAssignable = elementTypes.every(elemType =>
                !isErrorType(elemType) &&
                this.typeUtils.isAssignable(elemType, expectedElementType).success
            );
            if (allAssignable) {
                return expectedType;
            }
        }

        // Literal glue: when there's no external contextual type, bare numeric literals
        // (without explicit suffix) should adopt the type of explicitly-typed siblings.
        // E.g., [1u32, 2] → the bare `2` glues to u32, so result is u32[] not i64[].
        if (!expectedType) {
            elementTypes = this.applyLiteralGlue(node, elementTypes);
        }

        // Filter out non-reportable error types (e.g., from invalid array spreads)
        // before computing the common type. The actual diagnostics for these are
        // reported by the specific validation methods (e.g., inferArraySpreadExpression).
        const validElementTypes = elementTypes.filter(t => !(isErrorType(t) && !t.reportable));
        const typesForCommon = validElementTypes.length > 0 ? validElementTypes : elementTypes;

        const commonType = this.typeUtils.getCommonType(typesForCommon);

        // If getCommonType returns an error, return it directly instead of wrapping in array
        // This ensures type errors are properly propagated to validation
        if (isErrorType(commonType)) {
            return commonType;
        }

        return this.typeFactory.createArrayType(commonType, node);
    }

    /**
     * Applies "literal glue" to array elements: bare numeric literals (no explicit suffix)
     * adopt the type of explicitly-typed siblings in the same array literal.
     *
     * E.g., `[1u32, 2]` → the bare `2` glues to `u32`, producing `u32[]` instead of `i64[]`.
     *
     * Rules:
     * - Only applies when there's no external contextual type annotation
     * - Finds an "anchor" type from elements with explicit type suffixes
     * - All anchors must agree on the same type
     * - Bare integer literals glue to integer anchors, bare float literals glue to float anchors
     * - Non-literal elements and suffixed literals are left unchanged
     */
    private applyLiteralGlue(node: ast.ArrayConstructionExpression, elementTypes: TypeDescription[]): TypeDescription[] {
        if (!node.values || node.values.length <= 1) {
            return elementTypes;
        }

        // Collect anchor types from explicitly-suffixed literals
        let anchorType: TypeDescription | undefined;
        let hasConflictingAnchors = false;

        for (const v of node.values) {
            if (ast.isArraySpreadExpression(v)) continue;

            const expr = v.expr;
            if (ast.isIntegerLiteral(expr)) {
                const suffixMatch = expr.value.match(/([iu])(8|16|32|64)$/);
                if (suffixMatch) {
                    const suffixType = this.typeFactory.createIntegerTypeFromString(suffixMatch[0], expr);
                    if (suffixType) {
                        if (anchorType && !this.typeUtils.areTypesEqual(anchorType, suffixType).success) {
                            hasConflictingAnchors = true;
                            break;
                        }
                        anchorType = suffixType;
                    }
                }
            } else if (ast.isFloatLiteral(expr)) {
                // FloatLiteral (has 'f' suffix) → f32 is anchor
                const f32Type = this.typeFactory.createF32Type(expr);
                if (anchorType && !this.typeUtils.areTypesEqual(anchorType, f32Type).success) {
                    hasConflictingAnchors = true;
                    break;
                }
                anchorType = f32Type;
            }
        }

        // If no anchor or conflicting anchors, fall back to default LUB
        if (!anchorType || hasConflictingAnchors) {
            return elementTypes;
        }

        // Re-infer bare literals using the anchor type as context
        return node.values.map((v, i) => {
            if (ast.isArraySpreadExpression(v)) return elementTypes[i];

            const expr = v.expr;

            // Check if this is a bare integer literal (no suffix)
            if (ast.isIntegerLiteral(expr)) {
                const hasSuffix = /([iu])(8|16|32|64)$/.test(expr.value);
                if (!hasSuffix && this.isIntegerType(anchorType!)) {
                    // Bare integer → glue to anchor type
                    return anchorType!;
                }
            }

            // Check if this is a bare float literal (DoubleLiteral, no 'f' suffix)
            if (ast.isFloatingPointLiteral(expr) && !ast.isFloatLiteral(expr)) {
                if (this.isFloatType(anchorType!)) {
                    // Bare float → glue to anchor type
                    return anchorType!;
                }
            }

            // Not a bare literal or anchor type mismatch → keep original
            return elementTypes[i];
        });
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

        // Validate spread field type compatibility
        this.validateStructSpreadFieldTypes(node);

        return this.typeFactory.createStructType(fields, false, node);
    }

    private inferAnonymousStructConstruction(node: ast.AnonymousStructConstructionExpression): TypeDescription {
        // Get the expected type from context
        const expectedType = this.getExpectedType(node);

        // Unwrap nullable and resolve reference types
        let resolvedExpectedType = expectedType;
        if (resolvedExpectedType && isNullableType(resolvedExpectedType)) {
            resolvedExpectedType = resolvedExpectedType.baseType;
        }
        if (resolvedExpectedType && isReferenceType(resolvedExpectedType)) {
            resolvedExpectedType = this.resolveReference(resolvedExpectedType);
        }
        if (resolvedExpectedType && isNullableType(resolvedExpectedType)) {
            resolvedExpectedType = resolvedExpectedType.baseType;
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
            // Attempt generic inference when the class is generic but no explicit generic args provided
            if (ast.isReferenceType(node.instanceType)) {
                const ref = node.instanceType.field?.ref;
                if (ref && ast.isTypeDeclaration(ref)) {
                    const astGenericParams = ref.genericParameters ?? [];
                    const providedGenericArgs = node.instanceType.genericArgs ?? [];

                    if (astGenericParams.length > 0 && providedGenericArgs.length === 0) {
                        // Get the unsubstituted class type to find init methods
                        const unsubstitutedType = this.getType(ref.definition);
                        if (isClassType(unsubstitutedType)) {
                            const initMethods = unsubstitutedType.methods.filter(m => m.names.includes('init'));
                            const args = node.args || [];
                            const argCount = args.length;

                            // Filter init methods by arity
                            const matchingArityMethods = initMethods.filter(m => {
                                const minArity = getMinArity(m.parameters);
                                return argCount >= minArity && argCount <= m.parameters.length;
                            });

                            if (matchingArityMethods.length > 0) {
                                const argumentTypes = args.map(arg => this.inferExpression(arg));
                                const genericParamNames = astGenericParams.map(p => p.name);

                                // Get GenericTypeDescriptions for constraint validation
                                const genericParamTypes = astGenericParams.map(p => this.getType(p)) as GenericTypeDescription[];

                                for (const initMethod of matchingArityMethods) {
                                    const parameterTypes = initMethod.parameters.map(p => p.type);

                                    let substitutions = this.inferGenericsFromArguments(
                                        genericParamNames,
                                        parameterTypes,
                                        argumentTypes
                                    );

                                    // Resolve remaining generics from operator constraints
                                    if (ref.operatorConstraints?.length) {
                                        this.resolveGenericsFromOperatorConstraints(
                                            ref.operatorConstraints,
                                            substitutions,
                                            genericParamNames,
                                            node
                                        );
                                    }

                                    // If all inferred generics are `never`, inference failed — fall through
                                    const allNever = Array.from(substitutions.values()).every(t => isNeverType(t));
                                    if (allNever) {
                                        break;
                                    }

                                    // Validate inferred types against generic parameter constraints
                                    for (let i = 0; i < genericParamTypes.length; i++) {
                                        const param = genericParamTypes[i];
                                        const inferredType = substitutions.get(param.name);
                                        if (inferredType && !isNeverType(inferredType)) {
                                            const constraint = param.constraint
                                                ? this.typeUtils.substituteGenerics(param.constraint, substitutions)
                                                : param.constraint;
                                            const constraintCheck = this.typeUtils.validateGenericConstraint(inferredType, constraint);
                                            if (!constraintCheck.success) {
                                                return this.typeFactory.createErrorType(
                                                    constraintCheck.message || `Inferred type does not satisfy generic constraint`,
                                                    undefined,
                                                    node
                                                );
                                            }
                                        }
                                    }

                                    // Create a ReferenceType with the inferred generic args
                                    const inferredGenericArgs = genericParamNames.map(
                                        name => substitutions.get(name) ?? this.typeFactory.createNeverType()
                                    );
                                    const result = this.typeFactory.createReferenceType(ref, inferredGenericArgs, node);
                                    // Validate new expression (class type, init methods, operator constraints)
                                    this.validateNewExpression(node, result);
                                    return result;
                                }
                            }
                        }
                    }
                }
            }

            const result = this.getType(node.instanceType);
            // Validate new expression (class type, init methods, operator constraints)
            this.validateNewExpression(node, result);
            return result;
        }

        return this.typeFactory.createErrorType('New expression without type', undefined, node);
    }

    private inferLambdaExpression(node: ast.LambdaExpression): TypeDescription {
        // Get expected lambda type for parameter inference
        let expectedLambdaType = this.getExpectedType(node);
        if (expectedLambdaType && isNullableType(expectedLambdaType)) {
            expectedLambdaType = expectedLambdaType.baseType;
        }
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
                    `Parameter '${arg.name ?? '<unnamed>'}' requires type annotation or must be in a context where type can be inferred`,
                    undefined,
                    arg
                );
            }

            return this.typeFactory.createFunctionParameterType(
                arg.name ?? '',
                paramType,
                arg.isMut
            );
        }) ?? [];

        const isCoroutine = node.fnType === 'cfn';

        let returnType: TypeDescription;
        const declaredReturnType = node.header.returnType ? this.getType(node.header.returnType) : undefined;

        if (declaredReturnType) {
            // Explicit return/yield type provided
            returnType = declaredReturnType;
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

        // --- Validation (Phase 5): return/yield checks as side-effect of inference ---
        if (declaredReturnType) {
            // Infer from body to validate against declared type
            let inferredReturnType: TypeDescription;
            if (node.expr) {
                inferredReturnType = this.getType(node.expr);
            } else if (node.body) {
                inferredReturnType = isCoroutine
                    ? this.inferYieldTypeFromBody(node.body, node.expr)
                    : this.inferReturnTypeFromBody(node.body, node.expr);
            } else {
                inferredReturnType = this.typeFactory.createVoidType(node);
            }

            this.validateReturnYieldSemantics(
                node.body, isCoroutine, declaredReturnType, inferredReturnType, node,
                node.expr ?? node.header.returnType, 'lambda'
            );

            if (isCoroutine) {
                this.validateYieldExpressions(node.body, declaredReturnType, node);
            } else {
                this.validateReturnStatements(node.body, declaredReturnType, node);
            }
        } else {
            // No declared type — validate structural rules with inferred type
            this.validateReturnYieldSemantics(
                node.body, isCoroutine, undefined, returnType, node, node, 'lambda'
            );
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

        // Validate cast expression
        this.validateTypeCastExpression(node);

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

        // Validate denull on non-nullable types
        this.validateDenullExpression(node, exprType);

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
                arg.name ?? '',
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
        this.overloadResolutionDepth++;
        try {
            const expressionTypes = args.map(arg => this.inferExpression(arg));
            const argCount = expressionTypes.length;

            // Filter candidates by arity range (accounts for default parameters)
            const argBasedCandidates = functions.filter(fn => {
                const minArity = getMinArity(fn.parameters);
                return argCount >= minArity && argCount <= fn.parameters.length;
            });

            if (argBasedCandidates.length === 1) {
                return [functions.indexOf(argBasedCandidates[0])];
            }

            const finalCandidates = [];
            // First prio is exact match (only check provided args)
            for (const fn of argBasedCandidates) {
                let allMatch = true;
                for (let i = 0; i < argCount; i++) {
                    if (!this.typeUtils.areTypesEqual(expressionTypes[i], fn.parameters[i].type).success) {
                        allMatch = false;
                        break;
                    }
                }
                if (allMatch) finalCandidates.push(fn);
            }

            // Second prio is assignable match (only check provided args)
            if (finalCandidates.length === 0) {
                for (const fn of argBasedCandidates) {
                    let allMatch = true;
                    for (let i = 0; i < argCount; i++) {
                        if (!this.typeUtils.isAssignable(expressionTypes[i], fn.parameters[i].type).success) {
                            allMatch = false;
                            break;
                        }
                    }
                    if (allMatch) finalCandidates.push(fn);
                }
            }
            return finalCandidates.map(fn => functions.indexOf(fn));
        } finally {
            this.overloadResolutionDepth--;
        }
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

    // ========================================================================
    // Declaration Validation (migrated from declaration-diagnostics Phase 8)
    // ========================================================================

    /**
     * Public entry point for declaration-level validation on nodes that
     * do NOT have their own infer*() method (or where validation must be
     * triggered explicitly from the tree walk).
     *
     * Called from the thin validator's triggerTypeInference walk.
     */
    validateDeclarationNode(node: AstNode): void {
        if (ast.isVariableDeclSingle(node)) {
            this.validateVariableDeclSingle(node);
        } else if (ast.isVariableDeclArrayDestructuring(node)) {
            this.validateVariableDeclArrayDestructuring(node);
        } else if (ast.isVariableDeclStructDestructuring(node)) {
            this.validateVariableDeclStructDestructuring(node);
        } else if (ast.isVariableDeclTupleDestructuring(node)) {
            this.validateVariableDeclTupleDestructuring(node);
        } else if (ast.isFunctionParameter(node)) {
            this.validateFunctionParameter(node);
        } else if (ast.isClassAttributeDecl(node)) {
            this.validateClassAttributeDecl(node);
        } else if (ast.isIteratorVar(node)) {
            this.validateIteratorVar(node);
        } else if (ast.isVariablePattern(node)) {
            this.validateVariablePatternDecl(node);
        } else if (ast.isForEachIterator(node)) {
            this.validateForEachIterator(node);
        } else if (ast.isForRangeIterator(node)) {
            this.validateForRangeIterator(node);
        } else if (ast.isQualifiedReference(node)) {
            this.validateQualifiedReferenceGenerics(node);
        } else if (ast.isImplementationMethodDecl(node)) {
            this.validateImplMethodDefaults(node);
        } else if (ast.isInterfaceType(node)) {
            this.validateInterfaceType(node);
        } else if (ast.isClassType(node)) {
            this.validateClassImplementation(node);
        } else if (ast.isImplementationType(node)) {
            this.validateImplementationType(node);
        } else if (ast.isClassImplementationMethodDecl(node)) {
            this.validateClassImplDeclaration(node);
        } else if (ast.isMatchCasePattern(node)) {
            this.validatePatternErrors(node);
        }

        // DataType-specific checks run for ALL DataType subtypes (NullableType, ReferenceType, etc.)
        // The original collector dispatched checkType for every DataType via isSubtype matching,
        // in addition to specific handlers. We must preserve that behavior.
        if (ast.isDataType(node)) {
            // Specific NullableType / ReferenceType checks
            if (ast.isNullableType(node)) {
                this.validateNullableType(node);
            } else if (ast.isReferenceType(node)) {
                this.validateReferenceType(node);
            }
            // Recursive type-error check for ALL DataType nodes
            this.validateDataType(node);
        }
    }

    /**
     * Validate default parameters for a function declaration.
     * Called as a side-effect from inferFunctionDeclaration.
     */
    private validateFunctionDefaults(node: ast.FunctionDeclaration): void {
        const params = node.header?.args ?? [];
        this.validateDefaultParamOrdering(params);
        this.validateDefaultParamTypes(params);
        this.validateDefaultExpressionScope(params);
    }

    /**
     * Validate class method overrides and default parameters.
     * Called as deferred validation from validateClassMethodReturnType
     * (AFTER all types are cached, to avoid cycles).
     */
    private validateClassMethodDeclaration(node: ast.ClassMethod): void {
        this.validateOverrideMethod(node);
        const params = node.method?.header?.args ?? [];
        this.validateDefaultParamOrdering(params);
        this.validateDefaultParamTypes(params);
        this.validateDefaultExpressionScope(params);
    }

    // --- Variable Declaration Checks ---

    private validateVariableDeclSingle(node: ast.VariableDeclSingle): void {
        // Get the final type that will be assigned to this variable
        let finalType: TypeDescription;

        if (node.annotation) {
            finalType = this.getType(node.annotation);
        } else if (node.initializer) {
            finalType = this.getType(node.initializer);
            if (isErrorType(finalType)) {
                this.addDiagnostic(node, 'error', finalType.message, ErrorCode.TC_EXPRESSION_TYPE_ERROR);
            }
        } else {
            return; // No type to check
        }

        // Resolve references to get the actual type
        finalType = this.typeUtils.resolveIfReference(finalType);

        // Check if the final variable type is a nullable basic type
        if (isNullableType(finalType) && this.typeUtils.isTypeBasic(finalType.baseType)) {
            const errorNode = node.annotation || node.initializer || node;
            this.addDiagnostic(errorNode, 'error',
                `Variable '${node.name}' cannot have nullable basic type '${finalType.toString()}'. ` +
                `Basic types cannot be nullable. ` +
                `Consider using a reference type or handling null with the ?? operator.`,
                ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE
            );
            return;
        }

        // Check if non-const variable is assigned from a const expression
        if (!node.isConst && node.initializer) {
            const constSource = getConstSource(node.initializer);
            if (constSource) {
                const initializerType = this.getType(node.initializer);
                const resolvedType = this.typeUtils.resolveIfReference(initializerType);

                if (!this.typeUtils.isTypeBasic(resolvedType)) {
                    this.addDiagnostic(node.initializer, 'error',
                        `Cannot assign ${constSource.description} to non-const variable '${node.name}'. ` +
                        `Reference types must preserve const-ness. Either declare the variable as const (let const ${node.name} = ...) or assign from a mutable source.`,
                        ErrorCode.TC_ASSIGNMENT_FROM_CONST_TO_MUTABLE
                    );
                }
            }
        }

        // Only check type compatibility if there's both annotation AND initializer
        if (!node.annotation || !node.initializer) {
            return;
        }

        let expectedType = this.getType(node.annotation);
        let inferredType = this.getType(node.initializer);

        expectedType = this.typeUtils.resolveIfReference(expectedType);
        inferredType = this.typeUtils.resolveIfReference(inferredType);

        const compatResult = this.typeUtils.isAssignable(inferredType, expectedType);
        if (!compatResult.success) {
            let errorMsg: string;
            let errorCode: ErrorCode;

            if (isInterfaceType(expectedType) && isClassType(inferredType)) {
                errorCode = ErrorCode.TC_VARIABLE_INTERFACE_IMPLEMENTATION_ERROR;
                errorMsg = `Variable '${node.name}' type error: Class '${inferredType.toString()}' must implement interface '${expectedType.toString()}'`;
                if (compatResult.message) {
                    errorMsg += `. Implementation issue: ${compatResult.message}`;
                }
            } else {
                errorCode = ErrorCode.TC_VARIABLE_TYPE_MISMATCH;
                errorMsg = compatResult.message
                    ? `Variable '${node.name}' type mismatch: ${compatResult.message}`
                    : `Variable '${node.name}' type mismatch: Expected type '${expectedType.toString()}', but got '${inferredType.toString()}'`;
            }
            this.addDiagnostic(node.initializer, 'error', errorMsg, errorCode, 'initializer');
        }
    }

    private validateVariableDeclArrayDestructuring(node: ast.VariableDeclArrayDestructuring): void {
        if (!node.initializer || node.isConst) {
            return;
        }

        const constSource = getConstSource(node.initializer);
        if (!constSource) {
            return;
        }

        for (const element of node.elements) {
            if (!ast.isDestructuringElement(element)) {
                continue;
            }

            const elementType = this.getType(element);
            const resolvedType = this.typeUtils.resolveIfReference(elementType);

            if (!this.typeUtils.isTypeBasic(resolvedType)) {
                this.addDiagnostic(element, 'error',
                    `Cannot assign element from ${constSource.description} to non-const variable '${element.name}'. ` +
                    `Reference types must preserve const-ness. Either declare as const (let const [...] = ...) or assign from a mutable source.`,
                    ErrorCode.TC_ASSIGNMENT_FROM_CONST_TO_MUTABLE, 'name'
                );
            }
        }
    }

    private validateVariableDeclStructDestructuring(node: ast.VariableDeclStructDestructuring): void {
        if (!node.initializer || node.isConst) {
            return;
        }

        const constSource = getConstSource(node.initializer);
        if (!constSource) {
            return;
        }

        for (const element of node.elements) {
            if (!ast.isDestructuringElement(element)) {
                continue;
            }

            const elementType = this.getType(element);
            const resolvedType = this.typeUtils.resolveIfReference(elementType);

            if (!this.typeUtils.isTypeBasic(resolvedType)) {
                const fieldName = element.originalName || element.name;
                this.addDiagnostic(element, 'error',
                    `Cannot assign field '${fieldName}' from ${constSource.description} to non-const variable '${element.name}'. ` +
                    `Reference types must preserve const-ness. Either declare as const (let const {...} = ...) or assign from a mutable source.`,
                    ErrorCode.TC_ASSIGNMENT_FROM_CONST_TO_MUTABLE, 'name'
                );
            }
        }
    }

    private validateVariableDeclTupleDestructuring(node: ast.VariableDeclTupleDestructuring): void {
        if (!node.initializer || node.isConst) {
            return;
        }

        const constSource = getConstSource(node.initializer);
        if (!constSource) {
            return;
        }

        for (const element of node.elements) {
            if (!ast.isDestructuringElement(element)) {
                continue;
            }

            const elementType = this.getType(element);
            const resolvedType = this.typeUtils.resolveIfReference(elementType);

            if (!this.typeUtils.isTypeBasic(resolvedType)) {
                this.addDiagnostic(element, 'error',
                    `Cannot assign tuple element from ${constSource.description} to non-const variable '${element.name}'. ` +
                    `Reference types must preserve const-ness. Either declare as const (let const (...) = ...) or assign from a mutable source.`,
                    ErrorCode.TC_ASSIGNMENT_FROM_CONST_TO_MUTABLE, 'name'
                );
            }
        }
    }

    // --- Function Parameter / Class Attribute / Iterator Checks ---

    private validateFunctionParameter(node: ast.FunctionParameter): void {
        if (!node.type) return;

        const paramType = this.getType(node.type);
        const errorMsg = checkForNullableBasicType(this.typeUtils, paramType);

        if (errorMsg) {
            this.addDiagnostic(node.type, 'error',
                `Parameter '${node.name ?? '<unnamed>'}' cannot have ${errorMsg}`,
                ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE
            );
        }
    }

    private validateClassAttributeDecl(node: ast.ClassAttributeDecl): void {
        // Validate that attribute has either type or initializer (or both)
        if (!node.type && !node.initializer) {
            this.addDiagnostic(node, 'error',
                `Class attribute '${node.name}' must have either a type annotation or an initializer`,
                ErrorCode.TC_CLASS_ATTRIBUTE_MISSING_TYPE_OR_INITIALIZER
            );
            return;
        }

        // Get the final type of the attribute
        let finalType: TypeDescription;

        if (node.type) {
            finalType = this.getType(node.type);
        } else if (node.initializer) {
            finalType = this.getType(node.initializer);
            if (isErrorType(finalType)) {
                this.addDiagnostic(node.initializer, 'error', finalType.message,
                    ErrorCode.TC_EXPRESSION_TYPE_ERROR
                );
                return;
            }
        } else {
            return;
        }

        finalType = this.typeUtils.resolveIfReference(finalType);

        // Check nullable basic type
        if (isNullableType(finalType) && this.typeUtils.isTypeBasic(finalType.baseType)) {
            const errorNode = node.type || node.initializer || node;
            this.addDiagnostic(errorNode, 'error',
                `Attribute '${node.name}' cannot have nullable basic type '${finalType.toString()}'. ` +
                `Basic types cannot be nullable. ` +
                `Consider using a reference type or handling null with the ?? operator.`,
                ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE
            );
            return;
        }

        // Check const assignment
        if (!node.isConst && node.initializer) {
            const constSource = getConstSource(node.initializer);
            if (constSource) {
                const initializerType = this.getType(node.initializer);
                const resolvedType = this.typeUtils.resolveIfReference(initializerType);

                if (!this.typeUtils.isTypeBasic(resolvedType)) {
                    this.addDiagnostic(node.initializer, 'error',
                        `Cannot assign ${constSource.description} to non-const attribute '${node.name}'. ` +
                        `Reference types must preserve const-ness. Either declare the attribute as const (let const ${node.name} = ...) or assign from a mutable source.`,
                        ErrorCode.TC_ASSIGNMENT_FROM_CONST_TO_MUTABLE
                    );
                }
            }
        }

        // Check type compatibility if both annotation and initializer
        if (!node.type || !node.initializer) {
            return;
        }

        let expectedType = this.getType(node.type);
        let inferredType = this.getType(node.initializer);

        expectedType = this.typeUtils.resolveIfReference(expectedType);
        inferredType = this.typeUtils.resolveIfReference(inferredType);

        const compatResult = this.typeUtils.isAssignable(inferredType, expectedType);
        if (!compatResult.success) {
            const errorCode = ErrorCode.TC_VARIABLE_TYPE_MISMATCH;
            const errorMsg = compatResult.message
                ? `Attribute '${node.name}' type mismatch: ${compatResult.message}`
                : `Attribute '${node.name}' type mismatch: Expected type '${expectedType.toString()}', but got '${inferredType.toString()}'`;
            this.addDiagnostic(node.initializer, 'error', errorMsg, errorCode, 'initializer');
        }
    }

    private validateIteratorVar(node: ast.IteratorVar): void {
        const varType = this.getType(node);
        const errorMsg = checkForNullableBasicType(this.typeUtils, varType);

        if (errorMsg) {
            this.addDiagnostic(node, 'error',
                `Iterator variable '${node.name}' cannot have ${errorMsg}`,
                ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE
            );
        }
    }

    private validateVariablePatternDecl(node: ast.VariablePattern): void {
        const varType = this.getType(node);
        const errorMsg = checkForNullableBasicType(this.typeUtils, varType);

        if (errorMsg) {
            this.addDiagnostic(node, 'error',
                `Pattern variable '${node.name}' cannot have ${errorMsg}`,
                ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE
            );
        }
    }

    // --- Iterator Checks ---

    private validateForEachIterator(node: ast.ForEachIterator): void {
        const iteratorType = this.getType(node.valueVar);

        if (isErrorType(iteratorType)) {
            this.addDiagnostic(node.valueVar, 'error',
                iteratorType.message || 'Cannot infer iterator variable type',
                ErrorCode.TC_EXPRESSION_TYPE_ERROR
            );
        }
    }

    private validateForRangeIterator(node: ast.ForRangeIterator): void {
        let startType = this.getType(node.start);
        let endType = this.getType(node.end);
        let stepType = this.getType(node.step);

        startType = this.typeUtils.resolveIfReference(startType);
        endType = this.typeUtils.resolveIfReference(endType);
        stepType = this.typeUtils.resolveIfReference(stepType);

        const hasError = isErrorType(startType) || isErrorType(endType) || isErrorType(stepType);

        if (!hasError) {
            if (!this.isIntegerType(startType) && startType.kind !== TypeKind.Never) {
                this.addDiagnostic(node.start, 'error',
                    `Range start must be a non-floating point integer, but got '${startType.toString()}'`,
                    ErrorCode.TC_EXPRESSION_TYPE_ERROR
                );
            }

            if (!this.isIntegerType(endType) && endType.kind !== TypeKind.Never) {
                this.addDiagnostic(node.end, 'error',
                    `Range end must be a non-floating point integer, but got '${endType.toString()}'`,
                    ErrorCode.TC_EXPRESSION_TYPE_ERROR
                );
            }

            if (!this.isIntegerType(stepType) && stepType.kind !== TypeKind.Never) {
                this.addDiagnostic(node.step, 'error',
                    `Range step must be a non-floating point integer, but got '${stepType.toString()}'`,
                    ErrorCode.TC_EXPRESSION_TYPE_ERROR
                );
            } else if (this.isIntegerType(stepType)) {
                const signedTypes = [TypeKind.I8, TypeKind.I16, TypeKind.I32, TypeKind.I64];
                if (signedTypes.includes(stepType.kind)) {
                    this.addDiagnostic(node.step, 'error',
                        `Range step must be a positive integer (unsigned type), but got signed type '${stepType.toString()}'. Use u8, u16, u32, or u64 instead.`,
                        ErrorCode.TC_EXPRESSION_TYPE_ERROR
                    );
                }
            }
        }

        // Validate iterator type annotation if specified
        if (node.iterType) {
            let iterType = this.getType(node.iterType);
            iterType = this.typeUtils.resolveIfReference(iterType);

            if (!this.isIntegerType(iterType) && !isErrorType(iterType) && iterType.kind !== TypeKind.Never) {
                this.addDiagnostic(node.iterType, 'error',
                    `Range iterator type must be a non-floating point integer, but got '${iterType.toString()}'`,
                    ErrorCode.TC_EXPRESSION_TYPE_ERROR
                );
            }
        }

        // Validate iterator variable type
        const valueVarType = this.getType(node.valueVar);

        if (isErrorType(valueVarType)) {
            this.addDiagnostic(node.valueVar, 'error',
                valueVarType.message || 'Cannot infer iterator variable type',
                ErrorCode.TC_EXPRESSION_TYPE_ERROR
            );
        }
    }

    // --- Type Annotation Checks ---

    private validateNullableType(node: ast.NullableType): void {
        const type = this.getType(node.baseType);

        if (this.typeUtils.isTypeBasic(type)) {
            this.addDiagnostic(node, 'error', 'Basic types cannot be nullables',
                ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE
            );
        }
    }

    private validateReferenceType(node: ast.ReferenceType): void {
        const ref = node.field?.ref;
        if (!ref) {
            return;
        }

        // Check if the reference points to a variable instead of a type
        const isVariable =
            ast.isVariableDeclaration(ref) ||
            ast.isFunctionParameter(ref) ||
            ast.isClassAttributeDecl(ref) ||
            ast.isIteratorVar(ref) ||
            ast.isVariablePattern(ref);

        if (isVariable) {
            const variableKind = ast.isVariableDeclaration(ref) ? 'variable' :
                                ast.isFunctionParameter(ref) ? 'parameter' :
                                ast.isClassAttributeDecl(ref) ? 'attribute' :
                                ast.isIteratorVar(ref) ? 'iterator variable' :
                                'pattern variable';
            this.addDiagnostic(node, 'error',
                `Cannot use ${variableKind} '${getReferenceName(ref)}' as a type. Type annotations must reference type declarations, not variables.`,
                ErrorCode.TC_VARIABLE_USED_AS_TYPE, 'field'
            );
            return;
        }

        if (!ast.isTypeDeclaration(ref)) {
            return;
        }

        const expectedGenericCount = ref.genericParameters?.length ?? 0;
        const providedGenericArgs = node.genericArgs ?? [];
        const providedGenericCount = providedGenericArgs.length;

        if (expectedGenericCount === 0 && providedGenericCount > 0) {
            this.addDiagnostic(node, 'error',
                `Type '${ref.name}' does not accept generic arguments`,
                ErrorCode.TC_NON_GENERIC_TYPE_WITH_ARGS
            );
            return;
        }

        if (providedGenericCount > 0 && providedGenericCount !== expectedGenericCount) {
            this.addDiagnostic(node, 'error',
                `Type '${ref.name}' expects ${expectedGenericCount} generic argument(s), but got ${providedGenericCount}`,
                ErrorCode.TC_GENERIC_ARG_COUNT_MISMATCH
            );
        }
    }

    private validateQualifiedReferenceGenerics(node: ast.QualifiedReference): void {
        const ref = node.reference?.ref;
        if (!ref) {
            return;
        }

        const refType = this.getType(ref);
        const resolvedType = this.typeUtils.resolveIfReference(refType);

        const providedGenericArgs = node.genericArgs ?? [];
        const providedGenericCount = providedGenericArgs.length;

        if (isFunctionType(resolvedType)) {
            const genericParams = resolvedType.genericParameters || [];
            const expectedGenericCount = genericParams.length;

            if (expectedGenericCount === 0 && providedGenericCount > 0) {
                this.addDiagnostic(node, 'error',
                    `Function '${ref.$type === 'FunctionDeclaration' ? (ref as ast.FunctionDeclaration).name : 'function'}' does not accept generic arguments`,
                    ErrorCode.TC_NON_GENERIC_TYPE_WITH_ARGS
                );
                return;
            }

            if ((expectedGenericCount > 0 && providedGenericCount === 0) && !ast.isFunctionCall(node.$container)) {
                this.addDiagnostic(node, 'error',
                    `Generic function requires ${expectedGenericCount} generic argument(s). Example: ${ref.$type === 'FunctionDeclaration' ? (ref as ast.FunctionDeclaration).name : 'function'}<${genericParams.map(p => p.name).join(', ')}>`,
                    ErrorCode.TC_GENERIC_ARG_COUNT_MISMATCH
                );
                return;
            }

            if (providedGenericCount > 0 && providedGenericCount !== expectedGenericCount) {
                this.addDiagnostic(node, 'error',
                    `Generic argument count mismatch: Expected ${expectedGenericCount} generic argument(s), but got ${providedGenericCount}`,
                    ErrorCode.TC_GENERIC_ARG_COUNT_MISMATCH
                );
            }
        } else if (providedGenericCount > 0) {
            this.addDiagnostic(node, 'error',
                `Cannot apply generic arguments to non-generic entity '${resolvedType.toString()}'`,
                ErrorCode.TC_NON_GENERIC_TYPE_WITH_ARGS
            );
        }
    }

    private validateDataType(node: ast.DataType): void {
        const type = this.typeUtils.resolveIfReference(this.getType(node));
        this.checkTypeForErrors(type, node);
    }

    /**
     * Recursively check a type and its nested types for errors.
     */
    private checkTypeForErrors(type: TypeDescription, node: AstNode): void {
        if (isErrorType(type)) {
            const message = type.message;

            if (message === '__recursion_placeholder__' ||
                message === '__contextual_placeholder__' ||
                message?.includes('placeholder')) {
                return;
            }

            this.addDiagnostic(node, 'error', message || 'Type error',
                ErrorCode.TC_EXPRESSION_TYPE_ERROR
            );
            return;
        }

        if (type.errors && type.errors.length > 0) {
            for (const errorMsg of type.errors) {
                this.addDiagnostic(node, 'error', errorMsg,
                    ErrorCode.TC_EXPRESSION_TYPE_ERROR
                );
            }
        }

        // Recursively check nested types
        if (isArrayType(type)) {
            this.checkTypeForErrors(type.elementType, node);
        } else if (isNullableType(type)) {
            this.checkTypeForErrors(type.baseType, node);
        } else if (isUnionType(type)) {
            for (const t of type.types) {
                this.checkTypeForErrors(t, node);
            }
        } else if (isJoinType(type)) {
            for (const t of type.types) {
                this.checkTypeForErrors(t, node);
            }
        } else if (isTupleType(type)) {
            for (const t of type.elementTypes) {
                this.checkTypeForErrors(t, node);
            }
        } else if (isStructType(type)) {
            for (const field of type.fields) {
                this.checkTypeForErrors(field.type, node);
            }
        } else if (isReferenceType(type) && type.genericArgs.length > 0) {
            for (const arg of type.genericArgs) {
                this.checkTypeForErrors(arg, node);
            }
        }
    }

    // --- Default Parameter Checks ---

    private validateDefaultParamOrdering(params: ast.FunctionParameter[]): void {
        let seenDefault = false;
        for (const param of params) {
            if (param.defaultValue) {
                seenDefault = true;
            } else if (seenDefault) {
                this.addDiagnostic(param, 'error',
                    `Required parameter '${param.name}' cannot appear after a parameter with a default value.`,
                    ErrorCode.TC_DEFAULT_PARAM_BEFORE_REQUIRED, 'name'
                );
            }
        }
    }

    private validateDefaultParamTypes(params: ast.FunctionParameter[]): void {
        for (const param of params) {
            if (param.defaultValue && param.type) {
                const paramType = this.getType(param.type);
                const defaultType = this.getType(param.defaultValue);

                const result = this.typeUtils.isAssignable(
                    this.typeUtils.resolveIfReference(defaultType),
                    this.typeUtils.resolveIfReference(paramType)
                );
                if (!result.success) {
                    this.addDiagnostic(param.defaultValue, 'error',
                        `Default value type mismatch: Parameter '${param.name}' has type '${paramType.toString()}', but default value has type '${defaultType.toString()}'`,
                        ErrorCode.TC_DEFAULT_PARAM_TYPE_MISMATCH
                    );
                }
            }
        }
    }

    private validateDefaultExpressionScope(params: ast.FunctionParameter[]): void {
        const paramNames = new Set(params.map(p => p.name));

        for (const param of params) {
            if (!param.defaultValue) continue;

            const nodesToCheck = [param.defaultValue, ...AstUtils.streamAllContents(param.defaultValue)];
            for (const child of nodesToCheck) {
                if (ast.isQualifiedReference(child)) {
                    const ref = child.reference?.ref;
                    if (!ref) continue;

                    if (ast.isFunctionParameter(ref) && paramNames.has(ref.name)) {
                        this.addDiagnostic(child, 'error',
                            `Default value for '${param.name}' cannot reference parameter '${ref.name}'. Default expressions are evaluated at the call site and cannot access other parameters.`,
                            ErrorCode.TC_DEFAULT_PARAM_REFERENCES_LOCAL
                        );
                    }

                    if (ast.isVariableDeclaration(ref) || ast.isVariableDeclSingle(ref)) {
                        const containingFn = AstUtils.getContainerOfType(ref, ast.isFunctionDeclaration);
                        const containingMethod = AstUtils.getContainerOfType(ref, ast.isClassMethod);
                        const containingImpl = AstUtils.getContainerOfType(ref, ast.isImplementationMethodDecl);
                        if (containingFn || containingMethod || containingImpl) {
                            const varName = ast.isVariableDeclSingle(ref) ? ref.name : '(variable)';
                            this.addDiagnostic(child, 'error',
                                `Default value for '${param.name}' cannot reference local variable '${varName}'. Default expressions are evaluated at the call site and cannot access local scope.`,
                                ErrorCode.TC_DEFAULT_PARAM_REFERENCES_LOCAL
                            );
                        }
                    }
                }

                if (ast.isThisExpression(child)) {
                    this.addDiagnostic(child, 'error',
                        `Default value for '${param.name}' cannot reference 'this'. Default expressions are evaluated at the call site.`,
                        ErrorCode.TC_DEFAULT_PARAM_REFERENCES_LOCAL
                    );
                }
            }
        }
    }

    // --- Override Method Check ---

    private validateOverrideMethod(node: ast.ClassMethod): void {
        if (!node.isOverride) {
            return;
        }

        const classNode = AstUtils.getContainerOfType(node, ast.isClassType);
        if (!classNode) {
            return;
        }

        const classType = this.getType(classNode);
        if (!isClassType(classType)) {
            return;
        }

        const overrideMethodNames = node.method.names;

        for (const methodName of overrideMethodNames) {
            const implMethods: MethodType[] = [];

            for (const implRef of classType.implementations) {
                const implType = this.resolveReference(implRef);

                if (isImplementationType(implType)) {
                    let substitutions: Map<string, TypeDescription> | undefined;
                    if (isReferenceType(implRef) && implRef.genericArgs.length > 0 && implRef.declaration.genericParameters) {
                        substitutions = new Map<string, TypeDescription>();
                        implRef.declaration.genericParameters.forEach((param, i) => {
                            if (i < implRef.genericArgs.length) {
                                substitutions!.set(param.name, implRef.genericArgs[i]);
                            }
                        });
                    }

                    for (const implMethod of implType.methods) {
                        if (implMethod.names.includes(methodName)) {
                            if (substitutions && substitutions.size > 0) {
                                implMethods.push({
                                    ...implMethod,
                                    parameters: implMethod.parameters.map(p => ({
                                        name: p.name,
                                        type: this.typeUtils.substituteGenerics(p.type, substitutions!),
                                        isMut: p.isMut,
                                        hasDefault: p.hasDefault
                                    })),
                                    returnType: this.typeUtils.substituteGenerics(implMethod.returnType, substitutions!)
                                });
                            } else {
                                implMethods.push(implMethod);
                            }
                        }
                    }
                }
            }

            if (implMethods.length === 0) {
                this.addDiagnostic(node.method, 'error',
                    `Override method '${methodName}' does not override any method from implementations. ` +
                    `The 'override' keyword can only be used when overriding a method provided by an impl.`,
                    ErrorCode.TC_OVERRIDE_WITHOUT_IMPL_METHOD, 'names'
                );
                continue;
            }

            let overrideMethodType: MethodType | undefined;

            if (classType.methods) {
                overrideMethodType = classType.methods.find(m =>
                    m.names.includes(methodName) &&
                    m.parameters.length === (node.method.header?.args?.length ?? 0)
                );
            }

            if (!overrideMethodType) {
                continue;
            }

            let foundMatch = false;
            const signatureMismatchDetails: string[] = [];

            for (const implMethod of implMethods) {
                if (overrideMethodType.parameters.length !== implMethod.parameters.length) {
                    signatureMismatchDetails.push(
                        `Expected ${implMethod.parameters.length} parameter(s), got ${overrideMethodType.parameters.length}`
                    );
                    continue;
                }

                let parametersMatch = true;
                for (let i = 0; i < overrideMethodType.parameters.length; i++) {
                    const overrideParam = overrideMethodType.parameters[i];
                    const implParam = implMethod.parameters[i];

                    const compatResult = this.typeUtils.areTypesEqual(overrideParam.type, implParam.type);
                    if (!compatResult.success) {
                        parametersMatch = false;
                        signatureMismatchDetails.push(
                            `Parameter ${i + 1} type mismatch: expected '${implParam.type.toString()}', got '${overrideParam.type.toString()}'`
                        );
                        break;
                    }

                    const overrideIsMut = overrideParam.isMut || false;
                    const implIsMut = implParam.isMut || false;

                    if (overrideIsMut && !implIsMut) {
                        parametersMatch = false;
                        signatureMismatchDetails.push(
                            `Parameter ${i + 1} mutability mismatch: impl parameter is immutable, but override parameter is mutable. ` +
                            `Override cannot be more permissive than the impl method.`
                        );
                        break;
                    }
                }

                if (!parametersMatch) {
                    continue;
                }

                const returnTypeCompat = this.typeUtils.isAssignable(
                    this.typeUtils.resolveIfReference(overrideMethodType.returnType),
                    this.typeUtils.resolveIfReference(implMethod.returnType)
                );
                if (!returnTypeCompat.success) {
                    signatureMismatchDetails.push(
                        `Return type mismatch: expected '${implMethod.returnType.toString()}', got '${overrideMethodType.returnType.toString()}'`
                    );
                    continue;
                }

                foundMatch = true;
                break;
            }

            if (!foundMatch) {
                const implSignatures = implMethods.map(m =>
                    `${methodName}(${m.parameters.map(p => p.type.toString()).join(', ')}) -> ${m.returnType.toString()}`
                ).join(' or ');

                this.addDiagnostic(node.method, 'error',
                    `Override method '${methodName}' signature does not match any impl method. ` +
                    `Expected: ${implSignatures}. ` +
                    `Issues: ${signatureMismatchDetails.join('; ')}`,
                    ErrorCode.TC_OVERRIDE_SIGNATURE_MISMATCH, 'names'
                );
            }
        }
    }

    // --- Impl Method Default Parameter Checks ---

    private validateImplMethodDefaults(node: ast.ImplementationMethodDecl): void {
        const params = node.method?.header?.args ?? [];
        this.validateDefaultParamOrdering(params);
        this.validateDefaultParamTypes(params);
        this.validateDefaultExpressionScope(params);
    }

    // ========================================================================
    // Class/Interface Validation (migrated from class-interface-diagnostics Phase 9)
    // ========================================================================

    /**
     * Validate join (intersection) types.
     *
     * Rules:
     * 1. Join types can only combine interfaces and structs (not classes, enums, etc.)
     * 2. Cannot mix interfaces with structs in the same join
     * 3. Struct combination must have unique fields (no duplicate field names)
     * 4. Interface combination must have unique method signatures (overloading is allowed)
     */
    private validateJoinType(node: ast.JoinType): void {
        // Get the joined types
        const leftType = this.getType(node.left);
        const rightType = this.getType(node.right);

        // Resolve references
        const resolvedLeft = this.typeUtils.resolveIfReference(leftType);
        const resolvedRight = this.typeUtils.resolveIfReference(rightType);

        // Collect all types from nested joins
        const allTypes: TypeDescription[] = [];
        this.collectJoinTypesForValidation(resolvedLeft, allTypes);
        this.collectJoinTypesForValidation(resolvedRight, allTypes);

        // Validate that all types are either interfaces or structs
        const hasInterface = allTypes.some(t => isInterfaceType(t));
        const hasStruct = allTypes.some(t => isStructType(t));
        const hasOther = allTypes.some(t => !isInterfaceType(t) && !isStructType(t));

        // Check rule 1: Only interfaces and structs allowed
        if (hasOther) {
            const invalidType = allTypes.find(t => !isInterfaceType(t) && !isStructType(t));
            this.addDiagnostic(node, 'error',
                `Join type invalid member: Join types can only combine interfaces and structs. Found invalid type: ${invalidType?.toString()}`,
                ErrorCode.TC_JOIN_TYPE_INVALID_MEMBER
            );
            return;
        }

        // Check rule 2: Cannot mix interfaces with structs
        if (hasInterface && hasStruct) {
            this.addDiagnostic(node, 'error',
                `Join type mixing error: Cannot combine interfaces with structs in the same join type. All members must be either interfaces or structs.`,
                ErrorCode.TC_JOIN_TYPE_MIXING_KINDS
            );
            return;
        }

        // Check rule 3: Struct fields must have compatible types
        // Allow duplicate fields with the same type (inheritance), but error on conflicting types
        if (hasStruct) {
            const structs = allTypes.filter(isStructType);
            const fieldTypeMap = new Map<string, { type: TypeDescription; sources: string[] }>();

            for (const struct of structs) {
                const structName = struct.toString();
                for (const field of struct.fields) {
                    const existing = fieldTypeMap.get(field.name);
                    if (existing) {
                        // Check if types are compatible
                        if (existing.type.toString() !== field.type.toString()) {
                            this.addDiagnostic(node, 'error',
                                `Join struct field type conflict: Field '${field.name}' has conflicting types: '${existing.type.toString()}' in ${existing.sources.join(', ')} vs '${field.type.toString()}' in ${structName}`,
                                ErrorCode.TC_JOIN_STRUCT_FIELD_TYPE_CONFLICT
                            );
                        }
                        existing.sources.push(structName);
                    } else {
                        fieldTypeMap.set(field.name, {
                            type: field.type,
                            sources: [structName]
                        });
                    }
                }
            }
        }

        // Check rule 4: Interface methods must have compatible signatures
        // Allow duplicate methods with the same signature (inheritance), but error on conflicting signatures
        if (hasInterface) {
            const interfaces = allTypes.filter(isInterfaceType);
            this.validateJoinInterfaceMethodCompatibility(interfaces, node);
        }
    }

    /**
     * Validate that interface methods have compatible signatures in a join type.
     * Allow duplicate methods with the same signature (inheritance),
     * but report errors for conflicting signatures with the same name.
     */
    private validateJoinInterfaceMethodCompatibility(
        interfaces: TypeDescription[],
        node: ast.JoinType
    ): void {
        interface MethodSignature {
            name: string;
            parameterTypes: string[];
            returnType: string;
            sources: string[];
        }

        const methodMap = new Map<string, MethodSignature>();

        for (const iface of interfaces) {
            if (!isInterfaceType(iface)) continue;

            const ifaceName = iface.toString();

            for (const method of iface.methods) {
                for (const name of method.names) {
                    const paramTypes = method.parameters.map(p => p.type.toString());
                    const returnType = method.returnType.toString();
                    const signatureKey = `${name}(${paramTypes.join(',')})`;

                    const existing = methodMap.get(signatureKey);
                    if (existing) {
                        // Check if return types match
                        if (existing.returnType !== returnType) {
                            this.addDiagnostic(node, 'error',
                                `Join interface method conflict: Method '${name}(${paramTypes.join(', ')})' has conflicting return types: '${existing.returnType}' in ${existing.sources.join(', ')} vs '${returnType}' in ${ifaceName}`,
                                ErrorCode.TC_JOIN_INTERFACE_METHOD_SIGNATURE_CONFLICT
                            );
                        }
                        existing.sources.push(ifaceName);
                    } else {
                        methodMap.set(signatureKey, {
                            name,
                            parameterTypes: paramTypes,
                            returnType,
                            sources: [ifaceName]
                        });
                    }
                }
            }
        }
    }

    /**
     * Recursively collect all types from a join type for validation.
     * Resolves reference types to get the actual interface/struct definitions.
     */
    private collectJoinTypesForValidation(type: TypeDescription, result: TypeDescription[]): void {
        // Resolve reference types first
        let resolvedType = type;
        if (isReferenceType(type)) {
            const resolved = this.resolveReference(type);
            if (resolved) {
                resolvedType = resolved;
            }
        }

        if (isJoinType(resolvedType)) {
            // Recursively flatten nested joins
            for (const t of resolvedType.types) {
                this.collectJoinTypesForValidation(t, result);
            }
        } else {
            result.push(resolvedType);
        }
    }

    // --- Interface Validation ---

    /**
     * Validate an interface type definition.
     * Checks inheritance, method names, and default parameters.
     */
    private validateInterfaceType(node: ast.InterfaceType): void {
        this.validateInterfaceInheritance(node);
        this.validateInterfaceMethodNames(node);
        this.validateInterfaceMethodDefaults(node);
    }

    /**
     * Check interface inheritance for method conflicts and circular references.
     *
     * Validates:
     * 1. Interfaces can only extend other interfaces
     * 2. No circular inheritance (A extends B, B extends A)
     * 3. When an interface extends another interface, it cannot override methods with
     *    different return types (same parameters, different return type).
     */
    private validateInterfaceInheritance(node: ast.InterfaceType): void {
        if (!node.superTypes || node.superTypes.length === 0) {
            return; // No inheritance to check
        }

        // Get the type description for this interface
        const interfaceType = this.getType(node);
        if (!isInterfaceType(interfaceType)) {
            return;
        }

        // Check for circular inheritance before processing methods
        const visited = new Set<ast.InterfaceType>();
        const path: string[] = [];
        const circularRef = this.detectCircularInterfaceInheritance(node, visited, path);
        if (circularRef) {
            this.addDiagnostic(node, 'error',
                `Circular interface inheritance detected: ${circularRef}`,
                ErrorCode.TC_INTERFACE_CIRCULAR_INHERITANCE
            );
            return; // Don't process further if there's a circular reference
        }

        // Collect all methods from parent interfaces
        interface ParentMethod {
            name: string;
            parameterTypes: string[];
            returnType: string;
            parentInterface: string;
        }
        const parentMethods = new Map<string, ParentMethod>();

        for (const extendedRef of node.superTypes) {
            const parentType = this.getType(extendedRef);
            const resolvedParent = isReferenceType(parentType)
                ? this.resolveReference(parentType)
                : parentType;

            // Use asInterfaceType to handle both direct interfaces and join types that resolve to interfaces
            const parentInterface = this.typeUtils.asInterfaceType(resolvedParent);

            if (!parentInterface) {
                this.addDiagnostic(extendedRef, 'error',
                    `Interface can only extend other interfaces, but '${resolvedParent.toString()}' is not an interface`,
                    ErrorCode.TC_INTERFACE_INVALID_SUPERTYPE
                );
                continue;
            }

            const parentName = parentInterface.toString();

            for (const method of parentInterface.methods) {
                for (const name of method.names) {
                    const paramTypes = method.parameters.map(p => p.type.toString());
                    const signatureKey = `${name}(${paramTypes.join(',')})`;

                    parentMethods.set(signatureKey, {
                        name,
                        parameterTypes: paramTypes,
                        returnType: method.returnType.toString(),
                        parentInterface: parentName
                    });
                }
            }
        }

        // Check if any methods in this interface conflict with parent methods
        for (const method of interfaceType.methods) {
            for (const name of method.names) {
                const paramTypes = method.parameters.map(p => p.type.toString());
                const signatureKey = `${name}(${paramTypes.join(',')})`;
                const returnType = method.returnType.toString();

                const parentMethod = parentMethods.get(signatureKey);
                if (parentMethod && parentMethod.returnType !== returnType) {
                    this.addDiagnostic(node, 'error',
                        `Interface inheritance method conflict: Method '${name}(${paramTypes.join(', ')})' in interface cannot override parent method with different return type. Parent returns '${parentMethod.returnType}', but this interface returns '${returnType}'`,
                        ErrorCode.TC_INTERFACE_INHERITANCE_METHOD_CONFLICT
                    );
                }
            }
        }
    }

    /**
     * Detects circular inheritance in interfaces.
     * Returns the cycle path as a string if found, undefined otherwise.
     */
    private detectCircularInterfaceInheritance(
        node: ast.InterfaceType,
        visited: Set<ast.InterfaceType>,
        path: string[]
    ): string | undefined {
        // If we've already visited this node in the current path, we found a cycle
        if (visited.has(node)) {
            // Find where the cycle starts
            const nodeType = this.getType(node);
            const nodeName = isInterfaceType(nodeType) ? nodeType.toString() : 'unknown';
            const cycleStart = path.indexOf(nodeName);
            if (cycleStart >= 0) {
                const cycle = [...path.slice(cycleStart), nodeName];
                return cycle.join(' → ');
            }
            return path.join(' → ') + ' → ' + nodeName;
        }

        // Add current node to visited set and path
        visited.add(node);
        const nodeType = this.getType(node);
        const nodeName = isInterfaceType(nodeType) ? nodeType.toString() : 'unknown';
        path.push(nodeName);

        // Check all supertypes
        if (node.superTypes) {
            for (const superTypeRef of node.superTypes) {
                const superType = this.getType(superTypeRef);

                // Resolve reference to get the actual interface
                const resolvedSuper = isReferenceType(superType)
                    ? this.resolveReference(superType)
                    : superType;

                // Use asInterfaceType to handle join types
                const superInterface = this.typeUtils.asInterfaceType(resolvedSuper);

                if (superInterface && superInterface.node && ast.isInterfaceType(superInterface.node)) {
                    // Recursively check the supertype
                    const result = this.detectCircularInterfaceInheritance(
                        superInterface.node,
                        new Set(visited), // Create a copy to allow different branches
                        [...path] // Create a copy of the path
                    );
                    if (result) {
                        return result;
                    }
                }
            }
        }

        return undefined;
    }

    /**
     * Check that interface methods don't use reserved names like 'init'.
     */
    private validateInterfaceMethodNames(node: ast.InterfaceType): void {
        // Check each method in the interface
        for (const method of node.methods) {
            // Check all names for this method (methods can have multiple names for overloading)
            for (const name of method.names) {
                if (name === 'init') {
                    this.addDiagnostic(method, 'error',
                        `Interface method cannot be named 'init': The name 'init' is reserved for class initializers and cannot be used in interface methods`,
                        ErrorCode.TC_INTERFACE_METHOD_RESERVED_NAME
                    );
                }
            }
        }
    }

    /**
     * Interface methods cannot have default parameter values.
     * Defaults are implementation-specific — they belong on the implementing class or impl, not the interface contract.
     */
    private validateInterfaceMethodDefaults(node: ast.InterfaceType): void {
        for (const method of node.methods) {
            for (const param of method.header?.args ?? []) {
                if (param.defaultValue) {
                    this.addDiagnostic(param.defaultValue, 'error',
                        `Interface methods cannot have default parameter values. Default values are implementation-specific — move the default to the implementing class or impl.`,
                        ErrorCode.TC_INTERFACE_DEFAULT_PARAM
                    );
                }
            }
        }
    }

    // --- Class Validation ---

    /**
     * Check class implementation of interfaces.
     *
     * When a class declares it extends interfaces (e.g., `class Container<T>`),
     * validate that it properly implements all required methods.
     */
    private validateClassImplementation(node: ast.ClassType): void {
        if (!node.superTypes || node.superTypes.length === 0) {
            return; // No interfaces to implement
        }

        // Get the class type
        const classType = this.getType(node);
        if (!isClassType(classType)) {
            return;
        }

        // Check each extended interface
        for (const superTypeRef of node.superTypes) {
            const interfaceType = this.getType(superTypeRef);
            const resolvedInterface = isReferenceType(interfaceType)
                ? this.resolveReference(interfaceType)
                : interfaceType;

            if (!isInterfaceType(resolvedInterface)) {
                continue;
            }

            // Use the existing compatibility check from type-utils
            const compatResult = this.typeUtils.isClassAssignableToInterface(classType, resolvedInterface);
            if (!compatResult.success) {
                const errorMsg = `Class must implement interface '${resolvedInterface.toString()}': ${compatResult.message}`;
                this.addDiagnostic(superTypeRef, 'error', errorMsg,
                    ErrorCode.TC_VARIABLE_INTERFACE_IMPLEMENTATION_ERROR
                );
            }
        }
    }

    // --- Implementation Type Validation ---

    /**
     * Validate that implementation type requirements are all interfaces.
     */
    private validateImplementationType(node: ast.ImplementationType): void {
        const supertypes = (node?.superTypes ?? []).map(e => this.typeUtils.resolveIfReference(this.getType(e)));
        for (const [i, v] of supertypes.entries()) {
            if (!isInterfaceType(v)) {
                this.addDiagnostic(supertypes[i].node!, 'error',
                    `Implementation requirement is not an interface`,
                    ErrorCode.TC_IMPL_REQUIREMENT_NOT_INTERFACE
                );
            }
        }
    }

    // --- Class Implementation Method Declaration Validation ---

    /**
     * Check class impl declaration.
     *
     * When a class uses an impl (e.g., `impl Default3DImpl<vec3>(pos, scale, rot)`),
     * validate:
     * 1. The referenced type is actually an implementation type
     * 2. The argument count matches the expected attributes
     * 3. Each argument type matches the expected attribute type
     * 4. All interface methods required by the impl are satisfied
     */
    private validateClassImplDeclaration(node: ast.ClassImplementationMethodDecl): void {
        // Get the impl type being referenced
        const implRefType = this.getType(node.type);

        // Resolve the reference to get the actual implementation type
        let resolvedImplType = isReferenceType(implRefType)
            ? this.resolveReference(implRefType)
            : implRefType;

        // Resolve again if still a reference (nested references)
        resolvedImplType = this.typeUtils.resolveIfReference(resolvedImplType);

        // Verify it's an implementation type
        if (!isImplementationType(resolvedImplType)) {
            this.addDiagnostic(node.type, 'error',
                `Expected implementation reference, instead got ${resolvedImplType.kind}`,
                ErrorCode.TC_IMPL_NOT_IMPL
            );
            return;
        }

        // Get the expected attributes from the impl type
        const expectedAttributes = resolvedImplType.attributes;

        // Get the provided arguments
        const providedArgs = node.args || [];

        // Check 1: Argument count must match
        if (providedArgs.length !== expectedAttributes.length) {
            this.addDiagnostic(node, 'error',
                `Implementation argument count mismatch: ` +
                `'${this.getImplDisplayName(node.type)}' expects ${expectedAttributes.length} argument(s), ` +
                `but got ${providedArgs.length}`,
                ErrorCode.TC_IMPL_ARG_COUNT_MISMATCH
            );
            return;
        }

        // Check 2: Each argument type must match the expected attribute type
        // Build generic substitutions from the impl reference if it has generic args
        let substitutions: Map<string, TypeDescription> | undefined;
        if (isReferenceType(implRefType) && implRefType.genericArgs.length > 0 && implRefType.declaration.genericParameters) {
            substitutions = new Map<string, TypeDescription>();
            implRefType.declaration.genericParameters.forEach((param, i) => {
                if (i < implRefType.genericArgs.length) {
                    substitutions!.set(param.name, implRefType.genericArgs[i]);
                }
            });
        }

        for (let i = 0; i < providedArgs.length; i++) {
            const argRef = providedArgs[i].ref;
            if (!argRef || !ast.isClassAttributeDecl(argRef)) {
                continue; // Unresolved reference, will be caught elsewhere
            }

            // Get the actual type of the provided argument (the class attribute)
            const argType = this.getType(argRef.type);

            // Get the expected type from the impl attribute
            let expectedType = expectedAttributes[i].type;

            // Apply generic substitutions if we have them
            if (substitutions && substitutions.size > 0) {
                expectedType = this.typeUtils.substituteGenerics(expectedType, substitutions);
            }

            // Check type compatibility
            const actual = this.typeUtils.resolveIfReference(argType);
            const expected = this.typeUtils.resolveIfReference(expectedType);
            const compatResult = this.typeUtils.isAssignable(actual, expected);
            if (!compatResult.success) {
                const errorMsg = `Implementation argument ${i + 1} ('${argRef.name}') type mismatch: ` +
                    `Expected '${expectedType.toString()}', but got '${argType.toString()}'`;
                this.addDiagnostic(node, 'error', errorMsg,
                    ErrorCode.TC_IMPL_ARG_TYPE_MISMATCH
                );
            }
        }

        // Check 3: Validate that impl interface requirements are satisfied by the class
        this.validateImplInterfaceRequirementsSatisfied(node, resolvedImplType, implRefType);
    }

    /**
     * Check that all interface methods required by an impl are satisfied by the class.
     */
    private validateImplInterfaceRequirementsSatisfied(
        implDeclNode: ast.ClassImplementationMethodDecl,
        resolvedImplType: TypeDescription,
        implRefType: TypeDescription
    ): void {
        if (!isImplementationType(resolvedImplType)) {
            return;
        }

        // Build generic substitutions from the impl reference if it has generic args
        let substitutions: Map<string, TypeDescription> | undefined;
        if (isReferenceType(implRefType) && implRefType.genericArgs.length > 0 && implRefType.declaration.genericParameters) {
            substitutions = new Map<string, TypeDescription>();
            implRefType.declaration.genericParameters.forEach((param, i) => {
                if (i < implRefType.genericArgs.length) {
                    substitutions!.set(param.name, implRefType.genericArgs[i]);
                }
            });
        }

        // Get the containing class
        const classNode = AstUtils.getContainerOfType(implDeclNode, ast.isClassType);
        if (!classNode) {
            return;
        }

        const classType = this.getType(classNode);
        if (!isClassType(classType)) {
            return;
        }

        // Check each interface that this impl extends
        for (const targetType of resolvedImplType.targetTypes) {
            // Resolve reference types to get the actual interface
            let resolvedTargetType = isReferenceType(targetType)
                ? this.resolveReference(targetType)
                : targetType;

            const interfaceType = this.typeUtils.asInterfaceType(resolvedTargetType);
            if (!interfaceType) {
                continue; // Not an interface, skip
            }

            // Check each interface method
            for (const interfaceMethod of interfaceType.methods) {
                // Apply generic substitutions to the interface method if we have them
                let expectedMethod = interfaceMethod;
                if (substitutions && substitutions.size > 0) {
                    expectedMethod = {
                        ...interfaceMethod,
                        parameters: interfaceMethod.parameters.map(p => ({
                            name: p.name,
                            type: this.typeUtils.substituteGenerics(p.type, substitutions),
                            isMut: p.isMut,
                            hasDefault: p.hasDefault
                        })),
                        returnType: this.typeUtils.substituteGenerics(interfaceMethod.returnType, substitutions)
                    };
                }

                // Check if this interface method is implemented by the impl itself
                const implementedByImpl = resolvedImplType.methods.some(implMethod =>
                    this.implMethodMatchesInterfaceMethod(implMethod, expectedMethod)
                );

                if (implementedByImpl) {
                    continue; // Impl provides this method, no need for class to provide it
                }

                // Check if the class provides this method (directly or via other impls)
                // Collect all class methods + methods from all impls
                const allClassMethods = [...classType.methods];

                // Add methods from all other impls
                for (const otherImplRef of classType.implementations) {
                    const otherImpl = this.resolveReference(otherImplRef);
                    if (isImplementationType(otherImpl)) {
                        // Build substitutions for this other impl
                        let otherSubstitutions: Map<string, TypeDescription> | undefined;
                        if (isReferenceType(otherImplRef) && otherImplRef.genericArgs.length > 0 && otherImplRef.declaration.genericParameters) {
                            otherSubstitutions = new Map<string, TypeDescription>();
                            otherImplRef.declaration.genericParameters.forEach((param, i) => {
                                if (i < otherImplRef.genericArgs.length) {
                                    otherSubstitutions!.set(param.name, otherImplRef.genericArgs[i]);
                                }
                            });
                        }

                        // Add substituted methods from other impl
                        for (const otherImplMethod of otherImpl.methods) {
                            if (otherSubstitutions && otherSubstitutions.size > 0) {
                                allClassMethods.push({
                                    ...otherImplMethod,
                                    parameters: otherImplMethod.parameters.map(p => ({
                                        name: p.name,
                                        type: this.typeUtils.substituteGenerics(p.type, otherSubstitutions!),
                                        isMut: p.isMut,
                                        hasDefault: p.hasDefault
                                    })),
                                    returnType: this.typeUtils.substituteGenerics(otherImplMethod.returnType, otherSubstitutions!)
                                });
                            } else {
                                allClassMethods.push(otherImplMethod);
                            }
                        }
                    }
                }

                // Check if any method in the class (including from other impls) provides this interface method
                const providedByClass = allClassMethods.some(classMethod =>
                    this.implMethodMatchesInterfaceMethod(classMethod, expectedMethod)
                );

                if (!providedByClass) {
                    // Missing required interface method
                    const methodSignature = `${expectedMethod.names[0]}(${expectedMethod.parameters.map(p => `${p.name}: ${p.type.toString()}`).join(', ')}) -> ${expectedMethod.returnType.toString()}`;
                    this.addDiagnostic(implDeclNode, 'error',
                        `Class must implement interface method '${expectedMethod.names[0]}': ` +
                        `Implementation '${this.getImplDisplayName(implDeclNode.type)}' extends interface with method '${methodSignature}', ` +
                        `but neither the impl nor the class provides this method.`,
                        ErrorCode.TC_IMPL_INTERFACE_METHOD_NOT_SATISFIED
                    );
                }
            }
        }
    }

    /**
     * Check if a method matches an interface method's signature.
     */
    private implMethodMatchesInterfaceMethod(
        method: MethodType,
        interfaceMethod: MethodType
    ): boolean {
        // Check if method has any name that matches the interface method
        const hasCommonName = method.names.some((name: string) =>
            interfaceMethod.names.includes(name)
        );

        if (!hasCommonName) {
            return false;
        }

        // CRITICAL: Interface methods are always public
        // Local (private) methods cannot implement interface methods
        if (method.isLocal) {
            return false;
        }

        // Check signature compatibility
        const compatResult = this.typeUtils.isMethodImplementationCompatible(method, interfaceMethod);
        return compatResult.success;
    }

    /**
     * Helper method to get a display name for an impl type reference.
     */
    private getImplDisplayName(typeRef: ast.ReferenceType): string {
        if (typeRef.field?.ref && ast.isTypeDeclaration(typeRef.field.ref)) {
            const decl = typeRef.field.ref;
            if (typeRef.genericArgs && typeRef.genericArgs.length > 0) {
                return `${decl.name}<${typeRef.genericArgs.map(g => g.$cstNode?.text || '?').join(', ')}>`;
            }
            return decl.name;
        }
        return typeRef.$cstNode?.text || 'unknown';
    }

    // --- MemberAccess Validation ---

    /**
     * Validate member access nodes for:
     * 1. Optional chaining correctness (nullable access, unnecessary optional chaining)
     * 2. Local member access restrictions
     * 3. Variant constructor usage (must be called)
     */
    private validateMemberAccessNode(node: ast.MemberAccess): void {
        this.validateMemberAccessOptionalChaining(node);
        this.validateLocalMemberAccess(node);
        this.validateVariantConstructorUsage(node);
    }

    /**
     * Check member access for proper usage of optional chaining.
     *
     * Rules:
     * 1. Accessing a nullable type with `.` -> error (should use `?.`)
     *    UNLESS there's `?.` somewhere in the parent chain (nullability propagation)
     * 2. Accessing a non-nullable type with `?.` -> warning
     */
    private validateMemberAccessOptionalChaining(node: ast.MemberAccess): void {
        const baseType = this.getType(node.expr);
        const isBaseNullable = isNullableType(baseType);
        const usesOptionalChaining = node.isNullable;

        // Check if optional chaining is used anywhere in the parent chain
        const hasOptionalChainingInChain = this.hasOptionalChaining(node.expr);

        // Rule 1: Accessing nullable type with regular `.`
        // EXCEPTION: If there's `?.` in the parent chain, nullability propagates so `.` is OK
        if (isBaseNullable && !usesOptionalChaining && !hasOptionalChainingInChain) {
            this.addDiagnostic(node, 'error',
                `Cannot access member of nullable type '${baseType.toString()}' using '.'. Use optional chaining '?.' instead, or unwrap with '!' if you're certain the value is not null.`,
                ErrorCode.TC_NULLABLE_ACCESSED_WITHOUT_OPTIONAL_CHAINING, 'element'
            );
            return;
        }

        // Rule 2: Accessing non-nullable type with `?.`
        if (!isBaseNullable && usesOptionalChaining) {
            this.addDiagnostic(node, 'warning',
                `Unnecessary optional chaining: Type '${baseType.toString()}' is not nullable. Use regular member access '.' instead.`,
                ErrorCode.TC_NON_NULLABLE_ACCESSED_WITH_OPTIONAL_CHAINING, 'element'
            );
        }
    }

    /**
     * Check that local attributes and methods are only accessed within their class scope.
     */
    private validateLocalMemberAccess(node: ast.MemberAccess): void {
        const element = node.element?.ref;
        if (!element) {
            return; // Unresolved reference, will be caught elsewhere
        }

        // Check if accessing a class attribute
        if (ast.isClassAttributeDecl(element)) {
            if (!element.isLocal) {
                return; // Not a local attribute, no validation needed
            }

            // Get the containing class of the attribute
            const attributeClass = AstUtils.getContainerOfType(element, ast.isClassType);
            if (!attributeClass) {
                return; // Shouldn't happen, but be safe
            }

            // Check if we're accessing from within the same class
            if (this.isMemberAccessWithinClass(node, attributeClass)) {
                return; // Access from within the same class is allowed
            }

            // Error: Accessing local attribute from outside the class
            this.addDiagnostic(node, 'error',
                `Cannot access local attribute '${element.name}' outside of its class. ` +
                `Local attributes are private to the class and can only be accessed within the class's methods.`,
                ErrorCode.TC_LOCAL_ATTRIBUTE_ACCESS_OUTSIDE_CLASS, 'element'
            );
            return;
        }

        // Check if accessing a class method
        if (ast.isClassMethod(element)) {
            if (!element.isLocal) {
                return; // Not a local method, no validation needed
            }

            // Get the containing class of the method
            const methodClass = AstUtils.getContainerOfType(element, ast.isClassType);
            if (!methodClass) {
                return; // Shouldn't happen, but be safe
            }

            // Check if we're accessing from within the same class
            if (this.isMemberAccessWithinClass(node, methodClass)) {
                return; // Access from within the same class is allowed
            }

            // Error: Accessing local method from outside the class
            const methodNames = element.method?.names || ['method'];
            this.addDiagnostic(node, 'error',
                `Cannot access local method '${methodNames[0]}' outside of its class. ` +
                `Local methods are private to the class and can only be called within the class's methods.`,
                ErrorCode.TC_LOCAL_METHOD_ACCESS_OUTSIDE_CLASS, 'element'
            );
        }
    }

    /**
     * Helper method to check if a member access is within the same class.
     */
    private isMemberAccessWithinClass(accessNode: ast.MemberAccess, targetClass: ast.ClassType): boolean {
        // Walk up the AST to find the containing class (if any)
        let current: AstNode | undefined = accessNode.$container;

        while (current) {
            // Check if we're in a class method
            if (ast.isClassMethod(current)) {
                // Get the containing class of this method
                const containingClass = AstUtils.getContainerOfType(current, ast.isClassType);

                // Check if it's the same class (by reference equality)
                if (containingClass === targetClass) {
                    return true;
                }

                // Not the same class, return false
                return false;
            }

            current = current.$container;
        }

        // Not within any class method
        return false;
    }

    /**
     * Check that variant constructor expressions are only used in function call contexts.
     */
    private validateVariantConstructorUsage(node: ast.MemberAccess): void {
        // Get the type of this reference
        const targetRef = node.element.ref;
        if (ast.isVariantConstructor(targetRef) && !ast.isFunctionCall(node.$container)) {
            if (!(ast.isFunctionCall(node.$container) && (node.$containerProperty === "expr"))) {
                this.addDiagnostic(node, 'error',
                    "Variant constructors must be called",
                    ErrorCode.TC_VARIANT_CONSTRUCTOR_NOT_CALLED
                );
            }
        }
    }

    // ========================================================================
    // Phase 10: Migrated validation methods from type-system-diagnostics
    // ========================================================================

    /**
     * Validate index set operations (type compatibility).
     * Migrated from TypeSystemDiagnostics.checkIndexSet.
     */
    private validateIndexSet(node: ast.IndexSet, baseType: TypeDescription): void {
        const valueType = this.getType(node.value);

        // For arrays: check element type compatibility
        if (isArrayType(baseType)) {
            const arrayType = baseType;
            const compatResult = this.typeUtils.isAssignable(
                this.typeUtils.resolveIfReference(valueType),
                this.typeUtils.resolveIfReference(arrayType.elementType)
            );
            if (!compatResult.success) {
                const errorMsg = compatResult.message
                    ? `Array index assignment type mismatch: ${compatResult.message}`
                    : `Array index assignment type mismatch: Cannot assign '${valueType.toString()}' to array of '${arrayType.elementType.toString()}'`;
                this.addDiagnostic(node.value, 'error', errorMsg, ErrorCode.TC_INDEX_SET_TYPE_MISMATCH);
            }
            return;
        }

        // For classes with []= operator: validate against the operator's parameter type
        if (isClassType(baseType)) {
            const indexSetMethod = baseType.methods.find(m => m.names.includes('[]='));
            if (indexSetMethod) {
                // The value parameter is typically the last parameter
                const valueParam = indexSetMethod.parameters[indexSetMethod.parameters.length - 1];
                if (valueParam) {
                    const compatResult = this.typeUtils.isAssignable(
                        this.typeUtils.resolveIfReference(valueType),
                        this.typeUtils.resolveIfReference(valueParam.type)
                    );
                    if (!compatResult.success) {
                        const errorMsg = compatResult.message
                            ? `Index operator assignment type mismatch: ${compatResult.message}`
                            : `Index operator assignment type mismatch: Cannot assign '${valueType.toString()}' to '${valueParam.type.toString()}'`;
                        this.addDiagnostic(node.value, 'error', errorMsg, ErrorCode.TC_INDEX_SET_TYPE_MISMATCH);
                    }
                }
            }
        }
    }

    /**
     * Validate reverse index set operations (type compatibility).
     * Migrated from TypeSystemDiagnostics.checkReverseIndexSet.
     */
    private validateReverseIndexSet(node: ast.ReverseIndexSet, baseType: TypeDescription): void {
        const valueType = this.getType(node.value);

        // For arrays: check element type compatibility
        if (isArrayType(baseType)) {
            const arrayType = baseType;
            const compatResult = this.typeUtils.isAssignable(
                this.typeUtils.resolveIfReference(valueType),
                this.typeUtils.resolveIfReference(arrayType.elementType)
            );
            if (!compatResult.success) {
                const errorMsg = compatResult.message
                    ? `Reverse array index assignment type mismatch: ${compatResult.message}`
                    : `Reverse array index assignment type mismatch: Cannot assign '${valueType.toString()}' to array of '${arrayType.elementType.toString()}'`;
                this.addDiagnostic(node.value, 'error', errorMsg, ErrorCode.TC_REVERSE_INDEX_SET_TYPE_MISMATCH);
            }
            return;
        }

        // For classes with [-]= operator: validate against the operator's parameter type
        if (isClassType(baseType)) {
            const reverseIndexSetMethod = baseType.methods.find(m => m.names.includes('[-]='));
            if (reverseIndexSetMethod) {
                // The value parameter is typically the last parameter
                const valueParam = reverseIndexSetMethod.parameters[reverseIndexSetMethod.parameters.length - 1];
                if (valueParam) {
                    const compatResult = this.typeUtils.isAssignable(
                        this.typeUtils.resolveIfReference(valueType),
                        this.typeUtils.resolveIfReference(valueParam.type)
                    );
                    if (!compatResult.success) {
                        const errorMsg = compatResult.message
                            ? `Reverse index operator assignment type mismatch: ${compatResult.message}`
                            : `Reverse index operator assignment type mismatch: Cannot assign '${valueType.toString()}' to '${valueParam.type.toString()}'`;
                        this.addDiagnostic(node.value, 'error', errorMsg, ErrorCode.TC_REVERSE_INDEX_SET_TYPE_MISMATCH);
                    }
                }
            }
        }
    }

    /**
     * Validate that basic types (arrays, strings) only use a single index.
     * Classes with overloaded [] operators may accept multiple indices.
     * Migrated from TypeSystemDiagnostics.checkIndexAccessMultipleIndices.
     */
    private validateIndexAccessMultipleIndices(node: ast.IndexAccess | ast.IndexSet): void {
        // Get the base type being indexed
        let baseType = this.getType(node.expr);
        baseType = this.typeUtils.resolveIfReference(baseType);

        // Get the number of indices provided
        const indexCount = node.indexes.length;

        // If only one index, no validation needed
        if (indexCount <= 1) {
            return;
        }

        // Check if the base type is an array
        if (isArrayType(baseType)) {
            this.addDiagnostic(node, 'error',
                `Array index access error: Arrays only support single index access, but ${indexCount} indices were provided. ` +
                `Use separate accesses like arr[${node.indexes[0].$cstNode?.text}][${node.indexes[1].$cstNode?.text}] for multidimensional arrays.`,
                ErrorCode.TC_INDEX_ACCESS_MULTIPLE_INDICES_ON_BASIC
            );
            return;
        }

        // Check if the base type is string
        if (baseType.kind === TypeKind.String) {
            this.addDiagnostic(node, 'error',
                `String index access error: Strings only support single index access, but ${indexCount} indices were provided.`,
                ErrorCode.TC_INDEX_ACCESS_MULTIPLE_INDICES_ON_BASIC
            );
            return;
        }

        // For classes with [] operator overload, validate against the operator's parameter count
        if (isClassType(baseType)) {
            // Determine which operator to check based on whether this is IndexSet or IndexAccess
            const operatorName = ast.isIndexSet(node) ? '[]=' : '[]';
            const indexMethod = baseType.methods.find(m => m.names.includes(operatorName));

            if (indexMethod) {
                // For []= operator, the last parameter is the value, so we need to subtract 1
                const expectedIndexCount = ast.isIndexSet(node)
                    ? indexMethod.parameters.length - 1
                    : indexMethod.parameters.length;

                if (indexCount !== expectedIndexCount) {
                    this.addDiagnostic(node, 'error',
                        `Index operator '${operatorName}' error: Class '${baseType.toString()}' expects ${expectedIndexCount} index parameter(s), but got ${indexCount}.`,
                        ErrorCode.TC_INDEX_ACCESS_MULTIPLE_INDICES_ON_BASIC
                    );
                }
            }
        }
    }

    /**
     * Validate denull expression on non-nullable types.
     * Migrated from TypeSystemDiagnostics.checkDenullExpression.
     */
    private validateDenullExpression(node: ast.DenullExpression, exprType: TypeDescription): void {
        // If the expression is not nullable, the denull operator is unnecessary
        if (!isNullableType(exprType)) {
            this.addDiagnostic(node, 'warning',
                `Unnecessary denull operator: Type '${exprType.toString()}' is not nullable. The '!' operator has no effect here.`,
                ErrorCode.TC_DENULL_ON_NON_NULLABLE,
                'expr'
            );
        }
    }

    /**
     * Validate spread field type compatibility in struct construction.
     * Migrated from TypeSystemDiagnostics.checkStructSpreadFieldTypes.
     */
    private validateStructSpreadFieldTypes(node: ast.NamedStructConstructionExpression): void {
        // Collect all fields from spread expressions
        const spreadFields = new Map<string, TypeDescription>();

        for (const field of node.fields) {
            if (ast.isStructSpreadExpression(field)) {
                // Get the type of the spread expression
                const spreadType = this.getType(field.expression);

                // Resolve reference types
                let resolvedType = this.typeUtils.resolveIfReference(spreadType);

                // If it's a struct type, collect its fields
                if (isStructType(resolvedType)) {
                    for (const structField of resolvedType.fields) {
                        spreadFields.set(structField.name, structField.type);
                    }
                }
            }
        }

        // Now check all regular fields against spread fields
        for (const field of node.fields) {
            if (ast.isStructFieldKeyValuePair(field)) {
                const fieldName = field.name;
                const spreadFieldType = spreadFields.get(fieldName);

                // If this field overrides a spread field, check type compatibility
                if (spreadFieldType) {
                    const overrideType = this.getType(field.expr);

                    const compatResult = this.typeUtils.isAssignable(
                        this.typeUtils.resolveIfReference(overrideType),
                        this.typeUtils.resolveIfReference(spreadFieldType)
                    );
                    if (!compatResult.success) {
                        const errorMsg = compatResult.message
                            ? `Struct spread field type mismatch: Field '${fieldName}' override - ${compatResult.message}`
                            : `Struct spread field type mismatch: Field '${fieldName}' override has type '${overrideType.toString()}', but spread expects '${spreadFieldType.toString()}'`;
                        this.addDiagnostic(field.expr, 'error', errorMsg, ErrorCode.TC_STRUCT_SPREAD_FIELD_TYPE_MISMATCH);
                    }
                }
            }
        }
    }

    // ArraySpreadExpression validation is handled inline in inferArrayConstruction
    // (ArraySpreadExpression is not a top-level Expression type in the grammar)

    /**
     * Helper method to get a user-friendly name for a type kind.
     * Migrated from TypeSystemDiagnostics.getTypeKindName.
     */
    private getTypeKindName(type: TypeDescription): string {
        if (isInterfaceType(type)) return 'interface';
        if (isStructType(type)) return 'struct';
        if (isEnumType(type)) return 'enum';
        if (isVariantType(type)) return 'variant';
        if (isFunctionType(type)) return 'function';
        if (isCoroutineType(type)) return 'coroutine';
        if (isArrayType(type)) return 'array type';
        if (isNullableType(type)) return 'nullable type';
        if (isUnionType(type)) return 'union type';
        if (isJoinType(type)) return 'join type';
        if (isTupleType(type)) return 'tuple type';
        if (isNumericType(type)) return 'primitive type';
        if (type.kind === TypeKind.Bool) return 'primitive type';
        if (type.kind === TypeKind.String) return 'primitive type';
        if (type.kind === TypeKind.Void) return 'primitive type';
        return 'type';
    }

    /**
     * Validate new expression for proper class instantiation.
     * Migrated from TypeSystemDiagnostics.checkNewExpression.
     *
     * IMPORTANT: This is called from within inferNewExpression, so we MUST NOT call
     * this.getType(node) on the NewExpression itself (would cause infinite recursion).
     * Instead, the inferred type is passed in by the caller when available.
     */
    private validateNewExpression(node: ast.NewExpression, inferredResultType?: TypeDescription): void {
        if (!node.instanceType) {
            return;
        }

        // Get the type that's being instantiated
        const instanceType = this.getType(node.instanceType);

        // Resolve reference types to get the actual type
        let resolvedType = this.typeUtils.resolveIfReference(instanceType);

        // Check if it's a class type (the only valid type for `new`)
        if (!isClassType(resolvedType) && !isMetaClassType(resolvedType)) {
            const typeKindName = this.getTypeKindName(resolvedType);
            this.addDiagnostic(node.instanceType, 'error',
                `Invalid use of 'new': Can only instantiate classes, but got ${typeKindName} '${resolvedType.toString()}'. Use appropriate construction syntax for this type.`,
                ErrorCode.TC_NEW_EXPRESSION_REQUIRES_CLASS
            );
            return;
        }

        // Check if the reference type requires generic arguments
        if (ast.isReferenceType(node.instanceType)) {
            const ref = node.instanceType.field?.ref;
            if (ref && ast.isTypeDeclaration(ref)) {
                const expectedGenericCount = ref.genericParameters?.length ?? 0;
                const providedGenericArgs = node.instanceType.genericArgs ?? [];
                const providedGenericCount = providedGenericArgs.length;

                if (expectedGenericCount > 0 && providedGenericCount === 0) {
                    // Use the inferred result type that was passed in by the caller
                    // (cannot call this.getType(node) here — that would recurse)
                    if (inferredResultType) {
                        if (isErrorType(inferredResultType)) {
                            // Inference produced an error (e.g., constraint violation)
                            this.addDiagnostic(node.instanceType, 'error',
                                inferredResultType.toString(),
                                ErrorCode.TC_NEW_EXPRESSION_REQUIRES_GENERIC_ARGS
                            );
                            return;
                        }

                        if (isReferenceType(inferredResultType) && inferredResultType.genericArgs.length > 0) {
                            // Inference succeeded -- resolve with inferred generics
                            resolvedType = this.typeUtils.resolveIfReference(inferredResultType);

                            // Validate operator constraints with the inferred substitutions
                            if (ref.operatorConstraints?.length) {
                                const genericParamNames = ref.genericParameters?.map(p => p.name) ?? [];
                                const substitutions = new Map<string, TypeDescription>();
                                genericParamNames.forEach((name, i) => {
                                    if (i < inferredResultType.genericArgs.length) {
                                        substitutions.set(name, inferredResultType.genericArgs[i]);
                                    }
                                });
                                this.validateOperatorConstraints(
                                    ref.operatorConstraints, substitutions, node
                                );
                            }
                        } else {
                            // Inference couldn't determine types -- report original error
                            this.addDiagnostic(node.instanceType, 'error',
                                `Generic class '${ref.name}' requires ${expectedGenericCount} generic argument(s) in 'new' expression. Example: new ${ref.name}<T>(...)`,
                                ErrorCode.TC_NEW_EXPRESSION_REQUIRES_GENERIC_ARGS
                            );
                            return;
                        }
                    } else {
                        // No inferred type available; report error
                        this.addDiagnostic(node.instanceType, 'error',
                            `Generic class '${ref.name}' requires ${expectedGenericCount} generic argument(s) in 'new' expression. Example: new ${ref.name}<T>(...)`,
                            ErrorCode.TC_NEW_EXPRESSION_REQUIRES_GENERIC_ARGS
                        );
                        return;
                    }
                }
            }
        }

        // Extract the actual class type (handle MetaClassType wrapper)
        const classType = isMetaClassType(resolvedType) ? resolvedType.baseClass : resolvedType;

        if (!isClassType(classType)) {
            return; // Shouldn't happen, but be safe
        }

        // Find all init methods in the class
        const initMethods = classType.methods.filter(m => m.names.includes('init'));

        // Get argument types and count
        const args = node.args || [];
        const argCount = args.length;

        // Filter init methods by argument count (accounts for default parameters)
        const matchingArityMethods = initMethods.filter(m => {
            const minArity = getMinArity(m.parameters);
            return argCount >= minArity && argCount <= m.parameters.length;
        });

        // If no init methods match the argument count, report error
        if (initMethods.length > 0 && matchingArityMethods.length === 0) {
            const availableSignatures = initMethods.map(m =>
                `init(${m.parameters.map(p => p.type.toString()).join(', ')})`
            ).join(' or ');
            this.addDiagnostic(node, 'error',
                `No matching 'init' method found: Expected ${availableSignatures}, but got ${argCount} argument(s)`,
                ErrorCode.TC_FUNCTION_CALL_ARG_COUNT_MISMATCH
            );
            return;
        }

        // If we have matching methods, validate argument types
        if (matchingArityMethods.length > 0) {
            // Get actual argument types
            const argumentTypes = args.map(arg => this.getType(arg));

            // Try to find a compatible init method
            let foundMatch = false;
            for (const initMethod of matchingArityMethods) {
                let allArgsMatch = true;

                // IMPORTANT: The resolved class type ALREADY has generic substitutions applied!
                const paramTypes = initMethod.parameters.map(p => p.type);

                // Check if all arguments are compatible
                for (let i = 0; i < argumentTypes.length; i++) {
                    const compatResult = this.typeUtils.isAssignable(
                        this.typeUtils.resolveIfReference(argumentTypes[i]),
                        this.typeUtils.resolveIfReference(paramTypes[i])
                    );
                    if (!compatResult.success) {
                        allArgsMatch = false;
                        break;
                    }
                }

                if (allArgsMatch) {
                    foundMatch = true;
                    break;
                }
            }

            // If no compatible init method found, report error with details
            if (!foundMatch) {
                const availableSignatures = matchingArityMethods.map(m =>
                    `init(${m.parameters.map(p => p.type.toString()).join(', ')})`
                ).join(' or ');
                const providedTypes = argumentTypes.map(t => t.toString()).join(', ');
                this.addDiagnostic(node, 'error',
                    `No matching 'init' method found for argument types (${providedTypes}). Available: ${availableSignatures}`,
                    ErrorCode.TC_FUNCTION_CALL_ARG_TYPE_MISMATCH
                );
            }
        }

        // If we have no init method, it is fine as long we have 0 args
        if ((initMethods.length == 0) && (argCount > 0)) {
            this.addDiagnostic(node, 'error',
                `Class has no \`init\` method, therefor \`new\` cannot accept any arguments`,
                ErrorCode.TC_NEW_EXPRESSION_BAD_ARGS
            );
        }
    }

    /**
     * Validate type cast expressions.
     * Migrated from TypeSystemDiagnostics.checkTypeCastExpression.
     */
    private validateTypeCastExpression(node: ast.TypeCastExpression): void {
        // Get source and target types
        const sourceType = this.getType(node.left);
        const targetType = this.getType(node.destType);

        // Resolve reference types
        const resolvedSource = this.typeUtils.resolveIfReference(sourceType);
        const resolvedTarget = this.typeUtils.resolveIfReference(targetType);

        // Skip validation if either is an error type
        if (isErrorType(resolvedSource) || isErrorType(resolvedTarget)) {
            return;
        }

        const castType = node.castType;

        // Check if the cast is valid
        const castResult = this.typeUtils.canCastTypes(resolvedSource, resolvedTarget);

        // REGULAR CAST (as): Must be trivially safe
        if (castType === 'as') {
            if (!castResult.success) {
                const errorMsg = castResult.message
                    ? `Invalid cast from '${sourceType.toString()}' to '${targetType.toString()}': ${castResult.message}. Use 'as?' for unsafe casts or 'as!' to force.`
                    : `Invalid cast from '${sourceType.toString()}' to '${targetType.toString()}'. Use 'as?' for unsafe casts or 'as!' to force.`;
                this.addDiagnostic(node.destType, 'error', errorMsg, ErrorCode.TC_CAST_INVALID_REGULAR_CAST);
            }
            return;
        }

        // Warn if dangerous (types are completely unrelated)
        const reverseResult = this.typeUtils.canCastTypes(resolvedTarget, resolvedSource);
        const hasRelationship = castResult.success || reverseResult.success;

        // SAFE CAST (as?): Allowed if cast is possible, warns if guaranteed to succeed or fail
        if (castType === 'as?') {
            // Check if cast is guaranteed to succeed (unnecessary safe cast)
            const assignableResult = this.typeUtils.isAssignable(resolvedSource, resolvedTarget);
            if (assignableResult.success) {
                this.addDiagnostic(node.destType, 'warning',
                    `Unnecessary safe cast from '${sourceType.toString()}' to '${targetType.toString()}': Cast is guaranteed to succeed. Use regular cast 'as' instead.`,
                    WarningCode.TC_CAST_UNNECESSARY_SAFE_CAST
                );
                return;
            }

            // Check special cases for safe cast that are guaranteed to fail
            const targetIsClass = isClassType(resolvedTarget);
            const sourceInterface = this.typeUtils.asInterfaceType(resolvedSource);

            if (sourceInterface && targetIsClass) {
                // Check if target class implements source interface
                const implementsResult = this.typeUtils.isClassAssignableToInterface(resolvedTarget, sourceInterface);
                if (!implementsResult.success) {
                    this.addDiagnostic(node.destType, 'warning',
                        `Safe cast guaranteed to fail: Class '${targetType.toString()}' does not implement interface '${sourceType.toString()}'. This will always return null.`,
                        WarningCode.TC_CAST_SAFE_CAST_ALWAYS_NULL
                    );
                }
            }

            if (!hasRelationship) {
                // Additional checks for primitive types - these are often intentional
                const bothPrimitive = (this.isIntegerType(resolvedSource) || this.isFloatType(resolvedSource)) &&
                                     (this.isIntegerType(resolvedTarget) || this.isFloatType(resolvedTarget));

                if (!bothPrimitive) {
                    this.addDiagnostic(node.destType, 'warning',
                        `Incompatible forced cast from '${sourceType.toString()}' to '${targetType.toString()}': Types are completely unrelated. This cast may cause undefined behavior at runtime.`,
                        WarningCode.TC_CAST_DANGEROUS_FORCE_CAST
                    );
                } else {
                    this.addDiagnostic(node.destType, 'error',
                        `Cannot perform safe cast with primitive types.`,
                        WarningCode.TC_CAST_SAFE_CAST_WITH_PRIMITIVE
                    );
                }
            }

            return;
        }

        // FORCE CAST (as!): Always succeeds, but may warn
        if (castType === 'as!') {
            // Warn if unnecessary (cast would succeed with regular 'as')
            if (castResult.success) {
                this.addDiagnostic(node.destType, 'warning',
                    `Unnecessary forced cast from '${sourceType.toString()}' to '${targetType.toString()}': Cast is already safe. Use regular cast 'as' instead.`,
                    WarningCode.TC_CAST_UNNECESSARY_FORCE_CAST
                );
                return;
            }

            if (!hasRelationship) {
                // Additional checks for primitive types - these are often intentional
                const bothPrimitive = (this.isIntegerType(resolvedSource) || this.isFloatType(resolvedSource)) &&
                                     (this.isIntegerType(resolvedTarget) || this.isFloatType(resolvedTarget));

                if (!bothPrimitive) {
                    this.addDiagnostic(node.destType, 'warning',
                        `Dangerous forced cast from '${sourceType.toString()}' to '${targetType.toString()}': Types are completely unrelated. This cast may cause undefined behavior at runtime.`,
                        WarningCode.TC_CAST_DANGEROUS_FORCE_CAST
                    );
                }
            }
            return;
        }
    }

    /**
     * Infer and validate instance check expression (is operator).
     * Migrated from TypeSystemDiagnostics.checkInstanceCheckExpression.
     */
    private inferInstanceCheckExpression(node: ast.InstanceCheckExpression): TypeDescription {
        // Get the type of the expression being checked (LHS of `is`)
        const sourceType = this.getType(node.left);

        // Get the type we're checking against (RHS of `is`)
        const destType = this.getType(node.destType);

        // Resolve reference types to get the actual types
        const resolvedSource = this.typeUtils.resolveIfReference(sourceType);
        const resolvedDest = this.typeUtils.resolveIfReference(destType);

        // Skip validation if either is an error type
        if (!isErrorType(resolvedSource) && !isErrorType(resolvedDest)) {
            // Check if it's one of the allowed types
            const isValidType = isClassType(resolvedDest) ||
                               isInterfaceType(resolvedDest) ||
                               isVariantType(resolvedDest) ||
                               isVariantConstructorType(resolvedDest) ||
                               resolvedDest.kind === TypeKind.Null;

            if (!isValidType) {
                const typeKindName = this.getTypeKindName(resolvedDest);
                this.addDiagnostic(node.destType, 'error',
                    `Invalid type for 'is' operator: The 'is' operator requires a Class, Interface, Variant, Variant Constructor, or null type, but got ${typeKindName} '${resolvedDest.toString()}'. ` +
                    `Runtime type checking is only supported for these reference types.`,
                    ErrorCode.TC_INSTANCE_CHECK_INVALID_RHS_TYPE
                );
            } else if (resolvedDest.kind !== TypeKind.Null) {
                // `x is null` is a direct null-check and is valid regardless of cast relationship.
                // For other types, validate relationship
                const sourceToDestResult = this.typeUtils.canCastTypes(resolvedSource, resolvedDest);
                const destToSourceResult = this.typeUtils.canCastTypes(resolvedDest, resolvedSource);
                const hasRelationship = sourceToDestResult.success || destToSourceResult.success;

                if (!hasRelationship) {
                    this.addDiagnostic(node.destType, 'error',
                        `Invalid 'is' check from '${sourceType.toString()}' to '${destType.toString()}': Types are completely unrelated. ` +
                        `The 'is' operator can only be used when there's a valid type relationship between the operands.`,
                        ErrorCode.TC_INSTANCE_CHECK_INVALID_RHS_TYPE
                    );
                }
            }
        }

        return this.typeFactory.createBoolType(node);
    }

    /**
     * Validate pattern nodes for errors cached during type inference.
     * Migrated from TypeSystemDiagnostics.checkPatternErrors.
     */
    private validatePatternErrors(node: AstNode): void {
        // Trigger type inference by finding and inferring a child variable pattern
        if (ast.isArrayPattern(node) || ast.isStructPattern(node) || ast.isTypePattern(node)) {
            this.triggerPatternInference(node);
        }

        const error = this.getPatternValidationError(node);
        if (error) {
            this.addDiagnostic(node, 'error', error.message, ErrorCode.TC_EXPRESSION_TYPE_ERROR);
        }
    }

    /**
     * Triggers type inference for a pattern tree by finding a variable pattern
     * child and calling getType on it.
     */
    private triggerPatternInference(pattern: AstNode): void {
        const varPattern = this.findVariablePattern(pattern);
        if (varPattern) {
            this.getType(varPattern);
        }
    }

    /**
     * Recursively finds the first variable pattern in a pattern tree.
     */
    private findVariablePattern(node: AstNode): ast.VariablePattern | undefined {
        if (ast.isVariablePattern(node)) {
            return node;
        }

        for (const child of AstUtils.streamContents(node)) {
            const found = this.findVariablePattern(child);
            if (found) {
                return found;
            }
        }

        return undefined;
    }

    /**
     * Validate object update fields.
     * Migrated from TypeSystemDiagnostics.checkObjectUpdateFields.
     */
    private validateObjectUpdateFields(node: ast.ObjectUpdate): void {
        const baseType = this.getType(node.expr);
        const resolvedType = this.typeUtils.resolveIfReference(baseType);

        // Validate base type is struct or class
        const isClass = isClassType(resolvedType);
        const structType = this.typeUtils.asStructType(resolvedType);

        if (!isClass && !structType) {
            this.addDiagnostic(node.expr, 'error',
                `Object Update Operator ".{}" requires either a struct or a class on the LHS, instead found ${baseType.toString()}`,
                ErrorCode.TC_INVALID_OBJ_UPDATE_LHS
            );
            return;
        }

        // Check each field in the update
        for (const kvPair of node.pairs) {
            // Get field info using the helper
            const fieldInfo = this.getFieldInfoForUpdate(resolvedType, kvPair.name);

            if (!fieldInfo) {
                const fieldKind = isClass ? 'Attribute' : 'Field';
                this.addDiagnostic(kvPair, 'error',
                    `${fieldKind} '${kvPair.name}' not found in ${baseType.toString()}`,
                    ErrorCode.TC_INVALID_OBJ_UPDATE_LHS
                );
                continue;
            }

            // Allow const assignment in constructor (init method)
            if (fieldInfo.isConst) {
                if (!this.isInConstructor(node)) {
                    this.addDiagnostic(kvPair, 'error',
                        `Attribute '${kvPair.name}' is constant and cannot be mutated. Const attributes can only be assigned in constructors (init methods).`,
                        ErrorCode.TC_ASSIGNMENT_TO_CONST
                    );
                    continue;
                }
            }

            // Check type compatibility
            const exprType = this.getType(kvPair.expr);
            const compatResult = this.typeUtils.isAssignable(
                this.typeUtils.resolveIfReference(exprType),
                this.typeUtils.resolveIfReference(fieldInfo.type)
            );

            if (!compatResult.success) {
                const errorMsg = compatResult.message
                    ? `Object update field '${kvPair.name}' type mismatch: ${compatResult.message}`
                    : `Object update field '${kvPair.name}' type mismatch: Expected '${fieldInfo.type.toString()}', but got '${exprType.toString()}'`;
                this.addDiagnostic(kvPair.expr, 'error', errorMsg, ErrorCode.TC_ASSIGNMENT_TYPE_MISMATCH);
            }
        }
    }

    /**
     * Helper method to get field info in a class or struct for object update validation.
     */
    private getFieldInfoForUpdate(baseType: TypeDescription, fieldName: string):
        { type: TypeDescription; isConst: boolean; isClass: boolean } | undefined {

        // For classes: get attribute type
        if (isClassType(baseType)) {
            const attribute = baseType.attributes.find(a => a.name === fieldName);
            if (attribute) {
                return {
                    type: attribute.type,
                    isConst: attribute.isConst,
                    isClass: true
                };
            }
            return undefined;
        }

        // For structs: get field type
        const structType = this.typeUtils.asStructType(baseType);
        if (structType) {
            const field = structType.fields.find(f => f.name === fieldName);
            if (field) {
                return {
                    type: field.type,
                    isConst: false,
                    isClass: false
                };
            }
        }

        return undefined;
    }

}
