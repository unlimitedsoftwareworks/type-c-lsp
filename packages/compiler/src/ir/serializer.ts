/**
 * Type-C IR Serializer
 *
 * Converts IR programs to a human-readable text format.
 * Type annotations are shown on every instruction so the output
 * is fully self-describing.
 */

import { serializeIRType } from './types.js';
import type { IRInstruction, PhiPair } from './instructions.js';
import type { IRFunction, IRProgram } from './builder.js';

// ===== Instruction Serialization =====

function serializeInstruction(inst: IRInstruction): string {
    switch (inst.kind) {
        // --- Constants & Moves ---
        case 'const_int':
            return `    ${inst.dest}: ${inst.intType} = const_int ${inst.value}`;
        case 'const_float':
            return `    ${inst.dest}: ${inst.floatType} = const_float ${inst.value}`;
        case 'const_bool':
            return `    ${inst.dest}: bool = const_bool ${inst.value}`;
        case 'const_null':
            return `    ${inst.dest}: ptr = const_null`;
        case 'mov':
            return `    ${inst.dest}: ${serializeIRType(inst.type)} = mov ${inst.src}`;

        // --- Arithmetic ---
        case 'add':
            return `    ${inst.dest}: ${inst.numType} = add.${inst.numType} ${inst.lhs} ${inst.rhs}`;
        case 'sub':
            return `    ${inst.dest}: ${inst.numType} = sub.${inst.numType} ${inst.lhs} ${inst.rhs}`;
        case 'mul':
            return `    ${inst.dest}: ${inst.numType} = mul.${inst.numType} ${inst.lhs} ${inst.rhs}`;
        case 'div':
            return `    ${inst.dest}: ${inst.numType} = div.${inst.numType} ${inst.lhs} ${inst.rhs}`;
        case 'mod':
            return `    ${inst.dest}: ${inst.numType} = mod.${inst.numType} ${inst.lhs} ${inst.rhs}`;
        case 'neg':
            return `    ${inst.dest}: ${inst.numType} = neg.${inst.numType} ${inst.src}`;

        // --- Bitwise ---
        case 'shl':
            return `    ${inst.dest} = shl ${inst.lhs} ${inst.rhs}`;
        case 'shr':
            return `    ${inst.dest} = shr.${inst.signed ? 'signed' : 'unsigned'} ${inst.lhs} ${inst.rhs}`;
        case 'band':
            return `    ${inst.dest} = band ${inst.lhs} ${inst.rhs}`;
        case 'bor':
            return `    ${inst.dest} = bor ${inst.lhs} ${inst.rhs}`;
        case 'bxor':
            return `    ${inst.dest} = bxor ${inst.lhs} ${inst.rhs}`;
        case 'bnot':
            return `    ${inst.dest} = bnot ${inst.src}`;

        // --- Comparisons ---
        case 'cmp_lt':
            return `    ${inst.dest}: bool = cmp_lt.${inst.cmpType} ${inst.lhs} ${inst.rhs}`;
        case 'cmp_le':
            return `    ${inst.dest}: bool = cmp_le.${inst.cmpType} ${inst.lhs} ${inst.rhs}`;
        case 'cmp_gt':
            return `    ${inst.dest}: bool = cmp_gt.${inst.cmpType} ${inst.lhs} ${inst.rhs}`;
        case 'cmp_ge':
            return `    ${inst.dest}: bool = cmp_ge.${inst.cmpType} ${inst.lhs} ${inst.rhs}`;
        case 'cmp_eq':
            return `    ${inst.dest}: bool = cmp_eq.${inst.cmpType} ${inst.lhs} ${inst.rhs}`;
        case 'cmp_ne':
            return `    ${inst.dest}: bool = cmp_ne.${inst.cmpType} ${inst.lhs} ${inst.rhs}`;
        case 'cmp_eq_str':
            return `    ${inst.dest}: bool = cmp_eq_str ${inst.lhs} ${inst.rhs}`;
        case 'cmp_ne_str':
            return `    ${inst.dest}: bool = cmp_ne_str ${inst.lhs} ${inst.rhs}`;
        case 'is_null':
            return `    ${inst.dest}: bool = is_null ${inst.src}`;
        case 'is_true':
            return `    ${inst.dest}: bool = is_true ${inst.src}`;
        case 'is_false':
            return `    ${inst.dest}: bool = is_false ${inst.src}`;

        // --- Logical ---
        case 'and':
            return `    ${inst.dest}: bool = and ${inst.lhs} ${inst.rhs}`;
        case 'or':
            return `    ${inst.dest}: bool = or ${inst.lhs} ${inst.rhs}`;
        case 'not':
            return `    ${inst.dest}: bool = not ${inst.src}`;
        case 'istc':
            return `    ${inst.dest} = istc ${inst.src}`;
        case 'isfc':
            return `    ${inst.dest} = isfc ${inst.src}`;

        // --- Control Flow ---
        case 'label':
            return `${inst.name}:`;
        case 'jmp':
            return `    jmp @${inst.target}`;
        case 'br':
            return `    br ${inst.condition} @${inst.trueLabel} @${inst.falseLabel}`;
        case 'ret': {
            if (inst.values.length === 0) return `    ret`;
            const vals = inst.values.map((v, i) =>
                `${v}: ${serializeIRType(inst.types[i])}`
            ).join(', ');
            return `    ret ${vals}`;
        }
        case 'exit':
            return `    exit ${inst.code}`;

        // --- Loops ---
        case 'for_init':
            return `    for_init ${inst.base} ${inst.init} ${inst.limit} ${inst.step} @${inst.exitLabel}`;
        case 'for_loop':
            return `    for_loop ${inst.base} @${inst.exitLabel}`;

        // --- Function Calls ---
        case 'call': {
            const destsStr = inst.dests.length > 0
                ? inst.dests.map((d, i) => `${d}: ${serializeIRType(inst.retTypes[i])}`).join(', ') + ' = '
                : '';
            const argsStr = inst.args.map((a, i) =>
                `${a}: ${serializeIRType(inst.argTypes[i])}`
            ).join(', ');
            return `    ${destsStr}call ${inst.func}(${argsStr})`;
        }
        case 'call_method': {
            const destsStr = inst.dests.length > 0
                ? inst.dests.map((d, i) => `${d}: ${serializeIRType(inst.retTypes[i])}`).join(', ') + ' = '
                : '';
            const argsStr = inst.args.map((a, i) =>
                `${a}: ${serializeIRType(inst.argTypes[i])}`
            ).join(', ');
            return `    ${destsStr}call_method ${inst.object} #${inst.methodId}(${argsStr})`;
        }
        case 'call_closure': {
            const destsStr = inst.dests.length > 0
                ? inst.dests.map((d, i) => `${d}: ${serializeIRType(inst.retTypes[i])}`).join(', ') + ' = '
                : '';
            const argsStr = inst.args.map((a, i) =>
                `${a}: ${serializeIRType(inst.argTypes[i])}`
            ).join(', ');
            return `    ${destsStr}call_closure ${inst.closure}(${argsStr})`;
        }
        case 'call_ffi': {
            const destsStr = inst.dests.length > 0
                ? inst.dests.map((d, i) => `${d}: ${serializeIRType(inst.retTypes[i])}`).join(', ') + ' = '
                : '';
            const argsStr = inst.args.map((a, i) =>
                `${a}: ${serializeIRType(inst.argTypes[i])}`
            ).join(', ');
            return `    ${destsStr}call_ffi ${inst.handle}[${inst.methodId}](${argsStr})`;
        }

        // --- Struct ---
        case 'struct_alloc':
            return `    ${inst.dest}: ptr.struct = struct_alloc @${inst.typeId}`;
        case 'struct_get':
            return `    ${inst.dest}: ${serializeIRType(inst.resultType)} = struct_get ${inst.src} #${inst.fieldId}`;
        case 'struct_set':
            return `    struct_set ${inst.struct} #${inst.fieldId} ${inst.value}: ${serializeIRType(inst.valueType)}`;

        // --- Class ---
        case 'class_alloc':
            return `    ${inst.dest}: ptr.class = class_alloc @${inst.typeId}`;
        case 'class_get':
            return `    ${inst.dest}: ${serializeIRType(inst.resultType)} = class_get ${inst.src} #${inst.fieldId}`;
        case 'class_set':
            return `    class_set ${inst.class} #${inst.fieldId} ${inst.value}: ${serializeIRType(inst.valueType)}`;
        case 'class_get_method':
            return `    ${inst.dest}: u64 = class_get_method ${inst.class} #${inst.methodId}`;

        // --- Interface ---
        case 'interface_is_class':
            return `    ${inst.dest}: bool = interface_is_class ${inst.interface} #${inst.classId}`;
        case 'interface_has_method':
            return `    ${inst.dest}: bool = interface_has_method ${inst.interface} #${inst.methodId}`;

        // --- Array ---
        case 'array_alloc':
            return `    ${inst.dest}: ptr.array = array_alloc <${serializeIRType(inst.elementType)}> ${inst.size}`;
        case 'array_get':
            return `    ${inst.dest}: ${serializeIRType(inst.elementType)} = array_get ${inst.array} ${inst.index}`;
        case 'array_set':
            return `    array_set ${inst.array} ${inst.index} ${inst.value}: ${serializeIRType(inst.elementType)}`;
        case 'array_length':
            return `    ${inst.dest}: u64 = array_length ${inst.array}`;
        case 'array_extend':
            return `    array_extend ${inst.array} ${inst.newSize}`;
        case 'array_slice':
            return `    ${inst.dest}: ptr.array = array_slice ${inst.array} ${inst.start} ${inst.end}`;

        // --- String ---
        case 'str_const':
            return `    ${inst.dest}: ptr.string = str_const "${escapeString(inst.value)}"`;
        case 'str_alloc_empty':
            return `    ${inst.dest}: ptr.string = str_alloc_empty`;
        case 'str_concat':
            return `    ${inst.dest}: ptr.string = str_concat ${inst.str} ${inst.value}: ${serializeIRType(inst.valueType)}`;
        case 'str_from_bytes':
            return `    ${inst.dest}: ptr.string = str_from_bytes ${inst.array}`;

        // --- Closure ---
        case 'closure_alloc':
            return `    ${inst.dest}: ptr.closure = closure_alloc @${inst.funcName}`;
        case 'closure_push_env':
            return `    closure_push_env ${inst.closure} ${inst.value}: ${serializeIRType(inst.valueType)}`;
        case 'closure_ret': {
            if (inst.values.length === 0) return `    closure_ret`;
            const vals = inst.values.map((v, i) =>
                `${v}: ${serializeIRType(inst.types[i])}`
            ).join(', ');
            return `    closure_ret ${vals}`;
        }

        // --- Coroutine ---
        case 'coro_alloc':
            return `    ${inst.dest}: ptr.coroutine = coro_alloc @${inst.funcName}`;
        case 'coro_alloc_from':
            return `    ${inst.dest}: ptr.coroutine = coro_alloc_from ${inst.closure}`;
        case 'coro_state':
            return `    ${inst.dest}: u8 = coro_state ${inst.coro}`;
        case 'coro_call': {
            const destsStr = inst.dests.length > 0
                ? inst.dests.map((d, i) => `${d}: ${serializeIRType(inst.retTypes[i])}`).join(', ') + ' = '
                : '';
            const argsStr = inst.args.map((a, i) =>
                `${a}: ${serializeIRType(inst.argTypes[i])}`
            ).join(', ');
            return `    ${destsStr}coro_call ${inst.coro}(${argsStr})`;
        }
        case 'coro_yield': {
            if (inst.values.length === 0) return `    coro_yield`;
            const vals = inst.values.map((v, i) =>
                `${v}: ${serializeIRType(inst.types[i])}`
            ).join(', ');
            return `    coro_yield ${vals}`;
        }
        case 'coro_ret': {
            if (inst.values.length === 0) return `    coro_ret`;
            const vals = inst.values.map((v, i) =>
                `${v}: ${serializeIRType(inst.types[i])}`
            ).join(', ');
            return `    coro_ret ${vals}`;
        }
        case 'coro_reset':
            return `    coro_reset ${inst.coro}`;
        case 'coro_finish':
            return `    coro_finish ${inst.coro}`;

        // --- Global Variables ---
        case 'global_load':
            return `    ${inst.dest}: ${serializeIRType(inst.type)} = global_load $${inst.globalId}`;
        case 'global_store':
            return `    global_store $${inst.globalId} ${inst.value}: ${serializeIRType(inst.type)}`;

        // --- Type Conversion ---
        case 'widen':
            return `    ${inst.dest}: ${inst.to} = widen.${inst.from}_${inst.to} ${inst.src}`;
        case 'narrow':
            return `    ${inst.dest}: ${inst.to} = narrow.${inst.from}_${inst.to} ${inst.src}`;
        case 'cast':
            return `    ${inst.dest} = cast.${inst.castKind} ${inst.src}`;

        // --- SSA ---
        case 'phi': {
            const pairsStr = inst.pairs.map((p: PhiPair) =>
                `[${p.value}, @${p.fromLabel}]`
            ).join(', ');
            return `    ${inst.dest}: ${serializeIRType(inst.type)} = phi ${pairsStr}`;
        }
        case 'undef':
            return `    ${inst.dest}: ${serializeIRType(inst.type)} = undef`;

        // --- FFI ---
        case 'ffi_register':
            return `    ${inst.dest}: ptr.ffi_handle = ffi_register "${escapeString(inst.libName)}"`;
        case 'ffi_close':
            return `    ffi_close ${inst.handle}`;

        // --- Exception ---
        case 'throw':
            return `    throw ${inst.value}`;

        // --- Debug ---
        case 'debug':
            return `    ; ${inst.comment}`;

        default:
            return `    ; unknown instruction: ${(inst as any).kind}`;
    }
}

