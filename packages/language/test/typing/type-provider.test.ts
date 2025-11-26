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
            await assertType('functions/correct/test001.tc', {
                'n': 'u32',
                'x': 'u32',
                'fib': 'fn(n: u32) -> u32',
            });
        });

        test('should infer types in recursive functions with contextual literals', async () => {
            await assertType('functions/correct/function-inference.tc', {
                'fib': 'fn(n: u32) -> u32',
                'f1': 'fn(x: u32) -> u32',
                'f2': 'fn(x: u32) -> u32',
                'anotherFib': 'fn(n: u32) -> struct { x: i32, y: u32 }',
                'z': 'u32',
                'a': 'struct { x: i32, y: u32 }',
            });
        });

        test('should infer return types from non-recursive base cases', async () => {
            await assertType('functions/correct/return-inference.tc', {
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
            await assertType('structs/correct/struct-common-types.tc', {
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
            const content = await readFile(path.join(testFilesDir, 'functions/incorrect/return-type-errors.tc'), 'utf-8');
            const document = await parseAndValidate(content);
            
            // Expect exactly 3 validation errors
            expect(document.diagnostics?.length).toBe(3);
            
            const diagnostics = document.diagnostics || [];
            const errorMessages = diagnostics.map((d: any) => d.message);
            
            // TODO: Validate code
            expect(diagnostics.length).toBe(3);
            
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
            await assertType('primitives/correct/basic-types.tc', {
                'a': 'u8',
                'b': 'u16',
                'c': 'u32',
                'd': 'u64',
            });
        });

        test('should infer signed integer types', async () => {
            await assertType('primitives/correct/basic-types.tc', {
                'e': 'i8',
                'f': 'i16',
                'g': 'i32',
                'h': 'i64',
            });
        });

        test('should infer float types', async () => {
            await assertType('primitives/correct/basic-types.tc', {
                'floatX': 'f32',      // Explicit f32 type annotation
                'floatY': 'f64',      // Explicit f64 type annotation
            });
        });

        test('should infer bool and string types', async () => {
            await assertType('primitives/correct/basic-types.tc', {
                'flag': 'bool',
                'message': 'string',
            });
        });
    });

    describe('Struct Types', () => {
        test('should infer struct type with explicit annotation', async () => {
            await assertType('primitives/correct/basic-types.tc', {
                'Point': 'Point',   // Type reference shows alias name (last occurrence is usage site)
                'origin': 'Point',  // Explicit annotation preserves type alias name
                'px': 'f64',
            });
        });

        test('should infer struct type via duck typing', async () => {
            await assertType('primitives/correct/basic-types.tc', {
                'point': 'struct { x: f64, y: f64 }',  // Duck typing infers structural type
                'xCoord': 'f64',
            });
        });

        test('should handle comprehensive struct scenarios', async () => {
            await assertType('structs/correct/struct-tests.tc', {
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
            await assertType('primitives/correct/basic-types.tc', {
                'inferredU32': 'i32',       // Integer literals default to i32
                'inferredF64': 'f64',       // Float literals default to f64
                'inferredBool': 'bool',
                'inferredString': 'string',
            });
        });

        test('should infer types from binary operations', async () => {
            await assertType('primitives/correct/basic-types.tc', {
                'sum': 'u32',
                'product': 'i32',
                'quotient': 'f64',
            });
        });
    });

    describe('Classes', () => {
        test('should infer simple class types', async () => {
            await assertType('classes/correct/classes-interfaces.tc', {
                'Person': 'Person',
                'person': 'Person',
                'personName': 'string',
                'personAge': 'u32',
                'greeting': 'string',
                'age': 'u32',
            });
        });

        test('should infer generic class types', async () => {
            await assertType('classes/correct/classes-interfaces.tc', {
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
            await assertType('classes/correct/classes-interfaces.tc', {
                'Counter': 'Counter',
                'counter1': 'Counter',
                'counter2': 'Counter',
                'combined': 'Counter',
                'finalCount': 'i32',
            });
        });

        test('should infer nested generic types', async () => {
            await assertType('classes/correct/classes-interfaces.tc', {
                // Type system normalizes spacing in generic types
                'container': 'Container<Box<i32>>',
                'box1': 'Box<i32>',
                'retrievedBox': 'Box<i32>',
                'innerValue': 'i32',
            });
        });

        test('should handle multiple type parameters', async () => {
            await assertType('classes/correct/classes-interfaces.tc', {
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
            await assertType('classes/correct/classes-interfaces.tc', {
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
            await assertType('coercion/correct/type-coercion.tc', {
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
                await assertType('mixed/correct/advanced-types.tc', {
                    'Option': 'variant { Some(value: T), None }',  // Last occurrence is Option.None on line 9, type is the variant definition itself
                    'someValue': 'Option<i32>',
                    'noneValue': 'Option<string>',
                });
            });
        });

        describe('Array Operations', () => {
            test('should infer array operation types', async () => {
                await assertType('mixed/correct/advanced-types.tc', {
                    'numbers': 'i32[]',
                    'len': 'u64',
                    'first': 'i32',
                });
            });
        });

        describe('Nullable Chains', () => {
            test('should infer nullable linked list types', async () => {
                await assertType('mixed/correct/advanced-types.tc', {
                    'LinkedNode': 'LinkedNode<i32>',  // Last occurrence is the annotation on line 31
                    'node1': 'LinkedNode<i32>',
                    'nextNode': 'LinkedNode<i32>?',
                    'nextValue': 'i32?',
                });
            });
        });

        describe('Type Casting', () => {
            test('should infer type cast expressions', async () => {
                await assertType('mixed/correct/advanced-types.tc', {
                    'num': 'i32',
                    'bigNum': 'i64',
                });
            });
        });
    });

    describe('Variant Generics', () => {
        describe('Full Generic Inference', () => {
            test('should infer fully annotated variant types', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'okValue': 'Result<i32, string>',
                    'errValue': 'Result<i32, string>',
                });
            });
        });

        describe('Partial Generic Inference with never', () => {
            test('should infer Ok variant with never for uninferrable E', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    // okResponse should be Result<i32, never>.Ok
                    // When only T is inferrable, E becomes never
                    'okResponse': 'Result.Ok<i32, never>',
                });
            });

            test('should infer Err variant with never for uninferrable T', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    // errResponse should be Result<never, string>.Err
                    // When only E is inferrable, T becomes never
                    'errResponse': 'Result.Err<never, string>',
                });
            });
        });

        describe('Variant Constructors as Subtypes', () => {
            test('should allow Result.Ok<T, never> as subtype of Result<T, E>', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'testPartialInferenceOk': 'fn() -> Result<i32, string>',
                });
            });

            test('should allow Result.Err<never, E> as subtype of Result<T, E>', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'testPartialInferenceErr': 'fn() -> Result<i32, string>',
                });
            });
        });

        describe('Return Type Unification', () => {
            test('should unify variant types from conditional expressions', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'ok': 'Result.Ok<i32, never>',
                    'err': 'Result.Err<never, string>',
                    'testReturnUnification': 'fn() -> Result<i32, string>',
                });
            });
        });

        describe('Different Generic Instantiations', () => {
            test('should handle different variant instantiations', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'intResult': 'Result<i32, string>',
                    'strResult': 'Result<string, i32>',
                    'boolResult': 'Result<bool, string>',
                });
            });
        });

        describe('Nested Variants', () => {
            test('should handle nested variant types', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'nested': 'Result.Ok<Option.Some<i32>, never>',
                    'testNestedVariants': 'fn() -> Result<Option<i32>, string>',
                });
            });
        });

        describe('Single Type Parameter Variants', () => {
            test('should infer Option with single type parameter', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'someVal': 'Option.Some<i32>',
                    'noneVal': 'Option.None<never>',  // No params to infer, all become never
                    'testSingleParamVariant': 'fn() -> Option<i32>',
                });
            });
        });

        describe('Function Call Inference', () => {
            test('should infer from function parameter types', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'processResult': 'fn(r: Result<i32, string>) -> i32',
                    'result': 'Result.Ok<i32, never>',
                });
            });
        });

        describe('Multiple Partial Inferences', () => {
            test('should handle multiple partial inferences in same scope', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'ok1': 'Result.Ok<i32, never>',
                    'ok2': 'Result.Ok<i32, never>',
                    'ok3': 'Result.Ok<i32, never>',
                    'err1': 'Result.Err<never, string>',
                    'err2': 'Result.Err<never, string>',
                });
            });
        });

        describe('Variants in Struct Fields', () => {
            test('should handle variants as struct field types', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'response': 'Response<i32>',
                    'errorResponse': 'Response<i32>',
                });
            });
        });

        describe('Arrays of Variants', () => {
            test('should handle arrays of variant types', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'results': 'Result<i32, string>[]',
                });
            });
        });

        describe('Chained Variant Operations', () => {
            test('should handle variant return types in function calls', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'divide': 'fn(a: f64, b: f64) -> Result<f64, string>',
                    'result1': 'Result<f64, string>',
                    'result2': 'Result<f64, string>',
                });
            });
        });

        describe('Complex Variant Constructors', () => {
            test('should handle variants with multiple parameters in constructors', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'simple': 'Value.Primitive<f64>',
                    'complex': 'Value.Complex<f64>',
                    'testComplexVariant': 'fn() -> Value<f64>',
                });
            });
        });

        describe('Three Type Parameters', () => {
            test('should handle variants with three type parameters', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'first': 'Triple.First<i32, never, never>',
                    'second': 'Triple.Second<never, string, never>',
                    'third': 'Triple.Third<never, never, bool>',
                    'testThreeParams': 'fn() -> Triple<i32, string, bool>',
                });
            });
        });

        describe('Integration Test', () => {
            test('should infer all types correctly in main function', async () => {
                await assertType('variants/correct/variant-generics.tc', {
                    'r1': 'Result<i32, string>',
                    'r2': 'Result<i32, string>',
                    'r3': 'Result<i32, string>',
                    'r4': 'Result<i32, string>',
                    'r6': 'Result<Option<i32>, string>',
                    'r7': 'Option<i32>',
                    'r9': 'Result<i32, string>',
                    'r13': 'Value<f64>',
                    'r14': 'Triple<i32, string, bool>',
                });
            });
        });
    });

    describe('Variant Constructor Types', () => {
        describe('Simple Constructor Type Annotations', () => {
            test('should allow variant constructor types without generics', async () => {
                await assertType('variants/correct/variant-constructor-types.tc', {
                    'noneVal': 'Option.None<never>',
                });
            });
        });

        describe('Constructor Types with Generics', () => {
            test('should allow variant constructor types with generic parameters', async () => {
                await assertType('variants/correct/variant-constructor-types.tc', {
                    'someVal': 'Option.Some<u32>',
                    'okVal': 'Result.Ok<i32, string>',
                    'errVal': 'Result.Err<i32, string>',
                });
            });
        });

        describe('More Constructor Types', () => {
            test('should allow constructor types with different type parameters', async () => {
                await assertType('variants/correct/variant-constructor-types.tc', {
                    'successVal': 'Status.Success<i32>',
                    'failureVal': 'Status.Failure<i32>',
                });
            });
        });

        describe('Constructor Types in Function Signatures', () => {
            test('should allow constructor types in function parameters', async () => {
                await assertType('variants/correct/variant-constructor-types.tc', {
                    'processSome': 'fn(val: Option.Some<string>) -> string',
                    'processOk': 'fn(result: Result.Ok<u32, string>) -> u32',
                });
            });

            test('should allow constructor types in function return types', async () => {
                await assertType('variants/correct/variant-constructor-types.tc', {
                    'createSome': 'fn() -> Option.Some<i32>',
                    'createOk': 'fn() -> Result.Ok<string, i32>',
                });
            });
        });

        describe('Constructor Types with Type Inference', () => {
            test('should properly infer types with constructor type annotations', async () => {
                await assertType('variants/correct/variant-constructor-types.tc', {
                    's': 'Option.Some<u32>',
                    'n': 'Option.None<bool>',
                });
            });
        });


        /**
         * Generic tests
         */
        describe('Generic inference', () => {

            test('should properly infer types with constructor type annotations', async () => {
                await assertType('generics/correct/file1.tc', {
                    'd': 'i32[]',
                });
            });
            test('should properly infer types with constructor type annotations', async () => {
                await assertType('generics/correct/file2.tc', {
                    'f': 'Option.Some<string>',
                });
            });
        });
    });

    describe('String Enum and Literal Types', () => {
        describe('Valid String Literal Assignments', () => {
            test('should infer string literal types', async () => {
                await assertType('string-enums/correct/string-literal-to-enum.tc', {
                    'color1': 'Colors',
                    'color2': 'Colors',
                    'color3': 'Colors',
                    'color4': '"green" | "red"',
                });
            });

            test('should allow string literal access to string methods', async () => {
                await assertType('string-enums/correct/string-literal-to-enum.tc', {
                    'len': 'u64',
                    'upper': 'string',
                });
            });
        });

        describe('Invalid String Literal Assignments', () => {
            test('should reject string literals not in enum', async () => {
                const content = await readFile(path.join(testFilesDir, 'string-enums/incorrect/invalid-string-literal.tc'), 'utf-8');
                const document = await parseAndValidate(content);
                
                // Expect exactly 1 validation error
                expect(document.diagnostics?.length).toBe(1);
                
                const diagnostics = document.diagnostics || [];
                const errorMessages = diagnostics.map((d: any) => d.message);
                
                // Check that the error mentions "yellow" and the enum values
                const assignabilityError = errorMessages.find((msg: string) =>
                    msg.includes('yellow') && msg.includes('not assignable')
                );
                expect(assignabilityError).toBeDefined();
            });
        });
    
        describe('Coroutine Types', () => {
            describe('Yield Type Inference', () => {
                test('should infer yield types from simple coroutines', async () => {
                    await assertType('coroutines/correct/coroutine-yield-inference.tc', {
                        'simpleGen': 'cfn() -> i32',
                        'explicitGen': 'cfn() -> u32',
                        'exprGen': 'cfn() -> i32',
                        'exprGenExplicit': 'cfn() -> u32',
                    });
                });
    
                test('should infer string yield types', async () => {
                    await assertType('coroutines/correct/coroutine-yield-inference.tc', {
                        'stringGen': 'cfn() -> string',
                        'inferredStringGen': 'cfn() -> string',
                    });
                });
    
                test('should handle void yields', async () => {
                    await assertType('coroutines/correct/coroutine-yield-inference.tc', {
                        'voidGen': 'cfn() -> void',
                        'explicitVoidGen': 'cfn() -> void',
                    });
                });
    
                test('should infer struct yield types', async () => {
                    await assertType('coroutines/correct/coroutine-yield-inference.tc', {
                        'structGen': 'cfn() -> struct { x: u32, y: u32 }',
                    });
                });
    
                test('should handle generic coroutines', async () => {
                    await assertType('coroutines/correct/coroutine-yield-inference.tc', {
                        'genericGen': 'cfn<T>(value: T) -> T',
                    });
                });
    
                test('should infer array yield types', async () => {
                    await assertType('coroutines/correct/coroutine-yield-inference.tc', {
                        'arrayGen': 'cfn() -> u32[]',
                    });
                });
            });
    
            describe('Coroutine Instance Types', () => {
                test('should create coroutine instances', async () => {
                    await assertType('coroutines/correct/coroutine-instance-types.tc', {
                        'loop': 'cfn(x: u32[]) -> u32',
                    });
                });
    
                test('should handle different parameter types', async () => {
                    await assertType('coroutines/correct/coroutine-instance-types.tc', {
                        'stringGen': 'cfn(prefix: string, count: u32) -> string',
                    });
                });

                test('should infer coroutine instance type correctly', async () => {
                    await assertType('coroutines/correct/task-example.tc', {
                        'co': 'coroutine<fn(x: u32[]) -> u32>',
                        'x': 'u32',
                        'y': 'u32',
                        'z': 'u32',
                    });
                });
            });

            describe('Coroutine Call Validation', () => {
                test('should validate correct coroutine calls with proper arguments', async () => {
                    await assertType('coroutines/correct/coroutine-call-validation.tc', {
                        'loop': 'cfn(x: u32[]) -> u32',
                        'result': 'u32',
                    });
                });

                test('should validate calls with multiple parameters', async () => {
                    await assertType('coroutines/correct/coroutine-call-validation.tc', {
                        'a': 'string',
                        'b': 'string',
                    });
                });
            });
    
            describe('Coroutine Validation Errors', () => {
                test('should error on mismatched yield types', async () => {
                    const content = await readFile(path.join(testFilesDir, 'coroutines/incorrect/coroutine-yield-errors.tc'), 'utf-8');
                    const document = await parseAndValidate(content);
                    
                    const errors = document.diagnostics?.filter(d => d.severity === 1) || []; // severity 1 = error
                    expect(errors.length).toBeGreaterThan(0);
                    
                    // Should have error about cannot infer common type
                    expect(errors.some(d => d.message.includes('Cannot infer common type'))).toBe(true);
                });
    
                test('should error on yield in regular function', async () => {
                    const content = await readFile(path.join(testFilesDir, 'coroutines/incorrect/coroutine-yield-errors.tc'), 'utf-8');
                    const document = await parseAndValidate(content);
                    
                    const errors = document.diagnostics?.filter(d => d.severity === 1) || [];
                    expect(errors.some(d => d.message.includes('only be used in coroutines'))).toBe(true);
                });
    
                test('should error on return in coroutine', async () => {
                    const content = await readFile(path.join(testFilesDir, 'coroutines/incorrect/coroutine-yield-errors.tc'), 'utf-8');
                    const document = await parseAndValidate(content);
                    
                    const errors = document.diagnostics?.filter(d => d.severity === 1) || [];
                    expect(errors.some(d => d.message.includes('must use') && d.message.includes('yield'))).toBe(true);
                });

                test('should error on coroutine call with wrong argument types', async () => {
                    const content = await readFile(path.join(testFilesDir, 'coroutines/incorrect/coroutine-call-errors.tc'), 'utf-8');
                    const document = await parseAndValidate(content);
                    
                    const errors = document.diagnostics?.filter(d => d.severity === 1) || [];
                    expect(errors.length).toBeGreaterThan(0);
                    // Should have errors about argument type mismatches
                    expect(errors.some(d => d.message.includes('Argument') || d.message.includes('expected'))).toBe(true);
                });

                test('should error on coroutine call with wrong number of arguments', async () => {
                    const content = await readFile(path.join(testFilesDir, 'coroutines/incorrect/coroutine-call-errors.tc'), 'utf-8');
                    const document = await parseAndValidate(content);
                    
                    const errors = document.diagnostics?.filter(d => d.severity === 1) || [];
                    // Should have errors about argument count
                    expect(errors.some(d => d.message.includes('Expected') && d.message.includes('argument'))).toBe(true);
                });
            });
        });
    });
});