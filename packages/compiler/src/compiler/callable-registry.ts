import { AstNode } from "langium"
import * as ast from 'type-c-language/ast';
import { TypeDescription } from 'type-c-language/types';
import { MonomorphizationRegistry } from 'type-c-language/services';

/**
 * Registry for tracking callable names (functions and methods) with name mangling support.
 * 
 * This registry handles:
 * - Regular (non-generic) functions
 * - Generic function instantiations
 * - Class methods (both generic and non-generic)
 * 
 * For generic callables, it delegates to MonomorphizationRegistry for name generation.
 */
export class CallableRegistry {
    nodeMap: Map<AstNode, string> = new Map();
    nameCounter: Map<string, number> = new Map();
    monoRegistry: MonomorphizationRegistry;

    constructor(monoRegistry: MonomorphizationRegistry) {
        this.monoRegistry = monoRegistry;
    }

    /**
     * Get or generate a mangled name for a callable node.
     * 
     * For generic callables, this method should NOT be called directly.
     * Instead, use the specific methods for generic instantiations.
     * 
     * @param node Either FunctionDeclaration or ClassMethod
     * @param name Optional explicit name to use instead of extracting from node
     * @returns The mangled name (unique across different nodes, consistent for same node)
     */
    C(node: AstNode, name?: string): string {
        // If we've already seen this node, return the stored mangled name
        if (this.nodeMap.has(node)) {
            return this.nodeMap.get(node)!;
        }
        
        // Get the base name (from parameter or extract from node)
        const baseName = name ?? this.extractNodeName(node);
        
        // For methods, include the class name
        if (ast.isClassMethod(node)) {
            const classDecl = this.findParentClass(node);
            if (classDecl) {
                const className = classDecl.name;
                const methodName = baseName;
                const fullName = `${className}::${methodName}`;
                return this.generateMangledName(node, fullName);
            }
        }
        
        // For regular functions or if we couldn't find parent class
        return this.generateMangledName(node, baseName);
    }

    /**
     * Get mangled name for a generic function instantiation.
     * Uses the monomorphization registry to generate the name based on type arguments.
     * 
     * @param declaration The generic function declaration
     * @param typeArgs Concrete type arguments for this instantiation
     * @returns The mangled name for this specific instantiation
     * 
     * @example
     * // For: sort<u32>(arr)
     * getGenericFunctionName(sortDecl, [u32Type]) // Returns: "sort$u32"
     */
    getGenericFunctionName(
        declaration: ast.FunctionDeclaration,
        typeArgs: readonly TypeDescription[]
    ): string {
        // Register the instantiation with monomorphization registry
        const key = this.monoRegistry.registerFunctionInstantiation(declaration, typeArgs);
        
        // Get mangled name from the key
        const mangledName = this.monoRegistry.mangleName(key);
        
        // Note: We don't store this in nodeMap because the same declaration
        // can have multiple instantiations with different type arguments
        
        return mangledName;
    }

    /**
     * Get mangled name for a method instantiation.
     * This handles both:
     * - Methods in generic classes (even if method itself is not generic)
     * - Generic methods in any class
     * 
     * Uses the monomorphization registry to generate the name.
     * 
     * @param classKey The key of the parent class instantiation
     * @param methodDecl The method declaration
     * @param methodTypeArgs Concrete type arguments for the method (empty if method is not generic)
     * @returns The mangled name for this specific instantiation
     * 
     * @example
     * // For: arr.map<string>(fn) where arr: Array<u32>
     * getGenericMethodName("Array<u32>", mapDecl, [stringType]) // Returns: "Array$u32$map$string"
     */
    getGenericMethodName(
        classKey: string,
        methodDecl: ast.MethodHeader,
        methodTypeArgs: readonly TypeDescription[]
    ): string {
        // Register the instantiation with monomorphization registry
        const key = this.monoRegistry.registerMethodInstantiation(
            classKey,
            methodDecl,
            methodTypeArgs
        );
        
        // Get mangled name from the key
        const mangledName = this.monoRegistry.mangleName(key);
        
        return mangledName;
    }

    /**
     * Get mangled name for a NON-GENERIC method in a specific class instantiation.
     * This method is ONLY for methods that don't have their own generic parameters.
     * For generic methods, use getGenericMethodName with actual type arguments.
     *
     * @param classKey The key of the parent class instantiation (e.g., "Array<u32>" or "MyClass")
     * @param methodDecl The method declaration
     * @returns The mangled name
     *
     * @throws Error if the method has generic parameters (use getGenericMethodName instead)
     */
    getMethodNameForClass(
        classKey: string,
        methodDecl: ast.MethodHeader
    ): string {
        // Check if method has its own generic parameters
        if (methodDecl.genericParameters && methodDecl.genericParameters.length > 0) {
            throw new Error(
                `Method ${methodDecl.names[0]} has generic parameters. ` +
                `Use getGenericMethodName with actual type arguments instead.`
            );
        }
        
        // For non-generic methods, construct the name directly
        const methodName = methodDecl.names[0];
        const key = `${classKey}::${methodName}`;
        
        // Mangle the key (this handles things like Array<u32> → Array$u32)
        return this.monoRegistry.mangleName(key);
    }

    /**
     * Generate a unique mangled name for non-generic callables
     */
    private generateMangledName(node: AstNode, baseName: string): string {
        let mangledName: string;
        if (this.nameCounter.has(baseName)) {
            // Name already used, append counter to make it unique
            const counter = this.nameCounter.get(baseName)!;
            mangledName = `${baseName}_${counter}`;
            this.nameCounter.set(baseName, counter + 1);
        } else {
            // First time seeing this name
            mangledName = baseName;
            this.nameCounter.set(baseName, 1);
        }
        
        // Store the mapping and return the mangled name
        this.nodeMap.set(node, mangledName);
        return mangledName;
    }

    /**
     * Find the parent TypeDeclaration for a ClassMethod
     */
    private findParentClass(node: AstNode): ast.TypeDeclaration | undefined {
        let current: AstNode | undefined = node.$container;
        while (current) {
            if (ast.isTypeDeclaration(current)) {
                return current;
            }
            // Also check for ClassType directly
            if (ast.isClassType(current)) {
                // Find the TypeDeclaration that contains this ClassType
                current = current.$container;
                if (ast.isTypeDeclaration(current)) {
                    return current;
                }
            }
            current = current.$container;
        }
        return undefined;
    }

    /**
     * Extract the name from a node
     * @param node Either FunctionDeclaration or ClassMethod
     * @returns The callable name, or '_unknown' if not available
     */
    private extractNodeName(node: AstNode): string {
        if (ast.isFunctionDeclaration(node)) {
            return node.name;
        }
        if (ast.isClassMethod(node) && node.method) {
            // Use the first name from the names array
            return node.method.names[0];
        }
        if (ast.isMethodHeader(node)) {
            return node.names[0];
        }
        if ('name' in node) {
            return node['name'] as string;
        }
        // Fallback for other node types
        return '_unknown';
    }
}