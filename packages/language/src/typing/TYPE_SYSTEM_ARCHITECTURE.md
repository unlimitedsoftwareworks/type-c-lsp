# Type-C Type System Architecture

## Overview

The Type-C type system is a sophisticated type inference engine built on top of Lang

ium's language server infrastructure. It provides TypeScript-level type checking capabilities including generics, type inference, and context-aware auto-completion.

## Core Components

### 1. Type Provider (`type-c-type-provider.ts`)

**Purpose:** Central hub for type inference. Computes and caches types for all AST nodes.

**Key Responsibilities:**
- **Lazy evaluation**: Types are computed on-demand, not eagerly
- **Caching**: Uses WeakMap to cache computed types per AST node
- **Type dispatch**: Routes different AST node types to appropriate inference methods
- **Generic substitution**: Applies type parameter substitutions for generic types
- **Built-in prototypes**: Manages array/coroutine prototype methods

**Architecture:**
```
┌──────────────────────────────────────┐
│   getType(node) - Main Entry Point  │
│   - Checks cache                     │
│   - Calls computeType()              │
│   - Stores result                    │
└──────────┬───────────────────────────┘
           │
           v
┌──────────────────────────────────────┐
│   computeType(node) - Dispatcher     │
│   - Pattern matches on node.$type    │
│   - Delegates to specific infer*()   │
└──────────┬───────────────────────────┘
           │
           v
┌──────────────────────────────────────┐
│   Specific Inference Methods         │
│   - inferArrayType()                 │
│   - inferClassType()                 │
│   - inferMemberAccess()              │
│   - inferBinaryExpression()          │
│   - ... (50+ methods)                │
└──────────────────────────────────────┘
```

**Key Methods:**

- `getType(node)`: Main entry point. Returns cached or computed type.
- `computeType(node)`: Dispatcher that routes to specific inference methods.
- `getIdentifiableFields(type)`: Returns AST nodes for auto-completion (used by scope provider).
- `inferMemberAccess(node)`: Handles `obj.member` with generic substitution.
- `inferBuiltinDefinition(node)`: Converts builtin prototypes to type descriptions.
- `getArrayPrototype()`: Loads and caches array prototype from builtins.

### 2. Type Descriptions (`type-c-types.ts`)

**Purpose:** Defines the type system's data model.

**Type Hierarchy:**
```
TypeDescription (base interface)
├── PrimitiveTypeDescription (u8, u32, f64, bool, string, etc.)
├── ArrayTypeDescription (T[])
├── NullableTypeDescription (T?)
├── UnionTypeDescription (T | U)
├── JoinTypeDescription (T & U)
├── TupleTypeDescription ((T, U, V))
├── StructTypeDescription ({ field: type, ... })
├── ClassTypeDescription (class with attributes, methods, generics)
├── InterfaceTypeDescription (interface with methods)
├── VariantTypeDescription (variant { Ok(T), Error(E) })
├── EnumTypeDescription (enum { A, B, C })
├── FunctionTypeDescription (fn(args) -> ReturnType)
├── CoroutineTypeDescription (coroutine fn(args) -> YieldType)
├── ReferenceTypeDescription (TypeName<GenericArgs>)
├── GenericTypeDescription (T, U, V with optional constraints)
├── PrototypeTypeDescription (builtin array/coroutine methods)
├── ImplementationType (impl { ... })
├── NamespaceType (namespace X { ... })
├── FFIType (extern declarations)
├── ReturnType<T> (return type marker)
└── Special types: VoidType, NullType, NeverType, AnyType, UnsetType, ErrorType
```

**Key Features:**
- **Immutability**: All type descriptions are readonly
- **Node tracking**: Each type optionally links back to its AST node
- **toString()**: Every type can be rendered as a string for display
- **Type guards**: Functions like `isArrayType()`, `isClassType()` for type narrowing

### 3. Type Factory (`type-factory.ts`)

**Purpose:** Factory functions for creating type descriptions with consistent structure.

