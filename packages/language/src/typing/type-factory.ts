/**
 * Type Factory Functions
 *
 * This module provides factory functions for creating type descriptions.
 * All type creation should go through these factories to ensure consistency.
 */

import { AstNode } from "langium";
import * as ast from "../generated/ast.js";
import type { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "./type-c-type-provider.js";
import {
    AnyTypeDescription,
    ArrayTypeDescription,
    AttributeType,
    BoolTypeDescription,
    ClassTypeDescription,
    CoroutineTypeDescription,
    EnumCaseType,
    EnumTypeDescription,
    ErrorTypeDescription,
    FFITypeDescription,
    FloatTypeDescription,
    FunctionParameterType,
    FunctionTypeDescription,
    GenericTypeDescription,
    ImplementationTypeDescription,
    IntegerTypeDescription,
    InterfaceTypeDescription,
    JoinTypeDescription,
    MetaClassTypeDescription,
    MetaEnumTypeDescription,
    MetaVariantConstructorTypeDescription,
    MetaVariantTypeDescription,
    MethodType,
    NamespaceTypeDescription,
    NeverTypeDescription,
    NullTypeDescription,
    NullableTypeDescription,
    PrototypeMethodType,
    PrototypeTypeDescription,
    ReferenceTypeDescription,
    ReturnTypeDescription,
    StringEnumTypeDescription,
    StringLiteralTypeDescription,
    StringTypeDescription,
    StructFieldType,
    StructTypeDescription,
    TupleTypeDescription,
    TypeDescription,
    TypeGuardTypeDescription,
    TypeKind,
    UnionTypeDescription,
    UnsetTypeDescription,
    VariantConstructorType,
    VariantConstructorTypeDescription,
    VariantTypeDescription,
    VoidTypeDescription,
    isReferenceType,
} from "./type-c-types.js";
import { serializer } from "./type-serialization.js";

// ============================================================================
// Primitive Types
// ============================================================================

function createU8Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.U8,
        signed: false,
        bits: 8,
        node,
        toString: () => 'u8'
    };
}

function createU16Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.U16,
        signed: false,
        bits: 16,
        node,
        toString: () => 'u16'
    };
}

function createU32Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.U32,
        signed: false,
        bits: 32,
        node,
        toString: () => 'u32'
    };
}

function createU64Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.U64,
        signed: false,
        bits: 64,
        node,
        toString: () => 'u64'
    };
}

function createI8Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.I8,
        signed: true,
        bits: 8,
        node,
        toString: () => 'i8'
    };
}

function createI16Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.I16,
        signed: true,
        bits: 16,
        node,
        toString: () => 'i16'
    };
}

function createI32Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.I32,
        signed: true,
        bits: 32,
        node,
        toString: () => 'i32'
    };
}

function createI64Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.I64,
        signed: true,
        bits: 64,
        node,
        toString: () => 'i64'
    };
}

function createF32Type(node?: AstNode): FloatTypeDescription {
    return {
        kind: TypeKind.F32,
        bits: 32,
        node,
        toString: () => 'f32'
    };
}

function createF64Type(node?: AstNode): FloatTypeDescription {
    return {
        kind: TypeKind.F64,
        bits: 64,
        node,
        toString: () => 'f64'
    };
}

function createBoolType(node?: AstNode): BoolTypeDescription {
    return {
        kind: TypeKind.Bool,
        node,
        toString: () => 'bool'
    };
}

function createVoidType(node?: AstNode): VoidTypeDescription {
    return {
        kind: TypeKind.Void,
        node,
        toString: () => 'void'
    };
}

function createStringType(node?: AstNode): StringTypeDescription {
    return {
        kind: TypeKind.String,
        node,
        toString: () => 'string'
    };
}

function createStringLiteralType(value: string, node?: AstNode): StringLiteralTypeDescription {
    return {
        kind: TypeKind.StringLiteral,
        value,
        node,
        toString: () => JSON.stringify(value)
    };
}

function createNullType(node?: AstNode): NullTypeDescription {
    return {
        kind: TypeKind.Null,
        node,
        toString: () => 'null'
    };
}

// ============================================================================
// Composite Types
// ============================================================================

function createArrayType(elementType: TypeDescription, node?: AstNode): ArrayTypeDescription {
    return {
        kind: TypeKind.Array,
        elementType,
        node,
        toString: () => `${elementType.toString()}[]`
    };
}

