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
    stream,
    StreamScope
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
    private readonly services: TypeCServices;

    /** Type provider for inferring expression types */
    private readonly typeProvider: TypeCTypeProvider;
    private readonly workspaceManager: TCWorkspaceManager;

    constructor(services: TypeCServices) {
        super(services);

        this.services = services;
        this.globalCache = new DocumentCache(services.shared);
        this.typeProvider = services.typing.TypeProvider;
        const wsManager = services.shared.workspace.WorkspaceManager;
        // Ensure we have the correct workspace manager type
        if (!(wsManager instanceof TCWorkspaceManager)) {
            throw new Error('WorkspaceManager must be an instance of TCWorkspaceManager');
        }
        this.workspaceManager = wsManager;
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

            if(ast.isMemberAccess(container) && ast.isThisExpression(container.$container)){
                return this.getScopeFromBaseExpressionType(container.$container);
            }
            // Handle edge case: TypeGuard created in expression context
            // This happens during autocomplete after "expr." where parser ambiguously
            // creates a TypeGuard node. Extract the actual expression from the QualifiedReference.
            
            if(ast.isQualifiedReference(container.$container)) {
                return this.getScopeFromBaseExpressionType(container.$container)
            }
        }
        else if (scopeUtils.isRefTypeQualifiedReference(container, context)) {
            // Another check to keep typing happy
            if (ast.isReferenceType(container) && container.parent) {
                return this.getScopeFromReferenceType(container);
            }
        }

        if (ast.isSubModule(container)) {
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
            // Handle ImplementationMethodDecl - methods can have multiple names (operator overloading)
            else if (ast.isImplementationMethodDecl(node) && node.method) {
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

        return new StreamScope(stream(descriptions));
    }

    getScopeFromReferenceType(container: ast.ReferenceType): Scope {
        const parent = container.parent;
        if (parent?.field?.ref) {
            if (ast.isTypeDeclaration(parent.field.ref) && ast.isVariantType(parent.field.ref.definition)) {
                return this.createScopeForNodes(parent.field.ref.definition.constructors ?? []);
            }
            if (ast.isTypeDeclaration(parent.field.ref) && ast.isEnumType(parent.field.ref.definition)) {
                return this.createScopeForNodes(parent.field.ref.definition.cases ?? []);
            }
            return this.createScopeForNodes(scopeUtils.getDeclarationsFromContainer(parent.field.ref));
        }

        return EMPTY_SCOPE;
    }

    private findURIForImport(fileImport: ast.Import): string | undefined {
        const baseName = path.join(...fileImport.sourcePackage.segments!) + '.tc';

        const library = this.workspaceManager.findLibrary(baseName);
        if (library) {
            const fullPath = library.toString();
            return fullPath;
        }
        return undefined;
    }

    private resolveDescriptionNode(description: AstNodeDescription): AstNode | undefined {
        if (description.node) {
            return description.node;
        }

        const document = this.services.shared.workspace.LangiumDocuments.getDocument(description.documentUri);
        if (!document) {
            return undefined;
        }

        return this.services.workspace.AstNodeLocator.getAstNode(document.parseResult.value, description.path);
    }

    private getExportedRefFromSubModule(context: ReferenceInfo): Scope {
        // Restrict scope to the specific import's source file, not all imports.
        // SubModule.$container is the Import that contains it.
        const subModule = context.container;
        if (ast.isSubModule(subModule) && ast.isImport(subModule.$container)) {
            const uri = this.findURIForImport(subModule.$container);
            if (uri) {
                const uris = new Set<string>([uri]);
                const astNodeDescriptions = this.indexManager.allElements(ast.IdentifiableReference.$type, uris).toArray();
                return this.createScope(stream(astNodeDescriptions));
            }
        }

        // Fallback: use all imported URIs (shouldn't normally be reached)
        const document = AstUtils.getDocument(context.container);
        const parseResult = document.parseResult.value;
        if (!ast.isModule(parseResult)) {
            return EMPTY_SCOPE;
        }
        const model = parseResult;
        const uris = new Set<string>();

        for (const fileImport of model.imports) {
            const uri = this.findURIForImport(fileImport);
            if (uri) {
                uris.add(uri);
            }
        }

        const astNodeDescriptions = this.indexManager.allElements(ast.IdentifiableReference.$type, uris).toArray();
        return this.createScope(stream(astNodeDescriptions));
    }

    private getAllExportedRefsFromModule(importEntry: ast.Import): AstNodeDescription[] {
        const uri = this.findURIForImport(importEntry);
        if (uri) {
            const nodes = this.indexManager
                .allElements(ast.IdentifiableReference.$type, new Set([uri]))
                .toArray()
                .map(description => this.resolveDescriptionNode(description))
                .filter((node): node is AstNode => node !== undefined);
            return nodes.map(node => this.descriptions.createDescription(node, this.nameProvider.getName(node)));
        }
        return [];
    }

    private getNamedImportRefsFromModule(importEntry: ast.Import, subModule: ast.SubModule): AstNodeDescription[] {
        const importedRef = subModule.reference.ref;
        if (!importedRef) {
            return [];
        }

        // Navigate through nested namespace path (e.g., engine.graphics)
        let targetNode: AstNode = importedRef;
        if (subModule.nestedPath.length > 0) {
            for (const segment of subModule.nestedPath) {
                if (!ast.isNamespaceDecl(targetNode)) {
                    return []; // Can only navigate into namespaces
                }
                const found = targetNode.definitions?.find(
                    def => ast.isNamespaceDecl(def) && def.name === segment
                );
                if (!found) {
                    return []; // Nested namespace not found
                }
                targetNode = found;
            }
        }

        // Import name: alias > last nested segment > reference name
        const importName = subModule.alias
            ?? (subModule.nestedPath.length > 0 ? subModule.nestedPath[subModule.nestedPath.length - 1] : null)
            ?? this.nameProvider.getName(importedRef);
        if (!importName) {
            return [];
        }

        const defaultImportRef = this.descriptions.createDescription(targetNode, importName);
        if (!ast.isFunctionDeclaration(targetNode)) {
            return [defaultImportRef];
        }

        const uri = this.findURIForImport(importEntry);
        if (!uri) {
            return [defaultImportRef];
        }

        const targetFn = targetNode;
        const nodes = this.indexManager
            .allElements(ast.IdentifiableReference.$type, new Set([uri]))
            .toArray()
            .map(description => this.resolveDescriptionNode(description))
            .filter((node): node is AstNode => node !== undefined);

        const matchingOverloads = nodes.filter((node): node is ast.FunctionDeclaration =>
            ast.isFunctionDeclaration(node) &&
            node.name === targetFn.name
        );

        if (matchingOverloads.length === 0) {
            return [defaultImportRef];
        }

        return matchingOverloads.map(overload => this.descriptions.createDescription(overload, importName));
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
            if (ast.isModule(lastContainer)) {
                const importedModules: AstNodeDescription[] = []
                for (const importEntry of lastContainer.imports) {
                    if (importEntry.importAll) {
                        importedModules.push(...this.getAllExportedRefsFromModule(importEntry));
                    }
                    else {
                        for (const subModule of importEntry.modules) {
                            importedModules.push(...this.getNamedImportRefsFromModule(importEntry, subModule));
                        }
                    }
                }
                scopes.push(stream(importedModules));
            }
        }

        // Inject the target struct's generic parameters when inside a StructPrototypeDeclaration.
        // This allows `prototype Pair { fn swap() -> Pair<T> { ... } }` to reference T
        // from `type Pair<T> = struct { ... }`.
        // Must be done here (not in scope computation) because target?.ref requires linking.
        // Guard: skip when resolving the prototype's own `target` reference to avoid cycles.
        const protoNode = AstUtils.getContainerOfType(context.container, ast.isStructPrototypeDeclaration);
        if (protoNode && context.container !== protoNode) {
            const targetDecl = protoNode.target?.ref;
            if (targetDecl && ast.isTypeDeclaration(targetDecl) && targetDecl.genericParameters?.length) {
                const document = AstUtils.getDocument(context.container);
                const genericDescs = targetDecl.genericParameters.map(gp =>
                    this.descriptions.createDescription(gp, gp.name, document)
                );
                scopes.push(stream(genericDescs));
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
