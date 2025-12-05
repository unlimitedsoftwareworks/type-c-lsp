import { AstNode, AstUtils, ValidationAcceptor, ValidationChecks } from "langium";
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
    isFloatType,
    isFunctionType,
    isIntegerType,
    isInterfaceType,
    isJoinType,
    isMetaClassType,
    isNullableType,
    isReferenceType,
    isStructType,
    isTupleType,
    isUnionType,
    isVariantConstructorType,
    isVariantType,
    isEnumType
} from "../typing/type-c-types.js";
import * as factory from "../typing/type-factory.js";
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
            BinaryExpression: [this.checkBinaryExpression, this.checkExpressionForErrors],
            FunctionCall: [this.checkFunctionCall, this.checkExpressionForErrors],
            ReturnStatement: this.checkReturnStatement,
            YieldExpression: this.checkYieldExpression,
            FunctionDeclaration: this.checkFunctionDeclaration,
            ClassMethod: this.checkClassMethod,
            LambdaExpression: this.checkLambdaExpression,
            IndexSet: this.checkIndexSet,
            ReverseIndexSet: this.checkReverseIndexSet,
            JoinType: this.checkJoinType,
            InterfaceType: this.checkInterfaceInheritance,
            ClassType: this.checkClassImplementation,
            MemberAccess: [this.checkMemberAccess, this.checkExpressionForErrors],
            DenullExpression: [this.checkDenullExpression, this.checkExpressionForErrors],
            NamedStructConstructionExpression: [this.checkStructSpreadFieldTypes, this.checkExpressionForErrors],
            NewExpression: [this.checkNewExpression, this.checkExpressionForErrors],
            UnaryExpression: this.checkExpressionForErrors,
            IndexAccess: this.checkExpressionForErrors,
            ReverseIndexAccess: this.checkExpressionForErrors,
            PostfixOp: this.checkExpressionForErrors,
            ConditionalExpression: this.checkExpressionForErrors,
            MatchExpression: this.checkExpressionForErrors,
            LetInExpression: this.checkExpressionForErrors,
            DoExpression: this.checkExpressionForErrors,
            TypeCastExpression: this.checkExpressionForErrors,
            ArrayConstructionExpression: this.checkExpressionForErrors,
            AnonymousStructConstructionExpression: this.checkExpressionForErrors,
            TupleExpression: this.checkExpressionForErrors,
            QualifiedReference: this.checkExpressionForErrors,
            ThrowExpression: this.checkExpressionForErrors,
            MutateExpression: this.checkExpressionForErrors,
            CoroutineExpression: this.checkExpressionForErrors,
            InstanceCheckExpression: this.checkExpressionForErrors,
            ThisExpression: this.checkExpressionForErrors,
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
     * Check if an expression has an error type and report it as a validation error.
     *
     * This is a general-purpose validator that catches type inference failures
     * and reports them to the user. It filters out internal error types that
     * are used during type inference (like recursion placeholders).
     *
     * Each expression is validated separately - we only check the direct type,
     * not nested types. Nested expressions will be validated by their own nodes.
     *
     * Examples of errors this catches:
     * - Unresolved references: `unknownVar`
     * - Type inference failures: `[]` without context
     * - Invalid operations: array access on non-array types
     */
    checkExpressionForErrors = (node: ast.Expression, accept: ValidationAcceptor): void => {
        ///console.log('[VALIDATION] Checking expression:', node.$type);
        const exprType = this.typeProvider.getType(node);
        ///console.log('[VALIDATION] Expression type:', exprType.toString(), 'Kind:', exprType.kind);
        
        // Check if this expression's type is an error
        if (isErrorType(exprType)) {
            const message = exprType.message;
            ///console.log('[VALIDATION] Found error type with message:', message);
            
            // Skip internal error types used during type inference
            if (message === '__recursion_placeholder__' ||
                message === '__contextual_placeholder__' ||
                message?.includes('placeholder')) {
                ///console.log('[VALIDATION] Skipping placeholder error');
                return;
            }
            
            ///console.log('[VALIDATION] Reporting error:', message);
            // Report the error
            accept('error', message || 'Type error', {
                node,
                code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
            });
        } else {
            ///console.log('[VALIDATION] Type is not an error, skipping');
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
     * Helper method to infer return type from a block body.
     * This is extracted from the type provider for reuse in validation.
     */
    private inferReturnTypeFromBody(body: ast.BlockStatement): TypeDescription {
        const returnStatements = this.collectReturnStatements(body);

        if (returnStatements.length === 0) {
            return factory.createVoidType();
        }

        // Get types of all return expressions
        const allReturnTypes = returnStatements
            .map(stmt => stmt.expr ? this.typeProvider.getType(stmt.expr) : factory.createVoidType());

        // Filter out recursion placeholders
        const nonPlaceholderTypes = allReturnTypes.filter(type => {
            if (isErrorType(type)) {
                return type.message !== '__recursion_placeholder__';
            }
            return true;
        });

        const returnTypes = nonPlaceholderTypes.length > 0 ? nonPlaceholderTypes : allReturnTypes;

        if (returnTypes.length === 0) {
            return factory.createVoidType();
        }

        // Find common type
        return this.getCommonType(returnTypes);
    }

    /**
     * Collect all return statements from a block (only from this function level).
     */
    private collectReturnStatements(block: ast.BlockStatement): ast.ReturnStatement[] {
        const returns: ast.ReturnStatement[] = [];

        const visit = (node: AstNode) => {
            // Stop if we hit a nested function - don't collect its returns!
            if (ast.isFunctionDeclaration(node)) {
                return;
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
     * Helper method to infer yield type from a coroutine body.
     * Similar to inferReturnTypeFromBody but for yield expressions.
     */
    private inferYieldTypeFromBody(body: ast.BlockStatement): TypeDescription {
        const yieldStatements = this.collectYieldExpressions(body);

        if (yieldStatements.length === 0) {
            return factory.createVoidType();
        }

        // Get types of all yield expressions
        const allYieldTypes = yieldStatements
            .map(stmt => stmt.expr ? this.typeProvider.getType(stmt.expr) : factory.createVoidType());

        // Filter out recursion placeholders
        const nonPlaceholderTypes = allYieldTypes.filter(type => {
            if (isErrorType(type)) {
                return type.message !== '__recursion_placeholder__';
            }
            return true;
        });

        const yieldTypes = nonPlaceholderTypes.length > 0 ? nonPlaceholderTypes : allYieldTypes;

        if (yieldTypes.length === 0) {
            return factory.createVoidType();
        }

        // Find common type
        return this.getCommonType(yieldTypes);
    }

    /**
     * Collect all yield expressions from a block (only from this coroutine level).
     */
    private collectYieldExpressions(block: ast.BlockStatement): ast.YieldExpression[] {
        const yields: ast.YieldExpression[] = [];

        const visit = (node: AstNode) => {
            // Stop if we hit a nested function or coroutine - don't collect its yields!
            if (ast.isFunctionDeclaration(node) || ast.isLambdaExpression(node)) {
                return;
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
     * Get the common type from multiple types.
     * Simplified version for validation - delegates to type provider's logic.
     */
    private getCommonType(types: TypeDescription[]): TypeDescription {
        if (types.length === 0) {
            return factory.createVoidType();
        }

        if (types.length === 1) {
            return types[0];
        }

        // Separate null types from non-null types
        const nullTypes = types.filter(t => t.kind === TypeKind.Null);
        const nonNullTypes = types.filter(t => t.kind !== TypeKind.Null);

        // If all types are null, return null
        if (nonNullTypes.length === 0) {
            return factory.createNullType();
        }

        // Find common type of non-null types
        let commonType: TypeDescription;

        if (nonNullTypes.length === 1) {
            commonType = nonNullTypes[0];
        } else {
            // Check if all non-null types are identical
            const firstType = nonNullTypes[0];
            const allIdentical = nonNullTypes.every(t => t.toString() === firstType.toString());

            if (allIdentical) {
                commonType = firstType;
            } else {
                // For more complex cases, return an error type
                return factory.createErrorType(
                    `Cannot infer common type: found ${types.map(t => t.toString()).join(', ')}`,
                    undefined,
                    firstType.node
                );
            }
        }

        // If we had any nulls, wrap the common type in Nullable (but only once)
        if (nullTypes.length > 0) {
            // Don't double-wrap if commonType is already nullable
            if (isNullableType(commonType)) {
                return commonType;
            }
            return factory.createNullableType(commonType, types[0].node);
        }

        return commonType;
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
     * Check interface inheritance for method conflicts and circular references.
     *
     * Validates:
     * 1. Interfaces can only extend other interfaces
     * 2. No circular inheritance (A extends B, B extends A)
     * 3. When an interface extends another interface, it cannot override methods with
     *    different return types (same parameters, different return type).
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

        // Check for circular inheritance before processing methods
        const visited = new Set<ast.InterfaceType>();
        const path: string[] = [];
        const circularRef = this.detectCircularInheritance(node, visited, path);
        if (circularRef) {
            const errorCode = ErrorCode.TC_INTERFACE_CIRCULAR_INHERITANCE;
            accept('error',
                `Circular interface inheritance detected: ${circularRef}`,
                {
                    node: node,
                    code: errorCode
                }
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
            const parentType = this.typeProvider.getType(extendedRef);
            const resolvedParent = isReferenceType(parentType)
                ? this.typeProvider.resolveReference(parentType)
                : parentType;

            // Use asInterfaceType to handle both direct interfaces and join types that resolve to interfaces
            const parentInterface = this.typeUtils.asInterfaceType(resolvedParent);
            
            if (!parentInterface) {
                const errorCode = ErrorCode.TC_INTERFACE_INVALID_SUPERTYPE;
                accept('error',
                    `Interface can only extend other interfaces, but '${resolvedParent.toString()}' is not an interface`,
                    {
                        node: extendedRef,
                        code: errorCode
                    }
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

    /**
     * Detects circular inheritance in interfaces.
     * Returns the cycle path as a string if found, undefined otherwise.
     *
     * @param node Current interface node being checked
     * @param visited Set of interface nodes already visited in this path
     * @param path Array of interface names forming the current path
     * @returns Cycle description string if circular reference found, undefined otherwise
     */
    private detectCircularInheritance(
        node: ast.InterfaceType,
        visited: Set<ast.InterfaceType>,
        path: string[]
    ): string | undefined {
        // If we've already visited this node in the current path, we found a cycle
        if (visited.has(node)) {
            // Find where the cycle starts
            const nodeType = this.typeProvider.getType(node);
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
        const nodeType = this.typeProvider.getType(node);
        const nodeName = isInterfaceType(nodeType) ? nodeType.toString() : 'unknown';
        path.push(nodeName);

        // Check all supertypes
        if (node.superTypes) {
            for (const superTypeRef of node.superTypes) {
                const superType = this.typeProvider.getType(superTypeRef);
                
                // Resolve reference to get the actual interface
                const resolvedSuper = isReferenceType(superType)
                    ? this.typeProvider.resolveReference(superType)
                    : superType;

                // Use asInterfaceType to handle join types
                const superInterface = this.typeUtils.asInterfaceType(resolvedSuper);
                
                if (superInterface && superInterface.node && ast.isInterfaceType(superInterface.node)) {
                    // Recursively check the supertype
                    const result = this.detectCircularInheritance(
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
     * Check class implementation of interfaces.
     *
     * When a class declares it extends interfaces (e.g., `class Container<T>`),
     * validate that it properly implements all required methods.
     */
    checkClassImplementation = (node: ast.ClassType, accept: ValidationAcceptor): void => {
        if (!node.superTypes || node.superTypes.length === 0) {
            return; // No interfaces to implement
        }

        // Get the class type
        const classType = this.typeProvider.getType(node);
        if (!isClassType(classType)) {
            return;
        }

        // Check each extended interface
        for (const superTypeRef of node.superTypes) {
            const interfaceType = this.typeProvider.getType(superTypeRef);
            const resolvedInterface = isReferenceType(interfaceType)
                ? this.typeProvider.resolveReference(interfaceType)
                : interfaceType;

            if (!isInterfaceType(resolvedInterface)) {
                continue;
            }

            // Use the existing compatibility check from type-utils
            const compatResult = this.typeUtils.isClassAssignableToInterface(classType, resolvedInterface);
            if (!compatResult.success) {
                const errorCode = ErrorCode.TC_VARIABLE_INTERFACE_IMPLEMENTATION_ERROR;
                const errorMsg = `Class must implement interface '${resolvedInterface.toString()}': ${compatResult.message}`;
                accept('error', errorMsg, {
                    node: superTypeRef,
                    code: errorCode
                });
            }
        }
    }

    /**
     * Check member access for proper usage of optional chaining.
     *
     * Rules:
     * 1. Accessing a nullable type with `.` → error (should use `?.`)
     *    UNLESS there's `?.` somewhere in the parent chain (nullability propagation)
     * 2. Accessing a non-nullable type with `?.` → warning
     *
     * Examples:
     * - `e?.serialize()` where `e: Entity?` → ✅ OK
     * - `e.serialize()` where `e: Entity?` → ❌ Error
     * - `e?.serialize()` where `e: Entity` → ⚠️ Warning
     * - `e.serialize()` where `e: Entity` → ✅ OK
     * - `c?.getData().getValue()` → ✅ OK (nullability propagates from `?.`)
     */
    checkMemberAccess = (node: ast.MemberAccess, accept: ValidationAcceptor): void => {
        const baseType = this.typeProvider.getType(node.expr);
        const isBaseNullable = isNullableType(baseType);
        const usesOptionalChaining = node.isNullable;
        
        // Check if optional chaining is used anywhere in the parent chain
        const hasOptionalChainingInChain = this.hasOptionalChaining(node.expr);

        // Rule 1: Accessing nullable type with regular `.`
        // EXCEPTION: If there's `?.` in the parent chain, nullability propagates so `.` is OK
        if (isBaseNullable && !usesOptionalChaining && !hasOptionalChainingInChain) {
            const errorCode = ErrorCode.TC_NULLABLE_ACCESSED_WITHOUT_OPTIONAL_CHAINING;
            accept('error',
                `Cannot access member of nullable type '${baseType.toString()}' using '.'. Use optional chaining '?.' instead, or unwrap with '!' if you're certain the value is not null.`,
                {
                    node,
                    property: 'element',
                    code: errorCode
                }
            );
            return;
        }

        // Rule 2: Accessing non-nullable type with `?.`
        if (!isBaseNullable && usesOptionalChaining) {
            const errorCode = ErrorCode.TC_NON_NULLABLE_ACCESSED_WITH_OPTIONAL_CHAINING;
            accept('warning',
                `Unnecessary optional chaining: Type '${baseType.toString()}' is not nullable. Use regular member access '.' instead.`,
                {
                    node,
                    property: 'element',
                    code: errorCode
                }
            );
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
                let resolvedType = spreadType;
                if (isReferenceType(spreadType)) {
                    const resolved = this.typeProvider.resolveReference(spreadType);
                    if (resolved) {
                        resolvedType = resolved;
                    }
                }
                
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
     * Check new expression for proper class instantiation.
     *
     * Rules:
     * 1. `new` can only be used with class types
     * 2. Cannot use `new` with interfaces, structs, primitives, or other types
     *
     * Examples:
     * ```tc
     * class Person { let name: string }
     * let p = new Person("Alice")           // ✅ OK
     * let x = new u32()                     // ❌ Error - cannot instantiate primitive
     * let s = new {x: u32}()                // ❌ Error - cannot instantiate struct type
     * interface I { fn foo() }
     * let i = new I()                       // ❌ Error - cannot instantiate interface
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
        let resolvedType = instanceType;
        if (isReferenceType(instanceType)) {
            const resolved = this.typeProvider.resolveReference(instanceType);
            if (resolved) {
                resolvedType = resolved;
            }
        }

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
}