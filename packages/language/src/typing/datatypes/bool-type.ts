import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription } from "./base.js";

export interface BoolTypeDescription extends AbstractTypeDescription {
    $type: 'BoolType';
}

export function createBoolType(node?: AstNode): BoolTypeDescription {
    return {
        $type: 'BoolType',
        $node: node,
        toString: () => 'bool',
    };
}

export function isDescBoolType(type: TypeDescription): type is BoolTypeDescription {
    return type.$type === 'BoolType';
}