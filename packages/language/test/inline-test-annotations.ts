/**
 * Inline Test Annotation System for Type-C
 * 
 * This system allows embedding test expectations directly in .tc files using special comment annotations.
 * Supports:
 * - Error checking with message and code validation
 * - Type checking for specific expressions
 * - Warning checking
 * - No-error assertions
 * - Precise range specification
 * 
 * @example
 * ```tc
 * /// @Error: Type mismatch expected
 * let x: u32 = "hello"
 * 
 * /// @Error(TCE021): Function call argument type mismatch
 * let y = someFunc(wrongType)
 * 
 * /// @Type: u32[]
 * let arr = [1u32, 2u32, 3u32]
 * 
 * /// @NoError
 * let valid = "correct code"
 * ```
 */

import type { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';

/**
 * Represents a position in the source code
 */
export interface Position {
    line: number;      // 0-based line number
    character: number; // 0-based character offset
}

/**
 * Represents a range in the source code
 */
export interface Range {
    start: Position;
    end: Position;
}

/**
 * Base annotation interface
 */
export interface Annotation {
    type: 'error' | 'warning' | 'type' | 'no-error' | 'info';
    line: number;           // Line number where annotation is defined (0-based)
    targetLine: number;     // Line number where check should be applied (0-based)
    range?: Range;          // Optional specific range to check
    sourceLine: string;     // Original annotation line for debugging
}

/**
 * Error/Warning annotation
 */
export interface DiagnosticAnnotation extends Annotation {
    type: 'error' | 'warning' | 'info';
    message: string;        // Expected error/warning message (can be partial)
    code?: string;          // Expected error code (e.g., TCE021)
    severity?: DiagnosticSeverity;
}

/**
 * Type annotation
 */
export interface TypeAnnotation extends Annotation {
    type: 'type';
    expectedType: string;   // Expected type string
    substring?: string;     // Optional substring to find in the target line
}

/**
 * No-error annotation
 */
export interface NoErrorAnnotation extends Annotation {
    type: 'no-error';
}

/**
 * Union of all annotation types
 */
export type TestAnnotation = DiagnosticAnnotation | TypeAnnotation | NoErrorAnnotation;

/**
 * Parsed test file with annotations
 */
export interface ParsedTestFile {
    content: string;
    lines: string[];
    annotations: TestAnnotation[];
}

/**
 * Test result for a single annotation
 */
export interface AnnotationTestResult {
    annotation: TestAnnotation;
    passed: boolean;
    message: string;
    actual?: string;
}

/**
 * Overall test results for a file
 */
export interface FileTestResults {
    filePath: string;
    totalAnnotations: number;
    passed: number;
    failed: number;
    results: AnnotationTestResult[];
}

/**
 * Parse range specification from annotation
 * Formats:
 * - [start:end] - range on target line
 * - [line:start:end] - range on specific line
 * - [+N:start:end] - range N lines after annotation
 */
function parseRangeSpec(rangeSpec: string, annotationLine: number): Range | undefined {
    const match = rangeSpec.match(/^\[([+\d]+):(\d+):(\d+)\]$|^\[(\d+):(\d+)\]$/);
    if (!match) return undefined;

    if (match[1] !== undefined) {
        // Format: [line:start:end] or [+N:start:end]
        const lineSpec = match[1];
        const start = parseInt(match[2]);
        const end = parseInt(match[3]);
        
        const line = lineSpec.startsWith('+') 
            ? annotationLine + parseInt(lineSpec.substring(1)) 
            : parseInt(lineSpec);

        return {
            start: { line, character: start },
            end: { line, character: end }
        };
    } else {
        // Format: [start:end] - on next line after annotation
        const start = parseInt(match[4]);
        const end = parseInt(match[5]);
        return {
            start: { line: annotationLine + 1, character: start },
            end: { line: annotationLine + 1, character: end }
        };
    }
}

/**
 * Parse a single annotation line
 */
function parseAnnotationLine(line: string, lineNumber: number): TestAnnotation | null {
    const trimmed = line.trim();
    
    // Must start with /// (doc comment)
    if (!trimmed.startsWith('///')) return null;
    
    const content = trimmed.substring(3).trim();
    
    // @Error annotation: /// @Error[(code)][range]: message
    const errorMatch = content.match(/^@Error(?:\(([A-Z0-9]+)\))?(?:(\[[^\]]+\]))?:\s*(.+)$/);
    if (errorMatch) {
        const [, code, rangeSpec, message] = errorMatch;
        return {
            type: 'error',
            line: lineNumber,
            targetLine: lineNumber + 1,
            range: rangeSpec ? parseRangeSpec(rangeSpec, lineNumber) : undefined,
            message: message.trim(),
            code: code,
            severity: 1, // DiagnosticSeverity.Error
            sourceLine: line
        };
    }

    // @Warning annotation: /// @Warning[(code)][range]: message
    const warningMatch = content.match(/^@Warning(?:\(([A-Z0-9]+)\))?(?:(\[[^\]]+\]))?:\s*(.+)$/);
    if (warningMatch) {
        const [, code, rangeSpec, message] = warningMatch;
        return {
            type: 'warning',
            line: lineNumber,
            targetLine: lineNumber + 1,
            range: rangeSpec ? parseRangeSpec(rangeSpec, lineNumber) : undefined,
            message: message.trim(),
            code: code,
            severity: 2, // DiagnosticSeverity.Warning
            sourceLine: line
        };
    }

    // @Info annotation: /// @Info[(code)][range]: message
    const infoMatch = content.match(/^@Info(?:\(([A-Z0-9]+)\))?(?:(\[[^\]]+\]))?:\s*(.+)$/);
    if (infoMatch) {
        const [, code, rangeSpec, message] = infoMatch;
        return {
            type: 'info',
            line: lineNumber,
            targetLine: lineNumber + 1,
            range: rangeSpec ? parseRangeSpec(rangeSpec, lineNumber) : undefined,
            message: message.trim(),
            code: code,
            severity: 3, // DiagnosticSeverity.Information
            sourceLine: line
        };
    }

    // @Type annotation: /// @Type(substring): expectedType OR /// @Type[range]: expectedType
    const typeMatch = content.match(/^@Type(?:\(([^)]+)\))?(?:(\[[^\]]+\]))?:\s*(.+)$/);
    if (typeMatch) {
        const [, substring, rangeSpec, expectedType] = typeMatch;
        return {
            type: 'type',
            line: lineNumber,
            targetLine: lineNumber + 1,
            range: rangeSpec ? parseRangeSpec(rangeSpec, lineNumber) : undefined,
            expectedType: expectedType.trim(),
            substring: substring?.trim(),
            sourceLine: line
        };
    }

    // @NoError annotation: /// @NoError[range]
    const noErrorMatch = content.match(/^@NoError(?:(\[[^\]]+\]))?$/);
    if (noErrorMatch) {
        const [, rangeSpec] = noErrorMatch;
        return {
            type: 'no-error',
            line: lineNumber,
            targetLine: lineNumber + 1,
            range: rangeSpec ? parseRangeSpec(rangeSpec, lineNumber) : undefined,
            sourceLine: line
        };
    }

    return null;
}

