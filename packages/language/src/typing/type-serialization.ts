import { AttributeType, MethodType } from "./type-c-types.js";

export namespace serializer {
    export function serializeMethods(methods: Readonly<MethodType[]>) {
        return methods.map(e => {
            return "\t"+(e.isStatic?"static ":"")+(e.isLocal?"local ":"")+"fn "+e.names.join(" | ") + "(" + 
                e.parameters.map(e => (e.isMut?"mut ":"")+e.name+": "+e.type.toString()).join(", ")
                +") -> " + e.returnType.toString()
        }).join("\n");
    }

    export function serializeClassAttributes(attributes: Readonly<AttributeType[]>) {
        return attributes.map(
            e => ("\t"+(e.isStatic?"static ":"")+(e.isLocal?"local ":"")+(e.isConst?"const ":"")+e.name+": "+e.type.toString())
        ).join("\n")
    }
    
}