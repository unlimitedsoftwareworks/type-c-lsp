# Contextual Typing Test Cases

This directory contains comprehensive test cases for contextual typing in Type-C, covering all major data types and their combinations.

## Structure

```
aaa-contextual/
├── correct/           # Valid contextual typing cases
│   ├── variant-contextual.tc
│   ├── lambda-contextual.tc
│   ├── struct-contextual.tc
│   ├── array-contextual.tc
│   └── mixed-contextual.tc
└── incorrect/         # Invalid cases that should produce errors
    ├── variant-contextual-errors.tc
    ├── lambda-contextual-errors.tc
    ├── struct-contextual-errors.tc
    ├── array-contextual-errors.tc
    └── mixed-contextual-errors.tc
```

## Test Coverage

### 1. Variant Contextual Typing
**Files:** `variant-contextual.tc`, `variant-contextual-errors.tc`

Tests variant constructor inference and covariance:
- Basic variant constructor inference from context
- Lambda with explicit return type matching variant
- Array of variant constructors with unified types
- Nested variant types
- Variants with structs inside
- Higher-order functions with variants
- Match expressions with variant inference

**Key Error Cases:**
- Wrong variant type in lambda return (Result vs Result2)
- Mismatched generic arguments
- Wrong constructor for variant
- Nested variant type mismatch

### 2. Lambda Contextual Typing
**Files:** `lambda-contextual.tc`, `lambda-contextual-errors.tc`

Tests lambda parameter and return type inference:
- Lambda parameter inference from expected function type
- Lambda return type inference with contextual typing
- Nested lambda inference
- Lambda with struct/variant return types
- Lambda capturing with contextual typing
- Lambda chain operations

**Key Error Cases:**
- Lambda parameter type mismatch
- Lambda return type doesn't match declaration
- Wrong parameter count
- Nested lambda type mismatch
- Lambda with explicit wrong return type

### 3. Struct Contextual Typing
**Files:** `struct-contextual.tc`, `struct-contextual-errors.tc`

Tests struct field inference and structural typing:
- Anonymous struct with contextual typing
- Struct spread with contextual typing
- Nested structs
- Array of structs with contextual typing
- Struct in variant
- Generic function with struct
- Join types (intersection) with structs

**Key Error Cases:**
- Missing required field
- Extra field not in struct
- Wrong field type
- Struct spread with incompatible types
- Nested struct field type mismatch
- Join type with conflicting field types

### 4. Array Contextual Typing
**Files:** `array-contextual.tc`, `array-contextual-errors.tc`

Tests array element type inference:
- Empty array with contextual typing
- Array element inference from context
- Array of variants with unified types
- Nested arrays
- Array with struct/tuple/option elements
- Generic functions with arrays

**Key Error Cases:**
- Empty array without type context
- Array element type mismatch
- Mixed types in array
- Nested array depth mismatch
- Array with wrong element types

### 5. Mixed Contextual Typing
**Files:** `mixed-contextual.tc`, `mixed-contextual-errors.tc`

Tests complex scenarios combining multiple features:
- Array of variants with lambda mapping
- Lambda returning struct in variant
- Higher-order functions with complex types
- Nested structures with full contextual typing
- Lambda chains with variants and structs
- Complex tuples with everything

**Key Error Cases:**
- Multiple incompatible types in single expression
- Complex nested errors
- Higher-order function composing incompatible types
- Multiple nested errors with variants and structs

## Testing Approach

All test files follow the inline annotation format where errors are marked with `...` delimiters to indicate expected error locations.

### Correct Cases
Valid code that should pass type checking, demonstrating proper contextual typing inference.

### Incorrect Cases
Invalid code that should produce type errors, testing the validator's ability to catch contextual typing violations.

## Key Concepts Tested

1. **Never Type Covariance**: `Result<i32, never>` is assignable to `Result<i32, string>`
2. **Generic Inference**: Type parameters inferred from arguments and context
3. **Structural Typing**: Structs matched by field names and types
4. **Nominal Typing**: Variants identified by declaration, not structure
5. **Lambda Inference**: Parameters and return types inferred from expected function type
6. **Array Unification**: Finding common types across array elements
7. **Nested Inference**: Types propagated through complex nested structures

## Related Documentation

- [Type System Architecture](../../../src/typing/TYPE_SYSTEM_ARCHITECTURE.md)
- [Generic Substitution](../../../src/typing/GENERIC_SUBSTITUTION.md)
- [Type System](../../../src/typing/TYPE_SYSTEM.md)