**Why factories?**
- Ensures all required fields are set
- Provides default values
- Centralizes type creation logic
- Type-safe construction

**Examples:**
```typescript
factory.createArrayType(elementType, node);
factory.createClassType(name, attrs, methods, generics, node);
factory.createFunctionType(params, returnType, fnKind, generics, node);
factory.createErrorType(message, expected, node);
```

### 4. Type Utilities (`type-utils.ts`)

**Purpose:** Type manipulation, comparison, and substitution.

**Key Functions:**

- `typesAreEqual(a, b)`: Deep equality check (handles recursive types)
- `isAssignableTo(source, target)`: Type compatibility check
- `substituteGenerics(type, substitutions)`: Replace generic parameters with concrete types
- `simplifyType(type)`: Flattens unions/joins, removes duplicates
- `simplifyUnion(types)`: Merges nested unions into flat list
- `simplifyJoin(types)`: Merges nested intersections into flat list

**Generic Substitution Algorithm:**
```
substituteGenerics(Array<T>, {T: u32})
  → ArrayTypeDescription { elementType: u32 }

substituteGenerics(fn(T) -> T, {T: string})
  → FunctionTypeDescription {
      parameters: [{ type: string }],
      returnType: string
    }
```

### 5. Scope Provider (`tc-scope-provider.ts`)

**Purpose:** Provides symbol resolution and auto-completion for member access.

**How it works:**

1. User types `arr.` (where `arr` is `u32[]`)
2. Langium calls `getScope()` with context
3. Scope provider detects it's a member access
4. Calls `typeProvider.getExpressionType(arr)` → `ArrayTypeDescription<u32>`
5. Calls `typeProvider.getIdentifiableFields(arrayType)` → `[length, resize, slice]`
6. Creates scope with those AST nodes
7. Langium displays auto-completion options

**Key Methods:**

- `getScope(context)`: Main entry point from Langium
- `getScopeFromBaseExpressionType(expr)`: Gets members of an expression's type
- `createScopeForNodesWithMultipleNames(nodes)`: Handles operator overloading (methods with multiple names)
- `getLocalScope(context)`: Resolves local variables, parameters, etc.
- `getGlobalScope(referenceType, context)`: Resolves global symbols with caching

**Special handling:**
- **Operator overloading**: Methods like `+`, `-`, `()` have multiple names. Scope provider creates separate entries for each name.
- **Generic substitution**: Performed in type provider's `inferMemberAccess`, not here.

### 6. Hover Provider (`tc-hover-provider.ts`)

**Purpose:** Provides type information on hover.

**The Challenge:**
When hovering over `clone` in `arr.clone()` where `arr: Array<u32>`:
- Langium's default behavior: Resolve `clone` → jump to method definition → show `fn() -> Array<T>`
- Desired behavior: Show context-aware type `fn() -> Array<u32>`

**Solution:**
1. Override `getHoverContent()` to capture the cursor position
2. Find the AST node at cursor → store in `currentHoverNode`
3. Traverse up to find containing `MemberAccess` node
4. Call `typeProvider.getType(memberAccessNode)` → gets substituted type
5. Display the fully resolved type

**Why this works:**
- `inferMemberAccess()` already performs generic substitution
- We just need to get the type from the *usage site* (MemberAccess) instead of the *definition site* (Method)

### 7. Built-in Prototypes (`builtins/prototypes.ts`)

**Purpose:** Defines array and coroutine built-in methods for LSP.

**Example:**
```typescript
prototype for array {
    length: u64
    fn resize<T>(newLength: u64) -> void
    fn slice<T>(start: u64, end: u64) -> T[]
}
```

**Loading Process:**
1. Built-in file is pre-loaded by workspace manager
2. Type provider discovers `BuiltinDefinition` nodes
3. `inferBuiltinDefinition()` converts to `PrototypeTypeDescription`
4. Cached in `builtinPrototypes` map
5. Retrieved when inferring array types

## Type Inference Flow

### Example: `let x = arr.length`

