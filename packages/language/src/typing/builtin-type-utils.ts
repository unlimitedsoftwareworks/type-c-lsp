/**
 * Built-in Type Utilities
 * 
 * Utilities for working with built-in prototype types (arrays, coroutines).
 */

import { TypeDescription, isArrayType, isCoroutineType, PrototypeMethodType } from "./type-c-types.js";
import * as factory from "./type-factory.js";

/**
 * Gets the return type for array prototype methods.
 * 
 * It is not trivial to extract generic types from built-in functions,
 * however, they are few and we can reason about them by name.
 * 
 * @param prototypeFunction - The prototype function being called
 * @param baseExprType - The array type that the method is called on
 * @returns The return type of the prototype method
 */
export function getArrayPrototypeReturnType(
    prototypeFunction: PrototypeMethodType,
    baseExprType: TypeDescription
): TypeDescription {
    if (!isArrayType(baseExprType)) {
        return factory.createErrorType('Array prototype method called on non-array type');
    }

    switch (prototypeFunction.name) {
        case "slice":
            // slice returns a new array of the same element type
            return factory.createArrayType(baseExprType.elementType);
        case "resize":
            // resize returns void
            return factory.createVoidType(prototypeFunction.functionType.node);
        case "length":
            // length is a property, returns u32
            return factory.createU32Type(prototypeFunction.functionType.node);
        default:
            return prototypeFunction.functionType.returnType;
    }
}

/**
 * Gets the return type for coroutine prototype methods.
 * 
 * @param prototypeFunction - The prototype function being called
 * @param baseExprType - The coroutine type that the method is called on
 * @returns The return type of the prototype method
 */
export function getCoroutinePrototypeReturnType(
    prototypeFunction: PrototypeMethodType,
    baseExprType: TypeDescription
): TypeDescription {
    if (!isCoroutineType(baseExprType)) {
        return factory.createErrorType('Coroutine prototype method called on non-coroutine type');
    }

    switch (prototypeFunction.name) {
        case "next":
            // next() returns the yield type wrapped in an option-like type
            // For now, just return the yield type
            return baseExprType.yieldType;
        case "resume":
            // resume() returns void
            return factory.createVoidType(prototypeFunction.functionType.node);
        default:
            return prototypeFunction.functionType.returnType;
    }
}
