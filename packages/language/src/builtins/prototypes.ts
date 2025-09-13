export const prototypes = `
/**
 * @file prototypes.tc
 * @brief: Provides builtin prototypes for array and coroutine, used only by the LSP.
 */
prototype for array {
    /**
     * @brief: Returns the size of the array.
     */
    size: u64,
    
    /**
     * @brief: Resizes the array to the given size.
     * @param newSize: The new size of the array.
     */
    fn resize<T>(newSize: u64) -> T[]
}
`;