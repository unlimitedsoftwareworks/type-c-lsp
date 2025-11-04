import { AstNode, ValidationAcceptor, ValidationChecks } from "langium";
import * as ast from "../generated/ast.js";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCBaseValidation } from "./base-validation.js";
import { 
    TypeDescription, 
    TypeKind, 
    isFunctionType, 
    isClassType, 
    isStructType, 
    isReferenceType, 
    isInterfaceType,
    InterfaceTypeDescription,
    ClassTypeDescription,
    MethodType,
    ErrorTypeDescription
} from "../typing/type-c-types.js";

/**
 * Type system validator for Type-C.
 * 
 * Performs type checking to ensure:
 * - Variable declarations match their initializers
 * - Function arguments match parameter types
 * - Return statements match function return types
 * - Binary operations have compatible operand types
 */
export class TypeCTypeSystemValidator extends TypeCBaseValidation {
    private readonly typeProvider: TypeCTypeProvider;
    
    constructor(services: TypeCServices) {
        super();
        this.typeProvider = services.typing.TypeProvider;
    }

    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            VariableDeclSingle: this.checkVariableDeclSingle,
            BinaryExpression: this.checkBinaryExpression,
            FunctionCall: this.checkFunctionCall,
            ReturnStatement: this.checkReturnStatement,
            FunctionDeclaration: this.checkFunctionDeclaration,
        };
    }

    /**
     * Check variable declarations with explicit type annotations.
     * 
     * Examples:
     * - let x: u32 = 42      // ✅ OK
     * - let x: u32 = "hello" // ❌ Error: expected u32, got string
     * - let x = 42           // ✅ OK (no annotation, inferred)
     */
    checkVariableDeclSingle = (node: ast.VariableDeclSingle, accept: ValidationAcceptor): void => {
        // Only check if there's both an annotation AND an initializer
        if (!node.annotation || !node.initializer) {
            return;
        }

        let expectedType = this.typeProvider.getType(node.annotation);
        let inferredType = this.typeProvider.getType(node.initializer);

        // Resolve type references
        if (isReferenceType(expectedType)) {
            const resolved = this.typeProvider.resolveReference(expectedType);
            if (resolved) expectedType = resolved;
        }
        if (isReferenceType(inferredType)) {
            const resolved = this.typeProvider.resolveReference(inferredType);
            if (resolved) inferredType = resolved;
        }

        // Interface compatibility checking
        if (isInterfaceType(expectedType) && isClassType(inferredType)) {
            this.checkInterfaceCompatibility(inferredType, expectedType, node.initializer, accept);
            return;
        }

        // Check compatibility
        if (!this.isTypeCompatible(inferredType, expectedType)) {
            accept('error', `Type mismatch: expected '${expectedType.toString()}' but got '${inferredType.toString()}'`, {
                node: node.initializer,
                property: 'initializer',
            });
        }
    }

    /**
     * Check binary expressions for type compatibility.
     * 
     * Examples:
     * - 1 + 2           // ✅ OK (i32 + i32)
     * - 1 + 2.0         // ❌ Error (i32 + f64)
     * - x = "hello"     // ✅ OK if x is string
     */
    checkBinaryExpression = (node: ast.BinaryExpression, accept: ValidationAcceptor): void => {
        let leftType = this.typeProvider.getType(node.left);
        const rightType = this.typeProvider.getType(node.right);

        // Resolve references to check for class types
        if (isReferenceType(leftType)) {
            const resolved = this.typeProvider.resolveReference(leftType);
            if (resolved) leftType = resolved;
        }

        // Skip if operator might be overloaded (class type)
        // TODO: Check if the specific operator is actually overloaded
        if (isClassType(leftType)) {
            return;
        }

        // Assignment operators: right must be compatible with left
        const assignmentOps = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='];
        if (assignmentOps.includes(node.op)) {
            if (!this.isTypeCompatible(rightType, leftType)) {
                accept('error', `Cannot assign '${rightType.toString()}' to '${leftType.toString()}'`, {
                    node: node.right,
                });
            }
            return;
        }

        // Arithmetic operators: both sides must be numeric and compatible
        const arithmeticOps = ['+', '-', '*', '/', '%', '<<', '>>', '&', '|', '^'];
        if (arithmeticOps.includes(node.op)) {
            // Skip validation if either side is an error type (already reported or placeholder)
            if (leftType.kind === TypeKind.Error || rightType.kind === TypeKind.Error) {
                return;
            }
            
            if (!this.isNumericType(leftType) || !this.isNumericType(rightType)) {
                accept('error', `Operator '${node.op}' requires numeric operands`, {
                    node,
                });
            } else if (!this.isTypeCompatible(rightType, leftType)) {
                accept('error', `Type mismatch: cannot apply '${node.op}' to '${leftType.toString()}' and '${rightType.toString()}'`, {
                    node,
                });
            }
        }

        // Comparison operators: operands must be compatible
        const comparisonOps = ['==', '!=', '<', '>', '<=', '>='];
        if (comparisonOps.includes(node.op)) {
            if (!this.isTypeCompatible(rightType, leftType) && !this.isTypeCompatible(leftType, rightType)) {
                accept('warning', `Comparing incompatible types '${leftType.toString()}' and '${rightType.toString()}'`, {
                    node,
                });
            }
        }
    }

    /**
     * Check function call arguments against parameter types.
     */
    checkFunctionCall = (node: ast.FunctionCall, accept: ValidationAcceptor): void => {
        const fnType = this.typeProvider.getType(node.expr);
        
        if (!isFunctionType(fnType)) {
            // Not a function - let another validation handle this
            return;
        }

        const paramTypes = fnType.parameters;
        const args = node.args || [];

        // Check argument count
        if (args.length !== paramTypes.length) {
            accept('error', `Expected ${paramTypes.length} argument(s), but got ${args.length}`, {
                node,
            });
            return;
        }

        // Check each argument type
        args.forEach((arg, index) => {
            const expectedType = paramTypes[index].type;
            const actualType = this.typeProvider.getType(arg);

            if (!this.isTypeCompatible(actualType, expectedType)) {
                accept('error', `Argument ${index + 1}: expected '${expectedType.toString()}' but got '${actualType.toString()}'`, {
                    node: arg,
                });
            }
        });
    }

    /**
     * Check return statements against function return type.
     */
    checkReturnStatement = (node: ast.ReturnStatement, accept: ValidationAcceptor): void => {
        // Find the containing function
        let current: AstNode | undefined = node.$container;
        while (current && !ast.isFunctionDeclaration(current)) {
            current = current.$container;
        }

        if (!current || !ast.isFunctionDeclaration(current)) {
            return; // Not in a function
        }

        const fn: ast.FunctionDeclaration = current;
        if (!fn.header.returnType) {
            return; // No explicit return type
        }

        const expectedReturnType = this.typeProvider.getType(fn.header.returnType);

        if (node.expr) {
            const actualType = this.typeProvider.getType(node.expr);
            if (!this.isTypeCompatible(actualType, expectedReturnType)) {
                accept('error', `Return type mismatch: expected '${expectedReturnType.toString()}' but got '${actualType.toString()}'`, {
                    node: node.expr,
                });
            }
        } else {
            // Return with no value
            if (expectedReturnType.kind !== TypeKind.Void) {
                accept('error', `Function must return a value of type '${expectedReturnType.toString()}'`, {
                    node,
                });
            }
        }
    }

    /**
     * Check function declarations for return type issues.
     * 
     * Validates:
     * 1. If no explicit return type → ensure we can infer successfully (no error type)
     * 2. If explicit return type → ensure inferred type matches declared type
     * 
     * Examples:
     * ```
     * fn bad() = match n { 0 => 1, _ => "oops" }  // ❌ Can't infer common type
     * fn good() -> u32 = ...                       // ✅ Explicit type
     * fn good2() = 42                              // ✅ Can infer u32
     * ```
     */
    checkFunctionDeclaration = (node: ast.FunctionDeclaration, accept: ValidationAcceptor): void => {
        const fnType = this.typeProvider.getType(node);
        
        if (!isFunctionType(fnType)) {
            return; // Not a function type (shouldn't happen)
        }

        const inferredReturnType = fnType.returnType;
        
        // Check 1: If inferred return type is an error, report it
        if (inferredReturnType.kind === TypeKind.Error) {
            const errorType = inferredReturnType as ErrorTypeDescription;
            const message = errorType.message || 'Cannot infer return type';
            
            // Don't report recursion placeholder errors (they're handled during inference)
            if (message === '__recursion_placeholder__') {
                return;
            }
            
            // Highlight the entire function declaration for visibility
            accept('error', message, {
                node: node,
            });
            return;
        }

        // Check 2: If explicit return type, validate it matches inferred type
        if (node.header.returnType) {
            const declaredReturnType = this.typeProvider.getType(node.header.returnType);
            
            if (!this.isTypeCompatible(inferredReturnType, declaredReturnType)) {
                accept('error', 
                    `Function return type mismatch: declared '${declaredReturnType.toString()}' but inferred '${inferredReturnType.toString()}'`, 
                    {
                        node: node.header.returnType,
                    }
                );
            }
        }
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    /**
     * Check if a class implements all methods required by an interface.
     * 
     * Validates:
     * - All interface methods are present in the class
     * - Method signatures match (parameters and return type)
     * - Handles method overloading (multiple names per method)
     * 
     * Example:
     * ```
     * type Drawable = interface {
     *     fn draw() -> void
     * }
     * type Circle = class { ... }
     * let d: Drawable = new Circle()  // Check Circle implements draw()
     * ```
     */
    private checkInterfaceCompatibility(
        classType: ClassTypeDescription,
        interfaceType: InterfaceTypeDescription,
        node: AstNode,
        accept: ValidationAcceptor
    ): void {
        // Check each method required by the interface
        for (const requiredMethod of interfaceType.methods) {
            // Find a matching method in the class
            const matchingMethod = this.findMatchingMethod(classType.methods, requiredMethod);
            
            if (!matchingMethod) {
                // Method not found
                const methodName = requiredMethod.names[0] || '<unnamed>';
                accept('error', 
                    `Class '${classType.toString()}' does not implement interface method '${methodName}' from '${interfaceType.toString()}'`,
                    { node }
                );
                continue;
            }
            
            // Check method signature compatibility
            this.checkMethodSignatureCompatibility(matchingMethod, requiredMethod, node, accept);
        }
    }

    /**
     * Find a method in the class that matches one of the interface method's names.
     */
    private findMatchingMethod(
        classMethods: readonly MethodType[],
        interfaceMethod: MethodType
    ): MethodType | undefined {
        // Check if any class method has a name that matches any of the interface method's names
        return classMethods.find(classMethod =>
            classMethod.names.some(className =>
                interfaceMethod.names.some(interfaceName => className === interfaceName)
            )
        );
    }

    /**
     * Check if a class method's signature is compatible with the interface requirement.
     */
    private checkMethodSignatureCompatibility(
        classMethod: MethodType,
        interfaceMethod: MethodType,
        node: AstNode,
        accept: ValidationAcceptor
    ): void {
        const methodName = interfaceMethod.names[0] || '<unnamed>';
        
        // Check parameter count
        if (classMethod.parameters.length !== interfaceMethod.parameters.length) {
            accept('error',
                `Method '${methodName}' has wrong number of parameters: expected ${interfaceMethod.parameters.length}, got ${classMethod.parameters.length}`,
                { node }
            );
            return;
        }
        
        // Check each parameter type
        for (let i = 0; i < interfaceMethod.parameters.length; i++) {
            const classParam = classMethod.parameters[i];
            const interfaceParam = interfaceMethod.parameters[i];
            
            if (!this.isTypeCompatible(classParam.type, interfaceParam.type)) {
                accept('error',
                    `Method '${methodName}' parameter ${i + 1} '${interfaceParam.name}': expected '${interfaceParam.type.toString()}', got '${classParam.type.toString()}'`,
                    { node }
                );
            }
        }
        
        // Check return type
        if (!this.isTypeCompatible(classMethod.returnType, interfaceMethod.returnType)) {
            accept('error',
                `Method '${methodName}' has incompatible return type: expected '${interfaceMethod.returnType.toString()}', got '${classMethod.returnType.toString()}'`,
                { node }
            );
        }
    }

    /**
     * Check if a type is compatible with an expected type.
     * 
     * Handles:
     * - Simple type equality
     * - null assignable to nullable types
     * - Duck typing for structs (structural compatibility)
     * - Type aliases (references)
     * - **Implicit numeric type coercion** (safe conversions)
     */
    private isTypeCompatible(actual: TypeDescription, expected: TypeDescription): boolean {
        // Error types are always compatible (already reported)
        if (actual.kind === TypeKind.Error || expected.kind === TypeKind.Error) {
            return true;
        }

        // null is assignable to nullable types
        if (actual.kind === TypeKind.Null && expected.kind === TypeKind.Nullable) {
            return true;
        }

        // Resolve type references
        let actualResolved = actual;
        let expectedResolved = expected;
        
        if (isReferenceType(actual)) {
            const resolved = this.typeProvider.resolveReference(actual);
            if (resolved) actualResolved = resolved;
        }
        if (isReferenceType(expected)) {
            const resolved = this.typeProvider.resolveReference(expected);
            if (resolved) expectedResolved = resolved;
        }

        // Duck typing for structs: structural compatibility
        // A struct literal is compatible with a named struct if all fields match
        if (isStructType(actualResolved) && isStructType(expectedResolved)) {
            return this.areStructsCompatible(actualResolved, expectedResolved);
        }

        // Check for implicit numeric type coercion
        if (this.isNumericType(actualResolved) && this.isNumericType(expectedResolved)) {
            return this.canCoerceNumericType(actualResolved.kind, expectedResolved.kind);
        }

        // Simple equality check
        return actualResolved.toString() === expectedResolved.toString();
    }

    /**
     * Check if two struct types are structurally compatible (duck typing).
     * 
     * For now, uses simple string comparison of their structure.
     * TODO: Implement proper field-by-field comparison
     */
    private areStructsCompatible(actual: TypeDescription, expected: TypeDescription): boolean {
        // For now, compare string representations
        // This handles both named structs and anonymous struct literals
        return actual.toString() === expected.toString();
    }

    /**
     * Check if a type is numeric (integer or float).
     */
    private isNumericType(type: TypeDescription): boolean {
        const numericKinds = [
            TypeKind.U8, TypeKind.U16, TypeKind.U32, TypeKind.U64,
            TypeKind.I8, TypeKind.I16, TypeKind.I32, TypeKind.I64,
            TypeKind.F32, TypeKind.F64
        ];
        return numericKinds.includes(type.kind);
    }

    /**
     * Check if a numeric type can be implicitly coerced to another numeric type.
     * 
     * Safe conversions allowed:
     * 1. **Exact match** - always safe
     * 2. **Widening integer conversions** - no precision loss
     *    - u8 → u16 → u32 → u64
     *    - i8 → i16 → i32 → i64
     *    - u8 → i16, u16 → i32, u32 → i64 (unsigned to larger signed)
     * 3. **Integer to float** - safe for reasonable values
     *    - Any integer → f32, f64
     * 4. **Float widening** - no precision loss
     *    - f32 → f64
     * 
     * Examples:
     * - i32 → f32 ✅ (safe)
     * - f64 → f32 ❌ (narrowing, potential precision loss)
     * - i64 → i32 ❌ (narrowing, potential overflow)
     * - u32 → i32 ❌ (signed/unsigned mismatch without widening)
     */
    private canCoerceNumericType(from: TypeKind, to: TypeKind): boolean {
        // Exact match
        if (from === to) {
            return true;
        }

        // Any integer → any float (safe, common use case)
        const integerTypes = [
            TypeKind.U8, TypeKind.U16, TypeKind.U32, TypeKind.U64,
            TypeKind.I8, TypeKind.I16, TypeKind.I32, TypeKind.I64
        ];
        const floatTypes = [TypeKind.F32, TypeKind.F64];
        
        if (integerTypes.includes(from) && floatTypes.includes(to)) {
            return true; // int → float always allowed
        }

        // Float widening: f32 → f64
        if (from === TypeKind.F32 && to === TypeKind.F64) {
            return true;
        }

        // Unsigned integer widening
        const unsignedHierarchy = [TypeKind.U8, TypeKind.U16, TypeKind.U32, TypeKind.U64];
        const fromUnsignedIdx = unsignedHierarchy.indexOf(from);
        const toUnsignedIdx = unsignedHierarchy.indexOf(to);
        if (fromUnsignedIdx !== -1 && toUnsignedIdx !== -1 && fromUnsignedIdx < toUnsignedIdx) {
            return true; // u8 → u16 → u32 → u64
        }

        // Signed integer widening
        const signedHierarchy = [TypeKind.I8, TypeKind.I16, TypeKind.I32, TypeKind.I64];
        const fromSignedIdx = signedHierarchy.indexOf(from);
        const toSignedIdx = signedHierarchy.indexOf(to);
        if (fromSignedIdx !== -1 && toSignedIdx !== -1 && fromSignedIdx < toSignedIdx) {
            return true; // i8 → i16 → i32 → i64
        }

        // Unsigned to larger signed (safe: value always fits)
        if (from === TypeKind.U8 && (to === TypeKind.I16 || to === TypeKind.I32 || to === TypeKind.I64)) {
            return true;
        }
        if (from === TypeKind.U16 && (to === TypeKind.I32 || to === TypeKind.I64)) {
            return true;
        }
        if (from === TypeKind.U32 && to === TypeKind.I64) {
            return true;
        }

        // Signed to larger unsigned (widening with wraparound for negatives)
        // This is pragmatic - literals like 0, 255 are common and safe
        if (from === TypeKind.I8 && (to === TypeKind.U16 || to === TypeKind.U32 || to === TypeKind.U64)) {
            return true;
        }
        if (from === TypeKind.I16 && (to === TypeKind.U32 || to === TypeKind.U64)) {
            return true;
        }
        if (from === TypeKind.I32 && to === TypeKind.U64) {
            return true;
        }

        // No other conversions are safe
        return false;
    }
}