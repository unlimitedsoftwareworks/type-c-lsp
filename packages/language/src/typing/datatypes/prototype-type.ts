/**
 * A prototype is a built-in type dedicated to the LSP server to auto-complete prototypes for arrays and coroutines.
 * This is not part of the language spec, it is only used by the LSP server.
 */
import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface PrototypeFunctionParameterDescription {
    name: string;
    type: TypeDescription;
    isMut: boolean;
    node?: AstNode;
    toString: () => string;
}

export function createPrototypeFunctionParameterDescription(
    name: string, 
    type: TypeDescription, 
    isMut: boolean, 
    node?: AstNode
): PrototypeFunctionParameterDescription {
    return {
        name,
        type,
        isMut,
        node,
        toString() { return `${this.isMut ? "mut " : ""}${this.name}: ${this.type.toString()}`; }
    };
}

export interface PrototypeFunctionTypeDescription extends AbstractTypeDescription {
    $type: 'PrototypeFunctionType';
    parameters: PrototypeFunctionParameterDescription[];
    returnType: TypeDescription | undefined;
}

export function createPrototypeFunctionType(parameters: PrototypeFunctionParameterDescription[], returnType: TypeDescription | undefined, node?: AstNode): PrototypeFunctionTypeDescription {
    return {
        $type: 'PrototypeFunctionType',
        parameters,
        returnType,
        $node: node,
        toString() { 
            return getNameFromAstNode(this.$node) ?? `prototype fn (${this.parameters.map(p => p.toString()).join(", ")}) ${this.returnType? "-> " + this.returnType.toString() : ""}`; 
        }
    };
}

export function isDescPrototypeFunctionType(type: TypeDescription): type is PrototypeFunctionTypeDescription {
    return type.$type === 'PrototypeFunctionType';
}
