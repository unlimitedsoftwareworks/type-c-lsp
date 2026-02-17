/**
 * Field Slot Coloring
 *
 * Graph coloring algorithm that assigns "slot numbers" to struct field names.
 * Fields that never coexist in the same struct can share a slot, minimizing
 * the per-shape offset table size.
 *
 * Result: each field name ID maps to a slot number. The max slot count equals
 * the largest struct's field count (not the total unique field names).
 *
 * At runtime, struct_get(ptr, slot) does a single indexed load:
 *   offset = shape->foffset[slot]
 */

import type { StructShape } from '../ir/builder.js';

// === Result ===

export interface FieldColoringResult {
    /** Maps field name ID → assigned slot number */
    readonly slotMap: Map<number, number>;
    /** Total number of slots (chromatic number) */
    readonly numSlots: number;
}

// === Algorithm ===

/**
 * Assign slot numbers to field name IDs using greedy graph coloring.
 *
 * 1. Build interference graph: field names that coexist in any struct are adjacent.
 * 2. Order by degree descending (most-constrained first), tie-break by ID.
 * 3. Greedy assign: pick smallest color not used by any neighbor.
 */
export function colorFieldSlots(shapes: readonly StructShape[]): FieldColoringResult {
    // Collect all unique field name IDs
    const allNameIds = new Set<number>();
    for (const shape of shapes) {
        for (const field of shape.fields) {
            allNameIds.add(field.globalFieldId);
        }
    }

    if (allNameIds.size === 0) {
        return { slotMap: new Map(), numSlots: 0 };
    }

    // Build adjacency list (interference graph)
    const adj = new Map<number, Set<number>>();
    for (const id of allNameIds) {
        adj.set(id, new Set());
    }

    for (const shape of shapes) {
        const ids = shape.fields.map(f => f.globalFieldId);
        // All fields in this shape are pairwise adjacent
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                adj.get(ids[i])!.add(ids[j]);
                adj.get(ids[j])!.add(ids[i]);
            }
        }
    }

    // Order nodes: degree descending, then ID ascending for determinism
    const nodes = [...allNameIds].sort((a, b) => {
        const degDiff = adj.get(b)!.size - adj.get(a)!.size;
        if (degDiff !== 0) return degDiff;
        return a - b;
    });

    // Greedy coloring
    const slotMap = new Map<number, number>();
    let maxSlot = -1;

    for (const node of nodes) {
        // Collect colors used by neighbors
        const usedColors = new Set<number>();
        for (const neighbor of adj.get(node)!) {
            const color = slotMap.get(neighbor);
            if (color !== undefined) {
                usedColors.add(color);
            }
        }

        // Pick smallest available color
        let color = 0;
        while (usedColors.has(color)) {
            color++;
        }

        slotMap.set(node, color);
        if (color > maxSlot) {
            maxSlot = color;
        }
    }

    const numSlots = maxSlot + 1;

    if (numSlots > 255) {
        throw new Error(
            `Field coloring requires ${numSlots} slots, exceeding the u8 limit of 255. ` +
            `This means some struct has more than 255 fields.`
        );
    }

    return { slotMap, numSlots };
}
