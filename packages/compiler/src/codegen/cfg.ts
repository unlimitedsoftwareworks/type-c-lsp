/**
 * Control Flow Graph and SSA Elimination
 *
 * Phase 1 of the lowering pipeline:
 * 1. Build basic blocks from linear IR instruction list
 * 2. Eliminate phi nodes by inserting mov instructions at predecessor boundaries
 * 3. Lower undef to const_int 0
 * 4. Linearize back to flat instruction list
 */

import type { IRInstruction } from '../ir/instructions.js';
import type { IRType } from '../ir/types.js';

// === Basic Block ===

export interface BasicBlock {
    readonly id: string;
    readonly instructions: IRInstruction[];
    readonly predecessors: string[];
    readonly successors: string[];
}

// === CFG Construction ===

function isTerminator(inst: IRInstruction): boolean {
    return inst.kind === 'jmp' || inst.kind === 'br' || inst.kind === 'ret'
        || inst.kind === 'exit' || inst.kind === 'closure_ret'
        || inst.kind === 'coro_ret' || inst.kind === 'coro_yield'
        || inst.kind === 'for_init';
}

function getTargets(inst: IRInstruction): string[] {
    switch (inst.kind) {
        case 'jmp': return [inst.target];
        case 'br': return [inst.trueLabel, inst.falseLabel];
        case 'for_init': return [inst.exitLabel];
        case 'for_loop': return [inst.exitLabel];
        default: return [];
    }
}

/**
 * Build basic blocks from a linear instruction list.
 * Labels start new blocks; terminators end blocks.
 */
export function buildCFG(instructions: IRInstruction[]): BasicBlock[] {
    if (instructions.length === 0) return [];

    // Pass 1: identify block boundaries
    const blockStarts = new Set<number>();
    blockStarts.add(0);  // first instruction always starts a block

    for (let i = 0; i < instructions.length; i++) {
        const inst = instructions[i];
        if (inst.kind === 'label') {
            blockStarts.add(i);
        }
        if (isTerminator(inst) && i + 1 < instructions.length) {
            blockStarts.add(i + 1);  // instruction after terminator starts new block
        }
    }

    // Pass 2: create blocks
    const sortedStarts = [...blockStarts].sort((a, b) => a - b);
    const blocks: BasicBlock[] = [];
    const blockByLabel = new Map<string, string>();  // label name → block id

    for (let idx = 0; idx < sortedStarts.length; idx++) {
        const start = sortedStarts[idx];
        const end = idx + 1 < sortedStarts.length ? sortedStarts[idx + 1] : instructions.length;
        const blockInsts = instructions.slice(start, end);

        // Block ID: use label name if first instruction is a label, otherwise synthetic
        const firstInst = blockInsts[0];
        const blockId = firstInst.kind === 'label' ? firstInst.name : `__block_${start}`;

        if (firstInst.kind === 'label') {
            blockByLabel.set(firstInst.name, blockId);
        }

        blocks.push({
            id: blockId,
            instructions: blockInsts,
            predecessors: [],
            successors: [],
        });
    }

    // Build a lookup from block id to index
    const blockIndex = new Map<string, number>();
    for (let i = 0; i < blocks.length; i++) {
        blockIndex.set(blocks[i].id, i);
    }

    // Pass 3: compute edges
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const lastInst = block.instructions[block.instructions.length - 1];
        const succs: string[] = [];

        if (isTerminator(lastInst)) {
            const targets = getTargets(lastInst);
            for (const t of targets) {
                const targetBlockId = blockByLabel.get(t) ?? t;
                succs.push(targetBlockId);
            }
            // for_init also falls through to body when initial condition passes
            if (lastInst.kind === 'for_init' && i + 1 < blocks.length) {
                succs.push(blocks[i + 1].id);
            }
            // br can fall through in some IR patterns; jmp/ret do not
        } else if (i + 1 < blocks.length) {
            // Implicit fall-through to next block
            succs.push(blocks[i + 1].id);
        }

        // Mutate in place (readonly is for external consumers)
        (block as { successors: string[] }).successors = succs;

        for (const s of succs) {
            const succIdx = blockIndex.get(s);
            if (succIdx !== undefined) {
                (blocks[succIdx] as { predecessors: string[] }).predecessors.push(block.id);
            }
        }
    }

    return blocks;
}

// === Phi Elimination ===

interface PhiInfo {
    dest: string;
    type: IRType;
    pairs: Array<{ value: string; fromLabel: string }>;
}

/**
 * Eliminate phi nodes by inserting mov instructions at predecessor block boundaries.
 * Handles cycles by using temporary registers.
 */
