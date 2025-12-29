/**
 * Tests for Monomorphization Service
 *
 * Verifies that generic instantiations are correctly tracked during type checking
 * for use in code generation.
 */

import { describe, expect, test, beforeAll } from 'vitest';
import { setupLanguageServices, clearFileDocuments } from './test-utils.js';
import { ClassInstantiation, MethodInstantiation, FunctionInstantiation } from '../src/typing/monomorphization-service.js';

describe('Monomorphization Service', () => {
    const setup = setupLanguageServices();

    beforeAll(async () => {
        await setup.initialized;
    });

    test('should register class instantiation for Array<u32>', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
                fn init(){}
            }

            let arr1: Array<u32> = new Array<u32>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const stats = registry.getStats();
        
        // Should have registered Array<u32>
        expect(stats.classCount).toBeGreaterThan(0);
        
        const allClasses = registry.getAllClassInstantiations();
        const arrayU32 = allClasses.find((c: ClassInstantiation) => c.key === 'Array<u32>');
        
        expect(arrayU32).toBeDefined();
        expect(arrayU32?.declaration.name).toBe('Array');
        expect(arrayU32?.typeArgs).toHaveLength(1);
        expect(arrayU32?.typeArgs[0].toString()).toBe('u32');
    });

    test('should register multiple class instantiations', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
            }

            let arr1: Array<u32> = new Array<u32>()
            let arr2: Array<string> = new Array<string>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        
        // Should have Array<u32> and Array<string>
        expect(allClasses.length).toBeGreaterThanOrEqual(2);
        
        const keys = allClasses.map((c: ClassInstantiation) => c.key).sort();
        expect(keys).toContain('Array<u32>');
        expect(keys).toContain('Array<string>');
    });

    test('should register method instantiation for generic method', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
                
                fn map<U>(f: fn(T) -> U) -> Array<U> {
                    let arr: U[] = []
                    return new Array<U>(arr)
                }
            }

            let arr1: Array<u32> = new Array<u32>()
            let arr2 = arr1.map(fn(x: u32) = "hi")
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const stats = registry.getStats();
        
        // Should have registered at least Array<u32> and Array<string>
        expect(stats.classCount).toBeGreaterThanOrEqual(2);
        
        // Should have registered the map<string> method
        expect(stats.methodCount).toBeGreaterThan(0);
        
        const allMethods = Array.from((registry as any).methods.values()) as MethodInstantiation[];
        const mapMethods = allMethods.filter((m: MethodInstantiation) => m.key.includes('map'));
        
        expect(mapMethods.length).toBeGreaterThan(0);
    });

    
    test('should register method instantiation for generic method (2)', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
                
                fn map<U>(f: fn(T) -> U) -> Array<U> {
                    let arr: U[] = []
                    return new Array<U>(arr)
                }
            }

            type U32Array = Array<u32>

            let arr1: U32Array = new U32Array()
            let arr2 = arr1.map(fn(x: u32) = "hi")
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const stats = registry.getStats();
        
        // Should have registered at least Array<u32> and Array<string>
        expect(stats.classCount).toBeGreaterThanOrEqual(2);
        
        // Should have registered the map<string> method
        expect(stats.methodCount).toBeGreaterThan(0);
        
        const allMethods = Array.from((registry as any).methods.values()) as MethodInstantiation[];
        const mapMethods = allMethods.filter((m: MethodInstantiation) => m.key.includes('map'));
        
        expect(mapMethods.length).toBeGreaterThan(0);
    });

    test('should register method instantiation with nested aliases', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
                
                fn map<U>(f: fn(T) -> U) -> Array<U> {
                    let arr: U[] = []
                    return new Array<U>(arr)
                }
            }

            type U32Array = Array<u32>
            type MyArray = U32Array

            let arr1: MyArray = new MyArray()
            let arr2 = arr1.map(fn(x: u32) = "hi")
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const stats = registry.getStats();
        
        // Should have registered at least Array<u32> and Array<string>
        expect(stats.classCount).toBeGreaterThanOrEqual(2);
        
        // Should have registered the map<string> method
        expect(stats.methodCount).toBeGreaterThan(0);
        
        const allMethods = Array.from((registry as any).methods.values()) as MethodInstantiation[];
        const mapMethods = allMethods.filter((m: MethodInstantiation) => m.key.includes('map'));
        
        expect(mapMethods.length).toBeGreaterThan(0);
    });

    test('should register multiple method calls on different alias instantiations', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
                
                fn map<U>(f: fn(T) -> U) -> Array<U> {
                    let arr: U[] = []
                    return new Array<U>(arr)
                }
            }

            type U32Array = Array<u32>
            type StringArray = Array<string>

            let arr1: U32Array = new U32Array()
            let arr2: StringArray = new StringArray()
            let arr3 = arr1.map(fn(x: u32) = "hi")
            let arr4 = arr2.map(fn(x: string) = 42u32)
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const stats = registry.getStats();
        
        // Should have registered Array<u32>, Array<string>, and their map instantiations
        expect(stats.classCount).toBeGreaterThanOrEqual(2);
        expect(stats.methodCount).toBeGreaterThanOrEqual(2);
        
        const allMethods = Array.from((registry as any).methods.values()) as MethodInstantiation[];
        const mapMethods = allMethods.filter((m: MethodInstantiation) => m.key.includes('map'));
        
        // Should have map<string> from U32Array and map<u32> from StringArray
        expect(mapMethods.length).toBeGreaterThanOrEqual(2);
    });

    test('should register function instantiation', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            fn identity<T>(x: T) -> T = x

            let x = identity<u32>(42u32)
            let y = identity<string>("hello")
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const stats = registry.getStats();
        
        // Should have registered identity<u32> and identity<string>
        expect(stats.functionCount).toBeGreaterThanOrEqual(2);
        
        const allFunctions = registry.getAllFunctionInstantiations();
        const keys = allFunctions.map((f: FunctionInstantiation) => f.key).sort();
        
        expect(keys).toContain('identity<u32>');
        expect(keys).toContain('identity<string>');
    });

    test('should generate correct mangled names', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
            }

            let arr: Array<u32> = new Array<u32>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        const arrayU32 = allClasses.find((c: ClassInstantiation) => c.key === 'Array<u32>');
        
        expect(arrayU32).toBeDefined();
        
        const mangledName = registry.mangleName(arrayU32!.key);
        expect(mangledName).toBe('Array$u32');
    });

    test('should handle nested generics in mangling', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
            }
            
            type Matrix<T> = class {
                let rows: Array<Array<T>> = new Array<Array<T>>()
            }

            let mat: Matrix<f32> = new Matrix<f32>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        
        // Find Array<Array<f32>> instantiation
        const allClasses = registry.getAllClassInstantiations();
        const nestedArray = allClasses.find((c: ClassInstantiation) => c.key.includes('Array<Array<f32>>'));
        
        if (nestedArray) {
            const mangledName = registry.mangleName(nestedArray.key);
            // Should replace < > , with $ and remove spaces
            expect(mangledName).not.toContain('<');
            expect(mangledName).not.toContain('>');
            expect(mangledName).not.toContain(',');
        }
    });

    test('should not register non-generic classes', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Point = class {
                let x: f32 = 0.0f
                let y: f32 = 0.0f
            }

            let p: Point = new Point()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const stats = registry.getStats();
        
        // Should not register Point since it's not generic
        expect(stats.classCount).toBe(0);
    });

    test('should clear registry', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
            }

            let arr: Array<u32> = new Array<u32>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        let stats = registry.getStats();
        
        expect(stats.classCount).toBeGreaterThan(0);
        
        // Clear the registry
        registry.clear();
        stats = registry.getStats();
        
        expect(stats.classCount).toBe(0);
        expect(stats.methodCount).toBe(0);
        expect(stats.functionCount).toBe(0);
    });

    // ============================================================================
    // Advanced Tests: Multiple Generic Parameters
    // ============================================================================

    test('should register Map<K,V> with two type parameters', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Map<K, V> = class {
                let keys: K[] = []
                let values: V[] = []
                
                fn get(key: K) -> V? {
                    return null
                }
            }

            let strToInt: Map<string, u32> = new Map<string, u32>()
            let intToStr: Map<u32, string> = new Map<u32, string>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        
        expect(allClasses.length).toBeGreaterThanOrEqual(2);
        
        const keys = allClasses.map((c: ClassInstantiation) => c.key).sort();
        expect(keys).toContain('Map<string,u32>');
        expect(keys).toContain('Map<u32,string>');
    });

    test('should register Result<T,E> with success and error types', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Result<T, E> = class {
                let value: T? = null
                let error: E? = null
                
                fn isOk() -> bool {
                    return this.value != null
                }
            }

            let res1: Result<u32, string> = new Result<u32, string>()
            let res2: Result<string, u32> = new Result<string, u32>()
            let res3: Result<bool, string> = new Result<bool, string>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        
        expect(allClasses.length).toBeGreaterThanOrEqual(3);
        
        const keys = allClasses.map((c: ClassInstantiation) => c.key).sort();
        expect(keys).toContain('Result<u32,string>');
        expect(keys).toContain('Result<string,u32>');
        expect(keys).toContain('Result<bool,string>');
    });

    // ============================================================================
    // Advanced Tests: Deeply Nested Generic Types
    // ============================================================================

    test('should register deeply nested generic types (3 levels)', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
            }
            
            type Result<T, E> = class {
                let value: T? = null
            }
            
            // Array<Result<Array<u32>, string>>
            let nested: Array<Result<Array<u32>, string>> = new Array<Result<Array<u32>, string>>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        
        // Should have Array<u32>, Result<Array<u32>,string>, Array<Result<Array<u32>,string>>
        expect(allClasses.length).toBeGreaterThanOrEqual(3);
        
        const keys = allClasses.map((c: ClassInstantiation) => c.key);
        expect(keys).toContain('Array<u32>');
        expect(keys.some(k => k.includes('Result'))).toBe(true);
    });

    test('should register 4-level nested generics', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Box<T> = class {
                let value: T? = null
            }
            
            type Array<T> = class {
                let data: T[] = []
            }
            
            // Box<Array<Box<Array<u32>>>>
            let deep: Box<Array<Box<Array<u32>>>> = new Box<Array<Box<Array<u32>>>>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        
        // Should register multiple levels: Array<u32>, Box<Array<u32>>, Array<Box<Array<u32>>>, Box<Array<Box<Array<u32>>>>
        expect(allClasses.length).toBeGreaterThanOrEqual(4);
    });

    // ============================================================================
    // Advanced Tests: Generic Methods with Multiple Parameters
    // ============================================================================

    test('should register generic methods with multiple type parameters', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
                
                fn zip<U>(other: Array<U>) -> Array<Array<T>> {
                    return new Array<Array<T>>()
                }
            }

            let arr1: Array<u32> = new Array<u32>()
            let arr2: Array<string> = new Array<string>()
            let zipped = arr1.zip<string>(arr2)
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const stats = registry.getStats();
        
        expect(stats.methodCount).toBeGreaterThan(0);
        
        const allMethods = Array.from((registry as any).methods.values()) as MethodInstantiation[];
        const zipMethods = allMethods.filter((m: MethodInstantiation) => m.key.includes('zip'));
        
        expect(zipMethods.length).toBeGreaterThan(0);
    });

    test('should register methods with both class and method generics', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Container<T> = class {
                let value: T? = null
                
                fn transform<U, V>(f1: fn(T) -> U, f2: fn(U) -> V) -> V? {
                    return null
                }
            }

            let c: Container<u32> = new Container<u32>()
            let result = c.transform<string, bool>(
                fn(x: u32) = "test",
                fn(s: string) = true
            )
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allMethods = Array.from((registry as any).methods.values()) as MethodInstantiation[];
        
        expect(allMethods.length).toBeGreaterThan(0);
        
        const transformMethods = allMethods.filter((m: MethodInstantiation) =>
            m.key.includes('transform')
        );
        
        expect(transformMethods.length).toBeGreaterThan(0);
        
        // Verify method has both class and method type args
        const transformMethod = transformMethods[0];
        expect(transformMethod.classTypeArgs.length).toBeGreaterThan(0);
        expect(transformMethod.methodTypeArgs.length).toBeGreaterThan(0);
    });

    // ============================================================================
    // Advanced Tests: Generic Functions with Complex Signatures
    // ============================================================================

    test('should register generic functions with multiple parameters', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            fn zip<T, U>(arr1: T[], arr2: U[]) -> T[] {
                return arr1
            }

            let nums: u32[] = []
            let strs: string[] = []
            let result = zip<u32, string>(nums, strs)
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allFunctions = registry.getAllFunctionInstantiations();
        
        expect(allFunctions.length).toBeGreaterThanOrEqual(1);
        
        const zipFunc = allFunctions.find((f: FunctionInstantiation) =>
            f.key.includes('zip')
        );
        
        expect(zipFunc).toBeDefined();
        expect(zipFunc?.typeArgs.length).toBe(2);
    });

    test('should register generic functions with function type parameters', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            fn map<T, U>(arr: T[], f: fn(T) -> U) -> U[] {
                let result: U[] = []
                return result
            }

            let nums: u32[] = []
            let strs = map<u32, string>(nums, fn(x: u32) = "test")
            let bools = map<string, bool>(strs, fn(s: string) = true)
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allFunctions = registry.getAllFunctionInstantiations();
        
        expect(allFunctions.length).toBeGreaterThanOrEqual(2);
        
        const keys = allFunctions.map((f: FunctionInstantiation) => f.key).sort();
        expect(keys).toContain('map<u32,string>');
        expect(keys).toContain('map<string,bool>');
    });

    // ============================================================================
    // Advanced Tests: Nullable Generic Types
    // ============================================================================

    test('should register nullable generic types', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Option<T> = class {
                let value: T? = null
                
                fn isSome() -> bool {
                    return this.value != null
                }
            }

            let opt1: Option<u32?> = new Option<u32?>()
            let opt2: Option<string?> = new Option<string?>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        
        expect(allClasses.length).toBeGreaterThanOrEqual(2);
        
        // Should handle nullable type args correctly
        const keys = allClasses.map((c: ClassInstantiation) => c.key);
        expect(keys.some(k => k.includes('Option'))).toBe(true);
    });

    // ============================================================================
    // Advanced Tests: Deduplication and Consistency
    // ============================================================================

    test('should deduplicate identical instantiations', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
            }

            let arr1: Array<u32> = new Array<u32>()
            let arr2: Array<u32> = new Array<u32>()
            let arr3: Array<u32> = new Array<u32>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        
        // Should only register Array<u32> once despite 3 uses
        const arrayU32Count = allClasses.filter((c: ClassInstantiation) =>
            c.key === 'Array<u32>'
        ).length;
        
        expect(arrayU32Count).toBe(1);
    });

    test('should handle type aliases consistently', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
            }

            type IntArray = Array<u32>
            type AnotherIntArray = Array<u32>

            let arr1: IntArray = new IntArray()
            let arr2: AnotherIntArray = new AnotherIntArray()
            let arr3: Array<u32> = new Array<u32>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        
        // All three should resolve to the same Array<u32> instantiation
        const arrayU32Count = allClasses.filter((c: ClassInstantiation) =>
            c.key === 'Array<u32>'
        ).length;
        
        expect(arrayU32Count).toBe(1);
    });

    // ============================================================================
    // Advanced Tests: Real-World Patterns
    // ============================================================================

    test('should handle Option<T> pattern correctly', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Option<T> = class {
                let value: T? = null
                
                fn map<U>(f: fn(T) -> U) -> Option<U> {
                    return new Option<U>()
                }
                
                fn flatMap<U>(f: fn(T) -> Option<U>) -> Option<U> {
                    return new Option<U>()
                }
            }

            let opt: Option<u32> = new Option<u32>()
            let mapped = opt.map<string>(fn(x: u32) = "test")
            let flatMapped = mapped.flatMap<bool>(fn(s: string) = new Option<bool>())
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        
        // Should register Option<u32>, Option<string>, Option<bool>
        expect(allClasses.length).toBeGreaterThanOrEqual(3);
        
        const keys = allClasses.map((c: ClassInstantiation) => c.key).sort();
        expect(keys).toContain('Option<u32>');
        expect(keys).toContain('Option<string>');
        expect(keys).toContain('Option<bool>');
    });

    test('should handle Result<T,E> with chaining methods', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Result<T, E> = class {
                let value: T? = null
                let error: E? = null
                
                fn map<U>(f: fn(T) -> U) -> Result<U, E> {
                    return new Result<U, E>()
                }
                
                fn mapErr<F>(f: fn(E) -> F) -> Result<T, F> {
                    return new Result<T, F>()
                }
            }

            let res: Result<u32, string> = new Result<u32, string>()
            let mapped = res.map<bool>(fn(x: u32) = true)
            let errMapped = mapped.mapErr<u32>(fn(e: string) = 0u32)
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const stats = registry.getStats();
        
        // Should register multiple Result instantiations and methods
        expect(stats.classCount).toBeGreaterThanOrEqual(3);
        expect(stats.methodCount).toBeGreaterThanOrEqual(2);
    });

    test('should handle Iterator pattern with generic yield types', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Iterator<T> = class {
                let data: T[] = []
                
                fn next() -> T? {
                    return null
                }
                
                fn map<U>(f: fn(T) -> U) -> Iterator<U> {
                    return new Iterator<U>()
                }
                
                fn filter(pred: fn(T) -> bool) -> Iterator<T> {
                    return new Iterator<T>()
                }
            }

            let iter: Iterator<u32> = new Iterator<u32>()
            let mapped = iter.map<string>(fn(x: u32) = "test")
            let filtered = iter.filter(fn(x: u32) = true)
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        
        // Should register Iterator<u32> and Iterator<string>
        expect(allClasses.length).toBeGreaterThanOrEqual(2);
        
        const keys = allClasses.map((c: ClassInstantiation) => c.key).sort();
        expect(keys).toContain('Iterator<u32>');
        expect(keys).toContain('Iterator<string>');
    });

    // ============================================================================
    // Advanced Tests: Complex Mixed Scenarios
    // ============================================================================

    test('should handle complex scenario with classes, methods, and functions', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
                
                fn map<U>(f: fn(T) -> U) -> Array<U> {
                    return new Array<U>()
                }
            }
            
            fn reduce<T, U>(arr: Array<T>, init: U, f: fn(U, T) -> U) -> U {
                return init
            }

            let nums: Array<u32> = new Array<u32>()
            let strs = nums.map<string>(fn(x: u32) = "test")
            let total = reduce<string, u32>(strs, 0u32, fn(acc: u32, s: string) = acc)
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const stats = registry.getStats();
        
        expect(stats.classCount).toBeGreaterThanOrEqual(2); // Array<u32>, Array<string>
        expect(stats.methodCount).toBeGreaterThan(0); // map<string>
        expect(stats.functionCount).toBeGreaterThan(0); // reduce<string,u32>
    });

    test('should handle generic constructors with parameters', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Box<T> = class {
                let value: T
                
                fn init(val: T) {
                    this.value = val
                }
            }

            let box1: Box<u32> = new Box<u32>(42u32)
            let box2: Box<string> = new Box<string>("hello")
            let box3: Box<bool> = new Box<bool>(true)
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        
        expect(allClasses.length).toBeGreaterThanOrEqual(3);
        
        const keys = allClasses.map((c: ClassInstantiation) => c.key).sort();
        expect(keys).toContain('Box<u32>');
        expect(keys).toContain('Box<string>');
        expect(keys).toContain('Box<bool>');
    });

    test('should handle array types within generics', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Container<T> = class {
                let items: T[] = []
                
                fn add(item: T) -> void {
                }
            }

            let c1: Container<u32[]> = new Container<u32[]>()
            let c2: Container<string[]> = new Container<string[]>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        
        expect(allClasses.length).toBeGreaterThanOrEqual(2);
        
        // Should handle array type arguments
        const keys = allClasses.map((c: ClassInstantiation) => c.key);
        expect(keys.some(k => k.includes('Container'))).toBe(true);
    });

    // ============================================================================
    // Advanced Tests: Stress Tests and Edge Cases
    // ============================================================================

    test('should handle many instantiations of same generic class', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
            }

            let arr1: Array<u8> = new Array<u8>()
            let arr2: Array<u16> = new Array<u16>()
            let arr3: Array<u32> = new Array<u32>()
            let arr4: Array<u64> = new Array<u64>()
            let arr5: Array<i8> = new Array<i8>()
            let arr6: Array<i16> = new Array<i16>()
            let arr7: Array<i32> = new Array<i32>()
            let arr8: Array<i64> = new Array<i64>()
            let arr9: Array<f32> = new Array<f32>()
            let arr10: Array<f64> = new Array<f64>()
            let arr11: Array<bool> = new Array<bool>()
            let arr12: Array<string> = new Array<string>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        
        // Should register all 12 distinct Array<T> instantiations
        expect(allClasses.length).toBeGreaterThanOrEqual(12);
        
        const keys = allClasses.map((c: ClassInstantiation) => c.key);
        expect(keys).toContain('Array<u32>');
        expect(keys).toContain('Array<string>');
        expect(keys).toContain('Array<bool>');
    });

    test('should handle generic class with multiple methods', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Array<T> = class {
                let data: T[] = []
                
                fn map<U>(f: fn(T) -> U) -> Array<U> {
                    return new Array<U>()
                }
                
                fn filter(pred: fn(T) -> bool) -> Array<T> {
                    return new Array<T>()
                }
                
                fn reduce<U>(init: U, f: fn(U, T) -> U) -> U {
                    return init
                }
            }

            let arr: Array<u32> = new Array<u32>()
            let mapped = arr.map<string>(fn(x: u32) = "test")
            let filtered = arr.filter(fn(x: u32) = true)
            let reduced = arr.reduce<bool>(false, fn(acc: bool, x: u32) = acc)
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const stats = registry.getStats();
        
        expect(stats.methodCount).toBeGreaterThanOrEqual(3); // map, filter, reduce
        
        const allMethods = Array.from((registry as any).methods.values()) as MethodInstantiation[];
        const methodNames = allMethods.map((m: MethodInstantiation) => {
            const parts = m.key.split('::');
            return parts[parts.length - 1].split('<')[0];
        });
        
        expect(methodNames).toContain('map');
        expect(methodNames).toContain('filter');
        expect(methodNames).toContain('reduce');
    });

    test('should correctly mangle complex nested generic names', async () => {
        await clearFileDocuments(setup.services.TypeC);
        setup.services.TypeC.typing.MonomorphizationRegistry.clear();
        
        await setup.parseAndValidate(`
            type Result<T, E> = class {
                let value: T? = null
            }
            
            type Array<T> = class {
                let data: T[] = []
            }

            let complex: Array<Result<u32, string>> = new Array<Result<u32, string>>()
        `);

        const registry = setup.services.TypeC.typing.MonomorphizationRegistry;
        const allClasses = registry.getAllClassInstantiations();
        
        const nestedClass = allClasses.find((c: ClassInstantiation) =>
            c.key.includes('Array') && c.key.includes('Result')
        );
        
        if (nestedClass) {
            const mangledName = registry.mangleName(nestedClass.key);
            
            // Should be valid identifier: no <, >, or commas
            expect(mangledName).not.toContain('<');
            expect(mangledName).not.toContain('>');
            expect(mangledName).not.toContain(',');
            expect(mangledName).not.toContain(' ');
            
            // Should contain $ separators
            expect(mangledName).toContain('$');
        }
    });
});