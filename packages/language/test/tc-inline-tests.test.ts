import { describe, test } from 'vitest';
import { setupLanguageServices, expectInlineTestsPass, runInlineTestFile } from './test-utils.js';
import { readdirSync, statSync } from 'fs';
import path from 'path';
import { expect } from 'vitest';

/**
 * Recursively find all .tc files in a directory
 */
function findTcFiles(dir: string): string[] {
    const files: string[] = [];
    const entries = readdirSync(dir);
    
    for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const stat = statSync(fullPath);
        
        if (stat.isDirectory()) {
            files.push(...findTcFiles(fullPath));
        } else if (entry.endsWith('.tc')) {
            files.push(fullPath);
        }
    }
    
    return files;
}

/**
 * Check if a file is in a "correct" directory
 */
function isCorrectFile(filePath: string): boolean {
    return filePath.includes('/correct/');
}

/**
 * Check if a file is in an "incorrect" directory
 */
function isIncorrectFile(filePath: string): boolean {
    return filePath.includes('/incorrect/');
}

describe('TC Inline Tests - Comprehensive', () => {
    const setup = setupLanguageServices();
    const testCasesDir = path.join(__dirname, 'test-cases/tc-inline');
    
    // Find all .tc files
    const allFiles = findTcFiles(testCasesDir);
    const correctFiles = allFiles.filter(isCorrectFile);
    const incorrectFiles = allFiles.filter(isIncorrectFile);
    
    describe('Correct Files (should have 0 diagnostics)', () => {
        for (const filePath of correctFiles) {
            const relativePath = path.relative(testCasesDir, filePath);
            
            test(relativePath, async () => {
                const result = await runInlineTestFile(setup, filePath, {
                    checkTypes: true  // Enable type checking
                });
                
                // Correct files MUST have zero diagnostics
                const doc = await setup.parseAndValidate(
                    require('fs').readFileSync(filePath, 'utf-8')
                );
                await setup.services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
                const diagnostics = doc.diagnostics ?? [];
                const errors = diagnostics.filter(d => d.severity === 1);
                
                // Assert: no errors in correct files
                expect(errors).toHaveLength(0);
                
                // If there are annotations, they should all pass
                if (result.totalAnnotations > 0 && result.failed > 0) {
                    // Show which tests failed
                    const failedTests = result.results.filter(r => !r.passed);
                    const failureDetails = failedTests.map(r =>
                        `Line ${r.annotation.line + 1}: ${r.message}`
                    ).join('\n');
                    expect(result.failed, `Failed tests:\n${failureDetails}`).toBe(0);
                } else if (result.totalAnnotations > 0) {
                    expect(result.failed).toBe(0);
                }
            });
        }
    });
    
    describe('Incorrect Files (should have inline error annotations)', () => {
        for (const filePath of incorrectFiles) {
            const relativePath = path.relative(testCasesDir, filePath);
            
            test(relativePath, async () => {
                // Incorrect files must have annotations and all should pass
                await expectInlineTestsPass(setup, filePath, {
                    checkTypes: true  // Enable type checking
                });
            });
        }
    });
});