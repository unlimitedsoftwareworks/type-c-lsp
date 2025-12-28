/**
 * LIR Serializer
 * Converts LIR API objects to .lir file format
 */

import type {
    DataType,
    Literal,
    BasicType,
    ArrayType,
    NullableType
} from './types.js';

import type {
    DebugInstruction,
    Instruction,
    PhiPair
} from './instructions.js';

import type { LIRFunction, LIRProgram } from './builder.js';

// ===== Type Serialization =====

function serializeDataType(type: DataType): string {
    if (type.type === 'basic') {
        return (type as BasicType).name;
    } else if (type.type === 'array') {
        const arrayType = type as ArrayType;
        return `${serializeDataType(arrayType.elementType)}[]`;
    } else if (type.type === 'nullable') {
        const nullableType = type as NullableType;
        return `${serializeDataType(nullableType.baseType)}?`;
    }
    throw new Error(`Unknown data type: ${type.type}`);
}

// ===== Literal Serialization =====

function serializeLiteral(literal: Literal): string {
    switch (literal.type) {
        case 'int':
            return literal.value.toString();
        case 'float':
            return literal.value.toString();
        case 'bool':
            return literal.value ? 'true' : 'false';
        case 'char':
            return `'${literal.value}'`;
        case 'string':
            return `"${literal.value}"`;
    }
}

// ===== Instruction Serialization =====

