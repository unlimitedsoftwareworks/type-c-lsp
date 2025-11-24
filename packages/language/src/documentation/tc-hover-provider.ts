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

import { AstNode, MaybePromise, CstNode, LangiumDocument, isCompositeCstNode } from "langium";
import { AstNodeHoverProvider } from "langium/lsp";
import { Hover, HoverParams } from "vscode-languageserver";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";

/**
 * Recursively finds the most specific AST node at the given text offset.
 * 
 * **How it works:**
 * 1. Checks if offset falls within this CST node's range
 * 2. If node is composite, recursively check children (more specific)
 * 3. Returns the AST node associated with the most specific CST node
 * 
 * @param cstNode The CST (Concrete Syntax Tree) node to search
 * @param offset The text offset (0-based character position)
 * @returns The AST node at that position, or undefined if not found
 */
function findAstNodeAtOffset(cstNode: CstNode, offset: number): AstNode | undefined {
    // Check if offset is within this node
    if (offset < cstNode.offset || offset >= cstNode.end) {
        return undefined;
    }
    
    // Try children first (more specific) if this is a composite node
    if (isCompositeCstNode(cstNode)) {
        for (const child of cstNode.content) {
            const result = findAstNodeAtOffset(child, offset);
            if (result) {
                return result;
            }
        }
    }
    
    // Return this node's AST node
    return cstNode.astNode;
}

export class TypeCHoverProvider extends AstNodeHoverProvider {
    /** Type provider for inferring types */
    private readonly typeProvider: TypeCTypeProvider;
    
    /** Stores the node at cursor position during hover resolution */
    private currentHoverNode: AstNode | undefined;

    constructor(services: TypeCServices) {
        super(services);
        this.typeProvider = services.typing.TypeProvider;
    }

    /**
     * Main hover handler - captures cursor position before delegating to base class.
     * 
     * **Strategy:**
     * 1. Find and store the AST node at the cursor position
     * 2. Call base class (which resolves references)
     * 3. In `getAstNodeHoverContent()`, check if we're in a MemberAccess
     * 4. If yes, use the MemberAccess type (with substitutions)
     * 5. Clean up stored node
     * 
     * **Why this indirection?**
     * Langium's base class handles reference resolution, but we need to know
     * the *original* cursor position to find the containing MemberAccess.
     * 
     * @param document The document being hovered
     * @param params Hover parameters including cursor position
     * @returns Hover information or undefined
     */
    override async getHoverContent(document: LangiumDocument, params: HoverParams): Promise<Hover | undefined> {
        // Find the AST node at the cursor position
        const rootNode = document.parseResult?.value?.$cstNode;
        if (rootNode) {
            const offset = document.textDocument.offsetAt(params.position);
            this.currentHoverNode = findAstNodeAtOffset(rootNode, offset);
        }
        
        try {
            // Call base class implementation
            return await super.getHoverContent(document, params);
        } finally {
            // Clean up
            this.currentHoverNode = undefined;
        }
    }

    /**
     * Generates hover content string for an AST node with context awareness.
     * 
     * **Called by:** Base class after it resolves a reference to its definition.
     * 
     * **The key insight:**
     * When hovering over a member name, Langium gives us the *definition* node
     * (e.g., the method in the class). But we want the type from the *usage*
     * site (e.g., the member access with concrete generic args).
     * 
     * **How it works:**
     * 1. Check if `currentHoverNode` (cursor position) is set
     * 2. Traverse up the AST from that node
     * 3. If we find a MemberAccess or FunctionCall with MemberAccess:
     *    - Use the type from that node (has generic substitutions)
     * 4. Otherwise: use the type from the definition node (fallback)
     * 
     * **Example:**
     * ```typescript
     * arr: Array<u32>
     * arr.clone()  // Hover over 'clone'
     * 
     * - node: MethodHeader for clone (from definition)
     * - currentHoverNode: MethodHeader reference (at cursor)
     * - currentHoverNode.$container: MemberAccess (arr.clone)
     * - Type from MemberAccess: fn() -> Array<u32> ✅
     * ```
     * 
     * @param node The AST node that was resolved (usually the definition)
     * @returns Type string to display in hover
     */
    protected override getAstNodeHoverContent(node: AstNode): MaybePromise<string | undefined> {
        // Check if this node reference is from a MemberAccess
        // If we have a cached hover node, check its containers
        if (this.currentHoverNode) {
            let current: AstNode | undefined = this.currentHoverNode;
            while (current) {
                if (ast.isMemberAccess(current)) {
                    // Found a MemberAccess! Use its type (with generic substitutions)
                    const type = this.typeProvider.getType(current);
                    return type.toString();
                }
                // Also check if we're in a FunctionCall that contains a MemberAccess
                if (ast.isFunctionCall(current) && ast.isMemberAccess(current.expr)) {
                    const type = this.typeProvider.getType(current.expr);
                    return type.toString();
                }
                current = current.$container;
            }
        }
        
        // Fall back to getting the type directly
        const type = this.typeProvider.getType(node);
        return type.toString();
    }
}

