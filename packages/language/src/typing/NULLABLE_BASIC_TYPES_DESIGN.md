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
let x = v?.get()  // Should be u32?, but factory returned ErrorType

// Case 2: Nullish coalescing should handle null case
let y = v?.get() ?? 1u32  // Should work: u32? ?? u32 -> u32
                           // But factory prevented u32? from existing

// Case 3: Chained optional access
let z = v?.get().toString()  // Should propagate nullability
```

In all cases, the intermediate `u32?` type is:
1. **Necessary** for correct type inference
2. **Safe** because it's consumed by null-handling operators (`??`, `!`) or checked before use
3. **Not user-declared** - it's an internal representation

## Root Cause

The validation was placed in the **wrong layer** - the type factory (`createNullableType()`) was rejecting nullable basic types immediately, preventing them from existing even temporarily during type inference.

## Solution Design

### Core Principle: Separate Creation from Validation

The solution follows a clear separation of concerns:

1. **Factory Layer** (`type-factory.ts`): Creates types without judgment
   - Allows any nullable type to be created, including nullable basic types
   - Acts as a pure constructor - no business logic

2. **Validation Layer** (`type-system-validations.ts`): Validates usage contexts
   - Checks explicit type declarations (e.g., `let x: u32?`)
   - Reports errors only for user-visible type annotations

### Type Lifecycle

```
Creation → Inference → Consumption → Validation
   ↓          ↓            ↓            ↓
Factory   Provider    Provider     Validator
(allow)   (propagate) (transform)  (check decls)
```

### Implementation Details

#### 1. Factory Layer Changes

**File**: `packages/language/src/typing/type-factory.ts`

**Before**:
```typescript
createNullableType(baseType: TypeDescription, node?: AstNode): TypeDescription {
    // Check if baseType is a basic type (or resolves to one)
    if (this.typeUtils().isTypeBasic(baseType)) {
        return createErrorType(
            `Cannot create nullable type from basic type...`,
            ErrorCode.TC_NULLABLE_PRIMITIVE_TYPE,
            node
        );
    }
    return createNullableType(baseType, node);
}
```

**After**:
```typescript
/**
 * Creates a nullable type.
 * 
 * IMPORTANT: This factory method does NOT validate whether creating 
 * a nullable basic type is appropriate for the usage context. 
 * It simply creates the type description.
 * 
 * Validation happens at the validation layer, which checks explicit 
 * type declarations like `let x: u32?` and reports them as errors.
 * 
 * This design allows nullable basic types to exist temporarily during 
 * type inference and be consumed by null-handling operators.
 */
