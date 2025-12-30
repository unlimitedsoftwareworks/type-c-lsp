/**
 * LIR Instruction definitions
 * All instruction types supported by the IR
 */

import  {
    DataType,
    Literal,
    BinaryOp,
    UnaryOp,
    NoArgOp,
    CastType,
    IntType,
    StringConcatType
} from './types.js';

// ===== Base Instruction Interface =====

export interface Instruction {
    readonly kind: string;
}

// ===== Label Instruction =====

export interface LabelInstruction extends Instruction {
    readonly kind: 'label';
    readonly name: string;
}

// ===== Constant Instruction =====

export interface ConstInstruction extends Instruction {
    readonly kind: 'const';
    readonly dest: string;
    readonly type?: DataType;
    readonly value: Literal;
}

// ===== Binary Operation =====

export interface BinaryOpInstruction extends Instruction {
    readonly kind: 'binary_op';
    readonly dest: string;
    readonly type?: DataType;
    readonly op: BinaryOp;
    readonly arg1: string;
    readonly arg2: string;
}

// ===== Unary Operation =====

export interface UnaryOpInstruction extends Instruction {
    readonly kind: 'unary_op';
    readonly dest: string;
    readonly type?: DataType;
    readonly op: UnaryOp;
    readonly arg: string;
}

// ===== Memory Operations =====

export interface AllocInstruction extends Instruction {
    readonly kind: 'alloc';
    readonly dest: string;
    readonly type?: DataType;
    readonly size: string;
}

// ===== Control Flow =====

export interface CallInstruction extends Instruction {
    readonly kind: 'call';
    readonly dest?: string;
    readonly type?: DataType;
    readonly func: string;
    readonly args: string[];
}

export interface JumpInstruction extends Instruction {
    readonly kind: 'jmp';
    readonly label: string;
}

export interface BranchInstruction extends Instruction {
    readonly kind: 'br';
    readonly condition: string;
    readonly trueLabel: string;
    readonly falseLabel: string;
}

export interface ReturnInstruction extends Instruction {
    readonly kind: 'ret';
    readonly value?: string;
}

export interface ExitInstruction extends Instruction {
    readonly kind: 'exit';
    readonly code: string;
}

// ===== Loop Operations =====

export interface ForInitInstruction extends Instruction {
    readonly kind: 'fori';
    readonly loopStart: string;
    readonly initial: string;
    readonly dest: string;
    readonly step: string;
    readonly loopEnd: string;
}

export interface ForLoopInstruction extends Instruction {
    readonly kind: 'forl';
    readonly loopStart: string;
    readonly initial: string;
    readonly dest: string;
    readonly step: string;
    readonly loopEnd: string;
}

// ===== SSA Operations =====

export interface PhiPair {
    readonly arg: string;
    readonly label: string;
}

export interface PhiInstruction extends Instruction {
    readonly kind: 'phi';
    readonly dest: string;
    readonly type?: DataType;
    readonly pairs: PhiPair[];
}

export interface SetInstruction extends Instruction {
    readonly kind: 'set';
    readonly dest: string;
    readonly source: string;
}

export interface GetInstruction extends Instruction {
    readonly kind: 'get';
    readonly dest: string;
    readonly type?: DataType;
}

export interface UndefInstruction extends Instruction {
    readonly kind: 'undef';
    readonly dest: string;
    readonly type?: DataType;
}

// ===== Speculation =====

export interface GuardInstruction extends Instruction {
    readonly kind: 'guard';
    readonly condition: string;
    readonly label: string;
}

// ===== Miscellaneous =====

export interface PrintInstruction extends Instruction {
    readonly kind: 'print';
    readonly args: string[];
}

export interface NoArgInstruction extends Instruction {
    readonly kind: 'no_arg';
    readonly op: NoArgOp;
}

// ===== Global Variables =====

export interface GlobalLoadInstruction extends Instruction {
    readonly kind: 'global_load';
    readonly dest: string;
    readonly type?: DataType;
    readonly globalId: string;
}

export interface GlobalStoreInstruction extends Instruction {
    readonly kind: 'global_store';
    readonly globalId: string;
    readonly value: string;
}

// ===== Type Conversion =====

export interface WidenInstruction extends Instruction {
    readonly kind: 'widen';
    readonly dest: string;
    readonly type?: DataType;
    readonly sourceType: IntType;
    readonly targetType: IntType;
    readonly value: string;
}

export interface NarrowInstruction extends Instruction {
    readonly kind: 'narrow';
    readonly dest: string;
    readonly type?: DataType;
    readonly sourceType: IntType;
    readonly targetType: IntType;
    readonly value: string;
}

export interface CastInstruction extends Instruction {
    readonly kind: 'cast';
    readonly dest: string;
    readonly type?: DataType;
    readonly targetType: CastType;
    readonly value: string;
}

// ===== String Operations =====

export interface StringAllocInstruction extends Instruction {
    readonly kind: 'str_alloc';
    readonly dest: string;
    readonly type?: DataType;
}

export interface StringConcatInstruction extends Instruction {
    readonly kind: 'str_concat';
    readonly dest: string;
    readonly type?: DataType;
    readonly src: string;
    readonly valueType: StringConcatType;
    readonly value: string;
}

export interface StringAllocFromBytesInstruction extends Instruction {
    readonly kind: 'str_from_bytes';
    readonly dest: string;
    readonly type?: DataType;
    readonly array: string;
}

// ===== Copy Operations =====

export interface IsTrueCopyInstruction extends Instruction {
    readonly kind: 'istc';
    readonly dest: string;
    readonly type?: DataType;
    readonly src: string;
}

