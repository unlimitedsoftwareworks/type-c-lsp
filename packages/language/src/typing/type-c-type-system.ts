/**
 * Type System for Type-C
 *
 * This module provides the high-level type system interface for Type-C.
 * It coordinates type inference, type checking, and type operations.
 */

import type { TypeCServices } from '../type-c-module.js';
import type { AstNode } from 'langium';
import { TypeDescription } from './type-c-types.js';
import { areTypesEqual, isAssignable, narrowType, simplifyType, substituteGenerics, TypeCheckResult } from './type-utils.js';
import * as factory from './type-factory.js';

/**
 * Main type system facade.
 * Provides a unified interface for all type operations.
 */
export class TypeCTypeSystem {
    protected readonly services: TypeCServices;

    constructor(services: TypeCServices) {
        this.services = services;
    }

    // ========================================================================
    // Type Retrieval
    // ========================================================================

    /**
     * Gets the type of an AST node.
     * This is the main entry point for type information.
     */
    getType(node: AstNode | undefined): TypeDescription {
        return this.services.typing.TypeProvider.getType(node);
    }

    /**
     * Resolves a reference type to its actual definition.
     */
    resolveReference(type: TypeDescription): TypeDescription {
        return this.services.typing.TypeProvider.resolveReference(type);
    }

    /**
     * Invalidates cached types for a node.
     * Call this when the AST changes.
     */
    invalidateCache(node: AstNode): void {
        this.services.typing.TypeProvider.invalidateCache(node);
    }

    // ========================================================================
    // Type Comparison
    // ========================================================================

    /**
     * Checks if two types are exactly equal.
     * @returns TypeCheckResult with success status and optional error message
     */
    areEqual(a: TypeDescription, b: TypeDescription): TypeCheckResult {
        return areTypesEqual(a, b);
    }

    /**
     * Checks if a value of type 'from' can be assigned to 'to'.
     * @returns TypeCheckResult with success status and optional error message
     */
    isAssignable(from: TypeDescription, to: TypeDescription): TypeCheckResult {
        return isAssignable(from, to);
    }

    // ========================================================================
    // Type Manipulation
    // ========================================================================

    /**
     * Simplifies a type by removing redundancies.
     */
    simplify(type: TypeDescription): TypeDescription {
        return simplifyType(type);
    }

    /**
     * Narrows a type based on a type check.
     */
    narrow(type: TypeDescription, narrowTo: TypeDescription): TypeDescription {
        return narrowType(type, narrowTo);
    }

    /**
     * Substitutes generic type parameters with concrete types.
     */
    substitute(type: TypeDescription, substitutions: Map<string, TypeDescription>): TypeDescription {
        return substituteGenerics(type, substitutions);
    }

    // ========================================================================
    // Type Factory Methods (convenience wrappers)
    // ========================================================================

    createErrorType(message: string, cause?: unknown, node?: AstNode): TypeDescription {
        return factory.createErrorType(message, cause, node);
    }

    createVoidType(node?: AstNode): TypeDescription {
        return factory.createVoidType(node);
    }

    createBoolType(node?: AstNode): TypeDescription {
        return factory.createBoolType(node);
    }

    createIntegerType(spec: string, node?: AstNode): TypeDescription | undefined {
        return factory.createIntegerTypeFromString(spec, node);
    }

    createFloatType(spec: string, node?: AstNode): TypeDescription | undefined {
        return factory.createFloatTypeFromString(spec, node);
    }

    createStringType(node?: AstNode): TypeDescription {
        return factory.createStringType(node);
    }

    createNullType(node?: AstNode): TypeDescription {
        return factory.createNullType(node);
    }

    createArrayType(elementType: TypeDescription, node?: AstNode): TypeDescription {
        return factory.createArrayType(elementType, node);
    }

    createNullableType(baseType: TypeDescription, node?: AstNode): TypeDescription {
        return factory.createNullableType(baseType, node);
    }

    createUnionType(types: readonly TypeDescription[], node?: AstNode): TypeDescription {
        return factory.createUnionType(types, node);
    }

    createTupleType(types: readonly TypeDescription[], node?: AstNode): TypeDescription {
        return factory.createTupleType(types, node);
    }

    createNeverType(node?: AstNode): TypeDescription {
        return factory.createNeverType(node);
    }

    createAnyType(node?: AstNode): TypeDescription {
        return factory.createAnyType(node);
    }
}

