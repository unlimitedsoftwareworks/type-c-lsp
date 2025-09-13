import { AbstractTypeDescription } from "./base.js";
import * as ast from "../../generated/ast.js";
import { TypeDescription } from "../type-c-types.js";

export interface FFIDefinitionTypeDescription extends AbstractTypeDescription {
    $type: 'FFIDefinition';
    name: string;
    $node: ast.ExternFFIDecl;
}

export function createFFIDefinitionType(name: string, node: ast.ExternFFIDecl): FFIDefinitionTypeDescription {
    return {
        $type: 'FFIDefinition',
        name,
        $node: node,
        toString() { return this.name; }
    };
}

export function isDescFFIDefinitionType(type: TypeDescription): type is FFIDefinitionTypeDescription {
    return type.$type === 'FFIDefinition';
}