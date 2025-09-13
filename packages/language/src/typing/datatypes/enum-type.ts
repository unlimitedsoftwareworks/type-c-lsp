import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface EnumCaseDescription {
    name: string;
    value?: string;
    $node?: AstNode;
    toString(): string;
}

export function createEnumCaseDescription(name: string, value: string | undefined, node?: AstNode): EnumCaseDescription {
    return {
        name,
        value,
        $node: node,
        toString() { return `${this.name}${this.value ? ` = ${this.value}` : ""}`; },
    };
}

export interface EnumTypeDescription extends AbstractTypeDescription {
    $type: 'EnumType';
    cases: EnumCaseDescription[];
}

export function createEnumType(cases: EnumCaseDescription[], node?: AstNode): EnumTypeDescription {
    return {
        $type: 'EnumType',
        cases,
        $node: node,
        toString() { return getNameFromAstNode(this.$node) ?? `enum { ${this.cases.map(c => c.toString()).join(', ')} }`; },
    };
}

export function isDescEnumType(type: TypeDescription): type is EnumTypeDescription {
    return type.$type === 'EnumType';
}