/**
 * Type System for Type-C Language
 * 
 * This module defines the type representation system for Type-C, supporting:
 * - Primitive types (integers, floats, bool, void, string, null)
 * - Composite types (arrays, nullables, unions, intersections, tuples)
 * - Structural types (structs, variants, enums)
 * - Object-oriented types (classes, interfaces, implementations)
 * - Functional types (functions, coroutines)
 * - Generic types with constraints
 * - Recursive types (e.g., class with clone method returning self)
 * 
 * The type system is designed for lazy evaluation with caching via Langium's infrastructure.
 */

import * as ast from "../generated/ast.js";
import { AstNode } from "langium";

/**
 * Base interface for all type descriptions in Type-C.
 * Types are immutable and can be compared by structural equality.
 */
export interface TypeDescription {
    /** The kind of type - used for quick type discrimination */
    readonly kind: TypeKind;
    /** Optional reference to the AST node that this type was derived from */
    readonly node?: AstNode;
    /** Human-readable representation of the type */
    toString(): string;
}

/**
 * Enumeration of all possible type kinds in Type-C.
 */
export enum TypeKind {
    // Primitive types
    U8 = 'u8',
    U16 = 'u16',
    U32 = 'u32',
    U64 = 'u64',
    I8 = 'i8',
    I16 = 'i16',
    I32 = 'i32',
    I64 = 'i64',
    F32 = 'f32',
    F64 = 'f64',
    Bool = 'bool',
    Void = 'void',
    String = 'string',
    StringLiteral = 'string-literal',
    Null = 'null',
    
    // Composite types
    Array = 'array',
    Nullable = 'nullable',
    Union = 'union',
    Join = 'join', // Intersection type
    Tuple = 'tuple',
    
    // Structural types
    Struct = 'struct',
    Variant = 'variant',
    MetaVariant = 'meta-variant',
    VariantConstructor = 'variant-constructor',
    MetaVariantConstructor = 'meta-variant-constructor',
    Enum = 'enum',
    MetaEnum = 'meta-enum',
    StringEnum = 'string-enum',
    
    // Object-oriented types
    Class = 'class',
    MetaClass = 'meta-class',
    Interface = 'interface',
    Implementation = 'impl',
    
    // Functional types
    Function = 'function',
    Coroutine = 'coroutine',
    ReturnType = 'return-type',
    
    // Special types
    Reference = 'reference',      // Named type reference
    Generic = 'generic',           // Generic type parameter
    Prototype = 'prototype',       // Built-in prototype methods
    Namespace = 'namespace',       // Namespace type
    FFI = 'ffi',                  // External FFI declaration
    
    // Meta types
    Error = 'error',              // Type error sentinel
    Never = 'never',              // Bottom type (unreachable)
    Any = 'any',                  // Top type (for gradual typing)
    Unset = 'unset',              // Type not yet computed
}

// ============================================================================
// Primitive Types
// ============================================================================

export interface IntegerTypeDescription extends TypeDescription {
    readonly kind: TypeKind.U8 | TypeKind.U16 | TypeKind.U32 | TypeKind.U64 |
                   TypeKind.I8 | TypeKind.I16 | TypeKind.I32 | TypeKind.I64;
    readonly signed: boolean;
    readonly bits: 8 | 16 | 32 | 64;
}

export interface FloatTypeDescription extends TypeDescription {
    readonly kind: TypeKind.F32 | TypeKind.F64;
    readonly bits: 32 | 64;
}

export interface BoolTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Bool;
}

export interface VoidTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Void;
}

export interface StringTypeDescription extends TypeDescription {
    readonly kind: TypeKind.String;
}

export interface StringLiteralTypeDescription extends TypeDescription {
    readonly kind: TypeKind.StringLiteral;
    readonly value: string;
}

export interface NullTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Null;
}

export type PrimitiveTypeDescription =
    | IntegerTypeDescription
    | FloatTypeDescription
    | BoolTypeDescription
    | VoidTypeDescription
    | StringTypeDescription
    | StringLiteralTypeDescription
    | NullTypeDescription;

// ============================================================================
// Composite Types
// ============================================================================

export interface ArrayTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Array;
    readonly elementType: TypeDescription;
}

export interface NullableTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Nullable;
    readonly baseType: TypeDescription;
}

export interface UnionTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Union;
    readonly types: readonly TypeDescription[];
}

export interface JoinTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Join;
    readonly types: readonly TypeDescription[];
}

