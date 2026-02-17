/**
 * Type-C IR Instruction Definitions
 *
 * Every value-producing instruction carries an IRType so the lowering pass
 * can select the correct VM instruction variant (e.g., MOV_RR vs MOV_PTR_RR,
 * ADD_IU_RR vs ADD_F_RR vs ADD_D_RR).
 *
 * Virtual register names (VReg) are strings like "%t0", "%x", "%self".
 * The lowering pass maps these to physical registers (0-255).
 */

import type {
    IRType,
    IntType,
    FloatType,
    NumericType,
    CmpType,
    CastKind
} from './types.js';

// ===== Virtual Register =====

export type VReg = string;

// ===== Base Instruction =====

export interface Instruction {
    readonly kind: string;
}

// ===== Constants & Moves =====

export interface ConstIntInstruction extends Instruction {
    readonly kind: 'const_int';
    readonly dest: VReg;
    readonly value: bigint;
    readonly intType: IntType;
}

export interface ConstFloatInstruction extends Instruction {
    readonly kind: 'const_float';
    readonly dest: VReg;
    readonly value: number;
    readonly floatType: FloatType;
}

export interface ConstBoolInstruction extends Instruction {
    readonly kind: 'const_bool';
    readonly dest: VReg;
    readonly value: boolean;
}

export interface ConstNullInstruction extends Instruction {
    readonly kind: 'const_null';
    readonly dest: VReg;
}

export interface MovInstruction extends Instruction {
    readonly kind: 'mov';
    readonly dest: VReg;
    readonly src: VReg;
    readonly type: IRType;
}

// ===== Arithmetic Operations =====

export interface AddInstruction extends Instruction {
    readonly kind: 'add';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
    readonly numType: NumericType;
}

export interface SubInstruction extends Instruction {
    readonly kind: 'sub';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
    readonly numType: NumericType;
}

export interface MulInstruction extends Instruction {
    readonly kind: 'mul';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
    readonly numType: NumericType;
}

export interface DivInstruction extends Instruction {
    readonly kind: 'div';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
    readonly numType: NumericType;
}

export interface ModInstruction extends Instruction {
    readonly kind: 'mod';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
    readonly numType: NumericType;
}

export interface NegInstruction extends Instruction {
    readonly kind: 'neg';
    readonly dest: VReg;
    readonly src: VReg;
    readonly numType: NumericType;
}

// ===== Bitwise Operations =====

export interface ShlInstruction extends Instruction {
    readonly kind: 'shl';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
}

export interface ShrInstruction extends Instruction {
    readonly kind: 'shr';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
    readonly signed: boolean;
}

export interface BandInstruction extends Instruction {
    readonly kind: 'band';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
}

export interface BorInstruction extends Instruction {
    readonly kind: 'bor';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
}

export interface BxorInstruction extends Instruction {
    readonly kind: 'bxor';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
}

export interface BnotInstruction extends Instruction {
    readonly kind: 'bnot';
    readonly dest: VReg;
    readonly src: VReg;
}

// ===== Comparisons =====
// All produce a boolean result. Lowering fuses with br when possible.

export interface CmpLtInstruction extends Instruction {
    readonly kind: 'cmp_lt';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
    readonly cmpType: NumericType;
}

export interface CmpLeInstruction extends Instruction {
    readonly kind: 'cmp_le';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
    readonly cmpType: NumericType;
}

export interface CmpGtInstruction extends Instruction {
    readonly kind: 'cmp_gt';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
    readonly cmpType: NumericType;
}

export interface CmpGeInstruction extends Instruction {
    readonly kind: 'cmp_ge';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
    readonly cmpType: NumericType;
}

export interface CmpEqInstruction extends Instruction {
    readonly kind: 'cmp_eq';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
    readonly cmpType: CmpType;
}

export interface CmpNeInstruction extends Instruction {
    readonly kind: 'cmp_ne';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
    readonly cmpType: CmpType;
}

export interface CmpEqStrInstruction extends Instruction {
    readonly kind: 'cmp_eq_str';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
}

export interface CmpNeStrInstruction extends Instruction {
    readonly kind: 'cmp_ne_str';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
}

export interface IsNullInstruction extends Instruction {
    readonly kind: 'is_null';
    readonly dest: VReg;
    readonly src: VReg;
}

export interface IsTrueInstruction extends Instruction {
    readonly kind: 'is_true';
    readonly dest: VReg;
    readonly src: VReg;
}

