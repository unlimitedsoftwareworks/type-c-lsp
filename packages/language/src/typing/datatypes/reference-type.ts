import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription } from "./base.js";

export interface ReferenceTypeDescription extends AbstractTypeDescription {
    $type: 'ReferenceType';
    name: string;
    typeArgs: AbstractTypeDescription[];
    type: TypeDescription;
}

export function createReferenceType(
    name: string, 
    typeArgs: TypeDescription[], 
    type: TypeDescription, 
    node?: AstNode
): ReferenceTypeDescription {
    return {
        $type: 'ReferenceType',
        name,
        typeArgs,
        type,
        $node: node,
        toString() { 
            return this.name; 
        }
    }
}

export function isDescReferenceType(type: TypeDescription): type is ReferenceTypeDescription {
    return type.$type === 'ReferenceType';
}
