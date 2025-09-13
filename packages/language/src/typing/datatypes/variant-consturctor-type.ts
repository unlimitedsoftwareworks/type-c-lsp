import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface VariantConstructorTypeDescription extends AbstractTypeDescription {
    $type: 'VariantConstructorType';
    name: string;
    $node?: AstNode;
    parameters: {name: string, type: TypeDescription}[];
    baseVariant?: TypeDescription;
    toString: () => string;
}

export function createVariantConstructorType(
    name: string, 
    parameters: {name: string, type: TypeDescription, node?: AstNode}[], 
    baseVariant?: TypeDescription,
    node?: AstNode
): VariantConstructorTypeDescription {
    return {
        $type: 'VariantConstructorType',
        name,
        baseVariant,
        parameters,
        $node: node,
        toString() {
             return getNameFromAstNode(this.$node) ??
                `${this.name}(${this.parameters.map(p => `${p.name}: ${p.type.toString()}`).join(", ")})`; 
        }
    };
}

export function isDescVariantConstructorType(type: TypeDescription): type is VariantConstructorTypeDescription {
    return type.$type === 'VariantConstructorType';
}
