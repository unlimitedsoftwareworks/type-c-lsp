import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription, getNameFromAstNode } from "./base.js";

export interface StructFieldDescription {
    $node?: AstNode;
    name: string;
    type: TypeDescription;
    toString: () => string;
}

export function createStructFieldDescription(name: string, type: TypeDescription, node?: AstNode): StructFieldDescription {
    return {
        $node: node,
        name,
        type,
        toString() { return `${this.name}: ${this.type.toString()}`; }
    };
}

export interface StructTypeDescription extends AbstractTypeDescription {
    $type: 'StructType';
    fields: StructFieldDescription[];
}

export function createStructType(fields: StructFieldDescription[], node?: AstNode): StructTypeDescription {
    return {
        $type: 'StructType',
        fields,
        $node: node,
        toString() { 
            return getNameFromAstNode(this.$node) ?? `struct {
                ${this.fields.map(f => f.toString()).join("\n")}
            }`; 
        }
    };
}

export function isDescStructType(type: TypeDescription): type is StructTypeDescription {
    return type.$type === 'StructType';
}