```
1. Parser creates AST:
   VariableDeclaration {
     name: "x",
     initializer: MemberAccess {
       expr: QualifiedReference { ref: "arr" },
       element: { ref: "length" }
     }
   }

2. Type inference for VariableDeclaration:
   getType(varDecl)
   → inferVariableDeclaration(varDecl)
   → inferExpression(varDecl.initializer)
   → inferMemberAccess(memberAccessNode)

3. inferMemberAccess logic:
   a. Get base type: inferExpression(arr) → ArrayTypeDescription<u32>
   b. Check if array type → YES
   c. Get array prototype: getArrayPrototype() → PrototypeTypeDescription
   d. Find "length" in prototype.properties → { name: "length", type: u64 }
   e. Return u64

4. Result: x has type u64
```

### Example: Generic Method Call `arr.slice(0, 5)`

```
1. Type inference for FunctionCall:
   inferFunctionCall(node)
   → inferExpression(node.expr)  // node.expr is MemberAccess
   → inferMemberAccess(memberAccessNode)

2. inferMemberAccess logic:
   a. Base type: ArrayTypeDescription<u32>
   b. Find "slice" in array prototype → fn<T>(u64, u64) -> T[]
   c. Create substitution map: { T: u32 }
   d. Apply substitution: fn(u64, u64) -> u32[]
   e. Return function type with substituted return type

3. inferFunctionCall extracts return type:
   → return u32[]
```

## Generic Type Substitution

### When Substitution Happens

1. **Reference types**: When resolving `Array<u32>`, store generic args in `ReferenceTypeDescription`
2. **Member access**: When accessing members, substitute generics from base type
3. **Function calls**: When calling generic functions, substitute from explicit generic args

### How Substitution Works

```typescript
// Input:
baseType = ReferenceType {
  declaration: Array<T>,
  genericArgs: [u32]
}

// In inferMemberAccess:
1. Build substitution map:
   { T: u32 }

2. For each accessed member:
   substituteGenerics(member.type, substitutionMap)

3. Example:
   method: fn clone() -> Array<T>
   →  substituteGenerics(functionType, {T: u32})
   →  fn clone() -> Array<u32>
```

### Recursive Generic Handling

The system handles recursive generics like:
```typescript
type List<T> = class {
    fn map<U>(f: fn(T) -> U) -> List<U>
}
```

**Key insight:** We don't eagerly expand generics. Instead:
- Store generic parameters in the type description
- Substitute only when needed (at member access time)
- Cache results per context

## Caching Strategy

### Type Cache
- **Data structure**: `WeakMap<AstNode, TypeDescription>`
- **Lifetime**: Tied to AST node lifetime (garbage collected automatically)
- **Granularity**: One entry per AST node
- **Invalidation**: Manual via `invalidateCache()` or automatic when AST is rebuilt

### Global Scope Cache
- **Data structure**: `DocumentCache<string, Scope>`
- **Key**: Document URI + reference type
- **Lifetime**: Tied to document lifetime
- **Purpose**: Avoid recomputing global scope for each reference lookup

### Builtin Prototype Cache
- **Data structure**: `Map<string, TypeDescription>`
- **Keys**: 'array', 'coroutine'
- **Lifetime**: Permanent (per TypeProvider instance)
- **Purpose**: Built-in prototypes are immutable, compute once

## Error Handling

### Error Types
The system uses `ErrorTypeDescription` to represent type errors:
```typescript
factory.createErrorType(
  message: "Member 'foo' not found",
  expected: "Expected one of: length, slice, resize",
  node: astNode
)
```

### Error Propagation
- Errors don't throw exceptions
- Instead, return `ErrorType` which can be checked
- Allows partial type information even with errors
- LSP can show specific error messages

### Graceful Degradation
- If a type cannot be inferred, return `ErrorType` or `AnyType`
- System continues to provide other features (scope, hover, etc.)
- Validators can report the errors to the user

## Integration with Langium

### AST Node Linking
- Langium resolves cross-references (e.g., variable name → declaration)
- Type provider uses these links: `node.element?.ref`
- Reference resolution is lazy (happens on first access)