function serializeInstruction(instruction: Instruction): string {
    const kind = instruction.kind;

    switch (kind) {
        case 'label':
            return `${(instruction as any).name}:`;

        case 'const': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = const ${serializeLiteral(inst.value)};`;
        }

        case 'binary_op': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = ${inst.op} ${inst.arg1} ${inst.arg2};`;
        }

        case 'unary_op': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = ${inst.op} ${inst.arg};`;
        }

        case 'alloc': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = alloc ${inst.size};`;
        }

        case 'load': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = load ${inst.ptr};`;
        }

        case 'store': {
            const inst = instruction as any;
            return `    store ${inst.ptr} ${inst.value};`;
        }

        case 'ptradd': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = ptradd ${inst.ptr} ${inst.offset};`;
        }

        case 'free': {
            const inst = instruction as any;
            return `    free ${inst.ptr};`;
        }

        case 'call': {
            const inst = instruction as any;
            const destStr = inst.dest ? `${inst.dest}${inst.type ? `: ${serializeDataType(inst.type)}` : ''} = ` : '';
            const argsStr = inst.args.join(' ');
            return `    ${destStr}call ${inst.func} ${argsStr};`.trim() + ';';
        }

        case 'jmp': {
            const inst = instruction as any;
            return `    jmp ${inst.label};`;
        }

        case 'br': {
            const inst = instruction as any;
            return `    br ${inst.condition} ${inst.trueLabel} ${inst.falseLabel};`;
        }

        case 'ret': {
            const inst = instruction as any;
            return inst.value ? `    ret ${inst.value};` : `    ret;`;
        }

        case 'exit': {
            const inst = instruction as any;
            return `    exit ${inst.code};`;
        }

        case 'fori': {
            const inst = instruction as any;
            return `    fori ${inst.loopStart} ${inst.initial} ${inst.dest} ${inst.step} ${inst.loopEnd};`;
        }

        case 'forl': {
            const inst = instruction as any;
            return `    forl ${inst.loopStart} ${inst.initial} ${inst.dest} ${inst.step} ${inst.loopEnd};`;
        }

        case 'phi': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            const pairsStr = inst.pairs.map((p: PhiPair) => `${p.arg} ${p.label}`).join(' ');
            return `    ${inst.dest}${typeStr} = phi ${pairsStr};`;
        }

        case 'set': {
            const inst = instruction as any;
            return `    set ${inst.dest} ${inst.source};`;
        }

        case 'get': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = get;`;
        }

        case 'undef': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = undef;`;
        }

        case 'guard': {
            const inst = instruction as any;
            return `    guard ${inst.condition} ${inst.label};`;
        }

        case 'print': {
            const inst = instruction as any;
            const argsStr = inst.args.join(' ');
            return `    print ${argsStr};`;
        }

        case 'no_arg': {
            const inst = instruction as any;
            return `    ${inst.op};`;
        }

        case 'global_load': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = global_load ${inst.globalId};`;
        }

        case 'global_store': {
            const inst = instruction as any;
            return `    global_store ${inst.globalId} ${inst.value};`;
        }

        case 'widen': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = widen ${inst.sourceType} ${inst.targetType} ${inst.value};`;
        }

        case 'narrow': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = narrow ${inst.sourceType} ${inst.targetType} ${inst.value};`;
        }

        case 'cast': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = cast ${inst.targetType} ${inst.value};`;
        }

        case 'str_alloc': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = str_alloc;`;
        }

        case 'str_concat': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = str_concat ${inst.src} ${inst.valueType} ${inst.value};`;
        }

        case 'str_from_bytes': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = str_from_bytes ${inst.array};`;
        }

        case 'istc': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = istc ${inst.src};`;
        }

        case 'isfc': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = isfc ${inst.src};`;
        }

        case 'struct_alloc': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = struct_alloc ${inst.typeId};`;
        }

        case 'struct_get': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = struct_get ${inst.struct} ${inst.fieldId};`;
        }

        case 'struct_set': {
            const inst = instruction as any;
            return `    struct_set ${inst.struct} ${inst.fieldId} ${inst.value};`;
        }

        case 'class_alloc': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = class_alloc ${inst.typeId};`;
        }

        case 'class_get': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = class_get ${inst.class} ${inst.fieldId};`;
        }

        case 'class_set': {
            const inst = instruction as any;
            return `    class_set ${inst.class} ${inst.fieldId} ${inst.value};`;
        }

        case 'class_get_method': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = class_get_method ${inst.class} ${inst.methodId};`;
        }

        case 'interface_is': {
            const inst = instruction as any;
            return `    interface_is ${inst.interface} ${inst.classId};`;
        }

        case 'interface_has_method': {
            const inst = instruction as any;
            return `    interface_has_method ${inst.interface} ${inst.methodId};`;
        }

        case 'array_alloc': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = array_alloc ${serializeDataType(inst.elementType)} ${inst.size};`;
        }

        case 'array_length': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = array_length ${inst.array};`;
        }

        case 'array_extend': {
            const inst = instruction as any;
            return `    array_extend ${inst.array} ${inst.newSize};`;
        }

        case 'array_slice': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = array_slice ${inst.array} ${inst.start} ${inst.end};`;
        }

        case 'array_get': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = array_get ${inst.array} ${inst.index};`;
        }

        case 'array_set': {
            const inst = instruction as any;
            return `    array_set ${inst.array} ${inst.index} ${inst.value};`;
        }

        case 'closure_alloc': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = closure_alloc ${inst.func};`;
        }

        case 'closure_push_env': {
            const inst = instruction as any;
            return `    closure_push_env ${inst.closure} ${inst.value};`;
        }

        case 'closure_call': {
            const inst = instruction as any;
            const destStr = inst.dest ? `${inst.dest}${inst.type ? `: ${serializeDataType(inst.type)}` : ''} = ` : '';
            const argsStr = inst.args.join(' ');
            return `    ${destStr}closure_call ${inst.closure} ${argsStr};`.trim() + ';';
        }

        case 'closure_return': {
            const inst = instruction as any;
            return inst.value ? `    closure_return ${inst.value};` : `    closure_return;`;
        }

        case 'coro_alloc': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = coro_alloc ${inst.func};`;
        }

        case 'coro_state': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = coro_state ${inst.coro};`;
        }

        case 'coro_call': {
            const inst = instruction as any;
            const destStr = inst.dest ? `${inst.dest}${inst.type ? `: ${serializeDataType(inst.type)}` : ''} = ` : '';
            const argsStr = inst.args.join(' ');
            return `    ${destStr}coro_call ${inst.coro} ${argsStr};`.trim() + ';';
        }

        case 'coro_yield': {
            const inst = instruction as any;
            return inst.value ? `    coro_yield ${inst.value};` : `    coro_yield;`;
        }

        case 'coro_return': {
            const inst = instruction as any;
            return inst.value ? `    coro_return ${inst.value};` : `    coro_return;`;
        }

        case 'coro_reset': {
            const inst = instruction as any;
            return `    coro_reset ${inst.coro};`;
        }

        case 'coro_finish': {
            const inst = instruction as any;
            return `    coro_finish ${inst.coro};`;
        }

        case 'ffi_register': {
            const inst = instruction as any;
            const typeStr = inst.type ? `: ${serializeDataType(inst.type)}` : '';
            return `    ${inst.dest}${typeStr} = ffi_register ${inst.libPath} ${inst.funcName};`;
        }

        case 'ffi_call': {
            const inst = instruction as any;
            const destStr = inst.dest ? `${inst.dest}${inst.type ? `: ${serializeDataType(inst.type)}` : ''} = ` : '';
            const argsStr = inst.args.join(' ');
            return `    ${destStr}ffi_call ${inst.handle} ${argsStr};`.trim() + ';';
        }

        case 'ffi_close': {
            const inst = instruction as any;
            return `    ffi_close ${inst.handle};`;
        }

        case 'throw': {
            const inst = instruction as any;
            return `    throw ${inst.value};`;
        }

        case 'debug': {
            const inst = instruction as DebugInstruction;
            return `    debug ${inst.comment}`;
        }

        default:
            throw new Error(`Unknown instruction kind: ${kind}`);
    }
}

// ===== Function Serialization =====

function serializeFunction(func: LIRFunction): string {
    const lines: string[] = [];

    // Function signature
    const argsStr = func.args.length > 0
        ? `(${func.args.map(arg => {
            const typeStr = arg.type ? `: ${serializeDataType(arg.type)}` : '';
            return `${arg.name}${typeStr}`;
        }).join(', ')})`
        : '';
    
    const returnTypeStr = func.returnType ? `: ${serializeDataType(func.returnType)}` : '';
    
    lines.push(`${func.name}${argsStr}${returnTypeStr} {`);

    // Instructions
    for (const instruction of func.instructions) {
        lines.push(serializeInstruction(instruction));
    }

    lines.push('}');

    return lines.join('\n');
}

// ===== Program Serialization =====

export function serializeProgram(program: LIRProgram): string {
    return program.functions.map(func => serializeFunction(func)).join('\n\n') + '\n';
}

// ===== File Export =====

export function toLIRFile(program: LIRProgram): string {
    return serializeProgram(program);
}