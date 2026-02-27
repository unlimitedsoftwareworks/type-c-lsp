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
            if (slot === undefined) {
                throw new Error(`Field coloring: no slot assigned for field nameId ${field.globalFieldId} in struct shape`);
            }
            field.globalFieldId = slot;
        }
    }

    // Rewrite all struct_get/struct_set instructions: fieldId (nameId) → slot
    for (const fn of program.functions) {
        for (const inst of fn.instructions) {
            if (inst.kind === 'struct_get' || inst.kind === 'struct_set') {
                const slot = coloring.slotMap.get(inst.fieldId);
                if (slot === undefined) {
                    throw new Error(`Field coloring: no slot assigned for field nameId ${inst.fieldId} in ${inst.kind} instruction (function '${fn.name}')`);
                }
                inst.fieldId = slot;
            }
        }
    }
}

// === Phase 0b: Method Coloring — rewrite nameIds to colored slots ===

function applyMethodColoring(program: IRProgram): Map<string, Set<number>> {
    // Snapshot original nameIds per class BEFORE coloring overwrites them
    const classOriginalNameIds = new Map<string, Set<number>>();
    for (const shape of program.classShapes) {
        const nameIds = new Set<number>();
        for (const method of shape.methods) {
            nameIds.add(method.methodId);
        }
        classOriginalNameIds.set(shape.id, nameIds);
    }

    const coloring = colorMethodSlots(program.classShapes);
    program.numMethodSlots = coloring.numSlots;

    // Rewrite class shape metadata: methodId (nameId) → slot
    for (const shape of program.classShapes) {
        for (const method of shape.methods) {
            const slot = coloring.slotMap.get(method.methodId);
            if (slot === undefined) {
                throw new Error(`Method coloring: no slot assigned for method nameId ${method.methodId} in class shape '${shape.id}'`);
            }
            method.methodId = slot;
        }
    }

    // Rewrite all call_method instructions: methodId (nameId) → slot
    for (const fn of program.functions) {
        for (const inst of fn.instructions) {
            if (inst.kind === 'call_method') {
                const slot = coloring.slotMap.get(inst.methodId);
                if (slot === undefined) {
                    throw new Error(`Method coloring: no slot assigned for method nameId ${inst.methodId} in call_method instruction (function '${fn.name}')`);
                }
                inst.methodId = slot;
            }
        }
    }

    return classOriginalNameIds;
}

// === Per-Function Compilation ===

function compileFunction(
    fn: IRFunction,
    stringConstants: string[],
    funcNameToIndex: Map<string, number>,
    classIdToIndex: Map<string, number>,
    structIdToIndex: Map<string, number>,
    globalIdToIndex: Map<string, number>
): CompiledFunction {
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
        stringConstants,
        funcNameToIndex,
        classIdToIndex,
        structIdToIndex,
        globalIdToIndex,
        fn.name
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
        constantPool: constPoolEncoded,
        code,
    };
}

function collectReachableCode(program: IRProgram): {
    readonly functions: IRFunction[];
    readonly classes: IRProgram['classShapes'];
    readonly structs: IRProgram['structShapes'];
} {
    const functionByName = new Map<string, IRFunction>();
    for (const fn of program.functions) {
        functionByName.set(fn.name, fn);
    }

    const classById = new Map<string, IRProgram['classShapes'][number]>();
    for (const shape of program.classShapes) {
        classById.set(shape.id, shape);
    }

    const reachableFunctionNames = new Set<string>();
    const reachableClassIds = new Set<string>();
    const reachableStructIds = new Set<string>();
    const functionQueue: string[] = [];
    const classQueue: string[] = [];

    const enqueueFunction = (name: string): void => {
        if (!reachableFunctionNames.has(name)) {
            reachableFunctionNames.add(name);
            functionQueue.push(name);
        }
    };

    const enqueueClass = (id: string): void => {
        if (!reachableClassIds.has(id)) {
            reachableClassIds.add(id);
            classQueue.push(id);
        }
    };

    const enqueueStruct = (id: string): void => {
        if (!reachableStructIds.has(id)) {
            reachableStructIds.add(id);
        }
    };

    enqueueFunction(program.entryFunction);

    while (functionQueue.length > 0 || classQueue.length > 0) {
        while (functionQueue.length > 0) {
            const functionName = functionQueue.pop()!;
            const fn = functionByName.get(functionName);
            if (!fn) {
                continue;
            }

            for (const inst of fn.instructions) {
                if (inst.kind === 'call') {
                    enqueueFunction(inst.func);
                } else if (inst.kind === 'closure_alloc' || inst.kind === 'coro_alloc') {
                    enqueueFunction(inst.funcName);
                } else if (inst.kind === 'class_alloc') {
                    enqueueClass(inst.typeId);
                } else if (inst.kind === 'struct_alloc') {
                    enqueueStruct(inst.typeId);
                }
            }
        }

        while (classQueue.length > 0) {
            const classId = classQueue.pop()!;
            const shape = classById.get(classId);
            if (!shape) {
                continue;
            }
            for (const method of shape.methods) {
                enqueueFunction(method.funcName);
            }
        }
    }

    const functions = program.functions.filter(fn => reachableFunctionNames.has(fn.name));
    const classes = program.classShapes.filter(shape => reachableClassIds.has(shape.id));
    const structs = program.structShapes.filter(shape => reachableStructIds.has(shape.id));
    return { functions, classes, structs };
}

