/**
 * Linear Scan Register Allocation
 *
 * Phase 2 of the lowering pipeline:
 * Maps unlimited virtual registers (VReg strings) to physical u8 registers (0-255).
 *
 * Register layout per function:
 *   [0 .. P-1]       Parameters (fixed by VM call protocol)
 *   [P .. P+R-1]     Reserved for return values
 *   [P+R .. 255]     General-purpose pool for locals and temporaries
 *
 * Algorithm: linear scan with live interval computation.
 * MVP: errors if more than 256 registers are needed (no spilling yet).
 */

import type { IRInstruction, VReg } from '../ir/instructions.js';
import type { FunctionParam } from '../ir/builder.js';
import type { IRType } from '../ir/types.js';
import { isPointer } from '../ir/types.js';

// === Types ===

export interface LiveInterval {
    readonly vreg: VReg;
    readonly type: IRType;
    start: number;       // first instruction index where vreg is defined or used
    end: number;         // last instruction index where vreg is used
    physReg?: number;    // assigned physical register (0-255)
}

export interface RegisterAllocation {
    readonly regMap: Map<VReg, number>;      // vreg → physical register
    readonly pointerRegs: Set<number>;       // physical regs that hold GC pointers
    readonly maxRegUsed: number;             // highest physical register assigned
}

// === VReg Definition/Use Extraction ===

function getDefinedVRegs(inst: IRInstruction): VReg[] {
    switch (inst.kind) {
        case 'const_int':
        case 'const_float':
        case 'const_bool':
        case 'const_null':
            return [inst.dest];
        case 'mov':
            return [inst.dest];
        case 'add': case 'sub': case 'mul': case 'div': case 'mod':
            return [inst.dest];
        case 'neg':
            return [inst.dest];
        case 'shl': case 'shr': case 'band': case 'bor': case 'bxor':
            return [inst.dest];
        case 'bnot':
            return [inst.dest];
        case 'cmp_lt': case 'cmp_le': case 'cmp_gt': case 'cmp_ge':
        case 'cmp_eq': case 'cmp_ne':
        case 'cmp_eq_str': case 'cmp_ne_str':
            return [inst.dest];
        case 'is_null': case 'is_true': case 'is_false':
            return [inst.dest];
        case 'and': case 'or':
            return [inst.dest];
        case 'not':
            return [inst.dest];
        case 'istc': case 'isfc':
            return [inst.dest];
        case 'widen': case 'narrow': case 'cast':
            return [inst.dest];
        case 'struct_alloc': case 'class_alloc':
            return [inst.dest];
        case 'struct_get': case 'class_get':
            return [inst.dest];
        case 'class_get_method':
            return [inst.dest];
        case 'interface_is_class': case 'interface_has_method':
            return [inst.dest];
        case 'array_alloc':
            return [inst.dest];
        case 'array_get':
            return [inst.dest];
        case 'array_length':
            return [inst.dest];
        case 'array_slice':
            return [inst.dest];
        case 'str_const': case 'str_alloc_empty': case 'str_concat': case 'str_from_bytes':
            return [inst.dest];
        case 'closure_alloc':
            return [inst.dest];
        case 'coro_alloc': case 'coro_state':
            return [inst.dest];
        case 'global_load':
            return [inst.dest];
        case 'call':
            return [...inst.dests];
        case 'call_method':
            return [...inst.dests];
        case 'call_closure':
            return [...inst.dests];
        case 'call_ffi':
            return [...inst.dests];
        case 'coro_call':
            return [...inst.dests];
        case 'ffi_register':
            return [inst.dest];
        case 'phi':
            return [inst.dest];
        case 'undef':
            return [inst.dest];
        case 'for_init':
            return [inst.base];
        default:
            return [];
    }
}

