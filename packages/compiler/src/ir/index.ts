/**
 * LIR API - Self-contained IR modeling API
 * Independent of Langium
 */

// Export all types
export * from './types.js';

// Export all instruction interfaces
export * from './instructions.js';

// Export builder classes
export { LIRFunction, LIRProgram, FunctionArg } from './builder.js';

// Export serializer
export { serializeProgram, toLIRFile } from './serializer.js';