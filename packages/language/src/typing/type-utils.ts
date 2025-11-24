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

import {
    TypeDescription,
    TypeKind,
    IntegerTypeDescription,
    FloatTypeDescription,
    ArrayTypeDescription,
    NullableTypeDescription,
    UnionTypeDescription,
    JoinTypeDescription,
    TupleTypeDescription,
    StructTypeDescription,
    FunctionTypeDescription,
    ReferenceTypeDescription,
    GenericTypeDescription,
    VariantConstructorTypeDescription,
    isIntegerType,
    isFloatType,
    isNumericType,
    isArrayType,
    isNullableType,
    isUnionType,
    isJoinType,
    isTupleType,
    isStructType,
    isFunctionType,
    isReferenceType,
    isGenericType,
    isErrorType,
    isNeverType,
    isAnyType,
    isUnsetType,
    isClassType,
    isInterfaceType,
    isVariantType,
    isVariantConstructorType,
    ClassTypeDescription,
    InterfaceTypeDescription,
    VariantTypeDescription,
    isEnumType,
} from "./type-c-types.js";
import * as factory from "./type-factory.js";

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
export function areTypesEqual(a: TypeDescription, b: TypeDescription): TypeCheckResult {
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
        case TypeKind.Null:
        case TypeKind.Never:
        case TypeKind.Any:
            return success();
            
        case TypeKind.Array: {
            const result = areTypesEqual(
                (a as ArrayTypeDescription).elementType,
                (b as ArrayTypeDescription).elementType
            );
            if (!result.success) {
                return failure(`Array element types differ: ${result.message}`);
            }
            return success();
        }
            
        case TypeKind.Nullable: {
            const result = areTypesEqual(
                (a as NullableTypeDescription).baseType,
                (b as NullableTypeDescription).baseType
            );
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
            return areStructTypesEqual(a as StructTypeDescription, b as StructTypeDescription);
            
        case TypeKind.Function:
            return areFunctionTypesEqual(a as FunctionTypeDescription, b as FunctionTypeDescription);
            
        case TypeKind.Reference:
            return areReferenceTypesEqual(a as ReferenceTypeDescription, b as ReferenceTypeDescription);
            
        case TypeKind.Generic:
            return areGenericTypesEqual(a as GenericTypeDescription, b as GenericTypeDescription);

        case TypeKind.Variant:
            return areVariantTypesEqual(a as VariantTypeDescription, b as VariantTypeDescription);

        // For other complex types, fall back to string comparison
        // (This is a simplified approach; real implementation would need deeper comparison)
        default:
            if (a.toString() === b.toString()) {
                return success();
            }
            return failure(`Types differ: ${a.toString()} vs ${b.toString()}`);
    }
}

function areVariantTypesEqual(a: VariantTypeDescription, b: VariantTypeDescription): TypeCheckResult {
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
            const typeResult = areTypesEqual(aParam.type, bParam.type);
            if (!typeResult.success) {
                return failure(`Constructor '${aConstructor.name}' parameter '${aParam.name}' type mismatch: ${typeResult.message}`);
            }
        }
    }

    return success();
}

function areStructTypesEqual(a: StructTypeDescription, b: StructTypeDescription): TypeCheckResult {
    if (a.fields.length !== b.fields.length) {
        return failure(`Struct field count mismatch: ${a.fields.length} vs ${b.fields.length}`);
    }
    
    // Structs are equal if they have the same fields with the same types
    for (const aField of a.fields) {
        const bField = b.fields.find(f => f.name === aField.name);
        if (!bField) {
            return failure(`Field '${aField.name}' not found in target struct`);
        }
        const typeResult = areTypesEqual(aField.type, bField.type);
        if (!typeResult.success) {
            return failure(`Field '${aField.name}' type mismatch: ${typeResult.message}`);
        }
    }
    
    return success();
}

