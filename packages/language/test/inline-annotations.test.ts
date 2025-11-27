import { describe, test, expect } from "vitest";
import { setupLanguageServices, expectInlineTestsPass, parseInlineTests } from "./test-utils.js";
import path from "path";

describe('Inline Test Annotations', () => {
    const setup = setupLanguageServices();

    test('should run inline tests from coroutine-call-errors.tc', async () => {
        const filePath = path.join(__dirname, 'test-cases/tc-inline/coroutines/incorrect/coroutine-call-errors.tc');
        const result = await expectInlineTestsPass(setup, filePath);
        
        expect(result.passed).toBeGreaterThan(0);
        expect(result.failed).toBe(0);
    });

    test('should validate simple inline annotation file', async () => {
        const filePath = path.join(__dirname, 'test-cases/tc-inline/inline-annotations-simple.tc');
        const result = await expectInlineTestsPass(setup, filePath);
        
        // The simple file should have all tests passing
        expect(result.totalAnnotations).toBeGreaterThan(0);
        expect(result.passed).toBe(result.totalAnnotations);
        expect(result.failed).toBe(0);
    });

    test('should properly detect error annotations', async () => {
        const filePath = path.join(__dirname, 'test-cases/tc-inline/coroutines/incorrect/coroutine-call-errors.tc');
        const result = await expectInlineTestsPass(setup, filePath);
        
        // Should have found at least some error annotations
        const errorResults = result.results.filter(r =>
            r.annotation.type === 'error' && r.passed
        );
        expect(errorResults.length).toBeGreaterThan(0);
    });
});

describe('Inline Annotation Parser', () => {
    test('should parse error annotations', () => {
        const code = `
            /// @Error: Type mismatch
            let x: u32 = "hello"
        `;
        
        const parsed = parseInlineTests(code);
        expect(parsed.annotations).toHaveLength(1);
        const annotation = parsed.annotations[0];
        expect(annotation.type).toBe('error');
        if (annotation.type === 'error') {
            expect(annotation.message).toBe('Type mismatch');
        }
    });

    test('should parse error annotations with code', () => {
        const code = `
            /// @Error(TCE006): Variable type mismatch
            let x: u32 = "hello"
        `;
        
        const parsed = parseInlineTests(code);
        expect(parsed.annotations).toHaveLength(1);
        const annotation = parsed.annotations[0];
        expect(annotation.type).toBe('error');
        if (annotation.type === 'error') {
            expect(annotation.code).toBe('TCE006');
        }
    });

    test('should parse type annotations', () => {
        const code = `
            /// @Type: u32[]
            let numbers = [1u32, 2u32, 3u32]
        `;
        
        const parsed = parseInlineTests(code);
        expect(parsed.annotations).toHaveLength(1);
        const annotation = parsed.annotations[0];
        expect(annotation.type).toBe('type');
        if (annotation.type === 'type') {
            expect(annotation.expectedType).toBe('u32[]');
        }
    });

    test('should parse no-error annotations', () => {
        const code = `
            /// @NoError
            let valid: u32 = 42u32
        `;
        
        const parsed = parseInlineTests(code);
        expect(parsed.annotations).toHaveLength(1);
        expect(parsed.annotations[0].type).toBe('no-error');
    });

    test('should parse range specifications', () => {
        const code = `
            /// @Error[4:10]: Type mismatch
            let x: u32 = "hello"
        `;
        
        const parsed = parseInlineTests(code);
        expect(parsed.annotations).toHaveLength(1);
        expect(parsed.annotations[0].range).toBeDefined();
        expect(parsed.annotations[0].range?.start.character).toBe(4);
        expect(parsed.annotations[0].range?.end.character).toBe(10);
    });

    test('should parse multiple annotations', () => {
        const code = `
            /// @Error: First error
            let x: u32 = "hello"
            
            /// @Error: Second error
            let y: u32 = 42.5
            
            /// @NoError
            let z: u32 = 42u32
        `;
        
        const parsed = parseInlineTests(code);
        expect(parsed.annotations).toHaveLength(3);
        expect(parsed.annotations[0].type).toBe('error');
        expect(parsed.annotations[1].type).toBe('error');
        expect(parsed.annotations[2].type).toBe('no-error');
    });
});