/**
 * Parse a .tc file and extract all test annotations
 */
export function parseTestAnnotations(content: string): ParsedTestFile {
    const lines = content.split('\n');
    const annotations: TestAnnotation[] = [];

    for (let i = 0; i < lines.length; i++) {
        const annotation = parseAnnotationLine(lines[i], i);
        if (annotation) {
            annotations.push(annotation);
        }
    }

    return {
        content,
        lines,
        annotations
    };
}

/**
 * Check if a range overlaps with or is within another range
 */
function rangesOverlap(range1: Range, range2: Range): boolean {
    // Same line check first
    if (range1.start.line !== range2.start.line && range1.end.line !== range2.end.line) {
        // Check if ranges span multiple lines and overlap
        const r1Start = range1.start.line;
        const r1End = range1.end.line;
        const r2Start = range2.start.line;
        const r2End = range2.end.line;
        
        return !(r1End < r2Start || r2End < r1Start);
    }

    // Single line or same line - check character overlap
    if (range1.start.line === range2.start.line) {
        const r1Start = range1.start.character;
        const r1End = range1.end.character;
        const r2Start = range2.start.character;
        const r2End = range2.end.character;
        
        return !(r1End < r2Start || r2End < r1Start);
    }

    return false;
}

/**
 * Check if diagnostic matches annotation
 */
function diagnosticMatchesAnnotation(
    diagnostic: Diagnostic,
    annotation: DiagnosticAnnotation
): { matches: boolean; reason?: string } {
    // Check severity
    if (diagnostic.severity !== annotation.severity) {
        return { 
            matches: false, 
            reason: `Severity mismatch: expected ${annotation.severity}, got ${diagnostic.severity}` 
        };
    }

    // Check range if specified
    if (annotation.range) {
        if (!rangesOverlap(diagnostic.range, annotation.range)) {
            return { 
                matches: false, 
                reason: `Range mismatch: diagnostic at [${diagnostic.range.start.line}:${diagnostic.range.start.character}..${diagnostic.range.end.line}:${diagnostic.range.end.character}], expected at [${annotation.range.start.line}:${annotation.range.start.character}..${annotation.range.end.line}:${annotation.range.end.character}]` 
            };
        }
    } else {
        // Check target line if no specific range
        const diagLine = diagnostic.range.start.line;
        if (diagLine !== annotation.targetLine) {
            return { 
                matches: false, 
                reason: `Line mismatch: diagnostic at line ${diagLine}, expected at line ${annotation.targetLine}` 
            };
        }
    }

    // Check code if specified
    if (annotation.code && diagnostic.code !== annotation.code) {
        return { 
            matches: false, 
            reason: `Code mismatch: expected ${annotation.code}, got ${diagnostic.code}` 
        };
    }

    // Check message (partial match)
    if (!diagnostic.message.includes(annotation.message)) {
        return { 
            matches: false, 
            reason: `Message mismatch: expected to contain "${annotation.message}", got "${diagnostic.message}"` 
        };
    }

    return { matches: true };
}