createNullableType(baseType: TypeDescription, node?: AstNode): TypeDescription {
    // No validation here - just create the type
    return createNullableType(baseType, node);
}
```

**Key Changes**:
- Removed validation logic from factory
- Added comprehensive documentation explaining the design
- Factory now acts as a pure constructor

#### 2. Validation Layer

**File**: `packages/language/src/validations/type-system-validations.ts`

The validation layer has **multiple validators** to comprehensively catch nullable basic types in all contexts:

**Validator 1: Explicit Type Annotations** (`checkNullableType`):
```typescript
checkNullableType(node: ast.NullableType, accept: ValidationAcceptor) {
    let type = this.typeProvider.getType(node.baseType);
    if(this.typeUtils.isTypeBasic(type)) {
        accept('error', 'Basic types cannot be nullables', ...);
    }
}
```

**Validator 2: Variable Declarations** (`checkVariableDeclSingle`):
```typescript
checkVariableDeclSingle = (node: ast.VariableDeclSingle, ...) => {
    // Check final type (annotation or inferred)
    if (isNullableType(finalType) && this.typeUtils.isTypeBasic(finalType.baseType)) {
        accept('error', ...);
    }
}
```

**Validator 3: Function Parameters** (`checkFunctionParameter`):
```typescript
checkFunctionParameter = (node: ast.FunctionParameter, ...) => {
    const paramType = this.typeProvider.getType(node.type);
    if (isNullableType(paramType) && this.typeUtils.isTypeBasic(...)) {
        accept('error', `Parameter '${node.name}' cannot have...`);
    }
}
```

**Validator 4: Class Attributes** (`checkClassAttributeDecl`):
```typescript
checkClassAttributeDecl = (node: ast.ClassAttributeDecl, ...) => {
    const attrType = this.typeProvider.getType(node.type);
    if (isNullableType(attrType) && this.typeUtils.isTypeBasic(...)) {
        accept('error', `Attribute '${node.name}' cannot have...`);
    }
}
```

**Validator 5: Iterator Variables** (`checkIteratorVar`):
```typescript
checkIteratorVar = (node: ast.IteratorVar, ...) => {
    const varType = this.typeProvider.getType(node);
    if (isNullableType(varType) && this.typeUtils.isTypeBasic(...)) {
        accept('error', `Iterator variable '${node.name}' cannot have...`);
    }
}
```

**Validator 6: Pattern Variables** (`checkVariablePattern`):
```typescript
checkVariablePattern = (node: ast.VariablePattern, ...) => {
    const varType = this.typeProvider.getType(node);
    if (isNullableType(varType) && this.typeUtils.isTypeBasic(...)) {
        accept('error', `Pattern variable '${node.name}' cannot have...`);
    }
}
```

#### 3. Type Utility Layer (Common Type Inference)

**File**: `packages/language/src/typing/type-utils.ts`

**Enhanced `getCommonType`** - Validates nullable basic type creation:
```typescript
getCommonType(types: TypeDescription[]): TypeDescription {
    // ... existing logic to find common type ...
    
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
}
```

**Why validate in `getCommonType`?**

`getCommonType` is the **centralized** function used for:
- Array literal type inference: `[1u32, null, 3u32]`
- Function return type inference from multiple returns
- Match expression type inference from all arms
- Conditional expression type inference

By validating here, we catch nullable basic types **at the point they're created** across all these contexts, eliminating the need for separate validators for each.

**Coverage Map**:

| Context | Validator/Layer | Examples |
|---------|-----------------|----------|
| Explicit `T?` syntax | `checkNullableType` | `let x: u32?`, `fn foo() -> bool?` |
| Variable declarations | `checkVariableDeclSingle` | `let x = get<u32>()` where `get<T>() -> T?` |
| Function parameters | `checkFunctionParameter` | `fn foo(x: u32?)`, generic params |
| Class attributes | `checkClassAttributeDecl` | `class C { let x: u32? }` |
| Iterator variables | `checkIteratorVar` | `foreach x: u32? in ...` |
| Match patterns | `checkVariablePattern` | `match val { x => ... }` where x is u32? |
| **Array/Match/Function** | **`getCommonType`** | **`[1u32, null]`, match arms, returns** |

**Why This Design?**

Validation happens at **two strategic layers**:
1. **Variable declaration validators** (6 validators): Catch nullable basics bound to names
2. **Type utility layer** (`getCommonType`): Catch nullable basics in type inference

This ensures complete coverage with minimal redundancy.

### How It Works

#### Example 1: Optional Chaining

```typescript
interface Vec {
    fn get() -> u32
}
let v: Vec? = ...
let x = v?.get()  // x: u32?
```

**Flow**:
1. `v` has type `Vec?`
2. Optional chaining `?.` unwraps to `Vec`
3. `get()` returns `u32`
4. Optional chaining wraps result: `u32?` ✅ (factory allows creation)
5. `x` inferred as `u32?` ✅
6. No validation error because `u32?` not explicitly declared

#### Example 2: Nullish Coalescing

```typescript
let y = v?.get() ?? 1u32  // y: u32
```

**Flow**:
1. `v?.get()` creates intermediate `u32?` ✅
2. `??` operator checks left side is nullable
3. `??` unwraps: `u32? ?? u32 -> u32` ✅
4. `y` inferred as `u32` ✅
5. No nullable basic type in final result

#### Example 3: Explicit Declaration (Error Case)

```typescript
let x: u32? = 42  // ❌ Error: Basic types cannot be nullables
```

**Flow**:
1. Parser creates `NullableType` AST node for `u32?`
2. Factory creates `u32?` type (no error yet)
3. **Checkpoint 1**: `checkNullableType` detects basic type `u32` in annotation
4. Error reported to user ❌

#### Example 4: Generic Instantiation (Error Case)

```typescript
fn get<T>(x: T) -> T? = null
let x = get<u32>(1)  // ❌ Error: Variable 'x' cannot have nullable basic type 'u32?'
```

**Flow**:
1. Function `get` has valid signature (T could be reference type)
2. Call `get<u32>(1)` substitutes `T` with `u32`
3. Return type becomes `u32?` (factory allows creation)
4. Variable `x` would have type `u32?`
5. **Validator 2**: `checkVariableDeclSingle` detects final type is nullable basic
6. Error reported to user ❌

#### Example 5: Function Parameter (Error Case)

```typescript
fn process<T>(data: T?) -> void {  // Valid signature
    // ...
}

