# Type-C Language - Claude Development Guide

## ⚠️ CRITICAL: Read This First

### Past Issues to Avoid
- **Type system compatibility was broken** due to not understanding Type-C's specific type semantics
- **Tight coupling was not recognized** - changes cascaded without updating dependent code
- **Tests were not monitored** during changes - breaking changes went unnoticed
- **Assumptions were made** without understanding the language's design philosophy

### Core Development Rules

#### DO NOT:
- ❌ Break existing type system functionality without explicit approval
- ❌ Refactor or restructure code without being asked
- ❌ Make assumptions about type compatibility (Type-C has unique rules!)
- ❌ Modify code without reading and understanding existing implementation first
- ❌ Ignore test failures - they indicate broken compatibility
- ❌ Add type coercion for nested/composite types (only depth-0 primitives!)
- ❌ Treat unions like TypeScript unions (they're only for generic constraints!)
- ❌ Assume classes use structural typing (they're nominal!)

#### ALWAYS:
- ✅ Read existing code thoroughly before making changes
- ✅ Understand how components are coupled before modifying
- ✅ Run and monitor tests after changes
- ✅ Ask before making architectural changes
- ✅ Test changes incrementally
- ✅ Check if changes break existing patterns
- ✅ Understand Type-C's specific type rules (below)

---

## Type-C Language Semantics (MUST READ!)

### 1. Duck Typing (Structural) - Default for Everything EXCEPT Classes

Type-C uses **structural typing** for interfaces, structs, and most types. Types are compatible if their structure matches.

#### Interfaces are Structural
```typescript
type Movable = interface {
    move(x: u32, y: u32) -> void
}

type Drawable = interface {
    draw() -> void
}

type Draggable = interface {
    drag(x: u32, y: u32) -> void
}
```

#### Classes Implement Interfaces Structurally
```typescript
type Square = class Movable, Drawable {
    move(x: u32, y: u32) -> void {
        // move the square
    }

    draw() {
        // draw the square
    }
}

let x: Square = new Square()

// ✅ OK! Square structurally satisfies both interfaces
let y: Movable & Drawable = x
let z: Drawable & Movable = x

// ❌ Error! Square does not implement Draggable
let a: Draggable & Drawable = x
```

**Key Point**: Intersection types (`&`) require the value to satisfy ALL intersected interfaces.

---

### 2. Classes are Nominal (Name-Based)

**IMPORTANT**: Classes use **nominal typing**, NOT structural typing!

```typescript
type ClassA = class {
    x: u32
}

type ClassB = class {
    x: u32
}

let a: ClassA = new ClassA()
let b: ClassB = a  // ❌ ERROR! Even though structures match, classes are nominal
```

---

### 3. Unions - ONLY for Generic Constraints

**CRITICAL**: Unions (`|`) are NOT like TypeScript unions! They are **ONLY used for adding constraints to generics**.

```typescript
// ✅ VALID: Union in generic constraint
fn process<T: Movable | Drawable>(obj: T) -> void {
    // ...
}

// ❌ INVALID: Union in regular type annotation
let x: Movable | Drawable = something  // NOT ALLOWED!
```

**Do not implement general union types** - they have a specific, limited purpose.

---

### 4. Tuples - ONLY for Returns and Unpacking

Tuples are **only allowed** in two contexts:
1. Function return types
2. Unpacking function return values

**Reason**: The VM passes arguments via registers, so tuples are a low-level construct.

```typescript
// ✅ VALID: Tuple as return type
fn getCoords() -> (u32, u32) {
    return (10, 20)
}

// ✅ VALID: Unpacking tuple return
let (x, y) = getCoords()

// ❌ INVALID: Tuple as parameter or variable type
fn process(coords: (u32, u32)) -> void { }  // NOT ALLOWED
let coords: (u32, u32) = (1, 2)             // NOT ALLOWED
```

---

### 5. Anonymous Structs and Structural Compatibility

Anonymous struct literals are structurally compatible with named struct types.

```typescript
type P = struct {
    x: u32,
    y: u32
}

// Anonymous struct literal
let z = {x: 1u32, y: 2u32}

// ✅ OK! z is structurally compatible with P
let p: P = z
```

#### Struct Subtyping - Fields Must Align Exactly

**Small struct = Large struct** is valid ONLY if:
- Common fields exist in both
- Common fields have **exactly matching types** at depth 0
- **NO type coercion for nested types!**

```typescript
type Small = struct {
    x: u32
}

type Large = struct {
    x: u32,
    y: u32,
    z: string
}

let large: Large = {x: 1u32, y: 2u32, z: "test"}
let small: Small = large  // ✅ OK! x field matches exactly

// Type coercion at depth 0 (primitive level)
let a: u32 = 10u32
let b: i32 = a  // ✅ OK! Primitive coercion allowed

// NO coercion for nested types!
type S1 = struct { x: i32 }
type S2 = struct { x: u32 }

let s1: S1 = {x: 10i32}
let s2: S2 = s1  // ❌ ERROR! Nested field types must match exactly
```

**Critical Rule**: Type coercion **only applies at depth 0** (direct primitive assignments), not for struct fields or nested types.

---

### 6. Variant Constructors are Subtypes

**IMPORTANT**: Variant constructors (e.g., `Result.Ok`, `Result.Err`) are **subtypes of the variant itself**.

```typescript
type Result<T, E> = variant {
    Ok(value: T),
    Err(error: E)
}

fn test() -> Result<i32, string> {
    let ok = Result.Ok(42)     // Type: Result<i32, ?>.Ok
    let err = Result.Err("no") // Type: Result<?, string>.Err

    // ✅ Both are subtypes of Result<i32, string>
    return if someCondition => ok else err
}
```

---

### 7. Incomplete Generic Inference with `never` Type

Type-C allows **partial generic inference** for variants. Uninferrable generics are filled with the `never` type.

```typescript
type Result<T, E> = variant {
    Ok(value: T),
    Err(error: E)
}

fn pingServer() -> Result<i32, string> {
    // T is inferred as i32, but E cannot be inferred
    let okResponse = Result.Ok(200)

    /**
     * okResponse has type: Result<i32, never>.Ok
     *
     * Why `never`?
     * - E is impossible to infer from this context
     * - `never` represents a type that is statically unreachable
     * - `never` is NOT written by users - it's internal only
     * - Result.Ok is still a subtype of Result<i32, E> for any E
     */

    let badResponse = Result.Err("Unreachable")
    // Type: Result<never, string>.Err

    let someCondition = true
    return if someCondition => okResponse else badResponse
    // Return type unifies to Result<i32, string>
}
```

**Key Points**:
- ✅ Partial inference is allowed for variants
- ✅ Uninferrable type parameters become `never`
- ✅ `never` is for internal use only (users never write it)
- ✅ Variant constructors are subtypes of the variant
- ✅ Types unify at return based on declared return type

---

## Project Structure

```
type-c-langium/
├── packages/
│   ├── language/
│   │   └── src/
│   │       ├── typing/
│   │       │   ├── type-c-types.ts           # Type definitions (~600 lines)
│   │       │   ├── type-factory.ts           # Factory functions (~700 lines)
│   │       │   ├── type-utils.ts             # Type operations (~600 lines)
│   │       │   ├── type-c-type-provider.ts   # Type inference engine (~900 lines)
│   │       │   ├── type-c-type-system.ts     # High-level facade (~100 lines)
│   │       │   ├── builtin-type-utils.ts     # Built-in prototypes (~60 lines)
│   │       │   └── TYPE_SYSTEM.md            # Type system docs (~500 lines)
│   │       ├── type-c.langium                # Grammar definition
│   │       ├── type-c-scope-provider.ts      # Scope and completions
│   │       ├── type-c-validator.ts           # Validation rules
│   │       └── ...
│   └── ...
└── ...
```

---

## Type System Architecture

### Core Components

1. **type-c-types.ts**: Type definitions (34 type kinds in 7 categories)
2. **type-factory.ts**: Factory functions for creating types
3. **type-utils.ts**: Type comparison, assignability, subtyping
4. **type-c-type-provider.ts**: Main type inference engine
5. **type-c-type-system.ts**: High-level public API
6. **builtin-type-utils.ts**: Built-in prototype methods

### Type Kinds (34 types)

#### Primitive Types (14)
- Integers: `u8`, `u16`, `u32`, `u64`, `i8`, `i16`, `i32`, `i64`
- Floats: `f32`, `f64`
- Others: `bool`, `void`, `string`, `null`

#### Composite Types (5)
- `Array<T>` - Arrays with element type
- `Nullable<T?>` - Nullable types
- `Union (T | U)` - **Only for generic constraints!**
- `Join (T & U)` - Intersection types (must satisfy all)
- `Tuple (T, U, V)` - **Only for returns and unpacking!**

#### Structural Types (4)
- `Struct` - Records with named fields (structural typing)
- `Variant` - Algebraic data types with constructors (constructors are subtypes!)
- `Enum` - Enumerated types
- `StringEnum` - String literal types

#### Object-Oriented Types (3)
- `Interface` - Interfaces (structural typing)
- `Class` - Classes (**nominal typing!**)
- `Implementation` - Implementation types

#### Functional Types (3)
- `Function` - Function types (fn/cfn)
- `Coroutine` - Coroutine types
- `ReturnType<T>` - Return type wrapper

#### Special Types (5)
- `Reference` - Named type references
- `Generic` - Generic parameters
- `Prototype` - Built-in prototypes
- `Namespace` - Namespaces
- `FFI` - Foreign function interface

#### Meta Types (4)
- `Error` - Type error sentinel
- `Never` - Bottom type (unreachable, used for uninferrable generics)
- `Any` - Top type
- `Unset` - Not yet computed

---

## Key Implementation Details

### 1. Lazy Evaluation with Caching
- Types computed on-demand
- `WeakMap`-based caching for memory management
- Handles recursive types naturally
- Cache invalidation support

### 2. Type Inference Engine
- Expression type inference
- Declaration type inference
- Generic instantiation and substitution
- Return type inference from bodies

### 3. Type Compatibility Rules

**Remember these are Type-C specific!**

#### Assignability Rules
1. **Primitives**: Numeric promotion (u8 → u16 → u32 → u64, etc.)
2. **Structs**: Structural compatibility with exact field type matching
3. **Interfaces**: Structural compatibility
4. **Classes**: Nominal compatibility (name must match!)
5. **Intersections**: Must satisfy ALL intersected types
6. **Variants**: Constructors are subtypes of the variant
7. **Generics**: Partial inference with `never` for uninferrable types

#### Type Coercion (CRITICAL!)
- ✅ **Allowed at depth 0**: `u32` → `i32`, `i8` → `i32`, etc.
- ❌ **NOT allowed for nested types**: struct fields, array elements, etc.

```typescript
// ✅ OK
let x: u32 = 10u32
let y: i32 = x

// ❌ ERROR
type S1 = struct { x: u32 }
type S2 = struct { x: i32 }
let s1: S1 = {x: 10u32}
let s2: S2 = s1  // Fields don't match exactly!
```

---

## Testing Guidelines

### ALWAYS Monitor Tests
When making changes to the type system:

1. ✅ Run tests immediately after changes
2. ✅ Check for breaking test failures
3. ✅ Fix broken tests before continuing
4. ✅ Add new tests for new functionality
5. ✅ Ensure type compatibility rules are preserved

### Test Commands
```bash
# Run all tests
npm test

# Run specific test suite
npm test -- --grep "type system"

# Watch mode
npm test -- --watch
```

---

## Common Patterns to Preserve

### 1. Type Factory Pattern
Always use factory functions from `type-factory.ts`:

```typescript
// ✅ Good
const intType = createPrimitiveType('i32')
const arrayType = createArrayType(elementType)

// ❌ Bad - Don't construct types manually
const intType = { kind: 'primitive', primitive: 'i32', ... }
```

### 2. Type Guards
Always use type guards from `type-utils.ts`:

```typescript
// ✅ Good
if (isClassType(type)) {
    // TypeScript knows type is ClassType here
}

// ❌ Bad
if (type.kind === 'class') {
    // No type narrowing
}
```

### 3. Type Comparison
Use utility functions:

```typescript
// ✅ Good
if (areTypesEqual(type1, type2)) { ... }
if (isAssignable(fromType, toType)) { ... }

// ❌ Bad
if (type1 === type2) { ... }  // Reference equality, won't work!
```

---

## Integration Points

### Langium Service Architecture
```typescript
export type TypeCAddedServices = {
    typing: {
        TypeProvider: TypeCTypeProvider
    }
}
```

### Key Integrations
1. **Scope Provider**: Auto-completion, member access
2. **Validator**: Type checking, error reporting
3. **Documentation Provider**: Hover tooltips with types

---

## Known Issues & Gotchas

### 1. Type Caching
- Types are cached in WeakMaps
- If you modify AST nodes, invalidate cache: `typeProvider.invalidateCache(node)`

### 2. Recursive Types
- The system handles recursive types through lazy evaluation
- Don't try to compute recursive types eagerly

### 3. Generic Substitution
- When substituting generics, use `substituteGenerics()` from type-utils
- Don't manually replace type parameters

### 4. Variant Constructors
- Remember: constructors are subtypes of variants
- `Result.Ok<T, never>` is assignable to `Result<T, E>` for any E

---

## When Making Changes

### Before You Start
1. 📖 Read this entire document
2. 🔍 Understand the specific type rules above
3. 📝 Read existing implementation
4. 🧪 Check existing tests
5. 🤔 Understand coupling and dependencies

### During Development
1. ✅ Make incremental changes
2. ✅ Test after each change
3. ✅ Monitor for breaking changes
4. ✅ Update related code
5. ✅ Ask questions if unsure

### After Changes
1. ✅ Run full test suite
2. ✅ Verify no regressions
3. ✅ Update documentation if needed
4. ✅ Check for cascading effects

---

## Questions to Ask Yourself

Before making a change, ask:

- ❓ Do I understand Type-C's specific semantics for this type?
- ❓ Is this change compatible with existing code?
- ❓ What other code depends on this?
- ❓ Are there tests that will break?
- ❓ Am I following Type-C's rules (not TypeScript's rules)?
- ❓ Do I need to ask the user first?

**When in doubt, ASK!**

---

## Current Status

### ✅ Implemented
- [x] Core type system (34 type kinds)
- [x] Type inference engine
- [x] Generic type support
- [x] Structural and nominal typing
- [x] Built-in prototypes
- [x] Langium LSP integration

### 🎯 Current Priorities
- [ ] Fix type compatibility issues
- [ ] Ensure tests pass
- [ ] Maintain backward compatibility
- [ ] Improve error messages

### ⚠️ Known Issues
- Type system had breaking changes in the past
- Need better handling of partial generic inference
- Test coverage needs improvement

---

## Summary: The Most Important Rules

1. 🦆 **Duck typing everywhere EXCEPT classes** (classes are nominal!)
2. 🚫 **Unions only for generic constraints** (not like TypeScript!)
3. 📦 **Tuples only for returns/unpacking** (VM limitation)
4. 🎯 **Type coercion only at depth 0** (no nested coercion!)
5. 🏗️ **Structs are structural** (compatible by shape)
6. 🏷️ **Classes are nominal** (compatible by name)
7. ⚡ **Variant constructors are subtypes** (Result.Ok is subtype of Result)
8. 🔮 **Partial inference uses `never`** (uninferrable generics)
9. 🧪 **Always monitor tests** (catch breaking changes early!)
10. 🤔 **When in doubt, ask!** (don't assume)

---

**Remember**: Type-C is NOT TypeScript, NOT Rust, NOT any other language. It has its own unique semantics. Always refer to these rules when working with types!
