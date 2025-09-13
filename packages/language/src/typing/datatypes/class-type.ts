import { AstNode } from "langium";
import * as ast from "../../generated/ast.js";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";
import { FunctionTypeDescription } from "./function-type.js";
import { InterfaceMethodDescription } from "./interface-type.js";


export interface ClassAttributeDescription {
    $type: 'ClassAttribute';
    name: string;
    type: TypeDescription;
    isConstant: boolean;
    isLocal: boolean;
    isStatic: boolean;
    $node?: AstNode;
    toString: () => string;
}

export function createClassAttributeDescription(name: string, type: TypeDescription, isStatic: boolean, isLocal: boolean, isConstant: boolean, node?: AstNode): ClassAttributeDescription {
    return {
        $type: 'ClassAttribute',
        name,
        type,
        isConstant,
        isLocal,
        isStatic,
        $node: node,
        toString() {
            return `${this.isStatic ? "static " : ""}${this.isLocal ? "local " : ""}${this.isConstant ? "const " : ""}${this.name}: ${this.type.toString()}`;
        }
    };
}

export interface ClassMethodDescription extends InterfaceMethodDescription {
    expression?: ast.Expression;
    body?: ast.BlockStatement;
    isStatic: boolean;
    isLocal: boolean;
    isOverride: boolean;
}

export function createClassMethodDescription(
    names: string[],
    header: FunctionTypeDescription,
    isStatic: boolean,
    isLocal: boolean,
    isOverride: boolean,
    expression?: ast.Expression, 
    body?: ast.BlockStatement, 
    node?: AstNode
): ClassMethodDescription {
    return {
        names,
        header,
        expression,
        body,
        isStatic,
        isLocal,
        isOverride,
        $node: node,
        toString() {
            return `${this.isOverride ? "override " : ""}${this.isStatic ? "static " : ""}${this.isLocal ? "local " : ""}${this.names.join(" | ")} ${this.header.toString()}`;
        }
    };
}

export interface ClassTypeDescription extends AbstractTypeDescription {
    $type: 'ClassType';
    supertypes: TypeDescription[];
    attributes: ClassAttributeDescription[];
    methods: ClassMethodDescription[];
    implementations: ast.ClassImplementationMethodDecl[];
    staticBlocks: ast.BlockStatement[];
}

export function createClassType(
    supertypes: TypeDescription[],
    attributes: ClassAttributeDescription[],
    methods: ClassMethodDescription[],
    implementations: ast.ClassImplementationMethodDecl[],
    staticBlocks: ast.BlockStatement[],
    node?: AstNode
): ClassTypeDescription {
    return {
        $type: 'ClassType',
        supertypes,
        attributes,
        methods,
        implementations,
        staticBlocks,
        $node: node,
        toString() {
            // TODO: implement
            return getNameFromAstNode(this.$node) ?? `a class`;
        }
    };
}

export function isDescClassType(type: TypeDescription): type is ClassTypeDescription {
    return type.$type === 'ClassType';
}


export interface ClassDefinitionTypeDescription extends AbstractTypeDescription {
    $type: 'ClassDefinition';
    name: string;
    classReference: ClassTypeDescription;
}

export function createClassDefinitionType(name: string, classReference: ClassTypeDescription): ClassDefinitionTypeDescription {
    return {
        $type: 'ClassDefinition',
        name,
        classReference,
        toString() {
            return `typeof(${this.name})`;
        }
    };
}

export function isDescClassDefinitionType(type: TypeDescription): type is ClassDefinitionTypeDescription {
    return type.$type === 'ClassDefinition';
}