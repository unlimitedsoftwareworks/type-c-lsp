import {
    AstNode,
    AstNodeDescription,
    AstUtils,
    DefaultScopeProvider,
    DocumentCache,
    MapScope,
    ReferenceInfo,
    Scope,
    Stream,
    stream,
} from "langium";
import { prototypeURI } from "../builtins/index.js";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";
import * as scopeUtils from "./tc-scope-utils.js";

export class TypeCScopeProvider extends DefaultScopeProvider {
    private readonly globalCache: DocumentCache<string, Scope>;
    private readonly typeProvider: TypeCTypeProvider;

    constructor(services: TypeCServices) {
        super(services);

        this.globalCache = new DocumentCache(services.shared);
        this.typeProvider = services.typing.TypeProvider;
    }

    override getScope(context: ReferenceInfo): Scope {
        const container = context.container;
        if (scopeUtils.isMemberResolution(context.container, context)) {
            if (ast.isMemberAccess(container) && container.expr) {
                return this.getScopeFromBaseExpressionType(container.expr);
            }
        }
        return this.getLocalScope(context);
    }

    /**
     * Infers the type of the base expression and returns the scope of the type, i.e all identifiable references
     * such as class methods, attributes, array/coroutine prototypes, etc.
     * @param expr
     * @returns
     */
    private getScopeFromBaseExpressionType(expr: ast.Expression): Scope {
        const baseExprType = this.typeProvider.inferExpression(expr);
        const nodes = this.typeProvider.getIdentifiableFields(baseExprType);
        return this.createScopeForNodes(nodes);
    }

    /**
     * This is a reimplementation of the default getScope, minus the reflection check
     * Should scope provider care about the reflection check?
     * @param context
     * @returns local scope
     */
    protected getLocalScope(context: ReferenceInfo): Scope {
        const scopes: Array<Stream<AstNodeDescription>> = [];
        const referenceType = this.reflection.getReferenceType(context);

        const localSymbols = AstUtils.getDocument(context.container).localSymbols;
        if (localSymbols) {
            let currentNode: AstNode | undefined = context.container;
            do {
                if (localSymbols.has(currentNode)) {
                    scopes.push(localSymbols.getStream(currentNode));
                }
                currentNode = currentNode.$container;
            } while (currentNode);
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
        const uris = new Set<string>([prototypeURI]);
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
