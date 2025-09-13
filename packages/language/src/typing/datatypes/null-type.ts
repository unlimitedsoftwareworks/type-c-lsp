import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface NullTypeDescription extends AbstractTypeDescription {
    $type: 'NullType';
    $node?: AstNode;
}

export function createNullType(node?: AstNode): NullTypeDescription {
    return {
        $type: 'NullType',
        $node: node,
        toString: () => getNameFromAstNode(node) ?? 'null',
    };
}

export function isNullType(type: TypeDescription): type is NullTypeDescription {
    return type.$type === 'NullType';
}
