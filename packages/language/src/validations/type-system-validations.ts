import { AstNode, AstUtils, ValidationAcceptor, ValidationChecks } from "langium";
import { ErrorCode } from "../codes/errors.js";
import { WarningCode } from "../codes/warnings.js";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import {
    FunctionTypeDescription,
    GenericTypeDescription,
    isArrayType,
    isClassType,
    isCoroutineType,
    isEnumType,
    isErrorType,
    isFloatType,
    isFunctionType,
    isGenericType,
    isImplementationType,
    isIntegerType,
    isInterfaceType,
    isJoinType,
    isMetaClassType,
    isNeverType,
    isNullableType,
    isReferenceType,
    isStructType,
    isTupleType,
    isUnionType,
    isVariantConstructorType,
    isVariantType,
    getMinArity,
    MethodType,
    TypeDescription,
    TypeKind
} from "../typing/type-c-types.js";
import * as valUtils from "./tc-valdiation-helper.js";
import { isBinaryOpValid, isUnaryOpValid } from "../typing/operator-utils.js";
import { TypeCTypedValidation } from "./typed-base-validation.js";

/**
 * Type system validator for Type-C.
 *
 * Performs type checking to ensure:
 * - Variable declarations match their initializers
 * - Function arguments match parameter types
 * - Return statements match function return types
 * - Binary operations have compatible operand types
 */
