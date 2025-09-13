import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface NullableTypeDescription extends AbstractTypeDescription {
    $type: 'NullableType';
    type: TypeDescription;
}

export function createNullableType(type: TypeDescription, node?: AstNode): NullableTypeDescription {
    return {
        $type: 'NullableType',
        type,
        $node: node,
        toString() { return getNameFromAstNode(this.$node) ?? `${this.type.toString()}?`; }
    };
}

export function isDescNullableType(type: TypeDescription): type is NullableTypeDescription {
    return type.$type === 'NullableType';
}