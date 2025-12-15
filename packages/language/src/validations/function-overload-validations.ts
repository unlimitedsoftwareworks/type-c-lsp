import { ValidationAcceptor, ValidationChecks } from "langium";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";
import { TypeDescription, isImplementationType, isReferenceType } from "../typing/type-c-types.js";
import { TypeCBaseValidation } from "./base-validation.js";
import { ErrorCode } from "../codes/errors.js";

/**
 * Method signature for overload detection.
 * Note: Return type is NOT part of the signature!
 */
interface MethodSignature {
    name: string;
    genericParamCount: number;
    parameterTypes: string[];  // Serialized type representations
    node: ast.MethodHeader | ast.FunctionDeclaration;
}

/**
 * Validator for function overload uniqueness.
 * 
 * Ensures that function overloads within the same scope are unique.
 * The signature includes:
 * - Function name
 * - Generic parameter count
 * - Parameter types (in order)
 * 
 * Note: Return type is NOT part of the signature for overload resolution.
 * 
 * Examples:
 * ```
 * fn add(a: u32, b: u32) -> u32 { ... }  // ✅ OK
 * fn add(a: f64, b: f64) -> f64 { ... }  // ✅ OK - different parameter types
 * fn add(a: u32, b: u32) -> i32 { ... }  // ❌ Error - duplicate signature (return type doesn't matter)
 * 
 * fn map<T>(xs: T[]) -> T[] { ... }      // ✅ OK
 * fn map<T, U>(xs: T[]) -> U[] { ... }   // ✅ OK - different generic param count
 * ```
 */
export class FunctionOverloadValidator extends TypeCBaseValidation {
    private readonly typeProvider: TypeCTypeProvider;