function areFunctionTypesEqual(a: FunctionTypeDescription, b: FunctionTypeDescription): TypeCheckResult {
    if (a.fnType !== b.fnType) {
        return failure(`Function type mismatch: ${a.fnType} vs ${b.fnType}`);
    }
    if (a.parameters.length !== b.parameters.length) {
        return failure(`Parameter count mismatch: ${a.parameters.length} vs ${b.parameters.length}`);
    }
    
    // Check parameter types
    for (let i = 0; i < a.parameters.length; i++) {
        const aParam = a.parameters[i];
        const bParam = b.parameters[i];
        const typeResult = areTypesEqual(aParam.type, bParam.type);
        if (!typeResult.success) {
            return failure(`parameter ${i + 1} type mismatch: ${typeResult.message}`);
        }
    }
    
    // Check return type
    const returnResult = areTypesEqual(a.returnType, b.returnType);
    if (!returnResult.success) {
        return failure(`return type mismatch: ${returnResult.message}`);
    }
    
    return success();
}

function areReferenceTypesEqual(a: ReferenceTypeDescription, b: ReferenceTypeDescription): TypeCheckResult {
    // References are equal if they point to the same declaration
    if (a.declaration !== b.declaration) {
        return failure(`References point to different declarations: ${a.declaration.name} vs ${b.declaration.name}`);
    }
    
    // And have the same generic arguments
    if (a.genericArgs.length !== b.genericArgs.length) {
        return failure(`Generic argument count mismatch: ${a.genericArgs.length} vs ${b.genericArgs.length}`);
    }
    
    for (let i = 0; i < a.genericArgs.length; i++) {
        const result = areTypesEqual(a.genericArgs[i], b.genericArgs[i]);
        if (!result.success) {
            return failure(`Generic argument ${i + 1} mismatch: ${result.message}`);
        }
    }
    
    return success();
}

