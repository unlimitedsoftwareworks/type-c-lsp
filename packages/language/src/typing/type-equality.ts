/**
 * Type Equality for Type-C Type System
 *
 * Standalone type equality functions extracted from TypeCTypeUtils.
 * These compare two types for structural equality and return a TypeCheckResult
 * indicating success or failure with an error message.
 */

import {
    EnumTypeDescription,
    FunctionTypeDescription,
    GenericTypeDescription,
    isArrayType,
    isClassType,
    isEnumType,
    isFunctionType,
    isGenericType,
    isNullableType,
    isReferenceType,
    isStringEnumType,
    isStructType,
    isTypeGuardType,
    isVariantType,
    ReferenceTypeDescription,
    StructTypeDescription,
    TypeDescription,
    TypeGuardTypeDescription,
    TypeKind,
    VariantTypeDescription,
} from './type-c-types.js';

// ============================================================================
// Type Check Result
// ============================================================================

export interface TypeCheckResult {
    success: boolean;
    message?: string;
}

function success(): TypeCheckResult {
    return { success: true };
}

function failure(message: string): TypeCheckResult {
    return { success: false, message };
}

// ============================================================================
// Resolve callback type
// ============================================================================

export type ResolveIfReferenceFn = (type: TypeDescription) => TypeDescription;

// ============================================================================
// Main equality function
// ============================================================================

/**
 * Checks if two types are exactly equal (structural equality).
 *
 * @param a First type
 * @param b Second type
 * @param resolveIfReference Callback to resolve reference types
 * @returns TypeCheckResult with success status and optional error message
 */
export function areTypesEqual(
    a: TypeDescription,
    b: TypeDescription,
    resolveIfReference: ResolveIfReferenceFn
): TypeCheckResult {
    // Quick reference equality check
    if (a === b) return success();

    // Different kinds are never equal
    if (a.kind !== b.kind) {
        return failure(`expected '${b.toString()}', got '${a.toString()}'`);
    }

    // Handle each type kind
    switch (a.kind) {
        // Primitive types - kind equality is sufficient
        case TypeKind.U8:
        case TypeKind.U16:
        case TypeKind.U32:
        case TypeKind.U64:
        case TypeKind.I8:
        case TypeKind.I16:
        case TypeKind.I32:
        case TypeKind.I64:
        case TypeKind.F32:
        case TypeKind.F64:
        case TypeKind.Bool:
        case TypeKind.Void:
        case TypeKind.String:
        case TypeKind.StringLiteral:
        case TypeKind.Null:
        case TypeKind.Never:
        case TypeKind.Any:
            return success();

        case TypeKind.StringEnum: {
            if (!isStringEnumType(a) || !isStringEnumType(b)) {
                return failure('Expected string enum types');
            }

            // String enums are equal if they have the same values
            if (a.values.length !== b.values.length) {
                return failure(`String enum value count mismatch: ${a.values.length} vs ${b.values.length}`);
            }

            // Check all values match (order doesn't matter for structural equality)
            const aSet = new Set(a.values);
            const bSet = new Set(b.values);

            for (const val of a.values) {
                if (!bSet.has(val)) {
                    return failure(`String enum value "${val}" not found in target enum`);
                }
            }
            for (const val of b.values) {
                if (!aSet.has(val)) {
                    return failure(`String enum value "${val}" not found in source enum`);
                }
            }

            return success();
        }

        case TypeKind.Array: {
            if (!isArrayType(a) || !isArrayType(b)) {
                return failure('Expected array types');
            }
            const result = areTypesEqual(a.elementType, b.elementType, resolveIfReference);
            if (!result.success) {
                return failure(`Array element types differ: ${result.message}`);
            }
            return success();
        }

        case TypeKind.Nullable: {
            if (!isNullableType(a) || !isNullableType(b)) {
                return failure('Expected nullable types');
            }
            const result = areTypesEqual(a.baseType, b.baseType, resolveIfReference);
            if (!result.success) {
                return failure(`Nullable base types differ: ${result.message}`);
            }
            return success();
        }

        /**
         * - Unions are only used for generic constraints, so they are never equal to other types
         * - Tuples are only used for return types and unpacking, so they are never equal to other types
         * - Joins are resolved prior to reaching this point, this condition should never be reached
         */
        case TypeKind.Union:
        case TypeKind.Tuple:
        case TypeKind.Join:
            return failure(`Type ${a.toString()} cannot be compared for equality`);


        case TypeKind.Struct:
            if (!isStructType(a) || !isStructType(b)) {
                return failure('Expected struct types');
            }
            return areStructTypesEqual(a, b, resolveIfReference);

        case TypeKind.Class: {
            if (!isClassType(a) || !isClassType(b)) {
                return failure('Expected class types');
            }
            // Classes use nominal typing - must be the exact same declaration
            if (a === b) {
                return success();
            }
            if (a.node && b.node && a.node === b.node) {
                // Same declaration — but for generic classes, different instantiations
                // (e.g. Box<u32> vs Box<i32>) have different attribute types.
                // Compare attributes to distinguish them.
                if (a.attributes.length !== b.attributes.length) {
                    return failure(`Class types differ: ${a.toString()} vs ${b.toString()}`);
                }
                for (let i = 0; i < a.attributes.length; i++) {
                    const attrResult = areTypesEqual(a.attributes[i].type, b.attributes[i].type, resolveIfReference);
                    if (!attrResult.success) {
                        return failure(`Class types differ: ${a.toString()} vs ${b.toString()}`);
                    }
                }
                return success();
            }
            return failure(`Class types differ: ${a.toString()} vs ${b.toString()}`);
        }

        case TypeKind.Enum:
            if (!isEnumType(a) || !isEnumType(b)) {
                return failure('Expected enum types');
            }
            return areEnumTypesEqual(a, b, resolveIfReference);

        case TypeKind.Function:
            if (!isFunctionType(a) || !isFunctionType(b)) {
                return failure('Expected types');
            }
            return areFunctionTypesEqual(a, b, resolveIfReference);

        case TypeKind.Reference:
            if (!isReferenceType(a) || !isReferenceType(b)) {
                return failure('Expected reference types');
            }
            return areReferenceTypesEqual(a, b, resolveIfReference);

        case TypeKind.Generic:
            if (!isGenericType(a) || !isGenericType(b)) {
                return failure('Expected generic types');
            }
            return areGenericTypesEqual(a, b);

        case TypeKind.TypeGuard:
            if (!isTypeGuardType(a) || !isTypeGuardType(b)) {
                return failure('Expected type guard types');
            }
            return areTypeGuardsEqual(a, b, resolveIfReference);

        case TypeKind.Variant:
            if (!isVariantType(a) || !isVariantType(b)) {
                return failure('Expected variant types');
            }
            return areVariantTypesEqual(a, b, resolveIfReference);

        // For other complex types, fall back to string comparison
        // (This is a simplified approach; real implementation would need deeper comparison)
        default:
            if (a.toString() === b.toString()) {
                return success();
            }
            return failure(`Types differ: ${a.toString()} vs ${b.toString()}`);
    }
}

