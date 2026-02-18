/**
 * Instruction Selection
 *
 * Phase 3 of the lowering pipeline:
 * Translates IR instructions to VM bytecode words (uint32).
 * Handles comparison fusion, constant pool building, and opcode variant selection.
 */

import type { IRInstruction, VReg } from '../ir/instructions.js';
import type { NumericType, CmpType, CastKind, IRType } from '../ir/types.js';
import { isPointer } from '../ir/types.js';
import { Op, makeABC, makeAD, makeAJ } from './opcodes.js';
import { ConstantPool, fitsInImmediate, fitsIn32 } from './constant-pool.js';

// === Output Types ===

export interface VMInstruction {
    word: number;
    labelRef?: string;   // unresolved label reference (for JMP, FORI, FORL)
    isLabel?: string;     // this position IS a label
}

export interface SelectionResult {
    instructions: VMInstruction[];
    constantPool: ConstantPool;
}

// === Helper: resolve physical register ===

type RegMap = Map<VReg, number>;

function r(regMap: RegMap, vreg: VReg): number {
    const phys = regMap.get(vreg);
    if (phys === undefined) {
        throw new Error(`Unresolved virtual register: ${vreg}`);
    }
    return phys;
}

// === Arithmetic opcode selection ===

function addOp(numType: NumericType): Op {
    if (numType === 'f32') return Op.ADD_F_RR;
    if (numType === 'f64') return Op.ADD_D_RR;
    return Op.ADD_IU_RR;
}

function subOp(numType: NumericType): Op {
    if (numType === 'f32') return Op.SUB_F_RR;
    if (numType === 'f64') return Op.SUB_D_RR;
    return Op.SUB_IU_RR;
}

function mulOp(numType: NumericType): Op {
    if (numType === 'f32') return Op.MUL_F_RR;
    if (numType === 'f64') return Op.MUL_D_RR;
    return Op.MUL_IU_RR;
}

function divOp(numType: NumericType): Op {
    if (numType === 'f32') return Op.DIV_F_RR;
    if (numType === 'f64') return Op.DIV_D_RR;
    if (numType[0] === 'u') return Op.DIV_U_RR;
    return Op.DIV_I_RR;
}

function modOp(numType: NumericType): Op {
    if (numType === 'f32') return Op.MOD_F_RR;
    if (numType === 'f64') return Op.MOD_D_RR;
    if (numType[0] === 'u') return Op.MOD_U_RR;
    return Op.MOD_I_RR;
}

function negOp(numType: NumericType): Op {
    if (numType === 'f32') return Op.NEG_F;
    if (numType === 'f64') return Op.NEG_D;
    return Op.NEG_I;
}

// === Comparison opcode selection ===

type CmpOp = 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne';

function cmpOpcode(op: CmpOp, cmpType: CmpType): Op {
    const signed = (cmpType as string)[0] === 'i';
    const isF32 = cmpType === 'f32';
    const isF64 = cmpType === 'f64';
    const isPtr = cmpType === 'ptr';

    switch (op) {
        case 'lt':
            if (isF32) return Op.LT_F;
            if (isF64) return Op.LT_D;
            return signed ? Op.LT_I : Op.LT_U;
        case 'le':
            if (isF32) return Op.LE_F;
            if (isF64) return Op.LE_D;
            return signed ? Op.LE_I : Op.LE_U;
        case 'gt':
            if (isF32) return Op.GT_F;
            if (isF64) return Op.GT_D;
            return signed ? Op.GT_I : Op.GT_U;
        case 'ge':
            if (isF32) return Op.GE_F;
            if (isF64) return Op.GE_D;
            return signed ? Op.GE_I : Op.GE_U;
        case 'eq':
            if (isF32) return Op.EQ_F;
            if (isF64) return Op.EQ_D;
            if (isPtr) return Op.EQ_PTR;
            return Op.EQ_IU;
        case 'ne':
            if (isF32) return Op.NE_F;
            if (isF64) return Op.NE_D;
            if (isPtr) return Op.NE_PTR;
            return Op.NE_IU;
    }
}