/**
 * Validate diagnostic annotations against actual diagnostics
 */
export function validateDiagnosticAnnotations(
    annotations: DiagnosticAnnotation[],
    diagnostics: Diagnostic[]
): AnnotationTestResult[] {
    const results: AnnotationTestResult[] = [];
    const unmatchedDiagnostics = [...diagnostics];

    for (const annotation of annotations) {
        let matched = false;
        let failureReason = 'No matching diagnostic found';

        for (let i = 0; i < unmatchedDiagnostics.length; i++) {
            const diagnostic = unmatchedDiagnostics[i];
            const matchResult = diagnosticMatchesAnnotation(diagnostic, annotation);
            
            if (matchResult.matches) {
                matched = true;
                unmatchedDiagnostics.splice(i, 1);
                results.push({
                    annotation,
                    passed: true,
                    message: `✓ Found expected ${annotation.type}: "${annotation.message}"`,
                    actual: diagnostic.message
                });
                break;
            } else {
                failureReason = matchResult.reason || failureReason;
            }
        }

        if (!matched) {
            results.push({
                annotation,
                passed: false,
                message: `✗ Expected ${annotation.type} not found: "${annotation.message}" (${failureReason})`,
                actual: undefined
            });
        }
    }

    return results;
}

/**
 * Validate type annotations against actual types
 */
export function validateTypeAnnotations(
    annotations: TypeAnnotation[],
    typeGetter: (line: number, range?: Range, substring?: string) => string | undefined
): AnnotationTestResult[] {
    const results: AnnotationTestResult[] = [];

    for (const annotation of annotations) {
        const actualType = typeGetter(annotation.targetLine, annotation.range, annotation.substring);
        
        if (actualType === undefined) {
            const location = annotation.substring
                ? `for substring "${annotation.substring}"`
                : `at line ${annotation.targetLine}`;
            results.push({
                annotation,
                passed: false,
                message: `✗ Could not determine type ${location}`,
                actual: undefined
            });
            continue;
        }

        const passed = actualType === annotation.expectedType;
        results.push({
            annotation,
            passed,
            message: passed
                ? `✓ Type matches: ${annotation.expectedType}`
                : `✗ Type mismatch: expected "${annotation.expectedType}", got "${actualType}"`,
            actual: actualType
        });
    }

    return results;
}

/**
 * Validate no-error annotations
 */
export function validateNoErrorAnnotations(
    annotations: NoErrorAnnotation[],
    diagnostics: Diagnostic[]
): AnnotationTestResult[] {
    const results: AnnotationTestResult[] = [];

    for (const annotation of annotations) {
        const relevantDiagnostics = diagnostics.filter(d => {
            if (annotation.range) {
                return rangesOverlap(d.range, annotation.range);
            }
            return d.range.start.line === annotation.targetLine;
        });

        const passed = relevantDiagnostics.length === 0;
        results.push({
            annotation,
            passed,
            message: passed
                ? `✓ No errors as expected`
                : `✗ Found ${relevantDiagnostics.length} unexpected diagnostic(s)`,
            actual: relevantDiagnostics.length > 0 
                ? relevantDiagnostics.map(d => d.message).join('; ')
                : undefined
        });
    }

    return results;
}

/**
 * Type predicates for filtering annotations
 */
function isTypeAnnotation(annotation: TestAnnotation): annotation is TypeAnnotation {
    return annotation.type === 'type';
}

function isNoErrorAnnotation(annotation: TestAnnotation): annotation is NoErrorAnnotation {
    return annotation.type === 'no-error';
}

/**
 * Validate all annotations in a parsed file
 */
export function validateAllAnnotations(
    parsed: ParsedTestFile,
    diagnostics: Diagnostic[],
    typeGetter: (line: number, range?: Range, substring?: string) => string | undefined
): FileTestResults {
    const errorAnnotations = parsed.annotations.filter((a): a is DiagnosticAnnotation => a.type === 'error');
    const warningAnnotations = parsed.annotations.filter((a): a is DiagnosticAnnotation => a.type === 'warning');
    const infoAnnotations = parsed.annotations.filter((a): a is DiagnosticAnnotation => a.type === 'info');
    const typeAnnotations = parsed.annotations.filter(isTypeAnnotation);
    const noErrorAnnotations = parsed.annotations.filter(isNoErrorAnnotation);

    const results: AnnotationTestResult[] = [
        ...validateDiagnosticAnnotations(errorAnnotations, diagnostics.filter(d => d.severity === 1)),
        ...validateDiagnosticAnnotations(warningAnnotations, diagnostics.filter(d => d.severity === 2)),
        ...validateDiagnosticAnnotations(infoAnnotations, diagnostics.filter(d => d.severity === 3)),
        ...validateTypeAnnotations(typeAnnotations, typeGetter),
        ...validateNoErrorAnnotations(noErrorAnnotations, diagnostics)
    ];

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    return {
        filePath: '',
        totalAnnotations: results.length,
        passed,
        failed,
        results
    };
}