export interface IsFalseInstruction extends Instruction {
    readonly kind: 'is_false';
    readonly dest: VReg;
    readonly src: VReg;
}

// ===== Logical Operations =====

export interface AndInstruction extends Instruction {
    readonly kind: 'and';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
}

export interface OrInstruction extends Instruction {
    readonly kind: 'or';
    readonly dest: VReg;
    readonly lhs: VReg;
    readonly rhs: VReg;
}

export interface NotInstruction extends Instruction {
    readonly kind: 'not';
    readonly dest: VReg;
    readonly src: VReg;
}

export interface IsTrueCopyInstruction extends Instruction {
    readonly kind: 'istc';
    readonly dest: VReg;
    readonly src: VReg;
}

export interface IsFalseCopyInstruction extends Instruction {
    readonly kind: 'isfc';
    readonly dest: VReg;
    readonly src: VReg;
}

// ===== Control Flow =====

export interface LabelInstruction extends Instruction {
    readonly kind: 'label';
    readonly name: string;
}

export interface JmpInstruction extends Instruction {
    readonly kind: 'jmp';
    readonly target: string;
}

export interface BrInstruction extends Instruction {
    readonly kind: 'br';
    readonly condition: VReg;
    readonly trueLabel: string;
    readonly falseLabel: string;
}

export interface RetInstruction extends Instruction {
    readonly kind: 'ret';
    readonly values: VReg[];
    readonly types: IRType[];
}

export interface ExitInstruction extends Instruction {
    readonly kind: 'exit';
    readonly code: VReg;
}

// ===== Loops =====

export interface ForInitInstruction extends Instruction {
    readonly kind: 'for_init';
    readonly base: VReg;
    readonly init: VReg;
    readonly limit: VReg;
    readonly step: VReg;
    readonly exitLabel: string;
}

export interface ForLoopInstruction extends Instruction {
    readonly kind: 'for_loop';
    readonly base: VReg;
    readonly exitLabel: string;
}

// ===== Function Calls =====

export interface CallInstruction extends Instruction {
    readonly kind: 'call';
    readonly dests: VReg[];
    readonly func: string;
    readonly args: VReg[];
    readonly argTypes: IRType[];
    readonly retTypes: IRType[];
}

export interface CallMethodInstruction extends Instruction {
    readonly kind: 'call_method';
    readonly dests: VReg[];
    readonly object: VReg;
    readonly methodId: number;
    readonly args: VReg[];
    readonly argTypes: IRType[];
    readonly retTypes: IRType[];
}

export interface CallClosureInstruction extends Instruction {
    readonly kind: 'call_closure';
    readonly dests: VReg[];
    readonly closure: VReg;
    readonly args: VReg[];
    readonly argTypes: IRType[];
    readonly retTypes: IRType[];
}

export interface CallFFIInstruction extends Instruction {
    readonly kind: 'call_ffi';
    readonly dests: VReg[];
    readonly handle: VReg;
    readonly methodId: number;
    readonly args: VReg[];
    readonly argTypes: IRType[];
    readonly retTypes: IRType[];
}

// ===== Struct Operations =====

export interface StructAllocInstruction extends Instruction {
    readonly kind: 'struct_alloc';
    readonly dest: VReg;
    readonly typeId: string;
}

export interface StructGetInstruction extends Instruction {
    readonly kind: 'struct_get';
    readonly dest: VReg;
    readonly src: VReg;
    fieldId: number;  // Mutable: rewritten by field coloring pass (nameId → slot)
    readonly resultType: IRType;
}

export interface StructSetInstruction extends Instruction {
    readonly kind: 'struct_set';
    readonly struct: VReg;
    fieldId: number;  // Mutable: rewritten by field coloring pass (nameId → slot)
    readonly value: VReg;
    readonly valueType: IRType;
}

// ===== Class Operations =====

export interface ClassAllocInstruction extends Instruction {
    readonly kind: 'class_alloc';
    readonly dest: VReg;
    readonly typeId: string;
}

export interface ClassGetInstruction extends Instruction {
    readonly kind: 'class_get';
    readonly dest: VReg;
    readonly src: VReg;
    readonly fieldId: number;
    readonly resultType: IRType;
}

export interface ClassSetInstruction extends Instruction {
    readonly kind: 'class_set';
    readonly class: VReg;
    readonly fieldId: number;
    readonly value: VReg;
    readonly valueType: IRType;
}

export interface ClassGetMethodInstruction extends Instruction {
    readonly kind: 'class_get_method';
    readonly dest: VReg;
    readonly class: VReg;
    readonly methodId: number;
}

