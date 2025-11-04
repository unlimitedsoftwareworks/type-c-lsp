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
    ClassTypeDescription,
    InterfaceTypeDescription,
} from "./type-c-types.js";

// ============================================================================
// Type Equality
// ============================================================================

/**
 * Checks if two types are exactly equal (structural equality).
 * 
 * @param a First type
 * @param b Second type
 * @returns true if types are structurally equal
 */
export function areTypesEqual(a: TypeDescription, b: TypeDescription): boolean {
    // Quick reference equality check
    if (a === b) return true;
    
    // Different kinds are never equal
    if (a.kind !== b.kind) return false;
    
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
            return true;
            
        case TypeKind.Array:
            return areTypesEqual(
                (a as ArrayTypeDescription).elementType,
                (b as ArrayTypeDescription).elementType
            );
            
        case TypeKind.Nullable:
            return areTypesEqual(
                (a as NullableTypeDescription).baseType,
                (b as NullableTypeDescription).baseType
            );
            
        case TypeKind.Union:
            return areUnionTypesEqual(a as UnionTypeDescription, b as UnionTypeDescription);
            
        case TypeKind.Join:
            return areJoinTypesEqual(a as JoinTypeDescription, b as JoinTypeDescription);
            
        case TypeKind.Tuple:
            return areTupleTypesEqual(a as TupleTypeDescription, b as TupleTypeDescription);
            
        case TypeKind.Struct:
            return areStructTypesEqual(a as StructTypeDescription, b as StructTypeDescription);
            
        case TypeKind.Function:
            return areFunctionTypesEqual(a as FunctionTypeDescription, b as FunctionTypeDescription);
            
        case TypeKind.Reference:
            return areReferenceTypesEqual(a as ReferenceTypeDescription, b as ReferenceTypeDescription);
            
        case TypeKind.Generic:
            return areGenericTypesEqual(a as GenericTypeDescription, b as GenericTypeDescription);
            
        // For other complex types, fall back to string comparison
        // (This is a simplified approach; real implementation would need deeper comparison)
        default:
            return a.toString() === b.toString();
    }
}

function areUnionTypesEqual(a: UnionTypeDescription, b: UnionTypeDescription): boolean {
    if (a.types.length !== b.types.length) return false;
    
    // Union types are equal if they contain the same types (order-independent)
    return a.types.every(aType => 
        b.types.some(bType => areTypesEqual(aType, bType))
    ) && b.types.every(bType => 
        a.types.some(aType => areTypesEqual(aType, bType))
    );
}

function areJoinTypesEqual(a: JoinTypeDescription, b: JoinTypeDescription): boolean {
    if (a.types.length !== b.types.length) return false;
    
    // Join types are equal if they contain the same types (order-independent)
    return a.types.every(aType => 
        b.types.some(bType => areTypesEqual(aType, bType))
    ) && b.types.every(bType => 
        a.types.some(aType => areTypesEqual(aType, bType))
    );
}

function areTupleTypesEqual(a: TupleTypeDescription, b: TupleTypeDescription): boolean {
    if (a.elementTypes.length !== b.elementTypes.length) return false;
    
    // Tuples are equal if all elements are equal (order matters)
    return a.elementTypes.every((aType, i) => 
        areTypesEqual(aType, b.elementTypes[i])
    );
}

function areStructTypesEqual(a: StructTypeDescription, b: StructTypeDescription): boolean {
    if (a.fields.length !== b.fields.length) return false;
    
    // Structs are equal if they have the same fields with the same types
    return a.fields.every(aField => {
        const bField = b.fields.find(f => f.name === aField.name);
        return bField && areTypesEqual(aField.type, bField.type);
    });
}

function areFunctionTypesEqual(a: FunctionTypeDescription, b: FunctionTypeDescription): boolean {
    if (a.fnType !== b.fnType) return false;
    if (a.parameters.length !== b.parameters.length) return false;
    
    // Check parameter types
    if (!a.parameters.every((aParam, i) => 
        areTypesEqual(aParam.type, b.parameters[i].type)
    )) {
        return false;
    }
    
    // Check return type
    return areTypesEqual(a.returnType, b.returnType);
}

function areReferenceTypesEqual(a: ReferenceTypeDescription, b: ReferenceTypeDescription): boolean {
    // References are equal if they point to the same declaration
    if (a.declaration !== b.declaration) return false;
    
    // And have the same generic arguments
    if (a.genericArgs.length !== b.genericArgs.length) return false;
    
    return a.genericArgs.every((aArg, i) => 
        areTypesEqual(aArg, b.genericArgs[i])
    );
}

