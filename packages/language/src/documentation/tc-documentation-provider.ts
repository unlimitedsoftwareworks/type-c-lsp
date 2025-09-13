import { AstNode, JSDocDocumentationProvider } from "langium";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";
import { TypeCServices } from "../type-c-module.js";


export class TypeCDocumentationProvider extends JSDocDocumentationProvider {
    private readonly typeProvider: TypeCTypeProvider;

    constructor(services: TypeCServices) {
        super(services);
        this.typeProvider = services.typing.TypeProvider;
    }
    
    override getDocumentation(node: AstNode): string | undefined {
        let type = this.typeProvider.inferType(node);
        return `\`${type.toString()}\``;
    }
    
}