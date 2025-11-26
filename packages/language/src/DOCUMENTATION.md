# Type-C Language Server Documentation

## Overview

This directory contains the implementation of the Type-C language server, built on Langium. The language server provides:

- **Type Inference**: Sophisticated type system with generics, inference, and substitution
- **Auto-completion**: Context-aware completions including member access and operator overloading
- **Hover Information**: Shows types with generic substitutions applied
- **Go to Definition**: Jump to declarations and definitions
- **Validation**: Type checking and error reporting

## Documentation Index

### 📚 Architecture & Design

**[TYPE_SYSTEM_ARCHITECTURE.md](./typing/TYPE_SYSTEM_ARCHITECTURE.md)**
- Complete architecture overview
- Type system design and data flow
- Generic substitution algorithms
- Caching strategies
- Integration with Langium
- Extension points

**[TYPE_SYSTEM.md](./typing/TYPE_SYSTEM.md)**
- Type system specification
- Type hierarchy and descriptions
- Usage examples

### 🔍 Core Components

#### Type System (`/typing`)

**`type-c-type-provider.ts`** - Main Type Inference Engine
- Entry point: `getType(node)` - Gets type for any AST node with caching
- Key methods:
  - `getIdentifiableFields(type)` - Returns members for auto-completion
  - `inferMemberAccess(node)` - Handles member access with generic substitution
  - `inferBuiltinDefinition(node)` - Converts builtin prototypes to types
  - `getArrayPrototype()` - Loads array built-in methods

**`type-c-types.ts`** - Type System Data Model
- Defines all type description interfaces
- Type guards for safe type narrowing
- Core type hierarchy (30+ type kinds)

**`type-factory.ts`** - Type Creation Utilities
- Factory functions for creating type descriptions
- Ensures consistent type construction
- Provides defaults and validation

**`type-utils.ts`** - Type Manipulation
- `typesAreEqual(a, b)` - Deep equality comparison
- `isAssignableTo(source, target)` - Type compatibility checking
- `substituteGenerics(type, substitutions)` - Generic type substitution
- `simplifyType(type)` - Union/intersection simplification

**`builtin-type-utils.ts`** - Built-in Types
- Array and coroutine prototype methods
- Type substitution for built-in generics

#### Scoping (`/scope-system`)

**`tc-scope-provider.ts`** - Symbol Resolution & Auto-completion
- `getScope(context)` - Main entry point for scope resolution
- `getScopeFromBaseExpressionType(expr)` - Member access completions
- `createScopeForNodesWithMultipleNames(nodes)` - Operator overloading support
- Integrates with type provider for type-aware completions

**`tc-scope-computation.ts`** - Scope Building
- Computes local symbol tables for each scope
- Handles variable declarations, parameters, etc.

**`tc-scope-utils.ts`** - Scope Utilities
- Helper functions for scope computation
- Checks if context is member resolution

#### Documentation (`/documentation`)

**`tc-hover-provider.ts`** - Hover Information
- Provides context-aware hover with generic substitution
- `getHoverContent(document, params)` - Captures cursor position
- `getAstNodeHoverContent(node)` - Generates type strings
- Solves the "Array<T> vs Array<u32>" problem

**`tc-documentation-provider.ts`** - JSDoc Documentation
- Extracts JSDoc comments from code
- Provides documentation in hover and completion

#### Built-ins (`/builtins`)

**`prototypes.ts`** - Built-in Prototypes
- Array prototype methods (length, slice, resize)
- Coroutine prototype methods
- Parsed by type provider for LSP features

## Key Concepts

### Type Inference Flow

```
User code: let x = arr.length
           ↓
    Parse to AST
           ↓
    getType(varDecl)
           ↓
    inferVariableDeclaration()
           ↓
    inferExpression(arr.length)
           ↓
    inferMemberAccess()
           ├─ Infer base type: Array<u32>
           ├─ Get array prototype
           ├─ Find "length" property
           └─ Return: u64
           ↓
    Result: x has type u64
```

