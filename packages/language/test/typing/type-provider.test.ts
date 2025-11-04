import { describe, expect, test } from "vitest";
import { clearFileDocuments, diagnosticToString, setupLanguageServices } from "../test-utils.js";
import { readFile } from "fs/promises";
import { checkDocumentValid } from "../test-utils.js";
import path from "path";
import { CstUtils, LangiumDocument } from "langium";
import { Module } from "type-c-language";


describe('Type Provider', async () => {
	const { parseAndValidate, typeProvider, services } = setupLanguageServices();
    const testFilesDir = path.join("test", "test-cases", "typing");


    /**
     * Very similar to original IPL test implementation:
     * From a model, finds the AST node that matches the submodel string
     * and asserts that the type of that node is the expected type. Because selection of the node may return multiple nodes,
     * a filter function can be provided to select the correct node based on AST Type.
     * @param code Main file content
     * @param validationMap Map of expected types for each submodel
     * @param options Additional options, for multiple files
     */
    async function assertType(fileName: string, validationMap: Record<string, string>, options: Partial<{
        resources?: string | string[]
    }> = {}) {
        let document: LangiumDocument<Module>;
		const code = await readFile(path.join(testFilesDir, fileName), "utf-8");
        document = await parseAndValidate(code);

		expect(checkDocumentValid(document) ?? 'OK', 'Document is not valid').toBe('OK');
		// Expect diagnostics to be empty
		expect(document.diagnostics ?? [], 'Diagnostics are not empty! We have the following diagnostics: '+ document.diagnostics?.map(d => diagnosticToString(d)).join('\n')).toHaveLength(0);

        for (const [submodel, expectedType] of Object.entries(validationMap)) {
            // convert offset to position line/column based on the model
            // Use regex with word boundaries to match whole words only
            const regex = new RegExp(`\\b${submodel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
            const matches = Array.from(code.matchAll(regex));
            if (matches.length === 0) {
                throw new Error(`Could not find submodel '${submodel}' in the code as a whole word`);
            }
            const offset = matches[matches.length - 1].index!;

            // assert no errors/diagnostics
            expect(checkDocumentValid(document) ?? 'OK', 'Document is not valid').toBe('OK');

            const elementCstUtils = CstUtils.findLeafNodeBeforeOffset(document.parseResult.value!.$cstNode!, offset);
            expect(elementCstUtils).toBeDefined();
            expect(elementCstUtils?.astNode).toBeDefined();
            expect(typeProvider.getType(elementCstUtils?.astNode).toString()).toBe(expectedType);
        }
        clearFileDocuments(services.TypeC);
    }

    describe('Fibonacci Example', () => {
        test('should infer types in recursive function', async () => {
            await assertType('test001.tc', {
                'n': 'u32',
                'x': 'u32',
                'fib': 'fn(n: u32) -> u32',
            });
        });

        test('should infer types in recursive functions with contextual literals', async () => {
            await assertType('function-inference.tc', {
                'fib': 'fn(n: u32) -> u32',
                'f1': 'fn(x: u32) -> u32',
                'f2': 'fn(x: u32) -> u32',
                'anotherFib': 'fn(n: u32) -> struct { x: i32, y: u32 }',
                'z': 'u32',
                'a': 'struct { x: i32, y: u32 }',
            });
        });

        test('should infer return types from non-recursive base cases', async () => {
            await assertType('return-inference.tc', {
                'f3': 'fn() -> u32',
                'anotherFib': 'fn(n: u32) -> u32',
                'fiiib': 'fn(n: u32) -> u32',
                'outerFunc': 'fn(x: u32) -> u32',
                'a': 'u32',
                'b': 'u32',
                'c': 'u32',
                'd': 'u32',
            });
        });

        test('should infer common struct types with structural subtyping', async () => {
            await assertType('struct-common-types.tc', {
                'getPoint': 'fn(n: u32) -> struct { x: u32, y: u32 }',
                'getAllFields': 'fn(n: u32) -> struct { a: u32, b: u32 }',
                'getSingleField': 'fn(n: u32) -> struct { value: u32 }',
                'p': 'struct { x: u32, y: u32 }',
                'all': 'struct { a: u32, b: u32 }',
                'single': 'struct { value: u32 }',
            });
        });

    });

    describe('Validation Errors', () => {
        test('return-type-errors.tc should have expected validation errors', async () => {
            const content = await readFile(path.join(testFilesDir, 'return-type-errors.tc'), 'utf-8');
            const document = await parseAndValidate(content);
            
            // Expect exactly 3 validation errors
            expect(document.diagnostics?.length).toBe(3);
            
            const diagnostics = document.diagnostics || [];
            const errorMessages = diagnostics.map((d: any) => d.message);
            
            // Error 1 & 2: Functions with incompatible return types (can't infer common type)
            const returnTypeErrors = errorMessages.filter((msg: string) => 
                msg.includes('Cannot infer common type') || 
                msg.includes('Cannot infer return type')
            );
            expect(returnTypeErrors.length).toBe(2);
            
            // Error 3: Declared type doesn't match inferred type
            const mismatchErrors = errorMessages.filter((msg: string) => 
                msg.includes('Return type mismatch')
            );
            expect(mismatchErrors.length).toBe(1);
            
            // Verify specific functions have errors
            const diagnosticsWithSource = diagnostics.map((d: any) => ({
                message: d.message,
                line: d.range.start.line
            }));
            
            // badMixedTypes should error (around line 7)
            expect(diagnosticsWithSource.some((d: any) => 
                d.line >= 6 && d.line <= 12 && d.message.includes('Cannot infer')
            )).toBe(true);
            
            // badStructTypes should error (around line 15)
            expect(diagnosticsWithSource.some((d: any) => 
                d.line >= 14 && d.line <= 20 && d.message.includes('Cannot infer')
            )).toBe(true);
            
            // badDeclaredType should error (around line 23)
            expect(diagnosticsWithSource.some((d: any) => 
                d.line >= 22 && d.line <= 25 && d.message.includes('Return type mismatch')
            )).toBe(true);
        });
    });

    describe('Primitive Types', () => {
        test('should infer unsigned integer types', async () => {
            await assertType('basic-types.tc', {
                'a': 'u8',
                'b': 'u16',
                'c': 'u32',
                'd': 'u64',
            });
        });

        test('should infer signed integer types', async () => {
            await assertType('basic-types.tc', {
                'e': 'i8',
                'f': 'i16',
                'g': 'i32',
                'h': 'i64',
            });
        });

        test('should infer float types', async () => {
            await assertType('basic-types.tc', {
                'floatX': 'f32',      // Explicit f32 type annotation
                'floatY': 'f64',      // Explicit f64 type annotation
            });
        });

        test('should infer bool and string types', async () => {
            await assertType('basic-types.tc', {
                'flag': 'bool',
                'message': 'string',
            });
        });
    });

    describe('Struct Types', () => {
        test('should infer struct type with explicit annotation', async () => {
            await assertType('basic-types.tc', {
                'Point': 'Point',   // Type reference shows alias name (last occurrence is usage site)
                'origin': 'Point',  // Explicit annotation preserves type alias name
                'px': 'f64',
            });
        });

        test('should infer struct type via duck typing', async () => {
            await assertType('basic-types.tc', {
                'point': 'struct { x: f64, y: f64 }',  // Duck typing infers structural type
                'xCoord': 'f64',
            });
        });

        test('should handle comprehensive struct scenarios', async () => {
            await assertType('struct-tests.tc', {
                // Anonymous struct literals
                'createPoint': 'fn() -> struct { x: f64, y: f64 }',
                'createPoint3D': 'fn() -> struct { x: f64, y: f64, z: f64 }',
                
                // Named struct with explicit type
                'createNamedPoint': 'fn() -> Point',
                
                // Field access and operations
                'accessFields': 'fn() -> f64',
                'xVal': 'f64',
                'yVal': 'f64',
                
                // Nested structs
                'createRectangle': 'fn() -> struct { topLeft: struct { x: f64, y: f64 }, bottomRight: struct { x: f64, y: f64 } }',
                'accessNestedFields': 'fn() -> f64',
                'x1': 'f64',
                'y1': 'f64',
                'x2': 'f64',
                'y2': 'f64',
                
                // Structural subtyping
                'testStructuralSubtyping': 'fn() -> struct { x: f64, y: f64 }',
                
                // Common type inference (intersection of fields)
                'getPointVariant': 'fn(n: u32) -> struct { x: f64, y: f64 }',
                
                // Mixed field types
                'createMixedStruct': 'fn() -> struct { id: u32, name: string, active: bool, score: f64 }',
                'accessMixedStruct': 'fn() -> u32',
                'id': 'u32',
                'name': 'string',
                'active': 'bool',
                'score': 'f64',
                
                // Struct as parameter
                'calculateDistance': 'fn(p: Point) -> f64',
                'testStructParameter': 'fn() -> f64',
                
                // Multiple struct variables
                'testMultipleStructs': 'fn() -> f64',
                'dx': 'f64',
                'dy': 'f64',
                
                // Main function variables
                'point': 'struct { x: f64, y: f64 }',
                'sum': 'f64',
            });
        });
    });

    describe('Type Inference', () => {
        test('should infer primitive types from literals', async () => {
            await assertType('basic-types.tc', {
                'inferredU32': 'i32',       // Integer literals default to i32
                'inferredF64': 'f64',       // Float literals default to f64
                'inferredBool': 'bool',
                'inferredString': 'string',
            });
        });

        test('should infer types from binary operations', async () => {
            await assertType('basic-types.tc', {
                'sum': 'u32',
                'product': 'i32',
                'quotient': 'f64',
            });
        });
    });

    describe('Classes', () => {
        test('should infer simple class types', async () => {
            await assertType('classes-interfaces.tc', {
                'Person': 'Person',
                'person': 'Person',
                'personName': 'string',
                'personAge': 'u32',
                'greeting': 'string',
                'age': 'u32',
            });
        });

        test('should infer generic class types', async () => {
            await assertType('classes-interfaces.tc', {
                // Note: 'Box' resolves to last usage which is 'Box<i32>' in container test
                'intBox': 'Box<i32>',
                'boxValue': 'i32',
                'retrieved': 'i32',
                'strBox': 'Box<string>',
                'strValue': 'string',
                'strRetrieved': 'string',
            });
        });

        test('should handle operator overloading', async () => {
            await assertType('classes-interfaces.tc', {
                'Counter': 'Counter',
                'counter1': 'Counter',
                'counter2': 'Counter',
                'combined': 'Counter',
                'finalCount': 'i32',
            });
        });

        test('should infer nested generic types', async () => {
            await assertType('classes-interfaces.tc', {
                // Type system normalizes spacing in generic types
                'container': 'Container<Box<i32>>',
                'box1': 'Box<i32>',
                'retrievedBox': 'Box<i32>',
                'innerValue': 'i32',
            });
        });

        test('should handle multiple type parameters', async () => {
            await assertType('classes-interfaces.tc', {
                'pair': 'Pair<string, i32>',
                'firstVal': 'string',
                'secondVal': 'i32',
                'swapped': 'Pair<i32, string>',  // TODO: Check if this is correctly inferred
                'swappedFirst': 'i32',
                'swappedSecond': 'string',
            });
        });
    });

    describe('Interfaces', () => {
        test('should infer interface types', async () => {
            await assertType('classes-interfaces.tc', {
                'Drawable': 'Drawable',
                'Circle': 'Circle',
                'circle': 'Circle',
                'drawable': 'Drawable',
                'radius': 'f64',
            });
        });
    });

    describe('Type Coercion', () => {
        test('should allow implicit numeric type coercion', async () => {
            await assertType('type-coercion.tc', {
                'takesF32': 'fn(x: f32) -> f32',
                'takesF64': 'fn(x: f64) -> f64',
                'takesI32': 'fn(x: i32) -> i32',
                'takesU64': 'fn(x: u64) -> u64',
                // Note: Variable types reflect declared annotations, not implicit coercion
                // Coercion happens at assignment/call sites and is validated by type checker
                'area': 'f64',
                'multiply': 'fn(a: f64, b: f64) -> f64',
            });
        });
    });

    describe('Advanced Types', () => {
        describe('Variant Types', () => {
            test('should infer Option variant types', async () => {
                await assertType('advanced-types.tc', {
                    'Option': 'variant { Some(value: T), None }',  // Last occurrence is Option.None on line 9, type is the variant definition itself
                    'someValue': 'Option<i32>',
                    'noneValue': 'Option<string>',
                });
            });
        });

        describe('Array Operations', () => {
            test('should infer array operation types', async () => {
                await assertType('advanced-types.tc', {
                    'numbers': 'i32[]',
                    'len': 'u64',
                    'first': 'i32',
                });
            });
        });

        describe('Nullable Chains', () => {
            test('should infer nullable linked list types', async () => {
                await assertType('advanced-types.tc', {
                    'LinkedNode': 'LinkedNode<i32>',  // Last occurrence is the annotation on line 31
                    'node1': 'LinkedNode<i32>',
                    'nextNode': 'LinkedNode<i32>?',
                    'nextValue': 'i32?',
                });
            });
        });

        describe('Type Casting', () => {
            test('should infer type cast expressions', async () => {
                await assertType('advanced-types.tc', {
                    'num': 'i32',
                    'bigNum': 'i64',
                });
            });
        });
    });
});