export class TypeCTypeSystemValidator extends TypeCTypedValidation {
    constructor(services: TypeCServices) {
        super(services);
    }

    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            BinaryExpression: [this.checkBinaryExpression, this.checkNullishCoalescing, this.checkExpressionForErrors],
            FunctionCall: [this.checkFunctionCall, this.checkMutatingMethodOnConst, this.checkOptionalChainingBasicType, this.checkExpressionForErrors],
            ReturnStatement: this.checkReturnStatement,
            YieldExpression: this.checkYieldExpression,
            LambdaExpression: this.checkLambdaExpression,
            IndexSet: [this.checkIndexSet, this.checkIndexAccessMultipleIndices],
            ReverseIndexSet: this.checkReverseIndexSet,
            DenullExpression: [this.checkDenullExpression, this.checkExpressionForErrors],
            NamedStructConstructionExpression: [this.checkStructSpreadFieldTypes, this.checkExpressionForErrors],
            NewExpression: [this.checkNewExpression, this.checkExpressionForErrors],
            UnaryExpression: [this.checkExpressionForErrors],
            IndexAccess: [this.checkOptionalChainingBasicType, this.checkExpressionForErrors, this.checkIndexAccessMultipleIndices],
            ReverseIndexAccess: [this.checkOptionalChainingBasicType, this.checkExpressionForErrors],
            PostfixOp: [this.checkOptionalChainingBasicType, this.checkExpressionForErrors],
            ConditionalExpression: this.checkExpressionForErrors,
            MatchExpression: this.checkExpressionForErrors,
            LetInExpression: this.checkExpressionForErrors,
            DoExpression: this.checkExpressionForErrors,
            TypeCastExpression: [this.checkTypeCastExpression, this.checkOptionalChainingBasicType, this.checkExpressionForErrors],
            ArrayConstructionExpression: this.checkExpressionForErrors,
            ArraySpreadExpression: this.checkArraySpreadExpression,
            AnonymousStructConstructionExpression: this.checkExpressionForErrors,
            TupleExpression: this.checkExpressionForErrors,
            ThrowExpression: this.checkExpressionForErrors,
            CoroutineExpression: this.checkExpressionForErrors,
            InstanceCheckExpression: [this.checkInstanceCheckExpression, this.checkExpressionForErrors],
            ThisExpression: this.checkExpressionForErrors,
            MatchCasePattern: this.checkPatternErrors,
            ObjectUpdate: [this.checkObjectUpdateFields, this.checkOptionalChainingBasicType],
            SelfType: this.checkSelfTypeContext,
            StructPrototypeDeclaration: this.checkStructPrototypeDeclaration,
        };
    }

    /**
     * Check binary expressions for type compatibility.
     *
     * Examples:
     * - 1 + 2           // ✅ OK (i32 + i32)
     * - 1 + 2.0         // ✅ OK (i32 + f64, promotes to f64)
     * - "hello" + "world" // ✅ OK (string concatenation)
     * - "Count: " + 42    // ✅ OK (string + int, converts to string)
     * - 1.3 + 1          // ✅ OK (f64 + i32, promotes to f64)
     */
    checkBinaryExpression = (node: ast.BinaryExpression, accept: ValidationAcceptor): void => {
        let leftType = this.typeProvider.getType(node.left);
        let rightType = this.typeProvider.getType(node.right);

        // Save the original (pre-resolution) reference for struct prototype lookup BEFORE
        // resolveIfReference strips the alias identity and generic args.
        const leftOriginalRef = leftType;
        const leftOriginalDecl = isReferenceType(leftType) && ast.isTypeDeclaration(leftType.declaration)
            ? leftType.declaration
            : undefined;

        // Resolve references to check for class types
        leftType = this.typeUtils.resolveIfReference(leftType);
        rightType = this.typeUtils.resolveIfReference(rightType);

        // Check nullish coalescing operator for nullable basic types
        // The ?? operator should not be used with nullable basic types
        // Example: test(1) ?? 1 where test returns T? and T=i32 → Error
        if (node.op === '??') {
            if (isNullableType(leftType) && this.typeUtils.isTypeBasic(leftType.baseType)) {
                accept('error',
                    `Nullish coalescing operator '??' cannot be used with nullable basic type '${leftType.toString()}'. ` +
                    `Basic types cannot be nullable. The expression '${node.left.$cstNode?.text || 'expression'}' ` +
                    `should not produce a nullable basic type.`,
                    {
                        node: node.left,
                        code: ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE
                    }
                );
                return;
            }
        }

        // Rebind operator: ':=' can only target const variables
        if (node.op === ':=') {
            const rebindError = this.checkRebindTarget(node.left);
            if (rebindError) {
                accept('error', rebindError.message, {
                    node: node.left,
                    code: rebindError.code
                });
                return;
            }
            // Type compatibility (same as regular assignment)
            const compatResult = this.isTypeCompatible(rightType, leftType);
            if (!compatResult.success) {
                const errorMsg = compatResult.message
                    ? `Rebind error: ${compatResult.message}`
                    : `Cannot rebind to type '${rightType.toString()}', expected '${leftType.toString()}'`;
                accept('error', errorMsg, {
                    node: node.right,
                    code: ErrorCode.TC_ASSIGNMENT_TYPE_MISMATCH
                });
            }
            return;
        }

        // Assignment operators: right must be compatible with left
        const assignmentOps = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='];
        if (assignmentOps.includes(node.op)) {
            // Validate that the left side is a valid lvalue
            const lvalueError = this.checkLvalue(node.left);
            if (lvalueError) {
                accept('error', lvalueError.message, {
                    node: node.left,
                    code: lvalueError.code
                });
                return;
            }

            // For compound assignments (+=, -=, etc.), check if LHS class/interface implements the operator
            if (node.op !== '=') {
                const underlyingOp = node.op.substring(0, node.op.length - 1);
                let operatorMethods: MethodType[] = [];

                if (isClassType(leftType)) {
                    const allCompoundMethods: MethodType[] = [...leftType.methods];
                    for (const implRef of leftType.implementations) {
                        const resolvedImpl = this.typeUtils.resolveIfReference(implRef);
                        if (isImplementationType(resolvedImpl)) {
                            allCompoundMethods.push(...resolvedImpl.methods);
                        }
                    }
                    operatorMethods = allCompoundMethods.filter(m => m.names.includes(underlyingOp));
                } else {
                    const leftIface = this.typeUtils.asInterfaceType(leftType);
                    if (leftIface) {
                        operatorMethods = leftIface.methods.filter(m => m.names.includes(underlyingOp));
                    }
                }

                if (isClassType(leftType) || this.typeUtils.asInterfaceType(leftType)) {
                    if (operatorMethods.length === 0) {
                        const errorCode = ErrorCode.TC_BINARY_OP_INCOMPATIBLE_TYPES;
                        accept('error',
                            `Compound assignment '${node.op}' error: '${leftType.toString()}' does not implement operator '${underlyingOp}'`,
                            {
                                node,
                                code: errorCode
                            }
                        );
                        return;
                    }

                    const hasMatchingOverload = operatorMethods.some(method => {
                        if (method.parameters.length !== 1) {
                            return false;
                        }
                        const paramType = method.parameters[0].type;
                        return this.isTypeCompatible(rightType, paramType).success;
                    });

                    if (!hasMatchingOverload) {
                        const errorCode = ErrorCode.TC_BINARY_OP_INCOMPATIBLE_TYPES;
                        const availableOverloads = operatorMethods
                            .map(m => `${underlyingOp}(${m.parameters.map(p => p.type.toString()).join(', ')})`)
                            .join(' or ');
                        accept('error',
                            `Compound assignment '${node.op}' error: '${leftType.toString()}' has operator '${underlyingOp}', but none match the right operand type '${rightType.toString()}'. Available: ${availableOverloads}`,
                            {
                                node,
                                code: errorCode
                            }
                        );
                        return;
                    }

                    const matchingMethod = operatorMethods.find(method => {
                        if (method.parameters.length !== 1) return false;
                        return this.isTypeCompatible(rightType, method.parameters[0].type).success;
                    });

                    if (matchingMethod) {
                        const resultType = matchingMethod.returnType;
                        const assignableResult = this.isTypeCompatible(resultType, leftType);
                        if (!assignableResult.success) {
                            const errorCode = ErrorCode.TC_ASSIGNMENT_TYPE_MISMATCH;
                            const errorMsg = assignableResult.message
                                ? `Compound assignment '${node.op}' error: ${assignableResult.message}`
                                : `Compound assignment '${node.op}' error: Operator '${underlyingOp}' returns '${resultType.toString()}', which is not assignable to '${leftType.toString()}'`;
                            accept('error', errorMsg, {
                                node,
                                code: errorCode
                            });
                        }
                    }

                    return;
                }
            }
            
            // Standard assignment validation for non-class types or plain '='
            const compatResult = this.isTypeCompatible(rightType, leftType);
            if (!compatResult.success) {
                const errorCode = ErrorCode.TC_ASSIGNMENT_TYPE_MISMATCH;
                const errorMsg = compatResult.message
                    ? `Assignment error: ${compatResult.message}`
                    : `Cannot assign type '${rightType.toString()}' to type '${leftType.toString()}'`;
                accept('error', errorMsg, {
                    node: node.right,
                    code: errorCode
                });
            }
            return;
        }

        // Check if LEFT operand is a class/interface with operator overload
        // Operator overloading is left-associative: only LHS defines the operator
        // Note: Assignment operators are handled above, so we only deal with arithmetic/comparison here
        // Example: Vector + Vector → check if Vector has fn +(Vector)
        // Example: Vector + u32 → check if Vector has fn +(u32)
        // Example: Vector + string → error if no fn +(string) defined
        if (isClassType(leftType)) {
            // Find all methods with this operator name (including from impls)
            const allMethods: MethodType[] = [...leftType.methods];
            for (const implRef of leftType.implementations) {
                const resolvedImpl = this.typeUtils.resolveIfReference(implRef);
                if (isImplementationType(resolvedImpl)) {
                    allMethods.push(...resolvedImpl.methods);
                }
            }
            const operatorMethods = allMethods.filter(m => m.names.includes(node.op));
            
            if (operatorMethods.length > 0) {
                // Validate that there's a matching overload for the RHS type
                const hasMatchingOverload = operatorMethods.some(method => {
                    if (method.parameters.length !== 1) {
                        return false;
                    }
                    const paramType = method.parameters[0].type;
                    const compatResult = this.isTypeCompatible(rightType, paramType);
                    return compatResult.success;
                });
                
                if (!hasMatchingOverload) {
                    const errorCode = ErrorCode.TC_BINARY_OP_INCOMPATIBLE_TYPES;
                    const availableOverloads = operatorMethods
                        .map(m => `${node.op}(${m.parameters.map(p => p.type.toString()).join(', ')})`)
                        .join(' or ');
                    accept('error',
                        `Binary operator '${node.op}' error: Class '${leftType.toString()}' has operator overloads, but none match the right operand type '${rightType.toString()}'. Available: ${availableOverloads}`,
                        {
                            node,
                            code: errorCode
                        }
                    );
                }
                
                return;
            }
            else {
                const errorCode = ErrorCode.TC_BINARY_OP_INCOMPATIBLE_TYPES;
                accept('error',
                    `Binary operator '${node.op}' error: Class '${leftType.toString()}' does not implement operator '${node.op}'`,
                    {
                        node,
                        code: errorCode
                    }
                );
                return;
            }
        }

        // Check if LEFT operand is an interface with operator methods
        const leftInterface = this.typeUtils.asInterfaceType(leftType);
        if (leftInterface) {
            const operatorMethods = leftInterface.methods.filter(m => m.names.includes(node.op));
            if (operatorMethods.length > 0) {
                const hasMatchingOverload = operatorMethods.some(method => {
                    if (method.parameters.length !== 1) {
                        return false;
                    }
                    const paramType = method.parameters[0].type;
                    return this.isTypeCompatible(rightType, paramType).success;
                });

                if (!hasMatchingOverload) {
                    const errorCode = ErrorCode.TC_BINARY_OP_INCOMPATIBLE_TYPES;
                    const availableOverloads = operatorMethods
                        .map(m => `${node.op}(${m.parameters.map(p => p.type.toString()).join(', ')})`)
                        .join(' or ');
                    accept('error',
                        `Binary operator '${node.op}' error: Interface '${leftType.toString()}' has operator overloads, but none match the right operand type '${rightType.toString()}'. Available: ${availableOverloads}`,
                        {
                            node,
                            code: errorCode
                        }
                    );
                }
                return;
            }
        }
        
        // Check if LEFT operand is a struct type with a prototype that defines this operator.
        // Use leftOriginalDecl (captured before resolveIfReference) so prototype lookup
        // respects alias identity: `prototype Z` is only found for `z: Z`, not `v: Vec2`.
        const deepLeftType = this.typeUtils.resolveDeepIfReference(leftType);
        const deepRightType = this.typeUtils.resolveDeepIfReference(rightType);
        if (isStructType(deepLeftType) && leftOriginalDecl) {
            const proto = this.typeProvider.getStructPrototypeMethods(leftOriginalDecl);
            if (proto) {
                const operatorMethods = proto.methods.filter(m => m.names.includes(node.op));
                if (operatorMethods.length > 0) {
                    // Build generic substitutions from the original reference type
                    // e.g., GVec<f32> → {T: f32} so that +(GVec<T>) becomes +(GVec<f32>)
                    let structGenSubs: Map<string, TypeDescription> | undefined;
                    if (isReferenceType(leftOriginalRef) && leftOriginalRef.genericArgs.length > 0 &&
                        leftOriginalDecl.genericParameters?.length) {
                        structGenSubs = new Map();
                        const refArgs = leftOriginalRef.genericArgs;
                        leftOriginalDecl.genericParameters.forEach((param, i) => {
                            if (i < refArgs.length) {
                                structGenSubs!.set(param.name, refArgs[i]);
                            }
                        });
                    }

                    const hasMatchingOverload = operatorMethods.some(method => {
                        if (method.parameters.length !== 1) return false;
                        let paramType = method.parameters[0].type;
                        if (structGenSubs && structGenSubs.size > 0) {
                            paramType = this.typeUtils.substituteGenerics(paramType, structGenSubs);
                        }
                        return this.isTypeCompatible(deepRightType, paramType).success;
                    });
                    if (!hasMatchingOverload) {
                        const errorCode = ErrorCode.TC_BINARY_OP_INCOMPATIBLE_TYPES;
                        const availableOverloads = operatorMethods
                            .map(m => {
                                let params = m.parameters.map(p => {
                                    let pt = p.type;
                                    if (structGenSubs && structGenSubs.size > 0) {
                                        pt = this.typeUtils.substituteGenerics(pt, structGenSubs);
                                    }
                                    return pt.toString();
                                }).join(', ');
                                return `${node.op}(${params})`;
                            })
                            .join(' or ');
                        accept('error',
                            `Binary operator '${node.op}' error: Struct prototype has operator overloads, but none match the right operand type '${rightType.toString()}'. Available: ${availableOverloads}`,
                            { node, code: errorCode }
                        );
                    }
                    return;
                }
            }
        }

        // Check if EITHER operand is a generic type with a constraint that defines this operator
        // This allows both T + T and T + Constraint and Constraint + T patterns
        // Note: We also look up the constraint from the AST declaration as a fallback,
        // because the cached GenericType may have constraint=undefined due to cycle detection
        // during recursive type inference of self-referential constraints like T: interface { fn +(T) -> T }
        if (isGenericType(leftType)) {
            const constraint = leftType.constraint
                ?? (leftType.declaration?.constraint ? this.typeProvider.getType(leftType.declaration.constraint) : undefined);
            if (constraint && this.constraintDefinesOperator(constraint, node.op)) {
                return;
            }
        }

        if (isGenericType(rightType)) {
            const constraint = rightType.constraint
                ?? (rightType.declaration?.constraint ? this.typeProvider.getType(rightType.declaration.constraint) : undefined);
            if (constraint && this.constraintDefinesOperator(constraint, node.op)) {
                return;
            }
        }

        // Check for operator constraints declared with || syntax on the enclosing generic declaration
        if (isGenericType(leftType) || isGenericType(rightType)) {
            if (this.hasMatchingOperatorConstraint(node.op, leftType, rightType, node)) {
                return;
            }
        }

        // Skip validation if either side is an error type (already reported or placeholder)
        if (leftType.kind === TypeKind.Error || rightType.kind === TypeKind.Error) {
            return;
        }

        // Special handling for + operator (supports strings and numeric types)
        if (node.op === '+') {
            const leftIsString = leftType.kind === TypeKind.String;
            const rightIsString = rightType.kind === TypeKind.String;

            // String concatenation: string + anything
            if (leftIsString || rightIsString) {
                // Skip validation if either operand is a generic type
                // Generic types will be validated when instantiated with concrete types
                if (isGenericType(leftType) || isGenericType(rightType)) {
                    return;
                }

                const convertibleTypes = [
                    TypeKind.String, TypeKind.Bool,
                    TypeKind.U8, TypeKind.U16, TypeKind.U32, TypeKind.U64,
                    TypeKind.I8, TypeKind.I16, TypeKind.I32, TypeKind.I64,
                    TypeKind.F32, TypeKind.F64, TypeKind.Enum
                ];

                if (!convertibleTypes.includes(leftType.kind) || !convertibleTypes.includes(rightType.kind)) {
                    const errorCode = ErrorCode.TC_CONCATENATION_ERROR;
                    accept('error', `String concatenation error: Cannot concatenate incompatible types '${leftType.toString()}' and '${rightType.toString()}'. Types must be convertible to string.`, {
                        node,
                        code: errorCode
                    });
                }
                return;
            }

            // Numeric addition: allow mixed integer/float
            if (valUtils.isNumericType(leftType) && valUtils.isNumericType(rightType)) {
                // Allow any numeric combination (int+float, float+int, etc.)
                return;
            }

            const errorCode = ErrorCode.TC_BINARY_OP_INCOMPATIBLE_TYPES;
            accept('error', `Binary operator '+' error: Requires numeric or string operands, but got '${leftType.toString()}' and '${rightType.toString()}'`, {
                node,
                code: errorCode
            });
            return;
        }

        // Arithmetic operators (excluding +): both sides must be numeric, allow mixed int/float
        const arithmeticOps = ['-', '*', '/', '%', '<<', '>>', '&', '|', '^'];
        if (arithmeticOps.includes(node.op)) {
            const leftIsNumeric = valUtils.isNumericType(leftType);
            const rightIsNumeric = valUtils.isNumericType(rightType);

            if (!leftIsNumeric || !rightIsNumeric) {
                const errorCode = ErrorCode.TC_NUMERIC_OP_REQUIRES_NUMERIC;
                accept('error', `Arithmetic operator '${node.op}' error: Requires numeric operands, but got '${leftType.toString()}' and '${rightType.toString()}'`, {
                    node,
                    code: errorCode
                });
                return;
            }

            // For bitwise operators, warn if using floats
            const bitwiseOps = ['<<', '>>', '&', '|', '^', '%'];
            if (bitwiseOps.includes(node.op)) {
                const leftIsFloat = leftType.kind === TypeKind.F32 || leftType.kind === TypeKind.F64;
                const rightIsFloat = rightType.kind === TypeKind.F32 || rightType.kind === TypeKind.F64;

                if (leftIsFloat || rightIsFloat) {
                    accept('warning', `Bitwise operator '${node.op}' used with floating-point type`, {
                        node,
                    });
                }
            }

            // Allow mixed numeric types (e.g., 1.3 + 1)
            return;
        }

        // Comparison operators: operands must be compatible
        const comparisonOps = ['==', '!=', '<', '>', '<=', '>='];
        if (comparisonOps.includes(node.op)) {
            // Allow comparison between any numeric types
            if (valUtils.isNumericType(leftType) && valUtils.isNumericType(rightType)) {
                return;
            }

            // Otherwise, require exact type compatibility
            const rightToLeft = this.isTypeCompatible(rightType, leftType);
            const leftToRight = this.isTypeCompatible(leftType, rightType);
            if (!rightToLeft.success && !leftToRight.success) {
                const errorCode = ErrorCode.TC_COMPARISON_INCOMPATIBLE_TYPES;
                accept('warning', `Comparison warning: Comparing potentially incompatible types '${leftType.toString()}' and '${rightType.toString()}'. This may not behave as expected.`, {
                    node,
                    code: errorCode
                });
            }
        }
    }

    /**
     * Check function call arguments against parameter types.
     *
     * Note: Skip validation for variant constructor calls, as they perform
     * generic inference from arguments. The type provider handles this correctly.
     */
    checkFunctionCall = (node: ast.FunctionCall, accept: ValidationAcceptor): void => {
        let fnType = this.typeProvider.getType(node.expr);

        // Resolve reference types first
        fnType = this.typeUtils.resolveIfReference(fnType);

        // Only unwrap nullable function types if they come from optional chaining
        // Check if ANY part of the expression chain uses optional chaining (?.)
        if (isNullableType(fnType)) {
            const isFromOptionalChaining = this.hasOptionalChaining(node.expr);
            
            if (isFromOptionalChaining) {
                // Unwrap for validation - arguments still need to be checked
                fnType = fnType.baseType;
            }
            // Otherwise, leave as nullable and validation will continue below
        }

        // Handle coroutine instance calls
        if (isCoroutineType(fnType)) {
            const coroutineType = fnType;
            const args = node.args || [];
            
            // Check argument count (accounts for default parameters)
            const coroMinArity = getMinArity(coroutineType.parameters);
            const coroMaxArity = coroutineType.parameters.length;
            if (args.length < coroMinArity || args.length > coroMaxArity) {
                const errorCode = ErrorCode.TC_COROUTINE_CALL_ARG_COUNT_MISMATCH;
                const expected = coroMinArity === coroMaxArity
                    ? `${coroMinArity}`
                    : `${coroMinArity} to ${coroMaxArity}`;
                accept('error', `Coroutine call argument count mismatch: Expected ${expected} argument(s), but got ${args.length}`, {
                    node,
                    code: errorCode
                });
                return;
            }
            
            // Check each argument type
            args.forEach((arg, index) => {
                const expectedType = coroutineType.parameters[index].type;
                const actualType = this.typeProvider.getType(arg);
                
                const compatResult = this.isTypeCompatible(actualType, expectedType);
                if (!compatResult.success) {
                    const errorCode = ErrorCode.TC_COROUTINE_CALL_ARG_TYPE_MISMATCH;
                    const errorMsg = compatResult.message
                        ? `Coroutine call argument ${index + 1} type mismatch: ${compatResult.message}`
                        : `Coroutine call argument ${index + 1} type mismatch: Expected '${expectedType.toString()}', but got '${actualType.toString()}'`;
                    accept('error', errorMsg, {
                        node: arg,
                        code: errorCode
                    });
                }
            });
            return;
        }

        if (!isFunctionType(fnType)) {
            // Not a function or coroutine - let another validation handle this
            return;
        }

        // Validate variant constructor calls
        // Note: Variants do not support overload - each constructor name is unique
        if (isVariantConstructorType(fnType.returnType)) {
            this.checkVariantConstructorCall(node, fnType, accept);
            return;
        }

        let paramTypes = fnType.parameters;
        const args = node.args || [];
        const genericParams = fnType.genericParameters || [];
        let substitutions: Map<string, TypeDescription> | undefined;

        // Handle explicit generic type arguments
        if (node.genericArgs && node.genericArgs.length > 0) {
            // Check generic argument count
            if (node.genericArgs.length !== genericParams.length) {
                const errorCode = ErrorCode.TC_FUNCTION_GENERIC_ARG_COUNT_MISMATCH;
                accept('error', `Generic type argument count mismatch: Expected ${genericParams.length} type argument(s), but got ${node.genericArgs.length}`, {
                    node,
                    code: errorCode
                });
                return;
            }

            // Build substitution map: generic parameter name -> concrete type
            substitutions = new Map<string, TypeDescription>();
            genericParams.forEach((param, index) => {
                const concreteType = this.typeProvider.getType(node.genericArgs[index]);
                substitutions!.set(param.name, concreteType);
            });
        }
        // Attempt automatic generic inference if no explicit type arguments provided
        else if (genericParams.length > 0) {
            // Get concrete types of all arguments
            const argumentTypes = args.map(arg => this.typeProvider.getType(arg));

            // Get parameter types (which may contain generic references)
            const parameterTypes = fnType.parameters.map(p => p.type);

            // Infer generics from the arguments
            const genericParamNames = genericParams.map(p => p.name);
            substitutions = this.typeProvider.inferGenericsFromArguments(
                genericParamNames,
                parameterTypes,
                argumentTypes
            );
        }

        // Apply substitutions to parameter types if we have any
        if (substitutions && substitutions.size > 0) {
            const finalSubstitutions = substitutions;
            paramTypes = paramTypes.map(param => ({
                name: param.name,
                type: this.typeUtils.substituteGenerics(param.type, finalSubstitutions),
                isMut: param.isMut,
                hasDefault: param.hasDefault
            }));

            // Fast path: substitutions already built — validate constraints directly
            this.validateOperatorConstraintsAtCallSite(node, finalSubstitutions, accept);
        } else if (ast.isQualifiedReference(node.expr) && (node.expr.genericArgs?.length ?? 0) > 0) {
            // Only invoke fallback when explicit generic args exist but substitutions weren't built
            // (because the type provider already specialized the function type).
            this.validateOperatorConstraintsAtCallSite(node, undefined, accept);
        }

        // Check argument count (accounts for default parameters)
        const fnMinArity = getMinArity(paramTypes);
        const fnMaxArity = paramTypes.length;
        if (args.length < fnMinArity || args.length > fnMaxArity) {
            const errorCode = ErrorCode.TC_FUNCTION_CALL_ARG_COUNT_MISMATCH;
            const expected = fnMinArity === fnMaxArity
                ? `${fnMinArity}`
                : `${fnMinArity} to ${fnMaxArity}`;
            accept('error', `Function call argument count mismatch: Expected ${expected} argument(s), but got ${args.length}`, {
                node,
                code: errorCode
            });
            return;
        }

        // Check each argument type (only for provided args)
        args.forEach((arg, index) => {
            const expectedType = paramTypes[index].type;
            const actualType = this.typeProvider.getType(arg);

            const compatResult = this.isTypeCompatible(actualType, expectedType);
            if (!compatResult.success) {
                const errorCode = ErrorCode.TC_FUNCTION_CALL_ARG_TYPE_MISMATCH;
                const errorMsg = compatResult.message
                    ? `Function call argument ${index + 1} type mismatch: ${compatResult.message}`
                    : `Function call argument ${index + 1} type mismatch: Expected '${expectedType.toString()}', but got '${actualType.toString()}'`;
                accept('error', errorMsg, {
                    node: arg,
                    code: errorCode
                });
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
     * 
     * Examples:
     * - Option.Some(42u32) → OK
     * - Option.Some<u32>(42u32) → OK (explicit generic)
     * - Option.Some(42u32, 1) → ERROR (wrong arg count)
     * - Option.Some<string>(42u32) → ERROR (explicit generic doesn't match arg type)
     */
    private checkVariantConstructorCall = (node: ast.FunctionCall, fnType: FunctionTypeDescription, accept: ValidationAcceptor): void => {
        const constructorType = fnType.returnType;
        if (!isVariantConstructorType(constructorType)) {
            return; // Should not happen
        }

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
                const errorCode = ErrorCode.TC_VARIANT_CONSTRUCTOR_GENERIC_ARG_COUNT_MISMATCH;
                accept('error', `Variant constructor '${constructorType.constructorName}' does not take generic arguments`, {
                    node,
                    code: errorCode
                });
                return;
            }

            const expectedGenericCount = variantDecl.genericParameters.length;
            const providedGenericCount = node.genericArgs.length;

            if (providedGenericCount !== expectedGenericCount) {
                const errorCode = ErrorCode.TC_VARIANT_CONSTRUCTOR_GENERIC_ARG_COUNT_MISMATCH;
                accept('error', `Variant constructor '${constructorType.constructorName}' expects ${expectedGenericCount} generic argument(s), but got ${providedGenericCount}`, {
                    node,
                    code: errorCode
                });
                return;
            }

            // Build substitution map from explicit generic arguments
            const substitutions = new Map<string, TypeDescription>();
            variantDecl.genericParameters.forEach((param, i) => {
                const concreteType = this.typeProvider.getType(node.genericArgs[i]);
                substitutions.set(param.name, concreteType);
            });

            // Step 2: Validate explicit generic types against argument types
            // Apply substitutions to constructor parameters
            const substitutedParams = constructorParams.map(p => 
                this.typeUtils.substituteGenerics(p.type, substitutions)
            );

            // Check argument count
            if (args.length !== substitutedParams.length) {  // Variant constructors don't support defaults, so exact match
                const errorCode = ErrorCode.TC_VARIANT_CONSTRUCTOR_ARG_COUNT_MISMATCH;
                accept('error', `Variant constructor '${constructorType.constructorName}' expects ${substitutedParams.length} argument(s), but got ${args.length}`, {
                    node,
                    code: errorCode
                });
                return;
            }

            // Check each argument type against substituted parameter type
            args.forEach((arg, index) => {
                const expectedType = substitutedParams[index];
                const actualType = this.typeProvider.getType(arg);

                const compatResult = this.isTypeCompatible(actualType, expectedType);
                if (!compatResult.success) {
                    const errorCode = ErrorCode.TC_VARIANT_CONSTRUCTOR_ARG_TYPE_MISMATCH;
                    const errorMsg = compatResult.message
                        ? `Variant constructor '${constructorType.constructorName}' argument ${index + 1} type mismatch: ${compatResult.message}`
                        : `Variant constructor '${constructorType.constructorName}' argument ${index + 1} type mismatch: Expected '${expectedType.toString()}', but got '${actualType.toString()}'`;
                    accept('error', errorMsg, {
                        node: arg,
                        code: errorCode
                    });
                }
            });

            // Additionally, verify that the explicit generics are consistent with inferred types
            // This catches cases like Option.Some<string>(200u32) where the explicit generic doesn't match
            const inferredGenerics = this.typeProvider.inferGenericsFromArguments(
                variantDecl.genericParameters.map(p => p.name),
                constructorParams.map(p => p.type),
                args.map(arg => this.typeProvider.getType(arg))
            );

            // Compare explicit generics with inferred generics
            variantDecl.genericParameters.forEach((param, i) => {
                const explicitType = this.typeProvider.getType(node.genericArgs[i]);
                const inferredType = inferredGenerics.get(param.name);

                // Skip if inferred type is never (couldn't be inferred)
                if (inferredType && inferredType.kind !== TypeKind.Never) {
                    const compatResult = this.typeUtils.areTypesEqual(explicitType, inferredType);
                    if (!compatResult.success) {
                        const errorCode = ErrorCode.TC_VARIANT_CONSTRUCTOR_GENERIC_ARG_TYPE_MISMATCH;
                        accept('error', `Variant constructor '${constructorType.constructorName}' generic argument '${param.name}' mismatch: Explicitly specified as '${explicitType.toString()}', but inferred as '${inferredType.toString()}' from arguments`, {
                            node: node.genericArgs[i],
                            code: errorCode
                        });
                    }
                }
            });

            return;
        }

        // Step 3: No explicit generics - just validate argument count and types
        // The type provider will infer generics from arguments

        // Check argument count
        if (args.length !== constructorParams.length) {
            const errorCode = ErrorCode.TC_VARIANT_CONSTRUCTOR_ARG_COUNT_MISMATCH;
            accept('error', `Variant constructor '${constructorType.constructorName}' expects ${constructorParams.length} argument(s), but got ${args.length}`, {
                node,
                code: errorCode
            });
            return;
        }

        // Check each argument type
        // Note: We use the original parameter types here (with generic placeholders like T)
        // because the type provider will perform generic inference during type inference
        args.forEach((arg, index) => {
            const expectedType = constructorParams[index].type;
            const actualType = this.typeProvider.getType(arg);

            // For generic parameters, we can't validate directly - skip validation
            // The type system will handle generic inference
            if (isGenericType(expectedType)) {
                return;
            }

            const compatResult = this.isTypeCompatible(actualType, expectedType);
            if (!compatResult.success) {
                const errorCode = ErrorCode.TC_VARIANT_CONSTRUCTOR_ARG_TYPE_MISMATCH;
                const errorMsg = compatResult.message
                    ? `Variant constructor '${constructorType.constructorName}' argument ${index + 1} type mismatch: ${compatResult.message}`
                    : `Variant constructor '${constructorType.constructorName}' argument ${index + 1} type mismatch: Expected '${expectedType.toString()}', but got '${actualType.toString()}'`;
                accept('error', errorMsg, {
                    node: arg,
                    code: errorCode
                });
            }
        });
    }


    /**
     * Check return statements against function return type.
     *
     * IMPORTANT: Return statements inside do expressions should NOT be validated
     * against the function's return type. They return values from the do expression itself.
     */
    checkReturnStatement = (node: ast.ReturnStatement, accept: ValidationAcceptor): void => {
        // Check if we're in a do expression first (before checking functions)
        // Do expressions have their own return semantics - returns exit the do block, not the function
        const doExpr = valUtils.getContainingDoExpression(node);
        if (doExpr) {
            // We're inside a do expression - the return statement returns from the do block,
            // not from the function. The do expression's type will be inferred from all its
            // return statements, and that inferred type will be validated at the usage site.
            // Therefore, we don't validate individual return statements here.
            return;
        }
        
        // Find the containing function or lambda
        let current: AstNode | undefined = node.$container;
        while (current && !ast.isFunctionDeclaration(current) && !ast.isLambdaExpression(current)) {
            current = current.$container;
        }

        if (!current) {
            return; // Not in a function or lambda
        }

        // Get fnType from either FunctionDeclaration or LambdaExpression
        const fnType = ast.isFunctionDeclaration(current) ? current.fnType :
                       ast.isLambdaExpression(current) ? current.fnType : undefined;

        if (!fnType) {
            return; // Shouldn't happen
        }

        // Check if this is a coroutine - return statements not allowed in coroutines
        if (fnType === 'cfn') {
            const errorCode = ErrorCode.TC_RETURN_IN_COROUTINE;
            accept('error', `Return statement in coroutine: Coroutines must use 'yield' instead of 'return' to produce values`, {
                node,
                code: errorCode
            });
            return;
        }

        // Get header from either FunctionDeclaration or LambdaExpression
        const header = ast.isFunctionDeclaration(current) ? current.header :
                       ast.isLambdaExpression(current) ? current.header : undefined;

        if (!header || !header.returnType) {
            return; // No explicit return type
        }

        const expectedReturnType = this.typeProvider.getType(header.returnType);

        if (node.expr) {
            const actualType = this.typeProvider.getType(node.expr);
            const compatResult = this.isTypeCompatible(actualType, expectedReturnType);
            if (!compatResult.success) {
                const errorCode = ErrorCode.TC_RETURN_TYPE_MISMATCH;
                const errorMsg = compatResult.message
                    ? `Return type mismatch: ${compatResult.message}`
                    : `Return type mismatch: Expected '${expectedReturnType.toString()}', but got '${actualType.toString()}'`;
                accept('error', errorMsg, {
                    node: node.expr,
                    code: errorCode
                });
            }
        } else {
            // Return with no value
            if (expectedReturnType.kind !== TypeKind.Void) {
                const errorCode = ErrorCode.TC_RETURN_MISSING_VALUE;
                accept('error', `Missing return value: Function declared to return '${expectedReturnType.toString()}', but return statement has no value`, {
                    node,
                    code: errorCode
                });
            }
        }
    }

    /**
     * Check yield expressions against coroutine yield type.
     */
    checkYieldExpression = (node: ast.YieldExpression, accept: ValidationAcceptor): void => {
        // Find the containing function or lambda
        let current: AstNode | undefined = node.$container;
        while (current && !ast.isFunctionDeclaration(current) && !ast.isLambdaExpression(current)) {
            current = current.$container;
        }

        if (!current) {
            const errorCode = ErrorCode.TC_YIELD_OUTSIDE_COROUTINE;
            accept('error', `Yield outside coroutine: Yield expressions can only be used inside coroutine functions (cfn)`, {
                node,
                code: errorCode
            });
            return;
        }

        // Get fnType from either FunctionDeclaration or LambdaExpression
        const fnType = ast.isFunctionDeclaration(current) ? current.fnType :
                       ast.isLambdaExpression(current) ? current.fnType : undefined;

        if (!fnType) {
            const errorCode = ErrorCode.TC_YIELD_OUTSIDE_COROUTINE;
            accept('error', `Yield outside coroutine: Yield expressions can only be used inside coroutine functions (cfn)`, {
                node,
                code: errorCode
            });
            return;
        }

        // Check if this is a regular function - yield not allowed
        if (fnType !== 'cfn') {
            const errorCode = ErrorCode.TC_YIELD_IN_FUNCTION;
            accept('error', `Yield in regular function: Yield can only be used in coroutines (cfn). Use 'return' in regular functions instead.`, {
                node,
                code: errorCode
            });
            return;
        }

        // Get header from either FunctionDeclaration or LambdaExpression
        const header = ast.isFunctionDeclaration(current) ? current.header :
                       ast.isLambdaExpression(current) ? current.header : undefined;

        if (!header || !header.returnType) {
            return; // No explicit yield type to validate against
        }

        const expectedYieldType = this.typeProvider.getType(header.returnType);

        if (node.expr) {
            const actualType = this.typeProvider.getType(node.expr);
            const compatResult = this.isTypeCompatible(actualType, expectedYieldType);
            if (!compatResult.success) {
                const errorCode = ErrorCode.TC_YIELD_TYPE_MISMATCH;
                const errorMsg = compatResult.message
                    ? `Yield type mismatch: ${compatResult.message}`
                    : `Yield type mismatch: Expected '${expectedYieldType.toString()}', but got '${actualType.toString()}'`;
                accept('error', errorMsg, {
                    node: node.expr,
                    code: errorCode
                });
            }
        } else {
            // Yield with no value
            if (expectedYieldType.kind !== TypeKind.Void) {
                const errorCode = ErrorCode.TC_YIELD_MISSING_VALUE;
                accept('error', `Coroutine must yield a value of type '${expectedYieldType.toString()}'`, {
                    node,
                    code: errorCode
                });
            }
        }
    }

    /**
     * Check lambda expressions for return type issues.
     *
     * Validates:
     * 1. If explicit return type → ensure inferred type matches declared type
     * 2. Similar to function/method validation but for lambdas
     *
     * Examples:
     * ```
     * let f1 = fn() -> u32 = 42                    // ✅ Explicit type matches
     * let f2 = fn() -> Result<i32, never> = Result2.Oks(42)  // ❌ Error - Result2 ≠ Result
     * ```
     */
    checkLambdaExpression = (node: ast.LambdaExpression, accept: ValidationAcceptor): void => {
        // Only validate if there's an explicit return type annotation
        if (!node.header.returnType) {
            return;
        }

        const isCoroutine = node.fnType === 'cfn';
        
        // Infer the return type from the lambda body/expression
        let inferredReturnType: TypeDescription;
        
        if (node.expr) {
            // Expression-body lambda: fn() = expr
            inferredReturnType = this.typeProvider.getType(node.expr);
        } else if (node.body) {
            // Block-body lambda: fn() { ... }
            if (isCoroutine) {
                // For coroutines, infer from yield expressions
                inferredReturnType = this.inferYieldTypeFromBody(node.body);
            } else {
                // For regular functions, infer from return statements
                inferredReturnType = this.inferReturnTypeFromBody(node.body);
            }
        } else {
            // No body or expression (shouldn't happen for valid lambdas)
            return;
        }

        // Check if inferred return type is an error
        if (isErrorType(inferredReturnType)) {
            const errorType = inferredReturnType;
            const message = errorType.message || (isCoroutine ? 'Cannot infer yield type' : 'Cannot infer return type');

            // Don't report recursion placeholder errors
            if (message === '__recursion_placeholder__') {
                return;
            }

            const errorCode = isCoroutine ? ErrorCode.TC_COROUTINE_YIELD_TYPE_INFERENCE_FAILED : ErrorCode.TC_FUNCTION_RETURN_TYPE_INFERENCE_FAILED;
            accept('error', message, {
                node: node,
                code: errorCode
            });
            return;
        }

        // Validate that inferred type matches declared type
        const declaredReturnType = this.typeProvider.getType(node.header.returnType);

        const compatResult = this.isTypeCompatible(inferredReturnType, declaredReturnType);
        if (!compatResult.success) {
            const typeKind = isCoroutine ? 'yield' : 'return';
            const errorCode = isCoroutine ? ErrorCode.TC_COROUTINE_YIELD_TYPE_MISMATCH : ErrorCode.TC_FUNCTION_RETURN_TYPE_MISMATCH;
            const errorMsg = compatResult.message
                ? `Lambda ${typeKind} type mismatch: ${compatResult.message}`
                : `Lambda ${typeKind} type mismatch: Declared '${declaredReturnType.toString()}', but inferred '${inferredReturnType.toString()}'`;
            accept('error', errorMsg, {
                node: node.expr ?? node.header.returnType,
                code: errorCode
            });
        }
    }





    /**
     * Check index set operations (e.g., arr[0] = value).
     * Validates that the assigned value is compatible with the array/container element type.
     */
    checkIndexSet = (node: ast.IndexSet, accept: ValidationAcceptor): void => {
        let baseType = this.typeProvider.getType(node.expr);

        // Resolve reference types
        baseType = this.typeUtils.resolveIfReference(baseType);

        const valueType = this.typeProvider.getType(node.value);

        // For arrays: check element type compatibility
        if (isArrayType(baseType)) {
            const arrayType = baseType;
            const compatResult = this.isTypeCompatible(valueType, arrayType.elementType);
            if (!compatResult.success) {
                const errorCode = ErrorCode.TC_INDEX_SET_TYPE_MISMATCH;
                const errorMsg = compatResult.message
                    ? `Array index assignment type mismatch: ${compatResult.message}`
                    : `Array index assignment type mismatch: Cannot assign '${valueType.toString()}' to array of '${arrayType.elementType.toString()}'`;
                accept('error', errorMsg, {
                    node: node.value,
                    code: errorCode
                });
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
                    const compatResult = this.isTypeCompatible(valueType, valueParam.type);
                    if (!compatResult.success) {
                        const errorCode = ErrorCode.TC_INDEX_SET_TYPE_MISMATCH;
                        const errorMsg = compatResult.message
                            ? `Index operator assignment type mismatch: ${compatResult.message}`
                            : `Index operator assignment type mismatch: Cannot assign '${valueType.toString()}' to '${valueParam.type.toString()}'`;
                        accept('error', errorMsg, {
                            node: node.value,
                            code: errorCode
                        });
                    }
                }
            }
        }
    }

    /**
     * Check reverse index set operations (e.g., arr[-1] = value).
     */
    checkReverseIndexSet = (node: ast.ReverseIndexSet, accept: ValidationAcceptor): void => {
        let baseType = this.typeProvider.getType(node.expr);

        // Resolve reference types
        baseType = this.typeUtils.resolveIfReference(baseType);

        const valueType = this.typeProvider.getType(node.value);

        // For arrays: check element type compatibility
        if (isArrayType(baseType)) {
            const arrayType = baseType;
            const compatResult = this.isTypeCompatible(valueType, arrayType.elementType);
            if (!compatResult.success) {
                const errorCode = ErrorCode.TC_REVERSE_INDEX_SET_TYPE_MISMATCH;
                const errorMsg = compatResult.message
                    ? `Reverse array index assignment type mismatch: ${compatResult.message}`
                    : `Reverse array index assignment type mismatch: Cannot assign '${valueType.toString()}' to array of '${arrayType.elementType.toString()}'`;
                accept('error', errorMsg, {
                    node: node.value,
                    code: errorCode
                });
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
                    const compatResult = this.isTypeCompatible(valueType, valueParam.type);
                    if (!compatResult.success) {
                        const errorCode = ErrorCode.TC_REVERSE_INDEX_SET_TYPE_MISMATCH;
                        const errorMsg = compatResult.message
                            ? `Reverse index operator assignment type mismatch: ${compatResult.message}`
                            : `Reverse index operator assignment type mismatch: Cannot assign '${valueType.toString()}' to '${valueParam.type.toString()}'`;
                        accept('error', errorMsg, {
                            node: node.value,
                            code: errorCode
                        });
                    }
                }
            }
        }
    }

    /**
     * Check that basic types (arrays, strings) only use a single index.
     *
     * When accessing native/basic types like arrays or strings, only a single
     * index is allowed. Multiple indices (like x[1,2]) are not supported for
     * basic types.
     *
     * Rules:
     * 1. Array types can only be accessed with a single index
     * 2. String types can only be accessed with a single index
     * 3. Classes with overloaded [] operators may accept multiple indices
     *
     * Examples:
     * ```tc
     * let x = [1, 2, 3]
     * let a = x[0]           // ✅ OK - single index
     * let b = x[1, 2]        // ❌ Error - multiple indices on array
     *
     * let s = "hello"
     * let c = s[0]           // ✅ OK - single index
     * let d = s[1, 2]        // ❌ Error - multiple indices on string
     *
     * class Matrix {
     *     fn [](row: u32, col: u32) -> f32 { ... }
     * }
     * let m: Matrix = ...
     * let e = m[1, 2]        // ✅ OK - class overloads [] with multiple params
     * ```
     */
    checkIndexAccessMultipleIndices = (node: ast.IndexAccess | ast.IndexSet, accept: ValidationAcceptor): void => {
        // Get the base type being indexed
        let baseType = this.typeProvider.getType(node.expr);
        
        // Resolve reference types
        baseType = this.typeUtils.resolveIfReference(baseType);
        
        // Get the number of indices provided
        const indexCount = node.indexes.length;
        
        // If only one index, no validation needed
        if (indexCount <= 1) {
            return;
        }
        
        // Check if the base type is an array
        if (isArrayType(baseType)) {
            const errorCode = ErrorCode.TC_INDEX_ACCESS_MULTIPLE_INDICES_ON_BASIC;
            accept('error',
                `Array index access error: Arrays only support single index access, but ${indexCount} indices were provided. ` +
                `Use separate accesses like arr[${node.indexes[0].$cstNode?.text}][${node.indexes[1].$cstNode?.text}] for multidimensional arrays.`,
                {
                    node,
                    code: errorCode
                }
            );
            return;
        }
        
        // Check if the base type is string
        if (baseType.kind === TypeKind.String) {
            const errorCode = ErrorCode.TC_INDEX_ACCESS_MULTIPLE_INDICES_ON_BASIC;
            accept('error',
                `String index access error: Strings only support single index access, but ${indexCount} indices were provided.`,
                {
                    node,
                    code: errorCode
                }
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
                    const errorCode = ErrorCode.TC_INDEX_ACCESS_MULTIPLE_INDICES_ON_BASIC;
                    accept('error',
                        `Index operator '${operatorName}' error: Class '${baseType.toString()}' expects ${expectedIndexCount} index parameter(s), but got ${indexCount}.`,
                        {
                            node,
                            code: errorCode
                        }
                    );
                }
            } else {
                // Class doesn't define the operator - this error will be caught by other validations
                return;
            }
        }
    }


    /**
     * Check denull expression for unnecessary usage on non-nullable types.
     *
     * Rules:
     * 1. Using `!` on a non-nullable type → warning (unnecessary)
     * 2. Using `!` on a nullable type → ✅ OK
     *
     * Examples:
     * - `e!` where `e: Entity?` → ✅ OK (unwraps nullable)
     * - `e!` where `e: Entity` → ⚠️ Warning (unnecessary)
     */
    checkDenullExpression = (node: ast.DenullExpression, accept: ValidationAcceptor): void => {
        const exprType = this.typeProvider.getType(node.expr);
        
        // If the expression is not nullable, the denull operator is unnecessary
        if (!isNullableType(exprType)) {
            const errorCode = ErrorCode.TC_DENULL_ON_NON_NULLABLE;
            accept('warning',
                `Unnecessary denull operator: Type '${exprType.toString()}' is not nullable. The '!' operator has no effect here.`,
                {
                    node,
                    property: 'expr',
                    code: errorCode
                }
            );
        }
    }

    /**
     * Check nullish coalescing operator for type compatibility.
     *
     * The `??` operator requires that the base types are compatible:
     * 1. Both sides can be nullable or non-nullable independently
     * 2. The base types (unwrapped if nullable) must be compatible
     * 3. Result type is the RHS type (preserving its nullability)
     *
     * Examples:
     * - `c?.getValue() ?? 0` where `getValue()` returns `u32` → ✅ OK (u32 ?? u32 → u32)
     * - `c?.getValue() ?? getString()` where `getString()` returns `string?` → ✅ OK (u32 ?? string? → string?)
     * - `c?.getValue() ?? "default"` where `getValue()` returns `u32` → ❌ Error (u32 ?? string)
     * - `obj?.getData() ?? defaultData` where both are `Data` → ✅ OK (Data ?? Data → Data)
     * - `obj?.getData() ?? getData()` where `getData()` returns `Data?` → ✅ OK (Data ?? Data? → Data?)
     */
    checkNullishCoalescing = (node: ast.BinaryExpression, accept: ValidationAcceptor): void => {
        // Only validate nullish coalescing operator
        if (node.op !== '??') {
            return;
        }

        const leftType = this.typeProvider.getType(node.left);
        const rightType = this.typeProvider.getType(node.right);

        // Skip if either side is an error type (will be reported elsewhere)
        if (isErrorType(leftType) || isErrorType(rightType)) {
            return;
        }

        //const leftBaseType = isNullableType(leftType) ? leftType.baseType : leftType;
        //const rightBaseType = isNullableType(rightType) ? rightType.baseType : rightType;
        const leftBaseType = leftType;
        const rightBaseType = rightType;


        // Check if the base types are compatible
        // The RHS base type must be assignable to the LHS base type
        const compatResult = this.isTypeCompatible(rightBaseType, leftBaseType);
        if (!compatResult.success) {
            const errorCode = ErrorCode.TC_NULLISH_COALESCING_TYPE_MISMATCH;
            const errorMsg = compatResult.message
                ? `Nullish coalescing operator type mismatch: ${compatResult.message}`
                : `Nullish coalescing operator type mismatch: Left side has base type '${leftBaseType.toString()}', but right side has incompatible base type '${rightBaseType.toString()}'`;
            accept('error', errorMsg, {
                node: node.right,
                code: errorCode
            });
        }
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    /**
     * Check struct construction expressions for spread field type compatibility.
     *
     * When spreading an object and overriding its fields, the override must have
     * a compatible type with the original field.
     *
     * Examples:
     * ```tc
     * let p = {x: 1, y: 2}              // x: u32, y: u32
     * let z = {...p, x: 10}             // ✅ OK - x: u32 matches
     * let w = {...p, x: "hello"}        // ❌ Error - x: string doesn't match u32
     * let q = {...p, z: 3}              // ✅ OK - z is new, not overriding
     * ```
     */
    checkStructSpreadFieldTypes = (node: ast.NamedStructConstructionExpression, accept: ValidationAcceptor): void => {
        // Collect all fields from spread expressions
        const spreadFields = new Map<string, TypeDescription>();
        
        for (const field of node.fields) {
            if (ast.isStructSpreadExpression(field)) {
                // Get the type of the spread expression
                const spreadType = this.typeProvider.getType(field.expression);
                
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
                    const overrideType = this.typeProvider.getType(field.expr);
                    
                    const compatResult = this.isTypeCompatible(overrideType, spreadFieldType);
                    if (!compatResult.success) {
                        const errorCode = ErrorCode.TC_STRUCT_SPREAD_FIELD_TYPE_MISMATCH;
                        const errorMsg = compatResult.message
                            ? `Struct spread field type mismatch: Field '${fieldName}' override - ${compatResult.message}`
                            : `Struct spread field type mismatch: Field '${fieldName}' override has type '${overrideType.toString()}', but spread expects '${spreadFieldType.toString()}'`;
                        accept('error', errorMsg, {
                            node: field.expr,
                            code: errorCode
                        });
                    }
                }
            }
        }
    }

    /**
     * Check array spread expression to ensure it's spreading an array type.
     *
     * Rules:
     * 1. The expression being spread must be an array type
     * 2. Cannot spread non-array types like primitives, structs, etc.
     *
     * Examples:
     * ```tc
     * let arr: u32[] = [1, 2, 3]
     * let arr2 = [...arr, 4, 5]          // ✅ OK - spreading array
     * let x = 10
     * let bad = [...x, 1, 2]             // ❌ Error - spreading non-array
     * ```
     */
    checkArraySpreadExpression = (node: ast.ArraySpreadExpression, accept: ValidationAcceptor): void => {
        // Get the type of the expression being spread
        const spreadType = this.typeProvider.getType(node.expr);
        
        // Resolve reference types
        let resolvedType = this.typeUtils.resolveIfReference(spreadType);
        
        // Check if it's an array type
        if (!isArrayType(resolvedType)) {
            const errorCode = ErrorCode.TC_ARRAY_SPREAD_REQUIRES_ARRAY;
            accept('error',
                `Array spread requires an array type, but got '${resolvedType.toString()}'. Only arrays can be spread in array literals.`,
                {
                    node: node.expr,
                    code: errorCode
                }
            );
        }
    }

    /**
     * Check new expression for proper class instantiation.
     *
     * Rules:
     * 1. `new` can only be used with class types
     * 2. Cannot use `new` with interfaces, structs, primitives, or other types
     * 3. Generic classes must have explicit generic arguments provided
     *
     * Examples:
     * ```tc
     * class Person { let name: string }
     * let p = new Person("Alice")           // ✅ OK
     * let x = new u32()                     // ❌ Error - cannot instantiate primitive
     * let s = new {x: u32}()                // ❌ Error - cannot instantiate struct type
     * interface I { fn foo() }
     * let i = new I()                       // ❌ Error - cannot instantiate interface
     *
     * class Box<T> { let value: T }
     * let b = new Box<u32>(42)              // ✅ OK - explicit generic
     * let c = new Box(42)                   // ❌ Error - missing generic arguments
     * ```
     */
    checkNewExpression = (node: ast.NewExpression, accept: ValidationAcceptor): void => {
        // If no instance type is specified, we can't validate it here
        // The type provider will handle implicit type inference
        if (!node.instanceType) {
            return;
        }

        // Get the type that's being instantiated
        const instanceType = this.typeProvider.getType(node.instanceType);

        // Resolve reference types to get the actual type
        let resolvedType = this.typeUtils.resolveIfReference(instanceType);

        // Check if it's a class type (the only valid type for `new`)
        if (!isClassType(resolvedType) && !isMetaClassType(resolvedType)) {
            const errorCode = ErrorCode.TC_NEW_EXPRESSION_REQUIRES_CLASS;
            const typeKindName = this.getTypeKindName(resolvedType);
            accept('error',
                `Invalid use of 'new': Can only instantiate classes, but got ${typeKindName} '${resolvedType.toString()}'. Use appropriate construction syntax for this type.`,
                {
                    node: node.instanceType,
                    code: errorCode
                }
            );
            return;
        }

        // Check if the reference type requires generic arguments
        // When no explicit generics are provided, attempt inference via the type provider
        if (ast.isReferenceType(node.instanceType)) {
            const ref = node.instanceType.field?.ref;
            if (ref && ast.isTypeDeclaration(ref)) {
                const expectedGenericCount = ref.genericParameters?.length ?? 0;
                const providedGenericArgs = node.instanceType.genericArgs ?? [];
                const providedGenericCount = providedGenericArgs.length;

                if (expectedGenericCount > 0 && providedGenericCount === 0) {
                    // Ask the type provider to infer generic args from constructor arguments
                    const inferredExprType = this.typeProvider.getType(node);

                    if (isErrorType(inferredExprType)) {
                        // Inference produced an error (e.g., constraint violation)
                        accept('error', inferredExprType.toString(), {
                            node: node.instanceType,
                            code: ErrorCode.TC_NEW_EXPRESSION_REQUIRES_GENERIC_ARGS
                        });
                        return;
                    }

                    if (isReferenceType(inferredExprType) && inferredExprType.genericArgs.length > 0) {
                        // Inference succeeded — resolve with inferred generics
                        resolvedType = this.typeUtils.resolveIfReference(inferredExprType);

                        // Validate operator constraints with the inferred substitutions
                        if (ref.operatorConstraints?.length) {
                            const genericParamNames = ref.genericParameters?.map(p => p.name) ?? [];
                            const substitutions = new Map<string, TypeDescription>();
                            genericParamNames.forEach((name, i) => {
                                if (i < inferredExprType.genericArgs.length) {
                                    substitutions.set(name, inferredExprType.genericArgs[i]);
                                }
                            });
                            this.validateOperatorConstraints(
                                ref.operatorConstraints, substitutions, node, accept
                            );
                        }
                    } else {
                        // Inference couldn't determine types — report original error
                        const errorCode = ErrorCode.TC_NEW_EXPRESSION_REQUIRES_GENERIC_ARGS;
                        accept('error',
                            `Generic class '${ref.name}' requires ${expectedGenericCount} generic argument(s) in 'new' expression. Example: new ${ref.name}<T>(...)`,
                            {
                                node: node.instanceType,
                                code: errorCode
                            }
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
            const errorCode = ErrorCode.TC_FUNCTION_CALL_ARG_COUNT_MISMATCH;
            const availableSignatures = initMethods.map(m =>
                `init(${m.parameters.map(p => p.type.toString()).join(', ')})`
            ).join(' or ');
            accept('error',
                `No matching 'init' method found: Expected ${availableSignatures}, but got ${argCount} argument(s)`,
                {
                    node,
                    code: errorCode
                }
            );
            return;
        }
        
        // If we have matching methods, validate argument types
        if (matchingArityMethods.length > 0) {
            // Get actual argument types
            const argumentTypes = args.map(arg => this.typeProvider.getType(arg));
            
            // Try to find a compatible init method
            let foundMatch = false;
            for (const initMethod of matchingArityMethods) {
                let allArgsMatch = true;
                
                // IMPORTANT: The resolved class type ALREADY has generic substitutions applied!
                // When we called resolveReference(Pair<B, A>), it substituted:
                //   CLASS.A → B, CLASS.B → A
                // So the init method parameters are already substituted.
                // We should NOT substitute again!
                const paramTypes = initMethod.parameters.map(p => p.type);
                
                // Check if all arguments are compatible
                for (let i = 0; i < argumentTypes.length; i++) {
                    const compatResult = this.isTypeCompatible(argumentTypes[i], paramTypes[i]);
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
                const errorCode = ErrorCode.TC_FUNCTION_CALL_ARG_TYPE_MISMATCH;
                const availableSignatures = matchingArityMethods.map(m =>
                    `init(${m.parameters.map(p => p.type.toString()).join(', ')})`
                ).join(' or ');
                const providedTypes = argumentTypes.map(t => t.toString()).join(', ');
                accept('error',
                    `No matching 'init' method found for argument types (${providedTypes}). Available: ${availableSignatures}`,
                    {
                        node,
                        code: errorCode
                    }
                );
            }
        }

        // If we have no init method, it is fine as long we have 0 args
        if((initMethods.length == 0) && (argCount > 0)){
            accept('error',
                `Class has no \`init\` method, therefor \`new\` cannot accept any arguments`,
                {
                    node,
                    code: ErrorCode.TC_NEW_EXPRESSION_BAD_ARGS
                }
            );
        }
    }


    /**
     * Helper method to get a user-friendly name for a type kind.
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
        if (isIntegerType(type) || isFloatType(type)) return 'primitive type';
        if (type.kind === TypeKind.Bool) return 'primitive type';
        if (type.kind === TypeKind.String) return 'primitive type';
        if (type.kind === TypeKind.Void) return 'primitive type';
        return 'type';
    }

    /**
     * Check array pattern for type compatibility.
     *
     * Validates that the matched expression type is actually an array.
     * This prevents errors like matching a u32 with an array pattern [first, second].
     *
     * Examples:
     * - match val: u32 { [x, y] => ... }  // ❌ Error on array pattern
     * - match arr: u32[] { [x, y] => ... } // ✅ OK
     */
    /**
     * Check pattern nodes for validation errors cached during type inference.
     *
     * During pattern type inference, the type provider detects mismatches
     * (e.g., array pattern on non-array type) and caches validation errors.
     * This method simply retrieves and reports those cached errors.
     *
     * IMPORTANT: We must trigger type inference first by getting the type of
     * a child variable pattern, which will cause the entire pattern tree to be inferred.
     */
    checkPatternErrors(node: AstNode, accept: ValidationAcceptor): void {
        
        // Trigger type inference by finding and inferring a child variable pattern
        // This ensures the pattern validation errors are cached before we check them
        if (ast.isArrayPattern(node) || ast.isStructPattern(node) || ast.isTypePattern(node)) {
            this.triggerPatternInference(node);
        }
        
        const error = this.typeProvider.getPatternValidationError(node);
        if (error) {
            accept('error', error.message, {
                node,
                code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
            });
        }
    }

    /**
     * Helper method to find a field/attribute type and validation info in a class or struct.
     *
     * @param baseType The class or struct type to search in
     * @param fieldName The name of the field/attribute to find
     * @returns Field info including type and whether it's a const attribute, or undefined if not found
     */
    private getFieldInfo(baseType: TypeDescription, fieldName: string):
        { type: TypeDescription; isConst: boolean; isStatic: boolean; isClass: boolean } | undefined {
        
        // For classes: get attribute type
        if (isClassType(baseType)) {
            const attribute = baseType.attributes.find(a => a.name === fieldName);
            if (attribute) {
                return {
                    type: attribute.type,
                    isConst: attribute.isConst,
                    isStatic: attribute.isStatic,
                    isClass: true
                };
            }
            return undefined;
        }

        // For impl types: get attribute type
        if (isImplementationType(baseType)) {
            const attribute = baseType.attributes.find(a => a.name === fieldName);
            if (attribute) {
                return {
                    type: attribute.type,
                    isConst: attribute.isConst,
                    isStatic: attribute.isStatic,
                    isClass: false
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
                    isStatic: false,
                    isClass: false
                };
            }
        }
        
        return undefined;
    }

    /**
     * Check object update fields for validation.
     *
     * Validates that:
     * 1. Base expression is a struct or class
     * 2. All updated fields exist in the base type
     * 3. Const class attributes cannot be mutated (TODO: except in constructor)
     * 4. Field values are type-compatible with their declarations
     *
     * Examples:
     * - vec.{x: 1, y: 2} where vec is {x: u32, y: u32} → ✅ OK
     * - vec.{x: "string"} where vec.x is u32 → ❌ Error: type mismatch
     * - obj.{max: 200} where max is const → ❌ Error: cannot mutate const
     */
    checkObjectUpdateFields(node: ast.ObjectUpdate, accept: ValidationAcceptor) {
        const baseType = this.typeProvider.getType(node.expr);
        const resolvedType = this.typeUtils.resolveIfReference(baseType);
        
        // Validate base type is struct, class, or impl
        const isClass = isClassType(resolvedType);
        const isImpl = isImplementationType(resolvedType);
        const structType = this.typeUtils.asStructType(resolvedType);

        if (!isClass && !isImpl && !structType) {
            accept('error', `Object Update Operator ".{}" requires either a struct or a class on the LHS, instead found ${baseType.toString()}`, {
                node: node.expr,
                code: ErrorCode.TC_INVALID_OBJ_UPDATE_LHS
            });

            return;
        }

        // Check each field in the update
        for (const kvPair of node.pairs) {
            // Get field info using the helper
            const fieldInfo = this.getFieldInfo(resolvedType, kvPair.name);
            
            if (!fieldInfo) {
                const fieldKind = isClass ? 'Attribute' : 'Field';
                accept('error', `${fieldKind} '${kvPair.name}' not found in ${baseType.toString()}`, {
                    node: kvPair,
                    code: ErrorCode.TC_INVALID_OBJ_UPDATE_LHS
                });
                continue;
            }
            
            if (fieldInfo.isConst) {
                if (fieldInfo.isStatic) {
                    if (!this.isInFirstStaticBlock(node)) {
                        accept('error', `Cannot assign to static const attribute '${kvPair.name}'. Static const attributes can only be assigned in the first static block.`, {
                            node: kvPair,
                            code: ErrorCode.TC_STATIC_CONST_NOT_FIRST_BLOCK
                        });
                        continue;
                    }
                } else if (!this.isInConstructor(node)) {
                    accept('error', `Attribute '${kvPair.name}' is constant and cannot be mutated. Const attributes can only be assigned in constructors (init methods).`, {
                        node: kvPair,
                        code: ErrorCode.TC_ASSIGNMENT_TO_CONST
                    });
                    continue;
                }
            }

            // Check type compatibility
            const exprType = this.typeProvider.getType(kvPair.expr);
            const compatResult = this.isTypeCompatible(exprType, fieldInfo.type);
            
            if (!compatResult.success) {
                const errorCode = ErrorCode.TC_ASSIGNMENT_TYPE_MISMATCH;
                const errorMsg = compatResult.message
                    ? `Object update field '${kvPair.name}' type mismatch: ${compatResult.message}`
                    : `Object update field '${kvPair.name}' type mismatch: Expected '${fieldInfo.type.toString()}', but got '${exprType.toString()}'`;
                accept('error', errorMsg, {
                    node: kvPair.expr,
                    code: errorCode
                });
            }
        }
    }

    /**
     * Triggers type inference for a pattern tree by finding a variable pattern
     * child and calling getType on it. This causes the entire pattern tree to
     * be inferred, including caching any validation errors.
     */
    private triggerPatternInference(pattern: AstNode): void {
        // Find any variable pattern in the tree
        const varPattern = this.findVariablePattern(pattern);
        if (varPattern) {
            // Calling getType on a variable pattern triggers inferMatchCasePattern
            // which infers the entire pattern tree and caches validation errors
            this.typeProvider.getType(varPattern);
        } else {
        }
    }

    /**
     * Recursively finds the first variable pattern in a pattern tree.
     */
    private findVariablePattern(node: AstNode): ast.VariablePattern | undefined {
        if (ast.isVariablePattern(node)) {
            return node;
        }
        
        // Recursively search children
        for (const child of AstUtils.streamContents(node)) {
            const found = this.findVariablePattern(child);
            if (found) {
                return found;
            }
        }
        
        return undefined;
    }


    /**
     * Check type cast expressions for validity.
     *
     * Cast validation rules based on cast type:
     *
     * 1. Regular cast (as): Must be trivially safe (guaranteed to succeed)
     *    - Class to interface it implements
     *    - Primitive type conversions (u32 to i32, etc.)
     *    - Variant constructor to parent variant
     *    - Types that are directly assignable
     *
     * 2. Safe cast (as?): Returns nullable if cast fails
     *    - Interface to class (downcast)
     *    - Variant to variant constructor
     *    - Any cast that's not guaranteed but possible
     *
     * 3. Force cast (as!): User takes full responsibility
     *    - Warns if unnecessary (when regular cast would work)
     *    - Warns if dangerous (no relationship between types)
     *
     * Examples:
     * ```tc
     * let c: Animal = cat
     * let cat2 = c as Cat              // ❌ Error - not guaranteed
     * let cat3 = c as? Cat             // ✅ OK - safe cast returns Cat?
     * let x = 10u32 as i32             // ✅ OK - primitive conversion
     * let y = 10u32 as! string         // ⚠️ Warning - dangerous force cast
     * ```
     */
    checkTypeCastExpression = (node: ast.TypeCastExpression, accept: ValidationAcceptor): void => {
        // Get source and target types
        const sourceType = this.typeProvider.getType(node.left);
        const targetType = this.typeProvider.getType(node.destType);

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
                const errorCode = ErrorCode.TC_CAST_INVALID_REGULAR_CAST;
                const errorMsg = castResult.message
                    ? `Invalid cast from '${sourceType.toString()}' to '${targetType.toString()}': ${castResult.message}. Use 'as?' for unsafe casts or 'as!' to force.`
                    : `Invalid cast from '${sourceType.toString()}' to '${targetType.toString()}'. Use 'as?' for unsafe casts or 'as!' to force.`;
                accept('error', errorMsg, {
                    node: node.destType,
                    code: errorCode
                });
            }
            return;
        }

        
        // Warn if dangerous (types are completely unrelated)
        // Check if there's ANY relationship between the types
        const reverseResult = this.typeUtils.canCastTypes(resolvedTarget, resolvedSource);
        const hasRelationship = castResult.success || reverseResult.success;

        // SAFE CAST (as?): Allowed if cast is possible, warns if guaranteed to succeed or fail
        if (castType === 'as?') {
            // Check if cast is guaranteed to succeed (unnecessary safe cast)
            const assignableResult = this.typeUtils.isAssignable(resolvedSource, resolvedTarget);
            if (assignableResult.success) {
                const warningCode = WarningCode.TC_CAST_UNNECESSARY_SAFE_CAST;
                accept('warning', `Unnecessary safe cast from '${sourceType.toString()}' to '${targetType.toString()}': Cast is guaranteed to succeed. Use regular cast 'as' instead.`, {
                    node: node.destType,
                    code: warningCode
                });
                return;
            }

            // Check special cases for safe cast that are guaranteed to fail
            // Interface to class where class doesn't implement interface
            const targetIsClass = isClassType(resolvedTarget);
            const sourceInterface = this.typeUtils.asInterfaceType(resolvedSource);
            
            if (sourceInterface && targetIsClass) {
                // Check if target class implements source interface
                const implementsResult = this.typeUtils.isClassAssignableToInterface(resolvedTarget, sourceInterface);
                if (!implementsResult.success) {
                    const warningCode = WarningCode.TC_CAST_SAFE_CAST_ALWAYS_NULL;
                    accept('warning', `Safe cast guaranteed to fail: Class '${targetType.toString()}' does not implement interface '${sourceType.toString()}'. This will always return null.`, {
                        node: node.destType,
                        code: warningCode
                    });
                }
            }

            if (!hasRelationship) {
                // Additional checks for primitive types - these are often intentional
                const bothPrimitive = (isIntegerType(resolvedSource) || isFloatType(resolvedSource)) &&
                                     (isIntegerType(resolvedTarget) || isFloatType(resolvedTarget));
                
                if (!bothPrimitive) {
                    const warningCode = WarningCode.TC_CAST_DANGEROUS_FORCE_CAST;
                    accept('warning', `Incompatible forced cast from '${sourceType.toString()}' to '${targetType.toString()}': Types are completely unrelated. This cast may cause undefined behavior at runtime.`, {
                        node: node.destType,
                        code: warningCode
                    });
                }
                else {
                    const warningCode = WarningCode.TC_CAST_SAFE_CAST_WITH_PRIMITIVE;
                    accept('error', `Cannot perform safe cast with primitive types.`, {
                        node: node.destType,
                        code: warningCode
                    });
                }
            }
            
            return;
        }

        // FORCE CAST (as!): Always succeeds, but may warn
        if (castType === 'as!') {
            // Warn if unnecessary (cast would succeed with regular 'as')
            if (castResult.success) {
                const warningCode = WarningCode.TC_CAST_UNNECESSARY_FORCE_CAST;
                accept('warning', `Unnecessary forced cast from '${sourceType.toString()}' to '${targetType.toString()}': Cast is already safe. Use regular cast 'as' instead.`, {
                    node: node.destType,
                    code: warningCode
                });
                return;
            }


            if (!hasRelationship) {
                // Additional checks for primitive types - these are often intentional
                const bothPrimitive = (isIntegerType(resolvedSource) || isFloatType(resolvedSource)) &&
                                     (isIntegerType(resolvedTarget) || isFloatType(resolvedTarget));
                
                if (!bothPrimitive) {
                    const warningCode = WarningCode.TC_CAST_DANGEROUS_FORCE_CAST;
                    accept('warning', `Dangerous forced cast from '${sourceType.toString()}' to '${targetType.toString()}': Types are completely unrelated. This cast may cause undefined behavior at runtime.`, {
                        node: node.destType,
                        code: warningCode
                    });
                }
            }
            return;
        }
    }










    /**
     * Check instance check expressions (`is` operator) for valid RHS types.
     *
     * The `is` operator checks if a value is an instance of a type at runtime.
     * Only certain types support runtime type checking:
     * - Class types (check if instance is of that class)
     * - Interface types (check if instance implements that interface)
     * - Variant types (check if value is any constructor of that variant)
     * - Variant constructor types (check if value is that specific constructor)
     * - null (check if value is null)
     *
     * Examples:
     * ```tc
     * let x: Animal = ...
     * if x is Cat { ... }                    // ✅ OK - Cat is a class
     *
     * let y: any = ...
     * if y is Drawable { ... }               // ✅ OK - Drawable is an interface
     *
     * let opt: Option<u32> = ...
     * if opt is Option.Some { ... }          // ✅ OK - Option.Some is a variant constructor
     * if opt is Option { ... }               // ✅ OK - Option is a variant
     *
     * let n: u32 = ...
     * if n is u32 { ... }                    // ❌ Error - u32 is a primitive type
     * if n is string { ... }                 // ❌ Error - string is a primitive type
     * ```
     */
    checkInstanceCheckExpression = (node: ast.InstanceCheckExpression, accept: ValidationAcceptor): void => {
        // Get the type of the expression being checked (LHS of `is`)
        const sourceType = this.typeProvider.getType(node.left);
        
        // Get the type we're checking against (RHS of `is`)
        const destType = this.typeProvider.getType(node.destType);
        
        // Resolve reference types to get the actual types
        const resolvedSource = this.typeUtils.resolveIfReference(sourceType);
        const resolvedDest = this.typeUtils.resolveIfReference(destType);
        
        // Skip validation if either is an error type
        if (isErrorType(resolvedSource) || isErrorType(resolvedDest)) {
            return;
        }
        
        // Check if it's one of the allowed types
        const isValidType = isClassType(resolvedDest) ||
                           isInterfaceType(resolvedDest) ||
                           isVariantType(resolvedDest) ||
                           isVariantConstructorType(resolvedDest) ||
                           resolvedDest.kind === TypeKind.Null;
        
        if (!isValidType) {
            const errorCode = ErrorCode.TC_INSTANCE_CHECK_INVALID_RHS_TYPE;
            const typeKindName = this.getTypeKindName(resolvedDest);
            accept('error',
                `Invalid type for 'is' operator: The 'is' operator requires a Class, Interface, Variant, Variant Constructor, or null type, but got ${typeKindName} '${resolvedDest.toString()}'. ` +
                `Runtime type checking is only supported for these reference types.`,
                {
                    node: node.destType,
                    code: errorCode
                }
            );
            return;
        }

        // `x is null` is a direct null-check and is valid regardless of cast relationship.
        if (resolvedDest.kind === TypeKind.Null) {
            return;
        }
        
        // Now validate that there's a valid relationship between LHS and RHS
        // Similar to cast validation, check if there's ANY relationship between the types
        const sourceToDestResult = this.typeUtils.canCastTypes(resolvedSource, resolvedDest);
        const destToSourceResult = this.typeUtils.canCastTypes(resolvedDest, resolvedSource);
        const hasRelationship = sourceToDestResult.success || destToSourceResult.success;
        
        if (!hasRelationship) {
            const errorCode = ErrorCode.TC_INSTANCE_CHECK_INVALID_RHS_TYPE;
            accept('error',
                `Invalid 'is' check from '${sourceType.toString()}' to '${destType.toString()}': Types are completely unrelated. ` +
                `The 'is' operator can only be used when there's a valid type relationship between the operands.`,
                {
                    node: node.destType,
                    code: errorCode
                }
            );
        }
    }


    /**
     * Check if a generic constraint defines a specific operator.
     *
     * This checks if the constraint (interface, union, or join type) has a method
     * that corresponds to the given operator. For example, checking if a constraint
     * defines the '+' operator by looking for a method named '+'.
     *
     * CRITICAL: This must check inherited methods too! If Numeric extends Addable,
     * and Addable defines '+', then Numeric also defines '+'.
     *
     * @param constraint The constraint type (interface, union, or join)
     * @param operatorName The operator to check for (e.g., '+', '-', '*')
     * @returns true if the constraint defines this operator
     */
    private constraintDefinesOperator(constraint: TypeDescription, operatorName: string): boolean {
        // Resolve the constraint if it's a reference
        const resolvedConstraint = this.typeUtils.resolveIfReference(constraint);
        
        // Handle union constraints: T: Interface1 | Interface2
        // The generic can use operators defined in ANY of the union members
        if (isUnionType(resolvedConstraint)) {
            return resolvedConstraint.types.some(t => this.constraintDefinesOperator(t, operatorName));
        }
        
        // Handle join constraints: T: Interface1 & Interface2
        // The generic can use operators defined in ANY of the joined types
        if (isJoinType(resolvedConstraint)) {
            return resolvedConstraint.types.some(t => this.constraintDefinesOperator(t, operatorName));
        }
        
        // Handle interface constraints: check if the interface defines the operator method
        // CRITICAL: Must check ALL methods including inherited ones!
        if (isInterfaceType(resolvedConstraint)) {
            // Collect all methods including inherited ones
            const allMethods = this.typeUtils.collectAllInterfaceMethods(resolvedConstraint);
            // Check if any method (direct or inherited) is named after this operator
            return allMethods.some(method =>
                method.names.includes(operatorName)
            );
        }
        
        // For other constraint types (classes, etc.), we don't support operator overloading
        // through constraints yet, so return false
        return false;
    }

    /**
     * Validates operator constraints at the call site of a generic function.
     * Self-sufficient: builds its own substitutions from QualifiedReference.genericArgs
     * when the caller's substitutions are unavailable (e.g., the type provider already
     * specialized the function type from the QualifiedReference).
     */
    private validateOperatorConstraintsAtCallSite(
        node: ast.FunctionCall,
        substitutions: Map<string, TypeDescription> | undefined,
        accept: ValidationAcceptor
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
        // (e.g., `addVars<string, i32, i32>("hi", 1)` — generic args are on the reference,
        // so fnType.genericParameters is empty and the caller didn't build substitutions).
        if ((!substitutions || substitutions.size === 0) && genericParams && genericParams.length > 0) {
            if (ast.isQualifiedReference(node.expr)) {
                const qualRef = node.expr;
                if (qualRef.genericArgs?.length === genericParams.length) {
                    substitutions = new Map<string, TypeDescription>();
                    genericParams.forEach((param, index) => {
                        substitutions!.set(param.name, this.typeProvider.getType(qualRef.genericArgs[index]));
                    });
                }
            }
        }

        if (!substitutions || substitutions.size === 0) return;

        this.validateOperatorConstraints(constraints, substitutions, node, accept);
    }

    /**
     * Validates operator constraints against concrete substitutions.
     * Shared implementation used by both FunctionCall and NewExpression validation.
     */
    private validateOperatorConstraints(
        constraints: ast.OperatorConstraint[],
        substitutions: Map<string, TypeDescription>,
        node: AstNode,
        accept: ValidationAcceptor
    ): void {
        for (const constraint of constraints) {
            if (constraint.isBinary && constraint.leftType && constraint.rightType) {
                let leftConcreteType = this.typeProvider.getType(constraint.leftType);
                let rightConcreteType = this.typeProvider.getType(constraint.rightType);

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
                            ?? (genericType.declaration.constraint ? this.typeProvider.getType(genericType.declaration.constraint) : undefined);
                        if (genConstraint && this.constraintDefinesOperator(genConstraint, constraint.op)) {
                            continue;
                        }
                    }
                }

                if (!this.isBinaryOperatorValid(constraint.op, leftConcreteType, rightConcreteType)) {
                    accept('error',
                        `Operator constraint not satisfied: Type '${leftConcreteType.toString()}' does not support binary operator '${constraint.op}' with '${rightConcreteType.toString()}'`,
                        {
                            node,
                            code: ErrorCode.TC_OPERATOR_CONSTRAINT_NOT_SATISFIED
                        }
                    );
                } else {
                    // Operator is valid — now check that the actual result type matches the declared constraint result type.
                    // Skip if expectedResultType is `never`: this means the result type param was inferred from the
                    // operator constraint itself (not from explicit type args), so it matches by construction.
                    let expectedResultType = this.typeProvider.getType(constraint.resultType);
                    expectedResultType = this.typeUtils.substituteGenerics(expectedResultType, substitutions);
                    if (!isNeverType(expectedResultType)) {
                        const actualResultType = this.typeProvider.resolveOperatorResultType(constraint.op, leftConcreteType, rightConcreteType, node);
                        if (actualResultType && !this.isTypeCompatible(actualResultType, expectedResultType).success) {
                            accept('error',
                                `Operator constraint result type mismatch: '${leftConcreteType.toString()}' ${constraint.op} '${rightConcreteType.toString()}' produces '${actualResultType.toString()}', but constraint declares '${expectedResultType.toString()}'`,
                                {
                                    node,
                                    code: ErrorCode.TC_OPERATOR_CONSTRAINT_NOT_SATISFIED
                                }
                            );
                        }
                    }
                }
            } else if (!constraint.isBinary && constraint.operandType) {
                let operandConcreteType = this.typeProvider.getType(constraint.operandType);

                operandConcreteType = this.typeUtils.substituteGenerics(operandConcreteType, substitutions);

                // Same as binary: if the operand is still generic, check caller's context
                if (isGenericType(operandConcreteType)) {
                    if (operandConcreteType.declaration) {
                        if (this.hasMatchingOperatorConstraint(constraint.op, operandConcreteType, undefined, operandConcreteType.declaration)) {
                            continue;
                        }
                        const genConstraint = operandConcreteType.constraint
                            ?? (operandConcreteType.declaration.constraint ? this.typeProvider.getType(operandConcreteType.declaration.constraint) : undefined);
                        if (genConstraint && this.constraintDefinesOperator(genConstraint, constraint.op)) {
                            continue;
                        }
                    }
                }

                if (!this.isUnaryOperatorValid(constraint.op, operandConcreteType)) {
                    accept('error',
                        `Operator constraint not satisfied: Type '${operandConcreteType.toString()}' does not support unary operator '${constraint.op}'`,
                        {
                            node,
                            code: ErrorCode.TC_OPERATOR_CONSTRAINT_NOT_SATISFIED
                        }
                    );
                } else {
                    let expectedResultType = this.typeProvider.getType(constraint.resultType);
                    expectedResultType = this.typeUtils.substituteGenerics(expectedResultType, substitutions);
                    if (!isNeverType(expectedResultType)) {
                        const actualResultType = this.typeProvider.resolveOperatorResultType(constraint.op, operandConcreteType, undefined, node);
                        if (actualResultType && !this.isTypeCompatible(actualResultType, expectedResultType).success) {
                            accept('error',
                                `Operator constraint result type mismatch: ${constraint.op}'${operandConcreteType.toString()}' produces '${actualResultType.toString()}', but constraint declares '${expectedResultType.toString()}'`,
                                {
                                    node,
                                    code: ErrorCode.TC_OPERATOR_CONSTRAINT_NOT_SATISFIED
                                }
                            );
                        }
                    }
                }
            }
        }
    }

    /**
     * Checks if a binary operator is valid for the given concrete types.
     */
    private isBinaryOperatorValid(op: string, leftType: TypeDescription, rightType: TypeDescription): boolean {
        return isBinaryOpValid(op, leftType, rightType, this.typeUtils, valUtils.isNumericType);
    }

    /**
     * Checks if a unary operator is valid for the given concrete type.
     */
    private isUnaryOperatorValid(op: string, operandType: TypeDescription): boolean {
        return isUnaryOpValid(op, operandType, this.typeUtils, valUtils.isNumericType);
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
            } else if (ast.isStructPrototypeDeclaration(current)) {
                // Prototypes are siblings of the TypeDeclaration, not children.
                // Follow the target reference to pick up the type's operator constraints.
                const targetDecl = current.target?.ref;
                if (targetDecl && ast.isTypeDeclaration(targetDecl)) {
                    if (targetDecl.operatorConstraints && targetDecl.operatorConstraints.length > 0) {
                        return targetDecl.operatorConstraints;
                    }
                }
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

                const constraintLeftType = this.typeProvider.getType(constraint.leftType);
                const constraintRightType = this.typeProvider.getType(constraint.rightType);

                const leftMatch = this.typeUtils.areTypesEqual(leftType, constraintLeftType);
                const rightMatch = this.typeUtils.areTypesEqual(rightType, constraintRightType);

                if (leftMatch.success && rightMatch.success) {
                    return true;
                }
            } else {
                // Unary check
                if (constraint.isBinary || !constraint.operandType) continue;

                const constraintOperandType = this.typeProvider.getType(constraint.operandType);
                const match = this.typeUtils.areTypesEqual(leftType, constraintOperandType);

                if (match.success) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Check if an expression is a valid lvalue (can be assigned to).
     *
     * Valid lvalues:
     * - Variable references (non-const)
     * - Member access (non-const attributes)
     * - Index access (array elements)
     * - Reverse index access
     *
     * Invalid lvalues:
     * - Literals
     * - Function calls
     * - Binary expressions (except assignments)
     * - Const variables
     * - Const class attributes
     *
     * @param expr The expression to check
     * @returns Error info if invalid lvalue, undefined if valid
     */

    /**
     * Checks if an expression is a valid rebind (:=) target.
     * Only flat const variables are valid targets.
     */
    private checkRebindTarget(expr: ast.Expression): { message: string; code: ErrorCode } | undefined {
        // Must be a flat QualifiedReference (no member access, no indexing)
        if (!ast.isQualifiedReference(expr)) {
            return {
                message: `Rebind ':=' can only target variables, not expressions like member access or indexing.`,
                code: ErrorCode.TC_REBIND_NON_FLAT
            };
        }
        const ref = expr.reference?.ref;
        if (!ref) {
            return { message: `Cannot rebind unresolved reference`, code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET };
        }
        // Must be a const variable
        if (ast.isVariableDeclaration(ref)) {
            if (!ref.isConst) {
                return {
                    message: `Rebind ':=' can only be used on const variables. '${ref.name}' is not const. Use '=' for mutable variables.`,
                    code: ErrorCode.TC_REBIND_NON_CONST
                };
            }
            return undefined; // Valid rebind target
        }
        // Everything else (parameters, iterators, patterns, class attributes) — rejected
        if (ast.isFunctionParameter(ref)) {
            return { message: `Cannot rebind parameter '${ref.name}'.`, code: ErrorCode.TC_REBIND_IMMUTABLE_TARGET };
        }
        if (ast.isIteratorVar(ref)) {
            return { message: `Cannot rebind iterator variable.`, code: ErrorCode.TC_REBIND_IMMUTABLE_TARGET };
        }
        if (ast.isClassAttributeDecl(ref)) {
            return { message: `Cannot rebind class attribute '${ref.name}'.`, code: ErrorCode.TC_REBIND_NON_FLAT };
        }
        return { message: `Invalid rebind target.`, code: ErrorCode.TC_REBIND_IMMUTABLE_TARGET };
    }

    private checkLvalue(expr: ast.Expression): { message: string; code: ErrorCode } | undefined {
        // Valid lvalue: Variable reference (must check for const)
        if (ast.isQualifiedReference(expr)) {
            const ref = expr.reference?.ref;
            if (!ref) {
                return {
                    message: `Cannot assign to unresolved reference`,
                    code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
                };
            }

            // Check if it's a const variable
            if (ast.isVariableDeclaration(ref)) {
                if (ref.isConst) {
                    return {
                        message: `Cannot assign to const variable '${ref.name}'`,
                        code: ErrorCode.TC_ASSIGNMENT_TO_CONST
                    };
                }
                return undefined; // Valid mutable variable
            }

            // Check if it's a function parameter
            if (ast.isFunctionParameter(ref)) {
                // Parameters are const by default unless marked with 'mut'
                if (!ref.isMut) {
                    return {
                        message: `Cannot assign to parameter '${ref.name}'. Parameters are immutable by default. Use 'mut' keyword to make it mutable.`,
                        code: ErrorCode.TC_ASSIGNMENT_TO_CONST
                    };
                }
                return undefined; // Valid mutable parameter
            }

            // Check if it's a class attribute
            if (ast.isClassAttributeDecl(ref)) {
                if (ref.isConst) {
                    if (ref.isStatic) {
                        if (this.isInFirstStaticBlock(expr)) {
                            return undefined;
                        }
                        return {
                            message: `Cannot assign to static const attribute '${ref.name}'. Static const attributes can only be assigned in the first static block.`,
                            code: ErrorCode.TC_STATIC_CONST_NOT_FIRST_BLOCK
                        };
                    }
                    if (this.isInConstructor(expr)) {
                        return undefined;
                    }
                    return {
                        message: `Cannot assign to const attribute '${ref.name}'. Const attributes can only be assigned in constructors (init methods).`,
                        code: ErrorCode.TC_ASSIGNMENT_TO_CONST
                    };
                }
                return undefined; // Valid mutable attribute
            }

            // Check if it's an iterator variable (from foreach loops)
            if (ast.isIteratorVar(ref)) {
                return {
                    message: `Cannot assign to iterator variable '${ref.name || 'iterator'}'. Iterator variables are immutable.`,
                    code: ErrorCode.TC_ASSIGNMENT_TO_IMMUTABLE
                };
            }

            // Check if it's a variable pattern (from match expressions)
            if (ast.isVariablePattern(ref)) {
                return {
                    message: `Cannot assign to pattern variable '${ref.name || 'pattern'}'. Pattern variables are immutable.`,
                    code: ErrorCode.TC_ASSIGNMENT_TO_IMMUTABLE
                };
            }

            // Other references (functions, types, etc.) cannot be assigned to
            return {
                message: `Cannot assign to '${this.getReferenceName(ref)}'. This is not a valid assignment target.`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Valid lvalue: Member access (must check for const attributes and const base)
        if (ast.isMemberAccess(expr)) {
            // First check if the base expression is const
            const baseConstError = this.checkIfBaseIsConst(expr.expr);
            if (baseConstError) {
                return baseConstError;
            }

            // Then check if the member itself is const
            const element = expr.element?.ref;
            if (element && ast.isClassAttributeDecl(element) && element.isConst) {
                if (element.isStatic) {
                    if (this.isInFirstStaticBlock(expr)) {
                        return undefined;
                    }
                    return {
                        message: `Cannot assign to static const attribute '${element.name}'. Static const attributes can only be assigned in the first static block.`,
                        code: ErrorCode.TC_STATIC_CONST_NOT_FIRST_BLOCK
                    };
                }
                if (this.isInConstructor(expr)) {
                    return undefined;
                }
                return {
                    message: `Cannot assign to const attribute '${element.name}'. Const attributes can only be assigned in constructors (init methods).`,
                    code: ErrorCode.TC_ASSIGNMENT_TO_CONST
                };
            }
            return undefined; // Valid member access
        }

        // Valid lvalue: Index access
        if (ast.isIndexAccess(expr)) {
            return undefined;
        }

        // Valid lvalue: Reverse index access
        if (ast.isReverseIndexAccess(expr)) {
            return undefined;
        }

        // Invalid lvalue: Literals
        if (ast.isLiteralExpression(expr)) {
            return {
                message: `Cannot assign to literal value`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: Function calls
        if (ast.isFunctionCall(expr)) {
            return {
                message: `Cannot assign to function call result`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: Binary expressions (unless they're also assignments, which is handled separately)
        if (ast.isBinaryExpression(expr)) {
            return {
                message: `Cannot assign to expression result`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: Unary expressions
        if (ast.isUnaryExpression(expr)) {
            return {
                message: `Cannot assign to unary expression result`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: Type cast expressions
        if (ast.isTypeCastExpression(expr)) {
            return {
                message: `Cannot assign to cast expression result`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: Instance check expressions
        if (ast.isInstanceCheckExpression(expr)) {
            return {
                message: `Cannot assign to type check result`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: 'this' expression
        if (ast.isThisExpression(expr)) {
            return {
                message: `Cannot assign to 'this'`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: Lambda expressions
        if (ast.isLambdaExpression(expr)) {
            return {
                message: `Cannot assign to lambda expression`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: Array/struct construction
        if (ast.isArrayConstructionExpression(expr) ||
            ast.isNamedStructConstructionExpression(expr) ||
            ast.isAnonymousStructConstructionExpression(expr)) {
            return {
                message: `Cannot assign to constructor expression`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: Match/If/LetIn expressions
        if (ast.isMatchExpression(expr) ||
            ast.isConditionalExpression(expr) ||
            ast.isLetInExpression(expr)) {
            return {
                message: `Cannot assign to expression result`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: Do expression
        if (ast.isDoExpression(expr)) {
            return {
                message: `Cannot assign to do expression result`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: New expression
        if (ast.isNewExpression(expr)) {
            return {
                message: `Cannot assign to new expression result`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: Throw/Yield/Coroutine expressions
        if (ast.isThrowExpression(expr) ||
            ast.isYieldExpression(expr) ||
            ast.isCoroutineExpression(expr)) {
            return {
                message: `Cannot assign to expression result`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: Postfix operations (++, --, denull)
        if (ast.isPostfixOp(expr) || ast.isDenullExpression(expr)) {
            return {
                message: `Cannot assign to expression result`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: Tuple expression
        if (ast.isTupleExpression(expr)) {
            return {
                message: `Cannot assign to tuple expression. Use destructuring assignment instead.`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Invalid lvalue: Object update expression
        if (ast.isObjectUpdate(expr)) {
            return {
                message: `Cannot assign to object update result`,
                code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
            };
        }

        // Default: Unknown expression type, treat as invalid
        return {
            message: `Invalid assignment target`,
            code: ErrorCode.TC_INVALID_ASSIGNMENT_TARGET
        };
    }

    /**
     * Check if an expression is within a constructor (init method).
     *
     * @param expr The expression to check
     * @returns true if inside an init method, false otherwise
     */
    private isInConstructor(expr: AstNode): boolean {
        let current: AstNode | undefined = expr;
        
        // Walk up the AST tree to find a containing method
        while (current) {
            // Check if we're in a class method
            if (ast.isClassMethod(current)) {
                // Check if this method is named 'init' (constructor)
                const method = current.method;
                if (method && method.names.includes('init')) {
                    return true;
                }
                return false; // In a method, but not a constructor
            }
            
            current = current.$container;
        }
        
        return false;
    }

    /**
     * Check if an expression is within the first static block of its containing class.
     *
     * Static const attributes are allowed to be assigned only in the first static block,
     * serving as the "static constructor" for the class.
     */
    private isInFirstStaticBlock(expr: AstNode): boolean {
        let current: AstNode | undefined = expr;

        while (current) {
            if (ast.isBlockStatement(current)) {
                const parent: AstNode | undefined = current.$container;
                if (parent && ast.isClassType(parent) && parent.staticBlock?.length > 0) {
                    if (parent.staticBlock[0] === current) {
                        return true;
                    }
                    if (parent.staticBlock.includes(current)) {
                        return false;
                    }
                }
            }

            if (ast.isClassMethod(current) || ast.isClassType(current)) {
                return false;
            }

            current = current.$container;
        }

        return false;
    }

    /**
     * Check if the base of a member access chain is const.
     *
     * For example:
     * - `let const a = {x: 1}; a.x = 2` → base `a` is const, so error
     * - `let a = {x: 1}; a.x = 2` → base `a` is mutable, so OK
     * - `let const a = {nested: {x: 1}}; a.nested.x = 2` → base `a` is const, so error
     *
     * @param expr The base expression to check
     * @returns Error info if base is const, undefined otherwise
     */
    private checkIfBaseIsConst(expr: ast.Expression): { message: string; code: ErrorCode } | undefined {
        // Check if it's a qualified reference
        if (ast.isQualifiedReference(expr)) {
            const ref = expr.reference?.ref;
            if (ref && ast.isVariableDeclaration(ref) && ref.isConst) {
                return {
                    message: `Cannot assign to member of const variable '${ref.name}'. The variable is declared as const, making all its members immutable.`,
                    code: ErrorCode.TC_ASSIGNMENT_TO_CONST
                };
            }
            
            // Check if it's a function parameter
            if (ref && ast.isFunctionParameter(ref)) {
                // Function parameters are const by default unless marked with 'mut'
                if (!ref.isMut) {
                    return {
                        message: `Cannot assign to member of parameter '${ref.name}'. Parameters are immutable by default. Use 'mut' keyword to make it mutable.`,
                        code: ErrorCode.TC_ASSIGNMENT_TO_CONST
                    };
                }
                return undefined; // Valid mutable parameter
            }
        }

        // Check if it's a member access - recursively check the base
        if (ast.isMemberAccess(expr)) {
            return this.checkIfBaseIsConst(expr.expr);
        }

        // For other expressions (index access, function calls, etc.),
        // we don't consider them as const bases
        return undefined;
    }

    checkSelfTypeContext = (node: ast.SelfType, accept: ValidationAcceptor): void => {
        const inClass = AstUtils.getContainerOfType(node, ast.isClassType);
        if (inClass) return;
        const inImpl = AstUtils.getContainerOfType(node, ast.isImplementationType);
        if (inImpl) return;
        const inInterface = AstUtils.getContainerOfType(node, ast.isInterfaceType);
        if (inInterface) return;
        accept('error', "Type 'Self' can only be used inside a class, interface, or implementation block", {
            node,
            code: ErrorCode.TC_SELF_TYPE_OUTSIDE_CONTEXT
        });
    };

    /**
     * Trigger inference of struct prototype declarations and report any recorded errors.
     * Errors can be on the prototype declaration itself (non-struct target)
     * or on individual method nodes (static/override not allowed).
     *
     * Duplicate prototype detection is done here (not during inference) because
     * Langium's WorkspaceCache may invalidate the typeCache between validation passes,
     * causing inferStructPrototypeDeclaration to be called multiple times for the same
     * node. Moving the check here uses stable AST sibling relationships instead.
     */
    checkStructPrototypeDeclaration = (node: ast.StructPrototypeDeclaration, accept: ValidationAcceptor): void => {
        // Generic parameters on prototype declarations are not supported
        if (node.genericParameters.length > 0) {
            accept('error', 'Generic parameters on prototype declarations are not supported', {
                node,
                code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
            });
        }

        // Detect genuine duplicate prototypes: check for a preceding sibling
        // StructPrototypeDeclaration with the same target in the same scope.
        // Use $container directly (Module or NamespaceDecl) — do NOT climb to the
        // top-level Module, because a prototype inside a namespace is not in
        // module.definitions and indexOf() would return -1, silently skipping the check.
        const container = node.$container;
        if (ast.isModule(container) || ast.isNamespaceDecl(container)) {
            const definitions = container.definitions;
            const selfIdx = definitions.indexOf(node);
            const hasPrevious = selfIdx > 0 && definitions
                .slice(0, selfIdx)
                .some(d => ast.isStructPrototypeDeclaration(d) && d.target?.ref === node.target?.ref);
            if (hasPrevious) {
                const targetName = node.target?.ref?.name ?? '?';
                accept('error', `Duplicate prototype for struct '${targetName}'`, {
                    node,
                    code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
                });
            }
        }

        // Trigger inference (side effect: populates diagnosticMap for prototype + methods)
        this.typeProvider.getType(node);

        // Report node-level errors (e.g. non-struct target)
        const protoDiags = this.typeProvider.getTypeDiagnostics(node);
        for (const diag of protoDiags) {
            accept('error', diag.message, {
                node,
                code: diag.code || ErrorCode.TC_EXPRESSION_TYPE_ERROR
            });
        }

        // Report method-level errors (static/override not allowed, duplicate method names)
        for (const method of node.methods) {
            const methodDiags = this.typeProvider.getTypeDiagnostics(method);
            for (const diag of methodDiags) {
                accept('error', diag.message, {
                    node: method,
                    code: diag.code || ErrorCode.TC_EXPRESSION_TYPE_ERROR
                });
            }
        }
    };

    /**
     * Checks if a mutating method is being called on a const variable.
     * Only enforced for concrete types (class, struct with prototype) where
     * method bodies can be analyzed for mutations. For interface-typed values,
     * purity is unknown unless explicitly declared with `pure`.
     */
    checkMutatingMethodOnConst = (node: ast.FunctionCall, accept: ValidationAcceptor): void => {
        // Only applies to method calls (callee is MemberAccess)
        if (!ast.isMemberAccess(node.expr)) return;

        const memberAccess = node.expr;
        const baseExpr = memberAccess.expr;

        // Check if the base expression is const
        const constError = this.checkIfBaseIsConst(baseExpr);
        if (!constError) return;

        // Get the base type, unwrap reference and nullable
        let baseType = this.typeProvider.getType(baseExpr);
        baseType = this.typeUtils.resolveIfReference(baseType);
        if (isNullableType(baseType)) {
            baseType = this.typeUtils.resolveIfReference(baseType.baseType);
        }

        // Only enforce purity on concrete types where we can analyze method bodies.
        // For interface-typed values, we can't determine purity without explicit `pure` annotation.
        if (isInterfaceType(baseType)) {
            // For interfaces, only flag if the method is explicitly NOT pure
            // (i.e., the interface doesn't declare it as pure).
            // Since interface methods default to isPure:false, we only error
            // when a method IS found and is explicitly not pure... but we can't
            // distinguish "not declared pure" from "declared not pure", so we skip.
            // The `pure` keyword on interfaces only affects the compatibility check.
            return;
        }

        const methodName = memberAccess.element?.$refText ?? '';
        const methodType = this.findMethodOnType(baseType, methodName);

        if (!methodType || methodType.isPure) return;  // pure is OK

        accept('error',
            `Cannot call mutating method '${methodName}' on a const value. ` +
            `Consider making the variable non-const or ensuring the method doesn't modify 'this'.`,
            { node: node.expr, code: ErrorCode.TC_MUTATING_METHOD_ON_CONST }
        );
    };

    /**
     * Resolves a method by name from a type description.
     * Handles class types, interface types, struct prototype types, and nullable/reference wrappers.
     */
    private findMethodOnType(type: TypeDescription, name: string): MethodType | undefined {
        // Unwrap reference types
        if (isReferenceType(type)) {
            const resolved = this.typeUtils.resolveIfReference(type);
            return this.findMethodOnType(resolved, name);
        }

        // Unwrap nullable types
        if (isNullableType(type)) {
            return this.findMethodOnType(type.baseType, name);
        }

        // Class types: search direct methods
        if (isClassType(type)) {
            const method = type.methods.find(m => m.names.includes(name));
            if (method) return method;
            // Also check implementation methods
            for (const impl of type.implementations) {
                const resolved = this.typeUtils.resolveIfReference(impl);
                if (isImplementationType(resolved)) {
                    const implMethod = resolved.methods.find(m => m.names.includes(name));
                    if (implMethod) return implMethod;
                }
            }
            return undefined;
        }

        // Interface types: search methods
        if (isInterfaceType(type)) {
            return type.methods.find(m => m.names.includes(name));
        }

        // Struct types: look up prototype methods
        if (isStructType(type) && type.node) {
            const typeDecl = AstUtils.getContainerOfType(type.node, ast.isTypeDeclaration);
            if (typeDecl) {
                const protoInfo = this.typeProvider.getStructPrototypeMethods(typeDecl);
                if (protoInfo) {
                    return protoInfo.methods.find(m => m.names.includes(name));
                }
            }
        }

        return undefined;
    }










}
