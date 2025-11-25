import { describe, expect, test } from "vitest";
import { clearFileDocuments, setupLanguageServices } from "../test-utils.js";
import { readFile } from "fs/promises";
import path from "path";

describe('Function Overload Validation', async () => {
    const { parseAndValidate, services } = setupLanguageServices();
    const testFilesDir = path.join("test", "test-cases", "typing");

    describe('Valid Overloads', () => {
        test('should allow overloads with different parameter types', async () => {
            const content = await readFile(path.join(testFilesDir, 'overloads/correct/valid-overloads.tc'), 'utf-8');
            const document = await parseAndValidate(content);
            
            // Should have no validation errors for valid overloads
            const diagnostics = document.diagnostics || [];
            const errorMessages = diagnostics.map((d: any) => `Line ${d.range.start.line}: ${d.message}`);
            
            expect(diagnostics.length, `Expected no errors but got:\n${errorMessages.join('\n')}`).toBe(0);
            
            clearFileDocuments(services.TypeC);
        });

        test('should allow overloads with different parameter counts', async () => {
            const content = await readFile(path.join(testFilesDir, 'overloads/correct/valid-overloads.tc'), 'utf-8');
            const document = await parseAndValidate(content);
            
            // Verify the 'add' function has multiple valid overloads
            expect(document.diagnostics?.length ?? 0).toBe(0);
            
            clearFileDocuments(services.TypeC);
        });

        test('should allow overloads in namespaces', async () => {
            const content = await readFile(path.join(testFilesDir, 'overloads/correct/valid-overloads.tc'), 'utf-8');
            const document = await parseAndValidate(content);
            
            // Verify namespace functions can be overloaded
            expect(document.diagnostics?.length ?? 0).toBe(0);
            
            clearFileDocuments(services.TypeC);
        });

        test('should allow same function name in different scopes', async () => {
            const content = await readFile(path.join(testFilesDir, 'overloads/correct/valid-overloads.tc'), 'utf-8');
            const document = await parseAndValidate(content);
            
            // The file has 'outerFn' in multiple scopes - should be valid
            expect(document.diagnostics?.length ?? 0).toBe(0);
            
            clearFileDocuments(services.TypeC);
        });
    });

    describe('Invalid Overloads', () => {
        test('should detect duplicate function overloads', async () => {
            const content = await readFile(path.join(testFilesDir, 'overloads/incorrect/duplicate-overloads.tc'), 'utf-8');
            const document = await parseAndValidate(content);
            
            const diagnostics = document.diagnostics || [];
            const errorMessages = diagnostics.map((d: any) => d.message);
            
            // Should have validation errors for duplicate overloads
            expect(diagnostics.length).toBeGreaterThan(0);
            
            // Check for duplicate overload errors
            const duplicateErrors = errorMessages.filter((msg: string) => 
                msg.includes('Duplicate function overload') || msg.includes('Generic function')
            );
            expect(duplicateErrors.length).toBeGreaterThan(0);
            
            clearFileDocuments(services.TypeC);
        });

        test('should reject overloading generic functions', async () => {
            const content = await readFile(path.join(testFilesDir, 'overloads/incorrect/duplicate-overloads.tc'), 'utf-8');
            const document = await parseAndValidate(content);
            
            const diagnostics = document.diagnostics || [];
            const errorMessages = diagnostics.map((d: any) => d.message);
            
            // Check for generic function overload errors
            const genericErrors = errorMessages.filter((msg: string) => 
                msg.includes('Generic function') && msg.includes('cannot be overloaded')
            );
            expect(genericErrors.length).toBeGreaterThan(0);
            
            clearFileDocuments(services.TypeC);
        });

        test('should detect that return type does not affect overload signature', async () => {
            const content = await readFile(path.join(testFilesDir, 'overloads/incorrect/duplicate-overloads.tc'), 'utf-8');
            const document = await parseAndValidate(content);
            
            const diagnostics = document.diagnostics || [];
            
            // The test file has cases where functions differ only by return type
            // Case 1: add(u32, u32) -> u32 vs add(u32, u32) -> i32 (lines ~5-11)
            // Case 3: log(string) vs log(string) -> void (lines ~24-30)
            const duplicateReturnTypeErrors = diagnostics.filter((d: any) => {
                const line = d.range.start.line;
                const message = d.message;
                // Check for errors around the duplicate functions that differ only by return type
                return message.includes('Duplicate function overload') && 
                       ((line >= 9 && line <= 12) || (line >= 27 && line <= 31));
            });
            
            expect(duplicateReturnTypeErrors.length).toBeGreaterThan(0);
            
            clearFileDocuments(services.TypeC);
        });

        test('should detect duplicates in namespaces', async () => {
            const content = await readFile(path.join(testFilesDir, 'overloads/incorrect/duplicate-overloads.tc'), 'utf-8');
            const document = await parseAndValidate(content);
            
            const diagnostics = document.diagnostics || [];
            const errorMessages = diagnostics.map((d: any) => d.message);
            
            // Check that namespace duplicates are also detected
            const namespaceDuplicates = errorMessages.filter((msg: string) => 
                msg.includes('Duplicate function overload') && msg.includes('helper')
            );
            
            // Should have at least one duplicate in the Utils namespace
            expect(namespaceDuplicates.length).toBeGreaterThan(0);
            
            clearFileDocuments(services.TypeC);
        });
    });

    describe('Generic Inference with Overloads', () => {
        test('should allow using overloaded non-generic functions in generic contexts', async () => {
            const content = await readFile(path.join(testFilesDir, 'overloads/correct/overload-generic-inference.tc'), 'utf-8');
            const document = await parseAndValidate(content);
            
            const diagnostics = document.diagnostics || [];
            const errorMessages = diagnostics.map((d: any) => `Line ${d.range.start.line}: ${d.message}`);
            
            // Should have no validation errors - overloaded non-generic functions work in generic contexts
            expect(diagnostics.length, `Expected no errors but got:\n${errorMessages.join('\n')}`).toBe(0);
            
            clearFileDocuments(services.TypeC);
        });
    });

    describe('Class Method Overloads', () => {
        describe('Valid Class Method Overloads', () => {
            test('should allow class methods with different parameter types', async () => {
                const content = await readFile(path.join(testFilesDir, 'overloads/correct/class-method-overloads.tc'), 'utf-8');
                const document = await parseAndValidate(content);
                
                const diagnostics = document.diagnostics || [];
                const errorMessages = diagnostics.map((d: any) => `Line ${d.range.start.line}: ${d.message}`);
                
                expect(diagnostics.length, `Expected no errors but got:\n${errorMessages.join('\n')}`).toBe(0);
                
                clearFileDocuments(services.TypeC);
            });

            test('should allow operator overloading in classes', async () => {
                const content = await readFile(path.join(testFilesDir, 'overloads/correct/class-method-overloads.tc'), 'utf-8');
                const document = await parseAndValidate(content);
                
                // File contains Vec2 class with operator overloading
                expect(document.diagnostics?.length ?? 0).toBe(0);
                
                clearFileDocuments(services.TypeC);
            });

            test('should allow static method overloads', async () => {
                const content = await readFile(path.join(testFilesDir, 'overloads/correct/class-method-overloads.tc'), 'utf-8');
                const document = await parseAndValidate(content);
                
                // File contains Factory class with static method overloads
                expect(document.diagnostics?.length ?? 0).toBe(0);
                
                clearFileDocuments(services.TypeC);
            });
        });

        describe('Invalid Class Method Overloads', () => {
            test('should detect duplicate class method overloads', async () => {
                const content = await readFile(path.join(testFilesDir, 'overloads/incorrect/class-method-duplicate-overloads.tc'), 'utf-8');
                const document = await parseAndValidate(content);
                
                const diagnostics = document.diagnostics || [];
                const errorMessages = diagnostics.map((d: any) => d.message);
                
                // Should have validation errors
                expect(diagnostics.length).toBeGreaterThan(0);
                
                // Check for duplicate overload errors
                const duplicateErrors = errorMessages.filter((msg: string) =>
                    msg.includes('Duplicate class method overload') || msg.includes('Generic class method')
                );
                expect(duplicateErrors.length).toBeGreaterThan(0);
                
                clearFileDocuments(services.TypeC);
            });

            test('should reject overloading generic class methods', async () => {
                const content = await readFile(path.join(testFilesDir, 'overloads/incorrect/class-method-duplicate-overloads.tc'), 'utf-8');
                const document = await parseAndValidate(content);
                
                const diagnostics = document.diagnostics || [];
                const errorMessages = diagnostics.map((d: any) => d.message);
                
                // Check for generic method overload errors
                const genericErrors = errorMessages.filter((msg: string) =>
                    msg.includes('Generic class method') && msg.includes('cannot be overloaded')
                );
                expect(genericErrors.length).toBeGreaterThan(0);
                
                clearFileDocuments(services.TypeC);
            });

            test('should detect that return type does not affect class method signature', async () => {
                const content = await readFile(path.join(testFilesDir, 'overloads/incorrect/class-method-duplicate-overloads.tc'), 'utf-8');
                const document = await parseAndValidate(content);
                
                const diagnostics = document.diagnostics || [];
                
                // The test file has cases where methods differ only by return type
                const duplicateReturnTypeErrors = diagnostics.filter((d: any) => {
                    const line = d.range.start.line;
                    const message = d.message;
                    // Check for errors in Calculator and Logger classes
                    return message.includes('Duplicate class method overload') &&
                           ((line >= 9 && line <= 12) || (line >= 28 && line <= 35));
                });
                
                expect(duplicateReturnTypeErrors.length).toBeGreaterThan(0);
                
                clearFileDocuments(services.TypeC);
            });
        });
    });

    describe('Interface Method Overloads', () => {
        describe('Valid Interface Method Overloads', () => {
            test('should allow interface methods with different parameter types', async () => {
                const content = await readFile(path.join(testFilesDir, 'overloads/correct/interface-method-overloads.tc'), 'utf-8');
                const document = await parseAndValidate(content);
                
                const diagnostics = document.diagnostics || [];
                const errorMessages = diagnostics.map((d: any) => `Line ${d.range.start.line}: ${d.message}`);
                
                expect(diagnostics.length, `Expected no errors but got:\n${errorMessages.join('\n')}`).toBe(0);
                
                clearFileDocuments(services.TypeC);
            });

            test('should allow operator overloading in interfaces', async () => {
                const content = await readFile(path.join(testFilesDir, 'overloads/correct/interface-method-overloads.tc'), 'utf-8');
                const document = await parseAndValidate(content);
                
                // File contains Addable interface with operator overloading
                expect(document.diagnostics?.length ?? 0).toBe(0);
                
                clearFileDocuments(services.TypeC);
            });
        });

        describe('Invalid Interface Method Overloads', () => {
            test('should detect duplicate interface method overloads', async () => {
                const content = await readFile(path.join(testFilesDir, 'overloads/incorrect/interface-method-duplicate-overloads.tc'), 'utf-8');
                const document = await parseAndValidate(content);
                
                const diagnostics = document.diagnostics || [];
                const errorMessages = diagnostics.map((d: any) => d.message);
                
                // Should have validation errors
                expect(diagnostics.length).toBeGreaterThan(0);
                
                // Check for duplicate overload errors
                const duplicateErrors = errorMessages.filter((msg: string) =>
                    msg.includes('Duplicate interface method overload') || msg.includes('Generic interface method')
                );
                expect(duplicateErrors.length).toBeGreaterThan(0);
                
                clearFileDocuments(services.TypeC);
            });

            test('should detect that return type does not affect interface method signature', async () => {
                const content = await readFile(path.join(testFilesDir, 'overloads/incorrect/interface-method-duplicate-overloads.tc'), 'utf-8');
                const document = await parseAndValidate(content);
                
                const diagnostics = document.diagnostics || [];
                
                // The test file has cases where methods differ only by return type
                const duplicateReturnTypeErrors = diagnostics.filter((d: any) => {
                    const message = d.message;
                    return message.includes('Duplicate interface method overload');
                });
                
                expect(duplicateReturnTypeErrors.length).toBeGreaterThan(0);
                
                clearFileDocuments(services.TypeC);
            });
        });
    });
});