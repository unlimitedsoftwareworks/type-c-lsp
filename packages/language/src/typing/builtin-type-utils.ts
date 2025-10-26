import { ArrayTypeDescription, createArrayType } from "./datatypes/array-type.js";
import { PrototypeFunctionTypeDescription } from "./datatypes/prototype-type.js";
import { TypeDescription } from "./type-c-types.js";
import * as ast from "../generated/ast.js";
import { createVoidType } from "./datatypes/void-type.js";
import { CoroutineTypeDescription } from "./datatypes/coroutine-type.js";

/**
 * It is not trivial to me on how to extract the generic types from built-in functions,
 * However, they are few and we can reason about them by name
 * @param type 
 * @param baseExprType 
 * @returns 
 */
export function getArrayPrototypeReturnType(type: PrototypeFunctionTypeDescription, baseExprType: ArrayTypeDescription): TypeDescription {
    switch ((type.$node as ast.BuiltinSymbolFn).name) {
        case "slice":
            return createArrayType(baseExprType.elementType);
        default:
            return type.returnType ?? createVoidType();
    }
}

export function getCoroutinePrototypeReturnType(type: PrototypeFunctionTypeDescription, baseExprType: CoroutineTypeDescription): TypeDescription {
    switch ((type.$node as ast.BuiltinSymbolFn).name) {
        default:
            return type.returnType ?? createVoidType();
    }
}