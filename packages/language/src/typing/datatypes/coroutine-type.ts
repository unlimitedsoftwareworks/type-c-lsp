import { TypeDescription } from "../type-c-types.js";
import { AstNode } from "langium";
import { FunctionTypeDescription } from "./function-type.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface CoroutineTypeDescription extends AbstractTypeDescription {
    $type: 'CoroutineType';
    fnType: FunctionTypeDescription;
}

export function createCoroutineType(fnType: FunctionTypeDescription, node?: AstNode): CoroutineTypeDescription {
    return {
        $type: 'CoroutineType',
        fnType,
        $node: node,
        toString() { return getNameFromAstNode(this.$node) ?? `coroutine<${this.fnType.toString()}>`; },
    };
}

export function isDescCoroutineType(type: TypeDescription): type is CoroutineTypeDescription {
    return type.$type === 'CoroutineType';
}
