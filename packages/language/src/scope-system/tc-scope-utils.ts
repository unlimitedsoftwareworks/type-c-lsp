import { AstNode, ReferenceInfo } from "langium";
import * as ast from "../generated/ast.js";

export function isMemberResolution(container: AstNode, context: ReferenceInfo): boolean {
    // Check if we're resolving a member/method in any form
    if (ast.isMemberAccess(container) && (context.property === 'element')) {
        return true;
    }

    // Check if we're in a QualifiedReference and resolving a member/method
    if (container.$type === 'QualifiedReference') {
        // If we're resolving methods or members arrays
        if (context.property === 'methods' || context.property === 'members') {
            return true;
        }
    }

    return false;
}