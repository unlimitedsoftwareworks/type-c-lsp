import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface GenericTypeDescription extends AbstractTypeDescription {
    $type: 'GenericType';
    name: string;
}

export function createGenericType(name: string, node?: AstNode): GenericTypeDescription {
    return {
        $type: 'GenericType',
        name,
        $node: node,
        toString() { return getNameFromAstNode(this.$node) ?? this.name; },
    };
}

export function isDescGenericType(type: TypeDescription): type is GenericTypeDescription {
    return type.$type === 'GenericType';
}