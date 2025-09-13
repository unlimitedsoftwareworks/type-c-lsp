import { AstNode } from "langium";
export type AbstractTypeDescription = {
    $type: string;
    $node?: AstNode;
    toString(): string;
}

/**
 * Checks if the node is a reference to a type, then it returns the cst text of the node.
 * Useful to avoid displaying long descriptions, for those which have a reference defined already
 * @param node 
 * @returns 
 */
export function getNameFromAstNode(node: AstNode | undefined): string | undefined {
    if(!node) {
        return undefined;
    }

    return undefined;
}