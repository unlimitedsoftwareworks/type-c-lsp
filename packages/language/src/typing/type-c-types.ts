import { AnonymousVariantConstructorTypeDescription } from "./datatypes/anonymous-variant-consturctor-type.js";
import { AnyTypeDescription } from "./datatypes/any-type.js";
import { ArrayTypeDescription } from "./datatypes/array-type.js";
import { BoolTypeDescription } from "./datatypes/bool-type.js";
import { ClassDefinitionTypeDescription, ClassMethodDescription, ClassTypeDescription } from "./datatypes/class-type.js";
import { CoroutineTypeDescription } from "./datatypes/coroutine-type.js";
import { EnumTypeDescription } from "./datatypes/enum-type.js";
import { ErrorTypeDescription } from "./datatypes/error-type.js";
import { FFIDefinitionTypeDescription } from "./datatypes/ffi-type.js";
import { FloatTypeDescription } from "./datatypes/float-type.js";
import { FunctionTypeDescription } from "./datatypes/function-type.js";
import { GenericTypeDescription } from "./datatypes/generic-type.js";
import { ImplementationTypeDescription } from "./datatypes/implementation-type.js";
import { IntegerTypeDescription } from "./datatypes/integer-type.js";
import { InterfaceMethodDescription, InterfaceTypeDescription } from "./datatypes/interface-type.js";
import { NamespaceDefinitionTypeDescription } from "./datatypes/namespace-type.js";
import { NeverType } from "./datatypes/never-type.js";
import { NullTypeDescription } from "./datatypes/null-type.js";
import { NullableTypeDescription } from "./datatypes/nullable-type.js";
import { PrototypeFunctionTypeDescription } from "./datatypes/prototype-type.js";
import { ReferenceTypeDescription } from "./datatypes/reference-type.js";
import { StringEnumTypeDescription } from "./datatypes/string-enum-type.js";
import { StringTypeDescription } from "./datatypes/string-type.js";
import { StructTypeDescription } from "./datatypes/struct-type.js";
import { TupleTypeDescription } from "./datatypes/tuple-type.js";
import { UnionTypeDescription } from "./datatypes/union-type.js";
import { UnsetTypeDescription } from "./datatypes/unset-type.js";
import { VariantConstructorTypeDescription } from "./datatypes/variant-consturctor-type.js";
import { VariantDefinitionTypeDescription, VariantTypeDescription } from "./datatypes/variant-type.js";
import { VoidTypeDescription } from "./datatypes/void-type.js";

/**
 * All types extend the AbstractTypeDescription interface.
 */
export type TypeDescription = 
    NullTypeDescription |
    VoidTypeDescription |
    BoolTypeDescription |
    IntegerTypeDescription |
    FloatTypeDescription |
    StringTypeDescription |
    ArrayTypeDescription |
    FunctionTypeDescription |
    CoroutineTypeDescription |
    ClassTypeDescription |
    InterfaceTypeDescription |
    ImplementationTypeDescription |
    EnumTypeDescription |
    VariantTypeDescription |
    VariantConstructorTypeDescription |
    StructTypeDescription |
    AnonymousVariantConstructorTypeDescription | //::OK()
    StringEnumTypeDescription |
    NullableTypeDescription |
    TupleTypeDescription |
    GenericTypeDescription |
    ErrorTypeDescription |
    AnyTypeDescription | 
    NeverType |
    UnsetTypeDescription |
    ReferenceTypeDescription |
    UnionTypeDescription | // Union is used as a constraint for generics, that is all.
    PrototypeFunctionTypeDescription |
    InterfaceMethodDescription |
    ClassMethodDescription |

    /**
     * The following types are used for auto-completion, they should never propagate 
     * to; say a variable
     */
    
    // used for static class attributes/methods: MyClass.x typeof(MyClass) = ClassDefinitionTypeDescription
    ClassDefinitionTypeDescription |
    
    // used for static interface methods: MyInterface.x typeof(MyInterface) = InterfaceDefinitionTypeDescription
    // InterfaceDefinitionTypeDescription |
    
    // used for creating variant consturcots: let x: Response.Ok(200) typeof(Response) = VariantDefinitionTypeDescription
    VariantDefinitionTypeDescription |
    
    // Used for Namespaces
    NamespaceDefinitionTypeDescription |

    // Used for type FFI modules
    FFIDefinitionTypeDescription;

