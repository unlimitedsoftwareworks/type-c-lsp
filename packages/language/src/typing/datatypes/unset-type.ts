import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription } from "./base.js";

/**
 * an Unset type is the type of a node that is still being computed. 
 * This is used when inferring function return types mostly.
 */

export interface UnsetTypeDescription extends AbstractTypeDescription {
    $type: 'UnsetType';
}

export function createUnsetType(node?: AstNode): UnsetTypeDescription {
    return {
        $type: 'UnsetType',
        $node: node,
        toString() { return "unset"; }
    };
}

export function isDescUnsetType(type: TypeDescription): type is UnsetTypeDescription {
    return type.$type === 'UnsetType';
}