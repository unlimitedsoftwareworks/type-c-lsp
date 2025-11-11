/**
 * Type Factory Functions
 * 
 * This module provides factory functions for creating type descriptions.
 * All type creation should go through these factories to ensure consistency.
 */

import * as ast from "../generated/ast.js";
import { AstNode } from "langium";
import {
    TypeDescription,
    TypeKind,
    IntegerTypeDescription,
    FloatTypeDescription,
    BoolTypeDescription,
    VoidTypeDescription,
    StringTypeDescription,
    NullTypeDescription,
    ArrayTypeDescription,
    NullableTypeDescription,
    UnionTypeDescription,
    JoinTypeDescription,
    TupleTypeDescription,
    StructTypeDescription,
    StructFieldType,
    VariantTypeDescription,
    VariantConstructorType,
    VariantConstructorTypeDescription,
    EnumTypeDescription,
    EnumCaseType,
    StringEnumTypeDescription,
    InterfaceTypeDescription,
    ClassTypeDescription,
    ImplementationTypeDescription,
    FunctionTypeDescription,
    FunctionParameterType,
    CoroutineTypeDescription,
    ReturnTypeDescription,
    ReferenceTypeDescription,
    GenericTypeDescription,
    PrototypeTypeDescription,
    PrototypeMethodType,
    NamespaceTypeDescription,
    FFITypeDescription,
    ErrorTypeDescription,
    NeverTypeDescription,
    AnyTypeDescription,
    UnsetTypeDescription,
    MethodType,
    AttributeType,
} from "./type-c-types.js";

// ============================================================================
// Primitive Types
// ============================================================================

export function createU8Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.U8,
        signed: false,
        bits: 8,
        node,
        toString: () => 'u8'
    };
}

export function createU16Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.U16,
        signed: false,
        bits: 16,
        node,
        toString: () => 'u16'
    };
}

export function createU32Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.U32,
        signed: false,
        bits: 32,
        node,
        toString: () => 'u32'
    };
}

export function createU64Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.U64,
        signed: false,
        bits: 64,
        node,
        toString: () => 'u64'
    };
}

export function createI8Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.I8,
        signed: true,
        bits: 8,
        node,
        toString: () => 'i8'
    };
}

export function createI16Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.I16,
        signed: true,
        bits: 16,
        node,
        toString: () => 'i16'
    };
}

export function createI32Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.I32,
        signed: true,
        bits: 32,
        node,
        toString: () => 'i32'
    };
}

export function createI64Type(node?: AstNode): IntegerTypeDescription {
    return {
        kind: TypeKind.I64,
        signed: true,
        bits: 64,
        node,
        toString: () => 'i64'
    };
}

export function createF32Type(node?: AstNode): FloatTypeDescription {
    return {
        kind: TypeKind.F32,
        bits: 32,
        node,
        toString: () => 'f32'
    };
}

export function createF64Type(node?: AstNode): FloatTypeDescription {
    return {
        kind: TypeKind.F64,
        bits: 64,
        node,
        toString: () => 'f64'
    };
}

export function createBoolType(node?: AstNode): BoolTypeDescription {
    return {
        kind: TypeKind.Bool,
        node,
        toString: () => 'bool'
    };
}

export function createVoidType(node?: AstNode): VoidTypeDescription {
    return {
        kind: TypeKind.Void,
        node,
        toString: () => 'void'
    };
}

export function createStringType(node?: AstNode): StringTypeDescription {
    return {
        kind: TypeKind.String,
        node,
        toString: () => 'string'
    };
}

export function createNullType(node?: AstNode): NullTypeDescription {
    return {
        kind: TypeKind.Null,
        node,
        toString: () => 'null'
    };
}

// ============================================================================
// Composite Types
// ============================================================================

export function createArrayType(elementType: TypeDescription, node?: AstNode): ArrayTypeDescription {
    return {
        kind: TypeKind.Array,
        elementType,
        node,
        toString: () => `${elementType.toString()}[]`
    };
}

export function createNullableType(baseType: TypeDescription, node?: AstNode): NullableTypeDescription {
    return {
        kind: TypeKind.Nullable,
        baseType,
        node,
        toString: () => `${baseType.toString()}?`
    };
}

export function createUnionType(types: readonly TypeDescription[], node?: AstNode): UnionTypeDescription {
    return {
        kind: TypeKind.Union,
        types,
        node,
        toString: () => types.map(t => t.toString()).join(' | ')
    };
}

