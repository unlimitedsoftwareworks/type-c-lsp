export const prototypes = `
/**
 * @file prototypes.tc
 * @brief: Provides builtin prototypes for array and coroutine, used only by the LSP.
 */
prototype for array {
    /**
     * @brief: Returns the length of the array.
     */
    length: u64
    
    /**
     * @brief: Resizes the array to the given length.
     * @param newSize: The new length of the array.
     */
    fn resize<T>(newLength: u64) -> void

    /**
     * @brief: Returns the element at the given index.
     * @param start: The start index of the slice.
     * @param end: The end index of the slice.
     */
    fn slice<T>(start: u64, end: u64) -> T[]
}
`;