/**
 * Monomorphization Service for Type-C
 * 
 * Tracks all generic instantiations during type checking to enable
 * code generation of specialized versions (monomorphization).
 * 
 * This service collects:
 * - Generic class instantiations: Array<u32>, Result<i32, string>, etc.
 * - Generic method instantiations: Array<u32>::map<string>, etc.
 * - Generic function instantiations: sort<u32>, map<string>, etc.
 */

import * as ast from '../generated/ast.js';
import { TypeDescription } from './type-c-types.js';

/**
 * Represents a concrete instantiation of a generic class.
 * Example: Array<u32>, Result<i32, string>
 */
export interface ClassInstantiation {
    /** The generic class declaration */
    readonly declaration: ast.TypeDeclaration;
    /** Concrete type arguments for this instantiation */
    readonly typeArgs: readonly TypeDescription[];
    /** Canonical key for this instantiation (e.g., "Array<u32>") */
    readonly key: string;
}

/**
 * Represents a concrete instantiation of a generic method.
 * Example: Array<u32>::map<string>
 */
export interface MethodInstantiation {
    /** Key of the parent class instantiation */
    readonly classKey: string;
    /** The generic class declaration */
    readonly classDeclaration: ast.TypeDeclaration;
    /** Concrete type arguments for the class */
    readonly classTypeArgs: readonly TypeDescription[];
    /** The generic method declaration */
    readonly methodDeclaration: ast.MethodHeader;
    /** Concrete type arguments for the method (empty if method is not generic) */
    readonly methodTypeArgs: readonly TypeDescription[];
    /** Canonical key for this instantiation (e.g., "Array<u32>::map<string>") */
    readonly key: string;
}

/**
 * Represents a concrete instantiation of a generic function.
 * Example: sort<u32>, map<string>
 */
export interface FunctionInstantiation {
    /** The generic function declaration */
    readonly declaration: ast.FunctionDeclaration;
    /** Concrete type arguments for this instantiation */
    readonly typeArgs: readonly TypeDescription[];
    /** Canonical key for this instantiation (e.g., "sort<u32>") */
    readonly key: string;
}

/**
 * Registry for tracking all generic instantiations in the program.
 * 
 * This service is populated during type checking when generic types are used,
 * and later used during code generation to produce specialized versions.
 */
export class MonomorphizationRegistry {
    /** Map of class instantiation keys to their details */
    private classes = new Map<string, ClassInstantiation>();
    
    /** Map of method instantiation keys to their details */
    private methods = new Map<string, MethodInstantiation>();
    
    /** Map of function instantiation keys to their details */
    private functions = new Map<string, FunctionInstantiation>();

    /**
     * Clears all registered instantiations.
     * Useful for testing or when recompiling.
     */
    clear(): void {
        this.classes.clear();
        this.methods.clear();
        this.functions.clear();
    }

    // ============================================================================
    // Class Instantiation Registration
    // ============================================================================

    /**
     * Registers a concrete instantiation of a generic class.
     * 
     * Called during type checking when a generic class is used with concrete type arguments.
     * For example, when seeing `new Array<u32>()` or `let x: Result<i32, string>`.
     * 
     * @param decl The generic class declaration
     * @param typeArgs Concrete type arguments (must match generic parameter count)
     * @returns Canonical key for this instantiation
     * 
     * @example
     * ```typescript
     * // When type checking: let arr: Array<u32> = ...
     * registry.registerClassInstantiation(ArrayDecl, [u32Type])
     * // Returns: "Array<u32>"
     * ```
     */
    registerClassInstantiation(
        decl: ast.TypeDeclaration,
        typeArgs: readonly TypeDescription[]
    ): string {
        // Validate that this is actually a generic class
        if (!decl.genericParameters || decl.genericParameters.length === 0) {
            // Not a generic class - no need to register
            return decl.name;
        }

        const key = this.makeClassKey(decl, typeArgs);
        
        if (!this.classes.has(key)) {
            this.classes.set(key, {
                declaration: decl,
                typeArgs: [...typeArgs], // Create a copy to avoid mutation
                key
            });
        }
        
        return key;
    }