function getUsedVRegs(inst: IRInstruction): VReg[] {
    switch (inst.kind) {
        case 'mov':
            return [inst.src];
        case 'add': case 'sub': case 'mul': case 'div': case 'mod':
            return [inst.lhs, inst.rhs];
        case 'neg':
            return [inst.src];
        case 'shl': case 'shr': case 'band': case 'bor': case 'bxor':
            return [inst.lhs, inst.rhs];
        case 'bnot':
            return [inst.src];
        case 'cmp_lt': case 'cmp_le': case 'cmp_gt': case 'cmp_ge':
        case 'cmp_eq': case 'cmp_ne':
        case 'cmp_eq_str': case 'cmp_ne_str':
            return [inst.lhs, inst.rhs];
        case 'is_null': case 'is_true': case 'is_false':
            return [inst.src];
        case 'and': case 'or':
            return [inst.lhs, inst.rhs];
        case 'not':
            return [inst.src];
        case 'istc': case 'isfc':
            return [inst.src];
        case 'br':
            return [inst.condition];
        case 'ret':
            return [...inst.values];
        case 'closure_ret':
            return [...inst.values];
        case 'coro_ret':
            return [...inst.values];
        case 'coro_yield':
            return [...inst.values];
        case 'widen': case 'narrow':
            return [inst.src];
        case 'cast':
            return [inst.src];
        case 'struct_get':
            return [inst.src];
        case 'struct_set':
            return [inst.struct, inst.value];
        case 'class_get':
            return [inst.src];
        case 'class_set':
            return [inst.class, inst.value];
        case 'class_get_method':
            return [inst.class];
        case 'interface_is_class':
            return [inst.interface];
        case 'interface_has_method':
            return [inst.interface];
        case 'array_alloc':
            return [inst.size];
        case 'array_get':
            return [inst.array, inst.index];
        case 'array_set':
            return [inst.array, inst.index, inst.value];
        case 'array_length':
            return [inst.array];
        case 'array_extend':
            return [inst.array, inst.newSize];
        case 'array_slice':
            return [inst.array, inst.start, inst.end];
        case 'str_concat':
            return [inst.str, inst.value];
        case 'str_from_bytes':
            return [inst.array];
        case 'closure_push_env':
            return [inst.closure, inst.value];
        case 'coro_call':
            return [inst.coro, ...inst.args];
        case 'coro_reset': case 'coro_finish':
            return [inst.coro];
        case 'coro_state':
            return [inst.coro];
        case 'global_store':
            return [inst.value];
        case 'call':
            return [...inst.args];
        case 'call_method':
            return [inst.object, ...inst.args];
        case 'call_closure':
            return [inst.closure, ...inst.args];
        case 'call_ffi':
            return [inst.handle, ...inst.args];
        case 'ffi_close':
            return [inst.handle];
        case 'throw':
            return [inst.value];
        case 'for_init':
            return [inst.init, inst.limit, inst.step];
        case 'for_loop':
            return [inst.base];
        case 'exit':
            return [inst.code];
        case 'phi':
            return inst.pairs.map(p => p.value);
        default:
            return [];
    }
}

// === Live Interval Computation ===

/**
 * Collect backward-jump loop ranges from the flat instruction list.
 * A backward jump creates a loop range [targetIndex, jumpIndex].
 * Any vreg live within this range must survive the entire loop iteration.
 */
function collectLoopRanges(instructions: IRInstruction[]): Array<{ start: number; end: number }> {
    // Build label → instruction index map
    const labelIndex = new Map<string, number>();
    for (let i = 0; i < instructions.length; i++) {
        if (instructions[i].kind === 'label') {
            labelIndex.set((instructions[i] as { kind: 'label'; name: string }).name, i);
        }
    }

    const ranges: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < instructions.length; i++) {
        const inst = instructions[i];
        let targets: string[] = [];
        if (inst.kind === 'jmp') targets = [inst.target];
        else if (inst.kind === 'br') targets = [inst.trueLabel, inst.falseLabel];
        else if (inst.kind === 'for_loop') targets = [inst.exitLabel]; // for_loop jumps back implicitly

        for (const target of targets) {
            const targetIdx = labelIndex.get(target);
            if (targetIdx !== undefined && targetIdx < i) {
                // Backward jump → loop from targetIdx to i
                ranges.push({ start: targetIdx, end: i });
            }
        }
    }
    return ranges;
}

