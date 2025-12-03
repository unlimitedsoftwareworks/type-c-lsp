/**
 * Type Utilities for Type-C Type System
 *
 * This module provides utilities for working with types:
 * - Type comparison and equality
 * - Type compatibility and assignability
 * - Type narrowing and widening
 * - Type substitution (for generics)
 * - Type simplification and normalization
 */

import { AstNode } from "langium";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "./type-c-type-provider.js";
import {
    ArrayTypeDescription,
    ClassTypeDescription,
    FloatTypeDescription,
    FunctionTypeDescription,
    GenericTypeDescription,
    IntegerTypeDescription,
    InterfaceTypeDescription,
    JoinTypeDescription,
    MethodType,
    NullableTypeDescription,
    ReferenceTypeDescription,
    StructTypeDescription,
    TupleTypeDescription,
    TypeDescription,
    TypeKind,
    UnionTypeDescription,
    VariantConstructorTypeDescription,
    VariantTypeDescription,
    isAnyType,
    isArrayType,
    isClassType,
    isEnumType,
    isErrorType,
    isFloatType,
    isFunctionType,
    isGenericType,
    isIntegerType,
    isInterfaceType,
    isJoinType,
    isNeverType,
    isNullableType,
    isNumericType,
    isReferenceType,
    isStringEnumType,
    isStringLiteralType,
    isStructType,
    isTupleType,
    isUnionType,
    isUnsetType,
    isVariantConstructorType,
    isVariantType
} from "./type-c-types.js";
import * as factory from "./type-factory.js";


// ============================================================================
// Type Check Result
// ============================================================================

/**
 * Result of a type checking operation.
 * Contains success status and optional error message.
 */
export interface TypeCheckResult {
    /** Whether the type check succeeded */
    success: boolean;
    /** Optional error message explaining why the check failed */
    message?: string;
}

/**
 * Creates a successful type check result.
 */
export function success(): TypeCheckResult {
    return { success: true };
}

/**
 * Creates a failed type check result with an error message.
 */
export function failure(message: string): TypeCheckResult {
    return { success: false, message };
}

export class TypeCTypeUtils {
    // Lazy, due to circular dependencies
    readonly typeProvider: () => TypeCTypeProvider;
    readonly pendingChecks: Array<{ from: TypeDescription; to: TypeDescription }> = [];

    constructor(services: TypeCServices) {
        this.typeProvider = () => services.typing.TypeProvider;
    }


    // ============================================================================
    // Pending Type Checks (for handling circular references)
    // ============================================================================

    /**
     * Tracks type pairs currently being checked for assignability.
     * This prevents infinite recursion when checking circular/recursive types.
     *
     * Example: when checking if Array is assignable to Container:
     * - Check if Array.slice() -> Array is assignable to Container.slice() -> Container
     * - This requires checking if Array is assignable to Container again (circular!)
     * - By tracking this pair, we can assume compatibility and break the cycle
     */

    isPendingCheck(from: TypeDescription, to: TypeDescription): boolean {
        return this.pendingChecks.some(pair =>
            this.areSameTypeForCycleDetection(pair.from, from) &&
            this.areSameTypeForCycleDetection(pair.to, to)
        );
    }

    /**
     * Checks if two types are "the same" for cycle detection purposes.
     * This is more lenient than strict equality - for reference types with generics,
     * we compare by declaration and generic arguments, not object identity.
     */
    private areSameTypeForCycleDetection(a: TypeDescription, b: TypeDescription): boolean {
        // Quick identity check
        if (a === b) return true;

        // For reference types, compare by declaration and generic args
        if (isReferenceType(a) && isReferenceType(b)) {
            if (a.declaration !== b.declaration) return false;
            if (a.genericArgs.length !== b.genericArgs.length) return false;
            
            // Recursively check generic arguments
            for (let i = 0; i < a.genericArgs.length; i++) {
                if (!this.areSameTypeForCycleDetection(a.genericArgs[i], b.genericArgs[i])) {
                    return false;
                }
            }
            return true;
        }

        // For class types, compare structural identity
        if (isClassType(a) && isClassType(b)) {
            // Classes are the same if they have the same node or same structure
            return a.node === b.node || a === b;
        }

        // For interface types, compare structural identity
        if (isInterfaceType(a) && isInterfaceType(b)) {
            // Interfaces are the same if they have the same node or same structure
            return a.node === b.node || a === b;
        }

        // Default: use strict equality
        return false;
    }

    addPendingCheck(from: TypeDescription, to: TypeDescription): void {
        this.pendingChecks.push({ from, to });
    }

    removePendingCheck(from: TypeDescription, to: TypeDescription): void {
        const index = this.pendingChecks.findIndex(pair => pair.from === from && pair.to === to);
        if (index !== -1) {
            this.pendingChecks.splice(index, 1);
        }
    }

    // ============================================================================
    // Type Equality
    // ============================================================================

    /**
     * Checks if two types are exactly equal (structural equality).
     *
     * @param a First type
     * @param b Second type
     * @returns TypeCheckResult with success status and optional error message
     */
    areTypesEqual(a: TypeDescription, b: TypeDescription): TypeCheckResult {
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
                const result = this.areTypesEqual(a.elementType, b.elementType);
                if (!result.success) {
                    return failure(`Array element types differ: ${result.message}`);
                }
                return success();
            }

