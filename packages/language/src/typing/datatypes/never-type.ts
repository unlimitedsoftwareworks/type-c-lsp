import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription } from "./base.js";

export interface NeverType extends AbstractTypeDescription {
    $type: 'NeverType';
}

export function createNeverType(node?: AstNode): NeverType {
    return {
        $type: 'NeverType',
        $node: node,
        toString() { return "never"; }
    };
}

export function isDescNeverType(type: TypeDescription): type is NeverType {
    return type.$type === 'NeverType';
}