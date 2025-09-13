import { AstNode } from "langium";
import * as ast from "../../generated/ast.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

/**
 * @TODO:
 * think more about this ..
 */
export interface AnonymousVariantConstructorTypeDescription extends AbstractTypeDescription {
    $type: 'AnonymousVariantConstructorType';
    name: string;
    fields: ast.VariantConstructorField[];
}

export function createAnonymousVariantConstructorTypeDescription(name: string, fields: ast.VariantConstructorField[], node?: AstNode): AnonymousVariantConstructorTypeDescription {
    return {
        $type: 'AnonymousVariantConstructorType',
        name,
        fields,
        $node: node,
        toString() { return getNameFromAstNode(this.$node) ?? this.name; },
    };
}

