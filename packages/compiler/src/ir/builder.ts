/**
 * LIR Builder API
 * Fluent API for constructing LIR programs
 */

import {
    DataType,
    Literal,
    BinaryOp,
    UnaryOp,
    NoArgOp,
    CastType,
    IntType,
    StringConcatType
} from './types.js';

import {
    Instruction,
    LabelInstruction,
    ConstInstruction,
    BinaryOpInstruction,
    UnaryOpInstruction,
    AllocInstruction,
    CallInstruction,
    JumpInstruction,
    BranchInstruction,
    ReturnInstruction,
    ExitInstruction,
    ForInitInstruction,
    ForLoopInstruction,
    PhiInstruction,
    PhiPair,
    SetInstruction,
    GetInstruction,
    UndefInstruction,
    GuardInstruction,
    PrintInstruction,
    NoArgInstruction,
    GlobalLoadInstruction,
    GlobalStoreInstruction,
    WidenInstruction,
    NarrowInstruction,
    CastInstruction,
    StringAllocInstruction,
    StringConcatInstruction,
    StringAllocFromBytesInstruction,
    IsTrueCopyInstruction,
    IsFalseCopyInstruction,
    StructAllocInstruction,
    StructGetInstruction,
    StructSetInstruction,
    ClassAllocInstruction,
    ClassGetInstruction,
    ClassSetInstruction,
    ClassGetMethodInstruction,
    InterfaceIsInstruction,
    InterfaceHasMethodInstruction,
    ArrayAllocInstruction,
    ArrayLengthInstruction,
    ArrayExtendInstruction,
    ArraySliceInstruction,
    ArrayGetInstruction,
    ArraySetInstruction,
    ClosureAllocInstruction,
    ClosurePushEnvInstruction,
    ClosureCallInstruction,
    ClosureReturnInstruction,
    CoroAllocInstruction,
    CoroStateInstruction,
    CoroCallInstruction,
    CoroYieldInstruction,
    CoroReturnInstruction,
    CoroResetInstruction,
    CoroFinishInstruction,
    FFIRegisterInstruction,
    FFICallInstruction,
    FFICloseInstruction,
    ThrowInstruction
} from './instructions.js';

// ===== Function Argument =====

export interface FunctionArg {
    readonly name: string;
    readonly type?: DataType;
}

// ===== Function =====

export class LIRFunction {
    readonly name: string;
    readonly args: FunctionArg[];
    readonly returnType?: DataType;
    readonly instructions: Instruction[] = [];

    constructor(name: string, args: FunctionArg[] = [], returnType?: DataType) {
        this.name = name;
        this.args = args;
        this.returnType = returnType;
    }

    // ===== Label =====

