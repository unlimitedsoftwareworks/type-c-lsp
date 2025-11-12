import { TypeDescription, TypeKind } from "../typing/type-c-types.js";

/**
 * Helper method to check if a type is numeric
 */
export function isNumericType(type: TypeDescription): boolean {
    const numericKinds = [
        TypeKind.U8, TypeKind.U16, TypeKind.U32, TypeKind.U64,
        TypeKind.I8, TypeKind.I16, TypeKind.I32, TypeKind.I64,
        TypeKind.F32, TypeKind.F64
    ];
    return numericKinds.includes(type.kind);
}