import { AstNode, AstNodeDescription, AstUtils, DefaultScopeComputation, LangiumDocument, MultiMap } from "langium";
import { CancellationToken } from "vscode-languageserver";
import * as ast from "../generated/ast.js";
import * as scopeUtils from "./tc-scope-utils.js";
/**
 * In langium, scope computation is equivalent to static (default) lexical scope.
 */
export class TypeCScopeComputation extends DefaultScopeComputation {
    override collectExportedSymbols(document: LangiumDocument, cancelToken?: CancellationToken): Promise<AstNodeDescription[]> {
        const model = document.parseResult.value as ast.Module;
        return this.collectExportedSymbolsForNode(model, document, this.exportFilter, cancelToken);
    }

    exportFilter(node: AstNode): Iterable<AstNode>{
        function isExportable(node: AstNode): boolean {
            if(ast.isNamespaceDecl(node)) {
                return !node.isLocal;
            }
        
            if(ast.isExternFFIDecl(node)) {
                return !node.isLocal;
            }
        
            if(ast.isTypeDeclaration(node)) {
                return !node.isLocal;
            }
        
            if(ast.isVariableDeclarationStatement(node)) {
                return !node.declarations.isLocal;
            }
        
            if(ast.isFunctionDeclaration(node)) {
                return !node.isLocal;
            }

            if(ast.isBuiltinDefinition(node)) {
                return true;
            }
    
            return false;
        }

        const items: AstNode[] = [];
        AstUtils.streamContents(node).forEach(item => {
            if(isExportable(item)) {
                items.push(item);
            }
        });

        return items;
    }

    /**
     * Overrides the default Local Symbol computations
     */
    override addLocalSymbol(node: AstNode, document: LangiumDocument, symbols: MultiMap<AstNode, AstNodeDescription>): void {
        const containers = scopeUtils.getContainerHierarchy(node);
        for (const container of containers) {
            const declarations = scopeUtils.getDeclarationsFromContainer(container);
            for (const declaration of declarations) {
                const name = this.nameProvider.getName(declaration);
                if (name) {
                    symbols.add(container, this.descriptions.createDescription(declaration, name, document));
                }
            }
        }
    }
}