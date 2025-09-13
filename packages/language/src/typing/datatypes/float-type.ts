import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription } from "./base.js";


export interface FloatTypeDescription extends AbstractTypeDescription {
    $type: 'FloatType';
    name: 'f32' | 'f64';
    $node?: AstNode;
}

export function createFloatType(name: 'f32' | 'f64', node?: AstNode): FloatTypeDescription {
    return {
        $type: 'FloatType',
        name,
        $node: node,
        toString() { return this.name; },
    };
}

export function isDescFloatType(type: TypeDescription): type is FloatTypeDescription {
    return type.$type === 'FloatType';
}
