/**
 * Custom Hover Provider for Type-C
 * 
 * **Purpose:**
 * Provides context-aware hover information with proper generic type substitution.
 * 
 * **The Problem:**
 * Langium's default hover provider resolves references to their definitions,
 * losing context about generic type arguments.
 * 
 * **Example problem:**
 * ```typescript
 * let arr: Array<u32> = ...
 * arr.clone()  // Hover over 'clone'
 * ```
 * - Default behavior: Jump to method definition → show `fn() -> Array<T>`
 * - Desired behavior: Show context-aware type → `fn() -> Array<u32>`
 * 
 * **Solution:**
 * 1. Capture the AST node at the cursor position (usage site)
 * 2. Traverse up to find the containing MemberAccess node
 * 3. Get the type from MemberAccess (which has generic substitutions)
 * 4. Display the fully resolved type
 * 
 * **Why this works:**
 * The type provider's `inferMemberAccess()` already handles generic substitution.
 * We just need to get the type from the *usage site* instead of the *definition site*.
 */

import { AstNode, LangiumDocument, MaybePromise } from "langium";
import { AstNodeHoverProvider } from "langium/lsp";
import { Hover, HoverParams, MarkupContent } from "vscode-languageserver";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";

export class TypeCHoverProvider extends AstNodeHoverProvider {
    /** Type provider for inferring types */
    private readonly typeProvider: TypeCTypeProvider;
    
    constructor(services: TypeCServices) {
        super(services);
        this.typeProvider = services.typing.TypeProvider;
    }

    override async getHoverContent(document: LangiumDocument, params: HoverParams): Promise<Hover | undefined> {
        let res = await super.getHoverContent(document, params);
        if(MarkupContent.is(res?.contents)) {
            res.contents.value = "```tc\n"+res.contents.value+"\n```"
        }
        return res;
    }

    protected override getAstNodeHoverContent(node: AstNode): MaybePromise<string | undefined> {
        const type = this.typeProvider.getType(node);
        return type.toString();
    }
}

