/**
 * Type Substitution for Type-C Type System
 *
 * Standalone type substitution functions extracted from TypeCTypeUtils.
 * Handles replacing generic type parameters with concrete types during
 * generic instantiation.
 */

import { ErrorCode } from "../codes/errors.js";
import {
    isArrayType,
    isClassType,
    isFunctionType,
    isGenericType,
    isInterfaceType,
    isJoinType,
    isNullableType,
    isReferenceType,
    isSelfType,
    isStructType,
    isTupleType,
    isTypeGuardType,
    isUnionType,
    isVariantConstructorType,
    isVariantType,
    ReferenceTypeDescription,
    TypeDescription,
} from "./type-c-types.js";
import { TypeCTypeFactory } from "./type-factory.js";

// ============================================================================
// Dependency interface
// ============================================================================

/**
 * Dependencies required by the substitution engine.
 * Passed from TypeCTypeUtils to avoid tight coupling.
 */
export interface SubstitutionDeps {
    readonly typeFactory: TypeCTypeFactory;
    isTypeBasic(type: TypeDescription): boolean;
    areTypesEqual(a: TypeDescription, b: TypeDescription): { success: boolean; message?: string };
    resolveReference(type: ReferenceTypeDescription): TypeDescription;
    readonly resolvingReferences: Set<string>;
    readonly pendingChecks: ReadonlyArray<{ from: TypeDescription; to: TypeDescription }>;
    addPendingCheck(from: TypeDescription, to: TypeDescription): void;
    removePendingCheck(from: TypeDescription, to: TypeDescription): void;
}

/**
 * Mutable state for depth tracking across recursive substitution calls.
 */
export interface SubstitutionState {
    depth: number;
    readonly maxDepth: number;
}

// ============================================================================
// Main substitution function
// ============================================================================

/**
 * Substitutes generic type parameters with concrete types.
 * Used when instantiating generic functions, classes, etc.
 *
 * @param type Type to substitute in
 * @param substitutions Map from generic parameter names to concrete types
 * @param deps External dependencies (type factory, type checks, etc.)
 * @param state Mutable depth tracking state
 * @param context Optional context string for error messages
 * @param errors Optional array to collect errors during substitution
 * @returns New type with substitutions applied
 */
export function substituteGenerics(
    type: TypeDescription,
    substitutions: Map<string, TypeDescription>,
    deps: SubstitutionDeps,
    state: SubstitutionState,
    context?: string,
    errors?: string[]
): TypeDescription {
    // Safety check: prevent excessive recursion depth
    state.depth++;
    if (state.depth > state.maxDepth) {
        state.depth--;
        const errorMsg = `Maximum substitution depth exceeded (${state.maxDepth}) - possible infinite recursion in type ${type.toString()}${context ? ` in ${context}` : ''}`;
        if (errors) {
            errors.push(errorMsg);
        }
        return deps.typeFactory.createErrorType(errorMsg, undefined, type.node);
    }

    try {
        return substituteGenericsImpl(type, substitutions, deps, state, context, errors);
    } finally {
        state.depth--;
    }
}

// ============================================================================
// Internal implementation
// ============================================================================

/**
 * Internal implementation of substituteGenerics with recursion depth tracking.
 * DO NOT call this directly - use substituteGenerics() instead.
 */
