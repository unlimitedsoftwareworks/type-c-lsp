# Type-C Typing Test Cases

This directory contains test cases for the Type-C type system, organized by data type category and expected outcome.

## Directory Structure

```
typing/
├── variants/
│   ├── correct/           # Valid variant type tests that should pass
│   │   ├── variant-generics.tc
│   │   └── variant-constructor-types.tc
│   └── incorrect/         # Invalid variant tests that should fail validation
│
├── structs/
│   ├── correct/           # Valid struct type tests that should pass
│   │   ├── struct-tests.tc
│   │   └── struct-common-types.tc
│   └── incorrect/         # Invalid struct tests that should fail validation
│
├── classes/
│   ├── correct/           # Valid class/interface tests that should pass
│   │   └── classes-interfaces.tc
│   └── incorrect/         # Invalid class tests that should fail validation
│
├── functions/
│   ├── correct/           # Valid function tests that should pass
│   │   ├── test001.tc (fibonacci example)
│   │   ├── function-inference.tc
│   │   └── return-inference.tc
│   └── incorrect/         # Invalid function tests that should fail validation
│       └── return-type-errors.tc
│
├── primitives/
│   ├── correct/           # Valid primitive type tests that should pass
│   │   └── basic-types.tc
│   └── incorrect/         # Invalid primitive tests that should fail validation
│
├── coercion/
│   ├── correct/           # Valid type coercion tests that should pass
│   │   └── type-coercion.tc
│   └── incorrect/         # Invalid coercion tests that should fail validation
│
└── mixed/
    ├── correct/           # Complex tests with multiple type features
    │   └── advanced-types.tc (variants, arrays, nullables, casts)
    └── incorrect/         # Complex invalid tests
```

## Test Categories

### `correct/` Folders
Test files in `correct/` folders contain valid Type-C code that should:
- Parse without errors
- Have no validation diagnostics
- Type-check successfully
- Match expected type inferences

### `incorrect/` Folders
Test files in `incorrect/` folders contain invalid Type-C code that should:
- Parse successfully (syntax is valid)
- Produce specific validation errors
- Test error detection and reporting

## Adding New Tests

When adding new test cases:

1. **Determine the category**: variants, structs, classes, functions, primitives, coercion, or mixed
2. **Choose correct/incorrect**: Based on whether the test should pass or fail validation
3. **Create the test file**: Add your `.tc` file in the appropriate subfolder
4. **Update test runner**: Add assertions in `test/typing/type-provider.test.ts`

### Example for `correct/` tests:
```typescript
test('should infer my new feature', async () => {
    await assertType('category/correct/my-test.tc', {
        'varName': 'ExpectedType',
    });
});
```

### Example for `incorrect/` tests:
```typescript
test('should detect error in my case', async () => {
    const content = await readFile(
        path.join(testFilesDir, 'category/incorrect/my-error-test.tc'),
        'utf-8'
    );
    const document = await parseAndValidate(content);
    expect(document.diagnostics?.length).toBe(expectedErrorCount);
    // Add specific error assertions...
});
```

## Type-C Type System Rules

Remember these key Type-C semantics when writing tests:

- **Structural typing** for interfaces, structs (duck typing)
- **Nominal typing** for classes (name-based)
- **Unions** (`|`) only for generic constraints
- **Tuples** only for returns and unpacking
- **Type coercion** only at depth 0 (primitives)
- **Variant constructors** are subtypes of their variant
- **Partial inference** fills uninferrable generics with `never`

See `CLAUDE.md` in the repository root for full details.
