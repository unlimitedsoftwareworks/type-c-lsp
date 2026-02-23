import { AstNode } from 'langium';
import * as ast from "../generated/ast.js";
import {
    isClassType,
    isErrorType,
    isIntegerType,
    isNumericType,
    isStringEnumType,
    isStringLiteralType,
    isStringType,
    TypeDescription,
    TypeKind
} from './type-c-types.js';
import type { TypeCTypeFactory } from './type-factory.js';
import type { TypeCTypeUtils } from './type-utils.js';

export function isAssignmentOperator(op: ast.BinaryExpression['op']): boolean {
    return ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='].includes(op);
}

/**
 * Checks if a type is a string-like type that supports concatenation via `+`.
 */
export function isStringConcatenationType(type: TypeDescription): boolean {
    return isStringType(type) || isStringLiteralType(type) || isStringEnumType(type);
}

// --- Primitive result type computation (used by type inference) ---

/**
 * Computes the result type of a binary operation on primitive types.
 * Does NOT handle operator overloads or generic constraints — those are
 * resolved by the caller before falling through to this function.
 *
 * Returns undefined if the primitive rules don't apply (e.g. unknown operator combo).
 */
export function computeBinaryResultType(
    op: string,
    left: TypeDescription,
    right: TypeDescription,
    typeUtils: TypeCTypeUtils,
    typeFactory: TypeCTypeFactory,
    node: AstNode
): TypeDescription | undefined {
    // Comparison operators → bool
    if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
        return typeFactory.createBoolType(node);
    }

    // Logical operators → bool
    if (['&&', '||'].includes(op)) {
        return typeFactory.createBoolType(node);
    }

    // String concatenation: string + X or X + string → string
    if (op === '+') {
        if (isStringConcatenationType(left) || isStringConcatenationType(right)) {
            return typeFactory.createStringType(node);
        }
    }

    // Arithmetic operators → common numeric type
    if (['+', '-', '*', '/', '%'].includes(op)) {
        const resolvedLeft = typeUtils.resolveIfReference(left);
        const resolvedRight = typeUtils.resolveIfReference(right);
        if (isNumericType(resolvedLeft) && isNumericType(resolvedRight)) {
            const commonNumeric = typeUtils.getCommonType([resolvedLeft, resolvedRight]);
            if (!isErrorType(commonNumeric)) {
                return commonNumeric;
            }
        }
    }

    // Bitwise operators → common numeric type
    if (['&', '|', '^', '<<', '>>'].includes(op)) {
        const resolvedLeft = typeUtils.resolveIfReference(left);
        const resolvedRight = typeUtils.resolveIfReference(right);
        if (isNumericType(resolvedLeft) && isNumericType(resolvedRight)) {
            const commonNumeric = typeUtils.getCommonType([resolvedLeft, resolvedRight]);
            if (!isErrorType(commonNumeric)) {
                return commonNumeric;
            }
        }
    }

    return undefined;
}

/**
 * Computes the result type of a unary operation on primitive types.
 * Does NOT handle operator overloads or generic constraints.
 *
 * Returns undefined if the primitive rules don't apply.
 * Returns an error type for unsigned negation.
 */
export function computeUnaryResultType(
    op: string,
    operand: TypeDescription,
    typeUtils: TypeCTypeUtils,
    typeFactory: TypeCTypeFactory,
    node: AstNode
): TypeDescription | undefined {
    // ! → bool
    if (op === '!') {
        return typeFactory.createBoolType(node);
    }

    // Unary minus: check for unsigned integer error
    if (op === '-') {
        const resolved = typeUtils.resolveIfReference(operand);
        if (isIntegerType(resolved)) {
            if (!resolved.signed) {
                return typeFactory.createErrorType(
                    `Cannot apply unary minus to unsigned type '${resolved.toString()}'. Use explicit cast to signed type if negation is intended: -(x as i${resolved.bits})`,
                    undefined,
                    node
                );
            }
        }
    }

    // - and ~ preserve the operand type (numeric passthrough)
    if (op === '-' || op === '~') {
        if (isNumericType(typeUtils.resolveIfReference(operand))) {
            return operand;
        }
    }

    return undefined;
}

// --- Primitive result type for constraint resolution (used by resolveOperatorResultType) ---

/**
 * Computes the primitive result type for constraint resolution contexts.
 * Stricter than computeBinaryResultType: logical operators require bool operands,
 * `!` requires bool, `-`/`~` require numeric.
 *
 * Returns undefined if no primitive rule matches.
 */
