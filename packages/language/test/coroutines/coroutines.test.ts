import { describe, expect, test } from "vitest";
import { clearFileDocuments, setupLanguageServices } from "../test-utils.js";
import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver-types";

describe('Coroutine Validation', () => {
    const { services, parseAndValidate } = setupLanguageServices();

    async function parseAndGetDiagnostics(code: string): Promise<Diagnostic[]> {
        await clearFileDocuments(services.TypeC);
        const doc = await parseAndValidate(code);
        await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
        return doc.diagnostics ?? [];
    }

    describe('Correct Coroutine Usage', () => {
        test('should infer yield type from simple yields', async () => {
            const code = `
                cfn simpleGen() {
                    yield 1
                    yield 2
                    yield 3
                }
            `;
            const diagnostics = await parseAndGetDiagnostics(code);
            expect(diagnostics).toHaveLength(0);
        });

        test('should validate explicit yield type', async () => {
            const code = `
                cfn explicitGen() -> u32 {
                    yield 1u32
                    yield 2u32
                }
            `;
            const diagnostics = await parseAndGetDiagnostics(code);
            expect(diagnostics).toHaveLength(0);
        });

        test('should handle expression body coroutines', async () => {
            const code = `cfn exprGen() = 42`;
            const diagnostics = await parseAndGetDiagnostics(code);
            expect(diagnostics).toHaveLength(0);
        });

        test('should handle void yields', async () => {
            const code = `
                cfn voidGen() {
                    yield
                    yield
                }
            `;
            const diagnostics = await parseAndGetDiagnostics(code);
            expect(diagnostics).toHaveLength(0);
        });

        test('should handle string yields', async () => {
            const code = `
                cfn stringGen() -> string {
                    yield "hello"
                    yield "world"
                }
            `;
            const diagnostics = await parseAndGetDiagnostics(code);
            expect(diagnostics).toHaveLength(0);
        });
    });

    describe('Coroutine Validation Errors', () => {
        test('should error on mismatched yield types', async () => {
            const code = `
                cfn mismatchedYields() {
                    yield 1
                    yield "oops"
                }
            `;
            const diagnostics = await parseAndGetDiagnostics(code);
            const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(d => d.message.includes('Cannot infer common type'))).toBe(true);
        });

        test('should error when yield type does not match declared type', async () => {
            const code = `
                cfn wrongExplicitType() -> string {
                    yield 1
                    yield 2
                }
            `;
            const diagnostics = await parseAndGetDiagnostics(code);
            const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(d => 
                d.message.includes('yield type mismatch') || 
                d.message.includes('Yield type mismatch')
            )).toBe(true);
        });

        test('should error when using yield in regular function', async () => {
            const code = `
                fn regularWithYield() {
                    yield 1
                }
            `;
            const diagnostics = await parseAndGetDiagnostics(code);
            const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(d => 
                d.message.includes('only be used in coroutines') ||
                d.message.includes('can only be used in coroutines')
            )).toBe(true);
        });

        test('should error when using return in coroutine', async () => {
            const code = `
                cfn coroutineWithReturn() {
                    return 1
                }
            `;
            const diagnostics = await parseAndGetDiagnostics(code);
            const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(d => 
                d.message.includes('must use') && d.message.includes('yield')
            )).toBe(true);
        });

        test('should error when yielding value with void yield type', async () => {
            const code = `
                cfn voidYieldingValue() -> void {
                    yield 42
                }
            `;
            const diagnostics = await parseAndGetDiagnostics(code);
            const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(d => d.message.includes('void'))).toBe(true);
        });

        test('should error when yielding void with non-void yield type', async () => {
            const code = `
                cfn missingYieldValue() -> u32 {
                    yield
                }
            `;
            const diagnostics = await parseAndGetDiagnostics(code);
            const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.some(d => 
                d.message.includes('must yield a value') ||
                d.message.includes('yield a value')
            )).toBe(true);
        });
    });

    describe('Coroutine Type Inference', () => {
        test('should infer common type from multiple yields', async () => {
            const code = `
                cfn numGen() {
                    yield 1
                    yield 2
                    yield 3
                }
            `;
            const diagnostics = await parseAndGetDiagnostics(code);
            expect(diagnostics).toHaveLength(0);
        });

        test('should handle struct yields', async () => {
            const code = `
                cfn structGen() {
                    yield {x: 1u32, y: 2u32}
                    yield {x: 3u32, y: 4u32}
                }
            `;
            const diagnostics = await parseAndGetDiagnostics(code);
            expect(diagnostics).toHaveLength(0);
        });

        test('should error on incompatible struct fields', async () => {
            const code = `
                cfn incompatibleStructs() {
                    yield {x: 1u32, y: 2u32}
                    yield {x: "oops", y: 4u32}
                }
            `;
            const diagnostics = await parseAndGetDiagnostics(code);
            const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
            expect(errors.length).toBeGreaterThan(0);
        });


        test('should work on lambda coroutine functions', async () => {
            const code = `
                // Test coroutine instance types

                // ✅ Creating a coroutine instance from a coroutine function
                cfn loop(x: u32[]) -> u32 {
                    yield x[0]
                    yield x[1]
                }

                fn main() {
                    // co has type: coroutine<fn(x: u32[]) -> u32>
                    let co = coroutine loop
                    
                    // Calling the coroutine instance multiple times
                    let x = co([1u32, 2u32, 3u32])  // yields u32
                    let y = co([4u32, 5u32, 6u32])  // yields u32
                    let z = co([7u32, 8u32, 9u32])  // yields u32
                }

                // ✅ Coroutine instance with different parameter types
                cfn stringGen(prefix: string, count: u32) -> string {
                    yield prefix
                }

                fn testStrings() {
                    let co = coroutine stringGen
                    let a = co("hello", 5u32)
                    let b = co("world", 10u32)
                }

                // ✅ Coroutine instance from lambda
                fn testLambdaCoroutine() {
                    let co = coroutine cfn(n: u32) -> u32 {
                        yield n
                        yield n + 1u32
                    }
                    
                    let x = co(10u32)
                }
            `;
            const diagnostics = await parseAndGetDiagnostics(code);
            expect(diagnostics).toHaveLength(0);
        });
    });
});