// ===== Interface Operations =====

export interface InterfaceIsClassInstruction extends Instruction {
    readonly kind: 'interface_is_class';
    readonly dest: VReg;
    readonly interface: VReg;
    readonly classId: number;
}

export interface InterfaceHasMethodInstruction extends Instruction {
    readonly kind: 'interface_has_method';
    readonly dest: VReg;
    readonly interface: VReg;
    readonly methodId: number;
}

// ===== Array Operations =====

export interface ArrayAllocInstruction extends Instruction {
    readonly kind: 'array_alloc';
    readonly dest: VReg;
    readonly elementType: IRType;
    readonly size: VReg;
}

export interface ArrayGetInstruction extends Instruction {
    readonly kind: 'array_get';
    readonly dest: VReg;
    readonly array: VReg;
    readonly index: VReg;
    readonly elementType: IRType;
}

export interface ArraySetInstruction extends Instruction {
    readonly kind: 'array_set';
    readonly array: VReg;
    readonly index: VReg;
    readonly value: VReg;
    readonly elementType: IRType;
}

export interface ArrayLengthInstruction extends Instruction {
    readonly kind: 'array_length';
    readonly dest: VReg;
    readonly array: VReg;
}

export interface ArrayExtendInstruction extends Instruction {
    readonly kind: 'array_extend';
    readonly array: VReg;
    readonly newSize: VReg;
}

export interface ArraySliceInstruction extends Instruction {
    readonly kind: 'array_slice';
    readonly dest: VReg;
    readonly array: VReg;
    readonly start: VReg;
    readonly end: VReg;
}

// ===== String Operations =====

export interface StrConstInstruction extends Instruction {
    readonly kind: 'str_const';
    readonly dest: VReg;
    readonly value: string;
}

export interface StrAllocEmptyInstruction extends Instruction {
    readonly kind: 'str_alloc_empty';
    readonly dest: VReg;
}

export interface StrConcatInstruction extends Instruction {
    readonly kind: 'str_concat';
    readonly dest: VReg;
    readonly str: VReg;
    readonly value: VReg;
    readonly valueType: IRType;
}

export interface StrFromBytesInstruction extends Instruction {
    readonly kind: 'str_from_bytes';
    readonly dest: VReg;
    readonly array: VReg;
}

// ===== Closure Operations =====

export interface ClosureAllocInstruction extends Instruction {
    readonly kind: 'closure_alloc';
    readonly dest: VReg;
    readonly funcName: string;
}

export interface ClosurePushEnvInstruction extends Instruction {
    readonly kind: 'closure_push_env';
    readonly closure: VReg;
    readonly value: VReg;
    readonly valueType: IRType;
}

export interface ClosureRetInstruction extends Instruction {
    readonly kind: 'closure_ret';
    readonly values: VReg[];
    readonly types: IRType[];
}

// ===== Coroutine Operations =====

export interface CoroAllocInstruction extends Instruction {
    readonly kind: 'coro_alloc';
    readonly dest: VReg;
    readonly funcName: string;
}

export interface CoroStateInstruction extends Instruction {
    readonly kind: 'coro_state';
    readonly dest: VReg;
    readonly coro: VReg;
}

export interface CoroCallInstruction extends Instruction {
    readonly kind: 'coro_call';
    readonly dests: VReg[];
    readonly coro: VReg;
    readonly args: VReg[];
    readonly argTypes: IRType[];
    readonly retTypes: IRType[];
}

export interface CoroYieldInstruction extends Instruction {
    readonly kind: 'coro_yield';
    readonly values: VReg[];
    readonly types: IRType[];
}

export interface CoroRetInstruction extends Instruction {
    readonly kind: 'coro_ret';
    readonly values: VReg[];
    readonly types: IRType[];
}

export interface CoroResetInstruction extends Instruction {
    readonly kind: 'coro_reset';
    readonly coro: VReg;
}

export interface CoroFinishInstruction extends Instruction {
    readonly kind: 'coro_finish';
    readonly coro: VReg;
}

// ===== Global Variables =====

export interface GlobalLoadInstruction extends Instruction {
    readonly kind: 'global_load';
    readonly dest: VReg;
    readonly globalId: string;
    readonly type: IRType;
}

export interface GlobalStoreInstruction extends Instruction {
    readonly kind: 'global_store';
    readonly globalId: string;
    readonly value: VReg;
    readonly type: IRType;
}

// ===== Type Conversion =====

