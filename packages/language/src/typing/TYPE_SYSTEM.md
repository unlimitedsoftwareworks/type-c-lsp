# Type-C Type System Documentation

## Overview

The Type-C type system is a sophisticated, TypeScript-like type system built on Langium infrastructure. It supports:

- **Lazy Evaluation**: Types are computed on-demand and cached
- **Recursive Types**: Handles complex recursive structures like `class T { clone(): T }`
- **Generic Types**: Full support for generic types with constraints
- **Structural Typing**: Interfaces and structs use structural subtyping
- **Type Inference**: Comprehensive type inference from expressions and declarations
- **Built-in Prototypes**: Support for array and coroutine built-in methods via prototype system

## Architecture

### Core Components

```
type-c-types.ts          - Type definitions and type guards
type-factory.ts          - Factory functions for creating types
type-utils.ts            - Type comparison, compatibility, and manipulation
type-c-type-provider.ts  - Main type inference engine
type-c-type-system.ts    - High-level type system facade
builtin-type-utils.ts    - Utilities for built-in prototype types
```

### Type Hierarchy

```
TypeDescription (base interface)
├── Primitive Types
│   ├── IntegerType (u8, u16, u32, u64, i8, i16, i32, i64)
│   ├── FloatType (f32, f64)
│   ├── BoolType
│   ├── VoidType
│   ├── StringType
│   └── NullType
├── Composite Types
│   ├── ArrayType<T>
│   ├── NullableType<T?>
│   ├── UnionType (T | U)
│   ├── JoinType (T & U) - Intersection
│   └── TupleType (T, U, V)
├── Structural Types
│   ├── StructType { field: Type, ... }
│   ├── VariantType (Algebraic Data Types)
│   ├── EnumType
│   └── StringEnumType
├── Object-Oriented Types
│   ├── InterfaceType
│   ├── ClassType
│   └── ImplementationType
├── Functional Types
│   ├── FunctionType
│   ├── CoroutineType
│   └── ReturnType<T>
└── Special Types
    ├── ReferenceType (named type references)
    ├── GenericType (type parameters)
    ├── PrototypeType (built-in methods)
    ├── NamespaceType
    ├── FFIType (external functions)
    ├── ErrorType (type errors)
    ├── NeverType (bottom type)
    ├── AnyType (top type)
    └── UnsetType (not yet computed)
```

## Type System Features

### 1. Type Inference

The `TypeCTypeProvider` service provides comprehensive type inference for all AST nodes:

```typescript
// Usage
const typeProvider = services.typing.TypeProvider;
const type = typeProvider.getType(astNode);
```

**Key Features:**
- Automatic type inference from expressions
- Type propagation through control flow
- Generic type instantiation
- Return type inference from function bodies

### 2. Type Comparison and Compatibility

The type system provides several comparison operations:

```typescript
// Structural equality
areTypesEqual(type1, type2): boolean

// Assignability (subtyping)
isAssignable(fromType, toType): boolean

// Type narrowing (for control flow analysis)
narrowType(type, targetType): TypeDescription

// Type simplification
simplifyType(unionOrJoinType): TypeDescription
```

**Subtyping Rules:**
- Numeric promotion: `u8 → u16 → u32 → u64`, `i8 → i16 → i32 → i64`, `f32 → f64`
- Nullable coercion: `T` is assignable to `T?`
- Structural subtyping for structs and interfaces
- Contravariant parameters, covariant returns for functions
- Union and intersection type handling

### 3. Generic Types

Full support for generic types with constraints:

```typescript
// Generic type with constraint
type Optional<T: MyInterface> = variant {
    Some(value: T),
    None
}

// Generic substitution
const substitutions = new Map([['T', concreteType]]);
const instantiated = substituteGenerics(genericType, substitutions);
```

**Features:**
- Generic classes, interfaces, and functions
- Type parameter constraints
- Generic type instantiation
- Recursive generic types

### 4. Built-in Prototypes

Array and coroutine types have built-in prototype methods:

```typescript
let x = [1, 2, 3];
let len = x.length;      // u32
let sliced = x.slice(0, 2); // i32[]
x.push(4);               // void
```

Prototype types are defined in the language via `prototype for array { ... }` declarations.

### 5. Lazy Evaluation and Caching

The type system uses lazy evaluation with WeakMap-based caching:

```typescript
class TypeCTypeProvider {
    private readonly typeCache = new WeakMap<AstNode, TypeDescription>();
    
    getType(node: AstNode): TypeDescription {
        // Check cache first
        const cached = this.typeCache.get(node);
        if (cached) return cached;
        
        // Compute and cache
        const type = this.computeType(node);
        this.typeCache.set(node, type);
        return type;
    }
}
```

**Benefits:**
- Types computed only when needed
- Automatic memory management via WeakMap
- Handles recursive types naturally
- Performance optimization for large files

### 6. Recursive Types

The system handles recursive types through reference types and lazy evaluation:

```typescript
type LinkedList<T> = variant {
    Cons(value: T, next: LinkedList<T>),
    Nil
}

class Node<T> {
    let value: T;
    let next: Node<T>?;
    
    fn clone(): Node<T> {
        // Returns same type as class
    }
}
```

Reference types are resolved lazily to break cycles.