export interface IsFalseCopyInstruction extends Instruction {
    readonly kind: 'isfc';
    readonly dest: string;
    readonly type?: DataType;
    readonly src: string;
}

// ===== Struct Operations =====

export interface StructAllocInstruction extends Instruction {
    readonly kind: 'struct_alloc';
    readonly dest: string;
    readonly type?: DataType;
    readonly typeId: string;
}

export interface StructGetInstruction extends Instruction {
    readonly kind: 'struct_get';
    readonly dest: string;
    readonly type?: DataType;
    readonly struct: string;
    readonly fieldId: string;
}

export interface StructSetInstruction extends Instruction {
    readonly kind: 'struct_set';
    readonly struct: string;
    readonly fieldId: string;
    readonly value: string;
}

// ===== Class Operations =====

export interface ClassAllocInstruction extends Instruction {
    readonly kind: 'class_alloc';
    readonly dest: string;
    readonly type?: DataType;
    readonly typeId: string;
}

export interface ClassGetInstruction extends Instruction {
    readonly kind: 'class_get';
    readonly dest: string;
    readonly type?: DataType;
    readonly class: string;
    readonly fieldId: string;
}

export interface ClassSetInstruction extends Instruction {
    readonly kind: 'class_set';
    readonly class: string;
    readonly fieldId: string;
    readonly value: string;
}

export interface ClassGetMethodInstruction extends Instruction {
    readonly kind: 'class_get_method';
    readonly dest: string;
    readonly type?: DataType;
    readonly class: string;
    readonly methodId: string;
}

// ===== Interface Operations =====

export interface InterfaceIsInstruction extends Instruction {
    readonly kind: 'interface_is';
    readonly interface: string;
    readonly classId: string;
}

export interface InterfaceHasMethodInstruction extends Instruction {
    readonly kind: 'interface_has_method';
    readonly interface: string;
    readonly methodId: string;
}

// ===== Array Operations =====

export interface ArrayAllocInstruction extends Instruction {
    readonly kind: 'array_alloc';
    readonly dest: string;
    readonly type?: DataType;
    readonly elementType: DataType;
    readonly size: string;
}

export interface ArrayLengthInstruction extends Instruction {
    readonly kind: 'array_length';
    readonly dest: string;
    readonly type?: DataType;
    readonly array: string;
}

export interface ArrayExtendInstruction extends Instruction {
    readonly kind: 'array_extend';
    readonly array: string;
    readonly newSize: string;
}

export interface ArraySliceInstruction extends Instruction {
    readonly kind: 'array_slice';
    readonly dest: string;
    readonly type?: DataType;
    readonly array: string;
    readonly start: string;
    readonly end: string;
}

export interface ArrayGetInstruction extends Instruction {
    readonly kind: 'array_get';
    readonly dest: string;
    readonly type?: DataType;
    readonly array: string;
    readonly index: string;
}

export interface ArraySetInstruction extends Instruction {
    readonly kind: 'array_set';
    readonly array: string;
    readonly index: string;
    readonly value: string;
}

// ===== Closure Operations =====

export interface ClosureAllocInstruction extends Instruction {
    readonly kind: 'closure_alloc';
    readonly dest: string;
    readonly type?: DataType;
    readonly func: string;
}

export interface ClosurePushEnvInstruction extends Instruction {
    readonly kind: 'closure_push_env';
    readonly closure: string;
    readonly value: string;
}

export interface ClosureCallInstruction extends Instruction {
    readonly kind: 'closure_call';
    readonly dest?: string;
    readonly type?: DataType;
    readonly closure: string;
    readonly args: string[];
}

export interface ClosureReturnInstruction extends Instruction {
    readonly kind: 'closure_return';
    readonly value?: string;
}

// ===== Coroutine Operations =====

export interface CoroAllocInstruction extends Instruction {
    readonly kind: 'coro_alloc';
    readonly dest: string;
    readonly type?: DataType;
    readonly func: string;
}

export interface CoroStateInstruction extends Instruction {
    readonly kind: 'coro_state';
    readonly dest: string;
    readonly type?: DataType;
    readonly coro: string;
}

export interface CoroCallInstruction extends Instruction {
    readonly kind: 'coro_call';
    readonly dest?: string;
    readonly type?: DataType;
    readonly coro: string;
    readonly args: string[];
}

export interface CoroYieldInstruction extends Instruction {
    readonly kind: 'coro_yield';
    readonly value?: string;
}

export interface CoroReturnInstruction extends Instruction {
    readonly kind: 'coro_return';
    readonly value?: string;
}

export interface CoroResetInstruction extends Instruction {
    readonly kind: 'coro_reset';
    readonly coro: string;
}

export interface CoroFinishInstruction extends Instruction {
    readonly kind: 'coro_finish';
    readonly coro: string;
}

// ===== FFI Operations =====

export interface FFIRegisterInstruction extends Instruction {
    readonly kind: 'ffi_register';
    readonly libname: string;
    readonly id: number;
}

export interface FFICallInstruction extends Instruction {
    readonly kind: 'ffi_call';
    readonly dest?: string;
    readonly type?: DataType;
    readonly handle: string;
    readonly args: string[];
}

export interface FFICloseInstruction extends Instruction {
    readonly kind: 'ffi_close';
    readonly handle: string;
}

// ===== Exception Handling =====

export interface ThrowInstruction extends Instruction {
    readonly kind: 'throw';
    readonly value: string;
}

export interface DebugInstruction extends Instruction {
    readonly kind: 'debug';
    readonly comment: string;
}