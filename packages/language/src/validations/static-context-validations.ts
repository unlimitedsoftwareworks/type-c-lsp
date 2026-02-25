import { AstNode, AstUtils, ValidationAcceptor, ValidationChecks } from "langium";
import { ErrorCode } from "../codes/errors.js";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypedValidation } from "./typed-base-validation.js";

/**
 * Static context validator for Type-C.
 *
 * Validates that static methods, static blocks, and static attributes
 * do not incorrectly reference instance-level constructs:
 * - `this` cannot be used in static methods or static blocks
 * - Instance members cannot be accessed in static contexts
 * - Static attributes/methods cannot use class template parameters
 */
export class TypeCStaticContextValidator extends TypeCTypedValidation {
    constructor(services: TypeCServices) {
        super(services);
    }

    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            ThisExpression: this.checkThisInStaticContext,
            ClassAttributeDecl: this.checkStaticAttributeTemplateUsage,
            ClassMethod: this.checkStaticMethodTemplateUsage,
            QualifiedReference: this.checkInstanceMemberInStaticContext,
        };
    }

    /**
     * Check that static attributes don't use class template parameters.
     *
     * Static members exist at the class level, not per instance, so they cannot
     * depend on instance-specific type parameters. For example:
     *
     * ```tc
     * class C<T> {
     *     static let instance: T  // ❌ Error: static cannot use template T
     *     let value: T            // ✅ OK: non-static can use template T
     * }
     * ```
     *
     * However, static methods can have their own generic parameters:
     * ```tc
     * class C<T> {
     *     static fn get<U>(x: U) -> U { ... }  // ✅ OK: U is method's own generic
     * }
     * ```
     */
    checkStaticAttributeTemplateUsage = (node: ast.ClassAttributeDecl, accept: ValidationAcceptor): void => {
        // Only check static attributes
        if (!node.isStatic) {
            return;
        }

        // Get the containing class to access its generic parameters
        const classNode = AstUtils.getContainerOfType(node, ast.isClassType);
        if (!classNode) {
            return;
        }

        // Get the class's generic parameters (from the parent type declaration)
        const typeDecl = classNode.$container;
        if (!ast.isTypeDeclaration(typeDecl) || !typeDecl.genericParameters || typeDecl.genericParameters.length === 0) {
            return; // No class templates to check
        }

        // Get the class template parameter names
        const classTemplateNames = new Set(typeDecl.genericParameters.map(p => p.name));

        // Check if the attribute type uses any class template parameter
        if (node.type) {
            const usedTemplates = this.findUsedTemplates(node.type, classTemplateNames);
            if (usedTemplates.size > 0) {
                const templateList = Array.from(usedTemplates).join(', ');
                accept('error',
                    `Static attribute '${node.name}' cannot use class template parameter(s): ${templateList}. ` +
                    `Static members exist at the class level and cannot depend on instance-specific type parameters.`,
                    {
                        node: node.type,
                        code: ErrorCode.TC_STATIC_ATTRIBUTE_USES_CLASS_TEMPLATE
                    }
                );
            }
        }
    }

    /**
     * Check that static methods don't use class template parameters.
     *
     * Static methods exist at the class level, not per instance, so their parameters,
     * return types, and method bodies cannot depend on instance-specific type parameters.
     *
     * ```tc
     * class C<T> {
     *     static fn bad(x: T) -> T { ... }     // ❌ Error: uses class template T
     *     static fn bad2() { let x: T }        // ❌ Error: body uses class template T
     *     static fn good<T>(x: T) -> T { ... } // ✅ OK: T is method's own generic
     *     fn instance(x: T) -> T { ... }       // ✅ OK: non-static can use class T
     * }
     * ```
     */
    checkStaticMethodTemplateUsage = (node: ast.ClassMethod, accept: ValidationAcceptor): void => {
        // Only check static methods
        if (!node.isStatic) {
            return;
        }

        // Get the containing class to access its generic parameters
        const classNode = AstUtils.getContainerOfType(node, ast.isClassType);
        if (!classNode) {
            return;
        }

        // Get the class's generic parameters (from the parent type declaration)
        const typeDecl = classNode.$container;
        if (!ast.isTypeDeclaration(typeDecl) || !typeDecl.genericParameters || typeDecl.genericParameters.length === 0) {
            return; // No class templates to check
        }

        // Get the class template parameter names
        const classTemplateNames = new Set(typeDecl.genericParameters.map(p => p.name));

        // Get the method's own generic parameters (which are allowed)
        const methodGenerics = node.method?.genericParameters || [];
        const methodTemplateNames = new Set(methodGenerics.map(p => p.name));

        // Check parameter types
        const header = node.method?.header;
        if (header && header.args) {
            for (const param of header.args) {
                if (param.type) {
                    const usedTemplates = this.findUsedTemplates(param.type, classTemplateNames, methodTemplateNames);
                    if (usedTemplates.size > 0) {
                        const templateList = Array.from(usedTemplates).join(', ');
                        accept('error',
                            `Static method parameter '${param.name}' cannot use class template parameter(s): ${templateList}. ` +
                            `Static methods exist at the class level and cannot depend on instance-specific type parameters. ` +
                            `If you need generics, add them to the method itself: fn static methodName<T>(...).`,
                            {
                                node: param.type,
                                code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE
                            }
                        );
                    }
                }
            }
        }

        // Check return type
        if (header && header.returnType) {
            const usedTemplates = this.findUsedTemplates(header.returnType, classTemplateNames, methodTemplateNames);
            if (usedTemplates.size > 0) {
                const templateList = Array.from(usedTemplates).join(', ');
                accept('error',
                    `Static method return type cannot use class template parameter(s): ${templateList}. ` +
                    `Static methods exist at the class level and cannot depend on instance-specific type parameters. ` +
                    `If you need generics, add them to the method itself: fn static methodName<T>(...) -> T.`,
                    {
                        node: header.returnType,
                        code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE
                    }
                );
            }
        }

        // Check method body for class template usage
        if (node.body) {
            this.checkStaticMethodBodyForTemplates(node.body, classTemplateNames, methodTemplateNames, accept);
        }
    }

    /**
     * Recursively check a static method body for class template parameter usage.
     *
     * This catches cases like:
     * ```tc
     * static fn wrap() {
     *     let x: T = ...  // ❌ Error: using class template T in body
     * }
     * ```
     */
    private checkStaticMethodBodyForTemplates(
        body: ast.BlockStatement,
        classTemplates: Set<string>,
        methodTemplates: Set<string>,
        accept: ValidationAcceptor
    ): void {
        // Helper to check all type annotations in the AST
        const checkNode = (node: AstNode): void => {
            // Check variable declarations with type annotations
            if (ast.isVariableDeclSingle(node) && node.annotation) {
                const usedTemplates = this.findUsedTemplates(node.annotation, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `Variable '${node.name}' in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        {
                            node: node.annotation,
                            code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE
                        }
                    );
                }
            }

            // Check array destructuring with type annotations
            if (ast.isVariableDeclArrayDestructuring(node) && node.annotation) {
                const usedTemplates = this.findUsedTemplates(node.annotation, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `Array destructuring in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        {
                            node: node.annotation,
                            code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE
                        }
                    );
                }
            }

            // Check struct destructuring with type annotations
            if (ast.isVariableDeclStructDestructuring(node) && node.annotation) {
                const usedTemplates = this.findUsedTemplates(node.annotation, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `Struct destructuring in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        {
                            node: node.annotation,
                            code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE
                        }
                    );
                }
            }

            // Check tuple destructuring with type annotations
            if (ast.isVariableDeclTupleDestructuring(node) && node.annotation) {
                const usedTemplates = this.findUsedTemplates(node.annotation, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `Tuple destructuring in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        {
                            node: node.annotation,
                            code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE
                        }
                    );
                }
            }

            // Check type cast expressions
            if (ast.isTypeCastExpression(node)) {
                const usedTemplates = this.findUsedTemplates(node.destType, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `Type cast in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        {
                            node: node.destType,
                            code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE
                        }
                    );
                }
            }

            // Check instance check expressions (is operator)
            if (ast.isInstanceCheckExpression(node)) {
                const usedTemplates = this.findUsedTemplates(node.destType, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `Instance check in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        {
                            node: node.destType,
                            code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE
                        }
                    );
                }
            }

            // Check new expressions with explicit type
            if (ast.isNewExpression(node) && node.instanceType) {
                const usedTemplates = this.findUsedTemplates(node.instanceType, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `New expression in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        {
                            node: node.instanceType,
                            code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE
                        }
                    );
                }
            }

            // Check lambda expressions with explicit types
            if (ast.isLambdaExpression(node)) {
                const header = node.header;
                // Check lambda parameter types
                if (header && header.args) {
                    for (const param of header.args) {
                        if (param.type) {
                            const usedTemplates = this.findUsedTemplates(param.type, classTemplates, methodTemplates);
                            if (usedTemplates.size > 0) {
                                const templateList = Array.from(usedTemplates).join(', ');
                                accept('error',
                                    `Lambda parameter in static method cannot use class template parameter(s): ${templateList}. ` +
                                    `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                                    {
                                        node: param.type,
                                        code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE
                                    }
                                );
                            }
                        }
                    }
                }
                // Check lambda return type
                if (header && header.returnType) {
                    const usedTemplates = this.findUsedTemplates(header.returnType, classTemplates, methodTemplates);
                    if (usedTemplates.size > 0) {
                        const templateList = Array.from(usedTemplates).join(', ');
                        accept('error',
                            `Lambda return type in static method cannot use class template parameter(s): ${templateList}. ` +
                            `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                            {
                                node: header.returnType,
                                code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE
                            }
                        );
                    }
                }
            }

            // Check foreach iterators with explicit type
            if (ast.isForRangeIterator(node) && node.iterType) {
                const usedTemplates = this.findUsedTemplates(node.iterType, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `Iterator type in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        {
                            node: node.iterType,
                            code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE
                        }
                    );
                }
            }

            // Recursively check all children
            for (const child of AstUtils.streamContents(node)) {
                checkNode(child);
            }
        };

        // Start checking from the body
        for (const stmt of body.statements || []) {
            checkNode(stmt);
        }
    }

    /**
     * Helper method to find which class template parameters are used in a type.
     * Recursively checks the type structure to find any references to class templates.
     *
     * @param typeNode The type AST node to check
     * @param classTemplates Set of class template parameter names
     * @param methodTemplates Optional set of method template parameter names (allowed in static methods)
     * @returns Set of class template names that are used
     */
    private findUsedTemplates(
        typeNode: ast.DataType,
        classTemplates: Set<string>,
        methodTemplates?: Set<string>
    ): Set<string> {
        const usedTemplates = new Set<string>();

        const checkType = (node: ast.DataType): void => {
            // Check reference types (could be a template reference)
            if (ast.isReferenceType(node)) {
                const refName = node.field?.$refText;
                if (refName && classTemplates.has(refName)) {
                    // If methodTemplates is provided and contains this name, it's allowed (method's own generic)
                    if (!methodTemplates || !methodTemplates.has(refName)) {
                        usedTemplates.add(refName);
                    }
                }

                // Check generic arguments recursively
                if (node.genericArgs) {
                    for (const arg of node.genericArgs) {
                        checkType(arg);
                    }
                }
            }
            // Check array types
            else if (ast.isArrayType(node)) {
                checkType(node.arrayOf);
            }
            // Check nullable types
            else if (ast.isNullableType(node)) {
                checkType(node.baseType);
            }
            // Check union types
            else if (ast.isUnionType(node)) {
                checkType(node.left);
                checkType(node.right);
            }
            // Check join types (intersection)
            else if (ast.isJoinType(node)) {
                checkType(node.left);
                checkType(node.right);
            }
            // Check tuple types
            else if (ast.isTupleType(node)) {
                for (const elemType of node.types) {
                    checkType(elemType);
                }
            }
            // Check struct types
            else if (ast.isStructType(node)) {
                for (const field of node.fields) {
                    checkType(field.type);
                }
            }
            // Check function types
            else if (ast.isFunctionType(node)) {
                const header = node.header;
                if (ast.isFunctionHeader(header)) {
                    // Check parameter types
                    for (const param of header.args || []) {
                        if (param.type) {
                            checkType(param.type);
                        }
                    }
                    // Check return type
                    if (header.returnType) {
                        checkType(header.returnType);
                    }
                } else if (ast.isFunctionTypeHeader(header)) {
                    // Check parameter types
                    for (const param of header.args || []) {
                        checkType(param.type);
                    }
                    // Check return type
                    if (header.returnType) {
                        checkType(header.returnType);
                    }
                }
            }
            // Check variant types
            else if (ast.isVariantType(node)) {
                for (const constructor of node.constructors) {
                    if (constructor.params) {
                        for (const param of constructor.params) {
                            checkType(param.type);
                        }
                    }
                }
            }
            // Check interface types
            else if (ast.isInterfaceType(node)) {
                for (const method of node.methods) {
                    const methodHeader = method.header;
                    // Check parameter types
                    for (const param of methodHeader.args || []) {
                        if (param.type) {
                            checkType(param.type);
                        }
                    }
                    // Check return type
                    if (methodHeader.returnType) {
                        checkType(methodHeader.returnType);
                    }
                }
            }
        };

        checkType(typeNode);
        return usedTemplates;
    }

    /**
     * Check that `this` is not used in static contexts (static methods or static blocks).
     *
     * The `this` keyword refers to the current instance, so it cannot be used in static
     * contexts which don't have access to an instance.
     *
     * Examples:
     * ```tc
     * class C {
     *     let value: u32
     *
     *     static fn bad() {
     *         let x = this.value  // ❌ Error: `this` in static method
     *     }
     *
     *     fn good() {
     *         let x = this.value  // ✅ OK: `this` in instance method
     *     }
     *
     *     static {
     *         let x = this.value  // ❌ Error: `this` in static block
     *     }
     * }
     * ```
     */
    checkThisInStaticContext = (node: ast.ThisExpression, accept: ValidationAcceptor): void => {
        // Check if we're in a static method
        const staticMethod = this.getContainingStaticMethod(node);
        if (staticMethod) {
            accept('error',
                `Cannot use 'this' in static method. Static methods exist at the class level and don't have access to instance members.`,
                {
                    node,
                    code: ErrorCode.TC_STATIC_CONTEXT_INSTANCE_MEMBER_ACCESS
                }
            );
            return;
        }

        // Check if we're in a static block
        const staticBlock = this.getContainingStaticBlock(node);
        if (staticBlock) {
            accept('error',
                `Cannot use 'this' in static block. Static blocks execute at class initialization and don't have access to instance members.`,
                {
                    node,
                    code: ErrorCode.TC_STATIC_BLOCK_INSTANCE_MEMBER_ACCESS
                }
            );
        }
    }

    /**
     * Check that instance members are not accessed in static contexts.
     *
     * Static methods and blocks cannot access instance attributes or non-static methods
     * because they don't have an instance to work with.
     *
     * Examples:
     * ```tc
     * class C<T> {
     *     let property: T
     *     let static instance: C<u32>
     *
     *     static fn wrap() {
     *         let c = property           // ❌ Error: accessing instance attribute
     *         let c2 = this.property     // ❌ Error: using `this`
     *         let c3 = C.instance        // ✅ OK: accessing static attribute
     *     }
     *
     *     static {
     *         this.property = ...        // ❌ Error: accessing instance via `this`
     *         C.instance.property = ...  // ✅ OK: accessing via instance reference
     *     }
     * }
     * ```
     */
    checkInstanceMemberInStaticContext = (node: ast.QualifiedReference, accept: ValidationAcceptor): void => {
        const ref = node.reference?.ref;
        if (!ref) {
            return; // Unresolved reference, will be caught elsewhere
        }

        // Check if we're accessing a class attribute or method
        const isInstanceMember = (ast.isClassAttributeDecl(ref) && !ref.isStatic) ||
                                 (ast.isClassMethod(ref) && !ref.isStatic);

        if (!isInstanceMember) {
            return; // Not an instance member, no validation needed
        }

        // Check if we're in a static method
        const staticMethod = this.getContainingStaticMethod(node);
        if (staticMethod) {
            const memberName = ast.isClassAttributeDecl(ref) ? ref.name :
                              ast.isClassMethod(ref) ? (ref.method?.names[0] || 'method') : 'member';
            const memberKind = ast.isClassAttributeDecl(ref) ? 'attribute' : 'method';

            accept('error',
                `Cannot access instance ${memberKind} '${memberName}' in static method. ` +
                `Static methods exist at the class level and don't have access to instance members. ` +
                `Use 'ClassName.${memberName}' if it's a static member, or access it through an instance.`,
                {
                    node,
                    property: 'reference',
                    code: ErrorCode.TC_STATIC_CONTEXT_INSTANCE_MEMBER_ACCESS
                }
            );
            return;
        }

        // Check if we're in a static block
        const staticBlock = this.getContainingStaticBlock(node);
        if (staticBlock) {
            const memberName = ast.isClassAttributeDecl(ref) ? ref.name :
                              ast.isClassMethod(ref) ? (ref.method?.names[0] || 'method') : 'member';
            const memberKind = ast.isClassAttributeDecl(ref) ? 'attribute' : 'method';

            accept('error',
                `Cannot access instance ${memberKind} '${memberName}' in static block. ` +
                `Static blocks execute at class initialization and don't have access to instance members. ` +
                `Access it through an instance reference instead.`,
                {
                    node,
                    property: 'reference',
                    code: ErrorCode.TC_STATIC_BLOCK_INSTANCE_MEMBER_ACCESS
                }
            );
        }
    }

    /**
     * Helper method to check if a node is contained within a static method.
     *
     * @param node The AST node to check
     * @returns The static method if found, undefined otherwise
     */
    private getContainingStaticMethod(node: AstNode): ast.ClassMethod | undefined {
        let current: AstNode | undefined = node.$container;

        while (current) {
            // Check if we're in a class method
            if (ast.isClassMethod(current)) {
                // Check if it's static
                if (current.isStatic) {
                    return current;
                }
                // If we hit a non-static method, we're not in a static context
                return undefined;
            }

            // Stop if we hit a class boundary (don't traverse into nested classes)
            if (ast.isClassType(current)) {
                return undefined;
            }

            current = current.$container;
        }

        return undefined;
    }

    /**
     * Helper method to check if a node is contained within a static block.
     *
     * @param node The AST node to check
     * @returns The static block if found, undefined otherwise
     */
    private getContainingStaticBlock(node: AstNode): ast.BlockStatement | undefined {
        let current: AstNode | undefined = node.$container;

        while (current) {
            // Check if we're in a block statement
            if (ast.isBlockStatement(current)) {
                // Check if the parent is a ClassType (static block is a direct child of ClassType)
                const parent = current.$container;
                if (ast.isClassType(parent)) {
                    // Check if this block is in the staticBlock array
                    if (parent.staticBlock && parent.staticBlock.includes(current)) {
                        return current;
                    }
                }
            }

            // Stop if we hit a method (static or not)
            if (ast.isClassMethod(current)) {
                return undefined;
            }

            // Stop if we hit a class boundary
            if (ast.isClassType(current)) {
                return undefined;
            }

            current = current.$container;
        }

        return undefined;
    }
}
