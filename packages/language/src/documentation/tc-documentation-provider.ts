import { AstNode, JSDocDocumentationProvider } from "langium";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";

export class TypeCDocumentationProvider extends JSDocDocumentationProvider {
    private readonly typeProvider: TypeCTypeProvider;

    constructor(services: TypeCServices) {
        super(services);
        this.typeProvider = services.typing.TypeProvider;
    }
    
    override getDocumentation(node: AstNode): string | undefined {
        // Check if this node is being referenced in a member access
        // If so, we want to get the type from the member access (which applies generic substitutions)
        // instead of the node itself (which would be the generic definition)
        const container = node.$container;
        
        // If this is a method or attribute being accessed through member access,
        // find the member access node and use its type instead
        if (ast.isClassMethod(node) || ast.isMethodHeader(node) || ast.isClassAttributeDecl(node)) {
            // Look for a MemberAccess that references this node
            // This is a heuristic - we check the parent's parent which is often the MemberAccess
            let current = container;
            while (current) {
                if (ast.isMemberAccess(current)) {
                    // Use the member access type, which will have generics substituted
                    const type = this.typeProvider.getType(current);
                    return `${type.toString()}`;
                }
                current = current.$container;
            }
        }
        
        // Default: get type of the node itself
        let type = this.typeProvider.getType(node);
        return `${type.toString()}`;
    }
}