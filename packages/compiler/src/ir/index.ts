/**
 * Type-C IR API
 *
 * A typed intermediate representation for the Type-C compiler.
 * Every value-producing instruction carries type information so the
 * lowering pass can select the correct VM instruction variant.
 */

// Type system
export type {
    SignedIntType,
    UnsignedIntType,
    IntType,
    FloatType,
    NumericType,
    ScalarType,
    PointerKind,
    ScalarIRType,
    PtrIRType,
    VoidIRType,
    IRType,
    CmpType,
    CastKind,
    IntLiteral,
    FloatLiteral,
    BoolLiteral,
    StringLiteral,
    Literal
} from './types.js';

export {
    scalarType,
    ptrType,
    voidType,
    isPointer,
    isScalar,
    isVoid,
    isSignedInt,
    isUnsignedInt,
    isInteger,
    isFloat,
    isDouble,
    isNumeric,
    isBool,
    intLiteral,
    floatLiteral,
    boolLiteral,
    stringLiteral,
    serializeIRType
} from './types.js';

// Instructions
export type {
    VReg,
    Instruction,
    IRInstruction,
    PhiPair,
    ConstIntInstruction,
    ConstFloatInstruction,
    ConstBoolInstruction,
    ConstNullInstruction,
    MovInstruction,
    AddInstruction,
    SubInstruction,
    MulInstruction,
    DivInstruction,
    ModInstruction,
    NegInstruction,
    ShlInstruction,
    ShrInstruction,
    BandInstruction,
    BorInstruction,
    BxorInstruction,
    BnotInstruction,
    CmpLtInstruction,
    CmpLeInstruction,
    CmpGtInstruction,
    CmpGeInstruction,
    CmpEqInstruction,
    CmpNeInstruction,
    CmpEqStrInstruction,
    CmpNeStrInstruction,
    IsNullInstruction,
    IsTrueInstruction,
    IsFalseInstruction,
    AndInstruction,
    OrInstruction,
    NotInstruction,
    IsTrueCopyInstruction,
    IsFalseCopyInstruction,
    LabelInstruction,
    JmpInstruction,
    BrInstruction,
    RetInstruction,
    ExitInstruction,
    ForInitInstruction,
    ForLoopInstruction,
    CallInstruction,
    CallMethodInstruction,
    CallClosureInstruction,
    CallFFIInstruction,
    StructAllocInstruction,
    StructGetInstruction,
    StructSetInstruction,
    ClassAllocInstruction,
    ClassGetInstruction,
    ClassSetInstruction,
    ClassGetMethodInstruction,
    InterfaceIsClassInstruction,
    InterfaceHasMethodInstruction,
    ArrayAllocInstruction,
    ArrayGetInstruction,
    ArraySetInstruction,
    ArrayLengthInstruction,
    ArrayExtendInstruction,
    ArraySliceInstruction,
    StrConstInstruction,
    StrAllocEmptyInstruction,
    StrConcatInstruction,
    StrFromBytesInstruction,
    ClosureAllocInstruction,
    ClosurePushEnvInstruction,
    ClosureRetInstruction,
    CoroAllocInstruction,
    CoroStateInstruction,
    CoroCallInstruction,
    CoroYieldInstruction,
    CoroRetInstruction,
    CoroResetInstruction,
    CoroFinishInstruction,
    GlobalLoadInstruction,
    GlobalStoreInstruction,
    WidenInstruction,
    NarrowInstruction,
    CastInstruction,
    PhiInstruction,
    UndefInstruction,
    FFIRegisterInstruction,
    FFICloseInstruction,
    ThrowInstruction,
    DebugInstruction
} from './instructions.js';

// Builder
export type {
    FunctionParam,
    StructFieldShape,
    StructShape,
    ClassFieldShape,
    ClassMethodShape,
    ClassShape,
    GlobalDecl
} from './builder.js';

export { IRFunction, IRProgram } from './builder.js';

// Serializer
export { serializeFunction, serializeProgram, toLIRFile } from './serializer.js';
