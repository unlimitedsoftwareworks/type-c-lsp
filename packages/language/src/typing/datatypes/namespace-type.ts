import * as ast from "../../generated/ast.js"
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription } from "./base.js";

export interface NamespaceDefinitionTypeDescription extends AbstractTypeDescription {
    $type: 'NamespaceDefinition';
    name: string;
    $node: ast.NamespaceDecl;
}

export function createNamespaceDefinitionType(name: string, $node: ast.NamespaceDecl): NamespaceDefinitionTypeDescription {
    return {
        $type: 'NamespaceDefinition',
        name,
        $node,
        toString() {
            return 'namespace ' + name;
        }
    };
}

export function isDescNamespaceDefinitionType(type: TypeDescription): type is NamespaceDefinitionTypeDescription {
    return type.$type === 'NamespaceDefinition';
}