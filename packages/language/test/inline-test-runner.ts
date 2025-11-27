/**
 * Inline Test Runner for Type-C
 * 
 * Provides utilities to run tests based on inline annotations in .tc files
 */

import { AstNode, LangiumDocument } from 'langium';
import { isAstNode } from 'langium';
import type { Diagnostic } from 'vscode-languageserver-types';
import {
    parseTestAnnotations,
    validateAllAnnotations,
    type FileTestResults,
    type Range,
    type ParsedTestFile
} from './inline-test-annotations.js';

/**
 * Options for running inline tests
 */
export interface InlineTestOptions {
    /**
     * Whether to include type checking (requires TypeProvider)
     */
    checkTypes?: boolean;
    
    /**
     * Whether to print detailed results
     */
    verbose?: boolean;
}

/**
 * Result of running inline tests on a file
 */
export interface InlineTestResult extends FileTestResults {
    filePath: string;
    source: string;
    parsed: ParsedTestFile;
}

/**
 * Run inline tests on a source string
 */
export async function runInlineTestOnSource(
    source: string,
    document: LangiumDocument,
    typeProvider?: { getType: (node: AstNode) => { toString: () => string } },
    options: InlineTestOptions = {}
): Promise<Omit<InlineTestResult, 'filePath'>> {
    const parsed = parseTestAnnotations(source);
    const diagnostics: Diagnostic[] = document.diagnostics ?? [];

    // Create type getter if type checking is enabled and type provider is available
    const typeGetter = options.checkTypes && typeProvider
        ? (line: number, range?: Range): string | undefined => {
            if (!range) {
                return undefined;
            }
            
            // Find AST node at the specified range
            const node = findNodeAtRange(document, range);
            if (!node) return undefined;

            return typeProvider.getType(node).toString();
        }
        : (_line: number, _range?: Range) => undefined;

    // Validate all annotations
    const results = validateAllAnnotations(parsed, diagnostics, typeGetter);

    return {
        ...results,
        source,
        parsed
    };
}

/**
 * Find AST node at a specific range
 */
function findNodeAtRange(document: LangiumDocument, range: Range): AstNode | undefined {
    const rootNode = document.parseResult.value;
    if (!rootNode) return undefined;

    // Simple implementation - you may want to enhance this
    // by doing a proper tree traversal
    const offset = document.textDocument.offsetAt({
        line: range.start.line,
        character: range.start.character
    });

    return findNodeAtOffset(rootNode, offset);
}

/**
 * Find AST node at a specific offset
 */
function findNodeAtOffset(node: AstNode, offset: number): AstNode | undefined {
    if (!node.$cstNode) return undefined;

    const nodeStart = node.$cstNode.offset;
    const nodeEnd = node.$cstNode.end;

    if (offset < nodeStart || offset > nodeEnd) {
        return undefined;
    }

    // Check children
    for (const [, value] of Object.entries(node)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                if (isAstNode(item)) {
                    const child = findNodeAtOffset(item, offset);
                    if (child) return child;
                }
            }
        } else if (isAstNode(value)) {
            const child = findNodeAtOffset(value, offset);
            if (child) return child;
        }
    }

    return node;
}


/**
 * Format test results for console output
 */
export function formatTestResults(result: InlineTestResult, verbose: boolean = false): string {
    const lines: string[] = [];
    
    lines.push(`\n📄 ${result.filePath}`);
    lines.push(`   Total: ${result.totalAnnotations} | ✅ Passed: ${result.passed} | ❌ Failed: ${result.failed}`);

    if (result.failed > 0 || verbose) {
        lines.push('');
        for (const testResult of result.results) {
            if (!testResult.passed || verbose) {
                const prefix = testResult.passed ? '  ✅' : '  ❌';
                lines.push(`${prefix} Line ${testResult.annotation.line + 1}: ${testResult.message}`);
                
                if (verbose && testResult.actual) {
                    lines.push(`     Actual: ${testResult.actual}`);
                }
            }
        }
    }

    return lines.join('\n');
}

/**
 * Format multiple test results
 */
export function formatMultipleTestResults(results: InlineTestResult[], verbose: boolean = false): string {
    const lines: string[] = [];
    
    const totalTests = results.reduce((sum, r) => sum + r.totalAnnotations, 0);
    const totalPassed = results.reduce((sum, r) => sum + r.passed, 0);
    const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);

    lines.push('\n' + '='.repeat(60));
    lines.push('📊 INLINE TEST RESULTS');
    lines.push('='.repeat(60));

    for (const result of results) {
        lines.push(formatTestResults(result, verbose));
    }

    lines.push('\n' + '='.repeat(60));
    lines.push(`📈 SUMMARY: ${totalTests} total | ✅ ${totalPassed} passed | ❌ ${totalFailed} failed`);
    lines.push('='.repeat(60) + '\n');

    return lines.join('\n');
}

/**
 * Check if all tests passed
 */
export function allTestsPassed(results: InlineTestResult[]): boolean {
    return results.every(r => r.failed === 0);
}