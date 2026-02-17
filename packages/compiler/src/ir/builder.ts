/**
 * Type-C IR Builder API
 *
 * Fluent API for constructing typed IR programs.
 * Every instruction method returns `this` for chaining.
 */

import type {
    IRType,
    IntType,
    FloatType,
    NumericType,
    CmpType,
    CastKind
} from './types.js';

import type {
    IRInstruction,
    VReg,
    PhiPair
} from './instructions.js';

// ===== Function Parameter =====

export interface FunctionParam {
    readonly name: string;
    readonly type: IRType;
}

// ===== Program-Level Metadata =====

export interface StructFieldShape {
    globalFieldId: number;  // Mutable: rewritten by coloring (nameId → slot)
    readonly type: IRType;
    readonly name: string;
}

export interface StructShape {
    readonly id: string;
    readonly fields: StructFieldShape[];
}

export interface ClassFieldShape {
    readonly localFieldId: number;
    readonly type: IRType;
    readonly name: string;
}

export interface ClassMethodShape {
    readonly methodId: number;
    readonly name: string;
    readonly funcName: string;
}

export interface ClassShape {
    readonly id: string;
    readonly uid: number;
    readonly fields: ClassFieldShape[];
    readonly methods: ClassMethodShape[];
    readonly implementedInterfaces: string[];
}

export interface GlobalDecl {
    readonly id: string;
    readonly type: IRType;
    readonly initializer?: string;
}

// ===== IR Function =====

export class IRFunction {
    readonly name: string;
    readonly params: FunctionParam[];
    readonly returnTypes: IRType[];
    readonly isCoroutine: boolean;
    readonly isClosure: boolean;
    readonly instructions: IRInstruction[] = [];

    constructor(
        name: string,
        params: FunctionParam[] = [],
        returnTypes: IRType[] = [],
        options?: { isCoroutine?: boolean; isClosure?: boolean }
    ) {
        this.name = name;
        this.params = params;
        this.returnTypes = returnTypes;
        this.isCoroutine = options?.isCoroutine ?? false;
        this.isClosure = options?.isClosure ?? false;
    }

    // ===== Constants & Moves =====

    constInt(dest: VReg, value: bigint | number, intType: IntType): this {
        this.instructions.push({
            kind: 'const_int',
            dest,
            value: typeof value === 'number' ? BigInt(value) : value,
            intType
        });
        return this;
    }

    constFloat(dest: VReg, value: number, floatType: FloatType): this {
        this.instructions.push({ kind: 'const_float', dest, value, floatType });
        return this;
    }

    constBool(dest: VReg, value: boolean): this {
        this.instructions.push({ kind: 'const_bool', dest, value });
        return this;
    }

    constNull(dest: VReg): this {
        this.instructions.push({ kind: 'const_null', dest });
        return this;
    }

    mov(dest: VReg, src: VReg, type: IRType): this {
        this.instructions.push({ kind: 'mov', dest, src, type });
        return this;
    }

    // ===== Arithmetic =====

    add(dest: VReg, lhs: VReg, rhs: VReg, numType: NumericType): this {
        this.instructions.push({ kind: 'add', dest, lhs, rhs, numType });
        return this;
    }

    sub(dest: VReg, lhs: VReg, rhs: VReg, numType: NumericType): this {
        this.instructions.push({ kind: 'sub', dest, lhs, rhs, numType });
        return this;
    }

    mul(dest: VReg, lhs: VReg, rhs: VReg, numType: NumericType): this {
        this.instructions.push({ kind: 'mul', dest, lhs, rhs, numType });
        return this;
    }

    div(dest: VReg, lhs: VReg, rhs: VReg, numType: NumericType): this {
        this.instructions.push({ kind: 'div', dest, lhs, rhs, numType });
        return this;
    }

    mod(dest: VReg, lhs: VReg, rhs: VReg, numType: NumericType): this {
        this.instructions.push({ kind: 'mod', dest, lhs, rhs, numType });
        return this;
    }

    neg(dest: VReg, src: VReg, numType: NumericType): this {
        this.instructions.push({ kind: 'neg', dest, src, numType });
        return this;
    }

    // ===== Bitwise =====

    shl(dest: VReg, lhs: VReg, rhs: VReg): this {
        this.instructions.push({ kind: 'shl', dest, lhs, rhs });
        return this;
    }

    shr(dest: VReg, lhs: VReg, rhs: VReg, signed: boolean): this {
        this.instructions.push({ kind: 'shr', dest, lhs, rhs, signed });
        return this;
    }

    band(dest: VReg, lhs: VReg, rhs: VReg): this {
        this.instructions.push({ kind: 'band', dest, lhs, rhs });
        return this;
    }