    /**
     * Creates a canonical key for a class instantiation.
     * Format: ClassName<Type1,Type2,...>
     */
    private makeClassKey(
        decl: ast.TypeDeclaration,
        typeArgs: readonly TypeDescription[]
    ): string {
        if (typeArgs.length === 0) {
            return decl.name;
        }
        
        const typeArgStrings = typeArgs.map(t => this.canonicalizeType(t));
        return `${decl.name}<${typeArgStrings.join(',')}>`;
    }

    // ============================================================================
    // Method Instantiation Registration
    // ============================================================================

    /**
     * Registers a concrete instantiation of a generic method.
     * 
     * Called during type checking when a generic method is called with concrete type arguments.
     * For example, when seeing `arr.map(fn(x) = x * 2)` where map is generic.
     * 
     * @param classKey The key of the parent class instantiation
     * @param methodDecl The generic method declaration
     * @param methodTypeArgs Concrete type arguments for the method
     * @returns Canonical key for this instantiation
     * 
     * @example
     * ```typescript
     * // When type checking: arr1.map(fn(x: u32) = "hi")
     * // where arr1: Array<u32>
     * registry.registerMethodInstantiation("Array<u32>", mapDecl, [stringType])
     * // Returns: "Array<u32>::map<string>"
     * ```
     */
    registerMethodInstantiation(
        classKey: string,
        methodDecl: ast.MethodHeader,
        methodTypeArgs: readonly TypeDescription[]
    ): string {
        const classInst = this.classes.get(classKey);
        if (!classInst) {
            throw new Error(`Cannot register method instantiation: class instantiation not found for key '${classKey}'`);
        }

        const key = this.makeMethodKey(classKey, methodDecl, methodTypeArgs);
        
        if (!this.methods.has(key)) {
            this.methods.set(key, {
                classKey,
                classDeclaration: classInst.declaration,
                classTypeArgs: classInst.typeArgs,
                methodDeclaration: methodDecl,
                methodTypeArgs: [...methodTypeArgs], // Create a copy
                key
            });
        }
        
        return key;
    }

    /**
     * Creates a canonical key for a method instantiation.
     * Format: ClassName<ClassTypes>::methodName<MethodTypes>
     */
    private makeMethodKey(
        classKey: string,
        methodDecl: ast.MethodHeader,
        methodTypeArgs: readonly TypeDescription[]
    ): string {
        const methodName = methodDecl.names[0]; // Use first name from the method's names array
        
        if (methodTypeArgs.length === 0) {
            return `${classKey}::${methodName}`;
        }
        
        const typeArgStrings = methodTypeArgs.map(t => this.canonicalizeType(t));
        return `${classKey}::${methodName}<${typeArgStrings.join(',')}>`;
    }

    // ============================================================================
    // Function Instantiation Registration
    // ============================================================================

    /**
     * Registers a concrete instantiation of a generic function.
     * 
     * Called during type checking when a generic function is called with concrete type arguments.
     * For example, when seeing `sort<u32>(arr)`.
     * 
     * @param decl The generic function declaration
     * @param typeArgs Concrete type arguments
     * @returns Canonical key for this instantiation
     * 
     * @example
     * ```typescript
     * // When type checking: sort<u32>(numbers)
     * registry.registerFunctionInstantiation(sortDecl, [u32Type])
     * // Returns: "sort<u32>"
     * ```
     */
    registerFunctionInstantiation(
        decl: ast.FunctionDeclaration,
        typeArgs: readonly TypeDescription[]
    ): string {
        // Validate that this is actually a generic function
        if (!decl.genericParameters || decl.genericParameters.length === 0) {
            // Not a generic function - no need to register
            return decl.name;
        }

        const key = this.makeFunctionKey(decl, typeArgs);
        
        if (!this.functions.has(key)) {
            this.functions.set(key, {
                declaration: decl,
                typeArgs: [...typeArgs], // Create a copy
                key
            });
        }
        
        return key;
    }

