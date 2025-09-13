
/**
 * Returns the minimum storage type for an integer literal
 * @param value - The integer literal
 * @param radix - The radix of the integer literal
 * @returns The minimum storage type for the integer literal
 */
export function getMinStorageForInt(value: string, radix: number = 10): 'u8' | 'u16' | 'u32' | 'u64' | 'i8' | 'i16' | 'i32' | 'i64' {
    // Convert to decimal
    const decimalValue = parseInt(value, radix);
    
    // Find minimum bytes required
    if (decimalValue <= 255) return 'u8'; // u8: 0 to 255
    if (decimalValue <= 65535) return 'u16'; // u16: 0 to 65535
    if (decimalValue <= 4294967295) return 'u32'; // u32: 0 to 4294967295
    return 'u64'; // Default to 64-bit (i64/u64)
}

