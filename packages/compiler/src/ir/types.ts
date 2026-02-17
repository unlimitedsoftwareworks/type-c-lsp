/**
 * Type-C IR Type System
 *
 * Provides type definitions for the IR that carry enough information
 * for the lowering pass to select the correct VM instruction variants.
 *
 * Key distinctions the VM needs:
 * - Signed vs unsigned integers (for div, mod, shift-right)
 * - Float vs double (separate instruction variants)
 * - Pointer vs value (for GC pointer bitmap tracking)
 */

// ===== Integer Types =====

export type SignedIntType = 'i8' | 'i16' | 'i32' | 'i64';
export type UnsignedIntType = 'u8' | 'u16' | 'u32' | 'u64';
export type IntType = SignedIntType | UnsignedIntType;

// ===== Float Types =====

export type FloatType = 'f32' | 'f64';

// ===== Numeric Types (integers + floats) =====

export type NumericType = IntType | FloatType;

// ===== Scalar Types (all value types that fit in a register) =====

export type ScalarType = NumericType | 'bool';

// ===== Pointer Kinds (all GC-tracked heap objects) =====

export type PointerKind =
    | 'struct'
    | 'class'
    | 'array'
    | 'closure'
    | 'coroutine'
    | 'string'
    | 'variant'
    | 'interface'
    | 'ffi_handle';

// ===== IR Type (discriminated union) =====

export interface ScalarIRType {
    readonly tag: 'scalar';
    readonly scalar: ScalarType;
}

export interface PtrIRType {
    readonly tag: 'ptr';
    readonly kind: PointerKind;
}

export interface VoidIRType {
    readonly tag: 'void';
}

export type IRType = ScalarIRType | PtrIRType | VoidIRType;

// ===== Comparison operand type =====
// Comparisons can operate on numeric types or pointers (for eq/ne)

export type CmpType = NumericType | 'ptr';

// ===== Factory Functions =====

export function scalarType(scalar: ScalarType): ScalarIRType {
    return { tag: 'scalar', scalar };
}

export function ptrType(kind: PointerKind): PtrIRType {
    return { tag: 'ptr', kind };
}

export function voidType(): VoidIRType {
    return { tag: 'void' };
}

// ===== Type Predicates =====

export function isPointer(t: IRType): t is PtrIRType {
    return t.tag === 'ptr';
}

export function isScalar(t: IRType): t is ScalarIRType {
    return t.tag === 'scalar';
}

export function isVoid(t: IRType): t is VoidIRType {
    return t.tag === 'void';
}

const SIGNED_INT_TYPES: ReadonlySet<string> = new Set(['i8', 'i16', 'i32', 'i64']);
const UNSIGNED_INT_TYPES: ReadonlySet<string> = new Set(['u8', 'u16', 'u32', 'u64']);

export function isSignedInt(t: IRType): boolean {
    return t.tag === 'scalar' && SIGNED_INT_TYPES.has(t.scalar);
}

export function isUnsignedInt(t: IRType): boolean {
    return t.tag === 'scalar' && UNSIGNED_INT_TYPES.has(t.scalar);
}

export function isInteger(t: IRType): boolean {
    return isSignedInt(t) || isUnsignedInt(t);
}

export function isFloat(t: IRType): boolean {
    return t.tag === 'scalar' && t.scalar === 'f32';
}

export function isDouble(t: IRType): boolean {
    return t.tag === 'scalar' && t.scalar === 'f64';
}

export function isNumeric(t: IRType): boolean {
    return isInteger(t) || isFloat(t) || isDouble(t);
}

export function isBool(t: IRType): boolean {
    return t.tag === 'scalar' && t.scalar === 'bool';
}

// ===== Type Conversion Kinds =====

export type CastKind =
    | 'i_f'  // int -> float
    | 'f_i'  // float -> int
    | 'u_f'  // uint -> float
    | 'f_u'  // float -> uint
    | 'i_d'  // int -> double
    | 'd_i'  // double -> int
    | 'u_d'  // uint -> double
    | 'd_u'  // double -> uint
    | 'i_u'  // int -> uint (reinterpret)
    | 'u_i'  // uint -> int (reinterpret)
    | 'f_d'  // float -> double
    | 'd_f'; // double -> float

// ===== Literals =====

export interface IntLiteral {
    readonly type: 'int';
    readonly value: bigint;
}

export interface FloatLiteral {
    readonly type: 'float';
    readonly value: number;
}

export interface BoolLiteral {
    readonly type: 'bool';
    readonly value: boolean;
}

export interface StringLiteral {
    readonly type: 'string';
    readonly value: string;
}

export type Literal = IntLiteral | FloatLiteral | BoolLiteral | StringLiteral;

// ===== Literal Factory Functions =====

export function intLiteral(value: bigint | number): IntLiteral {
    return { type: 'int', value: typeof value === 'number' ? BigInt(value) : value };
}

export function floatLiteral(value: number): FloatLiteral {
    return { type: 'float', value };
}

export function boolLiteral(value: boolean): BoolLiteral {
    return { type: 'bool', value };
}

export function stringLiteral(value: string): StringLiteral {
    return { type: 'string', value };
}

// ===== Serialization Helpers =====

export function serializeIRType(t: IRType): string {
    switch (t.tag) {
        case 'scalar': return t.scalar;
        case 'ptr': return `ptr.${t.kind}`;
        case 'void': return 'void';
    }
}
