/**
 * Label Resolution
 *
 * Phase 4 of the lowering pipeline:
 * Two-pass resolution of symbolic labels to relative instruction offsets.
 *
 * Pass 1: Walk VM instructions, record label positions (instruction index).
 * Pass 2: Patch JMP/FORI/FORL with signed 16-bit relative offsets,
 *          encoded as (offset + BCBIAS_J) in the upper 16 bits.
 */

import type { VMInstruction } from './instruction-selector.js';
import { BCBIAS_J, bcOp, bcA } from './opcodes.js';

/**
 * Resolve all label references in a VM instruction stream.
 *
 * - Instructions with `isLabel` define label positions.
 * - Instructions with `labelRef` need their J/D field patched to relative offsets.
 * - Label-defining instructions (isLabel) are stripped from the final output
 *   since they have no bytecode representation.
 *
 * Returns a new array of uint32 bytecode words (no VMInstruction wrappers).
 */
export function resolveLabels(vmInstructions: VMInstruction[]): number[] {
    // --- Pass 1: Record label positions (in the output stream, excluding label markers) ---
    const labelPositions = new Map<string, number>();
    let outputIndex = 0;

    for (const inst of vmInstructions) {
        if (inst.isLabel) {
            // This is a label marker, not a real instruction.
            // Record where it points in the output stream.
            labelPositions.set(inst.isLabel, outputIndex);
        } else {
            outputIndex++;
        }
    }

    // --- Pass 2: Emit instructions, patching label references ---
    const output: number[] = [];
    let pc = 0;

    for (const inst of vmInstructions) {
        if (inst.isLabel) {
            // Skip label markers — they don't produce bytecode
            continue;
        }

        if (inst.labelRef) {
            const target = labelPositions.get(inst.labelRef);
            if (target === undefined) {
                throw new Error(`Unresolved label: ${inst.labelRef}`);
            }

            // Compute signed relative offset: target - (current_pc + 1)
            // The VM dispatch loop does `inst = *pc++` which auto-increments pc
            // BEFORE applying the offset, so we subtract 1 to compensate.
            const offset = target - pc - 1;

            // Check 16-bit signed range
            if (offset < -32768 || offset > 32767) {
                throw new Error(
                    `Label offset out of range for ${inst.labelRef}: ${offset} ` +
                    `(must fit in signed 16-bit, -32768..32767)`
                );
            }

            // Re-encode instruction with the resolved offset in the J/D field.
            // Keep OP and A fields, replace upper 16 bits with (offset + BCBIAS_J).
            const op = bcOp(inst.word);
            const a = bcA(inst.word);
            const biasedOffset = (offset + BCBIAS_J) & 0xFFFF;
            const patched = ((op & 0xFF) | ((a & 0xFF) << 8) | (biasedOffset << 16)) >>> 0;
            output.push(patched);
        } else {
            output.push(inst.word);
        }

        pc++;
    }

    return output;
}