function irCmpToOp(kind: string): CmpOp {
    switch (kind) {
        case 'cmp_lt': return 'lt';
        case 'cmp_le': return 'le';
        case 'cmp_gt': return 'gt';
        case 'cmp_ge': return 'ge';
        case 'cmp_eq': return 'eq';
        case 'cmp_ne': return 'ne';
        default: throw new Error(`Not a comparison: ${kind}`);
    }
}

// === Widen opcode selection ===

function widenOp(from: string, to: string): Op {
    const key = `${from}_${to}`;
    switch (key) {
        case 'i8_i16': return Op.WIDEN_I8_I16;
        case 'i8_i32': return Op.WIDEN_I8_I32;
        case 'i8_i64': return Op.WIDEN_I8_I64;
        case 'i16_i32': return Op.WIDEN_I16_I32;
        case 'i16_i64': return Op.WIDEN_I16_I64;
        case 'i32_i64': return Op.WIDEN_I32_I64;
        case 'u8_u16': return Op.WIDEN_U8_U16;
        case 'u8_u32': return Op.WIDEN_U8_U32;
        case 'u8_u64': return Op.WIDEN_U8_U64;
        case 'u16_u32': return Op.WIDEN_U16_U32;
        case 'u16_u64': return Op.WIDEN_U16_U64;
        case 'u32_u64': return Op.WIDEN_U32_U64;
        default: throw new Error(`No widen opcode for ${from} → ${to}`);
    }
}

// === Narrow opcode selection ===

function narrowOp(from: string, to: string): Op {
    const key = `${from}_${to}`;
    switch (key) {
        case 'i64_i32': return Op.NARROW_I64_I32;
        case 'i64_i16': return Op.NARROW_I64_I16;
        case 'i64_i8': return Op.NARROW_I64_I8;
        case 'u64_u32': return Op.NARROW_U64_U32;
        case 'u64_u16': return Op.NARROW_U64_U16;
        case 'u64_u8': return Op.NARROW_U64_U8;
        default: throw new Error(`No narrow opcode for ${from} → ${to}`);
    }
}

// === Cast opcode selection ===

function castOp(castKind: CastKind): Op {
    switch (castKind) {
        case 'i_f': return Op.CAST_I_F;
        case 'f_i': return Op.CAST_F_I;
        case 'u_f': return Op.CAST_U_F;
        case 'f_u': return Op.CAST_F_U;
        case 'i_d': return Op.CAST_I_D;
        case 'd_i': return Op.CAST_D_I;
        case 'u_d': return Op.CAST_U_D;
        case 'd_u': return Op.CAST_D_U;
        case 'i_u': return Op.CAST_I_U;
        case 'u_i': return Op.CAST_U_I;
        case 'f_d': return Op.CAST_F_D;
        case 'd_f': return Op.CAST_D_F;
    }
}

// === String concat opcode selection ===

function strCatOp(valueType: IRType): Op {
    if (valueType.tag === 'ptr') {
        if (valueType.kind === 'string') return Op.STR_CAT_S_R;
        return Op.STR_CAT_PTR_R;
    }
    if (valueType.tag === 'scalar') {
        switch (valueType.scalar) {
            case 'f32': return Op.STR_CAT_F_R;
            case 'f64': return Op.STR_CAT_D_R;
            case 'i8': case 'i16': case 'i32': case 'i64':
                return Op.STR_CAT_I_R;
            case 'u8': case 'u16': case 'u32': case 'u64':
                return Op.STR_CAT_U_R;
            default: return Op.STR_CAT_I_R;
        }
    }
    return Op.STR_CAT_I_R;
}

// === Main Instruction Selection ===

