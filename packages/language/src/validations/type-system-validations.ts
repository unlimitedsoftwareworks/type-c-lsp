import { AstNode, ValidationAcceptor, ValidationChecks } from "langium";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";
import {
    TypeDescription,
    TypeKind,
    isArrayType,
    isClassType,
    isCoroutineType,
    isErrorType,
    isFunctionType,
    isInterfaceType,
    isJoinType,
    isReferenceType,
    isStructType,
    isVariantConstructorType
} from "../typing/type-c-types.js";
import { TypeCBaseValidation } from "./base-validation.js";
import * as valUtils from "./tc-valdiation-helper.js";
import { ErrorCode } from "../codes/errors.js";
import { TypeCTypeUtils } from "../typing/type-utils.js";

/**
 * Type system validator for Type-C.
 * 
 * Performs type checking to ensure:
 * - Variable declarations match their initializers
 * - Function arguments match parameter types
 * - Return statements match function return types
 * - Binary operations have compatible operand types
 */
export class TypeCTypeSystemValidator extends TypeCBaseValidation {
    private readonly typeProvider: TypeCTypeProvider;
    private readonly typeUtils: TypeCTypeUtils;

    constructor(services: TypeCServices) {
        super();
        this.typeProvider = services.typing.TypeProvider;
        this.typeUtils = services.typing.TypeUtils;
    }

    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            VariableDeclSingle: this.checkVariableDeclSingle,
            BinaryExpression: this.checkBinaryExpression,
            FunctionCall: this.checkFunctionCall,
            ReturnStatement: this.checkReturnStatement,
            YieldExpression: this.checkYieldExpression,
            FunctionDeclaration: this.checkFunctionDeclaration,
            IndexSet: this.checkIndexSet,
            ReverseIndexSet: this.checkReverseIndexSet,
            JoinType: this.checkJoinType,
            InterfaceType: this.checkInterfaceInheritance,
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
        // Only check if there's both an annotation AND an initializer
        if (!node.annotation || !node.initializer) {
            return;
        }

        let expectedType = this.typeProvider.getType(node.annotation);
        let inferredType = this.typeProvider.getType(node.initializer);

        // Resolve type references
        if (isReferenceType(expectedType)) {
            const resolved = this.typeProvider.resolveReference(expectedType);
            if (resolved) expectedType = resolved;
        }
        if (isReferenceType(inferredType)) {
            const resolved = this.typeProvider.resolveReference(inferredType);
            if (resolved) inferredType = resolved;
        }

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

        // Resolve references to check for class types
        if (isReferenceType(leftType)) {
            const resolved = this.typeProvider.resolveReference(leftType);
            if (resolved) leftType = resolved;
        }

        if(isReferenceType(rightType)) {
            const resolved = this.typeProvider.resolveReference(rightType);
            if (resolved) rightType = resolved;
        }

        // Skip if operator might be overloaded (class type)
        // TODO: Check if the specific operator is actually overloaded
        if (isClassType(leftType)) {
            return;
        }