    bor(dest: VReg, lhs: VReg, rhs: VReg): this {
        this.instructions.push({ kind: 'bor', dest, lhs, rhs });
        return this;
    }

    bxor(dest: VReg, lhs: VReg, rhs: VReg): this {
        this.instructions.push({ kind: 'bxor', dest, lhs, rhs });
        return this;
    }

    bnot(dest: VReg, src: VReg): this {
        this.instructions.push({ kind: 'bnot', dest, src });
        return this;
    }

    // ===== Comparisons =====

    cmpLt(dest: VReg, lhs: VReg, rhs: VReg, cmpType: NumericType): this {
        this.instructions.push({ kind: 'cmp_lt', dest, lhs, rhs, cmpType });
        return this;
    }

    cmpLe(dest: VReg, lhs: VReg, rhs: VReg, cmpType: NumericType): this {
        this.instructions.push({ kind: 'cmp_le', dest, lhs, rhs, cmpType });
        return this;
    }

    cmpGt(dest: VReg, lhs: VReg, rhs: VReg, cmpType: NumericType): this {
        this.instructions.push({ kind: 'cmp_gt', dest, lhs, rhs, cmpType });
        return this;
    }

    cmpGe(dest: VReg, lhs: VReg, rhs: VReg, cmpType: NumericType): this {
        this.instructions.push({ kind: 'cmp_ge', dest, lhs, rhs, cmpType });
        return this;
    }

    cmpEq(dest: VReg, lhs: VReg, rhs: VReg, cmpType: CmpType): this {
        this.instructions.push({ kind: 'cmp_eq', dest, lhs, rhs, cmpType });
        return this;
    }

    cmpNe(dest: VReg, lhs: VReg, rhs: VReg, cmpType: CmpType): this {
        this.instructions.push({ kind: 'cmp_ne', dest, lhs, rhs, cmpType });
        return this;
    }

    cmpEqStr(dest: VReg, lhs: VReg, rhs: VReg): this {
        this.instructions.push({ kind: 'cmp_eq_str', dest, lhs, rhs });
        return this;
    }

    cmpNeStr(dest: VReg, lhs: VReg, rhs: VReg): this {
        this.instructions.push({ kind: 'cmp_ne_str', dest, lhs, rhs });
        return this;
    }

    isNull(dest: VReg, src: VReg): this {
        this.instructions.push({ kind: 'is_null', dest, src });
        return this;
    }

    isTrue(dest: VReg, src: VReg): this {
        this.instructions.push({ kind: 'is_true', dest, src });
        return this;
    }

    isFalse(dest: VReg, src: VReg): this {
        this.instructions.push({ kind: 'is_false', dest, src });
        return this;
    }

    // ===== Logical =====

    and(dest: VReg, lhs: VReg, rhs: VReg): this {
        this.instructions.push({ kind: 'and', dest, lhs, rhs });
        return this;
    }

    or(dest: VReg, lhs: VReg, rhs: VReg): this {
        this.instructions.push({ kind: 'or', dest, lhs, rhs });
        return this;
    }

    not(dest: VReg, src: VReg): this {
        this.instructions.push({ kind: 'not', dest, src });
        return this;
    }

    istc(dest: VReg, src: VReg): this {
        this.instructions.push({ kind: 'istc', dest, src });
        return this;
    }

    isfc(dest: VReg, src: VReg): this {
        this.instructions.push({ kind: 'isfc', dest, src });
        return this;
    }

    // ===== Control Flow =====

    label(name: string): this {
        this.instructions.push({ kind: 'label', name });
        return this;
    }

    jmp(target: string): this {
        this.instructions.push({ kind: 'jmp', target });
        return this;
    }

    br(condition: VReg, trueLabel: string, falseLabel: string): this {
        this.instructions.push({ kind: 'br', condition, trueLabel, falseLabel });
        return this;
    }

    ret(values: VReg[] = [], types: IRType[] = []): this {
        this.instructions.push({ kind: 'ret', values, types });
        return this;
    }

    exit(code: VReg): this {
        this.instructions.push({ kind: 'exit', code });
        return this;
    }

    // ===== Loops =====

    forInit(base: VReg, init: VReg, limit: VReg, step: VReg, exitLabel: string): this {
        this.instructions.push({ kind: 'for_init', base, init, limit, step, exitLabel });
        return this;
    }

    forLoop(base: VReg, exitLabel: string): this {
        this.instructions.push({ kind: 'for_loop', base, exitLabel });
        return this;
    }

    // ===== Function Calls =====

    call(
        dests: VReg[],
        func: string,
        args: VReg[],
        argTypes: IRType[],
        retTypes: IRType[]
    ): this {
        this.instructions.push({ kind: 'call', dests, func, args, argTypes, retTypes });
        return this;
    }

