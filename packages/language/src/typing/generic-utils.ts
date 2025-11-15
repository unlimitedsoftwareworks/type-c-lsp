/**
 * Generic type inference utilities.
 *
 * This module provides helper functions for inferring generic type parameters
 * from concrete types during function calls and other generic instantiations.
 */

import * as factory from './type-factory.js';
import {
    TypeDescription,
    TypeKind,
    isArrayType,
    isFunctionType,
    isGenericType,
    isReferenceType,
    isVariantConstructorType
} from './type-c-types.js';

/**
 * Infer generic type parameters by matching a pattern type with a concrete type.
 *
 * This function recursively matches a type pattern containing generic parameters
 * with a concrete type, building a map of inferred generic substitutions.
 *
 * @param patternType The type pattern with generic parameters (e.g., T, Array<T>, fn(U) -> V)
 * @param concreteType The concrete type to match against (e.g., i32, Array<string>, fn(u32) -> f32)
 * @param inferredGenerics Map to store inferred generic parameters
 *
 * @example
 * // Direct generic matching
 * inferGenericsFromTypes(T, i32, map) → map.set('T', i32)
 *
 * @example
 * // Array matching
 * inferGenericsFromTypes(T[], u32[], map) → map.set('T', u32)
 *
 * @example
 * // Function matching
 * inferGenericsFromTypes(fn(U) -> V, fn(u32) -> f32, map) → map.set('U', u32), map.set('V', f32)
 *
 * @example
 * // Reference type matching
 * inferGenericsFromTypes(Result<T, E>, Result<i32, string>, map) → map.set('T', i32), map.set('E', string)
 */
export function inferGenericsFromTypes(
    patternType: TypeDescription,
    concreteType: TypeDescription,
    inferredGenerics: Map<string, TypeDescription>
): void {
    // If concrete type is a VariantConstructorType, extract its base variant
    // Example: Result.Ok(Option.Some(42)) should infer T = Option<i32>, not Option<i32>.Some
    if (isVariantConstructorType(concreteType)) {
        if (concreteType.variantDeclaration) {
            // Reconstruct a reference from the declaration and genericArgs
            concreteType = factory.createReferenceType(
                concreteType.variantDeclaration,
                concreteType.genericArgs,
                concreteType.node
            );
        } else {
            // Fallback to baseVariant for anonymous variants
            concreteType = concreteType.baseVariant;
        }
    }

    // If pattern is a generic parameter, infer its type from the concrete type
    if (isGenericType(patternType)) {
        const genericName = patternType.name;
        if (genericName) {
            const existing = inferredGenerics.get(genericName);

            // Set the generic if not yet inferred, or replace `never` with concrete type
            if (!existing || existing.kind === TypeKind.Never) {
                inferredGenerics.set(genericName, concreteType);
            }
        }
        return;
    }

    // If pattern is an array, try to infer element type
    // Example: T[] matches u32[] → infer T = u32
    if (isArrayType(patternType) && isArrayType(concreteType)) {
        inferGenericsFromTypes(
            patternType.elementType,
            concreteType.elementType,
            inferredGenerics
        );
        return;
    }

    // If pattern is a function type, infer from parameters and return type
    // Example: fn(a: U) -> V matches fn(a: u32) -> f32 → infer U = u32, V = f32
    if (isFunctionType(patternType) && isFunctionType(concreteType)) {
        // Infer from parameters
        const minParams = Math.min(patternType.parameters.length, concreteType.parameters.length);
        for (let i = 0; i < minParams; i++) {
            inferGenericsFromTypes(
                patternType.parameters[i].type,
                concreteType.parameters[i].type,
                inferredGenerics
            );
        }

        // Infer from return type
        inferGenericsFromTypes(
            patternType.returnType,
            concreteType.returnType,
            inferredGenerics
        );
        return;
    }

    // If pattern is a reference type, recurse into generic args
    // Example: Result<T, E> matches Result<i32, string> → infer T = i32, E = string
    if (isReferenceType(patternType) && isReferenceType(concreteType)) {
        const patternArgs = patternType.genericArgs;
        const concreteArgs = concreteType.genericArgs;

        for (let i = 0; i < Math.min(patternArgs.length, concreteArgs.length); i++) {
            inferGenericsFromTypes(patternArgs[i], concreteArgs[i], inferredGenerics);
        }
        return;
    }

    // TODO: Add more cases as needed (struct fields, tuple elements, nullable, etc.)
}

/**
 * Infer generic type parameters from function call arguments.
 *
 * Given a function with generic parameters and a list of argument types,
 * this function attempts to infer the concrete types for all generics.
 *
 * @param genericParamNames Names of the generic parameters (e.g., ['T', 'U'])
 * @param parameterTypes Function parameter types (may contain generic references)
 * @param argumentTypes Concrete types of the call arguments
 * @returns Map of generic parameter names to inferred concrete types
 *
 * @example
 * ```
 * fn map<U, V>(xs: U[], f: fn(a: U) -> V) -> V[]
 *
 * // Call: map([1u32, 2u32], fn(a: u32) -> f32 { ... })
 * inferGenericsFromArguments(
 *   ['U', 'V'],
 *   [U[], fn(U) -> V],
 *   [u32[], fn(u32) -> f32]
 * )
 * // Returns: Map { 'U' => u32, 'V' => f32 }
 * ```
 */
export function inferGenericsFromArguments(
    genericParamNames: string[],
    parameterTypes: TypeDescription[],
    argumentTypes: TypeDescription[]
): Map<string, TypeDescription> {
    // Initialize all generics with `never` (uninferrable by default)
    const inferredGenerics = new Map<string, TypeDescription>();
    for (const paramName of genericParamNames) {
        inferredGenerics.set(paramName, factory.createNeverType());
    }

    // Infer generics from each argument
    const numArgs = Math.min(parameterTypes.length, argumentTypes.length);
    for (let i = 0; i < numArgs; i++) {
        inferGenericsFromTypes(parameterTypes[i], argumentTypes[i], inferredGenerics);
    }

    return inferredGenerics;
}