function createNullableType(baseType: TypeDescription, node?: AstNode): NullableTypeDescription | ErrorTypeDescription {
    return {
        kind: TypeKind.Nullable,
        baseType,
        node,
        toString: () => `${baseType.toString()}?`
    };
}

function createUnionType(types: readonly TypeDescription[], node?: AstNode): UnionTypeDescription {
    return {
        kind: TypeKind.Union,
        types,
        node,
        toString: () => types.map(t => t.toString()).join(' | ')
    };
}

function createJoinType(types: readonly TypeDescription[], node?: AstNode): JoinTypeDescription {
    return {
        kind: TypeKind.Join,
        types,
        node,
        toString: () => types.map(t => t.toString()).join(' & ')
    };
}

function createTupleType(elementTypes: readonly TypeDescription[], node?: AstNode): TupleTypeDescription {
    return {
        kind: TypeKind.Tuple,
        elementTypes,
        node,
        toString: () => `(${elementTypes.map(t => t.toString()).join(', ')})`
    };
}

// ============================================================================
// Structural Types
// ============================================================================

function createStructType(
    fields: readonly StructFieldType[],
    isAnonymous: boolean = true,
    node?: AstNode
): StructTypeDescription {
    return {
        kind: TypeKind.Struct,
        fields,
        isAnonymous,
        node,
        toString: () => {
            const fieldStrs = fields.map(f => `${f.name}: ${f.type.toString()}`).join(', ');
            return `${isAnonymous ? '' : 'struct '}{ ${fieldStrs} }`;
        }
    };
}

function createStructField(name: string, type: TypeDescription, node: AstNode): StructFieldType {
    return { name, type, node };
}

function createVariantType(
    constructors: readonly VariantConstructorType[],
    node?: AstNode
): VariantTypeDescription {
    return {
        kind: TypeKind.Variant,
        constructors,
        node,
        toString: () => {
            const ctorStrs = constructors.map(c => {
                if (c.parameters.length === 0) {
                    return c.name;
                }
                const paramStrs = c.parameters.map(p => `${p.name}: ${p.type.toString()}`).join(', ');
                return `${c.name}(${paramStrs})`;
            }).join(', ');
            return `variant { ${ctorStrs} }`;
        }
    };
}

function createMetaVariantType(
    baseVariant: VariantTypeDescription,
    genericArgs: readonly TypeDescription[] = [],
    node?: AstNode
): MetaVariantTypeDescription {
    return { kind: TypeKind.MetaVariant, baseVariant, genericArgs, node, toString: () => `${baseVariant.toString()}` };
}

function createVariantConstructor(
    name: string,
    parameters: readonly StructFieldType[]
): VariantConstructorType {
    return { name, parameters };
}


/**
 * Creates a variant constructor type.
 *
 * This represents a specific variant constructor with concrete generic arguments.
 * Example: Result.Ok<i32, never> is a subtype of Result<i32, E> for any E
 *
 * @param baseVariant The resolved variant type (must be VariantTypeDescription, not a reference)
 * @param constructorName The specific constructor name (e.g., "Ok" or "Err")
 * @param genericArgs Generic arguments for this constructor (may include never for uninferrable params)
 * @param node Optional AST node for source tracking
 * @param variantDeclaration Optional type declaration (for displaying the name, e.g., "Result")
 * @returns A VariantConstructorTypeDescription
 */
function createVariantConstructorType(
    baseVariant: VariantTypeDescription,
    constructorName: string,
    parentConstructor: ast.VariantConstructor,
    genericArgs: readonly TypeDescription[] = [],
    node?: AstNode,
    variantDeclaration?: ast.TypeDeclaration
): VariantConstructorTypeDescription {
    return {
        kind: TypeKind.VariantConstructor,
        parentConstructor,
        baseVariant,
        variantDeclaration,
        constructorName,
        genericArgs,
        node,
        toString: () => {
            // Use variantDeclaration if available for clean display names
            if (variantDeclaration) {
                const name = variantDeclaration.name;
                const genericStr = genericArgs.length > 0
                    ? `<${genericArgs.map(t => t.toString()).join(', ')}>`
                    : '';
                return `${name}.${constructorName}${genericStr}`;
            }
            // Fallback to baseVariant (shows full structure) for anonymous variants
            const base = baseVariant.toString();
            const genericStr = genericArgs.length > 0
                ? `<${genericArgs.map(t => t.toString()).join(', ')}>`
                : '';
            return `${base}.${constructorName}${genericStr}`;
        }
    };
}