function areGenericTypesEqual(a: GenericTypeDescription, b: GenericTypeDescription): TypeCheckResult {
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
export function isAssignable(from: TypeDescription, to: TypeDescription): TypeCheckResult {
    // Exact equality
    const equalityResult = areTypesEqual(from, to);
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
        return isNumericPromotionValid(from, to);
    }

    // Int + Enum or Enum + Int should be assignable
    if (isIntegerType(from) && isEnumType(to)) {
        return success();
    }
    if (isEnumType(from) && isIntegerType(to)) {
        return success();
    }
    
    // Null can be assigned to nullable types
    if (from.kind === TypeKind.Null && isNullableType(to)) {
        return success();
    }
    
    // T can be assigned to T?
    if (isNullableType(to)) {
        return isAssignable(from, to.baseType);
    }
    
    // Array covariance (for now, arrays are invariant in element type)
    if (isArrayType(from) && isArrayType(to)) {
        const elementResult = areTypesEqual(from.elementType, to.elementType);
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
            const result = isAssignable(from.elementTypes[i], to.elementTypes[i]);
            if (!result.success) {
                return failure(`Tuple element ${i + 1} is not assignable: ${result.message}`);
            }
        }
        return success();
    }
    
    // Struct assignability (structural typing)
    if (isStructType(from) && isStructType(to)) {
        return isStructAssignable(from, to);
    }

    // Struct to named struct reference (duck typing)
    // Anonymous struct {x: 5.0, y: 10.0} can be assigned to Point if structurally compatible
    if (isStructType(from) && isReferenceType(to)) {
        // We need a type provider to resolve the reference, but we don't have access to it here
        // For now, we'll just return true and let the validator handle it
        // TODO: This should properly resolve the reference and check structural compatibility
        return success();
    }

    // Function assignability (contravariant in parameters, covariant in return type)
    if (isFunctionType(from) && isFunctionType(to)) {
        return isFunctionAssignable(from, to);
    }
    
    // Union type handling
    if (isUnionType(from)) {
        // All union members must be assignable to target
        for (const t of from.types) {
            const result = isAssignable(t, to);
            if (!result.success) {
                return failure(`Union member ${t.toString()} is not assignable to ${to.toString()}: ${result.message}`);
            }
        }
        return success();
    }
    
    if (isUnionType(to)) {
        // Source must be assignable to at least one union member
        for (const t of to.types) {
            const result = isAssignable(from, t);
            if (result.success) {
                return success();
            }
        }
        return failure(`${from.toString()} is not assignable to any member of union ${to.toString()}`);
    }
    
    // Join (intersection) type handling
    if (isJoinType(from)) {
        // At least one join member must be assignable to target
        for (const t of from.types) {
            const result = isAssignable(t, to);
            if (result.success) {
                return success();
            }
        }
        return failure(`No member of intersection ${from.toString()} is assignable to ${to.toString()}`);
    }
    
    if (isJoinType(to)) {
        // Source must be assignable to all join members
        for (const t of to.types) {
            const result = isAssignable(from, t);
            if (!result.success) {
                return failure(`${from.toString()} is not assignable to intersection member ${t.toString()}: ${result.message}`);
            }
        }
        return success();
    }
    
    // Class/Interface subtyping
    if (isClassType(from) && isClassType(to)) {
        if (from === to) {
            return success();
        }
        return failure(`Class types differ: ${from.toString()} vs ${to.toString()}`);
    }
    else if (isClassType(from) && isInterfaceType(to)) {
        return isClassAssignableToInterface(from, to);
    }

    if (isInterfaceType(from) && isInterfaceType(to)) {
        return isInterfaceAssignableToInterface(from, to);
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
            return isVariantConstructorAssignableToVariant(from, to);
        }
        if (isReferenceType(to)) {
            return isVariantConstructorAssignableToVariantRef(from, to);
        }
    }

    // Variant constructor to variant constructor assignability
    // Result.Ok<i32, never> <: Result.Ok<i32, string> (never is compatible)
    // Result.Ok<i32, string> is NOT assignable to Result.Err<i32, string> (different constructors)
    if (isVariantConstructorType(from) && isVariantConstructorType(to)) {
        return isVariantConstructorAssignableToVariantConstructor(from, to);
    }

    // Reference type assignability
    // Result<i32, never> <: Result<i32, string> (never is compatible with any type)
    if (isReferenceType(from) && isReferenceType(to)) {
        return isReferenceAssignableToReference(from, to);
    }

    // Default: not assignable
    return failure(`${from.toString()} is not assignable to ${to.toString()}`);
}