// ============================================================================
// Helper equality functions
// ============================================================================

function areVariantTypesEqual(
    a: VariantTypeDescription,
    b: VariantTypeDescription,
    resolveIfReference: ResolveIfReferenceFn
): TypeCheckResult {
    // Variants are equal if they have the same constructors with the same parameter types
    if (a.constructors.length !== b.constructors.length) {
        return failure(`Variant constructor count mismatch: ${a.constructors.length} vs ${b.constructors.length}`);
    }

    for (const aConstructor of a.constructors) {
        const bConstructor = b.constructors.find(c => c.name === aConstructor.name);
        if (!bConstructor) {
            return failure(`Constructor '${aConstructor.name}' not found in target variant`);
        }

        if (aConstructor.parameters.length !== bConstructor.parameters.length) {
            return failure(`Constructor '${aConstructor.name}' parameter count mismatch`);
        }

        for (let i = 0; i < aConstructor.parameters.length; i++) {
            const aParam = aConstructor.parameters[i];
            const bParam = bConstructor.parameters[i];
            if (aParam.name !== bParam.name) {
                return failure(`Constructor '${aConstructor.name}' parameter name mismatch: ${aParam.name} vs ${bParam.name}`);
            }
            const typeResult = areTypesEqual(aParam.type, bParam.type, resolveIfReference);
            if (!typeResult.success) {
                return failure(`Constructor '${aConstructor.name}' parameter '${aParam.name}' type mismatch: ${typeResult.message}`);
            }
        }
    }

    return success();
}

function areEnumTypesEqual(
    a: EnumTypeDescription,
    b: EnumTypeDescription,
    resolveIfReference: ResolveIfReferenceFn
): TypeCheckResult {
    if (a.cases.length !== b.cases.length) {
        return failure(`Enum case count mismatch: ${a.cases.length} vs ${b.cases.length}`);
    }

    for (let i = 0; i < a.cases.length; i++) {
        const aCase = a.cases[i];
        const bCase = b.cases[i];
        if (aCase.name !== bCase.name || aCase.value !== bCase.value) {
            return failure(
                `Enum case mismatch at position ${i + 1}: ${aCase.name} vs ${bCase.name}`
            );
        }
    }

    if (a.encoding && b.encoding) {
        const encodingMatch = areTypesEqual(a.encoding, b.encoding, resolveIfReference);
        if (!encodingMatch.success) {
            return failure(`Enum encoding mismatch: ${encodingMatch.message}`);
        }
    } else if (a.encoding || b.encoding) {
        return failure('Enum encoding mismatch');
    }

    return success();
}