    callMethod(
        dests: VReg[],
        object: VReg,
        methodId: number,
        args: VReg[],
        argTypes: IRType[],
        retTypes: IRType[]
    ): this {
        this.instructions.push({
            kind: 'call_method', dests, object, methodId, args, argTypes, retTypes
        });
        return this;
    }

    callClosure(
        dests: VReg[],
        closure: VReg,
        args: VReg[],
        argTypes: IRType[],
        retTypes: IRType[]
    ): this {
        this.instructions.push({
            kind: 'call_closure', dests, closure, args, argTypes, retTypes
        });
        return this;
    }

    callFFI(
        dests: VReg[],
        handle: VReg,
        methodId: number,
        args: VReg[],
        argTypes: IRType[],
        retTypes: IRType[]
    ): this {
        this.instructions.push({
            kind: 'call_ffi', dests, handle, methodId, args, argTypes, retTypes
        });
        return this;
    }

    // ===== Struct Operations =====

    structAlloc(dest: VReg, typeId: string): this {
        this.instructions.push({ kind: 'struct_alloc', dest, typeId });
        return this;
    }

    structGet(dest: VReg, src: VReg, fieldId: number, resultType: IRType): this {
        this.instructions.push({ kind: 'struct_get', dest, src, fieldId, resultType });
        return this;
    }

    structSet(struct: VReg, fieldId: number, value: VReg, valueType: IRType): this {
        this.instructions.push({ kind: 'struct_set', struct, fieldId, value, valueType });
        return this;
    }

    // ===== Class Operations =====

    classAlloc(dest: VReg, typeId: string): this {
        this.instructions.push({ kind: 'class_alloc', dest, typeId });
        return this;
    }

    classGet(dest: VReg, src: VReg, fieldId: number, resultType: IRType): this {
        this.instructions.push({ kind: 'class_get', dest, src, fieldId, resultType });
        return this;
    }

    classSet(classReg: VReg, fieldId: number, value: VReg, valueType: IRType): this {
        this.instructions.push({
            kind: 'class_set', class: classReg, fieldId, value, valueType
        });
        return this;
    }

    classGetMethod(dest: VReg, classReg: VReg, methodId: number): this {
        this.instructions.push({
            kind: 'class_get_method', dest, class: classReg, methodId
        });
        return this;
    }

    // ===== Interface Operations =====

    interfaceIsClass(dest: VReg, interfaceReg: VReg, classId: number): this {
        this.instructions.push({
            kind: 'interface_is_class', dest, interface: interfaceReg, classId
        });
        return this;
    }

    interfaceHasMethod(dest: VReg, interfaceReg: VReg, methodId: number): this {
        this.instructions.push({
            kind: 'interface_has_method', dest, interface: interfaceReg, methodId
        });
        return this;
    }

    // ===== Array Operations =====

    arrayAlloc(dest: VReg, elementType: IRType, size: VReg): this {
        this.instructions.push({ kind: 'array_alloc', dest, elementType, size });
        return this;
    }

    arrayGet(dest: VReg, array: VReg, index: VReg, elementType: IRType): this {
        this.instructions.push({ kind: 'array_get', dest, array, index, elementType });
        return this;
    }

    arraySet(array: VReg, index: VReg, value: VReg, elementType: IRType): this {
        this.instructions.push({ kind: 'array_set', array, index, value, elementType });
        return this;
    }

    arrayLength(dest: VReg, array: VReg): this {
        this.instructions.push({ kind: 'array_length', dest, array });
        return this;
    }

    arrayExtend(array: VReg, newSize: VReg): this {
        this.instructions.push({ kind: 'array_extend', array, newSize });
        return this;
    }

    arraySlice(dest: VReg, array: VReg, start: VReg, end: VReg): this {
        this.instructions.push({ kind: 'array_slice', dest, array, start, end });
        return this;
    }

    // ===== String Operations =====

    strConst(dest: VReg, value: string): this {
        this.instructions.push({ kind: 'str_const', dest, value });
        return this;
    }

    strAllocEmpty(dest: VReg): this {
        this.instructions.push({ kind: 'str_alloc_empty', dest });
        return this;
    }

    strConcat(dest: VReg, str: VReg, value: VReg, valueType: IRType): this {
        this.instructions.push({ kind: 'str_concat', dest, str, value, valueType });
        return this;
    }

    strFromBytes(dest: VReg, array: VReg): this {
        this.instructions.push({ kind: 'str_from_bytes', dest, array });
        return this;
    }

    // ===== Closure Operations =====

    closureAlloc(dest: VReg, funcName: string): this {
        this.instructions.push({ kind: 'closure_alloc', dest, funcName });
        return this;
    }

