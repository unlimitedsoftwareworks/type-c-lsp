import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";


export interface UnionTypeDescription extends AbstractTypeDescription {
    $type: 'UnionType';
    left: TypeDescription;
    right: TypeDescription;
}

export function createUnionType(left: TypeDescription, right: TypeDescription, node?: AstNode): UnionTypeDescription {
    return {
        $type: 'UnionType',
        left,
        right,
        $node: node,
        toString() { return getNameFromAstNode(this.$node) ?? `${this.left.toString()} | ${this.right.toString()}`; }
    };
}