export function areStructTypesEqual(
    a: StructTypeDescription,
    b: StructTypeDescription,
    resolveIfReference: ResolveIfReferenceFn
): TypeCheckResult {
    if (a.fields.length !== b.fields.length) {
        return failure(`Struct field count mismatch: ${a.fields.length} vs ${b.fields.length}`);
    }

    // Structs are equal if they have the same fields with the same types
    for (const aField of a.fields) {
        const bField = b.fields.find(f => f.name === aField.name);
        if (!bField) {
            return failure(`Field '${aField.name}' not found in target struct`);
        }
        const typeResult = areTypesEqual(aField.type, bField.type, resolveIfReference);
        if (!typeResult.success) {
            return failure(`Field '${aField.name}' type mismatch: ${typeResult.message}`);
        }
    }

    return success();
}

export function areFunctionTypesEqual(
    a: FunctionTypeDescription,
    b: FunctionTypeDescription,
    resolveIfReference: ResolveIfReferenceFn
): TypeCheckResult {
    if (a.fnType !== b.fnType) {
        return failure(`type mismatch: ${a.fnType} vs ${b.fnType}`);
    }
    if (a.parameters.length !== b.parameters.length) {
        return failure(`Parameter count mismatch: ${a.parameters.length} vs ${b.parameters.length}`);
    }

    // Check parameter types and mutability
    for (let i = 0; i < a.parameters.length; i++) {
        const aParam = a.parameters[i];
        const bParam = b.parameters[i];

        // Check parameter type
        const typeResult = areTypesEqual(aParam.type, bParam.type, resolveIfReference);
        if (!typeResult.success) {
            return failure(`parameter ${i + 1} type mismatch: ${typeResult.message}`);
        }

        // Check parameter mutability (must match exactly for equality)
        if (aParam.isMut !== bParam.isMut) {
            return failure(`parameter ${i + 1} mutability mismatch: ${aParam.isMut ? 'mut' : 'immutable'} vs ${bParam.isMut ? 'mut' : 'immutable'}`);
        }
    }

    // Check return type
    const returnResult = areTypesEqual(a.returnType, b.returnType, resolveIfReference);
    if (!returnResult.success) {
        return failure(`return type mismatch: ${returnResult.message}`);
    }

    return success();
}

export function areReferenceTypesEqual(
    a: ReferenceTypeDescription,
    b: ReferenceTypeDescription,
    resolveIfReference: ResolveIfReferenceFn
): TypeCheckResult {
    // References are equal if they point to the same declaration
    if (a.declaration !== b.declaration) {
        return failure(`References point to different declarations: ${a.declaration.name} vs ${b.declaration.name}`);
    }

    // And have the same generic arguments
    if (a.genericArgs.length !== b.genericArgs.length) {
        return failure(`Generic argument count mismatch: ${a.genericArgs.length} vs ${b.genericArgs.length}`);
    }

    for (let i = 0; i < a.genericArgs.length; i++) {
        const result = areTypesEqual(a.genericArgs[i], b.genericArgs[i], resolveIfReference);
        if (!result.success) {
            return failure(`Generic argument ${i + 1} mismatch: ${result.message}`);
        }
    }

    return success();
}

function areGenericTypesEqual(
    a: GenericTypeDescription,
    b: GenericTypeDescription
): TypeCheckResult {
    // Generics are equal if they have the same name
    // This is correct because generic type parameters are scoped by name, not by declaration.
    // When a class Pair<A, B> is instantiated with Pair<B, A> (using method generics),
    // the class's A and the method's A represent the same type variable in that context.
    if (a.name === b.name) {
        return success();
    }
    return failure(`Generic type name mismatch: ${a.name} vs ${b.name}`);
}

function areTypeGuardsEqual(
    a: TypeGuardTypeDescription,
    b: TypeGuardTypeDescription,
    resolveIfReference: ResolveIfReferenceFn
): TypeCheckResult {
    // Type guards are equal if they guard the same parameter and have the same guarded type
    if (a.parameterIndex !== b.parameterIndex) {
        return failure(`Type guards reference different parameters: parameter ${a.parameterIndex} vs parameter ${b.parameterIndex}`);
    }

    const guardedTypeResult = areTypesEqual(a.guardedType, b.guardedType, resolveIfReference);
    if (!guardedTypeResult.success) {
        return failure(`Type guard types differ: ${guardedTypeResult.message}`);
    }

    return success();
}
