# Generic Type Substitution in Type-C

This document explains how generic type substitution works in the Type-C type system, with a focus on the challenges and solutions for interface inheritance and join types.

## Table of Contents

1. [Overview](#overview)
2. [The Problem](#the-problem)
3. [The Solution](#the-solution)
4. [Implementation Details](#implementation-details)
5. [Examples](#examples)
6. [Edge Cases](#edge-cases)

## Overview

Generic substitution is the process of replacing generic type parameters (like `T`) with concrete types (like `string`) when instantiating generic types. In Type-C, this happens in several contexts:

- **Function calls**: `fn map<T>(x: T) -> T[]` with `map(42)` → `T = i32`
- **Type instantiation**: `Array<u32>` → `T = u32` in array methods
- **Interface inheritance**: `type Entity<T> = Serializable<T>` → substitute `T` in methods
- **Variant constructors**: `Result.Ok(42)` → infer `T = i32, E = never`

## The Problem

### Challenge: Generic Supertypes in Join Types

Consider this code:

```tc
type Serializable<T> = interface {
    fn serialize() -> T
}

type Drawable = interface {
    fn draw() -> void
}

type Entity = Drawable & Serializable<string>

fn main() {
    let e: Entity? = null
    let z = e.serialize()  // What is the type of z?
}
```

**Expected**: `z` should be `string?` (nullable because `e` is nullable)

**Problem**: Without proper substitution, `z` would be `T?` (the unsubstituted generic parameter)

### Why This Happens

The type resolution process:

1. `e: Entity?` → unwrap nullable → `Entity`
2. `Entity` is a reference to type `Drawable & Serializable<string>`
3. When we resolve `Entity`, we get `JoinType { Drawable, Serializable<T> }`
4. **BUG**: The `T` in `Serializable<T>` is still generic! We need to substitute it with `string`

### Three Scenarios That All Failed Before

```tc
// Scenario 1: Direct join type
type Entity = Drawable & Serializable<string>
let e: Entity = ...
e.serialize()  // Returned T instead of string ❌

// Scenario 2: Generic type with join
type Entity<T> = Drawable & Serializable<T>
let e: Entity<string> = ...
e.serialize()  // Returned T instead of string ❌

// Scenario 3: Interface with generic supertype
type Entity = interface Serializable<string> {
    fn draw() -> void
}
let e: Entity = ...
e.serialize()  // Returned T instead of string ❌
```

## The Solution

### Two-Part Fix

#### Part 1: Apply Substitutions to Resolved Types

Located in [`inferMemberAccess()`](type-c-type-provider.ts:1842) at lines 1856-1887:

```typescript
if (isReferenceType(baseType)) {
    const refType = baseType;
    // Build substitution map: Entity<string> → {T: string}
    genericSubstitutions = this.buildGenericSubstitutions(refType);
    
    // Resolve and apply substitutions to ENTIRE type
    baseType = this.resolveAndSubstituteReference(refType);
}
```

**What this does:**
1. `Entity<string>` has `genericArgs = [string]`
2. Build map: `{T: string}`
3. Resolve to `Drawable & Serializable<T>`
4. **Substitute generics**: `Drawable & Serializable<string>` ✓

#### Part 2: Look Up Methods from Substituted Types

Located in [`inferMemberAccess()`](type-c-type-provider.ts:1842) at lines 1917-1977:

```typescript
const baseInterface = this.typeUtils.asInterfaceType(baseType);
if (baseInterface && ast.isMethodHeader(targetRef)) {
    // Find method in the SUBSTITUTED interface, not the AST
    const method = findMethodInInterface(baseInterface);
    // Method already has T → string substituted
    memberType = factory.createFunctionType(...);
}
```

**What this does:**
1. Instead of `getType(targetRef)` which returns `fn() -> T` from AST
2. We search in `baseInterface` which is `Serializable<string>`
3. The method's return type is already `string` (not `T`) ✓

### Helper Methods

Two helper methods eliminate code duplication:

```typescript
// Extracts generic substitution map from reference type
private buildGenericSubstitutions(refType: ReferenceTypeDescription): Map<string, TypeDescription> | undefined

// Combines resolve + substitute operations
private resolveAndSubstituteReference(refType: ReferenceTypeDescription): TypeDescription
```

## Implementation Details

### When Substitution Happens

1. **Member Access** ([`inferMemberAccess()`](type-c-type-provider.ts:1842))
   - Before looking up members, resolve and substitute the base type
   - Ensures all supertypes have concrete types

2. **Function Calls** ([`inferFunctionCall()`](type-c-type-provider.ts:2042))
   - Apply substitutions to return type after inferring generics from arguments
   - Example: `map<T>([1,2,3], fn(x) -> x*2)` → infer `T=i32`, return `i32[]`

3. **Reference Resolution** ([`resolveReference()`](type-c-type-provider.ts:821))
   - When resolving `Array<u32>`, substitute `T` with `u32` throughout
   - Handles nested generics like `Array<Result<T, E>>`

### Substitution in Type Hierarchies

When an interface has generic supertypes:

```tc
type Identifiable<T> = interface {
    fn getId() -> T
}

type Versioned<T, V> = interface Identifiable<T> {
    fn getVersion() -> V
}

type Entity<T> = interface Versioned<T, u32> {
    fn save() -> void
}
```

For `Entity<string>`, the substitution cascade:
1. `Entity<string>` → resolve → `Versioned<T, u32>`
2. Substitute `{T: string}` → `Versioned<string, u32>`
3. Resolve `Versioned<string, u32>` → `Identifiable<string> + {getVersion() -> u32}`
4. Resolve `Identifiable<string>` → `{getId() -> string}`

**Result**: All methods have correct types:
- `getId()` returns `string` ✓
- `getVersion()` returns `u32` ✓

## Examples

### Example 1: Basic Join Type

```tc
type Serializable<T> = interface {
    fn serialize() -> T
}

type Entity = Drawable & Serializable<string>

let e: Entity = ...
e.serialize()  // Returns: string
```

**How it works:**
1. `e` has type `ReferenceType{Entity, genericArgs: []}`
2. Resolve → `JoinType{Drawable, Serializable<T>}` 
3. Build substitutions from `Serializable<string>` in the join → `{T: string}`
4. Substitute → `JoinType{Drawable, Serializable<string>}`
5. Look up `serialize()` in substituted interface → return type is `string`

### Example 2: Generic Propagation

```tc
type Entity<T> = Drawable & Serializable<T>

let e: Entity<string> = ...
e.serialize()  // Returns: string
```

**How it works:**
1. `e` has type `ReferenceType{Entity, genericArgs: [string]}`
2. Build substitutions → `{T: string}`
3. Resolve → `JoinType{Drawable, Serializable<T>}`
4. Substitute → `JoinType{Drawable, Serializable<string>}`
5. Look up method → return type is `string`

### Example 3: Generic Supertype

```tc
type Entity = interface Serializable<string> {
    fn draw() -> void
}

let e: Entity = ...
e.serialize()  // Returns: string
```

**How it works:**
1. `e` has type `ReferenceType{Entity, genericArgs: []}`
2. Resolve → `InterfaceType{methods: [draw], superTypes: [Serializable<string>]}`
3. Look up `serialize()` in methods → not found
4. Look up in supertypes → `Serializable<string>` (a `ReferenceType`)
5. Resolve supertype with substitutions → `InterfaceType{methods: [serialize() -> string]}`
6. Return method from supertype → `string`

### Example 4: Deeply Nested Generics

```tc
type Matrix<T> = interface {
    fn getMatrix() -> T[][][]
}

type NumericMatrix = interface Matrix<u32> {
    fn sum() -> u64
}

let nm: NumericMatrix = ...
let m = nm.getMatrix()  // Returns: u32[][][]
```

**How it works:**
1. `nm` has type `ReferenceType{NumericMatrix, genericArgs: []}`
2. Resolve → `InterfaceType{methods: [sum], superTypes: [Matrix<u32>]}`
3. Look up `getMatrix()` → search supertypes
4. Resolve `Matrix<u32>` with `{T: u32}` → `InterfaceType{methods: [getMatrix() -> T[][][]]}`
5. Substitute `T` → `getMatrix() -> u32[][][]`

## Edge Cases

### Case 1: Multiple Generic Parameters

```tc
type Storage<T, U> = interface {
    fn get() -> T
    fn getMeta() -> U
}

type UserStorage = interface Storage<User, Metadata> {
    fn save() -> void
}
```

Both `T` and `U` are correctly substituted independently.

### Case 2: Generic Remapping

```tc
type Source<T> = interface {
    fn fetch() -> T
}

type BatchSource<U> = interface Source<U[]> {
    fn count() -> u32
}

let bs: BatchSource<string> = ...
bs.fetch()  // Returns: string[]
```

**Substitution chain:**
- `BatchSource<string>` → `{U: string}`
- Supertype is `Source<U[]>` → substitute `{U: string}` → `Source<string[]>`
- Resolve `Source<string[]>` → `{T: string[]}` 
- `fetch()` returns `T` → `string[]`

### Case 3: Recursive Structures

```tc
type Node<T> = struct { data: T, next: Node<T>? }

type LinkedList<T> = interface {
    fn getHead() -> Node<T>?
}

let list: LinkedList<i32> = ...
list.getHead()  // Returns: struct{data: i32, next: Node<i32>?}?
```

Substitution correctly handles self-referential types.

### Case 4: Triple Nesting

```tc
type Container<T> = struct { items: T[] }

type Repository<T> = interface {
    fn getAll() -> Container<T>[]
}

let repo: Repository<User> = ...
repo.getAll()  // Returns: struct{items: User[]}[]
```

The `T` is substituted at all nesting levels:
- `Container<T>` → `Container<User>` → `struct{items: User[]}`
- Final type: `struct{items: User[]}[]`

## Implementation Architecture

```
┌─────────────────────────────────────────┐
│  Member Access: e.serialize()           │
└─────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────┐
│  1. Infer base type (e: Entity<string>) │
└─────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────┐
│  2. Build substitution map              │
│     {T: string}                          │
│     via buildGenericSubstitutions()     │
└─────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────┐
│  3. Resolve and substitute              │
│     Entity → Drawable & Serializable<T> │
│     Substitute → ... & Serializable<str>│
│     via resolveAndSubstituteReference() │
└─────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────┐
│  4. Look up method in substituted type  │
│     Find serialize() in Serializable<str>│
│     Recursively search supertypes       │
└─────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────┐
│  5. Return method type                  │
│     fn() -> string (not T!)             │
└─────────────────────────────────────────┘
```

## Testing

Comprehensive test coverage in:
- [`interface-join-generics.tc`](../../test/test-cases/tc-inline/join-types/correct/interface-join-generics.tc) - Basic scenarios
- [`interface-join-generics-stress-test.tc`](../../test/test-cases/tc-inline/join-types/correct/interface-join-generics-stress-test.tc) - 10 complex scenarios
- [`interface-join-extreme-stress-test.tc`](../../test/test-cases/tc-inline/join-types/correct/interface-join-extreme-stress-test.tc) - Deeply nested types

All tests validate that generic parameters are correctly substituted through:
- Multiple levels of inheritance
- Join types with multiple interfaces
- Nested generics (arrays, structs, etc.)
- Generic remapping (`T -> U[]`)
- Recursive structures

## Related Code

- [`type-c-type-provider.ts`](type-c-type-provider.ts) - Main implementation
  - `inferMemberAccess()` - Member lookup with substitution (lines 1842-2039)
  - `buildGenericSubstitutions()` - Extract substitution map (lines 2862-2873)
  - `resolveAndSubstituteReference()` - Resolve + substitute (lines 2893-2902)
  
- [`type-utils.ts`](type-utils.ts) - Substitution utilities
  - `substituteGenerics()` - Core substitution logic (lines 1127-1352)
  - Handles all composite types (arrays, structs, functions, etc.)

- [`type-factory.ts`](type-factory.ts) - Type construction
  - Creates type descriptions with proper structure for substitution

## Future Enhancements

Potential areas for improvement:

1. **Caching**: Memoize substitution results for performance
2. **Constraint checking**: Validate substituted types satisfy generic constraints
3. **Variance**: Support covariant/contravariant generic parameters
4. **Higher-kinded types**: Generic types that take other generics as parameters

## Debugging Tips

When debugging substitution issues:

1. **Check the base type**: Is it a `ReferenceType` with `genericArgs`?
2. **Verify substitution map**: Does it map all generic parameters?
3. **Trace resolution**: What does `resolveReference()` return?
4. **Check supertypes**: Are supertype generics also being substituted?
5. **Examine the final type**: Does `toString()` show concrete types or generic parameters?

Use the hover tooltip to see the actual type - if you see `T` instead of a concrete type, substitution failed somewhere in the chain.