/**
 * Type-V VM Opcodes and Instruction Encoding
 *
 * Mirrors typev-nextgen/typev/tvbc.h exactly.
 * 32-bit instructions in ABC / AD / AJ formats.
 */

// === Opcodes (must match tvbc.h enum values exactly) ===

export enum Op {
    // --- Move ---
    MOV_RR = 0,         // rA = rB
    MOV_PTR_RR,         // rA = rB (pointer, sets GC bitmap)
    MOV_RI,             // rA = immediate (signed 16-bit in D)
    MOV_RK_32,          // rA = constant pool 32-bit (offset in D)
    MOV_RK_64,          // rA = constant pool 64-bit (offset in D)
    MOV_RG,             // rA = global[D]
    MOV_PTR_RG,         // rA = global[D] (pointer)
    MOV_GR,             // global = rA
    MOV_PTR_GR,         // global = rA (pointer)
    MOV_NULL,           // rA = NULL

    // --- Type narrowing (always from 64-bit) ---
    NARROW_I64_I32,
    NARROW_I64_I16,
    NARROW_I64_I8,
    NARROW_U64_U32,
    NARROW_U64_U16,
    NARROW_U64_U8,

    // --- Type widening ---
    WIDEN_I8_I16,
    WIDEN_I8_I32,
    WIDEN_I8_I64,
    WIDEN_I16_I32,
    WIDEN_I16_I64,
    WIDEN_I32_I64,
    WIDEN_U8_U16,
    WIDEN_U8_U32,
    WIDEN_U8_U64,
    WIDEN_U16_U32,
    WIDEN_U16_U64,
    WIDEN_U32_U64,

    // --- Comparison (skip next instruction if true) ---
    LT_I, LT_U, LT_F, LT_D,
    GE_I, GE_U, GE_F, GE_D,
    LE_I, LE_U, LE_F, LE_D,
    GT_I, GT_U, GT_F, GT_D,
    EQ_IU, EQ_F, EQ_D, EQ_PTR,
    NE_IU, NE_F, NE_D, NE_PTR,
    EQ_S, NE_S,
    ISNULL, ISTRUE, ISFALSE,

    ISTC,               // copy if true
    ISFC,               // copy if false

    // --- Unary ops ---
    NOT,                // logical NOT
    NEG_I, NEG_F, NEG_D,

    // --- Binary arithmetic ---
    ADD_IU_RR, ADD_IU_RI,
    ADD_F_RR,  ADD_F_RI,
    ADD_D_RR,  ADD_D_RI,

    SUB_IU_RR, SUB_IU_RI,
    SUB_F_RR,  SUB_F_RI,
    SUB_D_RR,  SUB_D_RI,

    MUL_IU_RR, MUL_IU_RI,
    MUL_F_RR,  MUL_F_RI,
    MUL_D_RR,  MUL_D_RI,

    DIV_I_RR,  DIV_I_RI,
    DIV_U_RR,  DIV_U_RI,
    DIV_F_RR,  DIV_F_RI,
    DIV_D_RR,  DIV_D_RI,

    MOD_I_RR,  MOD_I_RI,
    MOD_U_RR,  MOD_U_RI,
    MOD_F_RR,  MOD_F_RI,
    MOD_D_RR,  MOD_D_RI,

    // --- Shift ---
    SHL_RR, SHL_RI,
    SHR_I_RR, SHR_I_RI,
    SHR_U_RR, SHR_U_RI,

    // --- Logical ---
    AND_RR,
    OR_RR,

    // --- Bitwise ---
    BAND_RR, BAND_RI, BAND_RK,
    BOR_RR,  BOR_RI,  BOR_RK,
    BXOR_RR, BXOR_RI, BXOR_RK,
    BNOT,

    // --- Type casts ---
    CAST_I_F,
    CAST_F_I,
    CAST_U_F,
    CAST_F_U,
    CAST_I_D,
    CAST_D_I,
    CAST_U_D,
    CAST_D_U,
    CAST_I_U,
    CAST_U_I,
    CAST_F_D,
    CAST_D_F,

    // --- Loops ---
    FORI,
    FORL,

    // --- Jump ---
    JMP,

    // --- Stack ---
    PUSH_I,
    PUSH_K,
    PUSH_R,
    PUSH_PTR,
    POP,
    POP_PTR,

    // --- Struct ---
    STRUCT_ALLOC_I,
    STRUCT_ALLOC_R,
    STRUCT_GET_R, STRUCT_GET_K, STRUCT_GET_I,
    STRUCT_SET_R, STRUCT_SET_K, STRUCT_SET_I,

