import { ValidationAcceptor, ValidationChecks } from "langium";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";
import { TypeDescription } from "../typing/type-c-types.js";
import { TypeCBaseValidation } from "./base-validation.js";

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
     */
    checkClassMethods = (node: ast.ClassType, accept: ValidationAcceptor): void => {
        // Extract methods from the class
        const classMethods: ast.ClassMethod[] = [];
        for (const item of node.methods) {
            if (ast.isClassMethod(item)) {
                classMethods.push(item);
            }
        }
        
        this.checkMethodOverloads(classMethods.map(m => m.method), accept, 'class');
    }

    /**
     * Check for duplicate method overloads within an interface.
     */
    checkInterfaceMethods = (node: ast.InterfaceType, accept: ValidationAcceptor): void => {
        this.checkMethodOverloads(node.methods, accept, 'interface');
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
                        accept('error',
                            `Generic function '${name}' cannot be overloaded`,
                            {
                                node: fn,
                                property: 'name'
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
                accept('error',
                    `Duplicate function overload: '${name}' with signature ${this.formatSignature(signature)} already exists`,
                    {
                        node: fn,
                        property: 'name'
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
                        accept('error',
                            `Generic ${context} method '${name}' cannot be overloaded`,
                            {
                                node: method,
                                property: 'names'
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
                accept('error',
                    `Duplicate ${context} method overload: '${name}' with signature ${this.formatSignature(signature)} already exists`,
                    {
                        node: method,
                        property: 'names'
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
}