    /**
     * Creates a canonical key for a function instantiation.
     * Format: functionName<Type1,Type2,...>
     */
    private makeFunctionKey(
        decl: ast.FunctionDeclaration,
        typeArgs: readonly TypeDescription[]
    ): string {
        const funcName = decl.name;
        
        if (typeArgs.length === 0) {
            return funcName;
        }
        
        const typeArgStrings = typeArgs.map(t => this.canonicalizeType(t));
        return `${funcName}<${typeArgStrings.join(',')}>`;
    }

    // ============================================================================
    // Retrieval Methods (for Code Generation)
    // ============================================================================

    /**
     * Returns all registered class instantiations.
     * Used during code generation to produce specialized class versions.
     */
    getAllClassInstantiations(): ClassInstantiation[] {
        return Array.from(this.classes.values());
    }

    /**
     * Returns all method instantiations for a specific class instantiation.
     * Used during code generation to produce specialized method versions.
     * 
     * @param classKey The class instantiation key
     * @returns Array of method instantiations for that class
     */
    getMethodInstantiations(classKey: string): MethodInstantiation[] {
        return Array.from(this.methods.values())
            .filter(m => m.classKey === classKey);
    }

    /**
     * Returns all registered function instantiations.
     * Used during code generation to produce specialized function versions.
     */
    getAllFunctionInstantiations(): FunctionInstantiation[] {
        return Array.from(this.functions.values());
    }

    /**
     * Gets a specific class instantiation by its key.
     */
    getClassInstantiation(key: string): ClassInstantiation | undefined {
        return this.classes.get(key);
    }

    /**
     * Gets a specific method instantiation by its key.
     */
    getMethodInstantiation(key: string): MethodInstantiation | undefined {
        return this.methods.get(key);
    }

    /**
     * Gets a specific function instantiation by its key.
     */
    getFunctionInstantiation(key: string): FunctionInstantiation | undefined {
        return this.functions.get(key);
    }

    /**
     * Checks if a class instantiation exists.
     */
    hasClassInstantiation(key: string): boolean {
        return this.classes.has(key);
    }

    /**
     * Returns statistics about registered instantiations.
     * Useful for debugging and analysis.
     */
    getStats(): {
        classCount: number;
        methodCount: number;
        functionCount: number;
    } {
        return {
            classCount: this.classes.size,
            methodCount: this.methods.size,
            functionCount: this.functions.size
        };
    }

    // ============================================================================
    // Helper Methods
    // ============================================================================

    /**
     * Converts a type to its canonical string representation.
     * This ensures consistent key generation regardless of how the type was created.
     * 
     * Uses toString() but could be enhanced with normalization rules if needed.
     */
    private canonicalizeType(type: TypeDescription): string {
        // For now, use toString() - it should provide consistent representation
        // Could enhance with additional normalization if needed (e.g., sorting fields in structs)
        return type.toString();
    }

    /**
     * Creates a mangled name for code generation.
     * Replaces special characters to produce valid identifiers.
     * 
     * @param key The instantiation key
     * @returns Mangled name suitable for code generation
     * 
     * @example
     * ```typescript
     * mangleName("Array<u32>") → "Array$u32"
     * mangleName("Result<i32,string>") → "Result$i32$string"
     * mangleName("Array<u32>::map<string>") → "Array$u32$map$string"
     * ```
     */
    mangleName(key: string): string {
        return key
            .replace(/</g, '$')
            .replace(/>/g, '')
            .replace(/,/g, '$')
            .replace(/::/g, '$')
            .replace(/\s+/g, ''); // Remove whitespace
    }
}