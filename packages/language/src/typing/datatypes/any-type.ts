import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription } from "./base.js";

export interface AnyTypeDescription extends AbstractTypeDescription {
    $type: 'AnyType';
}

export function createAnyType(node?: AstNode): AnyTypeDescription {
    return {
        $type: 'AnyType',
        $node: node,
        toString: () => 'any',
    };
}

export function isDescAnyType(type: TypeDescription): type is AnyTypeDescription {
    return type.$type === 'AnyType';
}
