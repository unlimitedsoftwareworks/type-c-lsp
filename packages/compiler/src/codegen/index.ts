/**
 * Codegen barrel export
 */

export { generateBytecode } from './codegen.js';
export { Op, makeABC, makeAD, makeAJ, BCBIAS_J } from './opcodes.js';
export { ConstantPool, fitsInImmediate, fitsIn32, fitsInSigned32 } from './constant-pool.js';
export { allocateRegisters, computeLiveIntervals } from './register-allocator.js';
export type { LiveInterval, RegisterAllocation } from './register-allocator.js';
export { selectInstructions } from './instruction-selector.js';
export type { VMInstruction, SelectionResult } from './instruction-selector.js';
export { resolveLabels } from './label-resolver.js';
export { encodeBinary, BINARY_MAGIC, BINARY_VERSION, encodeTypeTag } from './binary-format.js';
export type { CompiledFunction, CompiledProgram } from './binary-format.js';
export { buildCFG, eliminatePhis, linearize, eliminateSSA } from './cfg.js';
export type { BasicBlock } from './cfg.js';
export { colorFieldSlots } from './field-coloring.js';
export type { FieldColoringResult } from './field-coloring.js';