### Generic Substitution

```
Input:  arr: Array<u32>
        arr.clone()  // clone defined as fn() -> Array<T>

Process:
1. Base type: ReferenceType { Array, [u32] }
2. Build substitutions: { T → u32 }
3. Resolve to Array definition
4. Find clone method: fn() -> Array<T>
5. Apply substitutions: fn() -> Array<u32>

Output: fn() -> Array<u32> ✅
```

### Auto-completion Flow

```
User types: arr.
           ↓
    Langium calls getScope()
           ↓
    Detect member access
           ↓
    getExpressionType(arr)
           ├─ Returns: ArrayTypeDescription<u32>
           ↓
    getIdentifiableFields(arrayType)
           ├─ Returns: [length, resize, slice] (AST nodes)
           ↓
    createScopeForNodesWithMultipleNames()
           ├─ Creates scope entries for each member
           ↓
    Langium displays completions
```

### Hover Flow

```
User hovers over: arr.clone
                  ↓
     getHoverContent() captures position
                  ↓
     Find AST node at cursor
                  ├─ Stores in currentHoverNode
                  ↓
     Base class resolves reference
                  ├─ Finds method definition
                  ↓
     getAstNodeHoverContent()
                  ├─ Traverse up from currentHoverNode
                  ├─ Find containing MemberAccess
                  ├─ Get type: fn() -> Array<u32>
                  └─ Display type string
                  ↓
     Shows: fn() -> Array<u32>
```

## Code Organization

```
packages/language/src/
├── type-c.langium              # Grammar definition
├── generated/                   # Auto-generated from grammar
│   └── ast.ts                  # AST node types
├── typing/                      # Type system
│   ├── type-c-type-provider.ts # Type inference engine
│   ├── type-c-types.ts         # Type definitions
│   ├── type-factory.ts         # Type constructors
│   ├── type-utils.ts           # Type utilities
│   ├── builtin-type-utils.ts  # Built-in types
│   ├── TYPE_SYSTEM.md          # Specification
│   └── TYPE_SYSTEM_ARCHITECTURE.md  # Design doc
├── scope-system/                # Symbol resolution
│   ├── tc-scope-provider.ts    # Scope & completions
│   ├── tc-scope-computation.ts # Local symbols
│   └── tc-scope-utils.ts       # Utilities
├── documentation/               # Hover & docs
│   ├── tc-hover-provider.ts    # Hover provider
│   └── tc-documentation-provider.ts  # JSDoc
├── builtins/                    # Built-in definitions
│   ├── prototypes.ts           # Array/coroutine methods
│   └── index.ts                # Loader
└── DOCUMENTATION.md            # This file
```

## Common Tasks

### Adding a New Type

1. Add interface to `type-c-types.ts`
2. Add factory function to `type-factory.ts`
3. Add case in `computeType()` dispatcher
4. Implement `infer<NewType>()` method
5. Add type guard (e.g., `isNewType()`)
6. Update `substituteGenerics()` if needed

### Adding Built-in Methods

1. Edit `builtins/prototypes.ts`
2. Add method to appropriate prototype
3. Methods automatically available via type provider

### Debugging Type Issues

```typescript
// Add logging to type provider
getType(node: AstNode): TypeDescription {
    const type = this.computeType(node);
    console.log(`Type of ${node.$type}:`, type.toString());
    return type;
}

// Check what members are available
const members = typeProvider.getIdentifiableFields(type);
console.log('Available members:', members.map(m => nameProvider.getName(m)));

// Verify generic substitution
const substituted = substituteGenerics(type, substitutions);
console.log('Before:', type.toString());
console.log('After:', substituted.toString());
```

## Testing

### Unit Tests
- Test individual `infer*()` methods
- Mock AST nodes
- Assert correct type descriptions