function createMetaVariantConstructorType(
    baseVariantConstructor: VariantConstructorTypeDescription,
    genericArgs: readonly TypeDescription[] = [],
    node?: AstNode
): MetaVariantConstructorTypeDescription {
    return { kind: TypeKind.MetaVariantConstructor, baseVariantConstructor, genericArgs, node, toString: () => `${baseVariantConstructor.toString()}` };
}

function createEnumType(
    cases: readonly EnumCaseType[],
    encoding?: IntegerTypeDescription,
    node?: AstNode
): EnumTypeDescription {
    return {
        kind: TypeKind.Enum,
        cases,
        encoding,
        node,
        toString: () => {
            const caseStrs = cases.map(c => 
                c.value !== undefined ? `${c.name} = ${c.value}` : c.name
            ).join(', ');
            const encodingStr = encoding ? ` as ${encoding.toString()}` : '';
            return `enum${encodingStr} { ${caseStrs} }`;
        }
    };
}

function createMetaEnumType(
    baseEnum: EnumTypeDescription,
    node?: AstNode
): MetaEnumTypeDescription {
    return { kind: TypeKind.MetaEnum, baseEnum, node, toString: () => `${baseEnum.toString()}` };
}

function createEnumCase(name: string, value?: number): EnumCaseType {
    return { name, value };
}

function createStringEnumType(values: readonly string[], node?: AstNode): StringEnumTypeDescription {
    return {
        kind: TypeKind.StringEnum,
        values,
        node,
        toString: () => values.map(v => JSON.stringify(v)).join(' | ')
    };
}

// ============================================================================
// Object-Oriented Types
// ============================================================================

function createInterfaceType(
    methods: readonly MethodType[],
    superTypes: readonly TypeDescription[] = [],
    node?: AstNode
): InterfaceTypeDescription {
    return {
        kind: TypeKind.Interface,
        methods,
        superTypes,
        node,
        toString: () => {
            const methodsStr = serializer.serializeMethods(methods);
            const superStr = superTypes.length > 0 
                ? superTypes.map(t => t.toString()).join(', ') + ' ' 
                : '';
            return `interface ${superStr}{\n${methodsStr}\n}`;
        }
    };
}

function createClassType(
    attributes: readonly AttributeType[],
    methods: readonly MethodType[],
    superTypes: readonly TypeDescription[] = [],
    implementations: readonly TypeDescription[] = [],
    node?: AstNode
): ClassTypeDescription {
    return {
        kind: TypeKind.Class,
        attributes,
        methods,
        superTypes,
        implementations,
        node,
        toString: () => {
            const methodHeaders = serializer.serializeMethods(methods)
            const attrs = serializer.serializeClassAttributes(attributes)
            const superStr = superTypes.length > 0 
                ? ("("+superTypes.map(t => t.toString()).join(', ')) + ') ' 
                : '';
            return `class ${superStr}{\n${attrs}\n\n${methodHeaders}\n}`;

        }
    };
}

function createMetaClassType(
    baseClass: ClassTypeDescription,
    node?: AstNode
): MetaClassTypeDescription {
    return { kind: TypeKind.MetaClass, baseClass, node, toString: () => `${baseClass.toString()}` };
}

function createImplementationType(
    attributes: readonly AttributeType[],
    methods: readonly MethodType[],
    targetType?: TypeDescription,
    node?: AstNode
): ImplementationTypeDescription {
    return {
        kind: TypeKind.Implementation,
        attributes,
        methods,
        targetType,
        node,
        toString: () => {
            const forStr = targetType ? ` for ${targetType.toString()}` : '';
            return `impl${forStr} { ... }`;
        }
    };
}

function createMethodType(
    names: readonly string[],
    parameters: readonly FunctionParameterType[],
    returnType: TypeDescription,
    node: ast.MethodHeader | undefined,
    genericParameters: readonly GenericTypeDescription[] = [],
    isStatic: boolean = false,
    isOverride: boolean = false,
    isLocal: boolean = false
): MethodType {
    return {
        names,
        genericParameters,
        parameters,
        returnType,
        isStatic,
        isOverride,
        isLocal,
        node
    };
}

function createAttributeType(
    name: string,
    type: TypeDescription,
    isStatic: boolean = false,
    isConst: boolean = false,
    isLocal: boolean = false
): AttributeType {
    return {
        name,
        type,
        isStatic,
        isConst,
        isLocal
    };
}

