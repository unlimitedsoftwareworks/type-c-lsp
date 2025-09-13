import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface StringEnumTypeDescription extends AbstractTypeDescription {
    $type: 'StringEnumType';
    cases: string[];
}

export function createStringEnumType(cases: string[], node?: AstNode): StringEnumTypeDescription {
    return {
        $type: 'StringEnumType',
        cases,
        $node: node,
        toString() { return getNameFromAstNode(this.$node) ?? this.cases.join(" | "); }
    };
}

export function isDescStringEnumType(type: TypeDescription): type is StringEnumTypeDescription {
    return type.$type === 'StringEnumType';
}
