import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription } from "./base.js";

export interface ErrorTypeDescription extends AbstractTypeDescription {
    $type: 'ErrorType';
    message: string;
}

export function createErrorType(message: string, node?: AstNode): ErrorTypeDescription {
    return {
        $type: 'ErrorType',
        $node: node,
        message,
        toString() { return `error: ${this.message}`; }
    }
}

export function isDescErrorType(type: TypeDescription): type is ErrorTypeDescription {
    return type.$type === 'ErrorType';
}
