/**
 * Binary Format Serialization
 *
 * Phase 5 of the lowering pipeline:
 * Produces the final binary output for the VM loader.
 *
 * Binary layout:
 *
 * [Header]
 *   magic:          u32    (0x54564243 = "TVBC")
 *   version:        u16    (4)
 *   flags:          u16    (reserved)
 *   numStrings:     u16
 *   numGlobals:     u16
 *   numStructs:     u16
 *   numClasses:     u16
 *   numFunctions:   u16
 *   entryFuncIndex: u16
 *   numFieldSlots:  u16
 *   numMethodSlots: u16
 *   numMethodNames: u16
 *
 * [String Pool]
 *   For each string:
 *     length: u32
 *     data:   u8[length]  (UTF-8)
 *
 * [Globals]
 *   For each global:
 *     typeTag: u8   (0=scalar, 1=ptr)
 *     subTag:  u8   (scalar kind or pointer kind)
 *
 * [Struct Shapes]
 *   For each struct:
 *     numFields: u16
 *     For each field:
 *       globalFieldId: u32
 *       typeTag:       u8
 *       subTag:        u8
 *
 * [Class Shapes]
 *   For each class:
 *     uid:        u32
 *     numFields:  u8
 *     numMethods: u16
 *     For each field:
 *       localFieldId: u8
 *       typeTag:      u8
 *       subTag:       u8
 *     For each method:
 *       methodId:       u16
 *       funcNameIndex:  u16  (index into function table)
 *     bitmapWords:    u16  (number of u64 words in method name bitmap)
 *     For each bitmap word:
 *       lo:             u32  (lower 32 bits)
 *       hi:             u32  (upper 32 bits)
 *     ptrBitmap:      4 × u64  (field pointer bitmap, as 8 × u32 lo/hi pairs)
 *
 * [Functions]
 *   For each function:
 *     nameIndex:      u16   (index into string pool, or 0xFFFF if none)
 *     constPoolSlots: u16   (number of u32 slots in constant pool)
 *     codeSize:       u32   (number of u32 instruction words)
 *     numParams:      u8
 *     numReturns:     u8
 *     flags:          u8    (bit 0=coroutine, bit 1=closure)
 *     maxReg:         u8    (highest physical register used)
 *     ptrBitmapSize:  u16   (number of bytes in pointer bitmap)
 *     ptrBitmap:      u8[]  (ceil(maxReg+1 / 8) bytes)
 *     constPool:      u32[constPoolSlots]
 *     code:           u32[codeSize]
 */

import type { IRType } from '../ir/types.js';

// === Magic and Version ===

export const BINARY_MAGIC = 0x54564243;  // "TVBC" in ASCII
export const BINARY_VERSION = 5;

// === Type Tag Encoding ===

export function encodeTypeTag(t: IRType): [number, number] {
    switch (t.tag) {
        case 'scalar': return [0, scalarSubTag(t.scalar)];
        case 'ptr': return [1, ptrSubTag(t.kind)];
        case 'void': return [2, 0];
    }
}

function scalarSubTag(scalar: string): number {
    switch (scalar) {
        case 'i8': return 0;
        case 'i16': return 1;
        case 'i32': return 2;
        case 'i64': return 3;
        case 'u8': return 4;
        case 'u16': return 5;
        case 'u32': return 6;
        case 'u64': return 7;
        case 'f32': return 8;
        case 'f64': return 9;
        case 'bool': return 10;
        default: return 0xFF;
    }
}

function ptrSubTag(kind: string): number {
    switch (kind) {
        case 'struct': return 0;
        case 'class': return 1;
        case 'array': return 2;
        case 'closure': return 3;
        case 'coroutine': return 4;
        case 'string': return 5;
        case 'variant': return 6;
        case 'interface': return 7;
        case 'ffi_handle': return 8;
        default: return 0xFF;
    }
}

// === Compiled Function (input to binary encoding) ===

export interface CompiledFunction {
    readonly name: string;
    readonly numParams: number;
    readonly numReturns: number;
    readonly isCoroutine: boolean;
    readonly isClosure: boolean;
    readonly maxRegUsed: number;
    readonly pointerRegs: Set<number>;
    readonly constantPool: Uint32Array;
    readonly code: number[];       // u32 bytecode words
}

// === Compiled Program (input to binary encoding) ===

export interface CompiledProgram {
    readonly strings: string[];
    readonly globals: { type: IRType }[];
    readonly structs: {
        fields: { slotNumber: number; type: IRType }[];
    }[];
    readonly classes: {
        uid: number;
        fields: { localFieldId: number; type: IRType }[];
        methods: { methodId: number; funcIndex: number }[];
        methodNameBitmap: bigint[];
        ptrBitmap: bigint[];  // 4 × u64: field pointer bitmap (bit i set if field i is a pointer)
    }[];
    readonly functions: CompiledFunction[];
    readonly entryFuncIndex: number;
    readonly numFieldSlots: number;
    readonly numMethodSlots: number;
    readonly numMethodNames: number;
}

// === Binary Writer ===

class BinaryWriter {
    private chunks: Uint8Array[] = [];
    private totalSize = 0;

