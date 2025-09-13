import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface TupleTypeDescription extends AbstractTypeDescription {
    $type: 'TupleType';
    elements: TypeDescription[];
    node?: AstNode;
    toString: () => string;
}

export function createTupleType(elements: TypeDescription[], node?: AstNode): TupleTypeDescription {
    return {
        $type: 'TupleType',
        elements,
        node,
        toString() { return getNameFromAstNode(this.$node) ?? `(${this.elements.map(e => e.toString()).join(", ")})`; }
    };
}

export function isDescTupleType(type: TypeDescription): type is TupleTypeDescription {
    return type.$type === 'TupleType';
}