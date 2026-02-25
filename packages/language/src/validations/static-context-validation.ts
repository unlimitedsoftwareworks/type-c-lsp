import { AstNode, AstUtils, ValidationAcceptor, ValidationChecks } from "langium";
import { ErrorCode } from "../codes/errors.js";
import * as ast from "../generated/ast.js";
import { TypeCBaseValidation } from "./base-validation.js";

/**
 * Static context validator for Type-C.
 *
 * Validates that static methods, static blocks, and static attributes
 * do not incorrectly reference instance-level constructs:
 * - `this` cannot be used in static methods or static blocks
 * - Instance members cannot be accessed in static contexts
 * - Static attributes/methods cannot use class template parameters
 *
 * This is a purely structural validator (0 getType calls).
 */
export class TypeCStaticContextValidator extends TypeCBaseValidation {
    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            ThisExpression: this.checkThisInStaticContext,
            ClassAttributeDecl: this.checkStaticAttributeTemplateUsage,
            ClassMethod: this.checkStaticMethodTemplateUsage,
            QualifiedReference: this.checkInstanceMemberInStaticContext,
        };
    }

    checkStaticAttributeTemplateUsage = (node: ast.ClassAttributeDecl, accept: ValidationAcceptor): void => {
        if (!node.isStatic) return;

        const classNode = AstUtils.getContainerOfType(node, ast.isClassType);
        if (!classNode) return;

        const typeDecl = classNode.$container;
        if (!ast.isTypeDeclaration(typeDecl) || !typeDecl.genericParameters || typeDecl.genericParameters.length === 0) return;

        const classTemplateNames = new Set(typeDecl.genericParameters.map(p => p.name));

        if (node.type) {
            const usedTemplates = this.findUsedTemplates(node.type, classTemplateNames);
            if (usedTemplates.size > 0) {
                const templateList = Array.from(usedTemplates).join(', ');
                accept('error',
                    `Static attribute '${node.name}' cannot use class template parameter(s): ${templateList}. ` +
                    `Static members exist at the class level and cannot depend on instance-specific type parameters.`,
                    { node: node.type, code: ErrorCode.TC_STATIC_ATTRIBUTE_USES_CLASS_TEMPLATE }
                );
            }
        }
    }

    checkStaticMethodTemplateUsage = (node: ast.ClassMethod, accept: ValidationAcceptor): void => {
        if (!node.isStatic) return;

        const classNode = AstUtils.getContainerOfType(node, ast.isClassType);
        if (!classNode) return;

        const typeDecl = classNode.$container;
        if (!ast.isTypeDeclaration(typeDecl) || !typeDecl.genericParameters || typeDecl.genericParameters.length === 0) return;

        const classTemplateNames = new Set(typeDecl.genericParameters.map(p => p.name));
        const methodGenerics = node.method?.genericParameters || [];
        const methodTemplateNames = new Set(methodGenerics.map(p => p.name));

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
                            { node: param.type, code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE }
                        );
                    }
                }
            }
        }

        if (header && header.returnType) {
            const usedTemplates = this.findUsedTemplates(header.returnType, classTemplateNames, methodTemplateNames);
            if (usedTemplates.size > 0) {
                const templateList = Array.from(usedTemplates).join(', ');
                accept('error',
                    `Static method return type cannot use class template parameter(s): ${templateList}. ` +
                    `Static methods exist at the class level and cannot depend on instance-specific type parameters. ` +
                    `If you need generics, add them to the method itself: fn static methodName<T>(...) -> T.`,
                    { node: header.returnType, code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE }
                );
            }
        }

        if (node.body) {
            this.checkStaticMethodBodyForTemplates(node.body, classTemplateNames, methodTemplateNames, accept);
        }
    }

    private checkStaticMethodBodyForTemplates(
        body: ast.BlockStatement,
        classTemplates: Set<string>,
        methodTemplates: Set<string>,
        accept: ValidationAcceptor
    ): void {
        const checkNode = (node: AstNode): void => {
            if (ast.isVariableDeclSingle(node) && node.annotation) {
                const usedTemplates = this.findUsedTemplates(node.annotation, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `Variable '${node.name}' in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        { node: node.annotation, code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE }
                    );
                }
            }

            if (ast.isVariableDeclArrayDestructuring(node) && node.annotation) {
                const usedTemplates = this.findUsedTemplates(node.annotation, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `Array destructuring in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        { node: node.annotation, code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE }
                    );
                }
            }

            if (ast.isVariableDeclStructDestructuring(node) && node.annotation) {
                const usedTemplates = this.findUsedTemplates(node.annotation, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `Struct destructuring in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        { node: node.annotation, code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE }
                    );
                }
            }

            if (ast.isVariableDeclTupleDestructuring(node) && node.annotation) {
                const usedTemplates = this.findUsedTemplates(node.annotation, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `Tuple destructuring in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        { node: node.annotation, code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE }
                    );
                }
            }

            if (ast.isTypeCastExpression(node)) {
                const usedTemplates = this.findUsedTemplates(node.destType, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `Type cast in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        { node: node.destType, code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE }
                    );
                }
            }

            if (ast.isInstanceCheckExpression(node)) {
                const usedTemplates = this.findUsedTemplates(node.destType, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `Instance check in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        { node: node.destType, code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE }
                    );
                }
            }

            if (ast.isNewExpression(node) && node.instanceType) {
                const usedTemplates = this.findUsedTemplates(node.instanceType, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `New expression in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        { node: node.instanceType, code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE }
                    );
                }
            }

            if (ast.isLambdaExpression(node)) {
                const header = node.header;
                if (header && header.args) {
                    for (const param of header.args) {
                        if (param.type) {
                            const usedTemplates = this.findUsedTemplates(param.type, classTemplates, methodTemplates);
                            if (usedTemplates.size > 0) {
                                const templateList = Array.from(usedTemplates).join(', ');
                                accept('error',
                                    `Lambda parameter in static method cannot use class template parameter(s): ${templateList}. ` +
                                    `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                                    { node: param.type, code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE }
                                );
                            }
                        }
                    }
                }
                if (header && header.returnType) {
                    const usedTemplates = this.findUsedTemplates(header.returnType, classTemplates, methodTemplates);
                    if (usedTemplates.size > 0) {
                        const templateList = Array.from(usedTemplates).join(', ');
                        accept('error',
                            `Lambda return type in static method cannot use class template parameter(s): ${templateList}. ` +
                            `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                            { node: header.returnType, code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE }
                        );
                    }
                }
            }

            if (ast.isForRangeIterator(node) && node.iterType) {
                const usedTemplates = this.findUsedTemplates(node.iterType, classTemplates, methodTemplates);
                if (usedTemplates.size > 0) {
                    const templateList = Array.from(usedTemplates).join(', ');
                    accept('error',
                        `Iterator type in static method cannot use class template parameter(s): ${templateList}. ` +
                        `Static methods exist at the class level and cannot depend on instance-specific type parameters.`,
                        { node: node.iterType, code: ErrorCode.TC_STATIC_METHOD_USES_CLASS_TEMPLATE }
                    );
                }
            }

            for (const child of AstUtils.streamContents(node)) {
                checkNode(child);
            }
        };

        for (const stmt of body.statements || []) {
            checkNode(stmt);
        }
    }

    private findUsedTemplates(
        typeNode: ast.DataType,
        classTemplates: Set<string>,
        methodTemplates?: Set<string>
    ): Set<string> {
        const usedTemplates = new Set<string>();

        const checkType = (node: ast.DataType): void => {
            if (ast.isReferenceType(node)) {
                const refName = node.field?.$refText;
                if (refName && classTemplates.has(refName)) {
                    if (!methodTemplates || !methodTemplates.has(refName)) {
                        usedTemplates.add(refName);
                    }
                }
                if (node.genericArgs) {
                    for (const arg of node.genericArgs) {
                        checkType(arg);
                    }
                }
            } else if (ast.isArrayType(node)) {
                checkType(node.arrayOf);
            } else if (ast.isNullableType(node)) {
                checkType(node.baseType);
            } else if (ast.isUnionType(node)) {
                checkType(node.left);
                checkType(node.right);
            } else if (ast.isJoinType(node)) {
                checkType(node.left);
                checkType(node.right);
            } else if (ast.isTupleType(node)) {
                for (const elemType of node.types) {
                    checkType(elemType);
                }
            } else if (ast.isStructType(node)) {
                for (const field of node.fields) {
                    checkType(field.type);
                }
            } else if (ast.isFunctionType(node)) {
                const header = node.header;
                if (ast.isFunctionHeader(header)) {
                    for (const param of header.args || []) {
                        if (param.type) checkType(param.type);
                    }
                    if (header.returnType) checkType(header.returnType);
                } else if (ast.isFunctionTypeHeader(header)) {
                    for (const param of header.args || []) {
                        checkType(param.type);
                    }
                    if (header.returnType) checkType(header.returnType);
                }
            } else if (ast.isVariantType(node)) {
                for (const constructor of node.constructors) {
                    if (constructor.params) {
                        for (const param of constructor.params) {
                            checkType(param.type);
                        }
                    }
                }
            } else if (ast.isInterfaceType(node)) {
                for (const method of node.methods) {
                    const methodHeader = method.header;
                    for (const param of methodHeader.args || []) {
                        if (param.type) checkType(param.type);
                    }
                    if (methodHeader.returnType) checkType(methodHeader.returnType);
                }
            }
        };

        checkType(typeNode);
        return usedTemplates;
    }

    checkThisInStaticContext = (node: ast.ThisExpression, accept: ValidationAcceptor): void => {
        const staticMethod = this.getContainingStaticMethod(node);
        if (staticMethod) {
            accept('error',
                `Cannot use 'this' in static method. Static methods exist at the class level and don't have access to instance members.`,
                { node, code: ErrorCode.TC_STATIC_CONTEXT_INSTANCE_MEMBER_ACCESS }
            );
            return;
        }

        const staticBlock = this.getContainingStaticBlock(node);
        if (staticBlock) {
            accept('error',
                `Cannot use 'this' in static block. Static blocks execute at class initialization and don't have access to instance members.`,
                { node, code: ErrorCode.TC_STATIC_BLOCK_INSTANCE_MEMBER_ACCESS }
            );
        }
    }

    checkInstanceMemberInStaticContext = (node: ast.QualifiedReference, accept: ValidationAcceptor): void => {
        const ref = node.reference?.ref;
        if (!ref) return;

        const isInstanceMember = (ast.isClassAttributeDecl(ref) && !ref.isStatic) ||
                                 (ast.isClassMethod(ref) && !ref.isStatic);
        if (!isInstanceMember) return;

        const staticMethod = this.getContainingStaticMethod(node);
        if (staticMethod) {
            const memberName = ast.isClassAttributeDecl(ref) ? ref.name :
                              ast.isClassMethod(ref) ? (ref.method?.names[0] || 'method') : 'member';
            const memberKind = ast.isClassAttributeDecl(ref) ? 'attribute' : 'method';

            accept('error',
                `Cannot access instance ${memberKind} '${memberName}' in static method. ` +
                `Static methods exist at the class level and don't have access to instance members. ` +
                `Use 'ClassName.${memberName}' if it's a static member, or access it through an instance.`,
                { node, property: 'reference', code: ErrorCode.TC_STATIC_CONTEXT_INSTANCE_MEMBER_ACCESS }
            );
            return;
        }

        const staticBlock = this.getContainingStaticBlock(node);
        if (staticBlock) {
            const memberName = ast.isClassAttributeDecl(ref) ? ref.name :
                              ast.isClassMethod(ref) ? (ref.method?.names[0] || 'method') : 'member';
            const memberKind = ast.isClassAttributeDecl(ref) ? 'attribute' : 'method';

            accept('error',
                `Cannot access instance ${memberKind} '${memberName}' in static block. ` +
                `Static blocks execute at class initialization and don't have access to instance members. ` +
                `Access it through an instance reference instead.`,
                { node, property: 'reference', code: ErrorCode.TC_STATIC_BLOCK_INSTANCE_MEMBER_ACCESS }
            );
        }
    }

    private getContainingStaticMethod(node: AstNode): ast.ClassMethod | undefined {
        let current: AstNode | undefined = node.$container;
        while (current) {
            if (ast.isClassMethod(current)) {
                return current.isStatic ? current : undefined;
            }
            if (ast.isClassType(current)) return undefined;
            current = current.$container;
        }
        return undefined;
    }

    private getContainingStaticBlock(node: AstNode): ast.BlockStatement | undefined {
        let current: AstNode | undefined = node.$container;
        while (current) {
            if (ast.isBlockStatement(current)) {
                const parent = current.$container;
                if (ast.isClassType(parent)) {
                    if (parent.staticBlock && parent.staticBlock.includes(current)) {
                        return current;
                    }
                }
            }
            if (ast.isClassMethod(current)) return undefined;
            if (ast.isClassType(current)) return undefined;
            current = current.$container;
        }
        return undefined;
    }
}
