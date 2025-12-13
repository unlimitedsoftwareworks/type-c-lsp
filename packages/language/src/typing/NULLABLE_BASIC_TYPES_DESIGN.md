# Nullable Basic Types Design

## Problem Statement

The type system initially prevented nullable basic types (like `u32?`, `bool?`) from existing at all, returning error types immediately when attempting to create them. This validation-at-creation approach caused issues with valid operations:

### Examples of the Problem

```typescript
// Case 1: Optional chaining with method returning basic type
interface Vec {
    fn get() -> u32
}
let v: Vec? = ...
let x = v?.get()  // Should work, but what type should x have?

// Case 2: Nullish coalescing should handle null case
let y = v?.get() ?? 1u32  // Should work and return u32

// Case 3: Array with null and basic values
let nums = [1u32, null, 3u32]  // Should error - can't create u32?[]
```

## Root Cause

The validation was placed in the **wrong layer** - the type factory was rejecting nullable basic types immediately, preventing the type system from handling them properly.

## Solution Design

### Core Principle: Never Create Nullable Basic Types

The solution follows a "prevent at source" approach:

1. **Don't wrap basic types with nullable** during optional chaining
2. **Validate in `getCommonType`** for expressions that would infer nullable basics
3. **Validate at declaration points** as a safety net

### Type System Behavior

When you use optional chaining on a method that returns a basic type:

```typescript
v?.get()  // get() returns u32
```

**What happens**:
1. Check if `v` is null → if yes, short-circuit to `null`
2. If not null, call `get()` → returns `u32`
3. Result is `u32`, **NOT** `u32?`

This makes sense because:
- The `?.` operator handles the null check
- If the method executes, it returns a non-nullable `u32`
- There's no need to wrap the result in nullable

### Implementation Details

#### 1. Factory Layer

**File**: `packages/language/src/typing/type-factory.ts`

```typescript
/**
 * Creates a nullable type.
 * 
 * This factory does NOT validate - it just creates the type.
 * Prevention of nullable basic types happens at the call sites.
 */
createNullableType(baseType: TypeDescription, node?: AstNode): TypeDescription {
    return createNullableType(baseType, node);
}
```

#### 2. Type Provider Layer (Optional Chaining)

**File**: `packages/language/src/typing/type-c-type-provider.ts`

**Member Access** (lines 2563-2565, 2585-2587, 2710-2712):
```typescript
// Wrap in nullable if using optional chaining
// BUT: Don't wrap basic types - they can't be nullable
if (node.isNullable || baseIsNullable) {
    if (!this.typeUtils.isTypeBasic(memberType)) {
        memberType = this.typeFactory.createNullableType(memberType, node);
    }
}
```

**Function Calls** (lines 2739-2743, 2748-2753, 2791-2796, etc.):
```typescript
// Wrap return type in nullable if this was an optional call
// Don't wrap basic types with nullable
if (isOptionalCall && !this.typeUtils.isTypeBasic(returnType)) {
    return this.typeFactory.createNullableType(returnType, node);
}
return returnType;
```

**Index Access** (lines 3083-3089):
```typescript
// Wrap in nullable if using optional chaining
// BUT: Don't wrap basic types - they can't be nullable
if (node.isNullable || baseIsNullable) {
    if (!this.typeUtils.isTypeBasic(resultType)) {
        resultType = this.typeFactory.createNullableType(resultType, node);
    }
}
```

#### 3. Type Utility Layer (Common Type Inference)

**File**: `packages/language/src/typing/type-utils.ts`

**`getCommonType`** validation (lines 2218-2228, 2345-2355):
```typescript
// When wrapping in nullable, check if result is nullable basic
if (unwrappedTypes.some(item => item.wasNullable)) {
    commonType = this.typeFactory.createNullableType(commonType, types[0].node);
    
    // Validate: no nullable basic types allowed
    if (isNullableType(commonType) && this.isTypeBasic(commonType.baseType)) {
        return this.typeFactory.createErrorType(
            `Cannot create expression with nullable basic type '${commonType.toString()}'...`
        );
    }
}
```