/**
 * Compute live intervals for all virtual registers in a function.
 * Uses a forward scan with loop-aware extension: any vreg that overlaps
 * a backward-jump loop range has its interval extended to cover the full loop.
 */
export function computeLiveIntervals(
    instructions: IRInstruction[],
    params: FunctionParam[]
): LiveInterval[] {
    const intervals = new Map<VReg, LiveInterval>();

    // Pre-create intervals for parameters (they're live from instruction 0)
    for (const p of params) {
        intervals.set(p.name, {
            vreg: p.name,
            type: p.type,
            start: 0,
            end: 0,
        });
    }

    // Scan instructions
    for (let i = 0; i < instructions.length; i++) {
        const inst = instructions[i];

        // Process definitions
        for (const def of getDefinedVRegs(inst)) {
            if (!intervals.has(def)) {
                // Infer type from instruction
                const type = getDefinedType(inst, def);
                intervals.set(def, { vreg: def, type, start: i, end: i });
            }
        }

        // Process uses — extend the end of the interval
        for (const use of getUsedVRegs(inst)) {
            const interval = intervals.get(use);
            if (interval) {
                interval.end = Math.max(interval.end, i);
            }
            // If a vreg is used but never defined (shouldn't happen post-SSA-elim),
            // create an interval starting at 0
            if (!interval) {
                intervals.set(use, {
                    vreg: use,
                    type: { tag: 'scalar', scalar: 'i64' },
                    start: 0,
                    end: i,
                });
            }
        }
    }

    // Loop-aware extension: extend intervals that overlap backward-jump loops.
    // If a vreg is live at any point inside a loop body, it must be live for
    // the entire loop, because the backward jump re-enters the body.
    const loopRanges = collectLoopRanges(instructions);
    if (loopRanges.length > 0) {
        let changed = true;
        while (changed) {
            changed = false;
            for (const interval of intervals.values()) {
                for (const loop of loopRanges) {
                    // If the interval overlaps the loop range, extend it to cover the full loop
                    if (interval.start <= loop.end && interval.end >= loop.start) {
                        const newEnd = Math.max(interval.end, loop.end);
                        if (newEnd > interval.end) {
                            interval.end = newEnd;
                            changed = true;
                        }
                    }
                }
            }
        }
    }

    return [...intervals.values()];
}

/**
 * Infer the IRType of a vreg from the instruction that defines it.
 */