function substituteGenericsImpl(
    type: TypeDescription,
    substitutions: Map<string, TypeDescription>,
    deps: SubstitutionDeps,
    state: SubstitutionState,
    context?: string,
    errors?: string[]
): TypeDescription {
    const { typeFactory } = deps;

    // If it's a Self type, substitute it if a mapping exists (e.g., Self → class type)
    if (isSelfType(type)) {
        return substitutions.get('Self') ?? type;
    }

    // If it's a generic type parameter, substitute it
    if (isGenericType(type)) {
        const substitutedType = substitutions.get(type.name) ?? type;

        // If we actually substituted something (not just returning the original generic)
        if (substitutedType !== type) {
            // Check for illegal nullable basic types
            if (isNullableType(substitutedType) && deps.isTypeBasic(substitutedType.baseType)) {
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
                return typeFactory.createErrorType(errorMsg, ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE, type.node);
            }
        }

        return substitutedType;
    }

    // Recursively substitute in composite types
    if (isArrayType(type)) {
        const substitutedElement = substituteGenericsImpl(type.elementType, substitutions, deps, state, context ? `${context} array element` : 'array element', errors);

        // CRITICAL: Detect if we created a recursive array type
        // Example: T[] where T -> U[] would create U[][] which when T=U causes infinite recursion
        if (isArrayType(substitutedElement) && substitutedElement.elementType === type) {
            // Recursive array type detected - return without creating cycle
            return type;
        }

        const arrayType = typeFactory.createArrayType(substitutedElement, type.node);

        // Propagate errors from element type
        if (substitutedElement.errors && substitutedElement.errors.length > 0) {
            return { ...arrayType, errors: substitutedElement.errors };
        }

        return arrayType;
    }

    if (isNullableType(type)) {
        const substitutedBase = substituteGenericsImpl(type.baseType, substitutions, deps, state, context ? `${context} nullable base` : 'nullable base', errors);

        // CRITICAL: Detect if we created a recursive nullable type
        // Example: T? where T -> U? would create U?? which is illegal
        if (isNullableType(substitutedBase) && substitutedBase.baseType === type) {
            // Recursive nullable type detected - return without creating cycle
            return type;
        }

        // Check for illegal nullable types during substitution
        // 1. Check for double nullable (T? substituted with U? becomes U??)
        if (isNullableType(substitutedBase)) {
            const errorMsg = `Illegal double nullable type '${substitutedBase.toString()}?' - nullable types cannot be nested${context ? ` in ${context}` : ''}`;
            if (errors) {
                errors.push(errorMsg);
            }
            // Return error type immediately for double nullable
            return typeFactory.createErrorType(errorMsg, ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE, type.node);
        }

        // 2. Check for basic types being made nullable (u32? is illegal)
        if (deps.isTypeBasic(substitutedBase)) {
            const errorMsg = `Illegal nullable basic type '${substitutedBase.toString()}?' - basic types cannot be nullable${context ? ` in ${context}` : ''}`;
            if (errors) {
                errors.push(errorMsg);
            }
            // Return the nullable type but with error recorded
            const nullableType = typeFactory.createNullableType(substitutedBase, type.node);
            return { ...nullableType, errors: errors ? [...errors] : [errorMsg] };
        }

        // 3. Propagate errors from substitutedBase if it has any
        const nullableType = typeFactory.createNullableType(substitutedBase, type.node);
        if (substitutedBase.errors && substitutedBase.errors.length > 0) {
            return { ...nullableType, errors: substitutedBase.errors };
        }

        return nullableType;
    }

    if (isUnionType(type)) {
        const substitutedTypes = type.types.map(t => substituteGenericsImpl(t, substitutions, deps, state, context, errors));
        const unionType = typeFactory.createUnionType(substitutedTypes, type.node);

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
        const substitutedTypes = type.types.map(t => substituteGenericsImpl(t, substitutions, deps, state, context, errors));
        const joinType = typeFactory.createJoinType(substitutedTypes, type.node);

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
        const substitutedTypes = type.elementTypes.map(t => substituteGenericsImpl(t, substitutions, deps, state, context, errors));
        const tupleType = typeFactory.createTupleType(substitutedTypes, type.node);

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
            typeFactory.createStructField(
                f.name,
                substituteGenericsImpl(f.type, substitutions, deps, state, `struct field '${f.name}'`, errors),
                f.node
            )
        );
        const structType = typeFactory.createStructType(substitutedFields, type.isAnonymous, type.node);

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
            typeFactory.createFunctionParameterType(
                p.name,
                substituteGenericsImpl(p.type, substitutions, deps, state, p.name ? `function parameter '${p.name}'` : `function parameter ${idx + 1}`, errors),
                p.isMut,
                p.hasDefault
            )
        );
        const substitutedReturn = substituteGenericsImpl(type.returnType, substitutions, deps, state, 'function return type', errors);

        // Filter out generic parameters that have been substituted
        const remainingGenerics = type.genericParameters?.filter(g => !substitutions.has(g.name)) ?? [];

        const functionType = typeFactory.createFunctionType(
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
        const substitutedArgs = type.genericArgs.map(t => substituteGenericsImpl(t, substitutions, deps, state, context, errors));

        // Create a unique key for this reference + substituted args combination
        const refKey = `${type.declaration.name}|${substitutedArgs.map(a => a.toString()).join(',')}`;

        // Check if we're already resolving this exact reference (prevents infinite recursion)
        if (deps.resolvingReferences.has(refKey)) {
            // We're in a recursive resolution - return the reference without error checking
            return typeFactory.createReferenceType(
                type.declaration,
                substitutedArgs,
                type.node
            );
        }

        const refType = typeFactory.createReferenceType(
            type.declaration,
            substitutedArgs,
            type.node
        );

        // CRITICAL: Check if the substituted reference type itself will contain errors
        // This handles nested generic substitutions like Provider<T> with Maybe<T> where Maybe has T?
        // We need to resolve the reference and check if it contains errors
        // BUT we must avoid infinite recursion for recursive types like TreeNode<T> = { children: TreeNode<T>[]? }
        let resolvedErrors: string[] = [];

        // FIXED: Check for recursive generic instantiation before resolving
        // If any of the substituted generic arguments references the same declaration,
        // we have a recursive type (e.g., Array<Array<T>>). Skip error checking in this case
        // to avoid infinite recursion.
        const hasRecursiveGeneric = substitutedArgs.some(arg => {
            // Helper function to check if a type contains unsubstituted generics or recursive references
            const containsRecursiveOrGeneric = (t: TypeDescription): boolean => {
                // Check if the type is a reference to the same declaration
                if (isReferenceType(t) && t.declaration === type.declaration) {
                    return true;
                }
                // Check if the type is an unsubstituted generic (could cause recursion when resolved)
                if (isGenericType(t)) {
                    return true;
                }
                // Check arrays recursively
                if (isArrayType(t)) {
                    return containsRecursiveOrGeneric(t.elementType);
                }
                // Check nullables recursively
                if (isNullableType(t)) {
                    return containsRecursiveOrGeneric(t.baseType);
                }
                // Check reference types with generic args recursively
                if (isReferenceType(t) && t.genericArgs.length > 0) {
                    return t.genericArgs.some(a => containsRecursiveOrGeneric(a));
                }
                return false;
            };

            return containsRecursiveOrGeneric(arg);
        });

        // CRITICAL FIX: Skip error checking entirely if we have ANY unsubstituted generics
        // or recursive type patterns. Error checking will happen at a higher level when
        // the type is fully instantiated and used in context.
        // This prevents infinite recursion when resolving references during substitution.

        // Check if any substituted args still contain generics (not fully resolved yet)
        const hasUnresolvedGenerics = substitutedArgs.some(arg => {
            const checkForGenerics = (t: TypeDescription): boolean => {
                if (isGenericType(t)) return true;
                if (isArrayType(t)) return checkForGenerics(t.elementType);
                if (isNullableType(t)) return checkForGenerics(t.baseType);
                if (isReferenceType(t)) return t.genericArgs.some(checkForGenerics);
                if (isTupleType(t)) return t.elementTypes.some(checkForGenerics);
                return false;
            };
            return checkForGenerics(arg);
        });

        // Only attempt error checking if:
        // 1. No recursive generics detected
        // 2. All generics are fully resolved (no generic types remaining)
        // 3. Not already in a pending check for this reference
        if (!hasRecursiveGeneric && !hasUnresolvedGenerics) {
            // Check if this exact reference+substitution combo is already being checked
            const isAlreadyChecking = deps.pendingChecks.some(pair =>
                isReferenceType(pair.from) &&
                pair.from.declaration === type.declaration &&
                pair.from.genericArgs.length === substitutedArgs.length &&
                pair.from.genericArgs.every((arg, i) => deps.areTypesEqual(arg, substitutedArgs[i]).success)
            );

            if (!isAlreadyChecking) {
                // Add to pending checks AND resolution tracking to prevent infinite recursion
                deps.addPendingCheck(refType, refType);
                deps.resolvingReferences.add(refKey);

                try {
                    // Resolve the reference to check if the instantiated type contains errors
                    const resolved = deps.resolveReference(refType);
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
                    // Always remove from pending checks and resolution tracking
                    deps.removePendingCheck(refType, refType);
                    deps.resolvingReferences.delete(refKey);
                }
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
        const substitutedArgs = type.genericArgs.map(t => substituteGenerics(t, substitutions, deps, state, context, errors));
        const variantConstructorType = typeFactory.createVariantConstructorType(
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

            return typeFactory.createVariantConstructor(
                constructor.name,
                constructor.parameters.map(param => {
                    // Build context with parent context if available
                    const paramContext = context
                        ? `${context} variant constructor '${constructorSig}' parameter '${param.name}'`
                        : `variant constructor '${constructorSig}' parameter '${param.name}'`;
                    return typeFactory.createStructField(
                        param.name,
                        substituteGenericsImpl(param.type, substitutions, deps, state, paramContext, errors),
                        param.node
                    );
                })
            );
        });
        const variantType = typeFactory.createVariantType(substitutedConstructors, type.node);

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
            typeFactory.createAttributeType(
                a.name,
                substituteGenerics(a.type, substitutions, deps, state, `class attribute '${a.name}'`, errors),
                a.isStatic,
                a.isConst,
                a.isLocal
            )
        );
        const substitutedMethods = type.methods.filter(m => !m.isStatic).map(m => {
            // Build the full method signature for better error messages
            const methodSig = `${m.names[0]}(${m.parameters.map(p => `${p.name}: ${p.type.toString()}`).join(', ')}) -> ${m.returnType.toString()}`;

            return typeFactory.createMethodType(
                m.names,
                m.parameters.map((p, idx) =>
                    typeFactory.createFunctionParameterType(
                        p.name,
                        substituteGenerics(p.type, substitutions, deps, state, p.name ? `class method '${methodSig}' parameter '${p.name}'` : `class method '${methodSig}' parameter ${idx + 1}`, errors),
                        p.isMut,
                        p.hasDefault
                    )
                ),
                substituteGenerics(m.returnType, substitutions, deps, state, `class method '${methodSig}' return type`, errors),
                m.node,
                m.genericParameters,
                m.isStatic,
                m.isOverride,
                m.isLocal
            );
        });
        const substitutedImplementations = type.implementations.map(i =>
            substituteGenerics(i, substitutions, deps, state, context, errors) as TypeDescription
        );
        const substitutedSuperTypes = type.superTypes.map(t =>
            substituteGenerics(t, substitutions, deps, state, context, errors)
        );
        const classType = typeFactory.createClassType(
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

            return typeFactory.createMethodType(
                m.names,
                m.parameters.map((p, idx) => {
                    const paramContext = p.name
                        ? `interface method '${methodSig}' parameter '${p.name}'`
                        : `interface method '${methodSig}' parameter ${idx + 1}`;
                    return typeFactory.createFunctionParameterType(
                        p.name,
                        substituteGenerics(p.type, substitutions, deps, state, paramContext, errors),
                        p.isMut,
                        p.hasDefault
                    );
                }),
                substituteGenerics(m.returnType, substitutions, deps, state, `interface method '${methodSig}' return type`, errors),
                m.node,
                m.genericParameters,
                m.isStatic,
                m.isOverride,
                m.isLocal
            );
        });
        const substitutedSuperTypes = type.superTypes.map(t =>
            substituteGenerics(t, substitutions, deps, state, context, errors)
        );
        const interfaceType = typeFactory.createInterfaceType(substitutedMethods, substitutedSuperTypes, type.node);

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
        const substitutedGuardedType = substituteGenerics(type.guardedType, substitutions, deps, state, context, errors);
        const typeGuardType = typeFactory.createTypeGuardType(
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