// === Program-Level Compilation ===

export function generateBytecode(program: IRProgram): Uint8Array {
    // Phase 0: Field coloring (must run before per-function compilation)
    applyFieldColoring(program);

    // Phase 0b: Method coloring (must run before per-function compilation)
    const classOriginalNameIds = applyMethodColoring(program);

    const reachable = collectReachableCode(program);

    // Build string pool early — needed by instruction selector for FFI library names
    const strings = [...program.stringConstants];
    // Collect FFI library names from ffi_register instructions
    for (const fn of reachable.functions) {
        for (const inst of fn.instructions) {
            if (inst.kind === 'ffi_register' && !strings.includes(inst.libName)) {
                strings.push(inst.libName);
            }
        }
    }
    // Include function names
    for (const fn of reachable.functions) {
        if (!strings.includes(fn.name)) {
            strings.push(fn.name);
        }
    }

    // Build function name → index map
    const funcNameToIndex = new Map<string, number>();
    for (let i = 0; i < reachable.functions.length; i++) {
        funcNameToIndex.set(reachable.functions[i].name, i);
    }

    const requireFunctionIndex = (name: string, context: string): number => {
        const idx = funcNameToIndex.get(name);
        if (idx === undefined) {
            throw new Error(`Unresolved function target '${name}' while generating ${context}`);
        }
        return idx;
    };

    // Build shape id → index maps for CLASS_ALLOC / STRUCT_ALLOC resolution
    const classIdToIndex = new Map<string, number>();
    for (let i = 0; i < reachable.classes.length; i++) {
        classIdToIndex.set(reachable.classes[i].id, i);
    }
    const structIdToIndex = new Map<string, number>();
    for (let i = 0; i < reachable.structs.length; i++) {
        structIdToIndex.set(reachable.structs[i].id, i);
    }
    const globalIdToIndex = new Map<string, number>();
    for (let i = 0; i < program.globals.length; i++) {
        globalIdToIndex.set(program.globals[i].id, i);
    }

    // Compile all functions (pass string pool for FFI name resolution)
    const compiledFunctions: CompiledFunction[] = [];
    for (const fn of reachable.functions) {
        compiledFunctions.push(compileFunction(fn, strings, funcNameToIndex, classIdToIndex, structIdToIndex, globalIdToIndex));
    }

    // Map globals
    const globals = program.globals.map(g => ({ type: g.type }));

    // Map struct shapes (globalFieldId is now the colored slot number)
    const structs = reachable.structs.map(s => ({
        fields: s.fields.map(f => ({
            slotNumber: f.globalFieldId,
            type: f.type,
        })),
    }));

    // Map class shapes (build per-class method name bitmaps from pre-coloring snapshot)
    const numMethodNames = program.numMethodNames;
    const bitmapWords = numMethodNames > 0 ? Math.ceil(numMethodNames / 64) : 0;

    const classes = reachable.classes.map(c => {
        const bitmap: bigint[] = new Array(bitmapWords).fill(0n);
        const originalIds = classOriginalNameIds.get(c.id);
        if (originalIds) {
            for (const nameId of originalIds) {
                const wordIdx = Math.floor(nameId / 64);
                const bitIdx = nameId % 64;
                if (wordIdx < bitmapWords) {
                    bitmap[wordIdx] |= (1n << BigInt(bitIdx));
                }
            }
        }
        // Build field pointer bitmap: 4 × u64 (256 bits)
        const ptrBitmap: bigint[] = [0n, 0n, 0n, 0n];
        for (const f of c.fields) {
            if (f.type.tag === 'ptr') {
                const wordIdx = Math.floor(f.localFieldId / 64);
                const bitIdx = f.localFieldId % 64;
                ptrBitmap[wordIdx] |= (1n << BigInt(bitIdx));
            }
        }

        return {
            uid: c.uid,
            fields: c.fields.map(f => ({
                localFieldId: f.localFieldId,
                type: f.type,
            })),
            methods: c.methods.map(m => ({
                methodId: m.methodId,
                funcIndex: requireFunctionIndex(m.funcName, `class shape '${c.id}' method '${m.name}'`),
            })),
            methodNameBitmap: bitmap,
            ptrBitmap,
        };
    });

    // Find entry function index
    const entryFuncIndex = requireFunctionIndex(program.entryFunction, 'entry point');

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
        numMethodNames: program.numMethodNames,
    };

    return encodeBinary(compiled);
}
