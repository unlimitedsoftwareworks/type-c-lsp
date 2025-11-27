# Inline Test Annotations for Type-C

A comprehensive inline test annotation system that allows you to embed test expectations directly in `.tc` files using special comment annotations.

## Overview

This system eliminates the need for separate test files that check error snippets. Instead, you can write all test expectations directly in your `.tc` source files, making tests more maintainable and easier to understand.

## Features

- ✅ **Error Checking**: Validate that specific errors occur at expected locations
- ✅ **Type Checking**: Assert the inferred types of expressions
- ✅ **Warning/Info Checking**: Verify warnings and informational messages
- ✅ **No-Error Assertions**: Ensure code sections are error-free
- ✅ **Precise Range Specification**: Pinpoint exact positions in your code
- ✅ **Error Code Validation**: Match specific error codes (e.g., TCE021)

## Annotation Syntax

All annotations use triple-slash doc comments (`///`) and must appear **on the line immediately before** the code they test.

### Error Annotations

```tc
/// @Error: Expected error message
let x: u32 = "hello"  // Type error on this line

/// @Error(TCE006): Variable type mismatch
let y: u32 = false  // Error with specific code

/// @Error[4:10]: Type mismatch
let z: u32 = "test"  // Error at character positions 4-10

/// @Error[35:8:11]: Specific error
let w: bool = 123  // Error at line 35, characters 8-11
```

### Warning Annotations

```tc
/// @Warning: Variable might be unused
let unused = 42u32

/// @Warning(TCW001): Specific warning code
let another_unused = "test"
```

### Info Annotations

```tc
/// @Info: Consider using const instead
let mutable_but_never_changed = 42u32
```

### Type Annotations

```tc
/// @Type: u32[]
let numbers = [1u32, 2u32, 3u32]

/// @Type: {x: u32, y: u32}
let point = {x: 10u32, y: 20u32}

/// @Type[10:15]: string
let name = "Alice"  // Check type at specific range
```

### No-Error Annotations

```tc
/// @NoError
let validCode: u32 = 42u32

/// @NoError[0:20]
let another = "correct"  // No errors in character range 0-20
```

## Range Specifications

Ranges pinpoint exact code locations:

```tc
/// @Error[start:end]: message
// Range on the next line, from character 'start' to 'end'

/// @Error[line:start:end]: message  
// Range on absolute line number

/// @Error[+N:start:end]: message
// Range N lines after the annotation
```

**Note**: Line numbers are 0-based internally, but displayed as 1-based in errors.

## Usage in Tests

### Basic Test

```typescript
import { describe, test } from 'vitest';
import { setupLanguageServices, expectInlineTestsPass } from './test-utils.js';
import path from 'path';

describe('My Tests', () => {
    const setup = setupLanguageServices();

    test('should validate inline annotations', async () => {
        const filePath = path.join(__dirname, 'test-cases/my-test.tc');
        await expectInlineTestsPass(setup, filePath);
    });
});
```

### Advanced Usage

```typescript
import { runInlineTestFile, formatTestResults } from './test-utils.js';

// Run tests with options
const result = await runInlineTestFile(setup, filePath, {
    checkTypes: true,  // Enable type checking
    verbose: true      // Show all results, not just failures
});

// Print formatted results
console.log(formatTestResults(result, true));

// Check results
if (result.failed > 0) {
    console.error(`${result.failed} tests failed`);
}
```

### Multiple Files

```typescript
import { expectAllInlineTestsPass } from './test-utils.js';

const files = [
    path.join(__dirname, 'test-cases/file1.tc'),
    path.join(__dirname, 'test-cases/file2.tc'),
];

await expectAllInlineTestsPass(setup, files);
```

## Example Test File

```tc
// Test basic type errors
/// @Error: Type mismatch
let x: u32 = "hello"

// Test coroutine errors  
cfn loop(x: u32[]) -> u32 {
    yield x[0]
}

fn testCoroutine() {
    let co = coroutine loop
    
    /// @Error(TCE023): Coroutine call argument 1 type mismatch
    let result = co([1, 2, 3])  // i32[] instead of u32[]
}

// Test type inference
/// @Type: u32[]
let numbers = [1u32, 2u32, 3u32]

// Ensure valid code has no errors
/// @NoError
let valid: u32 = 42u32
```

## API Reference

### Functions

#### `parseTestAnnotations(content: string): ParsedTestFile`
Parse annotations from source code.

#### `runInlineTestFile(setup, filePath, options?): Promise<InlineTestResult>`
Run inline tests on a file.

**Options**:
- `checkTypes?: boolean` - Enable type checking (default: false)
- `verbose?: boolean` - Show all results (default: false)

#### `expectInlineTestsPass(setup, filePath, options?)`
Assert that all inline tests in a file pass. Throws if any fail.