This catches:
- Array literals: `[1u32, null, 3u32]` → Error
- Match expressions: `match x { 0 => 1u32, _ => null }` → Error
- Function returns: Multiple returns with nullable basics → Error

#### 4. Validation Layer (Variable Binding)

**File**: `packages/language/src/validations/type-system-validations.ts`

**Six specialized validators**:

1. **`checkNullableType`** - Explicit `T?` syntax
2. **`checkVariableDeclSingle`** - Local variable final types
3. **`checkFunctionParameter`** - Function parameter types
4. **`checkClassAttributeDecl`** - Class attribute types
5. **`checkIteratorVar`** - Iterator variable types
6. **`checkVariablePattern`** - Pattern variable types

### How It Works

#### Example 1: Optional Chaining with Basic Type Return

```typescript
interface Vec {
    fn get() -> u32
}
let v: Vec? = ...
let x = v?.get()  // x: u32 (NOT u32?)
```

**Flow**:
1. `v` has type `Vec?`
2. Optional chaining `?.` unwraps to `Vec`
3. `get()` returns `u32`
4. Check: Is `u32` a basic type? **Yes**
5. **Don't wrap with nullable** → result is `u32` ✅
6. `x` inferred as `u32` ✅

#### Example 2: Optional Chaining with Reference Type Return

```typescript
interface Container {
    fn getData() -> Data  // Data is a class
}
let c: Container? = ...
let d = c?.getData()  // d: Data?
```

**Flow**:
1. `c` has type `Container?`
2. Optional chaining `?.` unwraps to `Container`
3. `getData()` returns `Data`
4. Check: Is `Data` a basic type? **No**
5. **Wrap with nullable** → result is `Data?` ✅
6. `d` inferred as `Data?` ✅

#### Example 3: Nullish Coalescing

```typescript
let y = v?.get() ?? 1u32  // y: u32
```

**Flow**:
1. `v?.get()` returns `u32` (basic type not wrapped)
2. `??` operator: left is `u32` (not nullable)
3. Since left is not nullable, `??` just returns left side
4. Result is `u32` ✅

**Note**: The `??` operator can now be simplified since optional chaining never produces nullable basic types!

#### Example 4: Array Literal (Error Case)

```typescript
let nums = [1u32, null, 3u32]  // ❌ Error
```

**Flow**:
1. Elements: `u32`, `null`, `u32`
2. `getCommonType([u32, null, u32])` called
3. Tries to create nullable wrapper for `u32`
4. Detects nullable basic type → returns ErrorType ❌

#### Example 5: Generic Instantiation (Error Case)

```typescript
fn test<T>(x: T) -> T? = null
let z = test<u32>(1)  // ❌ Error: Variable cannot have nullable basic type
```

**Flow**:
1. Function signature is valid (T could be reference type)
2. `test<u32>(1)` substitutes T with `u32`
3. Return type becomes `u32?`
4. **`checkVariableDeclSingle`** detects final type is nullable basic
5. Error reported ❌

### Why This Design Works

#### 1. Optional Chaining Never Creates Nullable Basics
When you use `?.` on methods returning basic types:
- The result is the basic type itself, not wrapped in nullable
- This makes sense: `?.` handles the null check, the method returns non-null
- Simplifies the type system significantly

#### 2. Common Type Inference Validates
When combining values that would create nullable basic:
- `[1u32, null]` → `getCommonType` catches this
- `match x { 0 => 1u32, _ => null }` → `getCommonType` catches this
- Centralized validation for all expression contexts

#### 3. Variable Validators Provide Safety Net
Even if nullable basics escape inference:
- All variable binding points are validated
- Catches generic instantiation edge cases
- Ensures no nullable basics reach actual variable storage

#### 4. Clean Separation of Concerns
- **Provider**: Never creates nullable basics from basic types during `?.`
- **Utility**: Validates when inferring common types
- **Validator**: Validates at binding points

### Complete Coverage

The solution prevents nullable basic types through multiple layers:

**Layer 1: Prevention at Source** (Type Provider)
- ❌ `v?.get()` where `get()` returns `u32` → returns `u32`, not `u32?`
- ❌ Optional chaining on basic type returns → no wrapping
- ✅ Optional chaining on reference types → wrapping allowed

**Layer 2: Inference Validation** (Type Utils)  
- ❌ `[1u32, null, 3u32]` → `getCommonType` returns error
- ❌ `match x { 0 => 1u32, _ => null }` → error
- ❌ Function returns mixing null and basics → error

**Layer 3: Declaration Validation** (Validators)
- ❌ `let x: u32? = ...` → `checkNullableType`
- ❌ `let x = test<u32>(1)` → `checkVariableDeclSingle`
- ❌ `fn foo(x: u32?)` → `checkFunctionParameter`
- ❌ All other binding contexts → specific validators

### Testing Strategy

#### Valid Operations (Should Work)
1. `v?.get()` where `get()` returns `u32` → type is `u32` ✅
2. `v?.get() ?? 1u32` → type is `u32` ✅
3. `v?.getData()` where `getData()` returns `Data` (class) → type is `Data?` ✅
4. `v?.getData() ?? defaultData` → type is `Data` ✅
5. Chained optional: `v?.getData()?.process()` ✅

#### Invalid Operations (Should Error)
1. **Explicit nullable basic**: `let x: u32? = 42` ❌
2. **Array with null**: `let nums = [1u32, null, 3u32]` ❌
3. **Match with null**: `match x { 0 => 1u32, _ => null }` ❌
4. **Generic instantiation**: `let x = wrap<u32>(1)` where `wrap<T>() -> T?` ❌
5. **Parameter generic**: `fn foo<T>(x: T?) {}; foo<u32>(1)` ❌

### Benefits

1. **Simplicity**: Optional chaining never creates nullable basics - clean and intuitive
2. **Correctness**: Type inference works naturally for all null-aware operations
3. **Complete Coverage**: Three-layer defense (prevention + inference + declaration)
4. **Efficiency**: Most cases prevented at source, reducing downstream validation
5. **Clarity**: Clear error messages with proper context
6. **Type Safety**: No way for nullable basic types to exist in the program
7. **Maintainability**: Logic is distributed appropriately across layers

### Comparison with TypeScript

TypeScript allows nullable primitives:
```typescript
let x: number | null = null;  // OK in TypeScript
let arr: (number | null)[] = [1, null, 3];  // OK in TypeScript
```

Type-C is more restrictive:
```typescript
let x: u32? = null;  // ❌ Error in Type-C
let arr: u32?[] = [1, null, 3];  // ❌ Error in Type-C
```

This design decision:
- Prevents common null-related bugs
- Encourages using proper null handling with `??` operator
- Makes code more explicit about null handling
- Aligns with the language's focus on type safety

### Migration Notes

This change is **backward compatible**:
- Valid code continues to work
- Optional chaining behavior is clarified (doesn't wrap basics with nullable)
- Invalid code (explicit nullable basic types) still errors
- Better error messages and more consistent behavior

### Future Enhancements

Possible future improvements:
1. **Flow-sensitive typing**: Track null checks to narrow types
2. **Smart unwrapping**: Automatic unwrapping in safe contexts
3. **Refined error messages**: Suggest alternatives for common patterns

## Conclusion

By implementing a "prevent at source" approach:

1. **Type Provider Layer**: Never wraps basic types with nullable during `?.` operations
2. **Type Utility Layer**: `getCommonType` validates when inferring types from multiple values
3. **Validation Layer**: Safety net validators for all variable binding contexts

We achieve a clean, efficient solution where:
- ✅ Optional chaining on basic type methods returns the basic type directly
- ✅ Nullable wrapper is only used for reference types during `?.`
- ✅ Array literals, match expressions, etc. are validated in `getCommonType`
- ✅ Variable declarations are validated as a final safety check
- ✅ No nullable basic types can exist anywhere in the program
- ✅ Type system is simpler and more intuitive
- ✅ Complete type safety maintained

The solution is **clean, efficient, and comprehensive** - preventing nullable basic types at their source during optional chaining while maintaining validation layers for other contexts.