export function eliminatePhis(blocks: BasicBlock[]): BasicBlock[] {
    const blockMap = new Map<string, BasicBlock>();
    for (const b of blocks) blockMap.set(b.id, b);

    // Collect all phi nodes per block
    const phisPerBlock = new Map<string, PhiInfo[]>();

    for (const block of blocks) {
        const phis: PhiInfo[] = [];
        for (const inst of block.instructions) {
            if (inst.kind === 'phi') {
                phis.push({
                    dest: inst.dest,
                    type: inst.type,
                    pairs: inst.pairs.map(p => ({ value: p.value, fromLabel: p.fromLabel })),
                });
            }
        }
        if (phis.length > 0) {
            phisPerBlock.set(block.id, phis);
        }
    }

    if (phisPerBlock.size === 0) return blocks;

    // For each block with phis, insert movs at the end of each predecessor
    const insertions = new Map<string, IRInstruction[]>();  // predecessor block id → movs to append

    for (const [_blockId, phis] of phisPerBlock) {
        // Group by predecessor
        const predMovs = new Map<string, Array<{ dest: string; src: string; type: IRType }>>();

        for (const phi of phis) {
            for (const pair of phi.pairs) {
                const list = predMovs.get(pair.fromLabel) ?? [];
                list.push({ dest: phi.dest, src: pair.value, type: phi.type });
                predMovs.set(pair.fromLabel, list);
            }
        }

        // For each predecessor, resolve movs (handle cycles)
        for (const [predLabel, movs] of predMovs) {
            const resolved = resolveParallelMoves(movs);
            const existing = insertions.get(predLabel) ?? [];
            existing.push(...resolved);
            insertions.set(predLabel, existing);
        }
    }

    // Rebuild blocks: remove phis, insert movs before terminators
    return blocks.map(block => {
        // Remove phi and undef instructions
        let newInsts: IRInstruction[] = block.instructions.filter(i => i.kind !== 'phi');

        // Lower undef → const_int 0
        newInsts = newInsts.map((i): IRInstruction => {
            if (i.kind === 'undef') {
                return { kind: 'const_int' as const, dest: i.dest, value: 0n, intType: 'i64' as const };
            }
            return i;
        });

        // Insert predecessor movs before terminator
        const movsToInsert = insertions.get(block.id);
        if (movsToInsert && movsToInsert.length > 0) {
            const lastInst = newInsts[newInsts.length - 1];
            if (isTerminator(lastInst)) {
                // Insert before terminator
                newInsts = [...newInsts.slice(0, -1), ...movsToInsert, lastInst];
            } else {
                // Append at end
                newInsts = [...newInsts, ...movsToInsert];
            }
        }

        return { ...block, instructions: newInsts };
    });
}

/**
 * Resolve parallel moves, detecting and breaking cycles.
 * Input: list of (dest, src) pairs that must happen "simultaneously"
 * Output: sequential mov instructions (with temp regs for cycles)
 */
function resolveParallelMoves(
    movs: Array<{ dest: string; src: string; type: IRType }>
): IRInstruction[] {
    // Simple case: no conflicts
    if (movs.length <= 1) {
        return movs.map(m => ({
            kind: 'mov' as const,
            dest: m.dest,
            src: m.src,
            type: m.type,
        }));
    }

    // Build dependency graph to detect cycles
    const destToSrc = new Map<string, { src: string; type: IRType }>();
    for (const m of movs) {
        destToSrc.set(m.dest, { src: m.src, type: m.type });
    }

    const result: IRInstruction[] = [];
    const done = new Set<string>();
    const inProgress = new Set<string>();
    let tempCounter = 0;

    function visit(dest: string): void {
        if (done.has(dest)) return;
        if (inProgress.has(dest)) {
            // Cycle detected — break with temporary
            const entry = destToSrc.get(dest)!;
            const tmpName = `__phi_tmp_${tempCounter++}`;
            result.push({ kind: 'mov' as const, dest: tmpName, src: dest, type: entry.type });
            // Update the source that depends on this dest to use the temp
            for (const m of movs) {
                if (m.src === dest && inProgress.has(m.dest)) {
                    destToSrc.set(m.dest, { src: tmpName, type: m.type });
                }
            }
            done.add(dest);
            return;
        }

        const entry = destToSrc.get(dest);
        if (!entry) { done.add(dest); return; }

        inProgress.add(dest);

        // Visit dependency first
        if (destToSrc.has(entry.src)) {
            visit(entry.src);
        }

        inProgress.delete(dest);
        done.add(dest);

        const finalEntry = destToSrc.get(dest)!;
        result.push({ kind: 'mov' as const, dest, src: finalEntry.src, type: finalEntry.type });
    }

    for (const m of movs) {
        visit(m.dest);
    }

    return result;
}

// === Linearization ===

/**
 * Flatten blocks back to a linear instruction list (phi-free).
 */
export function linearize(blocks: BasicBlock[]): IRInstruction[] {
    const result: IRInstruction[] = [];
    for (const block of blocks) {
        result.push(...block.instructions);
    }
    return result;
}

/**
 * Full Phase 1: build CFG, eliminate phis, linearize.
 */
export function eliminateSSA(instructions: IRInstruction[]): IRInstruction[] {
    const blocks = buildCFG(instructions);
    const cleanBlocks = eliminatePhis(blocks);
    return linearize(cleanBlocks);
}