### Document Lifecycle
1. User edits file
2. Langium re-parses → new AST
3. Old type cache is automatically garbage collected (WeakMap)
4. New types computed on-demand

### LSP Features
- **Hover**: TypeCHoverProvider uses type system
- **Completion**: TypeCScopeProvider uses type system
- **Diagnostics**: TypeCValidator uses type system
- **Go to Definition**: Uses AST nodes returned by `getIdentifiableFields`

## Performance Considerations

### Lazy Evaluation
- Types are computed only when requested
- Avoids computing types for unused code
- Critical for large codebases

### Caching
- WeakMap ensures no memory leaks
- Cache hit rate typically >90% for active editing
- Scope cache reduces repeated global symbol lookups

### Type Simplification
- `simplifyType()` reduces complex union/join types
- Prevents exponential growth in nested generics
- Deduplicates equivalent types

## Extension Points

### Adding New Types
1. Add interface to `type-c-types.ts`
2. Add factory function to `type-factory.ts`
3. Add case in `computeType()` dispatcher
4. Implement `infer<NewType>()` method
5. Add type guard function (e.g., `isNewType()`)
6. Update `substituteGenerics()` if needed

### Adding New Built-ins
1. Edit `builtins/prototypes.ts`
2. Add prototype definition
3. Implement `get<Name>Prototype()` method
4. Call in appropriate `infer*()` method

### Custom Type Checking
1. Create validator class extending `TypeCValidator`
2. Use `typeProvider.getType()` to get types
3. Use `isAssignableTo()` to check compatibility
4. Report diagnostics via Langium's validation framework

## Common Patterns

### Pattern: Type Narrowing
```typescript
const type = typeProvider.getType(node);
if (isArrayType(type)) {
    // TypeScript now knows type is ArrayTypeDescription
    const elementType = type.elementType;
}
```

### Pattern: Generic Substitution
```typescript
if (isReferenceType(baseType)) {
    const substitutions = new Map<string, TypeDescription>();
    refType.declaration.genericParameters.forEach((param, i) => {
        substitutions.set(param.name, refType.genericArgs[i]);
    });
    return substituteGenerics(memberType, substitutions);
}
```

### Pattern: Error Recovery
```typescript
const type = this.getType(node.expr);
if (type.kind === TypeKind.Error) {
    // Try fallback or return partial info
    return factory.createAnyType(node);
}
```

## Testing Strategy

### Unit Tests
- Test each `infer*()` method in isolation
- Mock AST nodes with required properties
- Assert correct type descriptions returned

### Integration Tests
- Parse full Type-C code snippets
- Call `getType()` on specific nodes
- Verify complete type inference including generics

### LSP Tests
- Simulate hover at specific positions
- Verify correct type displayed
- Test auto-completion lists

## Future Enhancements

### Planned Features
- [ ] Control flow analysis for nullable types
- [ ] Exhaustiveness checking for match expressions
- [ ] Type inference for lambda parameters
- [ ] Trait/interface implementation verification
- [ ] Optimization: incremental type checking

### Performance Improvements
- [ ] Parallel type checking for independent modules
- [ ] Persistent cache across IDE sessions
- [ ] Demand-driven type refinement

---

## Quick Reference

### Most Important Files
1. `type-c-type-provider.ts` - Type inference engine
2. `tc-scope-provider.ts` - Auto-completion & symbol resolution
3. `tc-hover-provider.ts` - Hover information
4. `type-c-types.ts` - Type system data model
5. `type-utils.ts` - Type manipulation utilities

### Key Concepts
- **Lazy evaluation**: Compute types on-demand
- **Caching**: Store results in WeakMap
- **Generic substitution**: Replace type parameters with concrete types
- **AST nodes**: Return nodes for Langium's cross-referencing
- **Error types**: Graceful degradation instead of exceptions

### Debug Tips
- Add `console.log(type.toString())` to see inferred types
- Check type cache with `typeProvider.typeCache`
- Verify AST structure in Langium trace
- Use TypeScript's type narrowing for safety