export interface TupleTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Tuple;
    readonly elementTypes: readonly TypeDescription[];
}

// ============================================================================
// Structural Types
// ============================================================================

export interface StructFieldType {
    readonly name: string;
    readonly type: TypeDescription;
}

export interface StructTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Struct;
    readonly fields: readonly StructFieldType[];
    readonly isAnonymous: boolean;
}

export interface VariantConstructorType {
    readonly name: string;
    readonly parameters: readonly StructFieldType[];
}

export interface MetaVariantTypeDescription extends TypeDescription {
    readonly kind: TypeKind.MetaVariant;
    readonly baseVariant: VariantTypeDescription;
    readonly genericArgs: readonly TypeDescription[];
}

export interface VariantTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Variant;
    readonly constructors: readonly VariantConstructorType[];
}

export interface MetaVariantConstructorTypeDescription extends TypeDescription {
    readonly kind: TypeKind.MetaVariantConstructor;
    readonly baseVariantConstructor: VariantConstructorTypeDescription;
    readonly genericArgs: readonly TypeDescription[];
}

/**
 * Represents a specific variant constructor with generic arguments.
 *
 * Example: Result.Ok<i32, never> is a subtype of Result<i32, E> for any E
 *
 * Key properties:
 * - baseVariant: The resolved variant type (always a VariantType, never a reference)
 * - variantDeclaration: The type declaration (for displaying the name, e.g., "Result")
 * - constructorName: The specific constructor (e.g., "Ok" or "Err")
 * - genericArgs: Concrete type arguments (may include `never` for uninferrable params)
 *
 * Type relationship:
 * - Result.Ok<i32, never> <: Result<i32, string>
 * - Result.Err<never, string> <: Result<i32, string>
 * - Result.Ok<i32, never> is NOT assignable to Result.Err<i32, never>
 *
 * Note: baseVariant must be resolved before creating a VariantConstructorTypeDescription.
 * References should be resolved using TypeProvider.resolveReference() first.
 * variantDeclaration may be undefined for anonymous variants.
 */
export interface VariantConstructorTypeDescription extends TypeDescription {
    readonly kind: TypeKind.VariantConstructor;
    /** The resolved variant type - always VariantTypeDescription, never ReferenceType */
    readonly baseVariant: VariantTypeDescription;
    /** The variant's type declaration (for display purposes, may be undefined for anonymous variants) */
    readonly variantDeclaration?: ast.TypeDeclaration;
    /** The specific constructor name (e.g., "Ok" or "Err") */
    readonly constructorName: string;
    /** Generic arguments for this constructor (may include never) */
    readonly genericArgs: readonly TypeDescription[];
    /** Parent constructor type  */
    readonly parentConstructor: ast.VariantConstructor;
}

export interface EnumCaseType {
    readonly name: string;
    readonly value?: number;
}

export interface EnumTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Enum;
    readonly cases: readonly EnumCaseType[];
    readonly encoding?: IntegerTypeDescription;
}

export interface MetaEnumTypeDescription extends TypeDescription {
    readonly kind: TypeKind.MetaEnum;
    readonly baseEnum: EnumTypeDescription;
}

export interface StringEnumTypeDescription extends TypeDescription {
    readonly kind: TypeKind.StringEnum;
    readonly values: readonly string[];
}

// ============================================================================
// Object-Oriented Types
// ============================================================================

export interface MethodType {
    readonly names: readonly string[];
    readonly genericParameters: readonly GenericTypeDescription[];
    readonly parameters: readonly FunctionParameterType[];
    readonly returnType: TypeDescription;
    readonly isStatic: boolean;
    readonly isOverride: boolean;
    readonly isLocal: boolean;
}

export interface AttributeType {
    readonly name: string;
    readonly type: TypeDescription;
    readonly isStatic: boolean;
    readonly isConst: boolean;
    readonly isLocal: boolean;
}

export interface InterfaceTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Interface;
    readonly methods: readonly MethodType[];
    readonly superTypes: readonly TypeDescription[];
}

export interface ClassTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Class;
    readonly attributes: readonly AttributeType[];
    readonly methods: readonly MethodType[];
    readonly superTypes: readonly TypeDescription[];
    readonly implementations: readonly TypeDescription[];
}

export interface MetaClassTypeDescription extends TypeDescription {
    readonly kind: TypeKind.MetaClass;
    readonly baseClass: ClassTypeDescription;
}

