/**
 * Per-function Constant Pool Builder
 *
 * The Type-V VM stores constants at negative offsets from the function's base pointer.
 * Constants are addressed by a 16-bit index (offset), where offset 0 is invalid.
 *
 * - 32-bit constant: occupies 1 slot (uint32), accessed via get_constant_32(base, offset)
 * - 64-bit constant: occupies 2 slots (lo at base[-offset], hi at base[-offset-1])
 *
 * The constant pool is encoded as a Uint32Array in reverse order (highest offset first).
 */

export interface ConstantEntry {
    readonly value: bigint;
    readonly width: 32 | 64;
    readonly offset: number;  // 1-based offset from base
}

export class ConstantPool {
    private entries: ConstantEntry[] = [];
    private nextOffset = 1;  // offset 0 is reserved/invalid
    private dedup32 = new Map<number, number>();   // value → offset
    private dedup64 = new Map<bigint, number>();    // value → offset

    /**
     * Add a 32-bit constant. Returns the constant pool offset.
     */
    add32(value: number): number {
        const existing = this.dedup32.get(value);
        if (existing !== undefined) return existing;

        const offset = this.nextOffset++;
        if (offset > 0xFFFF) {
            throw new Error(`Constant pool overflow: offset ${offset} exceeds u16 range (max 65535). Function has too many constants.`);
        }
        this.entries.push({ value: BigInt(value) & 0xFFFFFFFFn, width: 32, offset });
        this.dedup32.set(value, offset);
        return offset;
    }

    /**
     * Add a 64-bit constant. Returns the constant pool offset.
     * The 64-bit value occupies 2 consecutive slots.
     */
    add64(value: bigint): number {
        const existing = this.dedup64.get(value);
        if (existing !== undefined) return existing;

        const offset = this.nextOffset;
        this.nextOffset += 2;  // 64-bit takes 2 slots
        if (offset > 0xFFFF) {
            throw new Error(`Constant pool overflow: offset ${offset} exceeds u16 range (max 65535). Function has too many constants.`);
        }
        this.entries.push({ value, width: 64, offset });
        this.dedup64.set(value, offset);
        return offset;
    }

    /**
     * Add a float32 constant (bit-reinterpreted as uint32).
     */
    addFloat32(value: number): number {
        const buf = new ArrayBuffer(4);
        new Float32Array(buf)[0] = value;
        return this.add32(new Uint32Array(buf)[0]);
    }

    /**
     * Add a float64 constant (bit-reinterpreted as uint64).
     */
    addFloat64(value: number): number {
        const buf = new ArrayBuffer(8);
        new Float64Array(buf)[0] = value;
        const u32 = new Uint32Array(buf);
        const lo = u32[0];
        const hi = u32[1];
        const bits = (BigInt(hi) << 32n) | BigInt(lo);
        return this.add64(bits);
    }

    /**
     * Total number of uint32 slots used.
     */
    get size(): number {
        return this.nextOffset - 1;
    }

    /**
     * Encode the constant pool as a Uint32Array.
     * Layout matches VM expectations: base[-1] is slot 1, base[-2] is slot 2, etc.
     * The returned array should be placed before the function's base pointer.
     */
    encode(): Uint32Array {
        const totalSlots = this.nextOffset - 1;
        const pool = new Uint32Array(totalSlots);

        // VM reads const_base[-(int32_t)d] which translates to memory[totalSlots - d].
        // So offset d's value must be stored at pool[totalSlots - d].
        for (const entry of this.entries) {
            if (entry.width === 32) {
                pool[totalSlots - entry.offset] = Number(entry.value & 0xFFFFFFFFn);
            } else {
                // 64-bit: VM reads lo from base[-d] = memory[n-d],
                //         hi from base[-d-1] = memory[n-d-1]
                const lo = Number(entry.value & 0xFFFFFFFFn);
                const hi = Number((entry.value >> 32n) & 0xFFFFFFFFn);
                pool[totalSlots - entry.offset] = lo;
                pool[totalSlots - entry.offset - 1] = hi;
            }
        }

        return pool;
    }
}

// === Value classification helpers ===

/**
 * Check if an integer value fits in a signed 16-bit immediate.
 */
export function fitsInImmediate(value: bigint): boolean {
    return value >= -32768n && value <= 32767n;
}

/**
 * Check if an integer value fits in an unsigned 32-bit constant.
 */
export function fitsIn32(value: bigint): boolean {
    return value >= 0n && value <= 0xFFFFFFFFn;
}

/**
 * Check if a signed integer value fits in a 32-bit constant pool entry.
 * (Covers both signed and unsigned 32-bit range)
 */
export function fitsInSigned32(value: bigint): boolean {
    return value >= -2147483648n && value <= 2147483647n;
}