function areGenericTypesEqual(a: GenericTypeDescription, b: GenericTypeDescription): boolean {
    // Generics are equal if they have the same name
    // (assuming they're from the same scope context)
    return a.name === b.name;
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
 * @returns true if assignment is valid
 */
export function isAssignable(from: TypeDescription, to: TypeDescription): boolean {
    // Exact equality
    if (areTypesEqual(from, to)) return true;
    
    // Any type accepts everything, everything is assignable to Any
    if (isAnyType(to)) return true;
    if (isAnyType(from)) return true;
    
    // Never type is assignable to everything
    if (isNeverType(from)) return true;
    
    // Nothing is assignable to Never
    if (isNeverType(to)) return false;
    
    // Error types propagate
    if (isErrorType(from) || isErrorType(to)) return true;
    
    // Unset types - treat as assignable for now (they should be resolved)
    if (isUnsetType(from) || isUnsetType(to)) return true;
    
    // Numeric promotions
    if (isNumericType(from) && isNumericType(to)) {
        return isNumericPromotionValid(from, to);
    }
    
    // Null can be assigned to nullable types
    if (from.kind === TypeKind.Null && isNullableType(to)) {
        return true;
    }
    
    // T can be assigned to T?
    if (isNullableType(to)) {
        return isAssignable(from, to.baseType);
    }
    
    // Array covariance (for now, arrays are invariant in element type)
    if (isArrayType(from) && isArrayType(to)) {
        return areTypesEqual(from.elementType, to.elementType);
    }
    
    // Tuple assignability
    if (isTupleType(from) && isTupleType(to)) {
        if (from.elementTypes.length !== to.elementTypes.length) return false;
        return from.elementTypes.every((fromType, i) => 
            isAssignable(fromType, to.elementTypes[i])
        );
    }
    
    // Struct assignability (structural typing)
    if (isStructType(from) && isStructType(to)) {
        return isStructAssignable(from, to);
    }
    
    // Function assignability (contravariant in parameters, covariant in return type)
    if (isFunctionType(from) && isFunctionType(to)) {
        return isFunctionAssignable(from, to);
    }
    
    // Union type handling
    if (isUnionType(from)) {
        // All union members must be assignable to target
        return from.types.every(t => isAssignable(t, to));
    }
    
    if (isUnionType(to)) {
        // Source must be assignable to at least one union member
        return to.types.some(t => isAssignable(from, t));
    }
    
    // Join (intersection) type handling
    if (isJoinType(from)) {
        // At least one join member must be assignable to target
        return from.types.some(t => isAssignable(t, to));
    }
    
    if (isJoinType(to)) {
        // Source must be assignable to all join members
        return to.types.every(t => isAssignable(from, t));
    }
    
    // Class/Interface subtyping
    if (isClassType(from) && (isClassType(to) || isInterfaceType(to))) {
        return isClassAssignableToType(from, to);
    }
    
    if (isInterfaceType(from) && isInterfaceType(to)) {
        return isInterfaceAssignableToInterface(from, to);
    }
    
    // Default: not assignable
    return false;
}

function isNumericPromotionValid(from: IntegerTypeDescription | FloatTypeDescription, to: IntegerTypeDescription | FloatTypeDescription): boolean {
    // Float types
    if (isFloatType(from) && isFloatType(to)) {
        // f32 can be promoted to f64
        return from.bits <= to.bits;
    }
    
    // Integer types
    if (isIntegerType(from) && isIntegerType(to)) {
        // Same signedness: can promote to larger size
        if (from.signed === to.signed) {
            return from.bits <= to.bits;
        }
        // Unsigned to signed: need extra bit
        if (!from.signed && to.signed) {
            return from.bits < to.bits;
        }
        // Signed to unsigned: not allowed
        return false;
    }
    
    // Integer to float: generally allowed (with potential precision loss)
    if (isIntegerType(from) && isFloatType(to)) {
        return true; // Could add more sophisticated checks
    }
    
    // Float to integer: not allowed implicitly
    return false;
}

function isStructAssignable(from: StructTypeDescription, to: StructTypeDescription): boolean {
    // Structural typing: 'from' must have all fields of 'to' with compatible types
    return to.fields.every(toField => {
        const fromField = from.fields.find(f => f.name === toField.name);
        return fromField && isAssignable(fromField.type, toField.type);
    });
}

function isFunctionAssignable(from: FunctionTypeDescription, to: FunctionTypeDescription): boolean {
    // Function types must match in arity and type style
    if (from.fnType !== to.fnType) return false;
    if (from.parameters.length !== to.parameters.length) return false;
    
    // Parameters are contravariant
    if (!to.parameters.every((toParam, i) => 
        isAssignable(toParam.type, from.parameters[i].type)
    )) {
        return false;
    }
    
    // Return type is covariant
    return isAssignable(from.returnType, to.returnType);
}

function isClassAssignableToType(from: ClassTypeDescription, to: ClassTypeDescription | InterfaceTypeDescription): boolean {
    // Check if 'to' is in the supertype chain of 'from'
    // This is a simplified version - real implementation needs full type resolution
    return from.superTypes.some(superType => 
        areTypesEqual(superType, to) || 
        (isClassType(superType) && isClassAssignableToType(superType, to))
    ) || from.implementations.some(impl => areTypesEqual(impl, to));
}

function isInterfaceAssignableToInterface(from: InterfaceTypeDescription, to: InterfaceTypeDescription): boolean {
    // Check if 'to' is in the supertype chain of 'from'
    return from.superTypes.some(superType => 
        areTypesEqual(superType, to) || 
        (isInterfaceType(superType) && isInterfaceAssignableToInterface(superType, to))
    );
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
        if (!uniqueTypes.some(existing => areTypesEqual(existing, t))) {
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
        if (!uniqueTypes.some(existing => areTypesEqual(existing, t))) {
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
    if (areTypesEqual(type, narrowTo)) {
        return type;
    }
    
    // Can't narrow to a broader type
    if (!isAssignable(narrowTo, type) && !isAssignable(type, narrowTo)) {
        // Return never type to indicate impossible narrowing
        return { kind: TypeKind.Never, toString: () => 'never' };
    }
    
    // If narrowing to a subtype, return the subtype
    if (isAssignable(narrowTo, type)) {
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
