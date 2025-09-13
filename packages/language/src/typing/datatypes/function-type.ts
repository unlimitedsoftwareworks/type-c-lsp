import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface FunctionParameterDescription {
    name: string;
    type: TypeDescription;
    isMut: boolean;
    node?: AstNode;
    toString: () => string;
}

export function createFunctionParameterDescription(
    name: string, 
    type: TypeDescription, 
    isMut: boolean, 
    node?: AstNode
): FunctionParameterDescription {
    return {
        name,
        type,
        isMut,
        node,
        toString() { return `${this.isMut ? "mut " : ""} ${this.name}: ${this.type.toString()}`; }
    };
}

export interface FunctionTypeDescription extends AbstractTypeDescription {
    $type: 'FunctionType';
    parameters: FunctionParameterDescription[];
    returnType: TypeDescription | undefined;
    // an fn or a cfn :thinkingface:
    isCoroutine: boolean;
}

export function createFunctionType(parameters: FunctionParameterDescription[], returnType: TypeDescription | undefined, isCoroutine: boolean, node?: AstNode): FunctionTypeDescription {
    return {
        $type: 'FunctionType',
        parameters,
        returnType,
        isCoroutine,
        $node: node,
        toString() { 
            return getNameFromAstNode(this.$node) ?? `${isCoroutine?"cfn":"fn"} (${this.parameters.map(p => p.toString()).join(", ")}) ${this.returnType? "-> " + this.returnType.toString() : ""}`; 
        }
    };
}

export function isDescFunctionType(type: TypeDescription): type is FunctionTypeDescription {
    return type.$type === 'FunctionType';
}