export interface ImplementationTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Implementation;
    readonly attributes: readonly AttributeType[];
    readonly methods: readonly MethodType[];
    readonly targetType?: TypeDescription; // The type this impl is for
}

// ============================================================================
// Functional Types
// ============================================================================

export interface FunctionParameterType {
    readonly name: string;
    readonly type: TypeDescription;
    readonly isMut: boolean;
}

export interface FunctionTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Function;
    readonly fnType: 'fn' | 'cfn'; // regular or coroutine function
    readonly parameters: readonly FunctionParameterType[];
    readonly returnType: TypeDescription;
    readonly genericParameters: readonly GenericTypeDescription[];
}

/**
 * Represents a coroutine instance type: `coroutine<fn(params) -> YieldType>`
 *
 * A coroutine instance wraps a coroutine function (cfn) and can be called multiple times.
 * Each call accepts the function's parameters and yields the yield type.
 *
 * Note: Coroutine instances can ONLY be created from cfn functions, not regular fn.
 * The type representation is always `coroutine<fn(...)>`, never `coroutine<cfn(...)>`.
 *
 * Example:
 * ```
 * cfn loop(x: u32[]) -> u32 {     // Function type: cfn(u32[]) -> u32
 *     yield x[0]
 *     yield x[1]
 * }
 *
 * let co = coroutine loop          // co type: coroutine<fn(u32[]) -> u32>
 * let x = co([1, 2, 3])            // Calls co, yields u32
 * let y = co([4, 5, 6])            // Calls again, yields u32
 * ```
 *
 * The coroutine instance:
 * - Is callable with the wrapped function's parameters
 * - Each call yields the yield type
 * - Can be called multiple times with same or different arguments
 * - Has builtin prototype methods (alive, state, reset, finish)
 */
export interface CoroutineTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Coroutine;
    /** Parameters required when calling the coroutine instance */
    readonly parameters: readonly FunctionParameterType[];
    /** The type that gets yielded when the coroutine is called */
    readonly yieldType: TypeDescription;
}

export interface ReturnTypeDescription extends TypeDescription {
    readonly kind: TypeKind.ReturnType;
    readonly returnType: TypeDescription;
}

// ============================================================================
// Special Types
// ============================================================================

export interface ReferenceTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Reference;
    readonly declaration: ast.TypeDeclaration;
    readonly genericArgs: readonly TypeDescription[];
    /** 
     * Lazily resolved actual type. 
     * Use TypeProvider.resolveReference() to get the actual type.
     */
    actualType?: TypeDescription;
}

export interface GenericTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Generic;
    readonly name: string;
    readonly constraint?: TypeDescription;
    readonly declaration?: ast.GenericType;
}

export interface PrototypeMethodType {
    readonly name: string;
    readonly functionType: FunctionTypeDescription;
}

export interface PrototypeTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Prototype;
    readonly targetKind: 'array' | 'coroutine' | 'string';
    readonly methods: readonly PrototypeMethodType[];
    readonly properties: readonly StructFieldType[];
}

export interface NamespaceTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Namespace;
    readonly name: string;
    readonly declaration: ast.NamespaceDecl;
}

export interface FFITypeDescription extends TypeDescription {
    readonly kind: TypeKind.FFI;
    readonly name: string;
    readonly dynlib: string;
    readonly methods: readonly MethodType[];
    readonly isLocal: boolean;
}

// ============================================================================
// Meta Types
// ============================================================================

export interface ErrorTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Error;
    readonly message: string;
    readonly cause?: unknown;
}

export interface NeverTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Never;
}

export interface AnyTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Any;
}

export interface UnsetTypeDescription extends TypeDescription {
    readonly kind: TypeKind.Unset;
}

// ============================================================================
// Type Guards
// ============================================================================

export function isIntegerType(type: TypeDescription): type is IntegerTypeDescription {
    return type.kind === TypeKind.U8 || type.kind === TypeKind.U16 || 
           type.kind === TypeKind.U32 || type.kind === TypeKind.U64 ||
           type.kind === TypeKind.I8 || type.kind === TypeKind.I16 || 
           type.kind === TypeKind.I32 || type.kind === TypeKind.I64;
}

export function isFloatType(type: TypeDescription): type is FloatTypeDescription {
    return type.kind === TypeKind.F32 || type.kind === TypeKind.F64;
}

export function isNumericType(type: TypeDescription): type is IntegerTypeDescription | FloatTypeDescription {
    return isIntegerType(type) || isFloatType(type);
}

