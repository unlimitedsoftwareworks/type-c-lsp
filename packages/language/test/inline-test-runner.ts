/**
 * Inline Test Runner for Type-C
 *
 * Provides utilities to run tests based on inline annotations in .tc files
 */

import { AstNode, AstUtils, CstUtils, LangiumDocument } from 'langium';
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
    const lines = source.split('\n');

    // Create type getter if type checking is enabled and type provider is available
    const typeGetter = options.checkTypes && typeProvider
        ? (line: number, range?: Range, substring?: string): string | undefined => {
            let actualRange = range;
            
            // If substring is provided but no range, search for identifier nodes with that name
            if (substring && !range && line < lines.length) {
                // Find the identifier node semantically (like VSCode's "Find All References")
                actualRange = findIdentifierInLine(document, line, substring);
            }
            
            if (!actualRange) {
                return undefined;
            }
            
            // Find AST node at the specified range
            const node = findNodeAtRange(document, actualRange);
            if (!node) return undefined;

            return typeProvider.getType(node).toString();
        }
        : (_line: number, _range?: Range, _substring?: string) => undefined;

    // Validate all annotations
    const results = validateAllAnnotations(parsed, diagnostics, typeGetter);

    return {
        ...results,
        source,
        parsed
    };
}

/**
 * Find AST node at a specific range using Langium's CstUtils
 */
function findNodeAtRange(document: LangiumDocument, range: Range): AstNode | undefined {
    const rootNode = document.parseResult.value;
    if (!rootNode || !rootNode.$cstNode) return undefined;

    // Calculate offset from the range start position
    const offset = document.textDocument.offsetAt({
        line: range.start.line,
        character: range.start.character
    });

    // Use Langium's built-in utility to find the leaf node at the offset
    const leafNode = CstUtils.findLeafNodeAtOffset(rootNode.$cstNode, offset);
    if (!leafNode) return undefined;

    // Return the AST node associated with the leaf CST node
    return leafNode.astNode;
}

/**
 * Find an identifier with the given name in a specific line
 * Searches semantically through AST nodes (like VSCode's whole-word search)
 */
function findIdentifierInLine(document: LangiumDocument, targetLine: number, identifierName: string): Range | undefined {
    const rootNode = document.parseResult.value;
    if (!rootNode) return undefined;

    const lineText = document.textDocument.getText({
        start: { line: targetLine, character: 0 },
        end: { line: targetLine + 1, character: 0 }
    });

    // Find all identifier-like nodes in the AST that are on the target line
    const candidates: Array<{ node: AstNode; range: Range }> = [];
    
    AstUtils.streamAllContents(rootNode).forEach(node => {
        if (!node.$cstNode) return;
        
        const nodeRange = node.$cstNode.range;
        // Check if node is on the target line
        if (nodeRange.start.line === targetLine || nodeRange.end.line === targetLine) {
            // Check if this node represents an identifier
            // Look for nodes with a 'name' property or reference-like properties
            const nodeName = getNodeIdentifierName(node);
            if (nodeName === identifierName) {
                candidates.push({
                    node,
                    range: nodeRange
                });
            }
        }
    });

    // Return the LAST match (like old tests)
    if (candidates.length > 0) {
        return candidates[candidates.length - 1].range;
    }

    // Fallback to text-based search if no semantic match found
    const regex = new RegExp(`\\b${identifierName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const matches = Array.from(lineText.matchAll(regex));
    if (matches.length > 0) {
        const lastMatch = matches[matches.length - 1];
        const index = lastMatch.index!;
        return {
            start: { line: targetLine, character: index },
            end: { line: targetLine, character: index + identifierName.length }
        };
    }

    return undefined;
}

/**
 * Extract the identifier name from an AST node
 */
function getNodeIdentifierName(node: AstNode): string | undefined {
    // Try common identifier properties using proper type checking
    
    // Direct name property
    if ('name' in node && typeof node.name === 'string') {
        return node.name;
    }
    
    // Reference to another node ($refText for unresolved references)
    if ('$refText' in node && typeof node.$refText === 'string') {
        return node.$refText;
    }
    
    // Variable reference (resolved reference)
    if ('ref' in node && node.ref && typeof node.ref === 'object' && 'name' in node.ref && typeof node.ref.name === 'string') {
        return node.ref.name;
    }
    
    return undefined;
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