    writeU8(value: number): void {
        const buf = new Uint8Array(1);
        buf[0] = value & 0xFF;
        this.chunks.push(buf);
        this.totalSize += 1;
    }

    writeU16(value: number): void {
        const buf = new Uint8Array(2);
        const view = new DataView(buf.buffer);
        view.setUint16(0, value & 0xFFFF, true);  // little-endian
        this.chunks.push(buf);
        this.totalSize += 2;
    }

    writeU32(value: number): void {
        const buf = new Uint8Array(4);
        const view = new DataView(buf.buffer);
        view.setUint32(0, value >>> 0, true);  // little-endian
        this.chunks.push(buf);
        this.totalSize += 4;
    }

    writeBytes(data: Uint8Array): void {
        this.chunks.push(data);
        this.totalSize += data.length;
    }

    toUint8Array(): Uint8Array {
        const result = new Uint8Array(this.totalSize);
        let offset = 0;
        for (const chunk of this.chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }
}

// === Pointer Bitmap ===

function buildPointerBitmap(pointerRegs: Set<number>, maxReg: number): Uint8Array {
    const numBytes = Math.ceil((maxReg + 1) / 8);
    const bitmap = new Uint8Array(numBytes);
    for (const reg of pointerRegs) {
        if (reg <= maxReg) {
            bitmap[reg >> 3] |= (1 << (reg & 7));
        }
    }
    return bitmap;
}

// === Main Encoding ===

export function encodeBinary(program: CompiledProgram): Uint8Array {
    const w = new BinaryWriter();

    // --- Header ---
    w.writeU32(BINARY_MAGIC);
    w.writeU16(BINARY_VERSION);
    w.writeU16(0);  // flags (reserved)
    w.writeU16(program.strings.length);
    w.writeU16(program.globals.length);
    w.writeU16(program.structs.length);
    w.writeU16(program.classes.length);
    w.writeU16(program.functions.length);
    w.writeU16(program.entryFuncIndex);
    w.writeU16(program.numFieldSlots);
    w.writeU16(program.numMethodSlots);
    w.writeU16(program.numMethodNames);

    // --- String Pool ---
    const encoder = new TextEncoder();
    for (const str of program.strings) {
        const bytes = encoder.encode(str);
        w.writeU32(bytes.length);
        w.writeBytes(bytes);
    }

    // --- Globals ---
    for (const g of program.globals) {
        const [tag, sub] = encodeTypeTag(g.type);
        w.writeU8(tag);
        w.writeU8(sub);
    }

    // --- Struct Shapes ---
    for (const s of program.structs) {
        w.writeU16(s.fields.length);
        for (const f of s.fields) {
            w.writeU16(f.slotNumber);
            const [tag, sub] = encodeTypeTag(f.type);
            w.writeU8(tag);
            w.writeU8(sub);
        }
    }

    // --- Class Shapes ---
    for (const c of program.classes) {
        w.writeU32(c.uid);
        w.writeU8(c.fields.length);
        w.writeU16(c.methods.length);
        for (const f of c.fields) {
            w.writeU8(f.localFieldId);
            const [tag, sub] = encodeTypeTag(f.type);
            w.writeU8(tag);
            w.writeU8(sub);
        }
        for (const m of c.methods) {
            w.writeU16(m.methodId);
            w.writeU16(m.funcIndex);
        }
        // Method name bitmap (for interface_has_method checks)
        const bmWords = c.methodNameBitmap.length;
        w.writeU16(bmWords);
        for (let bi = 0; bi < bmWords; bi++) {
            const val = c.methodNameBitmap[bi];
            w.writeU32(Number(val & 0xFFFFFFFFn));
            w.writeU32(Number((val >> 32n) & 0xFFFFFFFFn));
        }
        // Field pointer bitmap: 4 × u64 (256 bits, one per possible field)
        for (let pi = 0; pi < 4; pi++) {
            const val = c.ptrBitmap[pi];
            w.writeU32(Number(val & 0xFFFFFFFFn));
            w.writeU32(Number((val >> 32n) & 0xFFFFFFFFn));
        }
    }

    // --- Functions ---
    for (const fn of program.functions) {
        // nameIndex: find in string pool (or 0xFFFF)
        const nameIdx = program.strings.indexOf(fn.name);
        w.writeU16(nameIdx >= 0 ? nameIdx : 0xFFFF);

        // Constant pool
        w.writeU16(fn.constantPool.length);

        // Code size
        w.writeU32(fn.code.length);

        // Params, returns
        w.writeU8(fn.numParams);
        w.writeU8(fn.numReturns);

        // Flags
        let flags = 0;
        if (fn.isCoroutine) flags |= 0x01;
        if (fn.isClosure) flags |= 0x02;
        w.writeU8(flags);

        // Max register
        w.writeU8(fn.maxRegUsed);

        // Pointer bitmap
        const bitmap = buildPointerBitmap(fn.pointerRegs, fn.maxRegUsed);
        w.writeU16(bitmap.length);
        w.writeBytes(bitmap);

        // Constant pool data (u32[])
        for (let i = 0; i < fn.constantPool.length; i++) {
            w.writeU32(fn.constantPool[i]);
        }

        // Code (u32[])
        for (const word of fn.code) {
            w.writeU32(word);
        }
    }

    return w.toUint8Array();
}
