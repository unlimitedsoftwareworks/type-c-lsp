import { AstNode } from "langium";
import { TypeDescription } from "../type-c-types.js";
import { AbstractTypeDescription } from "./base.js";


export interface IntegerTypeDescription extends AbstractTypeDescription {
    $type: 'IntegerType';
    name: 'u8' | 'u16' | 'u32' | 'u64' | 'i8' | 'i16' | 'i32' | 'i64';
    //isLiteral: boolean;
    //initialValue?: string;
}

export function createIntegerType(
    name: 'u8' | 'u16' | 'u32' | 'u64' | 'i8' | 'i16' | 'i32' | 'i64', 
    //isLiteral?: boolean, 
    //initialValue?: string,
    node?: AstNode
): IntegerTypeDescription {
    return {
        $type: 'IntegerType',
        name,
        $node: node,
        //isLiteral: isLiteral ?? false,
        //initialValue: initialValue,
        toString() { return this.name; },
    };
}

export function isDescIntegerType(type: TypeDescription): type is IntegerTypeDescription {
    return type.$type === 'IntegerType';
}