    label(name: string): this {
        const instruction: LabelInstruction = {
            kind: 'label',
            name
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Const =====

    const(dest: string, value: Literal, type?: DataType): this {
        const instruction: ConstInstruction = {
            kind: 'const',
            dest,
            type,
            value
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Binary Operations =====

    binaryOp(dest: string, op: BinaryOp, arg1: string, arg2: string, type?: DataType): this {
        const instruction: BinaryOpInstruction = {
            kind: 'binary_op',
            dest,
            type,
            op,
            arg1,
            arg2
        };
        this.instructions.push(instruction);
        return this;
    }

    add(dest: string, arg1: string, arg2: string, type?: DataType): this {
        return this.binaryOp(dest, 'add', arg1, arg2, type);
    }

    sub(dest: string, arg1: string, arg2: string, type?: DataType): this {
        return this.binaryOp(dest, 'sub', arg1, arg2, type);
    }

    mul(dest: string, arg1: string, arg2: string, type?: DataType): this {
        return this.binaryOp(dest, 'mul', arg1, arg2, type);
    }

    div(dest: string, arg1: string, arg2: string, type?: DataType): this {
        return this.binaryOp(dest, 'div', arg1, arg2, type);
    }

    mod(dest: string, arg1: string, arg2: string, type?: DataType): this {
        return this.binaryOp(dest, 'mod', arg1, arg2, type);
    }

    // ===== Unary Operations =====

    unaryOp(dest: string, op: UnaryOp, arg: string, type?: DataType): this {
        const instruction: UnaryOpInstruction = {
            kind: 'unary_op',
            dest,
            type,
            op,
            arg
        };
        this.instructions.push(instruction);
        return this;
    }

    not(dest: string, arg: string, type?: DataType): this {
        return this.unaryOp(dest, 'not', arg, type);
    }

    neg(dest: string, arg: string, type?: DataType): this {
        return this.unaryOp(dest, 'neg', arg, type);
    }

    // ===== Memory Operations =====

    alloc(dest: string, size: string, type?: DataType): this {
        const instruction: AllocInstruction = {
            kind: 'alloc',
            dest,
            type,
            size
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Control Flow =====

    call(func: string, args: string[] = [], dest?: string, type?: DataType): this {
        const instruction: CallInstruction = {
            kind: 'call',
            dest,
            type,
            func,
            args
        };
        this.instructions.push(instruction);
        return this;
    }

    jmp(label: string): this {
        const instruction: JumpInstruction = {
            kind: 'jmp',
            label
        };
        this.instructions.push(instruction);
        return this;
    }

    br(condition: string, trueLabel: string, falseLabel: string): this {
        const instruction: BranchInstruction = {
            kind: 'br',
            condition,
            trueLabel,
            falseLabel
        };
        this.instructions.push(instruction);
        return this;
    }

    ret(value?: string): this {
        const instruction: ReturnInstruction = {
            kind: 'ret',
            value
        };
        this.instructions.push(instruction);
        return this;
    }

    exit(code: string): this {
        const instruction: ExitInstruction = {
            kind: 'exit',
            code
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Loop Operations =====

    fori(loopStart: string, initial: string, dest: string, step: string, loopEnd: string): this {
        const instruction: ForInitInstruction = {
            kind: 'fori',
            loopStart,
            initial,
            dest,
            step,
            loopEnd
        };
        this.instructions.push(instruction);
        return this;
    }

    forl(loopStart: string, initial: string, dest: string, step: string, loopEnd: string): this {
        const instruction: ForLoopInstruction = {
            kind: 'forl',
            loopStart,
            initial,
            dest,
            step,
            loopEnd
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== SSA Operations =====

    phi(dest: string, pairs: PhiPair[], type?: DataType): this {
        const instruction: PhiInstruction = {
            kind: 'phi',
            dest,
            type,
            pairs
        };
        this.instructions.push(instruction);
        return this;
    }

    set(dest: string, source: string): this {
        const instruction: SetInstruction = {
            kind: 'set',
            dest,
            source
        };
        this.instructions.push(instruction);
        return this;
    }

    get(dest: string, type?: DataType): this {
        const instruction: GetInstruction = {
            kind: 'get',
            dest,
            type
        };
        this.instructions.push(instruction);
        return this;
    }

    undef(dest: string, type?: DataType): this {
        const instruction: UndefInstruction = {
            kind: 'undef',
            dest,
            type
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Speculation =====

    guard(condition: string, label: string): this {
        const instruction: GuardInstruction = {
            kind: 'guard',
            condition,
            label
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Miscellaneous =====

    print(...args: string[]): this {
        const instruction: PrintInstruction = {
            kind: 'print',
            args
        };
        this.instructions.push(instruction);
        return this;
    }

    noArgOp(op: NoArgOp): this {
        const instruction: NoArgInstruction = {
            kind: 'no_arg',
            op
        };
        this.instructions.push(instruction);
        return this;
    }

    nop(): this {
        return this.noArgOp('nop');
    }

    // ===== Global Variables =====

    globalLoad(dest: string, globalId: string, type?: DataType): this {
        const instruction: GlobalLoadInstruction = {
            kind: 'global_load',
            dest,
            type,
            globalId
        };
        this.instructions.push(instruction);
        return this;
    }

    globalStore(globalId: string, value: string): this {
        const instruction: GlobalStoreInstruction = {
            kind: 'global_store',
            globalId,
            value
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Type Conversion =====

    widen(dest: string, sourceType: IntType, targetType: IntType, value: string, type?: DataType): this {
        const instruction: WidenInstruction = {
            kind: 'widen',
            dest,
            type,
            sourceType,
            targetType,
            value
        };
        this.instructions.push(instruction);
        return this;
    }

    narrow(dest: string, sourceType: IntType, targetType: IntType, value: string, type?: DataType): this {
        const instruction: NarrowInstruction = {
            kind: 'narrow',
            dest,
            type,
            sourceType,
            targetType,
            value
        };
        this.instructions.push(instruction);
        return this;
    }

    cast(dest: string, targetType: CastType, value: string, type?: DataType): this {
        const instruction: CastInstruction = {
            kind: 'cast',
            dest,
            type,
            targetType,
            value
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== String Operations =====

    strAlloc(dest: string, type?: DataType): this {
        const instruction: StringAllocInstruction = {
            kind: 'str_alloc',
            dest,
            type
        };
        this.instructions.push(instruction);
        return this;
    }

    strConcat(dest: string, src: string, valueType: StringConcatType, value: string, type?: DataType): this {
        const instruction: StringConcatInstruction = {
            kind: 'str_concat',
            dest,
            type,
            src,
            valueType,
            value
        };
        this.instructions.push(instruction);
        return this;
    }

    strFromBytes(dest: string, array: string, type?: DataType): this {
        const instruction: StringAllocFromBytesInstruction = {
            kind: 'str_from_bytes',
            dest,
            type,
            array
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Copy Operations =====

    isTrueCopy(dest: string, src: string, type?: DataType): this {
        const instruction: IsTrueCopyInstruction = {
            kind: 'istc',
            dest,
            type,
            src
        };
        this.instructions.push(instruction);
        return this;
    }

    isFalseCopy(dest: string, src: string, type?: DataType): this {
        const instruction: IsFalseCopyInstruction = {
            kind: 'isfc',
            dest,
            type,
            src
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Array Operations =====

    arrayAlloc(dest: string, elementType: DataType, size: string, type?: DataType): this {
        const instruction: ArrayAllocInstruction = {
            kind: 'array_alloc',
            dest,
            type,
            elementType,
            size
        };
        this.instructions.push(instruction);
        return this;
    }

    arrayLength(dest: string, array: string, type?: DataType): this {
        const instruction: ArrayLengthInstruction = {
            kind: 'array_length',
            dest,
            type,
            array
        };
        this.instructions.push(instruction);
        return this;
    }

    arrayExtend(array: string, newSize: string): this {
        const instruction: ArrayExtendInstruction = {
            kind: 'array_extend',
            array,
            newSize
        };
        this.instructions.push(instruction);
        return this;
    }

    arraySlice(dest: string, array: string, start: string, end: string, type?: DataType): this {
        const instruction: ArraySliceInstruction = {
            kind: 'array_slice',
            dest,
            type,
            array,
            start,
            end
        };
        this.instructions.push(instruction);
        return this;
    }

    arrayGet(dest: string, array: string, index: string, type?: DataType): this {
        const instruction: ArrayGetInstruction = {
            kind: 'array_get',
            dest,
            type,
            array,
            index
        };
        this.instructions.push(instruction);
        return this;
    }

    arraySet(array: string, index: string, value: string): this {
        const instruction: ArraySetInstruction = {
            kind: 'array_set',
            array,
            index,
            value
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Struct Operations =====

    structAlloc(dest: string, typeId: string, type?: DataType): this {
        const instruction: StructAllocInstruction = {
            kind: 'struct_alloc',
            dest,
            type,
            typeId
        };
        this.instructions.push(instruction);
        return this;
    }

    structGet(dest: string, struct: string, fieldId: string, type?: DataType): this {
        const instruction: StructGetInstruction = {
            kind: 'struct_get',
            dest,
            type,
            struct,
            fieldId
        };
        this.instructions.push(instruction);
        return this;
    }

    structSet(struct: string, fieldId: string, value: string): this {
        const instruction: StructSetInstruction = {
            kind: 'struct_set',
            struct,
            fieldId,
            value
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Class Operations =====

    classAlloc(dest: string, typeId: string, type?: DataType): this {
        const instruction: ClassAllocInstruction = {
            kind: 'class_alloc',
            dest,
            type,
            typeId
        };
        this.instructions.push(instruction);
        return this;
    }

    classGet(dest: string, classObj: string, fieldId: string, type?: DataType): this {
        const instruction: ClassGetInstruction = {
            kind: 'class_get',
            dest,
            type,
            class: classObj,
            fieldId
        };
        this.instructions.push(instruction);
        return this;
    }

    classSet(classObj: string, fieldId: string, value: string): this {
        const instruction: ClassSetInstruction = {
            kind: 'class_set',
            class: classObj,
            fieldId,
            value
        };
        this.instructions.push(instruction);
        return this;
    }

    classGetMethod(dest: string, classObj: string, methodId: string, type?: DataType): this {
        const instruction: ClassGetMethodInstruction = {
            kind: 'class_get_method',
            dest,
            type,
            class: classObj,
            methodId
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Interface Operations =====

    interfaceIs(interfaceVar: string, classId: string): this {
        const instruction: InterfaceIsInstruction = {
            kind: 'interface_is',
            interface: interfaceVar,
            classId
        };
        this.instructions.push(instruction);
        return this;
    }

    interfaceHasMethod(interfaceVar: string, methodId: string): this {
        const instruction: InterfaceHasMethodInstruction = {
            kind: 'interface_has_method',
            interface: interfaceVar,
            methodId
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Closure Operations =====

    closureAlloc(dest: string, func: string, type?: DataType): this {
        const instruction: ClosureAllocInstruction = {
            kind: 'closure_alloc',
            dest,
            type,
            func
        };
        this.instructions.push(instruction);
        return this;
    }

    closurePushEnv(closure: string, value: string): this {
        const instruction: ClosurePushEnvInstruction = {
            kind: 'closure_push_env',
            closure,
            value
        };
        this.instructions.push(instruction);
        return this;
    }

    closureCall(closure: string, args: string[] = [], dest?: string, type?: DataType): this {
        const instruction: ClosureCallInstruction = {
            kind: 'closure_call',
            dest,
            type,
            closure,
            args
        };
        this.instructions.push(instruction);
        return this;
    }

    closureReturn(value?: string): this {
        const instruction: ClosureReturnInstruction = {
            kind: 'closure_return',
            value
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Coroutine Operations =====

    coroAlloc(dest: string, func: string, type?: DataType): this {
        const instruction: CoroAllocInstruction = {
            kind: 'coro_alloc',
            dest,
            type,
            func
        };
        this.instructions.push(instruction);
        return this;
    }

    coroState(dest: string, coro: string, type?: DataType): this {
        const instruction: CoroStateInstruction = {
            kind: 'coro_state',
            dest,
            type,
            coro
        };
        this.instructions.push(instruction);
        return this;
    }

    coroCall(coro: string, args: string[] = [], dest?: string, type?: DataType): this {
        const instruction: CoroCallInstruction = {
            kind: 'coro_call',
            dest,
            type,
            coro,
            args
        };
        this.instructions.push(instruction);
        return this;
    }

    coroYield(value?: string): this {
        const instruction: CoroYieldInstruction = {
            kind: 'coro_yield',
            value
        };
        this.instructions.push(instruction);
        return this;
    }

    coroReturn(value?: string): this {
        const instruction: CoroReturnInstruction = {
            kind: 'coro_return',
            value
        };
        this.instructions.push(instruction);
        return this;
    }

    coroReset(coro: string): this {
        const instruction: CoroResetInstruction = {
            kind: 'coro_reset',
            coro
        };
        this.instructions.push(instruction);
        return this;
    }

    coroFinish(coro: string): this {
        const instruction: CoroFinishInstruction = {
            kind: 'coro_finish',
            coro
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== FFI Operations =====

    ffiRegister(libname: string, id: number): this {
        const instruction: FFIRegisterInstruction = {
            kind: 'ffi_register',
            libname,
            id
        };
        this.instructions.push(instruction);
        return this;
    }

    ffiCall(handle: string, args: string[] = [], dest?: string, type?: DataType): this {
        const instruction: FFICallInstruction = {
            kind: 'ffi_call',
            dest,
            type,
            handle,
            args
        };
        this.instructions.push(instruction);
        return this;
    }

    ffiClose(handle: string): this {
        const instruction: FFICloseInstruction = {
            kind: 'ffi_close',
            handle
        };
        this.instructions.push(instruction);
        return this;
    }

    // ===== Exception Handling =====

    throw(value: string): this {
        const instruction: ThrowInstruction = {
            kind: 'throw',
            value
        };
        this.instructions.push(instruction);
        return this;
    }
}

// ===== Program =====

export class LIRProgram {
    readonly functions: LIRFunction[] = [];

    createFunction(name: string, args: FunctionArg[] = [], returnType?: DataType): LIRFunction {
        const func = new LIRFunction(name, args, returnType);
        this.functions.push(func);
        return func;
    }

    addFunction(func: LIRFunction): this {
        this.functions.push(func);
        return this;
    }
}