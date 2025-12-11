import { AstNode } from "langium";
import * as ast from "../generated/ast.js";
import { isEnumType, TypeDescription, TypeKind } from "../typing/type-c-types.js";

/**
 * Helper method to check if a type is numeric
 */
export function isNumericType(type: TypeDescription): boolean {
    const numericKinds = [
        TypeKind.U8, TypeKind.U16, TypeKind.U32, TypeKind.U64,
        TypeKind.I8, TypeKind.I16, TypeKind.I32, TypeKind.I64,
        TypeKind.F32, TypeKind.F64
    ];
    return numericKinds.includes(type.kind) || isEnumType(type);
}

/**
 * Get the containing do expression if the node is within one (but not within a nested function).
 * Returns undefined if the node is within a function or not within a do expression.
 *
 * This is used to determine if a return statement should use contextual typing from the do expression
 * instead of from a function's return type.
 */
export function getContainingDoExpression(node: AstNode): ast.DoExpression | undefined {
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