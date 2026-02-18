/**
 * Method Slot Coloring
 *
 * Graph coloring algorithm that assigns "slot numbers" to class method names.
 * Methods that never coexist in the same class can share a slot, minimizing
 * the per-class vtable size.
 *
 * Result: each method name ID maps to a slot number. The max slot count equals
 * the largest class's method count (not the total unique method names).
 *
 * At runtime, class_get_method(obj, slot) does a single indexed load:
 *   func_idx = cls->gmethods[slot]
 */

import type { ClassShape } from '../ir/builder.js';

// === Result ===

export interface MethodColoringResult {
    /** Maps method name ID → assigned slot number */
    readonly slotMap: Map<number, number>;
    /** Total number of slots (chromatic number) */
    readonly numSlots: number;
}

// === Algorithm ===

/**
 * Assign slot numbers to method name IDs using greedy graph coloring.
 *
 * 1. Build interference graph: method names that coexist in any class are adjacent.
 * 2. Order by degree descending (most-constrained first), tie-break by ID.
 * 3. Greedy assign: pick smallest color not used by any neighbor.
 */
export function colorMethodSlots(shapes: readonly ClassShape[]): MethodColoringResult {
    // Collect all unique method name IDs
    const allNameIds = new Set<number>();
    for (const shape of shapes) {
        for (const method of shape.methods) {
            allNameIds.add(method.methodId);
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
        const ids = shape.methods.map(m => m.methodId);
        // All methods in this class are pairwise adjacent
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

    if (numSlots > 65535) {
        throw new Error(
            `Method coloring requires ${numSlots} slots, exceeding the u16 limit of 65535. ` +
            `This means some class has more than 65535 methods.`
        );
    }

    // Suboptimality warning: compare to theoretical lower bound
    // The lower bound is the max number of methods in any single class
    let lowerBound = 0;
    for (const shape of shapes) {
        if (shape.methods.length > lowerBound) {
            lowerBound = shape.methods.length;
        }
    }

    if (lowerBound > 0 && numSlots > lowerBound * 1.5) {
        console.warn(
            `Warning: Method coloring produced ${numSlots} slots (lower bound: ${lowerBound}). ` +
            `High slot count increases per-class vtable size.`
        );
    }

    return { slotMap, numSlots };
}
