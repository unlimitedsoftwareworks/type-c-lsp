import * as ast from "../generated/ast.js";

export function isAssignmentOperator(op: ast.BinaryExpression['op']): boolean {
    return ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='].includes(op);
}