export interface WidenInstruction extends Instruction {
    readonly kind: 'widen';
    readonly dest: VReg;
    readonly src: VReg;
    readonly from: IntType;
    readonly to: IntType;
}

export interface NarrowInstruction extends Instruction {
    readonly kind: 'narrow';
    readonly dest: VReg;
    readonly src: VReg;
    readonly from: IntType;
    readonly to: IntType;
}

export interface CastInstruction extends Instruction {
    readonly kind: 'cast';
    readonly dest: VReg;
    readonly src: VReg;
    readonly castKind: CastKind;
}

// ===== SSA =====

export interface PhiPair {
    readonly value: VReg;
    readonly fromLabel: string;
}

export interface PhiInstruction extends Instruction {
    readonly kind: 'phi';
    readonly dest: VReg;
    readonly pairs: PhiPair[];
    readonly type: IRType;
}

export interface UndefInstruction extends Instruction {
    readonly kind: 'undef';
    readonly dest: VReg;
    readonly type: IRType;
}

// ===== FFI =====

export interface FFIRegisterInstruction extends Instruction {
    readonly kind: 'ffi_register';
    readonly dest: VReg;
    readonly libName: string;
}

export interface FFICloseInstruction extends Instruction {
    readonly kind: 'ffi_close';
    readonly handle: VReg;
}

// ===== Exception =====

export interface ThrowInstruction extends Instruction {
    readonly kind: 'throw';
    readonly value: VReg;
}

// ===== Debug =====

export interface DebugInstruction extends Instruction {
    readonly kind: 'debug';
    readonly comment: string;
}

// ===== Union of All Instructions =====

export type IRInstruction =
    // Constants & Moves
    | ConstIntInstruction
    | ConstFloatInstruction
    | ConstBoolInstruction
    | ConstNullInstruction
    | MovInstruction
    // Arithmetic
    | AddInstruction
    | SubInstruction
    | MulInstruction
    | DivInstruction
    | ModInstruction
    | NegInstruction
    // Bitwise
    | ShlInstruction
    | ShrInstruction
    | BandInstruction
    | BorInstruction
    | BxorInstruction
    | BnotInstruction
    // Comparisons
    | CmpLtInstruction
    | CmpLeInstruction
    | CmpGtInstruction
    | CmpGeInstruction
    | CmpEqInstruction
    | CmpNeInstruction
    | CmpEqStrInstruction
    | CmpNeStrInstruction
    | IsNullInstruction
    | IsTrueInstruction
    | IsFalseInstruction
    // Logical
    | AndInstruction
    | OrInstruction
    | NotInstruction
    | IsTrueCopyInstruction
    | IsFalseCopyInstruction
    // Control Flow
    | LabelInstruction
    | JmpInstruction
    | BrInstruction
    | RetInstruction
    | ExitInstruction
    // Loops
    | ForInitInstruction
    | ForLoopInstruction
    // Function Calls
    | CallInstruction
    | CallMethodInstruction
    | CallClosureInstruction
    | CallFFIInstruction
    // Struct
    | StructAllocInstruction
    | StructGetInstruction
    | StructSetInstruction
    // Class
    | ClassAllocInstruction
    | ClassGetInstruction
    | ClassSetInstruction
    | ClassGetMethodInstruction
    // Interface
    | InterfaceIsClassInstruction
    | InterfaceHasMethodInstruction
    // Array
    | ArrayAllocInstruction
    | ArrayGetInstruction
    | ArraySetInstruction
    | ArrayLengthInstruction
    | ArrayExtendInstruction
    | ArraySliceInstruction
    // String
    | StrConstInstruction
    | StrAllocEmptyInstruction
    | StrConcatInstruction
    | StrFromBytesInstruction
    // Closure
    | ClosureAllocInstruction
    | ClosurePushEnvInstruction
    | ClosureRetInstruction
    // Coroutine
    | CoroAllocInstruction
    | CoroStateInstruction
    | CoroCallInstruction
    | CoroYieldInstruction
    | CoroRetInstruction
    | CoroResetInstruction
    | CoroFinishInstruction
    // Globals
    | GlobalLoadInstruction
    | GlobalStoreInstruction
    // Type Conversion
    | WidenInstruction
    | NarrowInstruction
    | CastInstruction
    // SSA
    | PhiInstruction
    | UndefInstruction
    // FFI
    | FFIRegisterInstruction
    | FFICloseInstruction
    // Exception
    | ThrowInstruction
    // Debug
    | DebugInstruction;