### Integration Tests
- Parse complete Type-C code
- Verify end-to-end type inference
- Test generic substitution

### LSP Tests
- Simulate hover/completion requests
- Verify correct results
- Test with complex generic scenarios

## Performance Considerations

### Caching

- **Type cache**: WeakMap<AstNode, TypeDescription>
  - Automatic garbage collection
  - Hit rate typically >90%

- **Scope cache**: DocumentCache<string, Scope>
  - Per-document caching
  - Invalidated on document changes

- **Builtin cache**: Map<string, TypeDescription>
  - Permanent (immutable built-ins)
  - Loaded once per session

### Lazy Evaluation

- Types computed only when requested
- Avoids unnecessary work for unused code
- Critical for large codebases

### Type Simplification

- `simplifyType()` reduces complex unions
- Deduplicates equivalent types
- Prevents exponential growth

## Troubleshooting

### Issue: Auto-completion not showing members

**Causes:**
1. Type inference failing → Check console for errors
2. `getIdentifiableFields()` not handling type → Add case
3. Scope provider not calling type provider → Verify `getScope()`

**Debug:**
```typescript
// In scope provider
const baseType = this.typeProvider.getExpressionType(expr);
console.log('Base type:', baseType.toString());
const fields = this.typeProvider.getIdentifiableFields(baseType);
console.log('Fields:', fields);
```

### Issue: Hover showing generic type instead of concrete type

**Causes:**
1. Hover provider not finding MemberAccess → Check `currentHoverNode`
2. Generic substitution not applied → Check `inferMemberAccess()`
3. Reference type not resolved → Check `resolveReference()`

**Debug:**
```typescript
// In hover provider
console.log('Current hover node:', this.currentHoverNode);
console.log('Container:', this.currentHoverNode?.$container);
```

### Issue: Wrong type inferred

**Causes:**
1. Missing case in `computeType()` → Add handler
2. Wrong inference logic → Fix `infer*()` method
3. Type cache stale → Invalidate cache

**Debug:**
```typescript
// Clear cache
typeProvider.invalidateCache(node);

// Trace inference
console.trace('Inferring type for:', node.$type);
```

## Best Practices

### Type Provider

1. **Always cache**: Every `getType()` call should cache results
2. **Handle undefined**: Check for undefined nodes gracefully
3. **Use type guards**: Prefer `isArrayType(type)` over type assertions
4. **Simplify types**: Call `simplifyType()` for unions/joins
5. **Document complexity**: Add comments for non-obvious logic

### Scope Provider

1. **Return AST nodes**: Langium needs nodes for cross-references
2. **Handle operator overloading**: Create multiple scope entries
3. **Cache global scopes**: Use DocumentCache for performance
4. **Don't apply substitutions**: Let type provider handle generics

### Hover Provider

1. **Capture context**: Store cursor position before resolution
2. **Traverse up**: Find containing expressions for context
3. **Use type provider**: Don't reimplement type inference
4. **Clean up state**: Clear temporary variables in finally blocks

## Resources

### Langium Documentation
- [Langium Official Docs](https://langium.org/docs/)
- [Langium API Reference](https://langium.org/docs/reference/)
- [LSP Specification](https://microsoft.github.io/language-server-protocol/)

### Type System Papers
- Hindley-Milner type inference
- Bidirectional type checking
- Generic type substitution algorithms

### Internal Docs
- `TYPE_SYSTEM_ARCHITECTURE.md` - Comprehensive architecture
- `TYPE_SYSTEM.md` - Type system specification
- Code comments in key files

---

## Questions?

For questions about:
- **Type system**: See `TYPE_SYSTEM_ARCHITECTURE.md`
- **Specific types**: See `TYPE_SYSTEM.md`
- **Implementation**: Read JSDoc comments in source files
- **Debugging**: Use console logging as shown above

**Remember:** The type system is sophisticated but well-documented. Read the docs, follow the patterns, and test thoroughly!