// ============================================================================
// Functional Types
// ============================================================================

function createFunctionParameterType(
    name: string,
    type: TypeDescription,
    isMut: boolean = false
): FunctionParameterType {
    return { name, type, isMut };
}

function createFunctionType(
    parameters: readonly FunctionParameterType[],
    returnType: TypeDescription,
    fnType: 'fn' | 'cfn' = 'fn',
    genericParameters: readonly GenericTypeDescription[] = [],
    node?: AstNode
): FunctionTypeDescription {
    return {
        kind: TypeKind.Function,
        fnType,
        parameters,
        returnType,
        genericParameters,
        node,
        toString: () => {
            const genericsStr = genericParameters.length > 0 
                ? `<${genericParameters.map(g => g.toString()).join(', ')}>`
                : '';
            const paramStrs = parameters.map(p => 
                `${p.isMut ? 'mut ' : ''}${p.name}: ${p.type.toString()}`
            ).join(', ');
            return `${fnType}${genericsStr}(${paramStrs}) -> ${returnType.toString()}`;
        }
    };
}

/**
 * Creates a coroutine instance type: `coroutine<fn(params) -> YieldType>`
 *
 * A coroutine instance wraps a coroutine function (cfn) and can be called multiple times.
 * The type representation is always `coroutine<fn(...)>`, never `coroutine<cfn(...)>`.
 *
 * @param parameters Parameters required when calling the coroutine instance
 * @param yieldType The type that gets yielded when the coroutine is called
 * @param node Optional AST node for source tracking
 */
function createCoroutineType(
    parameters: readonly FunctionParameterType[],
    yieldType: TypeDescription,
    node?: AstNode
): CoroutineTypeDescription {
    return {
        kind: TypeKind.Coroutine,
        parameters,
        yieldType,
        node,
        toString: () => {
            const paramStrs = parameters.map(p =>
                `${p.isMut ? 'mut ' : ''}${p.name}: ${p.type.toString()}`
            ).join(', ');
            return `coroutine<fn(${paramStrs}) -> ${yieldType.toString()}>`;
        }
    };
}

function createReturnType(returnType: TypeDescription, node?: AstNode): ReturnTypeDescription {
    return {
        kind: TypeKind.ReturnType,
        returnType,
        node,
        toString: () => `ReturnType(${returnType.toString()})`
    };
}

function createTypeGuardType(
    parameterName: string,
    parameterIndex: number,
    guardedType: TypeDescription,
    node?: AstNode
): TypeGuardTypeDescription {
    return {
        kind: TypeKind.TypeGuard,
        parameterName,
        parameterIndex,
        guardedType,
        node,
        toString: () => `${parameterName} is ${guardedType.toString()}`
    };
}

// ============================================================================
// Special Types
// ============================================================================

function createReferenceType(
    declaration: ast.TypeDeclaration,
    genericArgs: readonly TypeDescription[] = [],
    node?: AstNode
): ReferenceTypeDescription {
    return {
        kind: TypeKind.Reference,
        declaration,
        genericArgs,
        node,
        toString: () => {
            const argsStr = genericArgs.length > 0 
                ? `<${genericArgs.map(a => a.toString()).join(', ')}>`
                : '';
            return `${declaration.name}${argsStr}`;
        }
    };
}

function createGenericType(
    name: string,
    constraint?: TypeDescription,
    declaration?: ast.GenericType,
    node?: AstNode
): GenericTypeDescription {
    return {
        kind: TypeKind.Generic,
        name,
        constraint,
        declaration,
        node,
        toString: () => constraint ? `${name}: ${constraint.toString()}` : name
    };
}

function createPrototypeType(
    targetKind: 'array' | 'coroutine' | 'string',
    methods: readonly PrototypeMethodType[],
    properties: readonly StructFieldType[] = [],
    node?: AstNode
): PrototypeTypeDescription {
    return {
        kind: TypeKind.Prototype,
        targetKind,
        methods,
        properties,
        node,
        toString: () => `prototype for ${targetKind}`
    };
}

function createPrototypeMethod(
    name: string,
    functionType: FunctionTypeDescription
): PrototypeMethodType {
    return { name, functionType };
}

function createNamespaceType(
    name: string,
    declaration: ast.NamespaceDecl,
    node?: AstNode
): NamespaceTypeDescription {
    return {
        kind: TypeKind.Namespace,
        name,
        declaration,
        node,
        toString: () => `namespace ${name}`
    };
}

