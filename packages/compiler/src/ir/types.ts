/**
 * Self-contained API for LIR (Low-level Intermediate Representation)
 * This module provides type definitions independent of Langium
 */

// ===== Data Types =====

export type BasicDataType =
    | 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32' | 'i64' | 'u64'
    | 'f32' | 'f64'
    | 'bool' | 'string'
    | 'class' | 'struct' | 'interface' | 'variant'
    | 'coroutine' | 'function';

export type IntType = 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32' | 'i64' | 'u64';

export interface DataType {
    readonly type: 'basic' | 'array' | 'nullable';
}

export interface BasicType extends DataType {
    readonly type: 'basic';
    readonly name: BasicDataType;
}

export interface ArrayType extends DataType {
    readonly type: 'array';
    readonly elementType: DataType;
}

export interface NullableType extends DataType {
    readonly type: 'nullable';
    readonly baseType: DataType;
}

// ===== Literals =====

export type Literal = IntLiteral | FloatLiteral | BoolLiteral | CharLiteral | StringLiteral;

export interface IntLiteral {
    readonly type: 'int';
    readonly value: number;
}

export interface FloatLiteral {
    readonly type: 'float';
    readonly value: number;
}

export interface BoolLiteral {
    readonly type: 'bool';
    readonly value: boolean;
}

export interface CharLiteral {
    readonly type: 'char';
    readonly value: string;
}

export interface StringLiteral {
    readonly type: 'string';
    readonly value: string;
}

// ===== Operations =====

export type BinaryOp =
    | 'add' | 'mul' | 'sub' | 'div' | 'mod'
    | 'shl' | 'shr'
    | 'band' | 'bor' | 'bxor'
    | 'eq' | 'neq' | 'lt' | 'gt' | 'le' | 'ge'
    | 'and' | 'or';

export type UnaryOp = 'not' | 'bnot' | 'isnull' | 'istrue' | 'isfalse' | 'neg' | 'id';

export type NoArgOp = 'nop' | 'speculate' | 'commit';

export type CastType =
    | 'i_f' | 'f_i' | 'u_f' | 'f_u'
    | 'i_d' | 'd_i' | 'u_d' | 'd_u'
    | 'i_u' | 'u_i' | 'f_d' | 'd_f';

export type StringConcatType = 's' | 'i' | 'u' | 'f' | 'd' | 'ptr';

// ===== Helper Functions =====

export function basicType(name: BasicDataType): BasicType {
    return { type: 'basic', name };
}

export function arrayType(elementType: DataType): ArrayType {
    return { type: 'array', elementType };
}

export function nullableType(baseType: DataType): NullableType {
    return { type: 'nullable', baseType };
}

export function intLiteral(value: number): IntLiteral {
    return { type: 'int', value };
}

export function floatLiteral(value: number): FloatLiteral {
    return { type: 'float', value };
}

export function boolLiteral(value: boolean): BoolLiteral {
    return { type: 'bool', value };
}

export function charLiteral(value: string): CharLiteral {
    return { type: 'char', value };
}

export function stringLiteral(value: string): StringLiteral {
    return { type: 'string', value };
}