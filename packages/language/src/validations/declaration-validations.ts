import { AstNode, AstUtils, ValidationAcceptor, ValidationChecks } from "langium";
import { ErrorCode } from "../codes/errors.js";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import {
    isArrayType,
    isClassType,
    isErrorType,
    isFunctionType,
    isImplementationType,
    isIntegerType,
    isInterfaceType,
    isJoinType,
    isNullableType,
    isReferenceType,
    isStructType,
    isTupleType,
    isUnionType,
    MethodType,
    TypeDescription,
    TypeKind
} from "../typing/type-c-types.js";
import { TypeCTypedValidation } from "./typed-base-validation.js";

/**
 * Declaration validator for Type-C.
 *
 * Validates declarations and type annotations:
 * - Variable declarations (single, array/struct/tuple destructuring)
 * - Function declarations and class methods (return types, override checks)
 * - Function parameters and class attributes
 * - Iterator variables and variable patterns
 * - Type annotations (nullable, reference, generic, data types)
 * - Default parameter ordering, types, and expression scope
 */
export class TypeCDeclarationValidator extends TypeCTypedValidation {
    constructor(services: TypeCServices) {
        super(services);
    }

    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            VariableDeclSingle: this.checkVariableDeclSingle,
            VariableDeclArrayDestructuring: this.checkVariableDeclArrayDestructuring,
            VariableDeclStructDestructuring: this.checkVariableDeclStructDestructuring,
            VariableDeclTupleDestructuring: this.checkVariableDeclTupleDestructuring,
            FunctionParameter: this.checkFunctionParameter,
            ClassAttributeDecl: this.checkClassAttributeDecl,
            IteratorVar: this.checkIteratorVar,
            VariablePattern: [this.checkVariablePattern, this.checkExpressionForErrors],
            FunctionDeclaration: [this.checkFunctionDeclaration, this.checkDefaultParameterOrdering, this.checkDefaultParameterTypes, this.checkDefaultExpressionScope],
            ClassMethod: [this.checkClassMethod, this.checkOverrideMethod, this.checkClassMethodDefaultParams, this.checkClassMethodDefaultExpressionScope],
            ImplementationMethodDecl: [this.checkImplMethodDefaultParams, this.checkImplMethodDefaultExpressionScope],
            ForEachIterator: this.checkForEachIterator,
            ForRangeIterator: this.checkForRangeIterator,
            NullableType: this.checkNullableType,
            ReferenceType: this.checkReferenceType,
            QualifiedReference: [this.checkQualifiedReferenceGenerics, this.checkExpressionForErrors],
            DataType: this.checkType,
        };
    }

    /**
     * Check variable declarations with explicit type annotations.
     *
     * Examples:
     * - let x: u32 = 42      // ✅ OK
     * - let x: u32 = "hello" // ❌ Error: expected u32, got string
     * - let x = 42           // ✅ OK (no annotation, inferred)
     */
    checkVariableDeclSingle = (node: ast.VariableDeclSingle, accept: ValidationAcceptor): void => {
        // Get the final type that will be assigned to this variable
        // This could be from annotation or inference
        let finalType: TypeDescription;

        if (node.annotation) {
            finalType = this.typeProvider.getType(node.annotation);
        } else if (node.initializer) {
            finalType = this.typeProvider.getType(node.initializer);
            if(isErrorType(finalType)) {
                accept('error', finalType.message, {
                    node: node,
                    code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
                })
            }
        } else {
            return; // No type to check
        }

        // Resolve references to get the actual type
        finalType = this.typeUtils.resolveIfReference(finalType);

        // Check if the final variable type is a nullable basic type
        // This catches cases like:
        // 1. let x: u32? = ... (explicit annotation)
        // 2. let x = get<u32>() where get returns T? (inferred from generic)
        if (isNullableType(finalType) && this.typeUtils.isTypeBasic(finalType.baseType)) {
            const errorNode = node.annotation || node.initializer || node;
            accept('error',
                `Variable '${node.name}' cannot have nullable basic type '${finalType.toString()}'. ` +
                `Basic types cannot be nullable. ` +
                `Consider using a reference type or handling null with the ?? operator.`,
                {
                    node: errorNode,
                    code: ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE
                }
            );
            return;
        }

        // Check if non-const variable is assigned from a const expression
        // Only applies to reference types (not basic types which are copied by value)
        if (!node.isConst && node.initializer) {
            const constSource = this.getConstSource(node.initializer);
            if (constSource) {
                // Get the type being assigned to check if it's a reference type
                const initializerType = this.typeProvider.getType(node.initializer);
                const resolvedType = this.typeUtils.resolveIfReference(initializerType);

                // Only error if it's NOT a basic type (basic types are copied, not referenced)
                if (!this.typeUtils.isTypeBasic(resolvedType)) {
                    accept('error',
                        `Cannot assign ${constSource.description} to non-const variable '${node.name}'. ` +
                        `Reference types must preserve const-ness. Either declare the variable as const (let const ${node.name} = ...) or assign from a mutable source.`,
                        {
                            node: node.initializer,
                            code: ErrorCode.TC_ASSIGNMENT_FROM_CONST_TO_MUTABLE
                        }
                    );
                }
            }
        }

        // Only check type compatibility if there's both annotation AND initializer
        if (!node.annotation || !node.initializer) {
            return;
        }

        let expectedType = this.typeProvider.getType(node.annotation);
        let inferredType = this.typeProvider.getType(node.initializer);

        // Resolve type references
        expectedType = this.typeUtils.resolveIfReference(expectedType);
        inferredType = this.typeUtils.resolveIfReference(inferredType);

        // Check compatibility using the centralized type compatibility checker
        // This handles all cases including interface compatibility
        const compatResult = this.isTypeCompatible(inferredType, expectedType);
        if (!compatResult.success) {
            // Build context-aware error message
            let errorMsg: string;
            let errorCode: ErrorCode;

            if (isInterfaceType(expectedType) && isClassType(inferredType)) {
                // Special formatting for interface implementation errors
                errorCode = ErrorCode.TC_VARIABLE_INTERFACE_IMPLEMENTATION_ERROR;
                errorMsg = `Variable '${node.name}' type error: Class '${inferredType.toString()}' must implement interface '${expectedType.toString()}'`;
                if (compatResult.message) {
                    errorMsg += `. Implementation issue: ${compatResult.message}`;
                }
            } else {
                // General type mismatch
                errorCode = ErrorCode.TC_VARIABLE_TYPE_MISMATCH;
                errorMsg = compatResult.message
                    ? `Variable '${node.name}' type mismatch: ${compatResult.message}`
                    : `Variable '${node.name}' type mismatch: Expected type '${expectedType.toString()}', but got '${inferredType.toString()}'`;
            }
            accept('error', errorMsg, {
                node: node.initializer,
                property: 'initializer',
                code: errorCode
            });
        }
    }

    /**
     * Check array destructuring variable declarations for const assignment from const sources.
     */
    checkVariableDeclArrayDestructuring = (node: ast.VariableDeclArrayDestructuring, accept: ValidationAcceptor): void => {
        if (!node.initializer || node.isConst) {
            return; // Skip if no initializer or already const
        }

        // Check if assigning from a const source
        const constSource = this.getConstSource(node.initializer);
        if (!constSource) {
            return; // Not from a const source
        }

        // Check each destructured element
        for (const element of node.elements) {
            if (!ast.isDestructuringElement(element)) {
                continue;
            }

            // Get the type being assigned to check if it's a reference type
            const elementType = this.typeProvider.getType(element);
            const resolvedType = this.typeUtils.resolveIfReference(elementType);

            // Only error if it's NOT a basic type
            if (!this.typeUtils.isTypeBasic(resolvedType)) {
                accept('error',
                    `Cannot assign element from ${constSource.description} to non-const variable '${element.name}'. ` +
                    `Reference types must preserve const-ness. Either declare as const (let const [...] = ...) or assign from a mutable source.`,
                    {
                        node: element,
                        property: 'name',
                        code: ErrorCode.TC_ASSIGNMENT_FROM_CONST_TO_MUTABLE
                    }
                );
            }
        }
    }

    /**
     * Check struct destructuring variable declarations for const assignment from const sources.
     */
    checkVariableDeclStructDestructuring = (node: ast.VariableDeclStructDestructuring, accept: ValidationAcceptor): void => {
        if (!node.initializer || node.isConst) {
            return; // Skip if no initializer or already const
        }

        // Check if assigning from a const source
        const constSource = this.getConstSource(node.initializer);
        if (!constSource) {
            return; // Not from a const source
        }

        // Check each destructured element
        for (const element of node.elements) {
            if (!ast.isDestructuringElement(element)) {
                continue;
            }

            // Get the type being assigned to check if it's a reference type
            const elementType = this.typeProvider.getType(element);
            const resolvedType = this.typeUtils.resolveIfReference(elementType);

            // Only error if it's NOT a basic type
            if (!this.typeUtils.isTypeBasic(resolvedType)) {
                const fieldName = element.originalName || element.name;
                accept('error',
                    `Cannot assign field '${fieldName}' from ${constSource.description} to non-const variable '${element.name}'. ` +
                    `Reference types must preserve const-ness. Either declare as const (let const {...} = ...) or assign from a mutable source.`,
                    {
                        node: element,
                        property: 'name',
                        code: ErrorCode.TC_ASSIGNMENT_FROM_CONST_TO_MUTABLE
                    }
                );
            }
        }
    }

    /**
     * Check tuple destructuring variable declarations for const assignment from const sources.
     */
    checkVariableDeclTupleDestructuring = (node: ast.VariableDeclTupleDestructuring, accept: ValidationAcceptor): void => {
        if (!node.initializer || node.isConst) {
            return; // Skip if no initializer or already const
        }

        // Check if assigning from a const source
        const constSource = this.getConstSource(node.initializer);
        if (!constSource) {
            return; // Not from a const source
        }

        // Check each destructured element
        for (const element of node.elements) {
            if (!ast.isDestructuringElement(element)) {
                continue;
            }

            // Get the type being assigned to check if it's a reference type
            const elementType = this.typeProvider.getType(element);
            const resolvedType = this.typeUtils.resolveIfReference(elementType);

            // Only error if it's NOT a basic type
            if (!this.typeUtils.isTypeBasic(resolvedType)) {
                accept('error',
                    `Cannot assign tuple element from ${constSource.description} to non-const variable '${element.name}'. ` +
                    `Reference types must preserve const-ness. Either declare as const (let const (...) = ...) or assign from a mutable source.`,
                    {
                        node: element,
                        property: 'name',
                        code: ErrorCode.TC_ASSIGNMENT_FROM_CONST_TO_MUTABLE
                    }
                );
            }
        }
    }

    checkFunctionDeclaration = (node: ast.FunctionDeclaration, accept: ValidationAcceptor): void => {
        const isCoroutine = node.fnType === 'cfn';

        // Independently infer the return type from the function body/expression
        let inferredReturnType: TypeDescription;

        if (node.expr) {
            // Expression-body function: fn foo() = expr
            inferredReturnType = this.typeProvider.getType(node.expr);
        } else if (node.body) {
            // Block-body function: fn foo() { ... }
            if (isCoroutine) {
                // For coroutines, infer from yield expressions
                inferredReturnType = this.inferYieldTypeFromBody(node.body);
            } else {
                // For regular functions, infer from return statements
                inferredReturnType = this.inferReturnTypeFromBody(node.body);
            }
        } else {
            // No body or expression (shouldn't happen for implemented functions)
            return;
        }

        // Check 1: If inferred return/yield type is an error, report it
        if (isErrorType(inferredReturnType)) {
            const errorType = inferredReturnType;
            const message = errorType.message || (isCoroutine ? 'Cannot infer yield type' : 'Cannot infer return type');

            // Don't report recursion placeholder errors (they're handled during inference)
            if (message === '__recursion_placeholder__') {
                return;
            }

            // Highlight the entire function declaration for visibility
            const errorCode = isCoroutine ? ErrorCode.TC_COROUTINE_YIELD_TYPE_INFERENCE_FAILED : ErrorCode.TC_FUNCTION_RETURN_TYPE_INFERENCE_FAILED;
            accept('error', message, {
                node: node,
                code: errorCode
            });
            return;
        }

        // Check 2: If explicit return/yield type, validate it matches inferred type
        if (node.header.returnType) {
            const declaredReturnType = this.typeProvider.getType(node.header.returnType);

            const compatResult = this.isTypeCompatible(inferredReturnType, declaredReturnType);
            if (!compatResult.success) {
                const typeKind = isCoroutine ? 'yield' : 'return';
                const errorCode = isCoroutine ? ErrorCode.TC_COROUTINE_YIELD_TYPE_MISMATCH : ErrorCode.TC_FUNCTION_RETURN_TYPE_MISMATCH;
                const errorMsg = compatResult.message
                    ? `${isCoroutine ? 'Coroutine' : 'Function'} ${typeKind} type mismatch: ${compatResult.message}`
                    : `${isCoroutine ? 'Coroutine' : 'Function'} ${typeKind} type mismatch: Declared '${declaredReturnType.toString()}', but inferred '${inferredReturnType.toString()}'`;
                accept('error', errorMsg, {
                    node: node.expr ?? node.header.returnType,
                    code: errorCode
                });
            }
        }
    }

    /**
     * Check class method declarations for return type issues.
     *
     * Validates:
     * 1. If no explicit return type → ensure we can infer successfully (no error type)
     * 2. If explicit return type → ensure inferred type matches declared type
     *
     * This is similar to function validation but for class methods specifically.
     * Note: Class methods are always regular functions (fn), not coroutines (cfn).
     *
     * Examples:
     * ```
     * class Foo {
     *     fn bad() = match n { 0 => 1, _ => "oops" }  // ❌ Can't infer common type
     *     fn good() -> u32 = ...                       // ✅ Explicit type
     *     fn good2() = 42                              // ✅ Can infer u32
     * }
     * ```
     */
    checkClassMethod = (node: ast.ClassMethod, accept: ValidationAcceptor): void => {
        // Get the method header
        const methodHeader = node.method;
        if (!methodHeader || !methodHeader.header) {
            return;
        }

        // We need to infer the return type from the method body/expression
        let inferredReturnType: TypeDescription;

        if (node.expr) {
            // Expression-body method: fn foo() = expr
            inferredReturnType = this.typeProvider.getType(node.expr);
        } else if (node.body) {
            // Block-body method: fn foo() { ... }
            // Class methods are always regular functions
            inferredReturnType = this.inferReturnTypeFromBody(node.body);
        } else {
            // No body or expression (shouldn't happen for implemented methods)
            return;
        }

        // Check 1: If inferred return type is an error, report it
        if (isErrorType(inferredReturnType)) {
            const errorType = inferredReturnType;
            const message = errorType.message || 'Cannot infer return type';

            // Don't report recursion placeholder errors
            if (message === '__recursion_placeholder__') {
                return;
            }

            // Highlight the method declaration for visibility
            accept('error', message, {
                node: node,
                code: ErrorCode.TC_METHOD_RETURN_TYPE_INFERENCE_FAILED
            });
            return;
        }

        // Check 2: If explicit return type, validate it matches inferred type
        if (methodHeader.header.returnType) {
            const declaredReturnType = this.typeProvider.getType(methodHeader.header.returnType);

            const compatResult = this.isTypeCompatible(inferredReturnType, declaredReturnType);
            if (!compatResult.success) {
                const errorMsg = compatResult.message
                    ? `Method return type mismatch: ${compatResult.message}`
                    : `Method return type mismatch: Declared '${declaredReturnType.toString()}', but inferred '${inferredReturnType.toString()}'`;
                accept('error', errorMsg, {
                    node: node.expr??methodHeader.header.returnType,
                    code: ErrorCode.TC_METHOD_RETURN_TYPE_MISMATCH
                });
            }
        }
    }

    /**
     * Check that override methods actually override an impl method.
     *
     * Validates:
     * 1. Methods marked with `override` must actually override a method from an implementation
     * 2. The override signature must match the impl method signature (parameters)
     * 3. The override return type must be compatible with the impl method return type
     *
     * Examples:
     * ```tc
     * type Default3DImpl<T> = impl Object3D (position: T) {
     *     fn getPos() = this.position
     * }
     *
     * class Mesh {
     *     let pos: vec3
     *     impl Default3DImpl<vec3>(pos)
     *     override fn getPos() -> vec3 = this.pos  // ✅ OK - overrides impl method
     *     override fn nonExistent() -> i32 = 0     // ❌ Error - no impl method to override
     *     override fn getPos() -> i32 = 0          // ❌ Error - wrong return type
     * }
     * ```
     */
    checkOverrideMethod = (node: ast.ClassMethod, accept: ValidationAcceptor): void => {
        // Only validate methods marked with override
        if (!node.isOverride) {
            return;
        }

        // Get the containing class
        const classNode = AstUtils.getContainerOfType(node, ast.isClassType);
        if (!classNode) {
            return;
        }

        const classType = this.typeProvider.getType(classNode);
        if (!isClassType(classType)) {
            return;
        }

        // Get all method names from this override method
        const overrideMethodNames = node.method.names;

        // For each name, check if there's a matching impl method
        for (const methodName of overrideMethodNames) {
            // Collect all methods from implementations with this name
            const implMethods: MethodType[] = [];

            for (const implRef of classType.implementations) {
                const implType = this.typeProvider.resolveReference(implRef);

                if (isImplementationType(implType)) {
                    // Build generic substitutions if the impl has generic args
                    let substitutions: Map<string, TypeDescription> | undefined;
                    if (isReferenceType(implRef) && implRef.genericArgs.length > 0 && implRef.declaration.genericParameters) {
                        substitutions = new Map<string, TypeDescription>();
                        implRef.declaration.genericParameters.forEach((param, i) => {
                            if (i < implRef.genericArgs.length) {
                                substitutions!.set(param.name, implRef.genericArgs[i]);
                            }
                        });
                    }

                    // Find methods with matching name
                    for (const implMethod of implType.methods) {
                        if (implMethod.names.includes(methodName)) {
                            // Apply generic substitutions if we have them
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

            // If no impl methods found with this name, report error
            if (implMethods.length === 0) {
                const errorCode = ErrorCode.TC_OVERRIDE_WITHOUT_IMPL_METHOD;
                accept('error',
                    `Override method '${methodName}' does not override any method from implementations. ` +
                    `The 'override' keyword can only be used when overriding a method provided by an impl.`,
                    {
                        node: node.method,
                        property: 'names',
                        code: errorCode
                    }
                );
                continue;
            }

            // Get the override method signature
            let overrideMethodType: MethodType | undefined;

            // Extract the method type from the class method
            if (classType.methods) {
                overrideMethodType = classType.methods.find(m =>
                    m.names.includes(methodName) &&
                    m.parameters.length === (node.method.header?.args?.length ?? 0)
                );
            }

            if (!overrideMethodType) {
                continue; // Couldn't get method type, skip validation
            }

            // Check if the override signature matches any impl method
            let foundMatch = false;
            let signatureMismatchDetails: string[] = [];

            for (const implMethod of implMethods) {
                // Check parameter count
                if (overrideMethodType.parameters.length !== implMethod.parameters.length) {
                    signatureMismatchDetails.push(
                        `Expected ${implMethod.parameters.length} parameter(s), got ${overrideMethodType.parameters.length}`
                    );
                    continue;
                }

                // Check parameter types AND mutability
                let parametersMatch = true;
                for (let i = 0; i < overrideMethodType.parameters.length; i++) {
                    const overrideParam = overrideMethodType.parameters[i];
                    const implParam = implMethod.parameters[i];

                    // Use type equality check for parameters
                    const compatResult = this.typeUtils.areTypesEqual(overrideParam.type, implParam.type);
                    if (!compatResult.success) {
                        parametersMatch = false;
                        signatureMismatchDetails.push(
                            `Parameter ${i + 1} type mismatch: expected '${implParam.type.toString()}', got '${overrideParam.type.toString()}'`
                        );
                        break;
                    }

                    // Check mutability: override can be LESS permissive but NOT MORE permissive
                    // ✅ impl has mut, override has immutable (less permissive) - OK
                    // ❌ impl has immutable, override has mut (more permissive) - ERROR
                    const overrideIsMut = overrideParam.isMut || false;
                    const implIsMut = implParam.isMut || false;

                    if (overrideIsMut && !implIsMut) {
                        // Override is MORE permissive (wants to mutate when impl doesn't)
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

                // Check return type compatibility (override return type should be compatible with impl return type)
                const returnTypeCompat = this.isTypeCompatible(overrideMethodType.returnType, implMethod.returnType);
                if (!returnTypeCompat.success) {
                    signatureMismatchDetails.push(
                        `Return type mismatch: expected '${implMethod.returnType.toString()}', got '${overrideMethodType.returnType.toString()}'`
                    );
                    continue;
                }

                // Found a matching impl method
                foundMatch = true;
                break;
            }

            // If no matching impl method found, report error
            if (!foundMatch) {
                const errorCode = ErrorCode.TC_OVERRIDE_SIGNATURE_MISMATCH;
                const implSignatures = implMethods.map(m =>
                    `${methodName}(${m.parameters.map(p => p.type.toString()).join(', ')}) -> ${m.returnType.toString()}`
                ).join(' or ');

                accept('error',
                    `Override method '${methodName}' signature does not match any impl method. ` +
                    `Expected: ${implSignatures}. ` +
                    `Issues: ${signatureMismatchDetails.join('; ')}`,
                    {
                        node: node.method,
                        property: 'names',
                        code: errorCode
                    }
                );
            }
        }
    }

    /**
     * Check function parameters for nullable basic types.
     * Catches cases like: fn foo(x: u32?) or fn get<T>(x: T) where T is instantiated with u32 and return type is T?
     */
    checkFunctionParameter = (node: ast.FunctionParameter, accept: ValidationAcceptor): void => {
        if (!node.type) return;

        const paramType = this.typeProvider.getType(node.type);
        const errorMsg = this.checkForNullableBasicType(paramType);

        if (errorMsg) {
            accept('error', `Parameter '${node.name ?? '<unnamed>'}' cannot have ${errorMsg}`, {
                node: node.type,
                code: ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE
            });
        }
    }

    /**
     * Check class attributes for nullable basic types.
     * Catches cases like: class C { let x: u32? }
     */
    checkClassAttributeDecl = (node: ast.ClassAttributeDecl, accept: ValidationAcceptor): void => {
        // Validate that attribute has either type or initializer (or both)
        if (!node.type && !node.initializer) {
            accept('error', `Class attribute '${node.name}' must have either a type annotation or an initializer`, {
                node: node,
                code: ErrorCode.TC_CLASS_ATTRIBUTE_MISSING_TYPE_OR_INITIALIZER
            });
            return;
        }

        // Get the final type of the attribute (from annotation or inferred from initializer)
        let finalType: TypeDescription;

        if (node.type) {
            finalType = this.typeProvider.getType(node.type);
        } else if (node.initializer) {
            finalType = this.typeProvider.getType(node.initializer);
            if (isErrorType(finalType)) {
                accept('error', finalType.message, {
                    node: node.initializer,
                    code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
                });
                return;
            }
        } else {
            return; // Should not reach here due to check above
        }

        // Resolve references to get the actual type
        finalType = this.typeUtils.resolveIfReference(finalType);

        // Check if the final attribute type is a nullable basic type
        if (isNullableType(finalType) && this.typeUtils.isTypeBasic(finalType.baseType)) {
            const errorNode = node.type || node.initializer || node;
            accept('error',
                `Attribute '${node.name}' cannot have nullable basic type '${finalType.toString()}'. ` +
                `Basic types cannot be nullable. ` +
                `Consider using a reference type or handling null with the ?? operator.`,
                {
                    node: errorNode,
                    code: ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE
                }
            );
            return;
        }

        // Check if non-const attribute is assigned from a const expression
        // Only applies to reference types (not basic types which are copied by value)
        if (!node.isConst && node.initializer) {
            const constSource = this.getConstSource(node.initializer);
            if (constSource) {
                // Get the type being assigned to check if it's a reference type
                const initializerType = this.typeProvider.getType(node.initializer);
                const resolvedType = this.typeUtils.resolveIfReference(initializerType);

                // Only error if it's NOT a basic type (basic types are copied, not referenced)
                if (!this.typeUtils.isTypeBasic(resolvedType)) {
                    accept('error',
                        `Cannot assign ${constSource.description} to non-const attribute '${node.name}'. ` +
                        `Reference types must preserve const-ness. Either declare the attribute as const (let const ${node.name} = ...) or assign from a mutable source.`,
                        {
                            node: node.initializer,
                            code: ErrorCode.TC_ASSIGNMENT_FROM_CONST_TO_MUTABLE
                        }
                    );
                }
            }
        }

        // Only check type compatibility if there's both annotation AND initializer
        if (!node.type || !node.initializer) {
            return;
        }

        let expectedType = this.typeProvider.getType(node.type);
        let inferredType = this.typeProvider.getType(node.initializer);

        // Resolve type references
        expectedType = this.typeUtils.resolveIfReference(expectedType);
        inferredType = this.typeUtils.resolveIfReference(inferredType);

        // Check compatibility
        const compatResult = this.isTypeCompatible(inferredType, expectedType);
        if (!compatResult.success) {
            const errorCode = ErrorCode.TC_VARIABLE_TYPE_MISMATCH;
            const errorMsg = compatResult.message
                ? `Attribute '${node.name}' type mismatch: ${compatResult.message}`
                : `Attribute '${node.name}' type mismatch: Expected type '${expectedType.toString()}', but got '${inferredType.toString()}'`;
            accept('error', errorMsg, {
                node: node.initializer,
                property: 'initializer',
                code: errorCode
            });
        }
    }

    /**
     * Check iterator variables for nullable basic types.
     * Catches cases like: foreach x: u32? in ... or inferred from collection type
     */
    checkIteratorVar = (node: ast.IteratorVar, accept: ValidationAcceptor): void => {
        const varType = this.typeProvider.getType(node);
        const errorMsg = this.checkForNullableBasicType(varType);

        if (errorMsg) {
            accept('error', `Iterator variable '${node.name}' cannot have ${errorMsg}`, {
                node: node,
                code: ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE
            });
        }
    }

    /**
     * Check variable patterns (in match expressions) for nullable basic types.
     * Catches cases like match patterns that bind to nullable basic types
     */
    checkVariablePattern = (node: ast.VariablePattern, accept: ValidationAcceptor): void => {
        const varType = this.typeProvider.getType(node);
        const errorMsg = this.checkForNullableBasicType(varType);

        if (errorMsg) {
            accept('error', `Pattern variable '${node.name}' cannot have ${errorMsg}`, {
                node: node,
                code: ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE
            });
        }
    }

    checkForEachIterator(node: ast.ForEachIterator, accept: ValidationAcceptor) {
        const iteratorType = this.typeProvider.getType(node.valueVar);

        if(isErrorType(iteratorType)) {
            accept('error', iteratorType.message || 'Cannot infer iterator variable type', {
                node: node.valueVar,
                code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
            });
        }
    }

    checkForRangeIterator(node: ast.ForRangeIterator, accept: ValidationAcceptor) {
        // Validate that start, end, and step are all non-floating point integers
        let startType = this.typeProvider.getType(node.start);
        let endType = this.typeProvider.getType(node.end);
        let stepType = this.typeProvider.getType(node.step);

        // Resolve reference types (e.g., type aliases)
        startType = this.typeUtils.resolveIfReference(startType);
        endType = this.typeUtils.resolveIfReference(endType);
        stepType = this.typeUtils.resolveIfReference(stepType);

        // Skip validation if any type is already an error (will be reported elsewhere)
        const hasError = isErrorType(startType) || isErrorType(endType) || isErrorType(stepType);

        if (!hasError) {
            // Check start is integer
            if (!isIntegerType(startType) && startType.kind !== TypeKind.Never) {
                accept('error', `Range start must be a non-floating point integer, but got '${startType.toString()}'`, {
                    node: node.start,
                    code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
                });
            }

            // Check end is integer
            if (!isIntegerType(endType) && endType.kind !== TypeKind.Never) {
                accept('error', `Range end must be a non-floating point integer, but got '${endType.toString()}'`, {
                    node: node.end,
                    code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
                });
            }

            // Check step is integer
            if (!isIntegerType(stepType) && stepType.kind !== TypeKind.Never) {
                accept('error', `Range step must be a non-floating point integer, but got '${stepType.toString()}'`, {
                    node: node.step,
                    code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
                });
            }
            // Check step is unsigned (positive) integer
            else if (isIntegerType(stepType)) {
                // Signed integer types (i8, i16, i32, i64) are not allowed as step
                const signedTypes = [TypeKind.I8, TypeKind.I16, TypeKind.I32, TypeKind.I64];
                if (signedTypes.includes(stepType.kind)) {
                    accept('error', `Range step must be a positive integer (unsigned type), but got signed type '${stepType.toString()}'. Use u8, u16, u32, or u64 instead.`, {
                        node: node.step,
                        code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
                    });
                }
            }
        }

        // Validate iterator type annotation if specified
        if (node.iterType) {
            let iterType = this.typeProvider.getType(node.iterType);

            // Resolve reference types (e.g., type aliases)
            iterType = this.typeUtils.resolveIfReference(iterType);

            if (!isIntegerType(iterType) && !isErrorType(iterType) && iterType.kind !== TypeKind.Never) {
                accept('error', `Range iterator type must be a non-floating point integer, but got '${iterType.toString()}'`, {
                    node: node.iterType,
                    code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
                });
            }
        }

        // Validate that the iterator variable type is properly inferred
        // If no explicit type is provided, it inherits from the start value
        const valueVarType = this.typeProvider.getType(node.valueVar);

        if (isErrorType(valueVarType)) {
            accept('error', valueVarType.message || 'Cannot infer iterator variable type', {
                node: node.valueVar,
                code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
            });
        }
    }

    checkNullableType(node: ast.NullableType, accept: ValidationAcceptor) {
        let type = this.typeProvider.getType(node.baseType);

        if(this.typeUtils.isTypeBasic(type)) {
            accept('error', 'Basic types cannot be nullables', {
                node: node,
                code: ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE
            });
        }
    }

    checkReferenceType = (node: ast.ReferenceType, accept: ValidationAcceptor): void => {
        // Get the referenced entity
        const ref = node.field?.ref;
        if (!ref) {
            return; // Unresolved reference, will be reported elsewhere
        }

        // Check if the reference points to a variable instead of a type
        // Variables include: VariableDeclaration, FunctionParameter, ClassAttributeDecl, IteratorVar, VariablePattern
        const isVariable =
            ast.isVariableDeclaration(ref) ||
            ast.isFunctionParameter(ref) ||
            ast.isClassAttributeDecl(ref) ||
            ast.isIteratorVar(ref) ||
            ast.isVariablePattern(ref);

        if (isVariable) {
            const errorCode = ErrorCode.TC_VARIABLE_USED_AS_TYPE;
            const variableKind = ast.isVariableDeclaration(ref) ? 'variable' :
                                ast.isFunctionParameter(ref) ? 'parameter' :
                                ast.isClassAttributeDecl(ref) ? 'attribute' :
                                ast.isIteratorVar(ref) ? 'iterator variable' :
                                'pattern variable';
            accept('error',
                `Cannot use ${variableKind} '${this.getReferenceName(ref)}' as a type. Type annotations must reference type declarations, not variables.`,
                {
                    node,
                    property: 'field',
                    code: errorCode
                }
            );
            return;
        }

        // Continue with existing generic argument validation
        if (!ast.isTypeDeclaration(ref)) {
            return; // Not a type declaration, skip generic validation
        }

        // Get the generic parameters from the type declaration
        const expectedGenericCount = ref.genericParameters?.length ?? 0;

        // Get the generic arguments provided in the reference
        const providedGenericArgs = node.genericArgs ?? [];
        const providedGenericCount = providedGenericArgs.length;

        // Rule 1: If the type is non-generic (0 expected params), it should not receive generic arguments
        if (expectedGenericCount === 0 && providedGenericCount > 0) {
            const errorCode = ErrorCode.TC_NON_GENERIC_TYPE_WITH_ARGS;
            accept('error',
                `Type '${ref.name}' does not accept generic arguments`,
                {
                    node,
                    code: errorCode
                }
            );
            return;
        }

        // Rule 2: If generic arguments are provided, the count must match exactly
        // Note: We allow 0 generic args even for generic types (for inference)
        if (providedGenericCount > 0 && providedGenericCount !== expectedGenericCount) {
            const errorCode = ErrorCode.TC_GENERIC_ARG_COUNT_MISMATCH;
            accept('error',
                `Type '${ref.name}' expects ${expectedGenericCount} generic argument(s), but got ${providedGenericCount}`,
                {
                    node,
                    code: errorCode
                }
            );
        }
    }

    checkQualifiedReferenceGenerics(node: ast.QualifiedReference, accept: ValidationAcceptor) {
        // Only validate if the reference is resolved
        const ref = node.reference?.ref;
        if (!ref) {
            return; // Unresolved reference - will be reported elsewhere
        }

        // Get the type of the referenced entity
        const refType = this.typeProvider.getType(ref);

        // Resolve reference types to get the actual type
        const resolvedType = this.typeUtils.resolveIfReference(refType);

        // Get the provided generic arguments
        const providedGenericArgs = node.genericArgs ?? [];
        const providedGenericCount = providedGenericArgs.length;

        // Only function types can have generic instantiation in QualifiedReference
        // (Type declarations use ReferenceType for generic instantiation)
        if (isFunctionType(resolvedType)) {
            const genericParams = resolvedType.genericParameters || [];
            const expectedGenericCount = genericParams.length;

            // Rule 1: Non-generic function cannot receive generic arguments
            if (expectedGenericCount === 0 && providedGenericCount > 0) {
                const errorCode = ErrorCode.TC_NON_GENERIC_TYPE_WITH_ARGS;
                accept('error',
                    `Function '${ref.$type === 'FunctionDeclaration' ? (ref as ast.FunctionDeclaration).name : 'function'}' does not accept generic arguments`,
                    {
                        node,
                        code: errorCode
                    }
                );
                return;
            }

            // Rule 2: Generic function requires generic arguments when used as a reference
            // (not when called - calls can infer generics from arguments)
            if ((expectedGenericCount > 0 && providedGenericCount === 0) && !ast.isFunctionCall(node.$container)) {
                const errorCode = ErrorCode.TC_GENERIC_ARG_COUNT_MISMATCH;
                accept('error',
                    `Generic function requires ${expectedGenericCount} generic argument(s). Example: ${ref.$type === 'FunctionDeclaration' ? (ref as ast.FunctionDeclaration).name : 'function'}<${genericParams.map(p => p.name).join(', ')}>`,
                    {
                        node,
                        code: errorCode
                    }
                );
                return;
            }

            // Rule 3: Generic argument count must match
            if (providedGenericCount > 0 && providedGenericCount !== expectedGenericCount) {
                const errorCode = ErrorCode.TC_GENERIC_ARG_COUNT_MISMATCH;
                accept('error',
                    `Generic argument count mismatch: Expected ${expectedGenericCount} generic argument(s), but got ${providedGenericCount}`,
                    {
                        node,
                        code: errorCode
                    }
                );
            }
        }
        // For non-function types, having generic args on QualifiedReference is an error
        else if (providedGenericCount > 0) {
            const errorCode = ErrorCode.TC_NON_GENERIC_TYPE_WITH_ARGS;
            accept('error',
                `Cannot apply generic arguments to non-generic entity '${resolvedType.toString()}'`,
                {
                    node,
                    code: errorCode
                }
            );
        }
    }

    checkType = (node: ast.DataType, accept: ValidationAcceptor): void => {

        // Get the type of the declaration, which will trigger substitution if it's generic
        const type = this.typeUtils.resolveIfReference(this.typeProvider.getType(node));

        // Additionally, recursively check for errors in the type structure
        // This catches errors in nested types
        this.checkTypeForErrors(type, node, accept);
    }

    /**
     * Recursively check a type and its nested types for errors.
     * This is used to validate type declarations and catch errors deep in the type structure.
     */
    private checkTypeForErrors(type: TypeDescription, node: AstNode, accept: ValidationAcceptor): void {
        // Check if the type itself is an error
        if (isErrorType(type)) {
            const message = type.message;

            // Skip internal error types
            if (message === '__recursion_placeholder__' ||
                message === '__contextual_placeholder__' ||
                message?.includes('placeholder')) {
                return;
            }

            accept('error', message || 'Type error', {
                node,
                code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
            });
            return;
        }

        // Check the errors field
        if (type.errors && type.errors.length > 0) {
            for (const errorMsg of type.errors) {
                accept('error', errorMsg, {
                    node,
                    code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
                });
            }
        }

        // Recursively check nested types
        if (isArrayType(type)) {
            this.checkTypeForErrors(type.elementType, node, accept);
        } else if (isNullableType(type)) {
            this.checkTypeForErrors(type.baseType, node, accept);
        } else if (isUnionType(type)) {
            for (const t of type.types) {
                this.checkTypeForErrors(t, node, accept);
            }
        } else if (isJoinType(type)) {
            for (const t of type.types) {
                this.checkTypeForErrors(t, node, accept);
            }
        } else if (isTupleType(type)) {
            for (const t of type.elementTypes) {
                this.checkTypeForErrors(t, node, accept);
            }
        } else if (isStructType(type)) {
            for (const field of type.fields) {
                this.checkTypeForErrors(field.type, node, accept);
            }
        } else if (isReferenceType(type) && type.genericArgs.length > 0) {
            for (const arg of type.genericArgs) {
                this.checkTypeForErrors(arg, node, accept);
            }
        }
    }

    // ========================================================================
    // Default Parameter Validations
    // ========================================================================

    /**
     * Check that parameters with default values come after all required parameters.
     */
    checkDefaultParameterOrdering = (node: ast.FunctionDeclaration, accept: ValidationAcceptor): void => {
        const params = node.header?.args ?? [];
        this.validateDefaultParamOrdering(params, accept);
    }

    /**
     * Same check for class methods.
     */
    checkClassMethodDefaultParams = (node: ast.ClassMethod, accept: ValidationAcceptor): void => {
        const params = node.method?.header?.args ?? [];
        this.validateDefaultParamOrdering(params, accept);
        this.validateDefaultParamTypes(params, accept);
    }

    private validateDefaultParamOrdering(params: ast.FunctionParameter[], accept: ValidationAcceptor): void {
        let seenDefault = false;
        for (const param of params) {
            if (param.defaultValue) {
                seenDefault = true;
            } else if (seenDefault) {
                accept('error',
                    `Required parameter '${param.name}' cannot appear after a parameter with a default value.`,
                    {
                        node: param,
                        property: 'name',
                        code: ErrorCode.TC_DEFAULT_PARAM_BEFORE_REQUIRED
                    }
                );
            }
        }
    }

    /**
     * Check that default expressions have types assignable to their declared parameter types.
     */
    checkDefaultParameterTypes = (node: ast.FunctionDeclaration, accept: ValidationAcceptor): void => {
        const params = node.header?.args ?? [];
        this.validateDefaultParamTypes(params, accept);
    }

    private validateDefaultParamTypes(params: ast.FunctionParameter[], accept: ValidationAcceptor): void {
        for (const param of params) {
            if (param.defaultValue && param.type) {
                const paramType = this.typeProvider.getType(param.type);
                const defaultType = this.typeProvider.getType(param.defaultValue);

                const result = this.isTypeCompatible(defaultType, paramType);
                if (!result.success) {
                    accept('error',
                        `Default value type mismatch: Parameter '${param.name}' has type '${paramType.toString()}', but default value has type '${defaultType.toString()}'`,
                        {
                            node: param.defaultValue,
                            code: ErrorCode.TC_DEFAULT_PARAM_TYPE_MISMATCH
                        }
                    );
                }
            }
        }
    }

    /**
     * Check that default parameter expressions do not reference other function parameters
     * or local variables. Default expressions are expanded at the call site, so they cannot
     * access the declaring function's scope. Only literals and module-level declarations are safe.
     */
    checkDefaultExpressionScope = (node: ast.FunctionDeclaration, accept: ValidationAcceptor): void => {
        const params = node.header?.args ?? [];
        this.validateDefaultExpressionScope(params, accept);
    }

    /**
     * Same check for class methods.
     */
    checkClassMethodDefaultExpressionScope = (node: ast.ClassMethod, accept: ValidationAcceptor): void => {
        const params = node.method?.header?.args ?? [];
        this.validateDefaultExpressionScope(params, accept);
    }

    /**
     * Default parameter validations for impl block methods.
     * Checks ordering (TCE025) and type compatibility (TCE026).
     */
    checkImplMethodDefaultParams = (node: ast.ImplementationMethodDecl, accept: ValidationAcceptor): void => {
        const params = node.method?.header?.args ?? [];
        this.validateDefaultParamOrdering(params, accept);
        this.validateDefaultParamTypes(params, accept);
    }

    /**
     * Default expression scope validation for impl block methods (TCE027).
     */
    checkImplMethodDefaultExpressionScope = (node: ast.ImplementationMethodDecl, accept: ValidationAcceptor): void => {
        const params = node.method?.header?.args ?? [];
        this.validateDefaultExpressionScope(params, accept);
    }

    private validateDefaultExpressionScope(params: ast.FunctionParameter[], accept: ValidationAcceptor): void {
        // Collect all parameter names in this function for reference checking
        const paramNames = new Set(params.map(p => p.name));

        for (const param of params) {
            if (!param.defaultValue) continue;

            // Walk the default expression node itself AND all its descendants
            // streamAllContents only yields descendants, so we also need to check the root node
            const nodesToCheck = [param.defaultValue, ...AstUtils.streamAllContents(param.defaultValue)];
            for (const child of nodesToCheck) {
                if (ast.isQualifiedReference(child)) {
                    const ref = child.reference?.ref;
                    if (!ref) continue;

                    // Reject references to other function parameters
                    if (ast.isFunctionParameter(ref) && paramNames.has(ref.name)) {
                        accept('error',
                            `Default value for '${param.name}' cannot reference parameter '${ref.name}'. Default expressions are evaluated at the call site and cannot access other parameters.`,
                            {
                                node: child,
                                code: ErrorCode.TC_DEFAULT_PARAM_REFERENCES_LOCAL
                            }
                        );
                    }

                    // Reject references to local variables (VariableDeclaration inside a function body)
                    if (ast.isVariableDeclaration(ref) || ast.isVariableDeclSingle(ref)) {
                        // Check if the variable is local (inside a function/method body, not module-level)
                        const containingFn = AstUtils.getContainerOfType(ref, ast.isFunctionDeclaration);
                        const containingMethod = AstUtils.getContainerOfType(ref, ast.isClassMethod);
                        const containingImpl = AstUtils.getContainerOfType(ref, ast.isImplementationMethodDecl);
                        if (containingFn || containingMethod || containingImpl) {
                            const varName = ast.isVariableDeclSingle(ref) ? ref.name : '(variable)';
                            accept('error',
                                `Default value for '${param.name}' cannot reference local variable '${varName}'. Default expressions are evaluated at the call site and cannot access local scope.`,
                                {
                                    node: child,
                                    code: ErrorCode.TC_DEFAULT_PARAM_REFERENCES_LOCAL
                                }
                            );
                        }
                    }
                }

                // Reject 'this' expressions
                if (ast.isThisExpression(child)) {
                    accept('error',
                        `Default value for '${param.name}' cannot reference 'this'. Default expressions are evaluated at the call site.`,
                        {
                            node: child,
                            code: ErrorCode.TC_DEFAULT_PARAM_REFERENCES_LOCAL
                        }
                    );
                }
            }
        }
    }

}
