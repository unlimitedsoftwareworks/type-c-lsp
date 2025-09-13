import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface ArrayTypeDescription extends AbstractTypeDescription {
    $type: 'ArrayType';
    elementType: TypeDescription;
}

export function createArrayType(elementType: TypeDescription, node?: AstNode): ArrayTypeDescription {
    return {
        $type: 'ArrayType',
        elementType,
        $node: node,
        toString() { return getNameFromAstNode(this.$node) ?? `${this.elementType.toString()}[]`; },
    };
}

export function isDescArrayType(type: TypeDescription): type is ArrayTypeDescription {
    return type.$type === 'ArrayType';
}
