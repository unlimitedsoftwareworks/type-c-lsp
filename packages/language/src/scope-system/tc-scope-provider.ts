import {
    AstNode,
    AstNodeDescription,
    AstUtils,
    DefaultScopeProvider,
    DocumentCache,
    EMPTY_SCOPE,
    MapScope,
    ReferenceInfo,
    Scope,
    Stream,
    stream
} from "langium";
import * as path from "node:path";
import * as builtins from "../builtins/index.js";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";
import { TCWorkspaceManager } from "../workspace/tc-workspace-manager.js";
import * as scopeUtils from "./tc-scope-utils.js";

/**
 * Custom Scope Provider for Type-C
 * 
 * **Purpose:**
 * Provides symbol resolution and auto-completion for Type-C, with special
 * support for member access, operator overloading, and generic types.
 * 
 * **Key features:**
 * - Type-aware member completion (e.g., `arr.length` where arr is `u32[]`)
 * - Operator overloading (methods with multiple names like `+`, `-`, `()`)
 * - Generic-aware scope resolution
 * - Built-in prototype methods (array, coroutine)
 * 
 * **Integration with type system:**
 * This scope provider works closely with TypeCTypeProvider to:
 * 1. Infer types of base expressions
 * 2. Extract identifiable members from types
 * 3. Provide context-aware completions
 */
export class TypeCScopeProvider extends DefaultScopeProvider {
    /** Cache for global scopes, keyed by document and reference type */
    private readonly globalCache: DocumentCache<string, Scope>;
    
    /** Type provider for inferring expression types */
    private readonly typeProvider: TypeCTypeProvider;
    private readonly workspaceManager: TCWorkspaceManager;

    constructor(services: TypeCServices) {
        super(services);

        this.globalCache = new DocumentCache(services.shared);
        this.typeProvider = services.typing.TypeProvider;
        this.workspaceManager = services.shared.workspace.WorkspaceManager as TCWorkspaceManager;
    }

    /**
     * Main entry point for scope resolution.
     * 
     * **Called by Langium when:**
     * - User types a reference (variable name, type name, etc.)
     * - Auto-completion is triggered
     * - "Go to Definition" is requested
     * 
     * **How it works:**
     * 1. Check if this is a member access (e.g., `obj.field`)
     * 2. If yes: get members from the object's type
     * 3. If no: return local + global scope (variables, functions, types)
     * 
     * @param context Information about the reference being resolved
     * @returns Scope containing available symbols at this location
     */
    override getScope(context: ReferenceInfo): Scope {
        const container = context.container;
        
        // Check if we're resolving a member access expression
        if (scopeUtils.isMemberResolution(context.container, context)) {
            if (ast.isMemberAccess(container) && container.expr) {
                // Get scope from the type of the base expression
                return this.getScopeFromBaseExpressionType(container.expr);
            }
        }
        else if (scopeUtils.isRefTypeQualifiedReference(container, context)) {
            // Another check to keep typing happy
            if(ast.isReferenceType(container) && container.parent){
                return this.getScopeFromReferenceType(container);
            }
        }

        if(ast.isSubModule(container)) {
            return this.getExportedRefFromSubModule(context);
        }
        // Default: local + global scope
        return this.getCustomLocalScope(context);
    }

    /**
     * Gets the scope for member access based on the base expression's type.
     * 
     * **Example:**
     * ```typescript
     * let arr: u32[] = [1, 2, 3]
     * arr.  // <- cursor here
     * ```
     * 
     * **Flow:**
     * 1. Infer type of `arr` → `ArrayTypeDescription<u32>`
     * 2. Get identifiable fields → `[length, resize, slice]` (AST nodes)
     * 3. Create scope from these nodes
     * 4. Langium displays them in auto-completion
     * 
     * **Why this works:**
     * - Type provider handles generic substitution
     * - Scope provider just needs to expose the members
     * - AST nodes enable "Go to Definition"
     * 
     * @param expr The base expression (left side of the dot)
     * @returns Scope containing the members of the expression's type
     */
    private getScopeFromBaseExpressionType(expr: ast.Expression): Scope {
        const baseExprType = this.typeProvider.getExpressionType(expr);
        const nodes = this.typeProvider.getIdentifiableFields(baseExprType);
        return this.createScopeForNodesWithMultipleNames(nodes);
    }

    /**
     * Creates a scope from AST nodes, with support for operator overloading.
     * 
     * **Challenge:**
     * Type-C supports operator overloading, where a single method can have
     * multiple names (e.g., `fn [+, add](other: T) -> T`). Langium expects
     * one name per scope entry, so we need to create multiple entries.
     * 
     * **Solution:**
     * For methods with multiple names, create one AstNodeDescription per name,
     * all pointing to the same AST node. This enables both:
     * - Completion of `+` and `add`
     * - "Go to Definition" from either name
     * 
     * **Example:**
     * ```typescript
     * class Vec2 {
     *     fn [+, add](other: Vec2) -> Vec2 { ... }
     * }
     * 
     * // Creates two scope entries:
     * // "+": points to the method node
     * // "add": points to the same method node
     * ```
     * 
     * @param nodes AST nodes representing members (methods, fields, etc.)
     * @returns Scope with all names properly exposed
     */
    private createScopeForNodesWithMultipleNames(nodes: AstNode[]): Scope {
        const descriptions: AstNodeDescription[] = [];
        
        for (const node of nodes) {
            // Handle ClassMethod - methods can have multiple names (operator overloading)
            if (ast.isClassMethod(node) && node.method) {
                for (const name of node.method.names) {
                    descriptions.push(this.descriptions.createDescription(node, name));
                }
            }
            // Handle MethodHeader directly (for interfaces)
            else if (ast.isMethodHeader(node)) {
                for (const name of node.names) {
                    descriptions.push(this.descriptions.createDescription(node, name));
                }
            }
            // Handle StructFieldKeyValuePair (duck-typed struct fields)
            else if (ast.isStructFieldKeyValuePair(node)) {
                // For duck-typed structs, the field name is stored directly in the node
                descriptions.push(this.descriptions.createDescription(node, node.name));
            }
            // Handle other nodes normally (attributes, struct fields, etc.)
            else {
                const desc = this.descriptions.createDescription(node, this.nameProvider.getName(node));
                if (desc) {
                    descriptions.push(desc);
                }
            }
        }
        
        return new MapScope(stream(descriptions));
    }

