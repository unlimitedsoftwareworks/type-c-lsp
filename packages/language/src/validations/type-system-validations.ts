import { AstNode, ValidationAcceptor, ValidationChecks } from "langium";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";
import {
    ArrayTypeDescription,
    ErrorTypeDescription,
    TypeDescription,
    TypeKind,
    isArrayType,
    isClassType,
    isFunctionType,
    isInterfaceType,
    isReferenceType,
    isVariantConstructorType
} from "../typing/type-c-types.js";
import { isAssignable, substituteGenerics } from "../typing/type-utils.js";
import { TypeCBaseValidation } from "./base-validation.js";
import * as valUtils from "./tc-valdiation-helper.js";

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

    constructor(services: TypeCServices) {
        super();
        this.typeProvider = services.typing.TypeProvider;
    }

    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            VariableDeclSingle: this.checkVariableDeclSingle,
            BinaryExpression: this.checkBinaryExpression,
            FunctionCall: this.checkFunctionCall,
            ReturnStatement: this.checkReturnStatement,
            FunctionDeclaration: this.checkFunctionDeclaration,
            IndexSet: this.checkIndexSet,
            ReverseIndexSet: this.checkReverseIndexSet,
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
            if (isInterfaceType(expectedType) && isClassType(inferredType)) {
                // Special formatting for interface implementation errors
                errorMsg = `Variable '${node.name}' requires that '${inferredType.toString()}' implements '${expectedType.toString()}'`;
                if (compatResult.message) {
                    errorMsg += `. ${compatResult.message}`;
                }
            } else {
                // General type mismatch
                errorMsg = compatResult.message
                    ? `Type mismatch: ${compatResult.message}`
                    : `Type mismatch: expected '${expectedType.toString()}' but got '${inferredType.toString()}'`;
            }
            accept('error', errorMsg, {
                node: node.initializer,
                property: 'initializer',
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
                const errorMsg = compatResult.message
                    ? `Cannot assign: ${compatResult.message}`
                    : `Cannot assign '${rightType.toString()}' to '${leftType.toString()}'`;
                accept('error', errorMsg, {
                    node: node.right,
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
                    accept('error', `Cannot concatenate '${leftType.toString()}' and '${rightType.toString()}'`, {
                        node,
                    });
                }
                return;
            }

            // Numeric addition: allow mixed integer/float
            if (valUtils.isNumericType(leftType) && valUtils.isNumericType(rightType)) {
                // Allow any numeric combination (int+float, float+int, etc.)
                return;
            }

            accept('error', `Operator '+' requires numeric or string operands`, {
                node,
            });
            return;
        }

        // Arithmetic operators (excluding +): both sides must be numeric, allow mixed int/float
        const arithmeticOps = ['-', '*', '/', '%', '<<', '>>', '&', '|', '^'];
        if (arithmeticOps.includes(node.op)) {
            const leftIsNumeric = valUtils.isNumericType(leftType);
            const rightIsNumeric = valUtils.isNumericType(rightType);

            if (!leftIsNumeric || !rightIsNumeric) {
                accept('error', `Operator '${node.op}' requires numeric operands`, {
                    node,
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
                accept('warning', `Comparing incompatible types '${leftType.toString()}' and '${rightType.toString()}'`, {
                    node,
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
        const fnType = this.typeProvider.getType(node.expr);

        if (!isFunctionType(fnType)) {
            // Not a function - let another validation handle this
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
                accept('error', `Expected ${genericParams.length} type argument(s), but got ${node.genericArgs.length}`, {
                    node,
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
                type: substituteGenerics(param.type, finalSubstitutions),
                isMut: param.isMut
            }));
        }

        // Check argument count
        if (args.length !== paramTypes.length) {
            accept('error', `Expected ${paramTypes.length} argument(s), but got ${args.length}`, {
                node,
            });
            return;
        }

        // Check each argument type
        args.forEach((arg, index) => {
            const expectedType = paramTypes[index].type;
            const actualType = this.typeProvider.getType(arg);

            const compatResult = this.isTypeCompatible(actualType, expectedType);
            if (!compatResult.success) {
                const errorMsg = compatResult.message
                    ? `Argument ${index + 1}: ${compatResult.message}`
                    : `Argument ${index + 1}: expected '${expectedType.toString()}' but got '${actualType.toString()}'`;
                accept('error', errorMsg, {
                    node: arg,
                });
            }
        });
    }

    /**
     * Check return statements against function return type.
     */
    checkReturnStatement = (node: ast.ReturnStatement, accept: ValidationAcceptor): void => {
        // Find the containing function
        let current: AstNode | undefined = node.$container;
        while (current && !ast.isFunctionDeclaration(current)) {
            current = current.$container;
        }

        if (!current || !ast.isFunctionDeclaration(current)) {
            return; // Not in a function
        }

        const fn: ast.FunctionDeclaration = current;
        if (!fn.header.returnType) {
            return; // No explicit return type
        }

        const expectedReturnType = this.typeProvider.getType(fn.header.returnType);

        if (node.expr) {
            const actualType = this.typeProvider.getType(node.expr);
            const compatResult = this.isTypeCompatible(actualType, expectedReturnType);
            if (!compatResult.success) {
                const errorMsg = compatResult.message
                    ? `Return type mismatch: ${compatResult.message}`
                    : `Return type mismatch: expected '${expectedReturnType.toString()}' but got '${actualType.toString()}'`;
                accept('error', errorMsg, {
                    node: node.expr,
                });
            }
        } else {
            // Return with no value
            if (expectedReturnType.kind !== TypeKind.Void) {
                accept('error', `Function must return a value of type '${expectedReturnType.toString()}'`, {
                    node,
                });
            }
        }
    }

    /**
     * Check function declarations for return type issues.
     * 
     * Validates:
     * 1. If no explicit return type → ensure we can infer successfully (no error type)
     * 2. If explicit return type → ensure inferred type matches declared type
     * 
     * Examples:
     * ```
     * fn bad() = match n { 0 => 1, _ => "oops" }  // ❌ Can't infer common type
     * fn good() -> u32 = ...                       // ✅ Explicit type
     * fn good2() = 42                              // ✅ Can infer u32
     * ```
     */
    checkFunctionDeclaration = (node: ast.FunctionDeclaration, accept: ValidationAcceptor): void => {
        const fnType = this.typeProvider.getType(node);

        if (!isFunctionType(fnType)) {
            return; // Not a function type (shouldn't happen)
        }

        const inferredReturnType = fnType.returnType;

        // Check 1: If inferred return type is an error, report it
        if (inferredReturnType.kind === TypeKind.Error) {
            const errorType = inferredReturnType as ErrorTypeDescription;
            const message = errorType.message || 'Cannot infer return type';

            // Don't report recursion placeholder errors (they're handled during inference)
            if (message === '__recursion_placeholder__') {
                return;
            }

            // Highlight the entire function declaration for visibility
            accept('error', message, {
                node: node,
            });
            return;
        }

        // Check 2: If explicit return type, validate it matches inferred type
        if (node.header.returnType) {
            const declaredReturnType = this.typeProvider.getType(node.header.returnType);

            const compatResult = this.isTypeCompatible(inferredReturnType, declaredReturnType);
            if (!compatResult.success) {
                const errorMsg = compatResult.message
                    ? `Function return type mismatch: ${compatResult.message}`
                    : `Function return type mismatch: declared '${declaredReturnType.toString()}' but inferred '${inferredReturnType.toString()}'`;
                accept('error', errorMsg, {
                    node: node.header.returnType,
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
            const arrayType = baseType as ArrayTypeDescription;
            const compatResult = this.isTypeCompatible(valueType, arrayType.elementType);
            if (!compatResult.success) {
                const errorMsg = compatResult.message
                    ? `Cannot assign to array: ${compatResult.message}`
                    : `Cannot assign '${valueType.toString()}' to array of '${arrayType.elementType.toString()}'`;
                accept('error', errorMsg, {
                    node: node.value,
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
                        const errorMsg = compatResult.message
                            ? `Cannot assign to index: ${compatResult.message}`
                            : `Cannot assign '${valueType.toString()}' to '${valueParam.type.toString()}'`;
                        accept('error', errorMsg, {
                            node: node.value,
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
            const arrayType = baseType as ArrayTypeDescription;
            const compatResult = this.isTypeCompatible(valueType, arrayType.elementType);
            if (!compatResult.success) {
                const errorMsg = compatResult.message
                    ? `Cannot assign to array: ${compatResult.message}`
                    : `Cannot assign '${valueType.toString()}' to array of '${arrayType.elementType.toString()}'`;
                accept('error', errorMsg, {
                    node: node.value,
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
                        const errorMsg = compatResult.message
                            ? `Cannot assign to reverse index: ${compatResult.message}`
                            : `Cannot assign '${valueType.toString()}' to '${valueParam.type.toString()}'`;
                        accept('error', errorMsg, {
                            node: node.value,
                        });
                    }
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
        return isAssignable(actual, expected);
    }

}