function createFFIType(
    name: string,
    dynlib: string,
    methods: readonly MethodType[],
    isLocal: boolean = false,
    node?: AstNode
): FFITypeDescription {
    return {
        kind: TypeKind.FFI,
        name,
        dynlib,
        methods,
        isLocal,
        node,
        toString: () => `extern ${name} from "${dynlib}"`
    };
}

// ============================================================================
// Meta Types
// ============================================================================

function createErrorType(message: string, cause?: unknown, node?: AstNode): ErrorTypeDescription {
    return {
        kind: TypeKind.Error,
        message,
        cause,
        node,
        toString: () => `<error: ${message}>`
    };
}

function createNeverType(node?: AstNode): NeverTypeDescription {
    return {
        kind: TypeKind.Never,
        node,
        toString: () => 'never'
    };
}

function createAnyType(node?: AstNode): AnyTypeDescription {
    return {
        kind: TypeKind.Any,
        node,
        toString: () => 'any'
    };
}

function createUnsetType(node?: AstNode): UnsetTypeDescription {
    return {
        kind: TypeKind.Unset,
        node,
        toString: () => '<unset>'
    };
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Creates an integer type from a string specifier (e.g., "u32", "i64")
 */
function createIntegerTypeFromString(spec: string, node?: AstNode): IntegerTypeDescription | undefined {
    switch (spec) {
        case 'u8': return createU8Type(node);
        case 'u16': return createU16Type(node);
        case 'u32': return createU32Type(node);
        case 'u64': return createU64Type(node);
        case 'i8': return createI8Type(node);
        case 'i16': return createI16Type(node);
        case 'i32': return createI32Type(node);
        case 'i64': return createI64Type(node);
        default: return undefined;
    }
}

/**
 * Creates a float type from a string specifier (e.g., "f32", "f64")
 */
function createFloatTypeFromString(spec: string, node?: AstNode): FloatTypeDescription | undefined {
    switch (spec) {
        case 'f32': return createF32Type(node);
        case 'f64': return createF64Type(node);
        default: return undefined;
    }
}

/**
 * Creates a primitive type from an AST PrimitiveType node
 */
function createPrimitiveTypeFromAST(astType: ast.PrimitiveType): TypeDescription {
    if (astType.integerType) {
        return createIntegerTypeFromString(astType.integerType, astType) ?? createErrorType(`Unknown integer type: ${astType.integerType}`, undefined, astType);
    }
    if (astType.floatType) {
        return createFloatTypeFromString(astType.floatType, astType) ?? createErrorType(`Unknown float type: ${astType.floatType}`, undefined, astType);
    }
    if (astType.boolType) {
        return createBoolType(astType);
    }
    if (astType.voidType) {
        return createVoidType(astType);
    }
    if (astType.stringType) {
        return createStringType(astType);
    }
    if (astType.neverType) {
        return createNeverType(astType);
    }
    if (astType.nullType) {
        return createNullType(astType);
    }

    return createErrorType('Unknown primitive type', undefined, astType);
}

// ============================================================================
// Type Factory Service
// ============================================================================

/**
 * Type Factory Service
 *
 * This service wraps the factory functions and provides a consistent API.
 * 
 * IMPORTANT: The factory does NOT validate usage contexts - it only creates types.
 * Validation of inappropriate type usage (e.g., nullable basic types in variable declarations)
 * happens at the validation layer, not during type creation. This separation allows:
 * 
 * 1. Intermediate nullable basic types to exist during type inference
 *    Example: `v?.get()` where get() returns `u32` creates temporary `u32?`
 * 
 * 2. These intermediate types to be consumed by null-handling operators
 *    Example: `v?.get() ?? 1u32` - the `??` consumes the `u32?` and produces `u32`
 * 
 * 3. Only explicit declarations to be validated
 *    Example: `let x: u32? = ...` is caught by validation, not factory
 */
export class TypeCTypeFactory {
    private readonly typeProvider: () => TypeCTypeProvider;
    //private readonly typeUtils: () => TypeCTypeUtils;

    constructor(services: TypeCServices) {
        // Use lazy getter to avoid circular dependency
        this.typeProvider = () => services.typing.TypeProvider;
        //this.typeUtils = () => services.typing.TypeUtils;
    }

    /**
     * Checks if a type is a basic/primitive type (either directly or through a reference)
     */
    isBasicType(type: TypeDescription): boolean {
        // Direct primitive types
        if (type.kind === TypeKind.U8 || type.kind === TypeKind.U16 ||
            type.kind === TypeKind.U32 || type.kind === TypeKind.U64 ||
            type.kind === TypeKind.I8 || type.kind === TypeKind.I16 ||
            type.kind === TypeKind.I32 || type.kind === TypeKind.I64 ||
            type.kind === TypeKind.F32 || type.kind === TypeKind.F64 ||
            type.kind === TypeKind.Bool || type.kind === TypeKind.Void ||
            type.kind === TypeKind.Null
        ) {
            return true;
        }

        // Reference types - need to resolve them
        if (isReferenceType(type)) {
            const resolvedType = this.typeProvider().resolveReference(type);
            // Avoid infinite recursion - if it's still a reference after resolution, it's not basic
            if (resolvedType.kind === TypeKind.Reference) {
                return false;
            }
            return this.isBasicType(resolvedType);
        }

        return false;
    }

    /**
     * Creates a nullable type.
     * 
     * IMPORTANT: This factory method does NOT validate whether creating a nullable basic type
     * is appropriate for the usage context. It simply creates the type description.
     * 
     * Validation happens at the validation layer (checkNullableType in type-system-validations.ts),
     * which checks explicit type declarations like `let x: u32?` and reports them as errors.
     * 
     * This design allows nullable basic types to exist temporarily during type inference
     * (e.g., from optional chaining like `v?.get()` where get() returns u32) and be consumed
     * by null-handling operators like `??` or `!` before reaching validation points.
     * 
     * Examples:
     * - `v?.get() ?? 1u32` - Creates temporary `u32?`, then `??` unwraps it to `u32` ✅
     * - `let x: u32? = ...` - Caught by validation, not factory ❌
     */
    createNullableType(baseType: TypeDescription, node?: AstNode): TypeDescription {
        // No validation here - just create the type
        // Validation of inappropriate usage happens at the validation layer
        return createNullableType(baseType, node);
    }

    // Delegate all other factory methods to the standalone functions
    createU8Type = createU8Type;
    createU16Type = createU16Type;
    createU32Type = createU32Type;
    createU64Type = createU64Type;
    createI8Type = createI8Type;
    createI16Type = createI16Type;
    createI32Type = createI32Type;
    createI64Type = createI64Type;
    createF32Type = createF32Type;
    createF64Type = createF64Type;
    createBoolType = createBoolType;
    createVoidType = createVoidType;
    createStringType = createStringType;
    createStringLiteralType = createStringLiteralType;
    createNullType = createNullType;
    createArrayType = createArrayType;
    createUnionType = createUnionType;
    createJoinType = createJoinType;
    createTupleType = createTupleType;
    createStructType = createStructType;
    createStructField = createStructField;
    createVariantType = createVariantType;
    createMetaVariantType = createMetaVariantType;
    createVariantConstructor = createVariantConstructor;
    createVariantConstructorType = createVariantConstructorType;
    createMetaVariantConstructorType = createMetaVariantConstructorType;
    createEnumType = createEnumType;
    createMetaEnumType = createMetaEnumType;
    createEnumCase = createEnumCase;
    createStringEnumType = createStringEnumType;
    createInterfaceType = createInterfaceType;
    createClassType = createClassType;
    createMetaClassType = createMetaClassType;
    createImplementationType = createImplementationType;
    createMethodType = createMethodType;
    createAttributeType = createAttributeType;
    createFunctionParameterType = createFunctionParameterType;
    createFunctionType = createFunctionType;
    createCoroutineType = createCoroutineType;
    createReturnType = createReturnType;
    createTypeGuardType = createTypeGuardType;
    createReferenceType = createReferenceType;
    createGenericType = createGenericType;
    createPrototypeType = createPrototypeType;
    createPrototypeMethod = createPrototypeMethod;
    createNamespaceType = createNamespaceType;
    createFFIType = createFFIType;
    createErrorType = createErrorType;
    createNeverType = createNeverType;
    createAnyType = createAnyType;
    createUnsetType = createUnsetType;
    createIntegerTypeFromString = createIntegerTypeFromString;
    createFloatTypeFromString = createFloatTypeFromString;
    createPrimitiveTypeFromAST = createPrimitiveTypeFromAST;
}