// ===== Function Serialization =====

export function serializeFunction(func: IRFunction): string {
    const lines: string[] = [];

    // Function signature
    const paramsStr = func.params.length > 0
        ? `(${func.params.map(p => `${p.name}: ${serializeIRType(p.type)}`).join(', ')})`
        : '()';

    const retStr = func.returnTypes.length > 0
        ? ` -> ${func.returnTypes.map(t => serializeIRType(t)).join(', ')}`
        : '';

    const modifiers: string[] = [];
    if (func.isCoroutine) modifiers.push('coroutine');
    if (func.isClosure) modifiers.push('closure');
    const modStr = modifiers.length > 0 ? `[${modifiers.join(', ')}] ` : '';

    lines.push(`${modStr}fn ${func.name}${paramsStr}${retStr} {`);

    for (const instruction of func.instructions) {
        lines.push(serializeInstruction(instruction));
    }

    lines.push('}');
    return lines.join('\n');
}

// ===== Program Serialization =====

export function serializeProgram(program: IRProgram): string {
    const sections: string[] = [];

    // String constants
    if (program.stringConstants.length > 0) {
        sections.push('; === String Constants ===');
        for (let i = 0; i < program.stringConstants.length; i++) {
            sections.push(`; str[${i}] = "${escapeString(program.stringConstants[i])}"`);
        }
        sections.push('');
    }

    // Global declarations
    if (program.globals.length > 0) {
        sections.push('; === Globals ===');
        for (const g of program.globals) {
            const initStr = g.initializer ? ` init=${g.initializer}` : '';
            sections.push(`; global $${g.id}: ${serializeIRType(g.type)}${initStr}`);
        }
        sections.push('');
    }

    // Struct shapes
    if (program.structShapes.length > 0) {
        sections.push('; === Struct Shapes ===');
        for (const s of program.structShapes) {
            sections.push(`; struct @${s.id} {`);
            for (const f of s.fields) {
                sections.push(`;   field #${f.globalFieldId} ${f.name}: ${serializeIRType(f.type)}`);
            }
            sections.push('; }');
        }
        sections.push('');
    }

    // Class shapes
    if (program.classShapes.length > 0) {
        sections.push('; === Class Shapes ===');
        for (const c of program.classShapes) {
            sections.push(`; class @${c.id} (uid=${c.uid}) {`);
            for (const f of c.fields) {
                sections.push(`;   field #${f.localFieldId} ${f.name}: ${serializeIRType(f.type)}`);
            }
            for (const m of c.methods) {
                sections.push(`;   method #${m.methodId} ${m.name} -> @${m.funcName}`);
            }
            if (c.implementedInterfaces.length > 0) {
                sections.push(`;   implements ${c.implementedInterfaces.join(', ')}`);
            }
            sections.push('; }');
        }
        sections.push('');
    }

    // Entry point
    if (program.entryFunction) {
        sections.push(`; entry @${program.entryFunction}`);
        sections.push('');
    }

    // Functions
    sections.push(program.functions.map(f => serializeFunction(f)).join('\n\n'));

    return sections.join('\n') + '\n';
}

// ===== Convenience =====

export function toLIRFile(program: IRProgram): string {
    return serializeProgram(program);
}

// ===== Helpers =====

function escapeString(s: string): string {
    return s
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}