    getScopeFromReferenceType(container: ast.ReferenceType): Scope {
        const parent = container.parent;
        if(parent?.field?.ref) {
            if(ast.isTypeDeclaration(parent.field.ref) && ast.isVariantType(parent.field.ref.definition)) {
                return this.createScopeForNodes(parent.field.ref.definition.constructors ?? []);
            }
            return this.createScopeForNodes(scopeUtils.getDeclarationsFromContainer(parent.field.ref));
        }
           
        return EMPTY_SCOPE;
    }

    private getExportedRefFromSubModule(context: ReferenceInfo): Scope {
        const document = AstUtils.getDocument(context.container);
        const model = document.parseResult.value as ast.Program;
        const uris = new Set<string>();

        for (const fileImport of model.imports) {
            const baseName = path.join(...fileImport.sourcePackage.segments!)+ '.tc';
            console.log(`Importing library: ${baseName}`);

            const library = this.workspaceManager.findLibrary(baseName);
            console.log(`Library found: ${library?.fsPath}`);
            if(library) {
                const fullPath = library.toString();
                uris.add(fullPath);
                console.log(`Imported library: ${fullPath}`);
            }
        }

        // Use indexManager to find all elements in the imported URIs
        const astNodeDescriptions = this.indexManager.allElements(ast.IdentifiableReference.$type, uris).toArray();
        console.log("Resolved AST Node Descriptions:", astNodeDescriptions.map(d => d.name));

        // Create a scope from the imported elements
        return this.createScope(stream(astNodeDescriptions));
    }

    /**
     * This is a reimplementation of the default getScope, minus the reflection check
     * Should scope provider care about the reflection check?
     * @param context
     * @returns local scope
     */
    protected getCustomLocalScope(context: ReferenceInfo): Scope {
        const scopes: Array<Stream<AstNodeDescription>> = [];
        const referenceType = this.reflection.getReferenceType(context);

        const localSymbols = AstUtils.getDocument(context.container).localSymbols;
        if (localSymbols) {
            let currentNode: AstNode | undefined = context.container;
            let lastContainer: AstNode | undefined = currentNode;
            do {
                if (localSymbols.has(currentNode)) {
                    scopes.push(localSymbols.getStream(currentNode));
                }
                lastContainer = currentNode;
                currentNode = currentNode.$container;
            } while (currentNode);

            // TODO: cache this?
            if(ast.isModule(lastContainer)) {
                const importedModules: AstNode[] = []
                for (const importEntry of lastContainer.imports) {
                    for (const subModule of importEntry.modules) {
                        if(subModule.reference.ref) {
                            importedModules.push(subModule.reference.ref);
                        }
                    }
                }
                const scope = this.createScopeForNodes(importedModules);
                scopes.push(scope.getAllElements());
            }
            
        }

        let result: Scope = this.getGlobalScope(referenceType, context);
        for (let i = scopes.length - 1; i >= 0; i--) {
            result = this.createScope(scopes[i], result);
        }
        return result;
    }

    protected override getGlobalScope(
        referenceType: string,
        _context: ReferenceInfo
    ): Scope {
        const document = AstUtils.getDocument<ast.Module>(_context.container);
        return this.globalCache.get(document.uri, referenceType, () =>
            this.createGlobalScope(referenceType, document.parseResult.value)
        );
    }

    private createGlobalScope(referenceType: string, root: ast.Module): Scope {
        return new MapScope(this.getGlobalScopeElements(referenceType, root));
    }

    getGlobalScopeElements(
        referenceType: string,
        root: ast.Module,
        ownFile: boolean = false
    ): Stream<AstNodeDescription> {
        // The builtin language definition is implicitly imported by every file
        const uris = new Set<string>([builtins.ArrayPrototypeBuiltin, builtins.CoroutinePrototypeBuiltin, builtins.StringPrototypeBuiltin]);
        // @TODO: circulate over all imports and add them to the URIs array!

        if (ownFile) {
            uris.add(AstUtils.getDocument(root).uri.toString());
        }
        // Prioritize elements of type `RepeatingGroupDef` over `Record`, and `Message` over `MessageDecl`
        // Fields in `RepeatingGroupDef` have additional `req` and `opt` specifiers that override the type of the record fields
        const allElements = this.indexManager
            .allElements(referenceType, uris)
            .toArray();

        return stream(allElements);
    }
}
