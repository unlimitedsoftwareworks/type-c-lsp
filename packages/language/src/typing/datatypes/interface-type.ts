import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { FunctionTypeDescription } from "./function-type.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface InterfaceMethodDescription extends AbstractTypeDescription {
    $type: 'InterfaceMethod';
    $node?: AstNode;
    names: string[];
    header: FunctionTypeDescription;
    toString: () => string;
}

export function createInterfaceMethodDescription(names: string[], header: FunctionTypeDescription, node?: AstNode): InterfaceMethodDescription {
    return {
        $type: 'InterfaceMethod',
        $node: node,
        names,
        header,
        toString() { 
            return getNameFromAstNode(this.$node) ?? `${this.names.join(" | ")} ${this.header.toString()}`; 
        }
    };
}

export interface InterfaceTypeDescription extends AbstractTypeDescription {
    $type: 'InterfaceType';
    supertypes: TypeDescription[];
    methods: InterfaceMethodDescription[];
}

/**
 * Creates an interface type from a list of supertypes and methods.
 * The methods will contain the full list of methods from the supertypes and the methods added.
 * 
 * This will not check its parent, that is done in the validation phase.
 * @param supertypes 
 * @param methods 
 * @param node 
 * @returns 
 */
export function createInterfaceType(supertypes: TypeDescription[], methods: InterfaceMethodDescription[], node?: AstNode): InterfaceTypeDescription {
    const allMethods = [...supertypes.filter(isDescInterfaceType).flatMap(s => s.methods), ...methods];

    return {
        $type: 'InterfaceType',
        supertypes,
        methods: allMethods,
        $node: node,
        toString() { 
            return getNameFromAstNode(this.$node) ?? `interface {
                ${this.methods.map(m => m.toString()).join("\n")}
            }`; 
        }
    };
}

export function isDescInterfaceType(type: TypeDescription): type is InterfaceTypeDescription {
    return type.$type === 'InterfaceType';
}

/*
export interface InterfaceDefinitionTypeDescription extends AbstractTypeDescription {
    $type: 'InterfaceDefinition';
    name: string;
    interfaceReference: InterfaceTypeDescription;
}

export function createInterfaceDefinitionType(name: string, interfaceReference: InterfaceTypeDescription): InterfaceDefinitionTypeDescription {
    return {
        $type: 'InterfaceDefinition',
        name,
        interfaceReference,
        toString() {
            return `typeof(${this.name})`;
        }
    };
}
*/