#### `expectAllInlineTestsPass(setup, filePaths, options?)`
Assert that all inline tests in multiple files pass.

#### `formatTestResults(result, verbose?): string`
Format test results for console output.

#### `formatMultipleTestResults(results, verbose?): string`
Format results from multiple files.

### Types

```typescript
interface InlineTestResult {
    filePath: string;
    totalAnnotations: number;
    passed: number;
    failed: number;
    results: AnnotationTestResult[];
    source: string;
    parsed: ParsedTestFile;
}

interface AnnotationTestResult {
    annotation: TestAnnotation;
    passed: boolean;
    message: string;
    actual?: string;
}

type TestAnnotation = 
    | DiagnosticAnnotation  // @Error, @Warning, @Info
    | TypeAnnotation        // @Type
    | NoErrorAnnotation;    // @NoError
```

## Best Practices

### 1. Place Annotations Close to Code

```tc
/// @Error: Type mismatch
let x: u32 = "hello"  // ✅ Good: annotation right before the error
```

### 2. Be Specific with Error Messages

```tc
/// @Error: Coroutine call argument 1 type mismatch
let x = co([1, 2, 3])  // ✅ Good: specific message

/// @Error: error
let y = co([1, 2, 3])  // ❌ Bad: too vague
```

### 3. Use Error Codes When Available

```tc
/// @Error(TCE023): Coroutine call argument type mismatch
let x = co([1, 2, 3])  // ✅ Good: includes error code
```

### 4. Group Related Tests

```tc
// ============================================================
// COROUTINE ERROR TESTS
// ============================================================

cfn loop(x: u32[]) -> u32 {
    yield x[0]
}

fn testErrors() {
    let co = coroutine loop
    
    /// @Error(TCE023): Wrong argument type
    let x = co([1, 2, 3])
    
    /// @Error(TCE022): Wrong argument count
    let y = co()
}
```

### 5. Use No-Error for Valid Examples

```tc
/// @NoError
let valid = validateFunction(correctInput)
```

## Troubleshooting

### Annotation Not Found

**Problem**: `✗ Expected error not found: "message" (No matching diagnostic found)`

**Solutions**:
- Check that the error actually occurs on the next line
- Verify the error message is correct (partial match works)
- Use range specification if error is on a different line

### Line Mismatch

**Problem**: `(Line mismatch: diagnostic at line 54, expected at line 11)`

**Solutions**:
- Move annotation directly before the problematic line
- Use absolute line number: `/// @Error[54:0:10]: message`
- Check for off-by-one errors in your test file

### Type Check Fails

**Problem**: `✗ Could not determine type at line 54`

**Solutions**:
- Ensure `checkTypes: true` is set in options
- Verify the expression is on the target line
- Use range specification: `/// @Type[10:20]: u32`

### Parser Doesn't Recognize Annotation

**Problem**: Annotation is ignored

**Solutions**:
- Use triple-slash (`///`), not double-slash (`//`)
- Follow exact syntax: `/// @Error: message`
- No extra spaces: `/// @Error:message` not `///@Error : message`

## Migration from Old Tests

### Before (separate test file)

```typescript
test('should error on wrong type', async () => {
    const code = `let x: u32 = "hello"`;
    const diagnostics = await parseAndGetDiagnostics(code);
    const errors = diagnostics.filter(d => d.severity === 1);
    expect(errors.some(d => d.message.includes('Type mismatch'))).toBe(true);
});
```

### After (inline annotation)

```tc
/// @Error: Type mismatch
let x: u32 = "hello"
```

```typescript
test('should validate inline tests', async () => {
    await expectInlineTestsPass(setup, 'path/to/file.tc');
});
```

## Benefits

1. **Co-located Tests**: Tests live with the code they test
2. **Better Maintainability**: Update tests when you update code
3. **Self-Documenting**: Code shows what errors are expected
4. **Easier to Write**: No boilerplate test code
5. **Faster Iteration**: See all expectations in one place
6. **Better Coverage**: Easy to add more test cases

## Limitations

- Type checking requires TypeProvider integration (work in progress)
- Cannot test runtime behavior, only compile-time diagnostics
- Annotations must use doc comments (`///`)
- Each annotation applies to the immediately following line (unless range is specified)

## Future Enhancements

- [ ] Support for multi-line annotations
- [ ] Custom assertion functions
- [ ] Test generation from annotations
- [ ] IDE integration for inline test running
- [ ] Snapshot testing support
- [ ] Coverage reporting

## Contributing

To add new annotation types:

1. Add the annotation type to `TestAnnotation` in `inline-test-annotations.ts`
2. Add parsing logic in `parseAnnotationLine()`
3. Add validation logic in `validateAllAnnotations()`
4. Update this documentation

## Support

For issues or questions:
- Check the troubleshooting section
- Review example files in `test/test-cases/typing/`
- See `inline-annotations.test.ts` for usage examples