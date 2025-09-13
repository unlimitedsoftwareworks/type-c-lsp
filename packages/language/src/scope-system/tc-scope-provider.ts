import { AstNodeDescription, AstUtils, DefaultScopeProvider, DocumentCache, MapScope, ReferenceInfo, Scope, Stream, stream } from "langium";
import { prototypeURI } from "../builtins/index.js";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";

export class TypeCScopeProvider extends DefaultScopeProvider {
    private readonly globalCache: DocumentCache<string, Scope>;

    constructor(services: TypeCServices) {
        super(services);

        this.globalCache = new DocumentCache(services.shared);
    }

    override getScope(context: ReferenceInfo): Scope {
        return super.getScope(context);
    }

    protected override getGlobalScope(referenceType: string, _context: ReferenceInfo): Scope {
        const document = AstUtils.getDocument<ast.Module>(_context.container);
        return this.globalCache.get(document.uri, referenceType, () => 
            this.createGlobalScope(referenceType, document.parseResult.value)
        );
    }

    private createGlobalScope(referenceType: string, root: ast.Module): Scope {
        return new MapScope(this.getGlobalScopeElements(referenceType, root));
    }


    getGlobalScopeElements(referenceType: string, root: ast.Module, ownFile: boolean = false): Stream<AstNodeDescription> {
        // The builtin language definition is implicitly imported by every file
        const uris = new Set<string>([prototypeURI]);
        // @TODO: circulate over all imports and add them to the URIs array!
        
        if (ownFile) {
            uris.add(AstUtils.getDocument(root).uri.toString());
        }
        // Prioritize elements of type `RepeatingGroupDef` over `Record`, and `Message` over `MessageDecl`
        // Fields in `RepeatingGroupDef` have additional `req` and `opt` specifiers that override the type of the record fields
        const allElements = this.indexManager.allElements(referenceType, uris).toArray();
        
        return stream(allElements);
    }
}