        // Assignment operators: right must be compatible with left
        const assignmentOps = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='];
        if (assignmentOps.includes(node.op)) {
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
        if (isReferenceType(fnType)) {
            fnType = this.typeProvider.resolveReference(fnType);
        }

        // Handle coroutine instance calls
        if (isCoroutineType(fnType)) {
            const coroutineType = fnType;
            const args = node.args || [];
            
            // Check argument count
            if (args.length !== coroutineType.parameters.length) {
                const errorCode = ErrorCode.TC_COROUTINE_CALL_ARG_COUNT_MISMATCH;
                accept('error', `Coroutine call argument count mismatch: Expected ${coroutineType.parameters.length} argument(s), but got ${args.length}`, {
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

        // Skip validation for variant constructor calls
        // Variant constructors have generic parameters that are inferred from arguments
        // The type provider handles this inference correctly
        if (isVariantConstructorType(fnType.returnType)) {
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
            const finalSubstitutions = substitutions; // Ensure TypeScript knows it's defined
            paramTypes = paramTypes.map(param => ({
                name: param.name,
                type: this.typeUtils.substituteGenerics(param.type, finalSubstitutions),
                isMut: param.isMut
            }));
        }

        // Check argument count
        if (args.length !== paramTypes.length) {
            const errorCode = ErrorCode.TC_FUNCTION_CALL_ARG_COUNT_MISMATCH;
            accept('error', `Function call argument count mismatch: Expected ${paramTypes.length} argument(s), but got ${args.length}`, {
                node,
                code: errorCode
            });
            return;
        }

        // Check each argument type
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
     * Check return statements against function return type.
     */
    checkReturnStatement = (node: ast.ReturnStatement, accept: ValidationAcceptor): void => {
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
     * Check function declarations for return/yield type issues.
     *
     * Validates:
     * 1. If no explicit return/yield type → ensure we can infer successfully (no error type)
     * 2. If explicit return/yield type → ensure inferred type matches declared type
     *
     * For regular functions:
     * - Checks return statements and infers return type
     *
     * For coroutines (cfn):
     * - Checks yield expressions and infers yield type
     * - The "return type" annotation actually represents the yield type
     *
     * Examples:
     * ```
     * fn bad() = match n { 0 => 1, _ => "oops" }  // ❌ Can't infer common type
     * fn good() -> u32 = ...                       // ✅ Explicit type
     * fn good2() = 42                              // ✅ Can infer u32
     *
     * cfn gen() -> u32 { yield 1; yield 2; }      // ✅ Explicit yield type
     * cfn gen() { yield 1; yield 2; }             // ✅ Can infer u32 from yields
     * cfn bad() { yield 1; yield "oops"; }        // ❌ Can't infer common type
     * ```
     */
    checkFunctionDeclaration = (node: ast.FunctionDeclaration, accept: ValidationAcceptor): void => {
        const fnType = this.typeProvider.getType(node);

        if (!isFunctionType(fnType)) {
            return; // Not a function type (shouldn't happen)
        }

        const isCoroutine = node.fnType === 'cfn';
        const inferredReturnType = fnType.returnType;

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
                    node: node.header.returnType,
                    code: errorCode
                });
            }
        }
    }

    /**
     * Check index set operations (e.g., arr[0] = value).
     * Validates that the assigned value is compatible with the array/container element type.
     */
    checkIndexSet = (node: ast.IndexSet, accept: ValidationAcceptor): void => {
        let baseType = this.typeProvider.getType(node.expr);

        // Resolve reference types
        if (isReferenceType(baseType)) {
            const resolved = this.typeProvider.resolveReference(baseType);
            if (resolved) baseType = resolved;
        }

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
        if (isReferenceType(baseType)) {
            const resolved = this.typeProvider.resolveReference(baseType);
            if (resolved) baseType = resolved;
        }

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
     * Check join type (intersection type) validations.
     *
     * Requirements:
     * 1. Only interfaces and structs can be joined
     * 2. Cannot mix interfaces with structs
     * 3. Struct combination must have unique fields (no duplicate field names)
     * 4. Interface combination must have unique method signatures (overloading is allowed)
     */
    checkJoinType = (node: ast.JoinType, accept: ValidationAcceptor): void => {
        // Get the joined types
        const leftType = this.typeProvider.getType(node.left);
        const rightType = this.typeProvider.getType(node.right);

        // Resolve references
        const resolvedLeft = isReferenceType(leftType) ? this.typeProvider.resolveReference(leftType) : leftType;
        const resolvedRight = isReferenceType(rightType) ? this.typeProvider.resolveReference(rightType) : rightType;

        // Collect all types from nested joins
        const allTypes: TypeDescription[] = [];
        this.collectJoinTypes(resolvedLeft, allTypes);
        this.collectJoinTypes(resolvedRight, allTypes);

        // Validate that all types are either interfaces or structs
        const hasInterface = allTypes.some(t => isInterfaceType(t));
        const hasStruct = allTypes.some(t => isStructType(t));
        const hasOther = allTypes.some(t => !isInterfaceType(t) && !isStructType(t));

        // Check rule 1: Only interfaces and structs allowed
        if (hasOther) {
            const invalidType = allTypes.find(t => !isInterfaceType(t) && !isStructType(t));
            const errorCode = ErrorCode.TC_JOIN_TYPE_INVALID_MEMBER;
            accept('error',
                `Join type invalid member: Join types can only combine interfaces and structs. Found invalid type: ${invalidType?.toString()}`,
                { node, code: errorCode },
            );
            return;
        }

        // Check rule 2: Cannot mix interfaces with structs
        if (hasInterface && hasStruct) {
            const errorCode = ErrorCode.TC_JOIN_TYPE_MIXING_KINDS;
            accept('error',
                `Join type mixing error: Cannot combine interfaces with structs in the same join type. All members must be either interfaces or structs.`,
                { node, code: errorCode }
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
                            const errorCode = ErrorCode.TC_JOIN_STRUCT_FIELD_TYPE_CONFLICT;
                            accept('error',
                                `Join struct field type conflict: Field '${field.name}' has conflicting types: '${existing.type.toString()}' in ${existing.sources.join(', ')} vs '${field.type.toString()}' in ${structName}`,
                                { node, code: errorCode }
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
            this.validateInterfaceMethodCompatibility(interfaces, node, accept);
        }
    }

    /**
     * Validate that interface methods have compatible signatures.
     * Allow duplicate methods with the same signature (inheritance),
     * but report errors for conflicting signatures with the same name.
     */
    private validateInterfaceMethodCompatibility(
        interfaces: TypeDescription[],
        node: ast.JoinType,
        accept: ValidationAcceptor
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
                            const errorCode = ErrorCode.TC_JOIN_INTERFACE_METHOD_SIGNATURE_CONFLICT;
                            accept('error',
                                `Join interface method conflict: Method '${name}(${paramTypes.join(', ')})' has conflicting return types: '${existing.returnType}' in ${existing.sources.join(', ')} vs '${returnType}' in ${ifaceName}`,
                                { node, code: errorCode }
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
     * Recursively collect all types from a join type.
     * Resolves reference types to get the actual interface/struct definitions.
     */
    private collectJoinTypes(type: TypeDescription, result: TypeDescription[]): void {
        // Resolve reference types first
        let resolvedType = type;
        if (isReferenceType(type)) {
            const resolved = this.typeProvider.resolveReference(type);
            if (resolved) {
                resolvedType = resolved;
            }
        }

        if (isJoinType(resolvedType)) {
            // Recursively flatten nested joins
            for (const t of resolvedType.types) {
                this.collectJoinTypes(t, result);
            }
        } else {
            result.push(resolvedType);
        }
    }


    /**
     * Check interface inheritance for method conflicts.
     *
     * When an interface extends another interface, it cannot override methods with
     * different return types (same parameters, different return type).
     */
    checkInterfaceInheritance = (node: ast.InterfaceType, accept: ValidationAcceptor): void => {
        if (!node.superTypes || node.superTypes.length === 0) {
            return; // No inheritance to check
        }

        // Get the type description for this interface
        const interfaceType = this.typeProvider.getType(node);
        if (!isInterfaceType(interfaceType)) {
            return;
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
            const parentType = this.typeProvider.getType(extendedRef);
            const resolvedParent = isReferenceType(parentType)
                ? this.typeProvider.resolveReference(parentType)
                : parentType;

            if (!isInterfaceType(resolvedParent)) {
                continue;
            }

            const parentName = resolvedParent.toString();

            for (const method of resolvedParent.methods) {
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
                    const errorCode = ErrorCode.TC_INTERFACE_INHERITANCE_METHOD_CONFLICT;
                    accept('error',
                        `Interface inheritance method conflict: Method '${name}(${paramTypes.join(', ')})' in interface cannot override parent method with different return type. Parent returns '${parentMethod.returnType}', but this interface returns '${returnType}'`,
                        {
                            node: node,
                            code: errorCode
                        }
                    );
                }
            }
        }
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    /**
     * Check if a type is compatible with an expected type.
     *
     * Delegates to the type-utils isAssignable function for consistent type checking.
     * This handles ALL compatibility checks including:
     * - Interface implementation (via isClassAssignableToInterface in type-utils.ts)
     * - Numeric promotions
     * - Struct compatibility
     * - Variant constructor assignability
     * - Generic type substitution
     * - And more...
     *
     * Returns the detailed error message if types are incompatible.
     */
    private isTypeCompatible(actual_: TypeDescription, expected_: TypeDescription): { success: boolean; message?: string } {
        const actual = isReferenceType(actual_) ? this.typeProvider.resolveReference(actual_) : actual_;
        const expected = isReferenceType(expected_) ? this.typeProvider.resolveReference(expected_) : expected_;

        // Use the centralized assignability check from type-utils
        // This handles:
        // - Never type (bottom type, assignable to everything)
        // - Generic arguments with never
        // - Numeric coercion
        // - Struct compatibility
        // - Variant constructor assignability
        // - And more...
        return this.typeUtils.isAssignable(actual, expected);
    }
}