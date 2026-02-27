import { AstNode, AstUtils, ValidationAcceptor, ValidationChecks } from "langium";
import { ErrorCode } from "../codes/errors.js";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import {
    ClassTypeDescription,
    isClassType,
    isImplementationType,
    isInterfaceType,
    isJoinType,
    isNullableType,
    isReferenceType,
    isSelfType,
    isStructType,
    MethodType,
    TypeDescription
} from "../typing/type-c-types.js";
import { TypeCTypedValidation } from "./typed-base-validation.js";

/**
 * Class/interface validator for Type-C.
 *
 * Performs validation of:
 * - Join types (intersection types)
 * - Interface inheritance, method names, and defaults
 * - Class interface implementations
 * - Implementation types
 * - Class impl declarations
 * - Member access (optional chaining, local access, variant constructor usage)
 */
export class TypeCClassInterfaceValidator extends TypeCTypedValidation {
    constructor(services: TypeCServices) {
        super(services);
    }

    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            JoinType: this.checkJoinType,
            InterfaceType: [this.checkInterfaceInheritance, this.checkInterfaceMethodNames, this.checkInterfaceMethodDefaults],
            ClassType: this.checkClassImplementation,
            ImplementationType: this.checkImplementaiton,
            ClassImplementationMethodDecl: this.checkClassImplDeclaration,
            MemberAccess: [this.checkVariantConstructorUsage, this.checkMemberAccess, this.checkLocalMemberAccess, this.checkOptionalChainingBasicType, this.checkExpressionForErrors],
        };
    }

    /**
     * Validate join (intersection) types.
     *
     * Rules:
     * 1. Join types can only combine interfaces and structs (not classes, enums, etc.)
     * 2. Cannot mix interfaces with structs in the same join
     * 3. Struct combination must have unique fields (no duplicate field names)
     * 4. Interface combination must have unique method signatures (overloading is allowed)
     */
    checkJoinType = (node: ast.JoinType, accept: ValidationAcceptor): void => {
        // Get the joined types
        const leftType = this.typeProvider.getType(node.left);
        const rightType = this.typeProvider.getType(node.right);

        // Resolve references
        const resolvedLeft = this.typeUtils.resolveIfReference(leftType);
        const resolvedRight = this.typeUtils.resolveIfReference(rightType);

        // Collect all types from nested joins
        const allTypes: TypeDescription[] = [];
        this.collectJoinTypes(resolvedLeft, allTypes);
        this.collectJoinTypes(resolvedRight, allTypes);

        // Validate that all types are either interfaces or structs
        const hasInterface = allTypes.some(t => isInterfaceType(t));
        const hasStruct = allTypes.some(t => isStructType(t));
        const hasOther = allTypes.some(t => !isInterfaceType(t) && !isStructType(t));

        // Check rule 1: Only interfaces and structs allowed
        if (hasOther) {
            const invalidType = allTypes.find(t => !isInterfaceType(t) && !isStructType(t));
            const errorCode = ErrorCode.TC_JOIN_TYPE_INVALID_MEMBER;
            accept('error',
                `Join type invalid member: Join types can only combine interfaces and structs. Found invalid type: ${invalidType?.toString()}`,
                { node, code: errorCode },
            );
            return;
        }

        // Check rule 2: Cannot mix interfaces with structs
        if (hasInterface && hasStruct) {
            const errorCode = ErrorCode.TC_JOIN_TYPE_MIXING_KINDS;
            accept('error',
                `Join type mixing error: Cannot combine interfaces with structs in the same join type. All members must be either interfaces or structs.`,
                { node, code: errorCode }
            );
            return;
        }

        // Check rule 3: Struct fields must have compatible types
        // Allow duplicate fields with the same type (inheritance), but error on conflicting types
        if (hasStruct) {
            const structs = allTypes.filter(isStructType);
            const fieldTypeMap = new Map<string, { type: TypeDescription; sources: string[] }>();

            for (const struct of structs) {
                const structName = struct.toString();
                for (const field of struct.fields) {
                    const existing = fieldTypeMap.get(field.name);
                    if (existing) {
                        // Check if types are compatible
                        if (existing.type.toString() !== field.type.toString()) {
                            const errorCode = ErrorCode.TC_JOIN_STRUCT_FIELD_TYPE_CONFLICT;
                            accept('error',
                                `Join struct field type conflict: Field '${field.name}' has conflicting types: '${existing.type.toString()}' in ${existing.sources.join(', ')} vs '${field.type.toString()}' in ${structName}`,
                                { node, code: errorCode }
                            );
                        }
                        existing.sources.push(structName);
                    } else {
                        fieldTypeMap.set(field.name, {
                            type: field.type,
                            sources: [structName]
                        });
                    }
                }
            }
        }

        // Check rule 4: Interface methods must have compatible signatures
        // Allow duplicate methods with the same signature (inheritance), but error on conflicting signatures
        if (hasInterface) {
            const interfaces = allTypes.filter(isInterfaceType);
            this.validateInterfaceMethodCompatibility(interfaces, node, accept);
        }
    }

    /**
     * Validate that interface methods have compatible signatures.
     * Allow duplicate methods with the same signature (inheritance),
     * but report errors for conflicting signatures with the same name.
     */
    private validateInterfaceMethodCompatibility(
        interfaces: TypeDescription[],
        node: ast.JoinType,
        accept: ValidationAcceptor
    ): void {
        interface MethodSignature {
            name: string;
            parameterTypes: string[];
            returnType: string;
            sources: string[];
        }

        const methodMap = new Map<string, MethodSignature>();

        for (const iface of interfaces) {
            if (!isInterfaceType(iface)) continue;

            const ifaceName = iface.toString();

            for (const method of iface.methods) {
                for (const name of method.names) {
                    const paramTypes = method.parameters.map(p => p.type.toString());
                    const returnType = method.returnType.toString();
                    const signatureKey = `${name}(${paramTypes.join(',')})`;

                    const existing = methodMap.get(signatureKey);
                    if (existing) {
                        // Check if return types match
                        if (existing.returnType !== returnType) {
                            const errorCode = ErrorCode.TC_JOIN_INTERFACE_METHOD_SIGNATURE_CONFLICT;
                            accept('error',
                                `Join interface method conflict: Method '${name}(${paramTypes.join(', ')})' has conflicting return types: '${existing.returnType}' in ${existing.sources.join(', ')} vs '${returnType}' in ${ifaceName}`,
                                { node, code: errorCode }
                            );
                        }
                        existing.sources.push(ifaceName);
                    } else {
                        methodMap.set(signatureKey, {
                            name,
                            parameterTypes: paramTypes,
                            returnType,
                            sources: [ifaceName]
                        });
                    }
                }
            }
        }
    }

    /**
     * Recursively collect all types from a join type.
     * Resolves reference types to get the actual interface/struct definitions.
     */
    private collectJoinTypes(type: TypeDescription, result: TypeDescription[]): void {
        // Resolve reference types first
        let resolvedType = type;
        if (isReferenceType(type)) {
            const resolved = this.typeProvider.resolveReference(type);
            if (resolved) {
                resolvedType = resolved;
            }
        }

        if (isJoinType(resolvedType)) {
            // Recursively flatten nested joins
            for (const t of resolvedType.types) {
                this.collectJoinTypes(t, result);
            }
        } else {
            result.push(resolvedType);
        }
    }


    /**
     * Check interface inheritance for method conflicts and circular references.
     *
     * Validates:
     * 1. Interfaces can only extend other interfaces
     * 2. No circular inheritance (A extends B, B extends A)
     * 3. When an interface extends another interface, it cannot override methods with
     *    different return types (same parameters, different return type).
     */
    checkInterfaceInheritance = (node: ast.InterfaceType, accept: ValidationAcceptor): void => {
        if (!node.superTypes || node.superTypes.length === 0) {
            return; // No inheritance to check
        }

        // Get the type description for this interface
        const interfaceType = this.typeProvider.getType(node);
        if (!isInterfaceType(interfaceType)) {
            return;
        }

        // Check for circular inheritance before processing methods
        const visited = new Set<ast.InterfaceType>();
        const path: string[] = [];
        const circularRef = this.detectCircularInheritance(node, visited, path);
        if (circularRef) {
            const errorCode = ErrorCode.TC_INTERFACE_CIRCULAR_INHERITANCE;
            accept('error',
                `Circular interface inheritance detected: ${circularRef}`,
                {
                    node: node,
                    code: errorCode
                }
            );
            return; // Don't process further if there's a circular reference
        }

        // Collect all methods from parent interfaces
        interface ParentMethod {
            name: string;
            parameterTypes: string[];
            returnType: string;
            parentInterface: string;
        }
        const parentMethods = new Map<string, ParentMethod>();

        for (const extendedRef of node.superTypes) {
            const parentType = this.typeProvider.getType(extendedRef);
            const resolvedParent = isReferenceType(parentType)
                ? this.typeProvider.resolveReference(parentType)
                : parentType;

            // Use asInterfaceType to handle both direct interfaces and join types that resolve to interfaces
            const parentInterface = this.typeUtils.asInterfaceType(resolvedParent);

            if (!parentInterface) {
                const errorCode = ErrorCode.TC_INTERFACE_INVALID_SUPERTYPE;
                accept('error',
                    `Interface can only extend other interfaces, but '${resolvedParent.toString()}' is not an interface`,
                    {
                        node: extendedRef,
                        code: errorCode
                    }
                );
                continue;
            }

            const parentName = parentInterface.toString();

            for (const method of parentInterface.methods) {
                for (const name of method.names) {
                    const paramTypes = method.parameters.map(p => p.type.toString());
                    const signatureKey = `${name}(${paramTypes.join(',')})`;

                    parentMethods.set(signatureKey, {
                        name,
                        parameterTypes: paramTypes,
                        returnType: method.returnType.toString(),
                        parentInterface: parentName
                    });
                }
            }
        }

        // Check if any methods in this interface conflict with parent methods
        for (const method of interfaceType.methods) {
            for (const name of method.names) {
                const paramTypes = method.parameters.map(p => p.type.toString());
                const signatureKey = `${name}(${paramTypes.join(',')})`;
                const returnType = method.returnType.toString();

                const parentMethod = parentMethods.get(signatureKey);
                if (parentMethod && parentMethod.returnType !== returnType) {
                    const errorCode = ErrorCode.TC_INTERFACE_INHERITANCE_METHOD_CONFLICT;
                    accept('error',
                        `Interface inheritance method conflict: Method '${name}(${paramTypes.join(', ')})' in interface cannot override parent method with different return type. Parent returns '${parentMethod.returnType}', but this interface returns '${returnType}'`,
                        {
                            node: node,
                            code: errorCode
                        }
                    );
                }
            }
        }
    }

    /**
     * Detects circular inheritance in interfaces.
     * Returns the cycle path as a string if found, undefined otherwise.
     *
     * @param node Current interface node being checked
     * @param visited Set of interface nodes already visited in this path
     * @param path Array of interface names forming the current path
     * @returns Cycle description string if circular reference found, undefined otherwise
     */
    private detectCircularInheritance(
        node: ast.InterfaceType,
        visited: Set<ast.InterfaceType>,
        path: string[]
    ): string | undefined {
        // If we've already visited this node in the current path, we found a cycle
        if (visited.has(node)) {
            // Find where the cycle starts
            const nodeType = this.typeProvider.getType(node);
            const nodeName = isInterfaceType(nodeType) ? nodeType.toString() : 'unknown';
            const cycleStart = path.indexOf(nodeName);
            if (cycleStart >= 0) {
                const cycle = [...path.slice(cycleStart), nodeName];
                return cycle.join(' → ');
            }
            return path.join(' → ') + ' → ' + nodeName;
        }

        // Add current node to visited set and path
        visited.add(node);
        const nodeType = this.typeProvider.getType(node);
        const nodeName = isInterfaceType(nodeType) ? nodeType.toString() : 'unknown';
        path.push(nodeName);

        // Check all supertypes
        if (node.superTypes) {
            for (const superTypeRef of node.superTypes) {
                const superType = this.typeProvider.getType(superTypeRef);

                // Resolve reference to get the actual interface
                const resolvedSuper = isReferenceType(superType)
                    ? this.typeProvider.resolveReference(superType)
                    : superType;

                // Use asInterfaceType to handle join types
                const superInterface = this.typeUtils.asInterfaceType(resolvedSuper);

                if (superInterface && superInterface.node && ast.isInterfaceType(superInterface.node)) {
                    // Recursively check the supertype
                    const result = this.detectCircularInheritance(
                        superInterface.node,
                        new Set(visited), // Create a copy to allow different branches
                        [...path] // Create a copy of the path
                    );
                    if (result) {
                        return result;
                    }
                }
            }
        }

        return undefined;
    }

    /**
     * Check that interface methods don't use reserved names like 'init'.
     *
     * The name 'init' is reserved for class initializers/constructors,
     * so interface methods cannot use this name.
     *
     * Examples:
     * ```tc
     * interface Bad {
     *     fn init()  // ❌ Error - 'init' is reserved
     * }
     *
     * interface Good {
     *     fn initialize()  // ✅ OK
     *     fn setup()       // ✅ OK
     * }
     * ```
     */
    checkInterfaceMethodNames = (node: ast.InterfaceType, accept: ValidationAcceptor): void => {
        // Check each method in the interface
        for (const method of node.methods) {
            // Check all names for this method (methods can have multiple names for overloading)
            for (const name of method.names) {
                if (name === 'init') {
                    const errorCode = ErrorCode.TC_INTERFACE_METHOD_RESERVED_NAME;
                    accept('error',
                        `Interface method cannot be named 'init': The name 'init' is reserved for class initializers and cannot be used in interface methods`,
                        {
                            node: method,
                            code: errorCode
                        }
                    );
                }
            }
        }
    }

    /**
     * Interface methods cannot have default parameter values.
     * Defaults are implementation-specific — they belong on the implementing class or impl, not the interface contract.
     */
    checkInterfaceMethodDefaults = (node: ast.InterfaceType, accept: ValidationAcceptor): void => {
        for (const method of node.methods) {
            for (const param of method.header?.args ?? []) {
                if (param.defaultValue) {
                    accept('error',
                        `Interface methods cannot have default parameter values. Default values are implementation-specific — move the default to the implementing class or impl.`,
                        {
                            node: param.defaultValue,
                            code: ErrorCode.TC_INTERFACE_DEFAULT_PARAM
                        }
                    );
                }
            }
        }
    }

    /**
     * Check class implementation of interfaces.
     *
     * When a class declares it extends interfaces (e.g., `class Container<T>`),
     * validate that it properly implements all required methods.
     */
    checkClassImplementation = (node: ast.ClassType, accept: ValidationAcceptor): void => {
        if (!node.superTypes || node.superTypes.length === 0) {
            return; // No interfaces to implement
        }

        // Get the class type
        const classType = this.typeProvider.getType(node);
        if (!isClassType(classType)) {
            return;
        }

        // Check each extended interface
        for (const superTypeRef of node.superTypes) {
            const interfaceType = this.typeProvider.getType(superTypeRef);
            const resolvedInterface = isReferenceType(interfaceType)
                ? this.typeProvider.resolveReference(interfaceType)
                : interfaceType;

            if (!isInterfaceType(resolvedInterface)) {
                continue;
            }

            // Use the existing compatibility check from type-utils
            const compatResult = this.typeUtils.isClassAssignableToInterface(classType, resolvedInterface);
            if (!compatResult.success) {
                const errorCode = ErrorCode.TC_VARIABLE_INTERFACE_IMPLEMENTATION_ERROR;
                const errorMsg = `Class must implement interface '${resolvedInterface.toString()}': ${compatResult.message}`;
                accept('error', errorMsg, {
                    node: superTypeRef,
                    code: errorCode
                });
            }
        }
    }

    checkImplementaiton(node: ast.ImplementationType, accept: ValidationAcceptor): void {
        const supertypes = (node?.superTypes ?? []).map(e => this.typeUtils.resolveIfReference(this.typeProvider.getType(e)));
        for (const [i, v] of supertypes.entries()) {
            if(!isInterfaceType(v)) {
                accept('error', `Implementation requirement is not an interface`, {
                    code: ErrorCode.TC_IMPL_REQUIREMENT_NOT_INTERFACE,
                    node: supertypes[i].node!
                })
            }
        }
    }

    /**
     * Check member access for proper usage of optional chaining.
     *
     * Rules:
     * 1. Accessing a nullable type with `.` → error (should use `?.`)
     *    UNLESS there's `?.` somewhere in the parent chain (nullability propagation)
     * 2. Accessing a non-nullable type with `?.` → warning
     *
     * Examples:
     * - `e?.serialize()` where `e: Entity?` → ✅ OK
     * - `e.serialize()` where `e: Entity?` → ❌ Error
     * - `e?.serialize()` where `e: Entity` → ⚠️ Warning
     * - `e.serialize()` where `e: Entity` → ✅ OK
     * - `c?.getData().getValue()` → ✅ OK (nullability propagates from `?.`)
     */
    checkMemberAccess = (node: ast.MemberAccess, accept: ValidationAcceptor): void => {
        const baseType = this.typeProvider.getType(node.expr);
        const isBaseNullable = isNullableType(baseType);
        const usesOptionalChaining = node.isNullable;

        // Check if optional chaining is used anywhere in the parent chain
        const hasOptionalChainingInChain = this.hasOptionalChaining(node.expr);

        // Rule 1: Accessing nullable type with regular `.`
        // EXCEPTION: If there's `?.` in the parent chain, nullability propagates so `.` is OK
        if (isBaseNullable && !usesOptionalChaining && !hasOptionalChainingInChain) {
            const errorCode = ErrorCode.TC_NULLABLE_ACCESSED_WITHOUT_OPTIONAL_CHAINING;
            accept('error',
                `Cannot access member of nullable type '${baseType.toString()}' using '.'. Use optional chaining '?.' instead, or unwrap with '!' if you're certain the value is not null.`,
                {
                    node,
                    property: 'element',
                    code: errorCode
                }
            );
            return;
        }

        // Rule 2: Accessing non-nullable type with `?.`
        if (!isBaseNullable && usesOptionalChaining) {
            const errorCode = ErrorCode.TC_NON_NULLABLE_ACCESSED_WITH_OPTIONAL_CHAINING;
            accept('warning',
                `Unnecessary optional chaining: Type '${baseType.toString()}' is not nullable. Use regular member access '.' instead.`,
                {
                    node,
                    property: 'element',
                    code: errorCode
                }
            );
        }
    }

    /**
     * Check that local attributes and methods are only accessed within their class scope.
     *
     * Local members (marked with `local` keyword) are private to the class and cannot be accessed
     * from outside the class, even from subclasses or instances in other contexts.
     *
     * Rules:
     * 1. Local attributes can only be accessed within methods of the same class
     * 2. Local methods can only be called within methods of the same class
     * 3. Access via `this` within the class is allowed
     * 4. Access from outside the class (even from subclasses) is forbidden
     *
     * Examples:
     * ```tc
     * class Counter {
     *     local let count: u32 = 0
     *     local fn increment() { this.count += 1 }
     *
     *     fn getCount() -> u32 = this.count  // ✅ OK - accessing local within class
     *     fn tick() { this.increment() }      // ✅ OK - calling local method within class
     * }
     *
     * let c = new Counter()
     * let x = c.count           // ❌ Error - accessing local attribute outside class
     * c.increment()             // ❌ Error - calling local method outside class
     * ```
     */
    checkLocalMemberAccess = (node: ast.MemberAccess, accept: ValidationAcceptor): void => {
        const element = node.element?.ref;
        if (!element) {
            return; // Unresolved reference, will be caught elsewhere
        }

        // Check if accessing a class attribute
        if (ast.isClassAttributeDecl(element)) {
            if (!element.isLocal) {
                return; // Not a local attribute, no validation needed
            }

            // Get the containing class of the attribute
            const attributeClass = AstUtils.getContainerOfType(element, ast.isClassType);
            if (!attributeClass) {
                return; // Shouldn't happen, but be safe
            }

            // Check if we're accessing from within the same class
            if (this.isAccessWithinClass(node, attributeClass)) {
                return; // ✅ Access from within the same class is allowed
            }

            // ❌ Error: Accessing local attribute from outside the class
            const errorCode = ErrorCode.TC_LOCAL_ATTRIBUTE_ACCESS_OUTSIDE_CLASS;
            accept('error',
                `Cannot access local attribute '${element.name}' outside of its class. ` +
                `Local attributes are private to the class and can only be accessed within the class's methods.`,
                {
                    node,
                    property: 'element',
                    code: errorCode
                }
            );
            return;
        }

        // Check if accessing a class method
        if (ast.isClassMethod(element)) {
            if (!element.isLocal) {
                return; // Not a local method, no validation needed
            }

            // Get the containing class of the method
            const methodClass = AstUtils.getContainerOfType(element, ast.isClassType);
            if (!methodClass) {
                return; // Shouldn't happen, but be safe
            }

            // Check if we're accessing from within the same class
            if (this.isAccessWithinClass(node, methodClass)) {
                return; // ✅ Access from within the same class is allowed
            }

            // ❌ Error: Accessing local method from outside the class
            const errorCode = ErrorCode.TC_LOCAL_METHOD_ACCESS_OUTSIDE_CLASS;
            const methodNames = element.method?.names || ['method'];
            accept('error',
                `Cannot access local method '${methodNames[0]}' outside of its class. ` +
                `Local methods are private to the class and can only be called within the class's methods.`,
                {
                    node,
                    property: 'element',
                    code: errorCode
                }
            );
        }
    }

    /**
     * Helper method to check if a member access is within the same class.
     *
     * @param accessNode The member access node
     * @param targetClass The class that contains the member being accessed
     * @returns true if the access is from within the same class, false otherwise
     */
    private isAccessWithinClass(accessNode: ast.MemberAccess, targetClass: ast.ClassType): boolean {
        // Walk up the AST to find the containing class (if any)
        let current: AstNode | undefined = accessNode.$container;

        while (current) {
            // Check if we're in a class method
            if (ast.isClassMethod(current)) {
                // Get the containing class of this method
                const containingClass = AstUtils.getContainerOfType(current, ast.isClassType);

                // Check if it's the same class (by reference equality)
                if (containingClass === targetClass) {
                    return true;
                }

                // Not the same class, return false
                return false;
            }

            current = current.$container;
        }

        // Not within any class method
        return false;
    }

    /**
     * Check that variant constructor expressions are only used in function call contexts.
     *
     * Variant constructors like Option.Some are inferred as function types for ease of use,
     * but they cannot be stored in variables or passed as parameters without being called.
     *
     * Examples:
     * - Option.Some(42) ✅ OK (function call)
     * - let z = Option.Some<u32> ❌ Error (storing constructor reference)
     * - foo(Option.Some) ❌ Error (passing constructor as argument)
     */
    checkVariantConstructorUsage = (node: ast.MemberAccess, accept: ValidationAcceptor): void => {
        // Get the type of this reference
        const targetRef = node.element.ref;
        if(ast.isVariantConstructor(targetRef) && !ast.isFunctionCall(node.$container)){
            if(!(ast.isFunctionCall(node.$container) && (node.$containerProperty === "expr"))){
                accept("error", "Variant constructors must be called", {
                    node,
                    code: ErrorCode.TC_VARIANT_CONSTRUCTOR_NOT_CALLED
                })
            }
        }
    }

    /**
     * Check class impl declaration.
     *
     * When a class uses an impl (e.g., `impl Default3DImpl<vec3>(pos, scale, rot)`),
     * validate:
     * 1. The referenced type is actually an implementation type
     * 2. The argument count matches the expected attributes
     * 3. Each argument type matches the expected attribute type
     * 4. All interface methods required by the impl are satisfied
     *
     * Examples:
     * ```tc
     * type Default3DImpl<T> = impl Object3D (
     *     pos: T,
     *     scale: T,
     *     rot: T
     * ) { ... }
     *
     * class Mesh {
     *     let pos: vec3
     *     let scale: vec3
     *     let rot: vec3
     *     impl Default3DImpl<vec3>(pos, scale, rot)  // ✅ OK - 3 args, all vec3
     * }
     *
     * class BadMesh {
     *     let pos: vec3
     *     impl Default3DImpl<vec3>(pos)  // ❌ Error - needs 3 args
     * }
     *
     * class BadMesh2 {
     *     let pos: u32
     *     let scale: vec3
     *     let rot: vec3
     *     impl Default3DImpl<vec3>(pos, scale, rot)  // ❌ Error - pos is u32, not vec3
     * }
     * ```
     */
    checkClassImplDeclaration = (node: ast.ClassImplementationMethodDecl, accept: ValidationAcceptor): void => {
        // Get the impl type being referenced
        const implRefType = this.typeProvider.getType(node.type);

        // Resolve the reference to get the actual implementation type
        let resolvedImplType = isReferenceType(implRefType)
            ? this.typeProvider.resolveReference(implRefType)
            : implRefType;

        // Resolve again if still a reference (nested references)
        resolvedImplType = this.typeUtils.resolveIfReference(resolvedImplType);

        // Verify it's an implementation type
        if (!isImplementationType(resolvedImplType)) {
            accept('error', `Expected implementation reference, instead got ${resolvedImplType.kind}`, {
                node: node.type,
                code: ErrorCode.TC_IMPL_NOT_IMPL
            })

            return;
        }

        // Get the expected attributes from the impl type
        const expectedAttributes = resolvedImplType.attributes;

        // Get the provided arguments
        const providedArgs = node.args || [];

        // Check 1: Argument count must match
        if (providedArgs.length !== expectedAttributes.length) {
            const errorCode = ErrorCode.TC_IMPL_ARG_COUNT_MISMATCH;
            accept('error',
                `Implementation argument count mismatch: ` +
                `'${this.getImplName(node.type)}' expects ${expectedAttributes.length} argument(s), ` +
                `but got ${providedArgs.length}`,
                {
                    node,
                    code: errorCode
                }
            );
            return;
        }

        // Check 2: Each argument type must match the expected attribute type
        // Build generic substitutions from the impl reference if it has generic args
        let substitutions: Map<string, TypeDescription> | undefined;
        if (isReferenceType(implRefType) && implRefType.genericArgs.length > 0 && implRefType.declaration.genericParameters) {
            substitutions = new Map<string, TypeDescription>();
            implRefType.declaration.genericParameters.forEach((param, i) => {
                if (i < implRefType.genericArgs.length) {
                    substitutions!.set(param.name, implRefType.genericArgs[i]);
                }
            });
        }

        for (let i = 0; i < providedArgs.length; i++) {
            const argRef = providedArgs[i].ref;
            if (!argRef || !ast.isClassAttributeDecl(argRef)) {
                continue; // Unresolved reference, will be caught elsewhere
            }

            // Get the actual type of the provided argument (the class attribute)
            const argType = this.typeProvider.getType(argRef.type);

            // Get the expected type from the impl attribute
            let expectedType = expectedAttributes[i].type;

            // Apply generic substitutions if we have them
            if (substitutions && substitutions.size > 0) {
                expectedType = this.typeUtils.substituteGenerics(expectedType, substitutions);
            }

            // Check type compatibility
            const compatResult = this.isTypeCompatible(argType, expectedType);
            if (!compatResult.success) {
                const errorCode = ErrorCode.TC_IMPL_ARG_TYPE_MISMATCH;
                const errorMsg = `Implementation argument ${i + 1} ('${argRef.name}') type mismatch: ` +
                      `Expected '${expectedType.toString()}', but got '${argType.toString()}'`;
                accept('error', errorMsg, {
                    node,
                    code: errorCode
                });
            }
        }

        // Check 3: Validate that impl interface requirements are satisfied by the class
        // This ensures that when an impl extends an interface but doesn't implement all methods,
        // the class using the impl provides the missing methods
        this.checkImplInterfaceRequirementsSatisfied(node, resolvedImplType, implRefType, accept);
    }

    /**
     * Check that all interface methods required by an impl are satisfied by the class.
     *
     * When an impl extends an interface (e.g., `impl Object3D`), it may implement some
     * interface methods but not all. The impl methods can then call the unimplemented
     * interface methods (e.g., `this.randomFn()`), expecting them to be provided elsewhere.
     *
     * This validation ensures that the class using the impl provides all methods that:
     * 1. Are required by the interface
     * 2. Are NOT implemented by the impl itself
     * 3. Are NOT provided by other impls
     *
     * Examples:
     * ```tc
     * type Object3D = interface {
     *     fn getPos() -> vec3
     *     fn randomFn() -> vec3
     * }
     *
     * type Default3DImpl<T> = impl Object3D (pos: T) {
     *     fn getPos() = this.position
     *     fn useRandom() = this.randomFn()  // Calls interface method
     * }
     *
     * class MyObject {
     *     let pos: vec3
     *     impl Default3DImpl<vec3>(pos)
     *     // ❌ Error: Must provide randomFn() since impl doesn't implement it
     * }
     *
     * class MyObject2 {
     *     let pos: vec3
     *     impl Default3DImpl<vec3>(pos)
     *     fn randomFn() -> vec3 { ... }  // ✅ OK: Provides missing method
     * }
     * ```
     */
    private checkImplInterfaceRequirementsSatisfied = (
        implDeclNode: ast.ClassImplementationMethodDecl,
        resolvedImplType: TypeDescription,
        implRefType: TypeDescription,
        accept: ValidationAcceptor
    ): void => {
        if (!isImplementationType(resolvedImplType)) {
            return;
        }

        // Build generic substitutions from the impl reference if it has generic args
        let substitutions: Map<string, TypeDescription> | undefined;
        if (isReferenceType(implRefType) && implRefType.genericArgs.length > 0 && implRefType.declaration.genericParameters) {
            substitutions = new Map<string, TypeDescription>();
            implRefType.declaration.genericParameters.forEach((param, i) => {
                if (i < implRefType.genericArgs.length) {
                    substitutions!.set(param.name, implRefType.genericArgs[i]);
                }
            });
        }

        // Get the containing class
        const classNode = AstUtils.getContainerOfType(implDeclNode, ast.isClassType);
        if (!classNode) {
            return;
        }

        const classType = this.typeProvider.getType(classNode);
        if (!isClassType(classType)) {
            return;
        }

        // Check each interface that this impl extends
        for (const targetType of resolvedImplType.targetTypes) {
            // Resolve reference types to get the actual interface
            let resolvedTargetType = isReferenceType(targetType)
                ? this.typeProvider.resolveReference(targetType)
                : targetType;

            const interfaceType = this.typeUtils.asInterfaceType(resolvedTargetType);
            if (!interfaceType) {
                continue; // Not an interface, skip
            }

            // Check each interface method
            for (const interfaceMethod of interfaceType.methods) {
                // Apply generic substitutions to the interface method if we have them
                let expectedMethod = interfaceMethod;
                if (substitutions && substitutions.size > 0) {
                    expectedMethod = {
                        ...interfaceMethod,
                        parameters: interfaceMethod.parameters.map(p => ({
                            name: p.name,
                            type: this.typeUtils.substituteGenerics(p.type, substitutions),
                            isMut: p.isMut,
                            hasDefault: p.hasDefault
                        })),
                        returnType: this.typeUtils.substituteGenerics(interfaceMethod.returnType, substitutions)
                    };
                }

                // Check if this interface method is implemented by the impl itself
                const implementedByImpl = resolvedImplType.methods.some(implMethod =>
                    this.methodMatchesInterfaceMethod(implMethod, expectedMethod, classType)
                );

                if (implementedByImpl) {
                    continue; // Impl provides this method, no need for class to provide it
                }

                // Check if the class provides this method (directly or via other impls)
                // Collect all class methods + methods from all impls
                const allClassMethods = [...classType.methods];

                // Add methods from all other impls
                for (const otherImplRef of classType.implementations) {
                    const otherImpl = this.typeProvider.resolveReference(otherImplRef);
                    if (isImplementationType(otherImpl)) {
                        // Build substitutions for this other impl
                        let otherSubstitutions: Map<string, TypeDescription> | undefined;
                        if (isReferenceType(otherImplRef) && otherImplRef.genericArgs.length > 0 && otherImplRef.declaration.genericParameters) {
                            otherSubstitutions = new Map<string, TypeDescription>();
                            otherImplRef.declaration.genericParameters.forEach((param, i) => {
                                if (i < otherImplRef.genericArgs.length) {
                                    otherSubstitutions!.set(param.name, otherImplRef.genericArgs[i]);
                                }
                            });
                        }

                        // Add substituted methods from other impl
                        for (const otherImplMethod of otherImpl.methods) {
                            if (otherSubstitutions && otherSubstitutions.size > 0) {
                                allClassMethods.push({
                                    ...otherImplMethod,
                                    parameters: otherImplMethod.parameters.map(p => ({
                                        name: p.name,
                                        type: this.typeUtils.substituteGenerics(p.type, otherSubstitutions!),
                                        isMut: p.isMut,
                                        hasDefault: p.hasDefault
                                    })),
                                    returnType: this.typeUtils.substituteGenerics(otherImplMethod.returnType, otherSubstitutions!)
                                });
                            } else {
                                allClassMethods.push(otherImplMethod);
                            }
                        }
                    }
                }

                // Check if any method in the class (including from other impls) provides this interface method
                const providedByClass = allClassMethods.some(classMethod =>
                    this.methodMatchesInterfaceMethod(classMethod, expectedMethod, classType)
                );

                if (!providedByClass) {
                    // Missing required interface method
                    const errorCode = ErrorCode.TC_IMPL_INTERFACE_METHOD_NOT_SATISFIED;
                    const methodSignature = `${expectedMethod.names[0]}(${expectedMethod.parameters.map(p => `${p.name}: ${p.type.toString()}`).join(', ')}) -> ${expectedMethod.returnType.toString()}`;
                    accept('error',
                        `Class must implement interface method '${expectedMethod.names[0]}': ` +
                        `Implementation '${this.getImplName(implDeclNode.type)}' extends interface with method '${methodSignature}', ` +
                        `but neither the impl nor the class provides this method.`,
                        {
                            node: implDeclNode,
                            code: errorCode
                        }
                    );
                }
            }
        }
    }

    /**
     * Check if a method matches an interface method's signature.
     *
     * @param method The method to check (from impl or class)
     * @param interfaceMethod The interface method to match against
     * @returns true if the method satisfies the interface method requirement
     */
    private methodMatchesInterfaceMethod(
        method: MethodType,
        interfaceMethod: MethodType,
        classType?: ClassTypeDescription
    ): boolean {
        // Check if method has any name that matches the interface method
        const hasCommonName = method.names.some((name: string) =>
            interfaceMethod.names.includes(name)
        );

        if (!hasCommonName) {
            return false;
        }

        // CRITICAL: Interface methods are always public
        // Local (private) methods cannot implement interface methods
        if (method.isLocal) {
            return false;
        }

        // Substitute Self with the class type before comparing signatures
        let effectiveMethod = method;
        let effectiveInterfaceMethod = interfaceMethod;
        if (classType) {
            const selfSubs = new Map<string, TypeDescription>([['Self', classType]]);
            if (isSelfType(method.returnType)) {
                effectiveMethod = { ...method, returnType: this.typeUtils.substituteGenerics(method.returnType, selfSubs) };
            }
            if (isSelfType(interfaceMethod.returnType)) {
                effectiveInterfaceMethod = { ...interfaceMethod, returnType: this.typeUtils.substituteGenerics(interfaceMethod.returnType, selfSubs) };
            }
        }

        // Check signature compatibility
        const compatResult = this.typeUtils.isMethodImplementationCompatible(effectiveMethod, effectiveInterfaceMethod);
        return compatResult.success;
    }

    /**
     * Helper method to get a display name for an impl type reference.
     */
    private getImplName(typeRef: ast.ReferenceType): string {
        if (typeRef.field?.ref && ast.isTypeDeclaration(typeRef.field.ref)) {
            const decl = typeRef.field.ref;
            if (typeRef.genericArgs && typeRef.genericArgs.length > 0) {
                return `${decl.name}<${typeRef.genericArgs.map(g => g.$cstNode?.text || '?').join(', ')}>`;
            }
            return decl.name;
        }
        return typeRef.$cstNode?.text || 'unknown';
    }

}