export function computeBinaryResultTypeStrict(
    op: string,
    leftType: TypeDescription,
    rightType: TypeDescription,
    typeUtils: TypeCTypeUtils,
    typeFactory: TypeCTypeFactory,
    node: AstNode
): TypeDescription | undefined {
    // Comparison operators → bool
    if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
        return typeFactory.createBoolType(node);
    }

    // String concatenation
    if (op === '+') {
        if (isStringConcatenationType(leftType) || isStringConcatenationType(rightType)) {
            return typeFactory.createStringType(node);
        }
    }

    // Numeric arithmetic
    if (['+', '-', '*', '/', '%'].includes(op)) {
        const resolvedLeft = typeUtils.resolveIfReference(leftType);
        const resolvedRight = typeUtils.resolveIfReference(rightType);
        if (isNumericType(resolvedLeft) && isNumericType(resolvedRight)) {
            const commonNumeric = typeUtils.getCommonType([resolvedLeft, resolvedRight]);
            if (!isErrorType(commonNumeric)) return commonNumeric;
        }
    }

    // Bitwise operators
    if (['&', '|', '^', '<<', '>>'].includes(op)) {
        const resolvedLeft = typeUtils.resolveIfReference(leftType);
        const resolvedRight = typeUtils.resolveIfReference(rightType);
        if (isNumericType(resolvedLeft) && isNumericType(resolvedRight)) {
            const commonNumeric = typeUtils.getCommonType([resolvedLeft, resolvedRight]);
            if (!isErrorType(commonNumeric)) return commonNumeric;
        }
    }

    // Logical → bool (only valid on bool operands)
    if (['&&', '||'].includes(op)) {
        const resolvedLeft = typeUtils.resolveIfReference(leftType);
        const resolvedRight = typeUtils.resolveIfReference(rightType);
        if (resolvedLeft.kind === TypeKind.Bool && resolvedRight.kind === TypeKind.Bool) {
            return typeFactory.createBoolType(node);
        }
    }

    return undefined;
}

/**
 * Computes the primitive result type for unary operations in constraint resolution.
 * Stricter: `!` requires bool, `-`/`~` require numeric.
 */
export function computeUnaryResultTypeStrict(
    op: string,
    operandType: TypeDescription,
    typeUtils: TypeCTypeUtils,
    typeFactory: TypeCTypeFactory,
    node: AstNode
): TypeDescription | undefined {
    if (op === '!') {
        const resolved = typeUtils.resolveIfReference(operandType);
        if (resolved.kind === TypeKind.Bool) {
            return typeFactory.createBoolType(node);
        }
    }
    if (op === '-' || op === '~') {
        if (isNumericType(operandType)) return operandType;
    }
    return undefined;
}

// --- Validity checks (used by the validator) ---

/**
 * Checks if a binary operator is valid for the given concrete types.
 * Handles numeric ops, string concatenation, bool logic, equality,
 * class operator overloads, and interface operator overloads.
 *
 * @param isNumericCheck - numeric type predicate (may include enums)
 */
export function isBinaryOpValid(
    op: string,
    leftType: TypeDescription,
    rightType: TypeDescription,
    typeUtils: TypeCTypeUtils,
    isNumericCheck: (type: TypeDescription) => boolean
): boolean {
    const resolvedLeft = typeUtils.resolveIfReference(leftType);
    const resolvedRight = typeUtils.resolveIfReference(rightType);

    // Numeric types support arithmetic, comparison, and bitwise operators
    const numericOps = ['+', '-', '*', '/', '%', '<', '>', '<=', '>=', '==', '!=', '&', '|', '^', '<<', '>>'];
    if (isNumericCheck(resolvedLeft) && isNumericCheck(resolvedRight) && numericOps.includes(op)) {
        return true;
    }

    // String supports +
    if (op === '+' && (resolvedLeft.kind === TypeKind.String || resolvedRight.kind === TypeKind.String)) {
        return true;
    }

    // Bool supports && and ||
    if (['&&', '||'].includes(op) && resolvedLeft.kind === TypeKind.Bool && resolvedRight.kind === TypeKind.Bool) {
        return true;
    }

    // Comparison operators (==, !=) generally work for compatible types
    if (['==', '!='].includes(op)) {
        return true;
    }

    // Check for class operator overloads
    if (isClassType(resolvedLeft)) {
        const operatorMethods = resolvedLeft.methods.filter(m => m.names.includes(op));
        if (operatorMethods.some(method => {
            if (method.parameters.length !== 1) return false;
            return typeUtils.isAssignable(resolvedRight, method.parameters[0].type).success;
        })) {
            return true;
        }
    }

    // Check interface operator overloads
    const interfaceType = typeUtils.asInterfaceType(resolvedLeft);
    if (interfaceType) {
        const allMethods = typeUtils.collectAllInterfaceMethods(interfaceType);
        if (allMethods.some(method => {
            if (!method.names.includes(op)) return false;
            if (method.parameters.length !== 1) return false;
            return typeUtils.isAssignable(resolvedRight, method.parameters[0].type).success;
        })) {
            return true;
        }
    }

    return false;
}

/**
 * Checks if a unary operator is valid for the given concrete type.
 * Handles numeric -, ~, ++, --, bool !, and class/interface overloads.
 *
 * @param isNumericCheck - numeric type predicate (may include enums)
 */
export function isUnaryOpValid(
    op: string,
    operandType: TypeDescription,
    typeUtils: TypeCTypeUtils,
    isNumericCheck: (type: TypeDescription) => boolean
): boolean {
    const resolved = typeUtils.resolveIfReference(operandType);

    // Numeric types support -, ~, ++, --
    if (isNumericCheck(resolved) && ['-', '~', '++', '--'].includes(op)) {
        return true;
    }

    // Bool supports !
    if (op === '!' && resolved.kind === TypeKind.Bool) return true;

    // Check for class operator overloads
    if (isClassType(resolved)) {
        const operatorMethods = resolved.methods.filter(m => m.names.includes(op));
        if (operatorMethods.some(method => method.parameters.length === 0)) {
            return true;
        }
    }

    // Check interface operator overloads
    const interfaceType = typeUtils.asInterfaceType(resolved);
    if (interfaceType) {
        const allMethods = typeUtils.collectAllInterfaceMethods(interfaceType);
        if (allMethods.some(method => {
            if (!method.names.includes(op)) return false;
            return method.parameters.length === 0;
        })) {
            return true;
        }
    }

    return false;
}