export function selectInstructions(
    instructions: IRInstruction[],
    regMap: RegMap,
    pointerRegs: Set<number>,
    stringConstants: string[] = [],
    funcNameToIndex: Map<string, number> = new Map(),
    classIdToIndex: Map<string, number> = new Map(),
    structIdToIndex: Map<string, number> = new Map(),
    globalIdToIndex: Map<string, number> = new Map()
): SelectionResult {
    const out: VMInstruction[] = [];
    const pool = new ConstantPool();

    function emit(word: number): void {
        out.push({ word });
    }

    function emitLabel(name: string): void {
        out.push({ word: 0, isLabel: name });
    }

    function emitJump(op: Op, a: number, label: string): void {
        out.push({ word: makeAJ(op, a, 0), labelRef: label });
    }

    // Check if instruction at index `i` is a comparison whose result is only used by the
    // immediately following `br` instruction (for fusion).
    function canFuseWithBranch(i: number): boolean {
        if (i + 1 >= instructions.length) return false;
        const next = instructions[i + 1];
        if (next.kind !== 'br') return false;
        const curr = instructions[i];
        if (!('dest' in curr)) return false;
        return next.condition === (curr as { dest: VReg }).dest;
    }

    for (let i = 0; i < instructions.length; i++) {
        const inst = instructions[i];

        switch (inst.kind) {
            // === Constants & Moves ===
            case 'const_int': {
                const dest = r(regMap, inst.dest);
                if (fitsInImmediate(inst.value)) {
                    emit(makeAD(Op.MOV_RI, dest, Number(inst.value) & 0xFFFF));
                } else if (fitsIn32(inst.value)) {
                    const offset = pool.add32(Number(inst.value & 0xFFFFFFFFn));
                    emit(makeAD(Op.MOV_RK_32, dest, offset));
                } else {
                    const offset = pool.add64(inst.value);
                    emit(makeAD(Op.MOV_RK_64, dest, offset));
                }
                break;
            }

            case 'const_float': {
                const dest = r(regMap, inst.dest);
                if (inst.floatType === 'f32') {
                    const offset = pool.addFloat32(inst.value);
                    emit(makeAD(Op.MOV_RK_32, dest, offset));
                } else {
                    const offset = pool.addFloat64(inst.value);
                    emit(makeAD(Op.MOV_RK_64, dest, offset));
                }
                break;
            }

            case 'const_bool': {
                const dest = r(regMap, inst.dest);
                emit(makeAD(Op.MOV_RI, dest, inst.value ? 1 : 0));
                break;
            }

            case 'const_null': {
                const dest = r(regMap, inst.dest);
                emit(makeABC(Op.MOV_NULL, dest, 0, 0));
                break;
            }

            case 'mov': {
                const dest = r(regMap, inst.dest);
                const src = r(regMap, inst.src);
                const op = isPointer(inst.type) ? Op.MOV_PTR_RR : Op.MOV_RR;
                emit(makeABC(op, dest, src, 0));
                break;
            }

            // === Arithmetic ===
            case 'add': {
                emit(makeABC(addOp(inst.numType), r(regMap, inst.dest), r(regMap, inst.lhs), r(regMap, inst.rhs)));
                break;
            }
            case 'sub': {
                emit(makeABC(subOp(inst.numType), r(regMap, inst.dest), r(regMap, inst.lhs), r(regMap, inst.rhs)));
                break;
            }
            case 'mul': {
                emit(makeABC(mulOp(inst.numType), r(regMap, inst.dest), r(regMap, inst.lhs), r(regMap, inst.rhs)));
                break;
            }
            case 'div': {
                emit(makeABC(divOp(inst.numType), r(regMap, inst.dest), r(regMap, inst.lhs), r(regMap, inst.rhs)));
                break;
            }
            case 'mod': {
                emit(makeABC(modOp(inst.numType), r(regMap, inst.dest), r(regMap, inst.lhs), r(regMap, inst.rhs)));
                break;
            }
            case 'neg': {
                emit(makeABC(negOp(inst.numType), r(regMap, inst.dest), r(regMap, inst.src), 0));
                break;
            }

            // === Shifts & Bitwise ===
            case 'shl':
                emit(makeABC(Op.SHL_RR, r(regMap, inst.dest), r(regMap, inst.lhs), r(regMap, inst.rhs)));
                break;
            case 'shr':
                emit(makeABC(inst.signed ? Op.SHR_I_RR : Op.SHR_U_RR,
                    r(regMap, inst.dest), r(regMap, inst.lhs), r(regMap, inst.rhs)));
                break;
            case 'band':
                emit(makeABC(Op.BAND_RR, r(regMap, inst.dest), r(regMap, inst.lhs), r(regMap, inst.rhs)));
                break;
            case 'bor':
                emit(makeABC(Op.BOR_RR, r(regMap, inst.dest), r(regMap, inst.lhs), r(regMap, inst.rhs)));
                break;
            case 'bxor':
                emit(makeABC(Op.BXOR_RR, r(regMap, inst.dest), r(regMap, inst.lhs), r(regMap, inst.rhs)));
                break;
            case 'bnot':
                emit(makeABC(Op.BNOT, r(regMap, inst.dest), r(regMap, inst.src), 0));
                break;

            // === Logical ===
            case 'and':
                emit(makeABC(Op.AND_RR, r(regMap, inst.dest), r(regMap, inst.lhs), r(regMap, inst.rhs)));
                break;
            case 'or':
                emit(makeABC(Op.OR_RR, r(regMap, inst.dest), r(regMap, inst.lhs), r(regMap, inst.rhs)));
                break;
            case 'not':
                emit(makeABC(Op.NOT, r(regMap, inst.dest), r(regMap, inst.src), 0));
                break;
            case 'istc':
                emit(makeAD(Op.ISTC, r(regMap, inst.dest), r(regMap, inst.src)));
                break;
            case 'isfc':
                emit(makeAD(Op.ISFC, r(regMap, inst.dest), r(regMap, inst.src)));
                break;

            // === Comparisons ===
            case 'cmp_lt': case 'cmp_le': case 'cmp_gt': case 'cmp_ge':
            case 'cmp_eq': case 'cmp_ne': {
                const cmpOp2 = irCmpToOp(inst.kind);
                if (canFuseWithBranch(i)) {
                    // Fuse with next br instruction
                    const br = instructions[i + 1];
                    if (br.kind !== 'br') break;
                    const opcode = cmpOpcode(cmpOp2, inst.cmpType);
                    emit(makeABC(opcode, r(regMap, inst.lhs), r(regMap, inst.rhs), 0));
                    // Skip fires → skip next instruction (the JMP to false)
                    // So if skip fires (condition true), we fall through past the JMP
                    emitJump(Op.JMP, 0, br.falseLabel);
                    // If true label isn't the immediate next, add another JMP
                    // (label resolver will handle fall-through optimization later)
                    if (i + 2 < instructions.length) {
                        const nextNext = instructions[i + 2];
                        if (nextNext.kind !== 'label' || nextNext.name !== br.trueLabel) {
                            emitJump(Op.JMP, 0, br.trueLabel);
                        }
                    } else {
                        emitJump(Op.JMP, 0, br.trueLabel);
                    }
                    i++; // skip the br
                } else {
                    // Boolean materialization: 3-instruction sequence
                    const dest = r(regMap, inst.dest);
                    const opcode = cmpOpcode(cmpOp2, inst.cmpType);
                    emit(makeAD(Op.MOV_RI, dest, 1));
                    emit(makeABC(opcode, r(regMap, inst.lhs), r(regMap, inst.rhs), 0));
                    emit(makeAD(Op.MOV_RI, dest, 0));
                }
                break;
            }

            case 'cmp_eq_str': {
                if (canFuseWithBranch(i)) {
                    const br = instructions[i + 1];
                    if (br.kind !== 'br') break;
                    emit(makeABC(Op.EQ_S, r(regMap, inst.lhs), r(regMap, inst.rhs), 0));
                    emitJump(Op.JMP, 0, br.falseLabel);
                    if (i + 2 < instructions.length) {
                        const nextNext = instructions[i + 2];
                        if (nextNext.kind !== 'label' || nextNext.name !== br.trueLabel) {
                            emitJump(Op.JMP, 0, br.trueLabel);
                        }
                    } else {
                        emitJump(Op.JMP, 0, br.trueLabel);
                    }
                    i++;
                } else {
                    const dest = r(regMap, inst.dest);
                    emit(makeAD(Op.MOV_RI, dest, 1));
                    emit(makeABC(Op.EQ_S, r(regMap, inst.lhs), r(regMap, inst.rhs), 0));
                    emit(makeAD(Op.MOV_RI, dest, 0));
                }
                break;
            }

            case 'cmp_ne_str': {
                if (canFuseWithBranch(i)) {
                    const br = instructions[i + 1];
                    if (br.kind !== 'br') break;
                    emit(makeABC(Op.NE_S, r(regMap, inst.lhs), r(regMap, inst.rhs), 0));
                    emitJump(Op.JMP, 0, br.falseLabel);
                    if (i + 2 < instructions.length) {
                        const nextNext = instructions[i + 2];
                        if (nextNext.kind !== 'label' || nextNext.name !== br.trueLabel) {
                            emitJump(Op.JMP, 0, br.trueLabel);
                        }
                    } else {
                        emitJump(Op.JMP, 0, br.trueLabel);
                    }
                    i++;
                } else {
                    const dest = r(regMap, inst.dest);
                    emit(makeAD(Op.MOV_RI, dest, 1));
                    emit(makeABC(Op.NE_S, r(regMap, inst.lhs), r(regMap, inst.rhs), 0));
                    emit(makeAD(Op.MOV_RI, dest, 0));
                }
                break;
            }

            case 'is_null': {
                if (canFuseWithBranch(i)) {
                    const br = instructions[i + 1];
                    if (br.kind !== 'br') break;
                    emit(makeABC(Op.ISNULL, r(regMap, inst.src), 0, 0));
                    emitJump(Op.JMP, 0, br.falseLabel);
                    i++;
                } else {
                    const dest = r(regMap, inst.dest);
                    emit(makeAD(Op.MOV_RI, dest, 1));
                    emit(makeABC(Op.ISNULL, r(regMap, inst.src), 0, 0));
                    emit(makeAD(Op.MOV_RI, dest, 0));
                }
                break;
            }

            case 'is_true': {
                if (canFuseWithBranch(i)) {
                    const br = instructions[i + 1];
                    if (br.kind !== 'br') break;
                    emit(makeABC(Op.ISTRUE, r(regMap, inst.src), 0, 0));
                    emitJump(Op.JMP, 0, br.falseLabel);
                    i++;
                } else {
                    const dest = r(regMap, inst.dest);
                    emit(makeAD(Op.MOV_RI, dest, 1));
                    emit(makeABC(Op.ISTRUE, r(regMap, inst.src), 0, 0));
                    emit(makeAD(Op.MOV_RI, dest, 0));
                }
                break;
            }

            case 'is_false': {
                if (canFuseWithBranch(i)) {
                    const br = instructions[i + 1];
                    if (br.kind !== 'br') break;
                    emit(makeABC(Op.ISFALSE, r(regMap, inst.src), 0, 0));
                    emitJump(Op.JMP, 0, br.falseLabel);
                    i++;
                } else {
                    const dest = r(regMap, inst.dest);
                    emit(makeAD(Op.MOV_RI, dest, 1));
                    emit(makeABC(Op.ISFALSE, r(regMap, inst.src), 0, 0));
                    emit(makeAD(Op.MOV_RI, dest, 0));
                }
                break;
            }

            // === Control Flow ===
            case 'label':
                emitLabel(inst.name);
                break;

            case 'jmp':
                emitJump(Op.JMP, 0, inst.target);
                break;

            case 'br':
                // Standalone br (not fused with a preceding comparison)
                emit(makeABC(Op.ISTRUE, r(regMap, inst.condition), 0, 0));
                emitJump(Op.JMP, 0, inst.falseLabel);
                // Check if trueLabel is fall-through
                if (i + 1 < instructions.length) {
                    const next = instructions[i + 1];
                    if (next.kind !== 'label' || next.name !== inst.trueLabel) {
                        emitJump(Op.JMP, 0, inst.trueLabel);
                    }
                } else {
                    emitJump(Op.JMP, 0, inst.trueLabel);
                }
                break;

            case 'ret': {
                // Move return values to registers 255, 254, 253... (backward from end)
                // This avoids collision with param registers at the front.
                for (let j = 0; j < inst.values.length; j++) {
                    const srcReg = r(regMap, inst.values[j]);
                    const destReg = 255 - j;
                    if (srcReg !== destReg) {
                        const retIsPtr = isPointer(inst.types[j]);
                        emit(makeABC(retIsPtr ? Op.MOV_PTR_RR : Op.MOV_RR, destReg, srcReg, 0));
                    }
                }
                emit(makeABC(Op.FN_RETURN, 0, 0, 0));
                break;
            }

            case 'exit':
                emit(makeABC(Op.EXIT, r(regMap, inst.code), 0, 0));
                break;

            // === Loops ===
            case 'for_init': {
                const base = r(regMap, inst.base);
                // Copy init value into base register (iterator)
                emit(makeABC(Op.MOV_RR, base, r(regMap, inst.init), 0));
                // Copy limit into base+1 (consecutive register reserved by allocator)
                emit(makeABC(Op.MOV_RR, base + 1, r(regMap, inst.limit), 0));
                // Copy step into base+2 (consecutive register reserved by allocator)
                emit(makeABC(Op.MOV_RR, base + 2, r(regMap, inst.step), 0));
                // FORI: check condition, jump to exitLabel if iter >= limit
                emitJump(Op.FORI, base, inst.exitLabel);
                break;
            }

            case 'for_loop':
                emitJump(Op.FORL, r(regMap, inst.base), inst.exitLabel);
                break;

            // === Function Calls ===
            case 'call': {
                // FN_ALLOC: allocate callee frame with function index
                const funcIdx = funcNameToIndex.get(inst.func) ?? 0xFFFF;
                const funcOffset = pool.add32(funcIdx);
                emit(makeAD(Op.FN_ALLOC, 0, funcOffset));
                // FN_SET_REG for each argument
                for (let j = 0; j < inst.args.length; j++) {
                    const argReg = r(regMap, inst.args[j]);
                    const isPtr = isPointer(inst.argTypes[j]);
                    emit(makeABC(isPtr ? Op.FN_SET_REG_PTR : Op.FN_SET_REG, j, argReg, 0));
                }
                // FN_CALL
                emit(makeABC(Op.FN_CALL, inst.args.length, inst.dests.length, 0));
                // FN_GET_RET_R: return values are in callee's regs 255, 254, 253...
                for (let j = 0; j < inst.dests.length; j++) {
                    const destReg = r(regMap, inst.dests[j]);
                    const isPtr = isPointer(inst.retTypes[j]);
                    emit(makeABC(isPtr ? Op.FN_GET_RET_PTR_R : Op.FN_GET_RET_R, destReg, 255 - j, 0));
                }
                break;
            }

            case 'call_method': {
                const objReg = r(regMap, inst.object);
                // Use a scratch register for the func index loaded from vtable.
                // Must NOT clobber objReg (needed for self). Use dests[0] if
                // available (gets overwritten by return value anyway), else reg 253.
                const scratchReg = inst.dests.length > 0
                    ? r(regMap, inst.dests[0])
                    : 253;
                // Load func_idx from vtable into scratch register
                emit(makeABC(Op.CLASS_GET_METHOD_I, scratchReg, objReg, inst.methodId));
                // Allocate function frame from register-held func index
                emit(makeABC(Op.FN_ALLOC_R, scratchReg, 0, 0));
                // self = arg 0
                emit(makeABC(Op.FN_SET_REG_PTR, 0, objReg, 0));
                // remaining args
                for (let j = 0; j < inst.args.length; j++) {
                    const argReg = r(regMap, inst.args[j]);
                    const isPtr = isPointer(inst.argTypes[j]);
                    emit(makeABC(isPtr ? Op.FN_SET_REG_PTR : Op.FN_SET_REG, j + 1, argReg, 0));
                }
                emit(makeABC(Op.FN_CALL, inst.args.length + 1, inst.dests.length, 0));
                // Return values at callee regs 255, 254, 253...
                for (let j = 0; j < inst.dests.length; j++) {
                    const destReg = r(regMap, inst.dests[j]);
                    const isPtr = isPointer(inst.retTypes[j]);
                    emit(makeABC(isPtr ? Op.FN_GET_RET_PTR_R : Op.FN_GET_RET_R, destReg, 255 - j, 0));
                }
                break;
            }

            case 'call_closure': {
                const closureReg = r(regMap, inst.closure);
                emit(makeABC(Op.CLOSURE_CALL, closureReg, inst.args.length, inst.dests.length));
                break;
            }

            case 'call_ffi': {
                const handleReg = r(regMap, inst.handle);
                // Push args onto stack for FFI function to pop
                for (let j = 0; j < inst.args.length; j++) {
                    const argReg = r(regMap, inst.args[j]);
                    const argIsPtr = isPointer(inst.argTypes[j]);
                    emit(makeABC(argIsPtr ? Op.PUSH_PTR : Op.PUSH_R, argReg, 0, 0));
                }
                // FFI_CALL: A=handleReg, B=methodId, C=argCount
                emit(makeABC(Op.FFI_CALL, handleReg, inst.methodId, inst.args.length));
                // Pop return values from stack
                for (let j = 0; j < inst.dests.length; j++) {
                    const destReg = r(regMap, inst.dests[j]);
                    const retIsPtr = isPointer(inst.retTypes[j]);
                    emit(makeABC(retIsPtr ? Op.POP_PTR : Op.POP, destReg, 0, 0));
                }
                break;
            }

            // === Struct ===
            case 'struct_alloc': {
                const structIndex = structIdToIndex.get(inst.typeId) ?? 0;
                emit(makeAD(Op.STRUCT_ALLOC_I, r(regMap, inst.dest), pool.add32(structIndex)));
                break;
            }
            case 'struct_get':
                emit(makeABC(Op.STRUCT_GET_I, r(regMap, inst.dest), r(regMap, inst.src), inst.fieldId));
                break;
            case 'struct_set':
                emit(makeABC(Op.STRUCT_SET_I, r(regMap, inst.value), r(regMap, inst.struct), inst.fieldId));
                break;

            // === Class ===
            case 'class_alloc': {
                const classIndex = classIdToIndex.get(inst.typeId) ?? 0;
                emit(makeAD(Op.CLASS_ALLOC, r(regMap, inst.dest), pool.add32(classIndex)));
                break;
            }
            case 'class_get':
                emit(makeABC(Op.CLASS_GET_I, r(regMap, inst.dest), r(regMap, inst.src), inst.fieldId));
                break;
            case 'class_set':
                emit(makeABC(Op.CLASS_SET_I, r(regMap, inst.value), r(regMap, inst.class), inst.fieldId));
                break;
            case 'class_get_method':
                emit(makeABC(Op.CLASS_GET_METHOD_I, r(regMap, inst.dest), r(regMap, inst.class), inst.methodId));
                break;

            // === Interface ===
            case 'interface_is_class':
                emit(makeABC(Op.OP_INTERFACE_IS_C_I, r(regMap, inst.interface), inst.classId, 0));
                break;
            case 'interface_has_method':
                emit(makeABC(Op.OP_I_HAS_M_R, r(regMap, inst.interface), inst.methodId, 0));
                break;

            // === Array ===
            case 'array_alloc':
                emit(makeABC(Op.ARRAY_ALLOC, r(regMap, inst.dest), r(regMap, inst.size), isPointer(inst.elementType) ? 1 : 0));
                break;
            case 'array_get':
                emit(makeABC(Op.ARRAY_GET_R, r(regMap, inst.dest), r(regMap, inst.array), r(regMap, inst.index)));
                break;
            case 'array_set':
                emit(makeABC(Op.ARRAY_SET_RR, r(regMap, inst.array), r(regMap, inst.index), r(regMap, inst.value)));
                break;
            case 'array_length':
                emit(makeABC(Op.ARRAY_LENGTH, r(regMap, inst.dest), r(regMap, inst.array), 0));
                break;
            case 'array_extend':
                emit(makeABC(Op.ARRAY_EXTEND_R, r(regMap, inst.array), r(regMap, inst.newSize), 0));
                break;
            case 'array_slice':
                emit(makeABC(Op.ARRAY_SLICE, r(regMap, inst.dest), r(regMap, inst.array), r(regMap, inst.start)));
                // end is in base+1 register (start register + 1) per VM convention
                break;

            // === String ===
            case 'str_const': {
                const strIdx = stringConstants.indexOf(inst.value);
                const offset = pool.add32(strIdx >= 0 ? strIdx : 0);
                emit(makeAD(Op.STR_ALLOC, r(regMap, inst.dest), offset));
                break;
            }
            case 'str_alloc_empty':
                emit(makeAD(Op.STR_EALLOC, r(regMap, inst.dest), 0));
                break;
            case 'str_concat':
                emit(makeABC(strCatOp(inst.valueType), r(regMap, inst.dest), r(regMap, inst.str), r(regMap, inst.value)));
                break;
            case 'str_from_bytes':
                emit(makeABC(Op.STR_BALLOC, r(regMap, inst.dest), r(regMap, inst.array), 0));
                break;

            // === Closure ===
            case 'closure_alloc': {
                const funcIdx = funcNameToIndex.get(inst.funcName) ?? 0xFFFF;
                const offset = pool.add32(funcIdx);
                emit(makeAD(Op.CLOSURE_ALLOC, r(regMap, inst.dest), offset));
                break;
            }
            case 'closure_push_env': {
                const isPtr = isPointer(inst.valueType);
                emit(makeABC(isPtr ? Op.CLOSURE_PUSH_ENV_PTR : Op.CLOSURE_PUSH_ENV,
                    r(regMap, inst.closure), r(regMap, inst.value), 0));
                break;
            }
            case 'closure_ret':
                emit(makeABC(Op.CLOSURE_BACK, 0, 0, 0));
                break;

            // === Coroutine ===
            case 'coro_alloc': {
                const funcIdx = funcNameToIndex.get(inst.funcName) ?? 0xFFFF;
                const offset = pool.add32(funcIdx);
                emit(makeAD(Op.CORO_ALLOC, r(regMap, inst.dest), offset));
                break;
            }
            case 'coro_state':
                emit(makeABC(Op.CORO_STATE, r(regMap, inst.dest), r(regMap, inst.coro), 0));
                break;
            case 'coro_call': {
                const coroReg = r(regMap, inst.coro);
                emit(makeABC(Op.CORO_CALL, coroReg, inst.args.length, inst.dests.length));
                break;
            }
            case 'coro_yield':
                emit(makeABC(Op.CORO_YIELD, 0, 0, 0));
                break;
            case 'coro_ret':
                emit(makeABC(Op.CORO_RETURN, 0, 0, 0));
                break;
            case 'coro_reset':
                emit(makeABC(Op.CORO_RESET, r(regMap, inst.coro), 0, 0));
                break;
            case 'coro_finish':
                emit(makeABC(Op.CORO_FINISH, r(regMap, inst.coro), 0, 0));
                break;

            // === Global Variables ===
            case 'global_load': {
                const dest = r(regMap, inst.dest);
                const globalIndex = globalIdToIndex.get(inst.globalId) ?? 0;
                const op = isPointer(inst.type) ? Op.MOV_PTR_RG : Op.MOV_RG;
                emit(makeAD(op, dest, pool.add32(globalIndex)));
                break;
            }
            case 'global_store': {
                const src = r(regMap, inst.value);
                const globalIndex = globalIdToIndex.get(inst.globalId) ?? 0;
                const op = isPointer(inst.type) ? Op.MOV_PTR_GR : Op.MOV_GR;
                emit(makeAD(op, src, pool.add32(globalIndex)));
                break;
            }

            // === Type Conversion ===
            case 'widen':
                emit(makeABC(widenOp(inst.from, inst.to), r(regMap, inst.dest), r(regMap, inst.src), 0));
                break;
            case 'narrow':
                emit(makeABC(narrowOp(inst.from, inst.to), r(regMap, inst.dest), r(regMap, inst.src), 0));
                break;
            case 'cast':
                emit(makeAD(castOp(inst.castKind), r(regMap, inst.dest), r(regMap, inst.src)));
                break;

            // === FFI ===
            case 'ffi_register': {
                // Store string pool index of the library name in the constant pool
                const strIdx = stringConstants.indexOf(inst.libName);
                const offset = pool.add32(strIdx >= 0 ? strIdx : 0);
                emit(makeAD(Op.FFI_REG, r(regMap, inst.dest), offset));
                break;
            }
            case 'ffi_close':
                emit(makeABC(Op.FFI_CLOSE, r(regMap, inst.handle), 0, 0));
                break;

            // === Exception ===
            case 'throw':
                emit(makeABC(Op.THROW, r(regMap, inst.value), 0, 0));
                break;

            // === SSA (should be eliminated before this point) ===
            case 'phi':
                throw new Error('Phi nodes should be eliminated before instruction selection');
            case 'undef':
                // Should have been lowered to const_int 0 in Phase 1
                emit(makeAD(Op.MOV_RI, r(regMap, inst.dest), 0));
                break;

            // === Debug ===
            case 'debug':
                // Dropped in bytecode output
                break;

            default:
                throw new Error(`Unhandled IR instruction: ${(inst as IRInstruction).kind}`);
        }
    }

    return { instructions: out, constantPool: pool };
}
