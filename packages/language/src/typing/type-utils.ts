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

import { AstNode, AstUtils } from "langium";
import { ErrorCode } from "../codes/errors.js";
import * as ast from '../generated/ast.js';
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "./type-c-type-provider.js";
import {
    ClassTypeDescription,
    FloatTypeDescription,
    FunctionTypeDescription,
    GenericTypeDescription,
    IntegerTypeDescription,
    InterfaceTypeDescription,
    isAnyType,
    isArrayType,
    isClassType,
    isEnumType,
    isErrorType,
    isFloatType,
    isFunctionType,
    isGenericType,
    isImplementationType,
    isIntegerType,
    isInterfaceType,
    isJoinType,
    isNeverType,
    isNullableType,
    isNumericType,
    isPrimitiveType,
    isReferenceType,
    isStringEnumType,
    isStringLiteralType,
    isStructType,
    isTupleType,
    isTypeGuardType,
    isUnionType,
    isUnsetType,
    isVariantConstructorType,
    isVariantType,
    JoinTypeDescription,
    MethodType,
    ReferenceTypeDescription,
    StringEnumTypeDescription,
    StructFieldType,
    StructTypeDescription,
    TypeDescription,
    TypeGuardTypeDescription,
    TypeKind,
    UnionTypeDescription,
    VariantConstructorTypeDescription,
    VariantTypeDescription
} from "./type-c-types.js";
import { TypeCTypeFactory } from "./type-factory.js";



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
    readonly typeFactory: TypeCTypeFactory;
    readonly pendingChecks: Array<{ from: TypeDescription; to: TypeDescription }> = [];

    constructor(services: TypeCServices) {
        this.typeProvider = () => services.typing.TypeProvider;
        this.typeFactory = services.typing.TypeFactory;
    }

    // ============================================================================
    // Type Resolution Helper
    // ============================================================================

    /**
     * Resolves a type if it's a reference type, otherwise returns the type as-is.
     * This is a convenience helper to avoid the common pattern:
     * `isReferenceType(type) ? this.typeProvider().resolveReference(type) : type`
     *
     * Note: When reporting errors, use the original type for better error messages
     * (avoids printing large resolved structs instead of the original type name).
     *
     * @param type The type to potentially resolve
     * @returns The resolved type if it was a reference, otherwise the original type
     */
    resolveIfReference(type: TypeDescription): TypeDescription {
        return isReferenceType(type) ? this.typeProvider().resolveReference(type) : type;
    }

    /**
     * Resolves a type if it's a generic type with a constraint, otherwise returns the type as-is.
     * This is a convenience helper for constraint-based member access and operator resolution.
     *
     * When a generic type parameter has a constraint (e.g., T: ComparableObject),
     * this method returns the constraint type to enable member access on the generic.
     *
     * This mimics Java's bounded type parameter behavior where constrained generics
     * can access members/methods defined in their bounds.
     *
     * @param type The type to potentially resolve
     * @returns The constraint type if it was a generic with constraint, otherwise the original type
     *
     * @example
     * ```
     * // T: ComparableObject
     * resolveIfGeneric(T) → ComparableObject
     * // T (no constraint)
     * resolveIfGeneric(T) → T
     * // u32 (not generic)
     * resolveIfGeneric(u32) → u32
     * ```
     */
    resolveIfGeneric(type: TypeDescription): TypeDescription {
        return isGenericType(type) && type.constraint ? type.constraint : type;
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

            case TypeKind.TypeGuard:
                if (!isTypeGuardType(a) || !isTypeGuardType(b)) {
                    return failure('Expected type guard types');
                }
                return this.areTypeGuardsEqual(a, b);

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

        // Check parameter types and mutability
        for (let i = 0; i < a.parameters.length; i++) {
            const aParam = a.parameters[i];
            const bParam = b.parameters[i];
            
            // Check parameter type
            const typeResult = this.areTypesEqual(aParam.type, bParam.type);
            if (!typeResult.success) {
                return failure(`parameter ${i + 1} type mismatch: ${typeResult.message}`);
            }
            
            // Check parameter mutability (must match exactly for equality)
            if (aParam.isMut !== bParam.isMut) {
                return failure(`parameter ${i + 1} mutability mismatch: ${aParam.isMut ? 'mut' : 'immutable'} vs ${bParam.isMut ? 'mut' : 'immutable'}`);
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
        // This is correct because generic type parameters are scoped by name, not by declaration.
        // When a class Pair<A, B> is instantiated with Pair<B, A> (using method generics),
        // the class's A and the method's A represent the same type variable in that context.
        if (a.name === b.name) {
            return success();
        }
        return failure(`Generic type name mismatch: ${a.name} vs ${b.name}`);
    }

    areTypeGuardsEqual(a: TypeGuardTypeDescription, b: TypeGuardTypeDescription): TypeCheckResult {
        // Type guards are equal if they guard the same parameter and have the same guarded type
        if (a.parameterIndex !== b.parameterIndex) {
            return failure(`Type guards reference different parameters: parameter ${a.parameterIndex} vs parameter ${b.parameterIndex}`);
        }
        
        const guardedTypeResult = this.areTypesEqual(a.guardedType, b.guardedType);
        if (!guardedTypeResult.success) {
            return failure(`Type guard types differ: ${guardedTypeResult.message}`);
        }
        
        return success();
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

        // CRITICAL: Generic types with constraints are assignable to their constraints
        // This enables passing constrained generics to methods expecting the constraint type
        // Example: fn<T: ComparableObject>(a: T, b: T) -> a.eq(b) where eq expects ComparableObject
        if (isGenericType(from) && from.constraint) {
            // Resolve both constraint and target in case they're reference types
            const resolvedConstraint = this.resolveIfReference(from.constraint);
            const resolvedTo = this.resolveIfReference(to);
            const constraintResult = this.isAssignable(resolvedConstraint, resolvedTo);
            if (constraintResult.success) {
                return success();
            }
            // If constraint didn't match, continue with other checks
        }

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

        // String enum to string: always valid (string enum is a subtype of string)
        if (isStringEnumType(from) && to.kind === TypeKind.String) {
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

        // Both nullable: T? can be assigned to U? if T can be assigned to U
        // This handles cases like u32[]? -> u32?[]? (nullable array with non-nullable elements
        // to nullable array with nullable elements)
        if (isNullableType(from) && isNullableType(to)) {
            return this.isAssignable(from.baseType, to.baseType);
        }

        // T can be assigned to T?
        if (isNullableType(to)) {
            return this.isAssignable(from, to.baseType);
        }

        // Array element type compatibility
        // Uses structural typing: element types must be assignable, not strictly equal
        // This allows struct literals to be compatible with named struct type aliases
        if (isArrayType(from) && isArrayType(to)) {
            const elementResult = this.isAssignable(from.elementType, to.elementType);
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

        // Struct to named struct reference (structural typing)
        // Anonymous struct {x: 5.0, y: 10.0} can be assigned to Point if structurally compatible
        if (fromStruct && isReferenceType(to)) {
            // Resolve the reference to get the actual struct type
            const resolvedTo = this.typeProvider().resolveReference(to);
            const toResolvedStruct = this.asStructType(resolvedTo);
            
            if (toResolvedStruct) {
                // Both are structs - use structural typing
                return this.isStructAssignable(fromStruct, toResolvedStruct);
            }
            
            // If reference doesn't resolve to a struct, not compatible
            return failure(`Cannot assign struct to non-struct type '${to.toString()}'`);
        }

        // Type guard to boolean compatibility
        // (x: unknown) => x is string is assignable to (x: unknown) => boolean
        if (isTypeGuardType(from) && to.kind === TypeKind.Bool) {
            return success();
        }

        // Boolean to type guard compatibility
        // (x: unknown) => boolean is assignable to (x: unknown) => x is T
        // This allows functions that return boolean expressions to be used as type guards
        if (from.kind === TypeKind.Bool && isTypeGuardType(to)) {
            return success();
        }

        // Type guard to any/unknown compatibility
        if (isTypeGuardType(from) && isAnyType(to)) {
            return success();
        }

        // Type guard to type guard compatibility
        // Same parameter index and compatible guarded types
        if (isTypeGuardType(from) && isTypeGuardType(to)) {
            if (from.parameterIndex !== to.parameterIndex) {
                return failure(`Type guards reference different parameters: parameter ${from.parameterIndex} vs parameter ${to.parameterIndex}`);
            }
            
            // The guarded type should be assignable (covariant)
            const guardedTypeResult = this.isAssignable(from.guardedType, to.guardedType);
            if (!guardedTypeResult.success) {
                return failure(`Type guard guarded types are not compatible: ${guardedTypeResult.message}`);
            }
            
            return success();
        }

        // Function assignability (contravariant in parameters, covariant in return type)
        // Handle both direct function types and references to function types
        const fromFunc = isFunctionType(from) ? from :
                        this.resolveIfReference(from);
        const toFunc = isFunctionType(to) ? to :
                      this.resolveIfReference(to);
        
        if (fromFunc && isFunctionType(fromFunc) && toFunc && isFunctionType(toFunc)) {
            return this.isFunctionAssignable(fromFunc, toFunc);
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

        // Parameters are contravariant (both type and mutability)
        for (let i = 0; i < to.parameters.length; i++) {
            const fromParam = from.parameters[i];
            const toParam = to.parameters[i];
            
            // Check parameter type (contravariant)
            const result = this.isAssignable(toParam.type, fromParam.type);
            if (!result.success) {
                return failure(`Parameter ${i + 1} type is not contravariant: ${result.message}`);
            }
            
            // Check parameter mutability (contravariant)
            // Rule: A read-only parameter function can be used where a mutable parameter function is expected
            // But NOT vice versa.
            //
            // Expected has 'mut', actual has immutable → OK (can use read-only where mutable expected)
            // Expected has immutable, actual has 'mut' → ERROR (cannot use mutable where read-only expected)
            //
            // In other words: if expected is immutable (false), actual must also be immutable (false)
            if (!toParam.isMut && fromParam.isMut) {
                return failure(
                    `Parameter ${i + 1} mutability is not contravariant: ` +
                    `expected immutable parameter, but got mutable parameter. ` +
                    `A function with mutable parameters cannot be used where immutable parameters are expected.`
                );
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
            // Collect impl methods with generic substitutions applied
            const implMethods = from.implementations.map(implRef => {
                // Build substitutions from the impl reference (e.g., Default3DImpl<vec3>)
                let implSubstitutions: Map<string, TypeDescription> | undefined;
                if (isReferenceType(implRef) && implRef.genericArgs.length > 0 && implRef.declaration.genericParameters) {
                    implSubstitutions = new Map<string, TypeDescription>();
                    implRef.declaration.genericParameters.forEach((param, i) => {
                        if (i < implRef.genericArgs.length) {
                            implSubstitutions!.set(param.name, implRef.genericArgs[i]);
                        }
                    });
                }
                
                // Resolve the impl type
                const impl = this.typeProvider().resolveReference(implRef);
                if(isImplementationType(impl)) {
                    // Apply generic substitutions to each method
                    if (implSubstitutions && implSubstitutions.size > 0) {
                        return impl.methods.map(m => ({
                            ...m,
                            parameters: m.parameters.map(p => ({
                                name: p.name,
                                type: this.substituteGenerics(p.type, implSubstitutions!),
                                isMut: p.isMut
                            })),
                            returnType: this.substituteGenerics(m.returnType, implSubstitutions!)
                        }));
                    }
                    return impl.methods;
                }
                return []
            }).flat();
            
            // Filter out impl methods that are shadowed by override methods
            const nonShadowedImplMethods = implMethods.filter(implMethod => {
                // Check if any class override method shadows this impl method
                return !from.methods.some(classMethod =>
                    classMethod.isOverride &&
                    this.methodSignaturesMatch(classMethod, implMethod)
                );
            });
            
            // Collect all available methods (class methods + non-shadowed impl methods)
            const classMethods = [...from.methods, ...nonShadowedImplMethods];
            // Find all class methods with matching names (to handle overloads)
            const candidateMethods = classMethods.filter(m => m.names.some(name => method.names.includes(name)));

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
                    // CRITICAL: Interface methods are always public, so check if the class method is local
                    // Local methods cannot implement interface methods
                    if (classMethod.isLocal) {
                        return failure(
                            `method '${method.names[0]}' cannot be implemented by local method. ` +
                            `Interface methods are always public, but class method '${classMethod.names[0]}' is marked as local (private). ` +
                            `Remove the 'local' keyword from the class method to implement the interface.`
                        );
                    }
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

        // Check parameter types and mutability (must be exactly equal for interface implementation)
        for (let i = 0; i < implementation.parameters.length; i++) {
            const implParam = implementation.parameters[i];
            const ifaceParam = interfaceMethod.parameters[i];

            // Check parameter type
            const typeResult = this.areTypesEqual(implParam.type, ifaceParam.type);
            if (!typeResult.success) {
                return failure(`Parameter ${i + 1} type mismatch: ${typeResult.message}`);
            }
            
            // Check parameter mutability (contravariant)
            // Rule: Implementation can be LESS permissive (immutable when interface has mut)
            // But NOT MORE permissive (mut when interface has immutable)
            //
            // Interface has immutable, implementation has mut → ERROR (more permissive)
            // Interface has mut, implementation has immutable → OK (less permissive)
            if (!ifaceParam.isMut && implParam.isMut) {
                return failure(
                    `Parameter ${i + 1} mutability mismatch: ` +
                    `interface parameter is immutable, but implementation parameter is mutable. ` +
                    `Implementation cannot be more permissive than the interface.`
                );
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
        // Structural subtyping: 'from' must have all methods of 'to' with compatible signatures
        // This enables interface inheritance and join type assignability
        
        // Collect all methods from 'from' including inherited ones
        const allFromMethods = this.collectAllInterfaceMethods(from);
        
        for (const toMethod of to.methods) {
            // Find all methods with matching names in 'from' (to handle overloads)
            const candidateMethods = allFromMethods.filter(m =>
                m.names.some(name => toMethod.names.includes(name))
            );

            if (candidateMethods.length === 0) {
                return failure(`interface does not implement required method '${toMethod.names[0]}'`);
            }

            // Check if any candidate method matches the signature
            let foundMatch = false;
            let lastError = '';

            for (const fromMethod of candidateMethods) {
                // Check type compatibility (allowing covariant return types)
                const result = this.isMethodImplementationCompatible(fromMethod, toMethod);
                if (result.success) {
                    foundMatch = true;
                    break;
                }
                lastError = result.message || '';
            }

            if (!foundMatch) {
                // Build a helpful error message showing expected signature
                const expectedSig = `${toMethod.names[0]}(${toMethod.parameters.map(p => `${p.name}: ${p.type.toString()}`).join(', ')}) -> ${toMethod.returnType.toString()}`;
                return failure(`method '${toMethod.names[0]}' signature mismatch: expected ${expectedSig} but no matching overload found. ${lastError}`);
            }
        }
        
        // Also verify that all required methods from 'to' supertypes are satisfied
        for (const toSuperType of to.superTypes) {
            const resolvedToSuper = this.resolveIfReference(toSuperType);
            const toSuperInterface = this.asInterfaceType(resolvedToSuper);
            
            if (toSuperInterface) {
                const superResult = this.isInterfaceAssignableToInterface(from, toSuperInterface);
                if (!superResult.success) {
                    return superResult;
                }
            }
        }
        
        return success();
    }
    
    /**
     * Recursively collects all methods from an interface including inherited ones.
     * This enables proper structural subtyping for interface inheritance.
     *
     * Since interfaces use structural typing, we simply collect all methods from
     * the entire inheritance hierarchy. Duplicate methods (same signature) don't
     * cause issues - they're structurally equivalent anyway.
     *
     * @param iface The interface to collect methods from
     * @returns Array of all methods (direct + inherited)
     */
    collectAllInterfaceMethods(iface: InterfaceTypeDescription): MethodType[] {
        const allMethods: MethodType[] = [...iface.methods];
        
        // Recursively collect methods from supertypes
        for (const superType of iface.superTypes) {
            const resolvedSuper = this.resolveIfReference(superType);
            const superInterface = this.asInterfaceType(resolvedSuper);
            
            if (superInterface) {
                // Recursively get all methods from the supertype
                const superMethods = this.collectAllInterfaceMethods(superInterface);
                allMethods.push(...superMethods);
            }
        }
        
        return allMethods;
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

    /**
     * Checks if a type can be cast to another type.
     *
     * This is used for validating cast expressions (as, as?, as!).
     * The rules are more permissive than assignability:
     * - Regular cast: Must be trivially safe (guaranteed to succeed)
     * - Safe cast: May fail, returns nullable
     * - Force cast: User takes responsibility
     *
     * @param from Source type being cast from
     * @param to Target type being cast to
     * @returns TypeCheckResult indicating if the cast is valid
     */
    canCastTypes(from: TypeDescription, to: TypeDescription): TypeCheckResult {
        // Exact equality is always allowed
        const equalityResult = this.areTypesEqual(from, to);
        if (equalityResult.success) {
            return success();
        }

        // Any type accepts everything
        if (isAnyType(to) || isAnyType(from)) {
            return success();
        }

        // Never type is castable to everything
        if (isNeverType(from)) {
            return success();
        }

        // Error types propagate
        if (isErrorType(from) || isErrorType(to)) {
            return success();
        }

        // Unset types - treat as castable for now
        if (isUnsetType(from) || isUnsetType(to)) {
            return success();
        }

        // Resolve reference types before checking
        const resolvedFrom = this.resolveIfReference(from);
        const resolvedTo = this.resolveIfReference(to);

        // Primitive types - allow all primitive-to-primitive casts (numeric conversions, etc.)
        // This includes: u32 to i32, i32 to f32, etc.
        if (isIntegerType(resolvedFrom) && isIntegerType(resolvedTo)) {
            return success();
        }
        if (isFloatType(resolvedFrom) && isFloatType(resolvedTo)) {
            return success();
        }
        if (isIntegerType(resolvedFrom) && isFloatType(resolvedTo)) {
            return success();
        }
        if (isFloatType(resolvedFrom) && isIntegerType(resolvedTo)) {
            return success();
        }

        // Integer and enum are castable
        if (isIntegerType(resolvedFrom) && isEnumType(resolvedTo)) {
            return success();
        }
        if (isEnumType(resolvedFrom) && isIntegerType(resolvedTo)) {
            return success();
        }

        // Nullable types: can cast T to T? and T? to T
        if (isNullableType(resolvedFrom) && !isNullableType(resolvedTo)) {
            // T? to T - allowed (unsafe, but that's why we have as!)
            return this.canCastTypes(resolvedFrom.baseType, resolvedTo);
        }
        if (!isNullableType(resolvedFrom) && isNullableType(resolvedTo)) {
            // T to T? - always safe
            return this.canCastTypes(resolvedFrom, resolvedTo.baseType);
        }
        if (isNullableType(resolvedFrom) && isNullableType(resolvedTo)) {
            // T? to U? - check if T can be cast to U
            return this.canCastTypes(resolvedFrom.baseType, resolvedTo.baseType);
        }

        // Class to interface - check if class implements interface (allowed for safe cast)
        const toInterface = this.asInterfaceType(resolvedTo);
        if (isClassType(resolvedFrom) && toInterface) {
            return this.isClassAssignableToInterface(resolvedFrom, toInterface);
        }

        // Interface to class - not guaranteed, but allowed for safe cast
        const fromInterface = this.asInterfaceType(resolvedFrom);
        if (fromInterface && isClassType(resolvedTo)) {
            // This is a downcast - we can't verify at compile time
            // But it's valid for safe cast (as?)
            return success();
        }

        // Variant constructor to parent variant - always safe
        if (isVariantConstructorType(resolvedFrom)) {
            if (isVariantType(resolvedTo)) {
                return this.isVariantConstructorAssignableToVariant(resolvedFrom, resolvedTo);
            }
            if (isReferenceType(to)) {
                return this.isVariantConstructorAssignableToVariantRef(resolvedFrom, to);
            }
        }

        // Variant to variant constructor - downcast, NOT safe for regular 'as'
        // This is like casting from Animal to Cat - we don't know at compile-time
        // if the variant value is actually that specific constructor
        // Example: Option<u32> as Option.Some is NOT safe - could be Option.None!
        if (isVariantType(resolvedFrom) && isVariantConstructorType(resolvedTo)) {
            // Check if the constructor exists in the source variant
            const constructor = resolvedFrom.constructors.find(c => c.name === resolvedTo.constructorName);
            if (constructor) {
                // This is a downcast - return failure to indicate it's not safe for 'as'
                // It's valid for 'as?' (safe cast) or 'as!' (forced cast), but NOT 'as'
                return failure(`Cannot safely cast variant to specific constructor - use 'as?' for safe cast or 'as!' to force`);
            }
            return failure(`Variant does not have constructor '${resolvedTo.constructorName}'`);
        }

        // Reference type to variant constructor
        if (isReferenceType(from) && isVariantConstructorType(resolvedTo)) {
            const resolvedFromVariant = this.typeProvider().resolveReference(from);
            if (isVariantType(resolvedFromVariant)) {
                const constructor = resolvedFromVariant.constructors.find(c => c.name === resolvedTo.constructorName);
                if (constructor) {
                    return success();
                }
                return failure(`Variant does not have constructor '${resolvedTo.constructorName}'`);
            }
        }

        // Array element type casting
        if (isArrayType(resolvedFrom) && isArrayType(resolvedTo)) {
            return this.canCastTypes(resolvedFrom.elementType, resolvedTo.elementType);
        }

        // Fallback to assignability check
        // If types are assignable, they're definitely castable
        return this.isAssignable(resolvedFrom, resolvedTo);
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
     * @param context Optional context string for error messages
     * @param errors Optional array to collect errors during substitution
     * @returns New type with substitutions applied
     */
    substituteGenerics(
        type: TypeDescription,
        substitutions: Map<string, TypeDescription>,
        context?: string,
        errors?: string[]
    ): TypeDescription {
        // If it's a generic type parameter, substitute it
        if (isGenericType(type)) {
            const substitutedType = substitutions.get(type.name) ?? type;
            
            // If we actually substituted something (not just returning the original generic)
            if (substitutedType !== type) {
                // Check for illegal nullable basic types
                if (isNullableType(substitutedType) && this.isTypeBasic(substitutedType.baseType)) {
                    const errorMsg = `Generic parameter '${type.name}' substituted with illegal nullable basic type '${substitutedType.toString()}'${context ? ` in ${context}` : ''}`;
                    if (errors) {
                        errors.push(errorMsg);
                    }
                    // Return the type with errors attached
                    return { ...substitutedType, errors: errors ? [...errors] : [errorMsg] };
                }
                
                // Check for double nullable (shouldn't happen with direct substitution, but be safe)
                // This would be if someone tries T -> U?? somehow
                if (isNullableType(substitutedType) && isNullableType(substitutedType.baseType)) {
                    const errorMsg = `Generic parameter '${type.name}' substituted with illegal double nullable type '${substitutedType.toString()}'${context ? ` in ${context}` : ''}`;
                    if (errors) {
                        errors.push(errorMsg);
                    }
                    // Return error type for double nullable (structural error)
                    return this.typeFactory.createErrorType(errorMsg, ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE, type.node);
                }
            }
            
            return substitutedType;
        }

        // Recursively substitute in composite types
        if (isArrayType(type)) {
            const substitutedElement = this.substituteGenerics(type.elementType, substitutions, context ? `${context} array element` : 'array element', errors);
            const arrayType = this.typeFactory.createArrayType(substitutedElement, type.node);
            
            // Propagate errors from element type
            if (substitutedElement.errors && substitutedElement.errors.length > 0) {
                return { ...arrayType, errors: substitutedElement.errors };
            }
            
            return arrayType;
        }

        if (isNullableType(type)) {
            const substitutedBase = this.substituteGenerics(type.baseType, substitutions, context ? `${context} nullable base` : 'nullable base', errors);
            
            // Check for illegal nullable types during substitution
            // 1. Check for double nullable (T? substituted with U? becomes U??)
            if (isNullableType(substitutedBase)) {
                const errorMsg = `Illegal double nullable type '${substitutedBase.toString()}?' - nullable types cannot be nested${context ? ` in ${context}` : ''}`;
                if (errors) {
                    errors.push(errorMsg);
                }
                // Return error type immediately for double nullable
                return this.typeFactory.createErrorType(errorMsg, ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE, type.node);
            }
            
            // 2. Check for basic types being made nullable (u32? is illegal)
            if (this.isTypeBasic(substitutedBase)) {
                const errorMsg = `Illegal nullable basic type '${substitutedBase.toString()}?' - basic types cannot be nullable${context ? ` in ${context}` : ''}`;
                if (errors) {
                    errors.push(errorMsg);
                }
                // Return the nullable type but with error recorded
                const nullableType = this.typeFactory.createNullableType(substitutedBase, type.node);
                return { ...nullableType, errors: errors ? [...errors] : [errorMsg] };
            }
            
            // 3. Propagate errors from substitutedBase if it has any
            const nullableType = this.typeFactory.createNullableType(substitutedBase, type.node);
            if (substitutedBase.errors && substitutedBase.errors.length > 0) {
                return { ...nullableType, errors: substitutedBase.errors };
            }
            
            return nullableType;
        }

        if (isUnionType(type)) {
            const substitutedTypes = type.types.map(t => this.substituteGenerics(t, substitutions, context, errors));
            const unionType = this.typeFactory.createUnionType(substitutedTypes, type.node);
            
            // Propagate errors from union members
            const allErrors: string[] = [];
            for (const memberType of substitutedTypes) {
                if (memberType.errors && memberType.errors.length > 0) {
                    allErrors.push(...memberType.errors);
                }
            }
            
            if (allErrors.length > 0) {
                return { ...unionType, errors: allErrors };
            }
            
            return unionType;
        }

        if (isJoinType(type)) {
            const substitutedTypes = type.types.map(t => this.substituteGenerics(t, substitutions, context, errors));
            const joinType = this.typeFactory.createJoinType(substitutedTypes, type.node);
            
            // Propagate errors from join members
            const allErrors: string[] = [];
            for (const memberType of substitutedTypes) {
                if (memberType.errors && memberType.errors.length > 0) {
                    allErrors.push(...memberType.errors);
                }
            }
            
            if (allErrors.length > 0) {
                return { ...joinType, errors: allErrors };
            }
            
            return joinType;
        }

        if (isTupleType(type)) {
            const substitutedTypes = type.elementTypes.map(t => this.substituteGenerics(t, substitutions, context, errors));
            const tupleType = this.typeFactory.createTupleType(substitutedTypes, type.node);
            
            // Propagate errors from tuple elements
            const allErrors: string[] = [];
            for (const elementType of substitutedTypes) {
                if (elementType.errors && elementType.errors.length > 0) {
                    allErrors.push(...elementType.errors);
                }
            }
            
            if (allErrors.length > 0) {
                return { ...tupleType, errors: allErrors };
            }
            
            return tupleType;
        }

        if (isStructType(type)) {
            const substitutedFields = type.fields.map(f =>
                this.typeFactory.createStructField(
                    f.name,
                    this.substituteGenerics(f.type, substitutions, `struct field '${f.name}'`, errors),
                    f.node
                )
            );
            const structType = this.typeFactory.createStructType(substitutedFields, type.isAnonymous, type.node);
            
            // Propagate errors from any field
            const fieldErrors = substitutedFields
                .map(f => f.type.errors)
                .filter(e => e && e.length > 0)
                .flat() as string[];
            
            if (fieldErrors.length > 0) {
                return { ...structType, errors: fieldErrors };
            }
            
            return structType;
        }

        if (isFunctionType(type)) {
            const substitutedParams = type.parameters.map((p, idx) =>
                this.typeFactory.createFunctionParameterType(
                    p.name,
                    this.substituteGenerics(p.type, substitutions, p.name ? `function parameter '${p.name}'` : `function parameter ${idx + 1}`, errors),
                    p.isMut
                )
            );
            const substitutedReturn = this.substituteGenerics(type.returnType, substitutions, 'function return type', errors);
            
            // Filter out generic parameters that have been substituted
            const remainingGenerics = type.genericParameters?.filter(g => !substitutions.has(g.name)) ?? [];
            
            const functionType = this.typeFactory.createFunctionType(
                substitutedParams,
                substitutedReturn,
                type.fnType,
                remainingGenerics,
                type.node
            );
            
            // Propagate errors from parameters and return type
            const allErrors: string[] = [];
            
            // Collect errors from parameters
            for (const param of substitutedParams) {
                if (param.type.errors && param.type.errors.length > 0) {
                    allErrors.push(...param.type.errors);
                }
            }
            
            // Collect errors from return type
            if (substitutedReturn.errors && substitutedReturn.errors.length > 0) {
                allErrors.push(...substitutedReturn.errors);
            }
            
            if (allErrors.length > 0) {
                return { ...functionType, errors: allErrors };
            }
            
            return functionType;
        }

        if (isReferenceType(type) && type.genericArgs.length > 0) {
            const substitutedArgs = type.genericArgs.map(t => this.substituteGenerics(t, substitutions, context, errors));
            
            const refType = this.typeFactory.createReferenceType(
                type.declaration,
                substitutedArgs,
                type.node
            );
            
            // CRITICAL: Check if the substituted reference type itself will contain errors
            // This handles nested generic substitutions like Provider<T> with Maybe<T> where Maybe has T?
            // We need to resolve the reference and check if it contains errors
            // BUT we must avoid infinite recursion for recursive types like TreeNode<T> = { children: TreeNode<T>[]? }
            let resolvedErrors: string[] = [];
            
            // Only resolve if we're not already checking this reference (cycle detection)
            // Check if this reference is already in our pending checks
            const isAlreadyChecking = this.pendingChecks.some(pair =>
                isReferenceType(pair.from) &&
                pair.from.declaration === type.declaration &&
                pair.from.genericArgs.length === substitutedArgs.length &&
                pair.from.genericArgs.every((arg, i) => this.areTypesEqual(arg, substitutedArgs[i]).success)
            );
            
            if (!isAlreadyChecking) {
                // Add to pending checks to prevent infinite recursion
                this.addPendingCheck(refType, refType);
                
                try {
                    // Resolve the reference to check if the instantiated type contains errors
                    const resolved = this.typeProvider().resolveReference(refType);
                    if (resolved.errors && resolved.errors.length > 0) {
                        // Enhance error messages with context about where this reference is being used
                        if (context) {
                            resolvedErrors = resolved.errors.map(err =>
                                `${err} (used in ${context})`
                            );
                        } else {
                            resolvedErrors = resolved.errors;
                        }
                    }
                } finally {
                    // Always remove from pending checks
                    this.removePendingCheck(refType, refType);
                }
            }
            
            // Propagate errors from both generic arguments AND the resolved type
            const allErrors: string[] = [];
            
            // Collect errors from generic arguments themselves
            for (const arg of substitutedArgs) {
                if (arg.errors && arg.errors.length > 0) {
                    allErrors.push(...arg.errors);
                }
            }
            
            // Add errors from the resolved type
            if (resolvedErrors.length > 0) {
                allErrors.push(...resolvedErrors);
            }
            
            if (allErrors.length > 0) {
                return { ...refType, errors: allErrors };
            }
            
            return refType;
        }

        if (isVariantConstructorType(type) && type.genericArgs.length > 0) {
            const substitutedArgs = type.genericArgs.map(t => this.substituteGenerics(t, substitutions, context, errors));
            const variantConstructorType = this.typeFactory.createVariantConstructorType(
                type.baseVariant,
                type.constructorName,
                type.parentConstructor,
                substitutedArgs,
                type.node,
                type.variantDeclaration
            );
            
            // Propagate errors from generic arguments AND from the base variant
            const allErrors: string[] = [];
            for (const arg of substitutedArgs) {
                if (arg.errors && arg.errors.length > 0) {
                    allErrors.push(...arg.errors);
                }
            }
            
            // CRITICAL: Propagate errors from the base variant
            // This handles cases where generic substitution in the variant definition
            // produces errors (e.g., T? -> i32? in variant constructor parameters)
            if (type.baseVariant.errors && type.baseVariant.errors.length > 0) {
                allErrors.push(...type.baseVariant.errors);
            }
            
            if (allErrors.length > 0) {
                return { ...variantConstructorType, errors: allErrors };
            }
            
            return variantConstructorType;
        }

        // Substitute generics in variant types
        if (isVariantType(type)) {
            const substitutedConstructors = type.constructors.map(constructor => {
                // Build the full constructor signature for better error messages
                const constructorSig = `${constructor.name}(${constructor.parameters.map(p => `${p.name}: ${p.type.toString()}`).join(', ')})`;
                
                return this.typeFactory.createVariantConstructor(
                    constructor.name,
                    constructor.parameters.map(param => {
                        // Build context with parent context if available
                        const paramContext = context
                            ? `${context} variant constructor '${constructorSig}' parameter '${param.name}'`
                            : `variant constructor '${constructorSig}' parameter '${param.name}'`;
                        return this.typeFactory.createStructField(
                            param.name,
                            this.substituteGenerics(param.type, substitutions, paramContext, errors),
                            param.node
                        );
                    })
                );
            });
            const variantType = this.typeFactory.createVariantType(substitutedConstructors, type.node);
            
            // Propagate errors from any constructor parameter
            const paramErrors: string[] = [];
            for (const constructor of substitutedConstructors) {
                for (const param of constructor.parameters) {
                    if (param.type.errors && param.type.errors.length > 0) {
                        paramErrors.push(...param.type.errors);
                    }
                }
            }
            
            if (paramErrors.length > 0) {
                return { ...variantType, errors: paramErrors };
            }
            
            return variantType;
        }
        if (isClassType(type)) {
            const substitutedAttributes = type.attributes.map(a =>
                this.typeFactory.createAttributeType(
                    a.name,
                    this.substituteGenerics(a.type, substitutions, `class attribute '${a.name}'`, errors),
                    a.isStatic,
                    a.isConst,
                    a.isLocal
                )
            );
            const substitutedMethods = type.methods.filter(m => !m.isStatic).map(m => {
                // Build the full method signature for better error messages
                const methodSig = `${m.names[0]}(${m.parameters.map(p => `${p.name}: ${p.type.toString()}`).join(', ')}) -> ${m.returnType.toString()}`;
                
                return this.typeFactory.createMethodType(
                    m.names,
                    m.parameters.map((p, idx) =>
                        this.typeFactory.createFunctionParameterType(
                            p.name,
                            this.substituteGenerics(p.type, substitutions, p.name ? `class method '${methodSig}' parameter '${p.name}'` : `class method '${methodSig}' parameter ${idx + 1}`, errors),
                            p.isMut
                        )
                    ),
                    this.substituteGenerics(m.returnType, substitutions, `class method '${methodSig}' return type`, errors),
                    m.node,
                    m.genericParameters,
                    m.isStatic,
                    m.isOverride,
                    m.isLocal
                );
            });
            const substitutedImplementations = type.implementations.map(i =>
                this.substituteGenerics(i, substitutions, context, errors) as TypeDescription
            );
            const substitutedSuperTypes = type.superTypes.map(t =>
                this.substituteGenerics(t, substitutions, context, errors)
            );
            const classType = this.typeFactory.createClassType(
                substitutedAttributes,
                substitutedMethods,
                substitutedSuperTypes,
                substitutedImplementations,
                type.node
            );
            
            // Propagate errors from attributes, method parameters/return types, implementations, and supertypes
            const allErrors: string[] = [];
            
            // Collect errors from attributes
            for (const attr of substitutedAttributes) {
                if (attr.type.errors && attr.type.errors.length > 0) {
                    allErrors.push(...attr.type.errors);
                }
            }
            
            // Collect errors from methods (parameters and return types)
            for (const method of substitutedMethods) {
                for (const param of method.parameters) {
                    if (param.type.errors && param.type.errors.length > 0) {
                        allErrors.push(...param.type.errors);
                    }
                }
                if (method.returnType.errors && method.returnType.errors.length > 0) {
                    allErrors.push(...method.returnType.errors);
                }
            }
            
            // Collect errors from implementations
            for (const impl of substitutedImplementations) {
                if (impl.errors && impl.errors.length > 0) {
                    allErrors.push(...impl.errors);
                }
            }
            
            // Collect errors from super types
            for (const superType of substitutedSuperTypes) {
                if (superType.errors && superType.errors.length > 0) {
                    allErrors.push(...superType.errors);
                }
            }
            
            if (allErrors.length > 0) {
                return { ...classType, errors: allErrors };
            }
            
            return classType;
        }

        if (isInterfaceType(type)) {
            const substitutedMethods = type.methods.map(m => {
                // Build the full method signature for better error messages
                const methodSig = `${m.names[0]}(${m.parameters.map(p => `${p.name}: ${p.type.toString()}`).join(', ')}) -> ${m.returnType.toString()}`;
                
                return this.typeFactory.createMethodType(
                    m.names,
                    m.parameters.map((p, idx) => {
                        const paramContext = p.name
                            ? `interface method '${methodSig}' parameter '${p.name}'`
                            : `interface method '${methodSig}' parameter ${idx + 1}`;
                        return this.typeFactory.createFunctionParameterType(
                            p.name,
                            this.substituteGenerics(p.type, substitutions, paramContext, errors),
                            p.isMut
                        );
                    }),
                    this.substituteGenerics(m.returnType, substitutions, `interface method '${methodSig}' return type`, errors),
                    m.node,
                    m.genericParameters,
                    m.isStatic,
                    m.isOverride,
                    m.isLocal
                );
            });
            const substitutedSuperTypes = type.superTypes.map(t =>
                this.substituteGenerics(t, substitutions, context, errors)
            );
            const interfaceType = this.typeFactory.createInterfaceType(substitutedMethods, substitutedSuperTypes, type.node);
            
            // Propagate errors from method parameters/return types and supertypes
            const allErrors: string[] = [];
            
            // Collect errors from methods (parameters and return types)
            for (const method of substitutedMethods) {
                for (const param of method.parameters) {
                    if (param.type.errors && param.type.errors.length > 0) {
                        allErrors.push(...param.type.errors);
                    }
                }
                if (method.returnType.errors && method.returnType.errors.length > 0) {
                    allErrors.push(...method.returnType.errors);
                }
            }
            
            // Collect errors from super types
            for (const superType of substitutedSuperTypes) {
                if (superType.errors && superType.errors.length > 0) {
                    allErrors.push(...superType.errors);
                }
            }
            
            if (allErrors.length > 0) {
                return { ...interfaceType, errors: allErrors };
            }
            
            return interfaceType;
        }

        if (isTypeGuardType(type)) {
            const substitutedGuardedType = this.substituteGenerics(type.guardedType, substitutions, context, errors);
            const typeGuardType = this.typeFactory.createTypeGuardType(
                type.parameterName,
                type.parameterIndex,
                substitutedGuardedType,
                type.node
            );
            
            // Propagate errors from guarded type
            if (substitutedGuardedType.errors && substitutedGuardedType.errors.length > 0) {
                return { ...typeGuardType, errors: substitutedGuardedType.errors };
            }
            
            return typeGuardType;
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
        const resolvedTypes = flatTypes.map(t => this.resolveIfReference(t));

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
                            return this.typeFactory.createErrorType(
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
                this.typeFactory.createStructField(name, info.type, info.nodes[0])
            );
            return this.typeFactory.createStructType(allFields, false, type.node);
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
            return this.typeFactory.createInterfaceType(allMethods, allSuperTypes, type.node);
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

    // ============================================================================
    // Common Type Inference
    // ============================================================================

    /**
     * Find the common type of multiple types.
     *
     * Used for:
     * - Return type inference (all return statements)
     * - Array literal inference (all elements)
     * - Match expression inference (all arms)
     *
     * Strategy:
     * 1. If all types are identical → use that type
     * 2. If all are structs → find common fields (structural subtyping)
     * 3. If types are compatible via coercion → use the wider type (TODO)
     * 4. Otherwise → error type
     */
    getCommonType(types: TypeDescription[]): TypeDescription {
        if (types.length === 0) {
            return this.typeFactory.createVoidType();
        }

        if (types.length === 1) {
            return types[0];
        }

        // Filter out never types first - they're the bottom type and assignable to everything
        // This allows branches like `throw "error"` (never) to unify with other branches
        const nonNeverTypes = types.filter(t => t.kind !== TypeKind.Never);
        
        // If all types are never, return never
        if (nonNeverTypes.length === 0) {
            return this.typeFactory.createNeverType();
        }
        
        // If we filtered out some never types and only one type remains, return it
        if (nonNeverTypes.length === 1) {
            return nonNeverTypes[0];
        }
        
        // Continue with non-never types
        types = nonNeverTypes;

        // Handle type guards specially
        // Type guards can be unified with each other (if same parameter) or with bool
        const typeGuards = types.filter(isTypeGuardType);
        const boolTypes = types.filter(t => t.kind === TypeKind.Bool);
        const otherTypes = types.filter(t => !isTypeGuardType(t) && t.kind !== TypeKind.Bool);
        
        if (typeGuards.length > 0) {
            // If we have type guards mixed with bools or other types, result is bool
            if (boolTypes.length > 0 || otherTypes.length > 0) {
                return this.typeFactory.createBoolType();
            }
            
            // All are type guards - check if they reference the same parameter
            const firstGuard = typeGuards[0];
            const allSameParameter = typeGuards.every(g => g.parameterIndex === firstGuard.parameterIndex);
            
            if (!allSameParameter) {
                return this.typeFactory.createErrorType(
                    `Cannot infer common type: type guards reference different parameters`,
                    undefined,
                    types[0].node
                );
            }
            
            // Find common guarded type
            const guardedTypes = typeGuards.map(g => g.guardedType);
            const commonGuardedType = this.getCommonType(guardedTypes);
            
            if (isErrorType(commonGuardedType)) {
                return this.typeFactory.createErrorType(
                    `Cannot infer common type: type guard guarded types are incompatible`,
                    commonGuardedType.message,
                    types[0].node
                );
            }
            
            // Return a type guard with the common guarded type
            return this.typeFactory.createTypeGuardType(
                firstGuard.parameterName,
                firstGuard.parameterIndex,
                commonGuardedType,
                types[0].node
            );
        }

        // Separate null types from non-null types
        const nullTypes = types.filter(t => t.kind === TypeKind.Null);
        const nonNullTypes = types.filter(t => t.kind !== TypeKind.Null);

        // If all types are null, return null
        if (nonNullTypes.length === 0) {
            return this.typeFactory.createNullType();
        }

        // Find common type of non-null types
        let commonType: TypeDescription;

        if (nonNullTypes.length === 1) {
            commonType = nonNullTypes[0];
        } else {
            // CRITICAL FIX: Handle arrays specially to recursively find common element types
            // This allows u32?[] and u32[] to unify to u32?[]
            const allArrays = nonNullTypes.every(t => isArrayType(t));
            if (allArrays) {
                const arrayTypes = nonNullTypes.filter(isArrayType);
                const elementTypes = arrayTypes.map(a => a.elementType);
                const commonElementType = this.getCommonType(elementTypes);
                
                if (isErrorType(commonElementType)) {
                    return commonElementType;
                }
                
                commonType = this.typeFactory.createArrayType(commonElementType, types[0].node);
            }
            // CRITICAL FIX: Handle tuples specially to recursively find common element types
            // This allows tuples with different element types at each position to unify
            // Example: (u32, f32) and (u32, f32) unify to (u32, f32)
            // Example: (Result.Ok<u32, never>, f32) and (Result.Err<never, string>, f32) unify to (Result<u32, string>, f32)
            else if (nonNullTypes.every(t => isTupleType(t))) {
                const tupleTypes = nonNullTypes.filter(isTupleType);
                
                // All tuples must have the same arity (number of elements)
                const firstTuple = tupleTypes[0];
                const allSameArity = tupleTypes.every(t => t.elementTypes.length === firstTuple.elementTypes.length);
                
                if (!allSameArity) {
                    return this.typeFactory.createErrorType(
                        `Cannot infer common type: tuples have different arities: ${types.map(t => t.toString()).join(', ')}`,
                        undefined,
                        types[0].node
                    );
                }
                
                // Find common type for each position
                const commonElementTypes: TypeDescription[] = [];
                for (let i = 0; i < firstTuple.elementTypes.length; i++) {
                    const typesAtPosition = tupleTypes.map(t => t.elementTypes[i]);
                    const commonTypeAtPosition = this.getCommonType(typesAtPosition);
                    
                    if (isErrorType(commonTypeAtPosition)) {
                        return this.typeFactory.createErrorType(
                            `Cannot infer common type: tuple element at position ${i + 1} has incompatible types: ${typesAtPosition.map(t => t.toString()).join(', ')}`,
                            undefined,
                            types[0].node
                        );
                    }
                    
                    commonElementTypes.push(commonTypeAtPosition);
                }
                
                commonType = this.typeFactory.createTupleType(commonElementTypes, types[0].node);
            }
            // Handle function types by recursively finding common return type
            // This allows [fn() -> Result.Ok<i32, never>, fn() -> Result.Err<never, string>] to unify
            // CRITICAL FIX: Resolve reference types to handle type aliases like StringGuard
            else if (nonNullTypes.every(t => {
                const resolved = this.resolveIfReference(t);
                return isFunctionType(resolved);
            })) {
                // Resolve any references to get actual function types
                const functionTypes = nonNullTypes.map(t => this.resolveIfReference(t)).filter(isFunctionType);
                
                // Check if all functions have the same parameter count
                const firstFunc = functionTypes[0];
                const allSameParamCount = functionTypes.every(fn =>
                    fn.parameters.length === firstFunc.parameters.length
                );
                
                if (!allSameParamCount) {
                    return this.typeFactory.createErrorType(
                        `Cannot infer common type: function parameter counts differ`,
                        undefined,
                        types[0].node
                    );
                }
                
                // Unify parameter types (find common type for each position)
                // This allows never to unify with concrete types
                const unifiedParams: { name: string; type: TypeDescription; isMut: boolean }[] = [];
                for (let i = 0; i < firstFunc.parameters.length; i++) {
                    const paramTypesAtPosition = functionTypes.map(fn => fn.parameters[i].type);
                    const commonParamType = this.getCommonType(paramTypesAtPosition);
                    
                    if (isErrorType(commonParamType)) {
                        return this.typeFactory.createErrorType(
                            `Cannot infer common type: function parameter ${i + 1} has incompatible types: ${paramTypesAtPosition.map(t => t.toString()).join(', ')}`,
                            undefined,
                            types[0].node
                        );
                    }
                    
                    unifiedParams.push({
                        name: firstFunc.parameters[i].name,
                        type: commonParamType,
                        isMut: firstFunc.parameters[i].isMut
                    });
                }
                
                // Unify return types
                const returnTypes = functionTypes.map(fn => fn.returnType);
                const commonReturnType = this.getCommonType(returnTypes);
                
                if (isErrorType(commonReturnType)) {
                    return commonReturnType;
                }
                
                // Create function type with unified parameter and return types
                commonType = this.typeFactory.createFunctionType(
                    unifiedParams,
                    commonReturnType,
                    firstFunc.fnType,
                    firstFunc.genericParameters,
                    types[0].node
                );
            }
            // CRITICAL FIX: Check if types differ only in nullability
            // This allows u32? and u32 to unify to u32?
            else {
                // Unwrap any nullable types and check if base types are identical
                const unwrappedTypes = nonNullTypes.map(t => ({
                    original: t,
                    base: isNullableType(t) ? t.baseType : t,
                    wasNullable: isNullableType(t)
                }));

                const firstBase = unwrappedTypes[0].base;
                const allBasesIdentical = unwrappedTypes.every(item =>
                    this.areTypesEqual(item.base, firstBase).success
                );

                if (allBasesIdentical) {
                    // All types have the same base type, possibly with different nullability
                    commonType = firstBase;
                    
                    // If any were nullable, make the result nullable
                    if (unwrappedTypes.some(item => item.wasNullable)) {
                        commonType = this.typeFactory.createNullableType(commonType, types[0].node);
                    }
                } else {
                    // CRITICAL: Handle string literal + string combinations FIRST
                    // String literals should widen to string when mixed with string type
                    // This enables: string ∪ "VarDecl" → string
                    const hasString = nonNullTypes.some(t => t.kind === TypeKind.String);
                    const hasStringLiterals = nonNullTypes.some(t => isStringLiteralType(t));
                    const hasStringEnums = nonNullTypes.some(t => isStringEnumType(t));
                    const allStringRelated = nonNullTypes.every(t =>
                        t.kind === TypeKind.String || isStringLiteralType(t) || isStringEnumType(t)
                    );
                    
                    if (allStringRelated && (hasString || hasStringLiterals || hasStringEnums)) {
                        // If any is string type, widen all to string
                        if (hasString) {
                            commonType = this.typeFactory.createStringType();
                        } else {
                            // All are string literals/enums - combine them into a string enum
                            const allLiterals = nonNullTypes.filter(isStringLiteralType);
                            const allEnums = nonNullTypes.filter(isStringEnumType);
                            
                            // Collect all string values
                            const values = new Set<string>();
                            for (const lit of allLiterals) {
                                values.add(lit.value);
                            }
                            for (const enumType of allEnums) {
                                for (const val of enumType.values) {
                                    values.add(val);
                                }
                            }
                            
                            commonType = this.typeFactory.createStringEnumType(Array.from(values), types[0].node);
                        }
                    } else {
                        // Check if all non-null types are identical
                        const firstType = nonNullTypes[0];
                        const allIdentical = nonNullTypes.every(t => this.areTypesEqual(t, firstType).success);

                        if (allIdentical) {
                            commonType = firstType;
                        } else {
                            // CRITICAL: Check if types differ only by generic constraints
                            // This handles: T: Numeric and Numeric should unify to Numeric
                            // Resolve any generics to their constraints for comparison
                            const resolvedTypes = nonNullTypes.map(t => this.resolveIfGeneric(t));
                            const firstResolved = resolvedTypes[0];
                            const allResolvedIdentical = resolvedTypes.every(t =>
                                this.areTypesEqual(t, firstResolved).success
                            );
                            
                            if (allResolvedIdentical) {
                                // All types resolve to the same constraint - use the constraint
                                commonType = firstResolved;
                            } else {
                                // Check if all are struct types (or join types that resolve to structs) - use structural subtyping
                                const structTypes = nonNullTypes.map(t => this.asStructType(t)).filter((t): t is StructTypeDescription => t !== undefined);
                                if (structTypes.length === nonNullTypes.length) {
                                    // All types are structs or resolve to structs
                                    commonType = this.getCommonStructType(structTypes);
                                    // Check if getCommonStructType returned an error
                                    if (isErrorType(commonType)) {
                                        return commonType;
                                    }
                                } else {
                                    // Check if all are references to the same declaration (e.g., Result<i32, never> and Result<never, string>)
                                    // This handles arrays of variant constructor calls: [Result.Ok(1), Result.Err("error")]
                                    const allReferences = nonNullTypes.every(t => isReferenceType(t));
                                    if (allReferences) {
                                        const referenceTypes = nonNullTypes.filter(isReferenceType);
                                        const firstDecl = referenceTypes[0].declaration;

                                        // Check if all references point to the same declaration
                                        const allSameDecl = referenceTypes.every(ref => ref.declaration === firstDecl);
                                        if (allSameDecl) {
                                            // Unify generic arguments across all references
                                            commonType = this.getCommonReferenceType(referenceTypes);
                                            // Check if getCommonReferenceType returned an error
                                            if (isErrorType(commonType)) {
                                                return commonType;
                                            }
                                        } else {
                                            // Different declarations - try structural LUB (NEW!)
                                            // This enables finding common supertypes for structural subtypes
                                            // Example: [AstNode, VarDecl] → struct { _type: string }
                                            commonType = this.computeLeastUpperBound(referenceTypes);
                                            if (isErrorType(commonType)) {
                                                return commonType;
                                            }
                                        }
                                    } else {
                                        // Check if all are variant constructors - unify generic arguments
                                        const allVariantConstructors = nonNullTypes.every(t => isVariantConstructorType(t));
                                        if (allVariantConstructors) {
                                            commonType = this.getCommonVariantConstructorType(nonNullTypes.filter(isVariantConstructorType));
                                            // Check if getCommonVariantConstructorType returned an error
                                            if (isErrorType(commonType)) {
                                                return commonType;
                                            }
                                        } else {
                                            // Check for MIXED case: ReferenceTypes and VariantConstructorTypes to the same variant
                                            // Example: Result<U, E> and Result.Err<never, E> should unify to Result<U, E>
                                            const hasReferences = nonNullTypes.some(t => isReferenceType(t));
                                            const hasConstructors = nonNullTypes.some(t => isVariantConstructorType(t));
                                            
                                            if (hasReferences && hasConstructors) {
                                                // Try to unify mixed references and constructors
                                                const unified = this.getCommonMixedVariantTypes(nonNullTypes);
                                                if (!isErrorType(unified)) {
                                                    commonType = unified;
                                                } else {
                                                    return unified;
                                                }
                                            } else {
                                                // TODO: Implement numeric type widening (e.g., i32 + u32 → i64)
                                                // For now, if types differ, it's an error
                                                return this.typeFactory.createErrorType(
                                                    `Cannot infer common type: found ${types.map(t => t.toString()).join(', ')}`,
                                                    undefined,
                                                    firstType.node
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // If we had any nulls, wrap the common type in Nullable (but only once)
        if (nullTypes.length > 0) {
            // Don't double-wrap if commonType is already nullable
            if (isNullableType(commonType)) {
                return commonType;
            }
            const nullableType = this.typeFactory.createNullableType(commonType, types[0].node);
            
            // Check if we created a nullable basic type
            if (isNullableType(nullableType) && this.isTypeBasic(nullableType.baseType)) {
                return this.typeFactory.createErrorType(
                    `Cannot create expression with nullable basic type '${nullableType.toString()}'. ` +
                    `Basic types cannot be nullable. ` +
                    `Consider using a wrapper type or handling null differently.`,
                    ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE
                );
            }
            
            return nullableType;
        }

        return commonType;
    }

    /**
     * Find the common type for references to the same declaration with different generic arguments.
     *
     * This handles arrays like:
     * ```
     * [Result.Ok(1), Result.Err("error")]
     * → [Result<i32, never>, Result<never, string>]
     * → Result<i32, string>[]
     * ```
     *
     * Strategy:
     * - For each generic parameter position, collect all types
     * - Replace `never` with concrete types from other elements
     * - All concrete types in a position must be identical
     */
    private getCommonReferenceType(types: TypeDescription[]): TypeDescription {
        // We know all types are ReferenceType from the caller
        const referenceTypes = types.filter(isReferenceType);
        if (referenceTypes.length === 0) {
            return this.typeFactory.createErrorType('Expected reference types', undefined, types[0].node);
        }
        
        const firstRef = referenceTypes[0];
        const declaration = firstRef.declaration;
        const numGenericParams = firstRef.genericArgs.length;

        // If no generic parameters, all types are identical
        if (numGenericParams === 0) {
            return firstRef;
        }

        // Unify generic arguments across all references
        const unifiedGenericArgs: TypeDescription[] = [];

        for (let i = 0; i < numGenericParams; i++) {
            // Collect all types at this position
            const typesAtPosition = referenceTypes.map(ref => ref.genericArgs[i]);

            // Filter out never types
            const concreteTypes = typesAtPosition.filter(t => t.kind !== TypeKind.Never);

            if (concreteTypes.length === 0) {
                // All are never - keep never
                unifiedGenericArgs.push(this.typeFactory.createNeverType());
            } else {
                // Check if all concrete types are identical
                const firstConcreteType = concreteTypes[0];
                const allIdentical = concreteTypes.every(t => this.areTypesEqual(t, firstConcreteType).success);

                if (allIdentical) {
                    // All concrete types match - use that type
                    unifiedGenericArgs.push(firstConcreteType);
                } else {
                    // Multiple different concrete types - error
                    return this.typeFactory.createErrorType(
                        `Cannot infer common type: generic parameter at position ${i + 1} has incompatible types: ${concreteTypes.map(t => t.toString()).join(', ')}`,
                        undefined,
                        firstRef.node
                    );
                }
            }
        }

        // Create a reference to the same declaration with unified generic arguments
        return this.typeFactory.createReferenceType(declaration, unifiedGenericArgs, firstRef.node);
    }

    /**
     * Find the common struct type (intersection of fields).
     *
     * Type-C uses structural subtyping for structs:
     * - `{x: u32, y: u32, z: u32}` is compatible with `{x: u32, y: u32}`
     * - Common fields must have EXACT matching types (u32 ≠ u64)
     *
     * Example:
     * ```
     * {x: 1u32, y: 2u32}         // struct { x: u32, y: u32 }
     * {x: 3u32, y: 4u32, z: 5u32} // struct { x: u32, y: u32, z: u32 }
     * → struct { x: u32, y: u32 }  // Common fields only
     * ```
     */
    private getCommonStructType(types: TypeDescription[]): TypeDescription {
        const structTypes = types.filter(isStructType);

        // Get all field names from each struct
        const allFieldSets = structTypes.map(st => {
            const fields = new Map<string, TypeDescription>();
            if (st.fields) {
                for (const field of st.fields) {
                    fields.set(field.name, field.type);
                }
            }
            return fields;
        });

        // Find common field names (intersection)
        const firstFieldSet = allFieldSets[0];
        const commonFieldNames = new Set<string>();

        for (const fieldName of firstFieldSet.keys()) {
            const isPresentInAll = allFieldSets.every(fieldSet => fieldSet.has(fieldName));
            if (isPresentInAll) {
                commonFieldNames.add(fieldName);
            }
        }

        if (commonFieldNames.size === 0) {
            return this.typeFactory.createErrorType(
                `Cannot infer common struct type: no common fields found`,
                undefined,
                types[0].node
            );
        }

        // Find common type for each field (allows unification of variant constructors, etc.)
        const commonFields: StructFieldType[] = [];

        for (const fieldName of commonFieldNames) {
            // Collect all types for this field across all structs
            const fieldTypes = allFieldSets.map(fieldSet => fieldSet.get(fieldName)!);
            
            // Find common type (this handles variant constructor unification, etc.)
            const commonFieldType = this.getCommonType(fieldTypes);
            
            if (isErrorType(commonFieldType)) {
                // Enhance error message with field context
                return this.typeFactory.createErrorType(
                    `Cannot infer common struct type: field '${fieldName}' has incompatible types: ${fieldTypes.map(t => t.toString()).join(', ')}`,
                    undefined,
                    types[0].node
                );
            }

            commonFields.push({
                name: fieldName,
                type: commonFieldType,
                node: commonFieldType.node || fieldTypes[0].node!
            });
        }

        // Create the common struct type (not anonymous - show 'struct' keyword)
        return this.typeFactory.createStructType(commonFields, false, types[0].node);
    }

    /**
     * Find the common type for variant constructors by unifying their generic arguments.
     *
     * Type-C allows variant constructors to be subtypes of their base variant:
     * - `Result.Ok<i32, never>` is a subtype of `Result<i32, E>` for any E
     * - `Result.Err<never, string>` is a subtype of `Result<T, string>` for any T
     *
     * When constructors are in an array, we unify their generic arguments:
     * - `never` is replaced by concrete types from other constructors
     * - All concrete types in a position must be identical or one must be never
     *
     * Example:
     * ```
     * [Result.Ok(1), Result.Err("error")]
     * → [Result<i32, never>.Ok, Result<never, string>.Err]
     * → Result<i32, string>[]
     * ```
     */
    private getCommonVariantConstructorType(types: VariantConstructorTypeDescription[]): TypeDescription {
        const firstConstructor = types[0];

        // Extract base variant declaration (prefer variantDeclaration field)
        let baseVariantDecl: ast.TypeDeclaration | undefined = firstConstructor.variantDeclaration;

        // Fallback to extracting from baseVariant.node if declaration not available
        if (!baseVariantDecl) {
            const variantAstNode = firstConstructor.baseVariant.node;
            if (variantAstNode && ast.isVariantType(variantAstNode)) {
                baseVariantDecl = AstUtils.getContainerOfType(variantAstNode, ast.isTypeDeclaration);
            }
        }

        if (!baseVariantDecl) {
            return this.typeFactory.createErrorType(
                'Cannot infer common type: variant constructor has no base variant declaration',
                undefined,
                firstConstructor.node
            );
        }

        // Check that all constructors belong to the same base variant
        const allSameBase = types.every(constructor => {
            // Prefer variantDeclaration field for comparison
            const constructorDecl = constructor.variantDeclaration;
            if (constructorDecl) {
                return constructorDecl === baseVariantDecl;
            }
            // Fallback to node comparison
            const constructorVariantNode = constructor.baseVariant.node;
            if (constructorVariantNode && ast.isVariantType(constructorVariantNode)) {
                const decl = AstUtils.getContainerOfType(constructorVariantNode, ast.isTypeDeclaration);
                return decl === baseVariantDecl;
            }
            return false;
        });

        if (!allSameBase) {
            return this.typeFactory.createErrorType(
                `Cannot infer common type: variant constructors from different variants: ${types.map(t => t.toString()).join(', ')}`,
                undefined,
                firstConstructor.node
            );
        }

        // Unify generic arguments across all constructors
        // For each generic parameter position, collect all types and merge
        const numGenericParams = firstConstructor.genericArgs.length;
        const unifiedGenericArgs: TypeDescription[] = [];

        for (let i = 0; i < numGenericParams; i++) {
            // Collect all types at this position
            const typesAtPosition = types.map(constructor => constructor.genericArgs[i]);

            // Filter out never types
            const concreteTypes = typesAtPosition.filter(t => t.kind !== TypeKind.Never);

            if (concreteTypes.length === 0) {
                // All are never - keep never
                unifiedGenericArgs.push(this.typeFactory.createNeverType());
            } else {
                // Check if all concrete types are identical
                const firstConcreteType = concreteTypes[0];
                const allIdentical = concreteTypes.every(t => this.areTypesEqual(t, firstConcreteType).success);

                if (allIdentical) {
                    // All concrete types match - use that type
                    unifiedGenericArgs.push(firstConcreteType);
                } else {
                    // Multiple different concrete types - error
                    return this.typeFactory.createErrorType(
                        `Cannot infer common type: generic parameter at position ${i + 1} has incompatible types: ${concreteTypes.map(t => t.toString()).join(', ')}`,
                        undefined,
                        firstConstructor.node
                    );
                }
            }
        }

        // Create a reference to the base variant with unified generic arguments
        return this.typeFactory.createReferenceType(baseVariantDecl, unifiedGenericArgs, firstConstructor.node);
    }

    /**
     * Find the common type for a mix of ReferenceTypes and VariantConstructorTypes to the same variant.
     *
     * This handles cases like:
     * ```
     * match r: Result<T, E> {
     *     Result.Ok(v) => f(v),        // Returns Result<U, E>
     *     Result.Err(e) => Result.Err(e) // Returns Result.Err<never, E>
     * }
     * → Result<U, E>
     * ```
     *
     * Strategy:
     * - Convert all VariantConstructorTypes to their base variant references
     * - Unify generic arguments across all types (references and constructors)
     * - Return a ReferenceType with unified generics
     */
    private getCommonMixedVariantTypes(types: TypeDescription[]): TypeDescription {
        // Extract base variant declaration - try to find it from any type
        let baseVariantDecl: ast.TypeDeclaration | undefined;
        
        // First try to find from ReferenceTypes
        for (const type of types) {
            if (isReferenceType(type)) {
                baseVariantDecl = type.declaration;
                break;
            }
        }
        
        // If not found, try VariantConstructorTypes
        if (!baseVariantDecl) {
            for (const type of types) {
                if (isVariantConstructorType(type)) {
                    baseVariantDecl = type.variantDeclaration;
                    break;
                }
            }
        }
        
        if (!baseVariantDecl) {
            return this.typeFactory.createErrorType(
                'Cannot infer common type: no base variant declaration found',
                undefined,
                types[0].node
            );
        }
        
        // Check that all types belong to the same base variant
        const allSameBase = types.every(type => {
            if (isReferenceType(type)) {
                return type.declaration === baseVariantDecl;
            }
            if (isVariantConstructorType(type)) {
                return type.variantDeclaration === baseVariantDecl;
            }
            return false;
        });
        
        if (!allSameBase) {
            return this.typeFactory.createErrorType(
                `Cannot infer common type: types belong to different variants`,
                undefined,
                types[0].node
            );
        }
        
        // Extract generic arguments from each type
        // For ReferenceType: use genericArgs directly
        // For VariantConstructorType: use genericArgs (they represent the same thing)
        const allGenericArgs = types.map(type => {
            if (isReferenceType(type)) {
                return [...type.genericArgs]; // Create mutable copy
            }
            if (isVariantConstructorType(type)) {
                return [...type.genericArgs]; // Create mutable copy
            }
            const emptyArray: TypeDescription[] = [];
            return emptyArray;
        });
        
        // Determine number of generic parameters
        const numGenericParams = allGenericArgs[0]?.length ?? 0;
        
        // Unify generic arguments across all types
        const unifiedGenericArgs: TypeDescription[] = [];
        
        for (let i = 0; i < numGenericParams; i++) {
            // Collect all types at this position
            const typesAtPosition = allGenericArgs.map(args => args[i]).filter(Boolean);
            
            // Filter out never types
            const concreteTypes = typesAtPosition.filter(t => t.kind !== TypeKind.Never);
            
            if (concreteTypes.length === 0) {
                // All are never - keep never
                unifiedGenericArgs.push(this.typeFactory.createNeverType());
            } else {
                // Check if all concrete types are identical
                const firstConcreteType = concreteTypes[0];
                const allIdentical = concreteTypes.every(t => this.areTypesEqual(t, firstConcreteType).success);
                
                if (allIdentical) {
                    // All concrete types match - use that type
                    unifiedGenericArgs.push(firstConcreteType);
                } else {
                    // Multiple different concrete types - error
                    return this.typeFactory.createErrorType(
                        `Cannot infer common type: generic parameter at position ${i + 1} has incompatible types: ${concreteTypes.map(t => t.toString()).join(', ')}`,
                        undefined,
                        types[0].node
                    );
                }
            }
        }
        
        // Create a reference to the base variant with unified generic arguments
        return this.typeFactory.createReferenceType(baseVariantDecl, unifiedGenericArgs, types[0].node);
    }

    // ============================================================================
    // Least Upper Bound (LUB) Algorithm for Structural Subtyping
    // ============================================================================

    /**
     * Resolves a type to its underlying structural representation.
     * This enables structural comparison across different named types.
     *
     * Resolution rules (TypeScript-style):
     * - ReferenceType → resolve via TypeProvider to get actual type definition
     * - NullableType → unwrap to base type (nullability handled separately)
     * - JoinType → simplify to merged struct/interface if possible
     * - Other → return as-is
     *
     * @param type The type to resolve
     * @returns The underlying structural type
     *
     * @example
     * ```
     * resolveToStructuralType(AstNode ref) → struct { _type: string }
     * resolveToStructuralType(u32?) → u32
     * resolveToStructuralType(Point & HasZ) → struct { x: f64, y: f64, z: f64 }
     * ```
     */
    private resolveToStructuralType(type: TypeDescription): TypeDescription {
        // Unwrap references to get actual type definitions
        if (isReferenceType(type)) {
            const resolved = this.typeProvider().resolveReference(type);
            // Recursively resolve in case reference points to another reference
            if (resolved !== type) {
                return this.resolveToStructuralType(resolved);
            }
            return resolved;
        }
        
        // Unwrap nullable - nullability is handled at higher level
        if (isNullableType(type)) {
            return this.resolveToStructuralType(type.baseType);
        }
        
        // Simplify join types to merged struct/interface if possible
        if (isJoinType(type)) {
            const simplified = this.simplifyJoin(type);
            if (simplified !== type && !isJoinType(simplified)) {
                return this.resolveToStructuralType(simplified);
            }
            return simplified;
        }
        
        // Already a structural type
        return type;
    }

    /**
     * Groups types by their structural category for category-specific LUB computation.
     *
     * Categories (TypeScript-inspired):
     * - 'struct': Structural record types with fields
     * - 'class': Nominal class types (name-based identity)
     * - 'interface': Structural interface types with methods
     * - 'variant': Algebraic data types with constructors
     * - 'string-enum': String literal unions
     * - 'primitive': Primitives (u32, string, etc.)
     * - 'array': Array types
     * - 'function': Function types
     * - 'other': Everything else
     *
     * @param types Array of types to group
     * @returns Map from category name to types in that category
     */
    private groupTypesByCategory(types: TypeDescription[]): Map<string, TypeDescription[]> {
        const groups = new Map<string, TypeDescription[]>();
        
        for (const type of types) {
            let category: string;
            
            if (isStructType(type)) {
                category = 'struct';
            } else if (isClassType(type)) {
                category = 'class';
            } else if (isInterfaceType(type)) {
                category = 'interface';
            } else if (isVariantType(type) || isVariantConstructorType(type)) {
                category = 'variant';
            } else if (isStringEnumType(type)) {
                category = 'string-enum';
            } else if (type.kind === TypeKind.String) {
                category = 'string';
            } else if (isArrayType(type)) {
                category = 'array';
            } else if (isFunctionType(type)) {
                category = 'function';
            } else if (isPrimitiveType(type)) {
                category = 'primitive';
            } else {
                category = 'other';
            }
            
            const group = groups.get(category) ?? [];
            group.push(type);
            groups.set(category, group);
        }
        
        return groups;
    }

    /**
     * Combines multiple string enum types into a single enum with all values.
     * This follows TypeScript's union behavior for string literal types.
     *
     * @param enums Array of string enum types to combine
     * @returns A single string enum with the union of all values
     *
     * @example
     * ```
     * combineStringEnums([("a" | "b"), ("b" | "c")]) → ("a" | "b" | "c")
     * ```
     */
    private combineStringEnums(enums: StringEnumTypeDescription[]): TypeDescription {
        if (enums.length === 0) {
            return this.typeFactory.createErrorType('No string enums to combine', undefined);
        }
        
        if (enums.length === 1) {
            return enums[0];
        }
        
        // Collect all unique values from all enums
        const allValues = new Set<string>();
        for (const enumType of enums) {
            for (const value of enumType.values) {
                allValues.add(value);
            }
        }
        
        return this.typeFactory.createStringEnumType(Array.from(allValues), enums[0].node);
    }

    /**
     * Normalizes an anonymous LUB result to a named type if it matches structurally.
     * This preserves named types in the result, matching TypeScript's behavior.
     * 
     * TypeScript behavior: When the LUB of [AstNode, VarDecl] is computed, if the result
     * structurally matches one of the original named types (like AstNode), use that named type.
     * 
     * Example:
     * - LUB of [AstNode, VarDecl] → struct { _type: string } (anonymous)
     * - Normalization: Check if matches AstNode → YES
     * - Result: AstNode (named type, more readable)
     * 
     * @param lubResult The computed LUB (potentially anonymous struct)
     * @param originalTypes The original input types (before resolution)
     * @returns Named type if structural match found, otherwise lubResult
     */
    private normalizeToNamedType(lubResult: TypeDescription, originalTypes: TypeDescription[]): TypeDescription {
        // Only normalize structs and interfaces
        if (!isStructType(lubResult) && !isInterfaceType(lubResult)) {
            return lubResult;
        }
        
        // Try to find an original type that structurally matches the LUB
        for (const original of originalTypes) {
            // Only consider reference types (named types)
            if (!isReferenceType(original)) {
                continue;
            }
            
            // Resolve the reference to get its structural type
            const resolved = this.typeProvider().resolveReference(original);
            
            // Check if structurally equal to the LUB
            if (isStructType(lubResult) && isStructType(resolved)) {
                const structsEqual = this.areStructTypesEqual(resolved, lubResult);
                if (structsEqual.success) {
                    // Found a structural match! Return the original named type
                    return original;
                }
            } else if (isInterfaceType(lubResult) && isInterfaceType(resolved)) {
                // For interfaces, check if they're structurally equal
                // (simplified check - could be enhanced)
                if (resolved === lubResult) {
                    return original;
                }
            }
        }
        
        // No match found - return the anonymous struct/interface
        return lubResult;
    }

    /**
     * Computes the Least Upper Bound (LUB) for struct types using structural subtyping.
     *
     * This implements TypeScript-style structural typing where the LUB is the intersection
     * of fields present in ALL input structs. Field types are computed recursively.
     *
     * Algorithm:
     * 1. Find common field names (intersection across all structs)
     * 2. For each common field, recursively compute LUB of field types
     * 3. Return struct with only common fields and their LUB types
     * 4. Error if no common fields exist (empty struct not allowed)
     *
     * This enables finding the minimal common supertype:
     * - `{x: u32, y: u32, z: u32}` ∪ `{x: u32, y: u32}` → `{x: u32, y: u32}`
     * - `{x: u32}` ∪ `{y: u32}` → Error (no common fields)
     *
     * @param structs Array of struct types to find LUB for
     * @returns The LUB struct type, or ErrorType if no valid LUB exists
     */
    private getLUBForStructs(structs: StructTypeDescription[]): TypeDescription {
        if (structs.length === 0) {
            return this.typeFactory.createErrorType(
                'Cannot compute LUB: no struct types provided',
                undefined
            );
        }
        
        if (structs.length === 1) {
            return structs[0];
        }
        
        // Step 1: Find common field names (intersection of all field name sets)
        const fieldNameSets = structs.map(s => new Set(s.fields.map(f => f.name)));
        const commonFieldNames = new Set<string>();
        
        // A field is common if it appears in ALL structs
        for (const fieldName of fieldNameSets[0]) {
            if (fieldNameSets.every(set => set.has(fieldName))) {
                commonFieldNames.add(fieldName);
            }
        }
        
        // Step 2: Check for empty result (not allowed - structs must have fields)
        if (commonFieldNames.size === 0) {
            const structReprs = structs.map(s => s.toString()).join(', ');
            return this.typeFactory.createErrorType(
                `Cannot infer common struct type: no common fields found among ${structReprs}`,
                'Structs must share at least one field to have a common supertype',
                structs[0].node
            );
        }
        
        // Step 3: For each common field, recursively compute LUB of field types
        const commonFields: StructFieldType[] = [];
        
        for (const fieldName of commonFieldNames) {
            // Collect all types for this field across all structs
            const fieldTypes = structs.map(s => {
                const field = s.fields.find(f => f.name === fieldName);
                // We know it exists because fieldName is in the intersection
                return field!.type;
            });
            
            // Recursively compute LUB for this field (handles nested structs, string literals, etc.)
            const fieldLUB = this.getCommonType(fieldTypes);
            
            if (isErrorType(fieldLUB)) {
                // Enhanced error message with field context
                return this.typeFactory.createErrorType(
                    `Cannot infer common struct type: field '${fieldName}' has incompatible types ${fieldTypes.map(t => t.toString()).join(', ')}`,
                    fieldLUB.message,
                    structs[0].node
                );
            }
            
            // Use the first struct's field node for the common field
            const firstFieldNode = structs[0].fields.find(f => f.name === fieldName)!.node;
            
            commonFields.push({
                name: fieldName,
                type: fieldLUB,
                node: firstFieldNode
            });
        }
        
        // Step 4: Create the LUB struct type (not anonymous - represents a supertype)
        return this.typeFactory.createStructType(
            commonFields,
            false, // Not anonymous - this is a structural supertype
            structs[0].node
        );
    }

    /**
     * Computes the Least Upper Bound (LUB) for interface types.
     *
     * Similar to struct LUB, but for interfaces with methods:
     * - Result contains only methods present in ALL input interfaces
     * - Method signatures (parameters) must match exactly
     * - Return types can vary (compute LUB recursively)
     *
     * @param interfaces Array of interface types to find LUB for
     * @returns The LUB interface type, or ErrorType if no valid LUB exists
     */
    private getLUBForInterfaces(interfaces: InterfaceTypeDescription[]): TypeDescription {
        if (interfaces.length === 0) {
            return this.typeFactory.createErrorType(
                'Cannot compute LUB: no interface types provided',
                undefined
            );
        }
        
        if (interfaces.length === 1) {
            return interfaces[0];
        }
        
        // Find common method names (intersection)
        const methodNameSets = interfaces.map(iface => {
            const names = new Set<string>();
            for (const method of iface.methods) {
                // Methods can have multiple names (operator overloading)
                for (const name of method.names) {
                    names.add(name);
                }
            }
            return names;
        });
        
        const commonMethodNames = new Set<string>();
        for (const methodName of methodNameSets[0]) {
            if (methodNameSets.every(set => set.has(methodName))) {
                commonMethodNames.add(methodName);
            }
        }
        
        if (commonMethodNames.size === 0) {
            return this.typeFactory.createErrorType(
                `Cannot infer common interface type: no common methods found`,
                undefined,
                interfaces[0].node
            );
        }
        
        // For each common method, verify signatures and compute LUB return type
        const commonMethods: MethodType[] = [];
        
        for (const methodName of commonMethodNames) {
            // Find all methods with this name across all interfaces
            const methodsWithName = interfaces.map(iface =>
                iface.methods.find(m => m.names.includes(methodName))!
            );
            
            // Verify all have same parameter count and types
            const firstMethod = methodsWithName[0];
            const allParamsMatch = methodsWithName.every(method => {
                if (method.parameters.length !== firstMethod.parameters.length) {
                    return false;
                }
                return method.parameters.every((param, i) =>
                    this.areTypesEqual(param.type, firstMethod.parameters[i].type).success
                );
            });
            
            if (!allParamsMatch) {
                return this.typeFactory.createErrorType(
                    `Cannot infer common interface type: method '${methodName}' has incompatible signatures`,
                    undefined,
                    interfaces[0].node
                );
            }
            
            // Compute LUB of return types
            const returnTypes = methodsWithName.map(m => m.returnType);
            const returnLUB = this.getCommonType(returnTypes);
            
            if (isErrorType(returnLUB)) {
                return this.typeFactory.createErrorType(
                    `Cannot infer common interface type: method '${methodName}' has incompatible return types`,
                    returnLUB.message,
                    interfaces[0].node
                );
            }
            
            // Create merged method with LUB return type
            commonMethods.push({
                names: firstMethod.names,
                parameters: firstMethod.parameters,
                returnType: returnLUB,
                genericParameters: firstMethod.genericParameters,
                isStatic: firstMethod.isStatic,
                isOverride: firstMethod.isOverride,
                isLocal: firstMethod.isLocal,
                node: firstMethod.node
            });
        }
        
        // Merge super types from all interfaces
        const allSuperTypes: TypeDescription[] = [];
        for (const iface of interfaces) {
            allSuperTypes.push(...iface.superTypes);
        }
        
        return this.typeFactory.createInterfaceType(commonMethods, allSuperTypes, interfaces[0].node);
    }

    /**
     * Computes the Least Upper Bound (LUB) of multiple types using structural subtyping.
     *
     * This is the core LUB algorithm that dispatches to category-specific handlers:
     * - Structs: Field intersection with recursive LUB
     * - Interfaces: Method intersection with recursive return type LUB
     * - String enums: Value union
     * - Classes: Name-based (no structural LUB)
     * - Mixed types: Special handling for string enum + string
     *
     * @param types Array of types to find LUB for
     * @returns The LUB type, or ErrorType if no valid LUB exists
     *
     * @example
     * ```
     * computeLeastUpperBound([AstNode, VarDecl]) → struct { _type: string }
     * computeLeastUpperBound([("a" | "b"), ("b" | "c")]) → ("a" | "b" | "c")
     * ```
     */
    private computeLeastUpperBound(types: TypeDescription[]): TypeDescription {
        if (types.length === 0) {
            return this.typeFactory.createVoidType();
        }
        
        if (types.length === 1) {
            return types[0];
        }
        
        // Step 1: Resolve all types to their structural representations
        const resolvedTypes = types.map(t => this.resolveToStructuralType(t));
        
        // Step 2: Group types by category
        const grouped = this.groupTypesByCategory(resolvedTypes);
        
        // Step 3: Handle single-category cases
        if (grouped.size === 1) {
            const [[category, categoryTypes]] = Array.from(grouped.entries());
            
            switch (category) {
                case 'struct':
                    // Compute LUB and normalize to named type if possible
                    const structLUB = this.getLUBForStructs(categoryTypes as StructTypeDescription[]);
                    return this.normalizeToNamedType(structLUB, types);
                    
                case 'interface':
                    // Compute LUB and normalize to named type if possible
                    const interfaceLUB = this.getLUBForInterfaces(categoryTypes as InterfaceTypeDescription[]);
                    return this.normalizeToNamedType(interfaceLUB, types);
                    
                case 'string-enum':
                    return this.combineStringEnums(categoryTypes as StringEnumTypeDescription[]);
                    
                case 'class':
                    // Classes are name-based, no structural LUB possible
                    return this.typeFactory.createErrorType(
                        `Cannot find LUB for different classes: ${categoryTypes.map(t => t.toString()).join(', ')}`,
                        'Classes use name-based identity, not structural typing',
                        types[0].node
                    );
                    
                case 'variant':
                    // Already handled by existing variant logic in getCommonType
                    // This should not be reached in normal flow
                    return this.typeFactory.createErrorType(
                        'Variant LUB computation should use existing getCommonVariantConstructorType',
                        undefined,
                        types[0].node
                    );
                    
                default:
                    // Primitives, arrays, functions, etc. - no LUB if not identical
                    const firstType = categoryTypes[0];
                    const allIdentical = categoryTypes.every(t =>
                        this.areTypesEqual(t, firstType).success
                    );
                    
                    if (allIdentical) {
                        return firstType;
                    }
                    
                    return this.typeFactory.createErrorType(
                        `Cannot find LUB for types in category '${category}': ${categoryTypes.map(t => t.toString()).join(', ')}`,
                        undefined,
                        types[0].node
                    );
            }
        }
        
        // Step 4: Handle mixed categories
        // Special case: string enum + string → string
        if (grouped.has('string-enum') && grouped.has('string')) {
            return this.typeFactory.createStringType();
        }
        
        // No other mixed category combinations are valid
        const categories = Array.from(grouped.keys()).join(', ');
        return this.typeFactory.createErrorType(
            `Cannot find LUB for mixed type categories: ${categories}`,
            `Types: ${types.map(t => t.toString()).join(', ')}`,
            types[0].node
        );
    }

    /**
     * Checks if a given type is a basic data type
     */
    isTypeBasic(type: TypeDescription) {
        // Direct primitive types
        function isBasic(type: TypeDescription){
            
            if (type.kind === TypeKind.U8 || type.kind === TypeKind.U16 ||
                type.kind === TypeKind.U32 || type.kind === TypeKind.U64 ||
                type.kind === TypeKind.I8 || type.kind === TypeKind.I16 ||
                type.kind === TypeKind.I32 || type.kind === TypeKind.I64 ||
                type.kind === TypeKind.F32 || type.kind === TypeKind.F64 ||
                type.kind === TypeKind.Bool || type.kind === TypeKind.Null
            ) {
                return true;
            }

            return false;
        }

        if(isBasic(type)){
            return true;
        }

        if(!type.node) {
            return false;
        }

        if(isReferenceType(type)) {
            let declType: AstNode = type.declaration.definition;
            while(ast.isReferenceType(declType)){
                declType = declType.field?.ref!;
            }
            
            /// string considired primitive but not basic!
            if (ast.isPrimitiveType(declType) && (!declType.stringType)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Validates that a concrete type satisfies a generic constraint.
     *
     * Used when instantiating generic types to ensure the provided type arguments
     * satisfy the constraints specified in the generic parameter declaration.
     *
     * @param concreteType The concrete type provided as a generic argument
     * @param constraint The constraint from the generic parameter (e.g., T: ComparableObject)
     * @returns TypeCheckResult indicating if the constraint is satisfied
     *
     * @example
     * ```
     * // fn test<T: interface { fn toString() -> string }>(x: T)
     * // test<u32>(1) → u32 must satisfy the interface constraint
     * validateGenericConstraint(u32, interface { fn toString() -> string })
     * // → failure (u32 doesn't have toString method)
     * ```
     */
    validateGenericConstraint(
        concreteType: TypeDescription,
        constraint: TypeDescription | undefined
    ): TypeCheckResult {
        // No constraint means any type is valid
        if (!constraint) {
            return success();
        }

        // Resolve reference types in both the concrete type and constraint
        const resolvedType = this.resolveIfReference(concreteType);
        const resolvedConstraint = this.resolveIfReference(constraint);

        // Handle union constraints: T: A | B means type must satisfy at least one
        if (isUnionType(resolvedConstraint)) {
            for (const constraintMember of resolvedConstraint.types) {
                const result = this.isAssignable(resolvedType, constraintMember);
                if (result.success) {
                    return success();
                }
            }
            return failure(
                `Type '${concreteType.toString()}' does not satisfy constraint '${constraint.toString()}'. ` +
                `The type must implement at least one of the required interfaces.`
            );
        }

        // Handle join constraints: T: A & B means type must satisfy all
        if (isJoinType(resolvedConstraint)) {
            for (const constraintMember of resolvedConstraint.types) {
                const result = this.isAssignable(resolvedType, constraintMember);
                if (!result.success) {
                    return failure(
                        `Type '${concreteType.toString()}' does not satisfy constraint '${constraint.toString()}'. ` +
                        `The type must implement all required interfaces.`
                    );
                }
            }
            return success();
        }

        // For other constraint types (interface, class, etc.), use standard assignability
        const result = this.isAssignable(resolvedType, resolvedConstraint);
        if (!result.success) {
            return failure(
                `Type '${concreteType.toString()}' does not satisfy constraint '${constraint.toString()}'.`
            );
        }

        return success();
    }

    /**
     * Check if two MethodType objects have the same signature.
     * Used for detecting shadowing and overrides.
     * Compares generic count, parameter types, and parameter mutability, but NOT return type.
     *
     * @param method1 First method
     * @param method2 Second method
     * @returns true if signatures match
     */
    private methodSignaturesMatch(method1: MethodType, method2: MethodType): boolean {
        // Check if methods share any common name
        const hasCommonName = method1.names.some(name1 =>
            method2.names.some(name2 => name1 === name2)
        );
        
        if (!hasCommonName) {
            return false;
        }

        // Different generic parameter counts -> not equal
        const genericCount1 = method1.genericParameters?.length ?? 0;
        const genericCount2 = method2.genericParameters?.length ?? 0;
        if (genericCount1 !== genericCount2) {
            return false;
        }

        // Different parameter counts -> not equal
        if (method1.parameters.length !== method2.parameters.length) {
            return false;
        }

        // Check each parameter type and mutability
        for (let i = 0; i < method1.parameters.length; i++) {
            const param1 = method1.parameters[i];
            const param2 = method2.parameters[i];
            
            // Use string comparison for type equality
            if (param1.type.toString() !== param2.type.toString()) {
                return false;
            }
            
            // Check parameter mutability
            if (param1.isMut !== param2.isMut) {
                return false;
            }
        }

        return true;
    }
}