function isNumericPromotionValid(from: IntegerTypeDescription | FloatTypeDescription, to: IntegerTypeDescription | FloatTypeDescription): TypeCheckResult {
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

function isStructAssignable(from: StructTypeDescription, to: StructTypeDescription): TypeCheckResult {
    // Structural typing: 'from' must have all fields of 'to' with compatible types
    for (const toField of to.fields) {
        const fromField = from.fields.find(f => f.name === toField.name);
        if (!fromField) {
            return failure(`Field '${toField.name}' missing in source struct`);
        }
        const result = isAssignable(fromField.type, toField.type);
        if (!result.success) {
            return failure(`Field '${toField.name}' type mismatch: ${result.message}`);
        }
    }
    return success();
}

function isFunctionAssignable(from: FunctionTypeDescription, to: FunctionTypeDescription): TypeCheckResult {
    // Function types must match in arity and type style
    if (from.fnType !== to.fnType) {
        return failure(`Function type mismatch: ${from.fnType} vs ${to.fnType}`);
    }
    if (from.parameters.length !== to.parameters.length) {
        return failure(`Parameter count mismatch: ${from.parameters.length} vs ${to.parameters.length}`);
    }
    
    // Parameters are contravariant
    for (let i = 0; i < to.parameters.length; i++) {
        const result = isAssignable(to.parameters[i].type, from.parameters[i].type);
        if (!result.success) {
            return failure(`Parameter ${i + 1} is not contravariant: ${result.message}`);
        }
    }
    
    // Return type is covariant
    const returnResult = isAssignable(from.returnType, to.returnType);
    if (!returnResult.success) {
        return failure(`Return type is not covariant: ${returnResult.message}`);
    }
    
    return success();
}

function isClassAssignableToInterface(from: ClassTypeDescription, to: InterfaceTypeDescription): TypeCheckResult {
    // All interface methods must be implemented by the class
    for (const method of to.methods) {
        const classMethod = from.methods.find(m => m.names.some(name => method.names.includes(name)));
        if (!classMethod) {
            return failure(`class does not implement required method '${method.names[0]}'`);
        }
        const result = areFunctionTypesEqual(
            factory.createFunctionType(classMethod.parameters, classMethod.returnType, 'fn', classMethod.genericParameters, undefined),
            factory.createFunctionType(method.parameters, method.returnType, 'fn', method.genericParameters, undefined)
        );
        if (!result.success) {
            return failure(`method '${method.names[0]}' signature mismatch: ${result.message}`);
        }
    }
    return success();
}

function isInterfaceAssignableToInterface(from: InterfaceTypeDescription, to: InterfaceTypeDescription): TypeCheckResult {
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
function isVariantConstructorAssignableToVariant(
    from: VariantConstructorTypeDescription,
    to: VariantTypeDescription
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
            ? substituteGenerics(fromParamType, fromSubstitutions)
            : fromParamType;

        // Check assignability: never is compatible with anything
        if (isNeverType(resolvedFromParamType)) {
            continue;
        }

        const result = isAssignable(resolvedFromParamType, toParamType);
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
function isVariantConstructorAssignableToVariantConstructor(
    from: VariantConstructorTypeDescription,
    to: VariantConstructorTypeDescription
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
        const result = isAssignable(fromArg, toArg);
        if (!result.success) {
            return failure(`Generic argument ${i + 1} not assignable: ${result.message}`);
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
function isVariantConstructorAssignableToVariantRef(
    from: VariantConstructorTypeDescription,
    to: ReferenceTypeDescription
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
        const result = isAssignable(fromArg, toArg);
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
function isReferenceAssignableToReference(
    from: ReferenceTypeDescription,
    to: ReferenceTypeDescription
): TypeCheckResult {
    // Must reference the same declaration
    if (from.declaration !== to.declaration) {
        return failure(`References point to different declarations: ${from.declaration.name} vs ${to.declaration.name}`);
    }

    // If no generic arguments, they're compatible
    if (from.genericArgs.length === 0 && to.genericArgs.length === 0) {
        return success();
    }

    // Generic argument counts must match
    if (from.genericArgs.length !== to.genericArgs.length) {
        return failure(`Generic argument count mismatch: ${from.genericArgs.length} vs ${to.genericArgs.length}`);
    }

    // Check each generic argument
    // `never` in from is compatible with any type in to
    for (let i = 0; i < from.genericArgs.length; i++) {
        const fromArg = from.genericArgs[i];
        const toArg = to.genericArgs[i];

        // If from is never, it's compatible with any target type
        if (isNeverType(fromArg)) {
            continue;
        }

        // Otherwise, check normal assignability
        const result = isAssignable(fromArg, toArg);
        if (!result.success) {
            return failure(`Generic argument ${i + 1} not assignable: ${result.message}`);
        }
    }

    return success();
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
export function substituteGenerics(
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
            elementType: substituteGenerics(type.elementType, substitutions),
            node: type.node,
            toString: () => `${substituteGenerics(type.elementType, substitutions).toString()}[]`
        };
        return arrayType;
    }
    
    if (isNullableType(type)) {
        const nullableType: NullableTypeDescription = {
            kind: type.kind,
            baseType: substituteGenerics(type.baseType, substitutions),
            node: type.node,
            toString: () => `${substituteGenerics(type.baseType, substitutions).toString()}?`
        };
        return nullableType;
    }
    
    if (isUnionType(type)) {
        const substitutedTypes = type.types.map(t => substituteGenerics(t, substitutions));
        const unionType: UnionTypeDescription = {
            kind: type.kind,
            types: substitutedTypes,
            node: type.node,
            toString: () => substitutedTypes.map(t => t.toString()).join(' | ')
        };
        return unionType;
    }
    
    if (isJoinType(type)) {
        const substitutedTypes = type.types.map(t => substituteGenerics(t, substitutions));
        const joinType: JoinTypeDescription = {
            kind: type.kind,
            types: substitutedTypes,
            node: type.node,
            toString: () => substitutedTypes.map(t => t.toString()).join(' & ')
        };
        return joinType;
    }
    
    if (isTupleType(type)) {
        const substitutedTypes = type.elementTypes.map(t => substituteGenerics(t, substitutions));
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
            type: substituteGenerics(f.type, substitutions)
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
            type: substituteGenerics(p.type, substitutions),
            isMut: p.isMut
        }));
        const substitutedReturn = substituteGenerics(type.returnType, substitutions);
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
        const substitutedArgs = type.genericArgs.map(t => substituteGenerics(t, substitutions));
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
        const substitutedArgs = type.genericArgs.map(t => substituteGenerics(t, substitutions));
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
                const substitutedParamType = substituteGenerics(param.type, substitutions);
                return {
                    name: param.name,
                    type: substitutedParamType
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
            type: substituteGenerics(a.type, substitutions),
            isStatic: a.isStatic,
            isConst: a.isConst,
            isLocal: a.isLocal
        }));
        const substitutedMethods = type.methods.filter(m => !m.isStatic).map(m => ({
            ...m,
            parameters: m.parameters.map(p => ({
                name: p.name,
                type: substituteGenerics(p.type, substitutions),
                isMut: p.isMut
            })),
            returnType: substituteGenerics(m.returnType, substitutions)
        }));
        const substitutedImplementations = type.implementations.map(i => substituteGenerics(i, substitutions));
        const substitutedSuperTypes = type.superTypes.map(t => substituteGenerics(t, substitutions));
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
    if(isInterfaceType(type)) {
        const substitutedMethods = type.methods.map(m => factory.createMethodType(m.names, m.parameters.map(p => ({
            name: p.name,
            type: substituteGenerics(p.type, substitutions),
            isMut: p.isMut
        })), substituteGenerics(m.returnType, substitutions), m.genericParameters, m.isStatic, m.isOverride, m.isLocal));
        
        return factory.createInterfaceType(substitutedMethods, type.superTypes.map(t => substituteGenerics(t, substitutions)), type.node);
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
export function simplifyType(type: TypeDescription): TypeDescription {
    if (isUnionType(type)) {
        return simplifyUnion(type);
    }
    
    if (isJoinType(type)) {
        return simplifyJoin(type);
    }
    
    // For other types, return as-is
    return type;
}

function simplifyUnion(type: UnionTypeDescription): TypeDescription {
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
        if (!uniqueTypes.some(existing => areTypesEqual(existing, t).success)) {
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

function simplifyJoin(type: JoinTypeDescription): TypeDescription {
    // Flatten nested joins
    const flatTypes: TypeDescription[] = [];
    for (const t of type.types) {
        if (isJoinType(t)) {
            flatTypes.push(...t.types);
        } else {
            flatTypes.push(t);
        }
    }
    
    // Remove duplicates
    const uniqueTypes: TypeDescription[] = [];
    for (const t of flatTypes) {
        if (!uniqueTypes.some(existing => areTypesEqual(existing, t).success)) {
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
export function narrowType(type: TypeDescription, narrowTo: TypeDescription): TypeDescription {
    // If types are equal, narrowing succeeds
    if (areTypesEqual(type, narrowTo).success) {
        return type;
    }
    
    // Can't narrow to a broader type
    const narrowToTypeCheck = isAssignable(narrowTo, type);
    const typeToNarrowCheck = isAssignable(type, narrowTo);
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
            .map(t => narrowType(t, narrowTo))
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