## Usage Examples

### Example 1: Type Inference

```typescript
// Variable type inference
let x = 42;              // Type: i32
let y = 3.14;           // Type: f64
let z = [1, 2, 3];      // Type: i32[]
let w = x + y;          // Type: f64 (numeric promotion)

// Function return type inference
fn add(a: i32, b: i32) = a + b  // Returns: i32

// Generic function
fn identity<T>(x: T) -> T = x
let result = identity<string>("hello");  // Type: string
```

### Example 2: Structural Typing

```typescript
// Struct types
type Point = struct { x: f64, y: f64 };
type Point3D = struct { x: f64, y: f64, z: f64 };

// Point3D is assignable to Point (structural subtyping)
let p2: Point = {x: 1.0, y: 2.0};
let p3: Point3D = {x: 1.0, y: 2.0, z: 3.0};
p2 = p3;  // OK: p3 has all fields of p2
```

### Example 3: Variant Types

```typescript
type Result<T, E> = variant {
    Ok(value: T),
    Err(error: E)
};

fn divide(a: f64, b: f64) -> Result<f64, string> {
    if b == 0.0 {
        return Err("Division by zero");
    }
    return Ok(a / b);
}

// Pattern matching with type narrowing
match divide(10.0, 2.0) {
    Ok(value) => {
        // value has type f64
        print(value);
    },
    Err(error) => {
        // error has type string
        print(error);
    },
    _ => unreachable
}
```

### Example 4: Generic Classes

```typescript
class Box<T> {
    let value: T;
    
    fn new(v: T): Box<T> {
        let box = new Box<T>();
        box.value = v;
        return box;
    }
    
    fn map<U>(f: fn(T) -> U) -> Box<U> {
        return Box<U>.new(f(this.value));
    }
}

let intBox = Box<i32>.new(42);
let strBox = intBox.map(fn(x: i32) -> string = x.toString());
```

## Integration with Langium

### Service Integration

The type system is integrated into Langium's service architecture:

```typescript
// In type-c-module.ts
export type TypeCAddedServices = {
    typing: {
        TypeProvider: TypeCTypeProvider
    }
}

// Usage in other services
class TypeCValidator {
    constructor(services: TypeCServices) {
        this.typeProvider = services.typing.TypeProvider;
    }
    
    validateAssignment(node: Assignment) {
        const leftType = this.typeProvider.getType(node.left);
        const rightType = this.typeProvider.getType(node.right);
        
        if (!isAssignable(rightType, leftType)) {
            this.error('Type mismatch', node);
        }
    }
}
```

### Scope Provider Integration

The type system works with the scope provider for autocomplete:

```typescript
class TypeCScopeProvider {
    protected getCompletionItems(node: AstNode): CompletionItem[] {
        const type = this.typeProvider.getType(node);
        
        if (type.kind === TypeKind.Class) {
            // Provide completions for class members
            return type.attributes.map(attr => ({
                label: attr.name,
                kind: CompletionItemKind.Property,
                detail: attr.type.toString()
            }));
        }
        
        // ...
    }
}
```

## Performance Considerations

### Caching Strategy

1. **WeakMap Cache**: Uses WeakMap for automatic memory management
2. **Node-level Caching**: Each AST node's type is cached individually
3. **Lazy Resolution**: Reference types resolved only when needed
4. **Cache Invalidation**: Call `invalidateCache(node)` when AST changes

### Best Practices

1. **Prefer Type Guards**: Use type guards (`isArrayType`, etc.) instead of `instanceof`
2. **Avoid Recomputation**: Access types through `TypeProvider.getType()`
3. **Batch Operations**: Group type operations to reduce overhead
4. **Profile Large Files**: Monitor performance for large TypeScript-like files

## Error Handling

The type system uses `ErrorType` for type errors:

```typescript
// Type error creation
factory.createErrorType('Unresolved reference', undefined, node);
    
// Error propagation
if (isErrorType(type)) {
    // Handle error case
}

// Error types are assignable to everything (to prevent cascading errors)
```

## Future Enhancements

Potential improvements for the type system:

1. **Effect System**: Track side effects and purity
2. **Dependent Types**: Limited dependent types for array sizes
3. **Refinement Types**: Predicates for more precise types
4. **Flow-Sensitive Typing**: More sophisticated control flow analysis
5. **Type Inference Improvements**: Better bidirectional type checking
6. **Performance Optimization**: Incremental type checking for large files

## Contributing

When extending the type system:

1. **Add Type Kind**: Add to `TypeKind` enum in `type-c-types.ts`
2. **Define Type Interface**: Extend `TypeDescription` in `type-c-types.ts`
3. **Add Type Guard**: Create `isXxxType()` function
4. **Create Factory**: Add factory function in `type-factory.ts`
5. **Implement Inference**: Add inference logic in `type-c-type-provider.ts`
6. **Update Utilities**: Add comparison/compatibility logic in `type-utils.ts`
7. **Add Tests**: Create tests for the new type

## References

- **Langium Documentation**: https://langium.org/
- **TypeScript Type System**: Similar design principles
- **Types and Programming Languages** (Pierce): Theoretical foundation
- **Type-C Grammar**: `packages/language/src/type-c.langium`