export function createJoinType(types: readonly TypeDescription[], node?: AstNode): JoinTypeDescription {
    return {
        kind: TypeKind.Join,
        types,
        node,
        toString: () => types.map(t => t.toString()).join(' & ')
    };
}

export function createTupleType(elementTypes: readonly TypeDescription[], node?: AstNode): TupleTypeDescription {
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

export function createStructType(
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

export function createStructField(name: string, type: TypeDescription): StructFieldType {
    return { name, type };
}

export function createVariantType(
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

export function createVariantConstructor(
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
export function createVariantConstructorType(
    baseVariant: VariantTypeDescription,
    constructorName: string,
    genericArgs: readonly TypeDescription[] = [],
    node?: AstNode,
    variantDeclaration?: ast.TypeDeclaration
): VariantConstructorTypeDescription {
    return {
        kind: TypeKind.VariantConstructor,
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

export function createEnumType(
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

export function createEnumCase(name: string, value?: number): EnumCaseType {
    return { name, value };
}

export function createStringEnumType(values: readonly string[], node?: AstNode): StringEnumTypeDescription {
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

export function createInterfaceType(
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
            const superStr = superTypes.length > 0 
                ? superTypes.map(t => t.toString()).join(', ') + ' ' 
                : '';
            return `interface ${superStr}{ ... }`;
        }
    };
}

export function createClassType(
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
            const extendsStr = superTypes.length > 0 
                ? superTypes.map(t => t.toString()).join(', ') + ' ' 
                : '';
            return `class ${extendsStr}{ ... }`;
        }
    };
}

export function createImplementationType(
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

export function createMethodType(
    names: readonly string[],
    parameters: readonly FunctionParameterType[],
    returnType: TypeDescription,
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
        isLocal
    };
}

export function createAttributeType(
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

export function createFunctionParameterType(
    name: string,
    type: TypeDescription,
    isMut: boolean = false
): FunctionParameterType {
    return { name, type, isMut };
}

export function createFunctionType(
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

export function createCoroutineType(
    parameters: readonly FunctionParameterType[],
    returnType: TypeDescription,
    yieldType: TypeDescription,
    fnType: 'fn' | 'cfn' = 'fn',
    node?: AstNode
): CoroutineTypeDescription {
    return {
        kind: TypeKind.Coroutine,
        fnType,
        parameters,
        returnType,
        yieldType,
        node,
        toString: () => {
            const paramStrs = parameters.map(p => 
                `${p.isMut ? 'mut ' : ''}${p.name}: ${p.type.toString()}`
            ).join(', ');
            return `coroutine<${fnType}(${paramStrs}) -> ${returnType.toString()}>`;
        }
    };
}

export function createReturnType(returnType: TypeDescription, node?: AstNode): ReturnTypeDescription {
    return {
        kind: TypeKind.ReturnType,
        returnType,
        node,
        toString: () => `ReturnType(${returnType.toString()})`
    };
}

// ============================================================================
// Special Types
// ============================================================================

export function createReferenceType(
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

export function createGenericType(
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

export function createPrototypeType(
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

export function createPrototypeMethod(
    name: string,
    functionType: FunctionTypeDescription
): PrototypeMethodType {
    return { name, functionType };
}

export function createNamespaceType(
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

export function createFFIType(
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

export function createErrorType(message: string, cause?: unknown, node?: AstNode): ErrorTypeDescription {
    return {
        kind: TypeKind.Error,
        message,
        cause,
        node,
        toString: () => `<error: ${message}>`
    };
}

export function createNeverType(node?: AstNode): NeverTypeDescription {
    return {
        kind: TypeKind.Never,
        node,
        toString: () => 'never'
    };
}

export function createAnyType(node?: AstNode): AnyTypeDescription {
    return {
        kind: TypeKind.Any,
        node,
        toString: () => 'any'
    };
}

export function createUnsetType(node?: AstNode): UnsetTypeDescription {
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
export function createIntegerTypeFromString(spec: string, node?: AstNode): IntegerTypeDescription | undefined {
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
export function createFloatTypeFromString(spec: string, node?: AstNode): FloatTypeDescription | undefined {
    switch (spec) {
        case 'f32': return createF32Type(node);
        case 'f64': return createF64Type(node);
        default: return undefined;
    }
}

/**
 * Creates a primitive type from an AST PrimitiveType node
 */
export function createPrimitiveTypeFromAST(astType: ast.PrimitiveType): TypeDescription {
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

