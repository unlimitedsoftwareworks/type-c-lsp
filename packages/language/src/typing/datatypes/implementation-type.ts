import { AstNode } from "langium";
import * as ast from "../../generated/ast.js";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface ImplementationTypeDescription extends AbstractTypeDescription {
    $type: 'ImplementationType';
    supertypes: ast.DataType[];
    attributes: ast.ImplementationAttributeDecl[];
    methods: ast.MethodHeader[];
}

export function createImplementationType(
    supertypes: ast.DataType[], 
    attributes: ast.ImplementationAttributeDecl[], 
    methods: ast.MethodHeader[],
    node?: AstNode
): ImplementationTypeDescription {
    return {
        $type: 'ImplementationType',
        supertypes,
        attributes,
        methods,
        $node: node,
        // TODO: implement
        toString() { return getNameFromAstNode(this.$node) ?? `impl`; }
    };
}

export function isDescImplementationType(type: TypeDescription): type is ImplementationTypeDescription {
    return type.$type === 'ImplementationType';
}