    constructor(services: TypeCServices) {
        super();
        this.typeProvider = services.typing.TypeProvider;
    }

    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            Module: this.checkModuleFunctions,
            NamespaceDecl: this.checkNamespaceFunctions,
            ClassType: this.checkClassMethods,
            InterfaceType: this.checkInterfaceMethods,
        };
    }

    /**
     * Check for duplicate function overloads at module/file root level.
     */
    checkModuleFunctions = (node: ast.Module, accept: ValidationAcceptor): void => {
        const functions = node.definitions.filter(
            (def): def is ast.FunctionDeclaration => ast.isFunctionDeclaration(def)
        );
        
        this.checkFunctionOverloads(functions, accept);
    }

    /**
     * Check for duplicate function overloads within a namespace.
     */
    checkNamespaceFunctions = (node: ast.NamespaceDecl, accept: ValidationAcceptor): void => {
        const functions = node.definitions.filter(
            (def): def is ast.FunctionDeclaration => ast.isFunctionDeclaration(def)
        );
        
        this.checkFunctionOverloads(functions, accept);
    }

    /**
     * Check for duplicate method overloads within a class.
     * This includes both methods defined directly in the class and methods from implementations.
     * Errors are always reported on the class node or class method, never on impl methods.
     */
    checkClassMethods = (node: ast.ClassType, accept: ValidationAcceptor): void => {
        // Extract methods from the class
        const classMethods: ast.ClassMethod[] = [];
        for (const item of node.methods) {
            if (ast.isClassMethod(item)) {
                classMethods.push(item);
            }
        }
        
        // Track method headers with their source for proper error reporting
        interface MethodWithSource {
            header: ast.MethodHeader;
            source: 'class' | 'impl';
            classMethod?: ast.ClassMethod;  // For class methods
            implDecl?: ast.ClassImplementationMethodDecl;  // For impl methods
        }
        
        const allMethods: MethodWithSource[] = [];
        
        // Add class methods
        for (const classMethod of classMethods) {
            allMethods.push({
                header: classMethod.method,
                source: 'class',
                classMethod
            });
        }
        
        // Add methods from implementations
        for (const implDecl of node.implementations ?? []) {
            let implType = this.typeProvider.getType(implDecl.type);
            
            if (isReferenceType(implType)) {
                implType = this.typeProvider.resolveReference(implType);
            }
            
            if (isImplementationType(implType) && implType.node && ast.isImplementationType(implType.node)) {
                for (const implMethod of implType.node.methods ?? []) {
                    allMethods.push({
                        header: implMethod.method,
                        source: 'impl',
                        implDecl
                    });
                }
            }
        }
        
        // Check for duplicates with proper error reporting
        this.checkClassMethodsWithSources(allMethods, node, accept);
    }

    /**
     * Check for duplicate method overloads within an interface.
     */
    checkInterfaceMethods = (node: ast.InterfaceType, accept: ValidationAcceptor): void => {
        this.checkMethodOverloads(node.methods, accept, 'interface');
    }

    /**
     * Check methods from both class and implementations for duplicates.
     * Errors are always reported on class methods or the class node itself.
     */
    private checkClassMethodsWithSources(
        methods: Array<{
            header: ast.MethodHeader;
            source: 'class' | 'impl';
            classMethod?: ast.ClassMethod;
            implDecl?: ast.ClassImplementationMethodDecl;
        }>,
        classNode: ast.ClassType,
        accept: ValidationAcceptor
    ): void {
        // Group methods by each of their names (methods can have multiple names for operators)
        const methodsByName = new Map<string, typeof methods>();
        
        for (const method of methods) {
            for (const name of method.header.names) {
                if (!methodsByName.has(name)) {
                    methodsByName.set(name, []);
                }
                methodsByName.get(name)!.push(method);
            }
        }

        // Check each group for duplicate signatures
        for (const [name, methodGroup] of methodsByName.entries()) {
            if (methodGroup.length > 1) {
                this.checkClassMethodGroupWithSources(name, methodGroup, classNode, accept);
            }
        }
    }

    /**
     * Check a group of methods with the same name for duplicate signatures.
     * Errors are reported on class methods or the class node.
     */
    private checkClassMethodGroupWithSources(
        name: string,
        methods: Array<{
            header: ast.MethodHeader;
            source: 'class' | 'impl';
            classMethod?: ast.ClassMethod;
            implDecl?: ast.ClassImplementationMethodDecl;
        }>,
        classNode: ast.ClassType,
        accept: ValidationAcceptor
    ): void {
        // Check if any method in the group is generic
        const hasGenericMethod = methods.some(m =>
            m.header.genericParameters && m.header.genericParameters.length > 0
        );

        if (hasGenericMethod) {
            // Generic methods cannot be overloaded at all
            if (methods.length > 1) {
                for (const method of methods) {
                    if (method.header.genericParameters && method.header.genericParameters.length > 0) {
                        const errorCode = ErrorCode.TC_GENERIC_CLASS_METHOD_CANNOT_OVERLOAD;
                        
                        // Report error on class method if it's from the class, otherwise on class node
                        if (method.source === 'class' && method.classMethod) {
                            accept('error',
                                `Generic class method overload error: Generic method '${name}' cannot be overloaded. Generic methods use type inference and cannot have multiple signatures.`,
                                {
                                    node: method.classMethod.method,
                                    property: 'names',
                                    code: errorCode
                                }
                            );
                        } else if (method.source === 'impl' && method.implDecl) {
                            // Report on the impl declaration in the class
                            accept('error',
                                `Generic class method overload error: Generic method '${name}' from implementation cannot be overloaded. Generic methods use type inference and cannot have multiple signatures.`,
                                {
                                    node: method.implDecl,
                                    property: 'type',
                                    code: errorCode
                                }
                            );
                        }
                    }
                }
            }
            return;
        }

        // For non-generic methods, check for duplicate signatures
        const signatures: Array<{
            sig: MethodSignature;
            method: typeof methods[0];
        }> = [];

        for (const method of methods) {
            const signature = this.computeMethodSignature(name, method.header);
            
            // Check if this signature already exists
            const duplicate = signatures.find(s =>
                this.signaturesEqual(s.sig, signature)
            );

            if (duplicate) {
                // Check if this is a valid override shadowing an impl method
                // Case 1: Current method (class override) shadows existing method (impl)
                const isValidOverride = this.isValidOverrideShadowing(method, duplicate.method);
                
                if (isValidOverride) {
                    // Override method shadows impl method - this is allowed, no error
                    // Replace the impl method with the override in signatures list
                    const index = signatures.findIndex(s => s === duplicate);
                    if (index !== -1) {
                        signatures[index] = { sig: signature, method };
                    }
                    continue;
                }
                
                // Case 2: Current method (impl) is shadowed by existing method (class override)
                const isValidShadowed = this.isValidOverrideShadowing(duplicate.method, method);
                
                if (isValidShadowed) {
                    // Impl method is shadowed by override method - this is allowed, no error
                    // Keep the existing override method in the signatures list, skip this impl method
                    continue;
                }
                
                const errorCode = ErrorCode.TC_DUPLICATE_CLASS_METHOD_OVERLOAD;
                const errorMsg = `Duplicate class method: Method '${name}' with signature ${this.formatSignature(signature)} is already defined in this class. Each overload must have a unique parameter signature.`;
                
                // Report error based on where the current method is from
                if (method.source === 'class' && method.classMethod) {
                    // Report on the class method
                    accept('error', errorMsg, {
                        node: method.classMethod.method,
                        property: 'names',
                        code: errorCode
                    });
                } else if (method.source === 'impl' && method.implDecl) {
                    // Report on the impl declaration in the class
                    accept('error',
                        `Duplicate class method: Method '${name}' with signature ${this.formatSignature(signature)} from implementation is already defined in this class. Each overload must have a unique parameter signature.`,
                        {
                            node: method.implDecl,
                            property: 'type',
                            code: errorCode
                        }
                    );
                }
            } else {
                signatures.push({ sig: signature, method });
            }
        }
    }

    /**
     * Check a list of functions for duplicate overloads.
     * Groups functions by name and validates each group.
     */
    private checkFunctionOverloads(
        functions: ast.FunctionDeclaration[],
        accept: ValidationAcceptor
    ): void {
        // Group functions by name
        const functionsByName = new Map<string, ast.FunctionDeclaration[]>();
        
        for (const fn of functions) {
            if (!functionsByName.has(fn.name)) {
                functionsByName.set(fn.name, []);
            }
            functionsByName.get(fn.name)!.push(fn);
        }

        // Check each group for duplicate signatures
        for (const [name, fns] of functionsByName.entries()) {
            if (fns.length > 1) {
                this.checkFunctionGroup(name, fns, accept);
            }
        }
    }

    /**
     * Check a list of methods for duplicate overloads.
     * Methods can have multiple names (for operator overloading), so we need to check each name separately.
     */
    private checkMethodOverloads(
        methods: ast.MethodHeader[],
        accept: ValidationAcceptor,
        context: 'class' | 'interface'
    ): void {
        // Group methods by each of their names (methods can have multiple names for operators)
        const methodsByName = new Map<string, ast.MethodHeader[]>();
        
        for (const method of methods) {
            for (const name of method.names) {
                if (!methodsByName.has(name)) {
                    methodsByName.set(name, []);
                }
                methodsByName.get(name)!.push(method);
            }
        }

        // Check each group for duplicate signatures
        for (const [name, methodGroup] of methodsByName.entries()) {
            if (methodGroup.length > 1) {
                this.checkMethodGroup(name, methodGroup, accept, context);
            }
        }
    }

    /**
     * Check a group of functions with the same name for duplicate signatures.
     */
    private checkFunctionGroup(
        name: string,
        functions: ast.FunctionDeclaration[],
        accept: ValidationAcceptor
    ): void {
        // Check if any function in the group is generic
        const hasGenericFunction = functions.some(fn =>
            fn.genericParameters && fn.genericParameters.length > 0
        );

        if (hasGenericFunction) {
            // Generic functions cannot be overloaded at all
            if (functions.length > 1) {
                for (const fn of functions) {
                    if (fn.genericParameters && fn.genericParameters.length > 0) {
                        const errorCode = ErrorCode.TC_GENERIC_FUNCTION_CANNOT_OVERLOAD;
                        accept('error',
                            `Generic function overload error: Generic function '${name}' cannot be overloaded. Generic functions use type inference and cannot have multiple signatures.`,
                            {
                                node: fn,
                                property: 'name',
                                code: errorCode
                            }
                        );
                    }
                }
            }
            return;
        }

        // For non-generic functions, check for duplicate signatures
        const signatures: MethodSignature[] = [];

        for (const fn of functions) {
            const signature = this.computeFunctionSignature(fn);
            
            // Check if this signature already exists
            const duplicate = signatures.find(sig =>
                this.signaturesEqual(sig, signature)
            );

            if (duplicate) {
                // Report error on the current function
                const errorCode = ErrorCode.TC_DUPLICATE_FUNCTION_OVERLOAD;
                accept('error',
                    `Duplicate function overload: Function '${name}' with signature ${this.formatSignature(signature)} is already defined. Each overload must have a unique parameter signature.`,
                    {
                        node: fn,
                        property: 'name',
                        code: errorCode
                    }
                );
            } else {
                signatures.push(signature);
            }
        }
    }

    /**
     * Check a group of methods with the same name for duplicate signatures.
     */
    private checkMethodGroup(
        name: string,
        methods: ast.MethodHeader[],
        accept: ValidationAcceptor,
        context: 'class' | 'interface'
    ): void {
        // Check if any method in the group is generic
        const hasGenericMethod = methods.some(m =>
            m.genericParameters && m.genericParameters.length > 0
        );

        if (hasGenericMethod) {
            // Generic methods cannot be overloaded at all
            if (methods.length > 1) {
                for (const method of methods) {
                    if (method.genericParameters && method.genericParameters.length > 0) {
                        const errorCode = context === 'class'
                            ? ErrorCode.TC_GENERIC_CLASS_METHOD_CANNOT_OVERLOAD
                            : ErrorCode.TC_GENERIC_INTERFACE_METHOD_CANNOT_OVERLOAD;
                        accept('error',
                            `Generic ${context} method overload error: Generic method '${name}' cannot be overloaded. Generic methods use type inference and cannot have multiple signatures.`,
                            {
                                node: method,
                                property: 'names',
                                code: errorCode
                            }
                        );
                    }
                }
            }
            return;
        }

        // For non-generic methods, check for duplicate signatures
        const signatures: MethodSignature[] = [];

        for (const method of methods) {
            const signature = this.computeMethodSignature(name, method);
            
            // Check if this signature already exists
            const duplicate = signatures.find(sig =>
                this.signaturesEqual(sig, signature)
            );

            if (duplicate) {
                // Report error on the current method
                const errorCode = context === 'class'
                    ? ErrorCode.TC_DUPLICATE_CLASS_METHOD_OVERLOAD
                    : ErrorCode.TC_DUPLICATE_INTERFACE_METHOD_OVERLOAD;
                accept('error',
                    `Duplicate ${context} method overload: Method '${name}' with signature ${this.formatSignature(signature)} is already defined in this ${context}. Each overload must have a unique parameter signature.`,
                    {
                        node: method,
                        property: 'names',
                        code: errorCode
                    }
                );
            } else {
                signatures.push(signature);
            }
        }
    }

    /**
     * Compute the signature of a function for overload resolution.
     * Note: Return type is NOT included!
     */
    private computeFunctionSignature(fn: ast.FunctionDeclaration): MethodSignature {
        const genericParamCount = fn.genericParameters?.length ?? 0;
        const parameterTypes: string[] = [];

        // Get parameter types
        for (const param of fn.header.args) {
            const paramType = this.typeProvider.getType(param.type);
            parameterTypes.push(this.serializeType(paramType));
        }

        return {
            name: fn.name,
            genericParamCount,
            parameterTypes,
            node: fn
        };
    }

    /**
     * Compute the signature of a method for overload resolution.
     * Note: Return type is NOT included!
     */
    private computeMethodSignature(name: string, method: ast.MethodHeader): MethodSignature {
        const genericParamCount = method.genericParameters?.length ?? 0;
        const parameterTypes: string[] = [];

        // Get parameter types
        for (const param of method?.header?.args ?? []) {
            const paramType = this.typeProvider.getType(param.type);
            parameterTypes.push(this.serializeType(paramType));
        }

        return {
            name,
            genericParamCount,
            parameterTypes,
            node: method
        };
    }

    /**
     * Check if two signatures are equal (for duplicate detection).
     */
    private signaturesEqual(sig1: MethodSignature, sig2: MethodSignature): boolean {
        // Different names -> not equal
        if (sig1.name !== sig2.name) {
            return false;
        }

        // Different generic parameter counts -> not equal
        if (sig1.genericParamCount !== sig2.genericParamCount) {
            return false;
        }

        // Different parameter counts -> not equal
        if (sig1.parameterTypes.length !== sig2.parameterTypes.length) {
            return false;
        }

        // Check each parameter type
        for (let i = 0; i < sig1.parameterTypes.length; i++) {
            if (sig1.parameterTypes[i] !== sig2.parameterTypes[i]) {
                return false;
            }
        }

        return true;
    }

    /**
     * Serialize a type description for signature comparison.
     * This creates a normalized string representation of the type.
     */
    private serializeType(type: TypeDescription): string {
        // Use the type's toString method for now
        // This should handle most cases including generics, arrays, etc.
        return type.toString();
    }

    /**
     * Format a signature for error messages.
     */
    private formatSignature(sig: MethodSignature): string {
        const genericPart = sig.genericParamCount > 0 
            ? `<${Array(sig.genericParamCount).fill('T').map((_, i) => `T${i}`).join(', ')}>`
            : '';
        
        const paramsPart = sig.parameterTypes.join(', ');
        
        return `${sig.name}${genericPart}(${paramsPart})`;
    }

    /**
     * Check if a method validly shadows another method via override.
     * Returns true if current method is a class override method shadowing an impl method.
     */
    private isValidOverrideShadowing(
        current: {
            source: 'class' | 'impl';
            classMethod?: ast.ClassMethod;
        },
        existing: {
            source: 'class' | 'impl';
        }
    ): boolean {
        // Override shadowing only happens when:
        // 1. Current method is from class with override flag
        // 2. Existing method is from impl
        return current.source === 'class' &&
               current.classMethod?.isOverride === true &&
               existing.source === 'impl';
    }
}