    // --- Class ---
    CLASS_ALLOC,
    CLASS_GET_R, CLASS_GET_K, CLASS_GET_I,
    CLASS_SET_R, CLASS_SET_K, CLASS_SET_I,

    // Class interface checks (AD skip-on-true)
    OP_INTERFACE_IS_C_I,    // AD: A=obj, D=classUid. Skip next if cls->uid == D
    OP_I_HAS_M_I,           // AD: A=obj, D=methodNameId. Skip next if bitmap bit set

    // Class method access
    CLASS_GET_METHOD_R,
    CLASS_GET_METHOD_I,

    // --- Array ---
    ARRAY_ALLOC,
    ARRAY_LENGTH,
    ARRAY_EXTEND_R,
    ARRAY_EXTEND_I,
    ARRAY_SLICE,

    ARRAY_GET_R, ARRAY_GET_I, ARRAY_GET_K,
    ARRAY_SET_RR, ARRAY_SET_RI, ARRAY_SET_RK,
    ARRAY_SET_IR, ARRAY_SET_II, ARRAY_SET_IK,

    // --- Closure ---
    CLOSURE_ALLOC,
    CLOSURE_PUSH_ENV,
    CLOSURE_PUSH_ENV_PTR,
    CLOSURE_CALL,
    CLOSURE_BACK,

    // --- Coroutine ---
    CORO_ALLOC,
    CORO_ALLOC_FROM,
    CORO_STATE,
    CORO_CALL,
    CORO_YIELD,
    CORO_RETURN,
    CORO_RESET,
    CORO_FINISH,
    CORO_FN_ALLOC,

    // --- String ---
    STR_EALLOC,
    STR_ALLOC,
    STR_BALLOC,

    STR_CAT_S_R, STR_CAT_S_K,
    STR_CAT_I_R, STR_CAT_I_K,
    STR_CAT_U_R, STR_CAT_U_K,
    STR_CAT_F_R, STR_CAT_F_K,
    STR_CAT_D_R, STR_CAT_D_K,
    STR_CAT_PTR_R,

    // --- Function ---
    FN_ALLOC,
    FN_SET,
    FN_CALL,
    FN_SET_REG_I,
    FN_SET_REG,
    FN_SET_REG_PTR,
    FN_RETURN,
    FN_GET_RET_R,
    FN_GET_RET_PTR_R,

    // --- FFI ---
    FFI_REG,
    FFI_CALL,
    FFI_CLOSE,

    // --- Exception ---
    THROW,

    // --- Exit ---
    EXIT,

    // --- Dynamic Function Call ---
    FN_CALL_R,      // call function from register-held func index (dispatch frame->next)

    // --- Pointer-aware GET (sets GC pointer bitmap on load) ---
    // Currently emitted: STRUCT_GET_PTR_I, CLASS_GET_PTR_I, ARRAY_GET_PTR_R
    // Reserved for future addressing mode optimizations: _R/_K for struct/class, _I/_K for array
    STRUCT_GET_PTR_R, STRUCT_GET_PTR_K, STRUCT_GET_PTR_I,
    CLASS_GET_PTR_R, CLASS_GET_PTR_K, CLASS_GET_PTR_I,
    ARRAY_GET_PTR_R, ARRAY_GET_PTR_I, ARRAY_GET_PTR_K,
}

// === Instruction Encoding ===

export const BCBIAS_J = 0x8000;

/**
 * ABC format: [B:8 | C:8 | A:8 | OP:8]
 */
export function makeABC(op: Op, a: number, b: number, c: number): number {
    return ((op & 0xFF) | ((a & 0xFF) << 8) | ((c & 0xFF) << 16) | ((b & 0xFF) << 24)) >>> 0;
}

/**
 * AD format: [D:16 | A:8 | OP:8]
 */
export function makeAD(op: Op, a: number, d: number): number {
    return ((op & 0xFF) | ((a & 0xFF) << 8) | ((d & 0xFFFF) << 16)) >>> 0;
}

/**
 * AJ format: [J+BCBIAS_J:16 | A:8 | OP:8]
 * J is a signed offset.
 */
export function makeAJ(op: Op, a: number, j: number): number {
    return ((op & 0xFF) | ((a & 0xFF) << 8) | (((j + BCBIAS_J) & 0xFFFF) << 16)) >>> 0;
}

// === Instruction Decoding ===

export function bcOp(i: number): number { return i & 0xFF; }
export function bcA(i: number): number { return (i >>> 8) & 0xFF; }
export function bcB(i: number): number { return (i >>> 24) & 0xFF; }
export function bcC(i: number): number { return (i >>> 16) & 0xFF; }
export function bcD(i: number): number { return (i >>> 16) & 0xFFFF; }
export function bcJ(i: number): number { return bcD(i) - BCBIAS_J; }