process<u32>(42)  // ❌ Error: Parameter 'data' cannot have nullable basic type 'u32?'
```

**Flow**:
1. Function signature is valid (T could be reference type)
2. Call instantiates T with u32
3. Parameter type becomes `u32?`
4. **Validator 3**: `checkFunctionParameter` detects nullable basic
5. Error reported ❌

#### Example 6: Iterator Variable (Error Case)

```typescript
fn getNullableInts<T>() -> T?[] = ...
foreach x in getNullableInts<u32>() {  // ❌ Error: Iterator variable 'x' cannot have...
    // x would be u32?
}
```

**Flow**:
1. `getNullableInts<u32>()` returns `u32?[]`
2. Iterator `x` would have type `u32?`
3. **Validator 5**: `checkIteratorVar` detects nullable basic
4. Error reported ❌

#### Example 7: Array Literal with null (Error Case)

```typescript
let nums = [1u32, null, 3u32]  // ❌ Error from type inference
```

**Flow**:
1. Array elements have types: `u32`, `null`, `u32`
2. `getCommonType([u32, null, u32])` called during array type inference
3. Attempts to create `u32?` (nullable basic)
4. **`getCommonType`** detects nullable basic type and returns ErrorType
5. Array expression gets ErrorType, reported by `checkExpressionForErrors` ❌

**Valid Alternative**:
```typescript
let vecs = [vec1, null, vec2]  // ✅ OK: Vec?[] is allowed for reference types
```

#### Example 8: Match Expression (Error Case)

```typescript
match value {
    0 => 1u32,
    1 => null,
    _ => 2u32
}  // ❌ Error from getCommonType
```

**Flow**:
1. Match arms return: `u32`, `null`, `u32`
2. `getCommonType` attempts to create `u32?`
3. Detects nullable basic type and returns ErrorType ❌

### Why This Design Works

#### 1. Intermediate Types Are Allowed
Nullable basic types can exist during type inference, enabling:
- Optional chaining on methods returning basic types
- Nullish coalescing with basic types
- Complex nullable chains

#### 2. Explicit Declarations Are Rejected
Users cannot declare variables with nullable basic types:
- Catches at validation layer
- Clear error messages
- No runtime surprises

#### 3. Type Safety Maintained
The type system ensures:
- Nullable basic types can exist temporarily during inference
- They're consumed by operators (`??`, `!`) before validation
- Variables never end up with nullable basic types
- All escape paths are validated (explicit declarations + final types)

#### 4. Clean Separation of Concerns
- Factory: Pure construction, no validation logic
- Provider: Type inference and propagation
- Validator: Usage context checking

### Edge Cases Handled

#### Case 1: Deep Nullable Chains
```typescript
let result = obj?.method1()?.method2()?.getValue()
// Where getValue() returns u32
// Result type: u32? (correct)
```

#### Case 2: Multiple Nullish Coalescing
```typescript
let x = a?.getValue() ?? b?.getValue() ?? 0u32
// Intermediate u32? types consumed by ??
// Final type: u32 (correct)
```

#### Case 3: Generic with Nullable Basic Type Result
```typescript
fn wrap<T>(x: T) -> T? = null
let x = wrap<u32>(42)  // ❌ Error
// Caught by checkVariableDeclSingle - final type is u32?