    closurePushEnv(closure: VReg, value: VReg, valueType: IRType): this {
        this.instructions.push({ kind: 'closure_push_env', closure, value, valueType });
        return this;
    }

    closureRet(values: VReg[] = [], types: IRType[] = []): this {
        this.instructions.push({ kind: 'closure_ret', values, types });
        return this;
    }

    // ===== Coroutine Operations =====

    coroAlloc(dest: VReg, funcName: string): this {
        this.instructions.push({ kind: 'coro_alloc', dest, funcName });
        return this;
    }

    coroState(dest: VReg, coro: VReg): this {
        this.instructions.push({ kind: 'coro_state', dest, coro });
        return this;
    }

    coroCall(
        dests: VReg[],
        coro: VReg,
        args: VReg[],
        argTypes: IRType[],
        retTypes: IRType[]
    ): this {
        this.instructions.push({
            kind: 'coro_call', dests, coro, args, argTypes, retTypes
        });
        return this;
    }

    coroYield(values: VReg[] = [], types: IRType[] = []): this {
        this.instructions.push({ kind: 'coro_yield', values, types });
        return this;
    }

    coroRet(values: VReg[] = [], types: IRType[] = []): this {
        this.instructions.push({ kind: 'coro_ret', values, types });
        return this;
    }

    coroReset(coro: VReg): this {
        this.instructions.push({ kind: 'coro_reset', coro });
        return this;
    }

    coroFinish(coro: VReg): this {
        this.instructions.push({ kind: 'coro_finish', coro });
        return this;
    }

    // ===== Global Variables =====

    globalLoad(dest: VReg, globalId: string, type: IRType): this {
        this.instructions.push({ kind: 'global_load', dest, globalId, type });
        return this;
    }

    globalStore(globalId: string, value: VReg, type: IRType): this {
        this.instructions.push({ kind: 'global_store', globalId, value, type });
        return this;
    }

    // ===== Type Conversion =====

    widen(dest: VReg, src: VReg, from: IntType, to: IntType): this {
        this.instructions.push({ kind: 'widen', dest, src, from, to });
        return this;
    }

    narrow(dest: VReg, src: VReg, from: IntType, to: IntType): this {
        this.instructions.push({ kind: 'narrow', dest, src, from, to });
        return this;
    }

    cast(dest: VReg, src: VReg, castKind: CastKind): this {
        this.instructions.push({ kind: 'cast', dest, src, castKind });
        return this;
    }

    // ===== SSA =====

    phi(dest: VReg, pairs: PhiPair[], type: IRType): this {
        this.instructions.push({ kind: 'phi', dest, pairs, type });
        return this;
    }

    undef(dest: VReg, type: IRType): this {
        this.instructions.push({ kind: 'undef', dest, type });
        return this;
    }

    // ===== FFI =====

    ffiRegister(dest: VReg, libName: string): this {
        this.instructions.push({ kind: 'ffi_register', dest, libName });
        return this;
    }

    ffiClose(handle: VReg): this {
        this.instructions.push({ kind: 'ffi_close', handle });
        return this;
    }

    // ===== Exception =====

    throw(value: VReg): this {
        this.instructions.push({ kind: 'throw', value });
        return this;
    }

    // ===== Debug =====

    debug(comment: string): this {
        this.instructions.push({ kind: 'debug', comment });
        return this;
    }
}

// ===== IR Program =====

export class IRProgram {
    readonly functions: IRFunction[] = [];
    readonly structShapes: StructShape[] = [];
    readonly classShapes: ClassShape[] = [];
    readonly globals: GlobalDecl[] = [];
    readonly stringConstants: string[] = [];
    entryFunction: string = '';
    /** Set by field coloring pass — total number of colored slots */
    numFieldSlots: number = 0;

    createFunction(
        name: string,
        params: FunctionParam[] = [],
        returnTypes: IRType[] = [],
        options?: { isCoroutine?: boolean; isClosure?: boolean }
    ): IRFunction {
        const func = new IRFunction(name, params, returnTypes, options);
        this.functions.push(func);
        return func;
    }

    addFunction(func: IRFunction): this {
        this.functions.push(func);
        return this;
    }

    declareStruct(shape: StructShape): void {
        this.structShapes.push(shape);
    }

    declareClass(shape: ClassShape): void {
        this.classShapes.push(shape);
    }

    declareGlobal(decl: GlobalDecl): void {
        this.globals.push(decl);
    }

    addStringConstant(value: string): number {
        const existing = this.stringConstants.indexOf(value);
        if (existing >= 0) return existing;
        this.stringConstants.push(value);
        return this.stringConstants.length - 1;
    }
}
