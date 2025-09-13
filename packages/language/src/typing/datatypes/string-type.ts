import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription } from "./base.js";

export interface StringTypeDescription extends AbstractTypeDescription {
    $type: 'StringType';
    $node?: AstNode;
}

export function createStringType(node?: AstNode): StringTypeDescription {
    return {
        $type: 'StringType',
        $node: node,
        toString: () => 'string'
    };
}

export function isStringType(type: TypeDescription): type is StringTypeDescription {
    return type.$type === 'StringType';
}
