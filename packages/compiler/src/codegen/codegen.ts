/**
 * Code Generation Pipeline Orchestrator
 *
 * Ties together all lowering phases:
 *   Phase 0: Field coloring (field-coloring.ts)
 *   Phase 1: SSA elimination (cfg.ts)
 *   Phase 2: Register allocation (register-allocator.ts)
 *   Phase 3: Instruction selection (instruction-selector.ts)
 *   Phase 4: Label resolution (label-resolver.ts)
 *   Phase 5: Binary encoding (binary-format.ts)
 *
 * Input:  IRProgram (from compiler front-end)
 * Output: Uint8Array (Type-V bytecode binary)
 */

import type { IRProgram, IRFunction } from '../ir/builder.js';
import { colorFieldSlots } from './field-coloring.js';
import { colorMethodSlots } from './method-coloring.js';
import { eliminateSSA } from './cfg.js';
import { allocateRegisters } from './register-allocator.js';
import { selectInstructions } from './instruction-selector.js';
import { resolveLabels } from './label-resolver.js';
import {
    encodeBinary,
    type CompiledFunction,
    type CompiledProgram,
} from './binary-format.js';

// === Phase 0: Field Coloring — rewrite nameIds to colored slots ===

function applyFieldColoring(program: IRProgram): void {
    const coloring = colorFieldSlots(program.structShapes);
    program.numFieldSlots = coloring.numSlots;

    // Rewrite struct shape metadata: globalFieldId (nameId) → slot
    for (const shape of program.structShapes) {
        for (const field of shape.fields) {
            const slot = coloring.slotMap.get(field.globalFieldId);
            if (slot !== undefined) {
                field.globalFieldId = slot;
            }
        }
    }

    // Rewrite all struct_get/struct_set instructions: fieldId (nameId) → slot
    for (const fn of program.functions) {
        for (const inst of fn.instructions) {
            if (inst.kind === 'struct_get' || inst.kind === 'struct_set') {
                const slot = coloring.slotMap.get(inst.fieldId);
                if (slot !== undefined) {
                    inst.fieldId = slot;
                }
            }
        }
    }
}

// === Phase 0b: Method Coloring — rewrite nameIds to colored slots ===

function applyMethodColoring(program: IRProgram): void {
    const coloring = colorMethodSlots(program.classShapes);
    program.numMethodSlots = coloring.numSlots;

    // Rewrite class shape metadata: methodId (nameId) → slot
    for (const shape of program.classShapes) {
        for (const method of shape.methods) {
            const slot = coloring.slotMap.get(method.methodId);
            if (slot !== undefined) {
                method.methodId = slot;
            }
        }
    }

    // Rewrite all call_method instructions: methodId (nameId) → slot
    for (const fn of program.functions) {
        for (const inst of fn.instructions) {
            if (inst.kind === 'call_method') {
                const slot = coloring.slotMap.get(inst.methodId);
                if (slot !== undefined) {
                    inst.methodId = slot;
                }
            }
        }
    }
}

// === Per-Function Compilation ===

function compileFunction(fn: IRFunction, stringConstants: string[], funcNameToIndex: Map<string, number>): CompiledFunction {
    // Phase 1: SSA elimination
    const flatInstructions = eliminateSSA(fn.instructions);

    // Phase 2: Register allocation
    const allocation = allocateRegisters(
        flatInstructions,
        fn.params,
        fn.returnTypes.length
    );

    // Phase 3: Instruction selection
    const { instructions: vmInstructions, constantPool } = selectInstructions(
        flatInstructions,
        allocation.regMap,
        allocation.pointerRegs,
        stringConstants,
        funcNameToIndex
    );

    // Phase 4: Label resolution
    const code = resolveLabels(vmInstructions);

    // Encode constant pool
    const constPoolEncoded = constantPool.encode();

    return {
        name: fn.name,
        numParams: fn.params.length,
        numReturns: fn.returnTypes.length,
        isCoroutine: fn.isCoroutine,
        isClosure: fn.isClosure,
        maxRegUsed: allocation.maxRegUsed,
        pointerRegs: allocation.pointerRegs,
        constantPool: constPoolEncoded,
        code,
    };
}

// === Program-Level Compilation ===

export function generateBytecode(program: IRProgram): Uint8Array {
    // Phase 0: Field coloring (must run before per-function compilation)
    applyFieldColoring(program);

    // Phase 0b: Method coloring (must run before per-function compilation)
    applyMethodColoring(program);

    // Build string pool early — needed by instruction selector for FFI library names
    const strings = [...program.stringConstants];
    // Collect FFI library names from ffi_register instructions
    for (const fn of program.functions) {
        for (const inst of fn.instructions) {
            if (inst.kind === 'ffi_register' && !strings.includes(inst.libName)) {
                strings.push(inst.libName);
            }
        }
    }
    // Include function names
    for (const fn of program.functions) {
        if (!strings.includes(fn.name)) {
            strings.push(fn.name);
        }
    }

    // Build function name → index map
    const funcNameToIndex = new Map<string, number>();
    for (let i = 0; i < program.functions.length; i++) {
        funcNameToIndex.set(program.functions[i].name, i);
    }

    // Compile all functions (pass string pool for FFI name resolution)
    const compiledFunctions: CompiledFunction[] = [];
    for (const fn of program.functions) {
        compiledFunctions.push(compileFunction(fn, strings, funcNameToIndex));
    }

    // Map globals
    const globals = program.globals.map(g => ({ type: g.type }));

    // Map struct shapes (globalFieldId is now the colored slot number)
    const structs = program.structShapes.map(s => ({
        fields: s.fields.map(f => ({
            slotNumber: f.globalFieldId,
            type: f.type,
        })),
    }));

    // Map class shapes
    const classes = program.classShapes.map(c => ({
        uid: c.uid,
        fields: c.fields.map(f => ({
            localFieldId: f.localFieldId,
            type: f.type,
        })),
        methods: c.methods.map(m => ({
            methodId: m.methodId,
            funcIndex: funcNameToIndex.get(m.funcName) ?? 0xFFFF,
        })),
    }));

    // Find entry function index
    const entryFuncIndex = funcNameToIndex.get(program.entryFunction) ?? 0;

    // Phase 5: Binary encoding
    const compiled: CompiledProgram = {
        strings,
        globals,
        structs,
        classes,
        functions: compiledFunctions,
        entryFuncIndex,
        numFieldSlots: program.numFieldSlots,
        numMethodSlots: program.numMethodSlots,
    };

    return encodeBinary(compiled);
}
