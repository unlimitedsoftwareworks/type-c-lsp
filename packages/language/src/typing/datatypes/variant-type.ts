import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";
import { VariantConstructorTypeDescription } from "./variant-consturctor-type.js";

export interface VariantTypeDescription extends AbstractTypeDescription {
    $type: 'VariantType';
    constructors: VariantConstructorTypeDescription[];
}

export function createVariantType(constructors: VariantConstructorTypeDescription[], node?: AstNode): VariantTypeDescription {
    return {
        $type: 'VariantType',
        constructors,
        $node: node,
        toString() { return getNameFromAstNode(this.$node) ?? 
            `variant {
                ${this.constructors.map(c => c.toString()).join("\n")}
            }`; 
        }
    };
}

export function isDescVariantType(type: TypeDescription): type is VariantTypeDescription {
    return type.$type === 'VariantType';
}

export interface VariantDefinitionTypeDescription extends AbstractTypeDescription {
    $type: 'VariantDefinition';
    name: string;
    variant: VariantTypeDescription;
}

export function createVariantDefinitionType(name: string, variant: VariantTypeDescription, node?: AstNode): VariantDefinitionTypeDescription {
    return {
        $type: 'VariantDefinition',
        name,
        variant,
        $node: node,
        toString() { return `variant ${this.name}`; }
    };
}

export function isDescVariantDefinitionType(type: TypeDescription): type is VariantDefinitionTypeDescription {
    return type.$type === 'VariantDefinition';
}