            case TypeKind.Nullable: {
                if (!isNullableType(a) || !isNullableType(b)) {
                    return failure('Expected nullable types');
                }
                const result = this.areTypesEqual(a.baseType, b.baseType);
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
                return this.areStructTypesEqual(a, b);

            case TypeKind.Function:
                if (!isFunctionType(a) || !isFunctionType(b)) {
                    return failure('Expected types');
                }
                return this.areFunctionTypesEqual(a, b);

            case TypeKind.Reference:
                if (!isReferenceType(a) || !isReferenceType(b)) {
                    return failure('Expected reference types');
                }
                return this.areReferenceTypesEqual(a, b);

            case TypeKind.Generic:
                if (!isGenericType(a) || !isGenericType(b)) {
                    return failure('Expected generic types');
                }
                return this.areGenericTypesEqual(a, b);

            case TypeKind.Variant:
                if (!isVariantType(a) || !isVariantType(b)) {
                    return failure('Expected variant types');
                }
                return this.areVariantTypesEqual(a, b);

            // For other complex types, fall back to string comparison
            // (This is a simplified approach; real implementation would need deeper comparison)
            default:
                if (a.toString() === b.toString()) {
                    return success();
                }
                return failure(`Types differ: ${a.toString()} vs ${b.toString()}`);
        }
    }

    areVariantTypesEqual(a: VariantTypeDescription, b: VariantTypeDescription): TypeCheckResult {
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
                const typeResult = this.areTypesEqual(aParam.type, bParam.type);
                if (!typeResult.success) {
                    return failure(`Constructor '${aConstructor.name}' parameter '${aParam.name}' type mismatch: ${typeResult.message}`);
                }
            }
        }

        return success();
    }

    areStructTypesEqual(a: StructTypeDescription, b: StructTypeDescription): TypeCheckResult {
        if (a.fields.length !== b.fields.length) {
            return failure(`Struct field count mismatch: ${a.fields.length} vs ${b.fields.length}`);
        }

        // Structs are equal if they have the same fields with the same types
        for (const aField of a.fields) {
            const bField = b.fields.find(f => f.name === aField.name);
            if (!bField) {
                return failure(`Field '${aField.name}' not found in target struct`);
            }
            const typeResult = this.areTypesEqual(aField.type, bField.type);
            if (!typeResult.success) {
                return failure(`Field '${aField.name}' type mismatch: ${typeResult.message}`);
            }
        }

        return success();
    }

    areFunctionTypesEqual(a: FunctionTypeDescription, b: FunctionTypeDescription): TypeCheckResult {
        if (a.fnType !== b.fnType) {
            return failure(`type mismatch: ${a.fnType} vs ${b.fnType}`);
        }
        if (a.parameters.length !== b.parameters.length) {
            return failure(`Parameter count mismatch: ${a.parameters.length} vs ${b.parameters.length}`);
        }

        // Check parameter types
        for (let i = 0; i < a.parameters.length; i++) {
            const aParam = a.parameters[i];
            const bParam = b.parameters[i];
            const typeResult = this.areTypesEqual(aParam.type, bParam.type);
            if (!typeResult.success) {
                return failure(`parameter ${i + 1} type mismatch: ${typeResult.message}`);
            }
        }

        // Check return type
        const returnResult = this.areTypesEqual(a.returnType, b.returnType);
        if (!returnResult.success) {
            return failure(`return type mismatch: ${returnResult.message}`);
        }

        return success();
    }

    areReferenceTypesEqual(a: ReferenceTypeDescription, b: ReferenceTypeDescription): TypeCheckResult {
        // References are equal if they point to the same declaration
        if (a.declaration !== b.declaration) {
            return failure(`References point to different declarations: ${a.declaration.name} vs ${b.declaration.name}`);
        }

        // And have the same generic arguments
        if (a.genericArgs.length !== b.genericArgs.length) {
            return failure(`Generic argument count mismatch: ${a.genericArgs.length} vs ${b.genericArgs.length}`);
        }

        for (let i = 0; i < a.genericArgs.length; i++) {
            const result = this.areTypesEqual(a.genericArgs[i], b.genericArgs[i]);
            if (!result.success) {
                return failure(`Generic argument ${i + 1} mismatch: ${result.message}`);
            }
        }

        return success();
    }

    areGenericTypesEqual(a: GenericTypeDescription, b: GenericTypeDescription): TypeCheckResult {
        // Generics are equal if they have the same name
        // (assuming they're from the same scope context)
        if (a.name === b.name) {
            return success();
        }
        return failure(`Generic type name mismatch: ${a.name} vs ${b.name}`);
    }

    // ============================================================================
    // Type Compatibility (Assignability)
    // ============================================================================

    /**
     * Checks if a value of type 'from' can be assigned to a variable of type 'to'.
     * This implements subtyping rules for Type-C.
     *
     * @param from Source type
     * @param to Target type
     * @returns TypeCheckResult with success status and optional error message
     */
    isAssignable(from: TypeDescription, to: TypeDescription): TypeCheckResult {
        // Check if we're already checking this type pair (circular reference detection)
        // If so, assume compatibility to break the cycle (TypeScript-style approach)
        if (this.isPendingCheck(from, to)) {
            return success();
        }

        // Exact equality
        const equalityResult = this.areTypesEqual(from, to);
        if (equalityResult.success) {
            return success();
        }

        // Any type accepts everything, everything is assignable to Any
        if (isAnyType(to)) return success();
        if (isAnyType(from)) return success();

        // Never type is assignable to everything
        if (isNeverType(from)) return success();

        // Nothing is assignable to Never
        if (isNeverType(to)) return failure(`Cannot assign ${from.toString()} to never type`);

        // Error types propagate
        if (isErrorType(from) || isErrorType(to)) return success();

        // Unset types - treat as assignable for now (they should be resolved)
        if (isUnsetType(from) || isUnsetType(to)) return success();

        // Numeric promotions
        if (isNumericType(from) && isNumericType(to)) {
            return this.isNumericPromotionValid(from, to);
        }

        // Int + Enum or Enum + Int should be assignable
        if (isIntegerType(from) && isEnumType(to)) {
            return success();
        }
        if (isEnumType(from) && isIntegerType(to)) {
            return success();
        }

        // String literal to string enum: check if literal value is in enum
        if (isStringLiteralType(from) && isStringEnumType(to)) {
            if (to.values.includes(from.value)) {
                return success();
            }
            return failure(`String literal "${from.value}" is not assignable to ${to.values.map(v => `"${v}"`).join(' | ')}`);
        }

        // String literal to string: always valid (string literal is a subtype of string)
        if (isStringLiteralType(from) && to.kind === TypeKind.String) {
            return success();
        }

        // String enum to string literal: only if enum has exactly that value
        if (isStringEnumType(from) && isStringLiteralType(to)) {
            // This is generally not assignable unless the enum is a single-value enum
            if (from.values.length === 1 && from.values[0] === to.value) {
                return success();
            }
            return failure(`String enum ${from.values.map(v => `"${v}"`).join(' | ')} is not assignable to literal "${to.value}"`);
        }

        // Null can be assigned to nullable types
        if (from.kind === TypeKind.Null && isNullableType(to)) {
            return success();
        }

        // T can be assigned to T?
        if (isNullableType(to)) {
            return this.isAssignable(from, to.baseType);
        }

        // Array covariance (for now, arrays are invariant in element type)
        if (isArrayType(from) && isArrayType(to)) {
            const elementResult = this.areTypesEqual(from.elementType, to.elementType);
            if (!elementResult.success) {
                return failure(`Array element types are not compatible: ${elementResult.message}`);
            }
            return success();
        }

        // Tuple assignability
        if (isTupleType(from) && isTupleType(to)) {
            if (from.elementTypes.length !== to.elementTypes.length) {
                return failure(`Tuple length mismatch: ${from.elementTypes.length} vs ${to.elementTypes.length}`);
            }
            for (let i = 0; i < from.elementTypes.length; i++) {
                const result = this.isAssignable(from.elementTypes[i], to.elementTypes[i]);
                if (!result.success) {
                    return failure(`Tuple element ${i + 1} is not assignable: ${result.message}`);
                }
            }
            return success();
        }

        // Struct assignability (structural typing)
        // Handle both direct structs and join types that resolve to structs
        const fromStruct = this.asStructType(from);
        const toStruct = this.asStructType(to);
        
        if (fromStruct && toStruct) {
            return this.isStructAssignable(fromStruct, toStruct);
        }

        // Struct to named struct reference (duck typing)
        // Anonymous struct {x: 5.0, y: 10.0} can be assigned to Point if structurally compatible
        if (fromStruct && isReferenceType(to)) {
            // We need a type provider to resolve the reference, but we don't have access to it here
            // For now, we'll just return true and let the validator handle it
            // TODO: This should properly resolve the reference and check structural compatibility
            return success();
        }

        // assignability (contravariant in parameters, covariant in return type)
        if (isFunctionType(from) && isFunctionType(to)) {
            return this.isFunctionAssignable(from, to);
        }

        // Union type handling
        if (isUnionType(from)) {
            // All union members must be assignable to target
            for (const t of from.types) {
                const result = this.isAssignable(t, to);
                if (!result.success) {
                    return failure(`Union member ${t.toString()} is not assignable to ${to.toString()}: ${result.message}`);
                }
            }
            return success();
        }

        if (isUnionType(to)) {
            // Source must be assignable to at least one union member
            for (const t of to.types) {
                const result = this.isAssignable(from, t);
                if (result.success) {
                    return success();
                }
            }
            return failure(`${from.toString()} is not assignable to any member of union ${to.toString()}`);
        }

        // String enum to string enum: check if all values in 'from' are in 'to'
        if (isStringEnumType(from) && isStringEnumType(to)) {
            // All values in 'from' must be present in 'to'
            for (const value of from.values) {
                if (!to.values.includes(value)) {
                    return failure(`String enum value "${value}" from ${from.toString()} is not in target enum ${to.toString()}`);
                }
            }
            return success();
        }

        // Join (intersection) type handling
        if (isJoinType(from)) {
            // At least one join member must be assignable to target
            for (const t of from.types) {
                const result = this.isAssignable(t, to);
                if (result.success) {
                    return success();
                }
            }
            return failure(`No member of intersection ${from.toString()} is assignable to ${to.toString()}`);
        }

        if (isJoinType(to)) {
            // Source must be assignable to all join members
            for (const t of to.types) {
                const result = this.isAssignable(from, t);
                if (!result.success) {
                    return failure(`${from.toString()} is not assignable to intersection member ${t.toString()}: ${result.message}`);
                }
            }
            return success();
        }

        // Class/Interface subtyping
        if (isClassType(from) && isClassType(to)) {
            // Classes are equal if they're the same object OR have the same AST node
            // This is critical for handling partial class types during inference
            // (stub methods with void return types vs fully inferred methods)
            if (from === to || (from.node && to.node && from.node === to.node)) {
                return success();
            }
            return failure(`Class types differ: ${from.toString()} vs ${to.toString()}`);
        }
        
        // Handle class to reference type (which may resolve to an interface)
        // This is critical for: fn serialize() = this, where 'this' is class type
        // and interface expects 'Serializable' (a ReferenceType)
        if (isClassType(from) && isReferenceType(to)) {
            // Check if we're already checking this pair (circular reference detection)
            if (this.isPendingCheck(from, to)) {
                return success(); // Assume compatibility to break the cycle
            }
            
            // Add to pending checks before recursing
            this.addPendingCheck(from, to);
            
            try {
                const resolvedTo = this.typeProvider().resolveReference(to);
                // Recursively check if class is assignable to the resolved type
                return this.isAssignable(from, resolvedTo);
            } finally {
                this.removePendingCheck(from, to);
            }
        }
        
        // Handle class to interface (including join types that resolve to interfaces)
        const toInterface = this.asInterfaceType(to);
        if (isClassType(from) && toInterface) {
            // CRITICAL: Check if this class is already being checked against ANY type
            // This prevents infinite recursion when methods return 'this' and interface expects the interface type
            // Example: fn serialize() -> Serializable = this
            const isClassAlreadyBeingChecked = this.pendingChecks.some(pair =>
                isClassType(pair.from) && pair.from.node === from.node
            );
            
            if (isClassAlreadyBeingChecked) {
                return success(); // Assume compatibility to break the cycle
            }
            
            // Add to pending checks before recursing to handle circular references
            this.addPendingCheck(from, to);
            const result = this.isClassAssignableToInterface(from, toInterface);
            this.removePendingCheck(from, to);
            return result;
        }

        // Handle interface to interface (including join types)
        const fromInterface = this.asInterfaceType(from);
        if (fromInterface && toInterface) {
            return this.isInterfaceAssignableToInterface(fromInterface, toInterface);
        }

        // Variant constructor assignability
        // A variant constructor (e.g., Result.Ok<i32, never>) is assignable to its base variant
        // with compatible generic arguments (e.g., Result<i32, string>)
        //
        // Key rules:
        // 1. Result.Ok<i32, never> <: Result<i32, E> for any E (never is compatible with any type)
        // 2. Result.Ok<i32, string> <: Result<i32, string> (exact match)
        // 3. Result.Ok<i32, string> is NOT assignable to Result.Err<i32, string> (different constructors)
        if (isVariantConstructorType(from)) {
            // Target can be either a VariantType or a ReferenceType pointing to a variant
            if (isVariantType(to)) {
                return this.isVariantConstructorAssignableToVariant(from, to);
            }
            if (isReferenceType(to)) {
                return this.isVariantConstructorAssignableToVariantRef(from, to);
            }
        }

        // Variant constructor to variant constructor assignability
        // Result.Ok<i32, never> <: Result.Ok<i32, string> (never is compatible)
        // Result.Ok<i32, string> is NOT assignable to Result.Err<i32, string> (different constructors)
        if (isVariantConstructorType(from) && isVariantConstructorType(to)) {
            return this.isVariantConstructorAssignableToVariantConstructor(from, to);
        }

        // Variant type to variant type assignability (CRITICAL for covariance!)
        // variant { Ok(value: i32), Err(message: never) } <: variant { Ok(value: i32), Err(message: string) }
        // This happens when Result<i32, never> and Result<i32, string> are both resolved to VariantTypes
        if (isVariantType(from) && isVariantType(to)) {
            return this.isVariantAssignableToVariant(from, to);
        }

        // Reference type assignability
        // Result<i32, never> <: Result<i32, string> (never is compatible with any type)
        if (isReferenceType(from) && isReferenceType(to)) {
            return this.isReferenceAssignableToReference(from, to);
        }

        // Default: not assignable
        return failure(`${from.toString()} is not assignable to ${to.toString()}`);
    }

    isNumericPromotionValid(from: IntegerTypeDescription | FloatTypeDescription, to: IntegerTypeDescription | FloatTypeDescription): TypeCheckResult {
        // Float types
        if (isFloatType(from) && isFloatType(to)) {
            // f32 can be promoted to f64
            if (from.bits <= to.bits) {
                return success();
            }
            return failure(`Cannot narrow ${from.toString()} to ${to.toString()}`);
        }

        // Integer types
        if (isIntegerType(from) && isIntegerType(to)) {
            // Same signedness: can promote to larger size
            if (from.signed === to.signed) {
                if (from.bits <= to.bits) {
                    return success();
                }
                return failure(`Cannot narrow ${from.toString()} to ${to.toString()}`);
            }
            // Unsigned to signed: need extra bit
            if (!from.signed && to.signed) {
                if (from.bits < to.bits) {
                    return success();
                }
                return failure(`Cannot convert unsigned ${from.toString()} to signed ${to.toString()} without extra bits`);
            }
            // Signed to unsigned: not allowed
            return failure(`Cannot convert signed ${from.toString()} to unsigned ${to.toString()}`);
        }

        // Integer to float: generally allowed (with potential precision loss)
        if (isIntegerType(from) && isFloatType(to)) {
            return success();
        }

        // Float to integer: not allowed implicitly
        return failure(`Cannot implicitly convert ${from.toString()} to ${to.toString()}`);
    }

    isStructAssignable(from: StructTypeDescription, to: StructTypeDescription): TypeCheckResult {
        // Structural typing: 'from' must have all fields of 'to' with compatible types
        for (const toField of to.fields) {
            const fromField = from.fields.find(f => f.name === toField.name);
            if (!fromField) {
                return failure(`Field '${toField.name}' missing in source struct`);
            }
            const result = this.isAssignable(fromField.type, toField.type);
            if (!result.success) {
                return failure(`Field '${toField.name}' type mismatch: ${result.message}`);
            }
        }
        return success();
    }

    isFunctionAssignable(from: FunctionTypeDescription, to: FunctionTypeDescription): TypeCheckResult {
        // types must match in arity and type style
        if (from.fnType !== to.fnType) {
            return failure(`type mismatch: ${from.fnType} vs ${to.fnType}`);
        }
        if (from.parameters.length !== to.parameters.length) {
            return failure(`Parameter count mismatch: ${from.parameters.length} vs ${to.parameters.length}`);
        }

        // Parameters are contravariant
        for (let i = 0; i < to.parameters.length; i++) {
            const result = this.isAssignable(to.parameters[i].type, from.parameters[i].type);
            if (!result.success) {
                return failure(`Parameter ${i + 1} is not contravariant: ${result.message}`);
            }
        }

        // Return type is covariant
        const returnResult = this.isAssignable(from.returnType, to.returnType);
        if (!returnResult.success) {
            return failure(`Return type is not covariant: ${returnResult.message}`);
        }

        return success();
    }

    isClassAssignableToInterface(from: ClassTypeDescription, to: InterfaceTypeDescription): TypeCheckResult {
        // All interface methods must be implemented by the class
        for (const method of to.methods) {
            // Find all class methods with matching names (to handle overloads)
            const candidateMethods = from.methods.filter(m => m.names.some(name => method.names.includes(name)));

            if (candidateMethods.length === 0) {
                return failure(`class does not implement required method '${method.names[0]}'`);
            }

            // Check if any candidate method matches the signature
            let foundMatch = false;
            let lastError = '';

            for (const classMethod of candidateMethods) {
                // Check type compatibility (allowing covariant return types)
                const result = this.isMethodImplementationCompatible(classMethod, method);
                if (result.success) {
                    foundMatch = true;
                    break;
                }
                lastError = result.message || '';
            }

            if (!foundMatch) {
                // Build a helpful error message showing expected signature
                const expectedSig = `${method.names[0]}(${method.parameters.map(p => `${p.name}: ${p.type.toString()}`).join(', ')}) -> ${method.returnType.toString()}`;
                return failure(`method '${method.names[0]}' signature mismatch: expected ${expectedSig} but no matching overload found in class. ${lastError}`);
            }
        }
        return success();
    }

    /**
     * Checks if a class method implementation is compatible with an interface method.
     *
     * Compatibility rules:
     * - Parameter count must match
     * - Parameter types must be exactly equal (invariant)
     * - Return type can be more specific (covariant): implementation return type must be assignable to interface return type
     * - Generic parameters must match
     *
     * This allows a class to return a more specific type than the interface requires,
     * which is sound because callers expecting the interface type can use the more specific type.
     */
    isMethodImplementationCompatible(
        implementation: { readonly parameters: readonly { name: string; type: TypeDescription; isMut: boolean }[]; returnType: TypeDescription; genericParameters?: readonly { name: string }[] },
        interfaceMethod: { readonly parameters: readonly { name: string; type: TypeDescription; isMut: boolean }[]; returnType: TypeDescription; genericParameters?: readonly { name: string }[] }
    ): TypeCheckResult {
        // Check parameter count
        if (implementation.parameters.length !== interfaceMethod.parameters.length) {
            return failure(`Parameter count mismatch: ${implementation.parameters.length} vs ${interfaceMethod.parameters.length}`);
        }

        // Check parameter types (must be exactly equal, not covariant/contravariant)
        for (let i = 0; i < implementation.parameters.length; i++) {
            const implParam = implementation.parameters[i];
            const ifaceParam = interfaceMethod.parameters[i];

            const typeResult = this.areTypesEqual(implParam.type, ifaceParam.type);
            if (!typeResult.success) {
                return failure(`Parameter ${i + 1} type mismatch: ${typeResult.message}`);
            }
        }

        // Check return type (covariant: implementation can return more specific type)
        // The implementation return type must be assignable to the interface return type
        const returnResult = this.isAssignable(implementation.returnType, interfaceMethod.returnType);
        if (!returnResult.success) {
            return failure(`Return type not compatible: implementation returns '${implementation.returnType.toString()}' but interface expects '${interfaceMethod.returnType.toString()}'. ${returnResult.message}`);
        }

        return success();
    }

    isInterfaceAssignableToInterface(from: InterfaceTypeDescription, to: InterfaceTypeDescription): TypeCheckResult {
        return failure(`Interface to interface assignment not yet implemented`);
    }

    /**
     * Checks if a variant constructor is assignable to a variant type.
     *
     * A variant constructor is a subtype of its base variant if:
     * 1. The constructor exists in the variant
     * 2. Generic arguments are compatible (never is compatible with any type)
     *
     * Examples:
     * - Result.Ok<i32, never> <: Result<i32, string> ✓
     * - Result.Ok<i32, string> <: Result<i32, string> ✓
     * - Result.Ok<i32, string> <: Result<u32, string> ✗ (i32 not assignable to u32)
     */
    isVariantConstructorAssignableToVariant(
        from: VariantConstructorTypeDescription,
        to: VariantTypeDescription,
        
    ): TypeCheckResult {
        // Find the constructor in the target variant
        const toConstructor = to.constructors.find(c => c.name === from.constructorName);
        if (!toConstructor) {
            return failure(`Constructor '${from.constructorName}' not found in target variant`);
        }

        // Find the constructor in the source's base variant
        const fromConstructor = from.baseVariant.constructors.find(c => c.name === from.constructorName);
        if (!fromConstructor) {
            return failure(`Constructor '${from.constructorName}' not found in source variant`);
        }

        // Check that parameter counts match
        if (fromConstructor.parameters.length !== toConstructor.parameters.length) {
            return failure(`Constructor '${from.constructorName}' parameter count mismatch`);
        }

        // The from constructor has genericArgs that represent the inferred types (e.g., [struct{x: u32}])
        // The to constructor has parameter types that have been substituted (e.g., value: string)
        // We need to check if the from's inferred types match the to's expected types

        // Build a substitution map for the from constructor's generics
        // This maps generic parameter names to the inferred types
        const fromSubstitutions = new Map<string, TypeDescription>();
        if (from.genericArgs.length > 0 && from.variantDeclaration?.genericParameters) {
            from.variantDeclaration.genericParameters.forEach((param, i) => {
                if (i < from.genericArgs.length) {
                    fromSubstitutions.set(param.name, from.genericArgs[i]);
                }
            });
        }

        // Check each parameter
        for (let i = 0; i < fromConstructor.parameters.length; i++) {
            const fromParamType = fromConstructor.parameters[i].type;
            const toParamType = toConstructor.parameters[i].type;

            // Substitute generics in the from parameter type
            const resolvedFromParamType = fromSubstitutions.size > 0
                ? this.substituteGenerics(fromParamType, fromSubstitutions)
                : fromParamType;

            // Check assignability: never is compatible with anything
            if (isNeverType(resolvedFromParamType)) {
                continue;
            }

            const result = this.isAssignable(resolvedFromParamType, toParamType);
            if (!result.success) {
                return failure(`Constructor '${from.constructorName}' parameter ${i + 1} type mismatch: ${result.message}`);
            }
        }

        return success();
    }

    /**
     * Checks if one variant constructor is assignable to another variant constructor.
     *
     * Rules:
     * 1. Constructors must have the same name (Result.Ok =/= Result.Err)
     * 2. Generic arguments must be compatible (with never being compatible with anything)
     *
     * Examples:
     * - Result.Ok<i32, never> <: Result.Ok<i32, string> ✓ (never is compatible)
     * - Result.Ok<i32, string> <: Result.Ok<i32, string> ✓ (exact match)
     * - Result.Ok<i32, string> <: Result.Err<i32, string> ✗ (different constructors)
     */
    isVariantConstructorAssignableToVariantConstructor(
        from: VariantConstructorTypeDescription,
        to: VariantConstructorTypeDescription,
        
    ): TypeCheckResult {
        // Constructors must have the same name
        if (from.constructorName !== to.constructorName) {
            return failure(`Constructor names differ: ${from.constructorName} vs ${to.constructorName}`);
        }

        // Generic arguments must be compatible
        // If lengths don't match, not compatible
        if (from.genericArgs.length !== to.genericArgs.length) {
            if (from.genericArgs.length === 0) {
                return success(); // Allow if from has no generics
            }
            return failure(`Generic argument count mismatch: ${from.genericArgs.length} vs ${to.genericArgs.length}`);
        }

        // Check each generic argument
        // never in 'from' is compatible with any type in 'to'
        for (let i = 0; i < from.genericArgs.length; i++) {
            const fromArg = from.genericArgs[i];
            const toArg = to.genericArgs[i];

            // If from is never, it's compatible with any target type
            if (isNeverType(fromArg)) {
                continue;
            }

            // Otherwise, check normal assignability
            const result = this.isAssignable(fromArg, toArg);
            if (!result.success) {
                return failure(`Generic argument ${i + 1} not assignable: ${result.message}`);
            }
        }

        return success();
    }

    /**
     * Checks if one variant type is assignable to another variant type using STRUCTURAL TYPING.
     *
     * Type-C uses structural typing for variants (similar to structs):
     * - Source variant is assignable to target variant if ALL constructors of source exist in target
     * - Target can have MORE constructors than source (source is a structural subset)
     * - For each matching constructor, parameter names and types must match exactly
     *
     * Covariance rules for constructor parameters:
     * - Parameter types must be assignable (with covariance support)
     * - `never` in source is compatible with any type in target (bottom type)
     *
     * Examples:
     * - variant { Ok(value: i32), Err(message: never) } <: variant { Ok(value: i32), Err(message: string) } ✓
     * - variant { Ok(i32) } <: variant { Ok(i32), Err(string) } ✓ (target has more constructors)
     * - variant { Ok(i32), Err(string) } <: variant { Ok(i32) } ✗ (source has Err, target doesn't)
     * - variant { Ok(value: u32) } <: variant { Ok(value: i32) } ✗ (u32 not assignable to i32)
     *
     * This method is called when both types are already resolved VariantTypeDescriptions,
     * typically after resolving Result<i32, never> and Result<i32, string> to their definitions.
     */
    isVariantAssignableToVariant(
        from: VariantTypeDescription,
        to: VariantTypeDescription
    ): TypeCheckResult {
        // STRUCTURAL TYPING: All constructors of 'from' must exist in 'to'
        // Target can have extra constructors (structural subtyping)
        for (const fromConstructor of from.constructors) {
            const toConstructor = to.constructors.find(c => c.name === fromConstructor.name);
            
            if (!toConstructor) {
                return failure(`${from.toString()} is not assignable to ${to.toString()}: Constructor '${fromConstructor.name}' from source variant not found in target variant`);
            }

            // Check that parameter counts match
            if (fromConstructor.parameters.length !== toConstructor.parameters.length) {
                return failure(`${from.toString()} is not assignable to ${to.toString()}: Constructor '${fromConstructor.name}' has ${fromConstructor.parameters.length} parameter(s), but target has ${toConstructor.parameters.length}`);
            }

            // Check each parameter name and type
            for (let i = 0; i < fromConstructor.parameters.length; i++) {
                const fromParam = fromConstructor.parameters[i];
                const toParam = toConstructor.parameters[i];

                // Parameter names must match (structural requirement)
                if (fromParam.name !== toParam.name) {
                    return failure(`${from.toString()} is not assignable to ${to.toString()}: Constructor '${fromConstructor.name}' parameter at position ${i} has name '${fromParam.name}' but target expects '${toParam.name}'`);
                }

                // If from is never, it's compatible with any target type
                if (isNeverType(fromParam.type)) {
                    continue;
                }

                // Check assignability with covariance
                const result = this.isAssignable(fromParam.type, toParam.type);
                if (!result.success) {
                    return failure(`${from.toString()} is not assignable to ${to.toString()}: Constructor '${fromConstructor.name}' parameter '${fromParam.name}' type incompatible - ${result.message}`);
                }
            }
        }

        return success();
    }

    /**
     * Checks if a variant constructor is assignable to a reference type pointing to a variant.
     *
     * Example: Result.Ok<i32, never> <: Result<i32, string>
     *
     * This is the most common case since type annotations like `Result<i32, string>` create ReferenceTypes.
     */
    isVariantConstructorAssignableToVariantRef(
        from: VariantConstructorTypeDescription,
        to: ReferenceTypeDescription,
        
    ): TypeCheckResult {
        // Check if from's baseVariant matches the target reference
        // Use the variantDeclaration if available, otherwise fall back to comparing AST nodes
        const fromBaseMatches = from.variantDeclaration
            ? from.variantDeclaration === to.declaration
            : from.baseVariant.node === to.declaration;

        if (!fromBaseMatches) {
            return failure(`Variant constructor does not match target reference`);
        }

        // Check generic arguments compatibility
        // from.genericArgs should be compatible with to.genericArgs
        if (from.genericArgs.length !== to.genericArgs.length) {
            // If lengths don't match, allow if from has no generics (will be inferred)
            if (from.genericArgs.length === 0) {
                return success();
            }
            return failure(`Generic argument count mismatch: ${from.genericArgs.length} vs ${to.genericArgs.length}`);
        }

        // Check each generic argument
        // never in 'from' is compatible with any type in 'to'
        for (let i = 0; i < from.genericArgs.length; i++) {
            const fromArg = from.genericArgs[i];
            const toArg = to.genericArgs[i];

            // If from is never, it's compatible with any target type
            if (isNeverType(fromArg)) {
                continue;
            }

            // Otherwise, check normal assignability
            const result = this.isAssignable(fromArg, toArg);
            if (!result.success) {
                return failure(`Generic argument ${i + 1} not assignable: ${result.message}`);
            }
        }

        return success();
    }

    /**
     * Checks if one reference type is assignable to another.
     *
     * Key rules:
     * - Must reference the same declaration
     * - Generic arguments must be compatible
     * - `never` in source is compatible with any type in target
     *
     * Examples:
     * - Result<i32, never> <: Result<i32, string> ✅ (never is compatible)
     * - Result<i32, string> <: Result<i32, string> ✅ (exact match)
     * - Result<i32, string> <: Result<i32, bool> ❌ (string not assignable to bool)
     */
    isReferenceAssignableToReference(
        from: ReferenceTypeDescription,
        to: ReferenceTypeDescription
    ): TypeCheckResult {
        // Check if we're already checking this pair (cycle detection)
        // When we detect a cycle, we still need to validate generic arguments
        // but we can skip the deep resolution to break infinite recursion
        if (this.isPendingCheck(from, to)) {
            // For cycle breaking: verify generic arguments match even during recursion
            // This prevents false positives like Array<string> -> Container<u32>
            if (from.genericArgs.length !== to.genericArgs.length) {
                return failure(`Generic argument count mismatch: ${from.genericArgs.length} vs ${to.genericArgs.length}`);
            }

            for (let i = 0; i < from.genericArgs.length; i++) {
                const fromArg = from.genericArgs[i];
                const toArg = to.genericArgs[i];

                // If from is never, it's compatible with any target type
                if (isNeverType(fromArg)) {
                    continue;
                }

                // For cycle detection: only check if types are exactly equal
                // Don't recursively call isAssignable as that would continue the infinite loop
                const equalResult = this.areTypesEqual(fromArg, toArg);
                if (!equalResult.success) {
                    return failure(`Generic argument ${i + 1} type mismatch during cycle check: ${equalResult.message}`);
                }
            }

            // Generic args match, assume structural compatibility to break the cycle
            return success();
        }

        // Add to pending checks before any recursive operations
        this.addPendingCheck(from, to);

        try {
            // IMPORTANT: Check generic arguments BEFORE resolving!
            // When we resolve, we might lose generic argument information,
            // so we need to validate them while we still have the reference types
            
            // If they have different numbers of generic arguments, they can't be compatible
            // UNLESS one is being resolved to check class-to-interface compatibility
            // In that case, we need to validate generic args correspond correctly
            
            if (from.genericArgs.length > 0 || to.genericArgs.length > 0) {
                // Both must have same number of generic arguments
                if (from.genericArgs.length !== to.genericArgs.length) {
                    return failure(`Generic argument count mismatch: ${from.genericArgs.length} vs ${to.genericArgs.length}`);
                }

                // Check each generic argument
                for (let i = 0; i < from.genericArgs.length; i++) {
                    const fromArg = from.genericArgs[i];
                    const toArg = to.genericArgs[i];

                    // If from is never, it's compatible with any target type
                    if (isNeverType(fromArg)) {
                        continue;
                    }

                    // Check normal assignability for generic arguments
                    const result = this.isAssignable(fromArg, toArg);
                    if (!result.success) {
                        return failure(`Generic argument ${i + 1} not assignable: ${result.message}`);
                    }
                }
            }

            // Now resolve both references to check their actual types
            const resolvedFrom = this.typeProvider().resolveReference(from);
            const resolvedTo = this.typeProvider().resolveReference(to);

            // If both resolved to non-reference types, check them directly
            // This handles class-to-interface compatibility (covariant returns)
            if (!isReferenceType(resolvedFrom) && !isReferenceType(resolvedTo)) {
                const result = this.isAssignable(resolvedFrom, resolvedTo);
                return result;
            }

            // If still reference types after resolution, they must reference the same declaration
            if (from.declaration !== to.declaration) {
                return failure(`References point to different declarations: ${from.declaration.name} vs ${to.declaration.name}`);
            }

            return success();
        } finally {
            // Always remove from pending checks, even if an error occurred
            this.removePendingCheck(from, to);
        }
    }

    // ============================================================================
    // Type Substitution (for Generics)
    // ============================================================================

    /**
     * Substitutes generic type parameters with concrete types.
     * Used when instantiating generic functions, classes, etc.
     * 
     * @param type Type to substitute in
     * @param substitutions Map from generic parameter names to concrete types
     * @returns New type with substitutions applied
     */
    substituteGenerics(
        type: TypeDescription,
        substitutions: Map<string, TypeDescription>
    ): TypeDescription {
        // If it's a generic type parameter, substitute it
        if (isGenericType(type)) {
            return substitutions.get(type.name) ?? type;
        }

        // Recursively substitute in composite types
        if (isArrayType(type)) {
            const arrayType: ArrayTypeDescription = {
                kind: type.kind,
                elementType: this.substituteGenerics(type.elementType, substitutions),
                node: type.node,
                toString: () => `${this.substituteGenerics(type.elementType, substitutions).toString()}[]`
            };
            return arrayType;
        }

        if (isNullableType(type)) {
            const nullableType: NullableTypeDescription = {
                kind: type.kind,
                baseType: this.substituteGenerics(type.baseType, substitutions),
                node: type.node,
                toString: () => `${this.substituteGenerics(type.baseType, substitutions).toString()}?`
            };
            return nullableType;
        }

        if (isUnionType(type)) {
            const substitutedTypes = type.types.map(t => this.substituteGenerics(t, substitutions));
            const unionType: UnionTypeDescription = {
                kind: type.kind,
                types: substitutedTypes,
                node: type.node,
                toString: () => substitutedTypes.map(t => t.toString()).join(' | ')
            };
            return unionType;
        }

        if (isJoinType(type)) {
            const substitutedTypes = type.types.map(t => this.substituteGenerics(t, substitutions));
            const joinType: JoinTypeDescription = {
                kind: type.kind,
                types: substitutedTypes,
                node: type.node,
                toString: () => substitutedTypes.map(t => t.toString()).join(' & ')
            };
            return joinType;
        }

        if (isTupleType(type)) {
            const substitutedTypes = type.elementTypes.map(t => this.substituteGenerics(t, substitutions));
            const tupleType: TupleTypeDescription = {
                kind: type.kind,
                elementTypes: substitutedTypes,
                node: type.node,
                toString: () => `(${substitutedTypes.map(t => t.toString()).join(', ')})`
            };
            return tupleType;
        }

        if (isStructType(type)) {
            const substitutedFields = type.fields.map(f => ({
                name: f.name,
                type: this.substituteGenerics(f.type, substitutions),
                node: f.node
            }));
            const structType: StructTypeDescription = {
                kind: type.kind,
                fields: substitutedFields,
                isAnonymous: type.isAnonymous,
                node: type.node,
                toString: () => {
                    const fieldStrs = substitutedFields.map(f => `${f.name}: ${f.type.toString()}`).join(', ');
                    return `${type.isAnonymous ? '' : 'struct '}{ ${fieldStrs} }`;
                }
            };
            return structType;
        }

        if (isFunctionType(type)) {
            const substitutedParams = type.parameters.map(p => ({
                name: p.name,
                type: this.substituteGenerics(p.type, substitutions),
                isMut: p.isMut
            }));
            const substitutedReturn = this.substituteGenerics(type.returnType, substitutions);
            const functionType: FunctionTypeDescription = {
                kind: type.kind,
                fnType: type.fnType,
                parameters: substitutedParams,
                returnType: substitutedReturn,
                genericParameters: type.genericParameters,
                node: type.node,
                toString: () => {
                    const paramStrs = substitutedParams.map(p =>
                        `${p.isMut ? 'mut ' : ''}${p.name}: ${p.type.toString()}`
                    ).join(', ');
                    return `${type.fnType}(${paramStrs}) -> ${substitutedReturn.toString()}`;
                }
            };
            return functionType;
        }

        if (isReferenceType(type) && type.genericArgs.length > 0) {
            const substitutedArgs = type.genericArgs.map(t => this.substituteGenerics(t, substitutions));
            const refType: ReferenceTypeDescription = {
                kind: type.kind,
                declaration: type.declaration,
                genericArgs: substitutedArgs,
                actualType: type.actualType,
                node: type.node,
                toString: () => {
                    const argsStr = substitutedArgs.length > 0
                        ? `<${substitutedArgs.map(a => a.toString()).join(', ')}>`
                        : '';
                    return `${type.declaration.name}${argsStr}`;
                }
            };
            return refType;
        }

        if (isVariantConstructorType(type) && type.genericArgs.length > 0) {
            const substitutedArgs = type.genericArgs.map(t => this.substituteGenerics(t, substitutions));
            const variantConstructorType: VariantConstructorTypeDescription = {
                kind: type.kind,
                baseVariant: type.baseVariant,
                variantDeclaration: type.variantDeclaration,
                constructorName: type.constructorName,
                genericArgs: substitutedArgs,
                parentConstructor: type.parentConstructor,
                node: type.node,
                toString: () => {
                    const variantName = type.variantDeclaration?.name ?? 'Variant';
                    const argsStr = substitutedArgs.length > 0
                        ? `<${substitutedArgs.map(a => a.toString()).join(', ')}>`
                        : '';
                    return `${variantName}.${type.constructorName}${argsStr}`;
                }
            };
            return variantConstructorType;
        }

        // Substitute generics in variant types
        if (isVariantType(type)) {
            const substitutedConstructors = type.constructors.map(constructor => ({
                name: constructor.name,
                parameters: constructor.parameters.map(param => {
                    const substitutedParamType = this.substituteGenerics(param.type, substitutions);
                    return {
                        name: param.name,
                        type: substitutedParamType,
                        node: param.node
                    };
                })
            }));
            const variantType: VariantTypeDescription = {
                kind: type.kind,
                constructors: substitutedConstructors,
                node: type.node,
                toString: () => {
                    const constructorStrs = substitutedConstructors.map(c => {
                        if (c.parameters.length === 0) {
                            return c.name;
                        }
                        const paramStrs = c.parameters.map(p =>
                            `${p.name}: ${p.type.toString()}`
                        ).join(', ');
                        return `${c.name}(${paramStrs})`;
                    }).join(', ');
                    return `variant { ${constructorStrs} }`;
                }
            };
            return variantType;
        }
        if (isClassType(type)) {
            const substitutedAttributes = type.attributes.map(a => ({
                name: a.name,
                type: this.substituteGenerics(a.type, substitutions),
                isStatic: a.isStatic,
                isConst: a.isConst,
                isLocal: a.isLocal
            }));
            const substitutedMethods = type.methods.filter(m => !m.isStatic).map(m => ({
                ...m,
                parameters: m.parameters.map(p => ({
                    name: p.name,
                    type: this.substituteGenerics(p.type, substitutions),
                    isMut: p.isMut
                })),
                returnType: this.substituteGenerics(m.returnType, substitutions)
            }));
            const substitutedImplementations = type.implementations.map(i => this.substituteGenerics(i, substitutions));
            const substitutedSuperTypes = type.superTypes.map(t => this.substituteGenerics(t, substitutions));
            const classType: ClassTypeDescription = {
                kind: type.kind,
                attributes: substitutedAttributes,
                methods: substitutedMethods,
                superTypes: substitutedSuperTypes,
                implementations: substitutedImplementations,
                node: type.node,
                toString: () => {
                    const attributeStrs = substitutedAttributes.map(a => `${a.name}: ${a.type.toString()}`).join(', ');
                    const methodStrs = substitutedMethods.map(m => `${m.names}(${m.parameters.map(p => `${p.name}: ${p.type.toString()}`).join(', ')}) -> ${m.returnType.toString()}`).join(', ');
                    const implementationStrs = substitutedImplementations.map(i => i.toString()).join(', ');
                    const superTypeStrs = substitutedSuperTypes.map(t => t.toString()).join(', ');
                    return `class { ${attributeStrs} } { ${methodStrs} } implements ${implementationStrs} super { ${superTypeStrs} }`;
                }
            };
            return classType;
        }
        if (isInterfaceType(type)) {
            const substitutedMethods = type.methods.map(m => factory.createMethodType(m.names, m.parameters.map(p => ({
                name: p.name,
                type: this.substituteGenerics(p.type, substitutions),
                isMut: p.isMut
            })), this.substituteGenerics(m.returnType, substitutions), m.node, m.genericParameters, m.isStatic, m.isOverride, m.isLocal));

            return factory.createInterfaceType(substitutedMethods, type.superTypes.map(t => this.substituteGenerics(t, substitutions)), type.node);
        }

        // For other types, return as-is
        return type;
    }

    // ============================================================================
    // Type Simplification
    // ============================================================================

    /**
     * Simplifies a type by removing redundancies and normalizing.
     * 
     * Examples:
     * - (T | T) -> T
     * - (T? | null) -> T?
     * - Union of overlapping types -> simplified union
     * 
     * @param type Type to simplify
     * @returns Simplified type
     */
    simplifyType(type: TypeDescription): TypeDescription {
        if (isUnionType(type)) {
            return this.simplifyUnion(type);
        }

        if (isJoinType(type)) {
            return this.simplifyJoin(type);
        }

        // For other types, return as-is
        return type;
    }

    simplifyUnion(type: UnionTypeDescription): TypeDescription {
        // Flatten nested unions
        const flatTypes: TypeDescription[] = [];
        for (const t of type.types) {
            if (isUnionType(t)) {
                flatTypes.push(...t.types);
            } else {
                flatTypes.push(t);
            }
        }

        // Remove duplicates
        const uniqueTypes: TypeDescription[] = [];
        for (const t of flatTypes) {
            if (!uniqueTypes.some(existing => this.areTypesEqual(existing, t).success)) {
                uniqueTypes.push(t);
            }
        }

        // If only one type remains, return it
        if (uniqueTypes.length === 1) {
            return uniqueTypes[0];
        }

        const simplifiedUnion: UnionTypeDescription = {
            kind: TypeKind.Union,
            types: uniqueTypes,
            node: type.node,
            toString: () => uniqueTypes.map(t => t.toString()).join(' | ')
        };
        return simplifiedUnion;
    }

    simplifyJoin(type: JoinTypeDescription): TypeDescription {
        // Flatten nested joins
        const flatTypes: TypeDescription[] = [];
        for (const t of type.types) {
            if (isJoinType(t)) {
                flatTypes.push(...t.types);
            } else {
                flatTypes.push(t);
            }
        }

        // Resolve reference types to get actual struct/interface definitions
        const resolvedTypes = flatTypes.map(t =>
            isReferenceType(t) ? this.typeProvider().resolveReference(t) : t
        );

        // Check if all types are structs - if so, merge them into a single struct
        const allStructs = resolvedTypes.every(t => isStructType(t));
        if (allStructs) {
            const structTypes = resolvedTypes.filter(isStructType);
            const mergedFields = new Map<string, { type: TypeDescription; sources: string[], nodes: AstNode[] }>();
            
            // Merge all struct fields
            for (const struct of structTypes) {
                const structName = struct.toString();
                for (const field of struct.fields) {
                    const existing = mergedFields.get(field.name);
                    if (existing) {
                        // Field already exists - check if types are compatible
                        const typesEqual = this.areTypesEqual(existing.type, field.type);
                        if (!typesEqual.success) {
                            // Conflicting field types - return error
                            return factory.createErrorType(
                                `Join type has conflicting field '${field.name}': ${existing.type.toString()} in ${existing.sources.join(', ')} vs ${field.type.toString()} in ${structName}`,
                                undefined,
                                type.node
                            );
                        }
                        existing.sources.push(structName);
                        existing.nodes.push(field.node)
                    } else {
                        mergedFields.set(field.name, {
                            type: field.type,
                            sources: [structName],
                            nodes: [field.node]
                        });
                    }
                }
            }
            
            // Create a merged struct type with all fields
            const allFields = Array.from(mergedFields.entries()).map(([name, info]) =>
                factory.createStructField(name, info.type, info.nodes[0])
            );
            return factory.createStructType(allFields, false, type.node);
        }

        // Check if all types are interfaces - merge them similarly
        const allInterfaces = resolvedTypes.every(t => isInterfaceType(t));
        if (allInterfaces) {
            const interfaceTypes = resolvedTypes.filter(isInterfaceType);
            // Collect all methods from all interfaces
            const allMethods: MethodType[] = [];
            for (const iface of interfaceTypes) {
                allMethods.push(...iface.methods);
            }
            // Collect all super types
            const allSuperTypes: TypeDescription[] = [];
            for (const iface of interfaceTypes) {
                allSuperTypes.push(...iface.superTypes);
            }
            // Create merged interface
            return factory.createInterfaceType(allMethods, allSuperTypes, type.node);
        }

        // Remove duplicates
        const uniqueTypes: TypeDescription[] = [];
        for (const t of resolvedTypes) {
            if (!uniqueTypes.some(existing => this.areTypesEqual(existing, t).success)) {
                uniqueTypes.push(t);
            }
        }

        // If only one type remains, return it
        if (uniqueTypes.length === 1) {
            return uniqueTypes[0];
        }

        const simplifiedJoin: JoinTypeDescription = {
            kind: TypeKind.Join,
            types: uniqueTypes,
            node: type.node,
            toString: () => uniqueTypes.map(t => t.toString()).join(' & ')
        };
        return simplifiedJoin;
    }

    // ============================================================================
    // Struct/Interface Join Type Utilities
    // ============================================================================

    /**
     * Checks if a type is a struct or a join of structs, and returns the resolved struct type.
     * This handles both direct struct types and join types that merge into a single struct.
     *
     * @param type The type to check
     * @returns The struct type if it's a struct or struct join, undefined otherwise
     *
     * @example
     * ```
     * asStructType({ kind: 'struct', fields: [...] }) → StructTypeDescription
     * asStructType(Coords & ZAttribute) → StructTypeDescription with merged fields
     * asStructType({ kind: 'u32' }) → undefined
     * ```
     */
    asStructType(type: TypeDescription): StructTypeDescription | undefined {
        // Direct struct type
        if (isStructType(type)) {
            return type;
        }

        // Join type - check if it resolves to a struct
        if (isJoinType(type)) {
            const simplified = this.simplifyJoin(type);
            if (isStructType(simplified)) {
                return simplified;
            }
        }

        return undefined;
    }

    /**
     * Checks if a type is an interface or a join of interfaces, and returns the resolved interface type.
     * This handles both direct interface types and join types that merge into a single interface.
     *
     * @param type The type to check
     * @returns The interface type if it's an interface or interface join, undefined otherwise
     *
     * @example
     * ```
     * asInterfaceType({ kind: 'interface', methods: [...] }) → InterfaceTypeDescription
     * asInterfaceType(IFoo & IBar) → InterfaceTypeDescription with merged methods
     * asInterfaceType({ kind: 'u32' }) → undefined
     * ```
     */
    asInterfaceType(type: TypeDescription): InterfaceTypeDescription | undefined {
        // Direct interface type
        if (isInterfaceType(type)) {
            return type;
        }

        // Join type - check if it resolves to an interface
        if (isJoinType(type)) {
            const simplified = this.simplifyJoin(type);
            if (isInterfaceType(simplified)) {
                return simplified;
            }
        }

        return undefined;
    }

    // ============================================================================
    // Type Narrowing
    // ============================================================================

    /**
     * Narrows a type based on a type check or condition.
     * Used for control flow analysis.
     * 
     * @param type Type to narrow
     * @param narrowTo Target type to narrow to
     * @returns Narrowed type, or never if narrowing is impossible
     */
    narrowType(type: TypeDescription, narrowTo: TypeDescription): TypeDescription {
        // If types are equal, narrowing succeeds
        if (this.areTypesEqual(type, narrowTo).success) {
            return type;
        }

        // Can't narrow to a broader type
        const narrowToTypeCheck = this.isAssignable(narrowTo, type);
        const typeToNarrowCheck = this.isAssignable(type, narrowTo);
        if (!narrowToTypeCheck.success && !typeToNarrowCheck.success) {
            // Return never type to indicate impossible narrowing
            return { kind: TypeKind.Never, toString: () => 'never' };
        }

        // If narrowing to a subtype, return the subtype
        if (narrowToTypeCheck.success) {
            return narrowTo;
        }

        // Union type narrowing
        if (isUnionType(type)) {
            const narrowedTypes = type.types
                .map(t => this.narrowType(t, narrowTo))
                .filter(t => !isNeverType(t));

            if (narrowedTypes.length === 0) {
                return { kind: TypeKind.Never, toString: () => 'never' };
            }

            if (narrowedTypes.length === 1) {
                return narrowedTypes[0];
            }

            const narrowedUnion: UnionTypeDescription = {
                kind: TypeKind.Union,
                types: narrowedTypes,
                node: type.node,
                toString: () => narrowedTypes.map(t => t.toString()).join(' | ')
            };
            return narrowedUnion;
        }

        // Default: return the target type
        return narrowTo;
    }

}