let y = wrap<Vec>(vec)  // ✅ OK
// Vec? is allowed for reference types
```

#### Case 4: Generic Instantiation
```typescript
type Option<T> = variant { Some(T), None }
let x: Option<u32> = ...
let y = x.unwrap()  // y: u32 (not u32?)
```

### Testing Strategy

#### Valid Operations (Should Work)
1. `v?.method()` where method returns basic type (creates temporary `u32?`)
2. `v?.method() ?? default` with basic type (temporary consumed by `??`)
3. Chained optional access with basic types
4. Safe unwrapping with `!` operator: `v?.get()!`
5. Generics with reference types: `let x = get<Vec>()` where `get<T>() -> T?` ✅
6. Arrays of reference types with null: `let vecs = [vec1, null, vec2]` → `Vec?[]` ✅

#### Invalid Declarations (Should Error)
1. **Explicit variable annotations**: `let x: u32? = ...` (Validator: `checkNullableType`)
2. **Return type annotations**: `fn foo() -> bool? { ... }` (Validator: `checkNullableType`)
3. **Parameter annotations**: `fn foo(x: i32?) { ... }` (Validators: `checkNullableType`, `checkFunctionParameter`)
4. **Class attributes**: `class C { let x: u32? }` (Validators: `checkNullableType`, `checkClassAttributeDecl`)
5. **Generic variable instantiation**: `let x = get<u32>()` where `get<T>() -> T?` (Validator: `checkVariableDeclSingle`)
6. **Generic parameter instantiation**: `fn foo<T>(x: T?) { ... }; foo<u32>(42)` (Validator: `checkFunctionParameter`)
7. **Iterator types**: `foreach x: u32? in ...` (Validators: `checkNullableType`, `checkIteratorVar`)
8. **Pattern variables**: In match expressions that bind to nullable basics (Validator: `checkVariablePattern`)
9. **Array literals with null**: `let nums = [1u32, null, 3u32]` (Caught by: `getCommonType`)
10. **Match expressions**: `match x { 0 => 1u32, _ => null }` (Caught by: `getCommonType`)
11. **Function returns**: Multiple returns producing nullable basics (Caught by: `getCommonType`)

### Benefits

1. **Correctness**: Type inference works naturally for all nullable operations
2. **Complete Coverage**: Two-checkpoint validation catches all nullable basic type paths
3. **Safety**: No way for nullable basic types to reach variable declarations
4. **Clarity**: Clear error messages for both explicit and inferred cases
5. **Flexibility**: Allows complex nullable chains and operators to work correctly
6. **Maintainability**: Clean separation makes code easier to understand and modify

### Migration Notes

This change is **backward compatible**:
- Valid code continues to work
- Invalid code (explicit nullable basic types) still errors
- Only difference: better error messages and more consistent behavior

### Future Enhancements

Possible future improvements:
1. **Flow-sensitive typing**: Track null checks to narrow types
2. **Smart unwrapping**: Automatic unwrapping in safe contexts
3. **Refined error messages**: Suggest alternatives for common patterns
4. **Nullability inference**: Infer when values might be null

## Conclusion

By combining three layers:

1. **Factory layer** (`type-factory.ts`):
   - Allows creation of any nullable type (no validation)
   - Pure construction, no business logic

2. **Type utility layer** (`type-utils.ts`):
   - `getCommonType` validates when creating nullable types from multiple values
   - Catches: array literals, match expressions, function returns
   - Centralized validation for type inference contexts

3. **Validation layer** (`type-system-validations.ts`):
   - 6 specialized validators for variable binding contexts
   - Each validator targets specific AST node types
   - Catches: variables, parameters, attributes, iterators, patterns

We achieve:
- ✅ Nullable basic types as intermediate values during inference (e.g., `v?.get()`)
- ✅ Natural handling by null-aware operators (`??`, `!`, `?.`)
- ✅ **Complete rejection** of nullable basic types in **all** persistent contexts:
  - Variable declarations (all kinds)
  - Array/match/function expressions (via `getCommonType`)
  - Function parameters and return types
  - Class attributes
- ✅ Clear, context-specific error messages
- ✅ Type safety without sacrificing expressiveness
- ✅ Efficient: centralized logic in `getCommonType` + specific validators
- ✅ Coverage of **all** edge cases including:
  - Generic instantiation: `get<u32>()` where `get<T>() -> T?`
  - Array literals: `[1u32, null, 3u32]`
  - Match expressions: `match x { 0 => 1u32, _ => null }`
  - Iterator variables from generic collections
  - Pattern matching with type inference
  - Function returns with mixed null/basic values

The solution is **comprehensive and efficient**, using centralized validation in `getCommonType` for type inference contexts while maintaining specific validators for variable binding contexts. This achieves complete coverage with minimal code duplication.