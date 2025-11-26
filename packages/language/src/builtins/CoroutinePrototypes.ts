export const coroutinePrototype = `
/**
 * @file CoroutinePrototypes.tc
 * @brief: Provides builtin prototypes for coroutines, used only by the LSP.
 */
prototype for coroutine {
    /**
     * @brief: State that indicates whether the coroutine is alive, i.e Can be called
     */
    alive: bool
    
    /**
     * @brief: Exact state of the coroutine.
     */
    state: enum as u8 {
        /**
         * @brief: The coroutine is ready to be called, in waiting mode.
         * This is the initial state of a coroutine, prior to its first call.
         */
        Ready = 0u8,

        /**
         * @brief: The coroutine is currently running. 
         * Useful if you are accessing the coroutine from within itself.
         */
        Running = 1u8,

        /**
         * @brief: The coroutine is suspended, i.e it yielded and can be resumed.
         */
        Suspended = 2u8,

        /**
         * @brief: The coroutine has finished execution and cannot be resumed.
         */
        Completed = 3u8
    }

    /**
     * @brief: Returns the element at the given index.
     * @param start: The start index of the slice.
     * @param end: The end index of the slice.
     */
    fn reset() -> void

    fn finish() -> void
}
`;