export function isPrimitiveType(type: TypeDescription): type is PrimitiveTypeDescription {
    return isIntegerType(type) || isFloatType(type) || 
           type.kind === TypeKind.Bool || type.kind === TypeKind.Void ||
           type.kind === TypeKind.String || type.kind === TypeKind.Null;
}

export function isArrayType(type: TypeDescription): type is ArrayTypeDescription {
    return type.kind === TypeKind.Array;
}

export function isNullableType(type: TypeDescription): type is NullableTypeDescription {
    return type.kind === TypeKind.Nullable;
}

export function isUnionType(type: TypeDescription): type is UnionTypeDescription {
    return type.kind === TypeKind.Union;
}

export function isJoinType(type: TypeDescription): type is JoinTypeDescription {
    return type.kind === TypeKind.Join;
}

export function isTupleType(type: TypeDescription): type is TupleTypeDescription {
    return type.kind === TypeKind.Tuple;
}

export function isStructType(type: TypeDescription): type is StructTypeDescription {
    return type.kind === TypeKind.Struct;
}

export function isVariantType(type: TypeDescription): type is VariantTypeDescription {
    return type.kind === TypeKind.Variant;
}

export function isMetaEnumType(type: TypeDescription): type is MetaEnumTypeDescription {
    return type.kind === TypeKind.MetaEnum;
}

export function isVariantConstructorType(type: TypeDescription): type is VariantConstructorTypeDescription {
    return type.kind === TypeKind.VariantConstructor;
}

export function isMetaVariantConstructorType(type: TypeDescription): type is MetaVariantConstructorTypeDescription {
    return type.kind === TypeKind.MetaVariantConstructor;
}

export function isEnumType(type: TypeDescription): type is EnumTypeDescription {
    return type.kind === TypeKind.Enum;
}

export function isMetaVariantType(type: TypeDescription): type is MetaVariantTypeDescription {
    return type.kind === TypeKind.MetaVariant;
}

export function isStringEnumType(type: TypeDescription): type is StringEnumTypeDescription {
    return type.kind === TypeKind.StringEnum;
}

export function isInterfaceType(type: TypeDescription): type is InterfaceTypeDescription {
    return type.kind === TypeKind.Interface;
}

export function isClassType(type: TypeDescription): type is ClassTypeDescription {
    return type.kind === TypeKind.Class;
}

export function isMetaClassType(type: TypeDescription): type is MetaClassTypeDescription {
    return type.kind === TypeKind.MetaClass;
}

export function isImplementationType(type: TypeDescription): type is ImplementationTypeDescription {
    return type.kind === TypeKind.Implementation;
}

export function isFunctionType(type: TypeDescription): type is FunctionTypeDescription {
    return type.kind === TypeKind.Function;
}

export function isCoroutineType(type: TypeDescription): type is CoroutineTypeDescription {
    return type.kind === TypeKind.Coroutine;
}

export function isReturnType(type: TypeDescription): type is ReturnTypeDescription {
    return type.kind === TypeKind.ReturnType;
}

export function isReferenceType(type: TypeDescription): type is ReferenceTypeDescription {
    return type.kind === TypeKind.Reference;
}

export function isGenericType(type: TypeDescription): type is GenericTypeDescription {
    return type.kind === TypeKind.Generic;
}

export function isPrototypeType(type: TypeDescription): type is PrototypeTypeDescription {
    return type.kind === TypeKind.Prototype;
}

export function isNamespaceType(type: TypeDescription): type is NamespaceTypeDescription {
    return type.kind === TypeKind.Namespace;
}

export function isFFIType(type: TypeDescription): type is FFITypeDescription {
    return type.kind === TypeKind.FFI;
}

export function isErrorType(type: TypeDescription): type is ErrorTypeDescription {
    return type.kind === TypeKind.Error;
}

export function isNeverType(type: TypeDescription): type is NeverTypeDescription {
    return type.kind === TypeKind.Never;
}

export function isAnyType(type: TypeDescription): type is AnyTypeDescription {
    return type.kind === TypeKind.Any;
}

export function isUnsetType(type: TypeDescription): type is UnsetTypeDescription {
    return type.kind === TypeKind.Unset;
}

export function isStringType(type: TypeDescription): type is StringTypeDescription {
    return type.kind === TypeKind.String;
}

export function isStringLiteralType(type: TypeDescription): type is StringLiteralTypeDescription {
    return type.kind === TypeKind.StringLiteral;
}