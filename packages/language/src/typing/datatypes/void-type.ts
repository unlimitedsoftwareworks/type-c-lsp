import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface VoidTypeDescription extends AbstractTypeDescription {
    $type: 'VoidType';
    $node?: AstNode;
    toString: () => string;
}

export function createVoidType(node?: AstNode): VoidTypeDescription {
    return {
        $type: 'VoidType',
        $node: node,
        toString() { return getNameFromAstNode(this.$node) ?? "void"; }
    };
}

export function isDescVoidType(type: TypeDescription): type is VoidTypeDescription {
    return type.$type === 'VoidType';
}