function getDefinedType(inst: IRInstruction, _vreg: VReg): IRType {
    switch (inst.kind) {
        case 'const_int': return { tag: 'scalar', scalar: inst.intType };
        case 'const_float': return { tag: 'scalar', scalar: inst.floatType };
        case 'const_bool': return { tag: 'scalar', scalar: 'bool' };
        case 'const_null': return { tag: 'ptr', kind: 'class' };
        case 'mov': return inst.type;
        case 'add': case 'sub': case 'mul': case 'div': case 'mod':
            return { tag: 'scalar', scalar: inst.numType };
        case 'neg': return { tag: 'scalar', scalar: inst.numType };
        case 'cmp_lt': case 'cmp_le': case 'cmp_gt': case 'cmp_ge':
        case 'cmp_eq': case 'cmp_ne':
        case 'cmp_eq_str': case 'cmp_ne_str':
        case 'is_null': case 'is_true': case 'is_false':
        case 'and': case 'or': case 'not':
            return { tag: 'scalar', scalar: 'bool' };
        case 'struct_alloc': return { tag: 'ptr', kind: 'struct' };
        case 'class_alloc': return { tag: 'ptr', kind: 'class' };
        case 'struct_get': return inst.resultType;
        case 'class_get': return inst.resultType;
        case 'class_get_method': return { tag: 'ptr', kind: 'closure' };
        case 'interface_is_class': case 'interface_has_method':
            return { tag: 'scalar', scalar: 'bool' };
        case 'array_alloc': return { tag: 'ptr', kind: 'array' };
        case 'array_get': return inst.elementType;
        case 'array_length': return { tag: 'scalar', scalar: 'u64' };
        case 'array_slice': return { tag: 'ptr', kind: 'array' };
        case 'str_const': case 'str_alloc_empty': case 'str_concat': case 'str_from_bytes':
            return { tag: 'ptr', kind: 'string' };
        case 'closure_alloc': return { tag: 'ptr', kind: 'closure' };
        case 'coro_alloc': return { tag: 'ptr', kind: 'coroutine' };
        case 'coro_state': return { tag: 'scalar', scalar: 'u8' };
        case 'global_load': return inst.type;
        case 'widen': return { tag: 'scalar', scalar: inst.to };
        case 'narrow': return { tag: 'scalar', scalar: inst.to };
        case 'ffi_register': return { tag: 'ptr', kind: 'ffi_handle' };
        case 'phi': return inst.type;
        case 'undef': return inst.type;
        default: return { tag: 'scalar', scalar: 'i64' };
    }
}

// === Linear Scan Allocation ===

/**
 * Allocate physical registers using linear scan.
 */
export function allocateRegisters(
    instructions: IRInstruction[],
    params: FunctionParam[],
    numReturns: number
): RegisterAllocation {
    const intervals = computeLiveIntervals(instructions, params);

    const numParams = params.length;
    const firstGeneral = numParams + numReturns;

    // Sort intervals by start position
    intervals.sort((a, b) => a.start - b.start);

    const regMap = new Map<VReg, number>();
    const pointerRegs = new Set<number>();
    let maxRegUsed = firstGeneral - 1;

    // Pre-assign parameters to registers 0..P-1
    for (let i = 0; i < numParams; i++) {
        const param = params[i];
        const interval = intervals.find(iv => iv.vreg === param.name);
        if (interval) {
            interval.physReg = i;
            regMap.set(param.name, i);
            if (isPointer(param.type)) {
                pointerRegs.add(i);
            }
        }
    }

    // Free register pool: [firstGeneral .. 255]
    const freeRegs: number[] = [];
    for (let r = 255; r >= firstGeneral; r--) {
        freeRegs.push(r);  // push in reverse so pop gives lowest first
    }

    // Active intervals sorted by end position
    const active: LiveInterval[] = [];

    for (const interval of intervals) {
        // Skip already-assigned parameters
        if (interval.physReg !== undefined) continue;

        // Expire old intervals
        expireOld(active, interval.start, freeRegs);

        if (freeRegs.length === 0) {
            throw new Error(
                `Register allocation failed: function requires more than 256 registers. ` +
                `Consider splitting the function. (vreg: ${interval.vreg})`
            );
        }

        // Allocate
        const reg = freeRegs.pop()!;
        interval.physReg = reg;
        regMap.set(interval.vreg, reg);

        if (isPointer(interval.type)) {
            pointerRegs.add(reg);
        }

        if (reg > maxRegUsed) maxRegUsed = reg;

        // Insert into active, maintaining sorted-by-end order
        insertActive(active, interval);
    }

    return { regMap, pointerRegs, maxRegUsed };
}

function expireOld(active: LiveInterval[], currentStart: number, freeRegs: number[]): void {
    // Remove intervals that have ended before the current start
    let i = 0;
    while (i < active.length) {
        if (active[i].end < currentStart) {
            freeRegs.push(active[i].physReg!);
            active.splice(i, 1);
        } else {
            i++;
        }
    }
}

function insertActive(active: LiveInterval[], interval: LiveInterval): void {
    let i = 0;
    while (i < active.length && active[i].end < interval.end) i++;
    active.splice(i, 0, interval);
}
