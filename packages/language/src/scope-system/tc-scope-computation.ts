import { AstNode, AstNodeDescription, AstUtils, DefaultScopeComputation, LangiumDocument, MultiMap } from "langium";
import { CancellationToken } from "vscode-languageserver";
import * as ast from "../generated/ast.js";

type ReferencableSymbol = 
    ast.VariableDeclaration | 
    ast.FunctionDeclaration | 
    ast.TypeDeclaration | 
    ast.NamespaceDecl | 
    ast.FunctionParameter | 
    ast.GenericType |
    ast.ExternFFIDecl |
    ast.SubModule |
    ast.BuiltinDefinition |
    ast.VariantConstructor;  // TODO: Make this context-sensitive later

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
        const containers = this.getContainerHierarchy(node);
        for (const container of containers) {
            const declarations = this.getDeclarationsFromContainer(container);
            for (const declaration of declarations) {
                const name = this.nameProvider.getName(declaration);
                symbols.add(container, this.descriptions.createDescription(declaration, name, document));
            }
        }
    }

    private getContainerHierarchy(node: AstNode): AstNode[] {
        const containers: AstNode[] = [];
        let current: AstNode | undefined = node;
        //console.log("--- BEGIN ---");
        while (current) {
            containers.push(current);
            // Add debug logging
            //console.log('Container type:', current.$type);
            current = current.$container;
        }
        //console.log("--- END ---");
        return containers;
    }

    private getDeclarationsFromContainer(container: AstNode): ReferencableSymbol[] {
        const declarations: ReferencableSymbol[] = [];

        // Add debug logging
        //console.log('Processing container type:', container.$type);

        if (ast.isFunctionDeclaration(container)) {
            // Add generic parameters
            declarations.push(...container.genericParameters ?? []);
            // Add parameters
            declarations.push(...container.header.args ?? []);  
        }
        else if (ast.isBuiltinSymbolFn(container)) {
            declarations.push(...container.genericParameters ?? []);
        }
        else if (ast.isBlockStatement(container)) {
            //console.log('Found block statement');
            declarations.push(...this.getVariableDeclarations(container));
        }
        else if (ast.isNamespaceDecl(container)) {
            //console.log('Found namespace declaration');
            declarations.push(...this.getNamespaceDeclarations(container));
        }
        else if (ast.isModule(container)) {
            //console.log('Found program');
            declarations.push(...this.getGlobalDeclarations(container));
        }
        else if (ast.isVariableDeclarationStatement(container)) {
            //console.log('Found variable declaration statement');
            declarations.push(...container.declarations.variables);
        }
        else if (ast.isTypeDeclaration(container)) {
            // Add generic parameters
            declarations.push(...container.genericParameters);
        }
        else if (ast.isLetInExpression(container)) {
            declarations.push(...container.vars);
        }
        /*
        if(isGenericType(container)) {
            declarations.push(container);
        }
        */
        else if(ast.isClassMethod(container)) {
            // Add parameters
            declarations.push(...container.method.header.args);
            // Add generic parameters
            declarations.push(...container.method.genericParameters);
        }
        else if (ast.isForStatement(container)) {
            if (container.init) {
                declarations.push(...this.getDeclarationsFromContainer(container.init));
            }
        }
        return declarations;
    }

    private getVariableDeclarations(block: ast.BlockStatement): ReferencableSymbol[] {
        const declarations: ReferencableSymbol[] = [];
        
        // Visit all children of the block
        for (const statement of block.statements ?? []) {
            if (ast.isVariableDeclarationStatement(statement)) {
                declarations.push(...statement.declarations.variables);
            } else if (ast.isFunctionDeclarationStatement(statement)) {
                declarations.push(statement.fn);
            }
        }
        
        return declarations;
    }

    private getNamespaceDeclarations(namespace: ast.NamespaceDecl): ReferencableSymbol[] {
        const declarations: ReferencableSymbol[] = [];
        
        // Get all definitions in the namespace
        for (const def of namespace.definitions ?? []) {
            if (ast.isVariableDeclaration(def)) {
                declarations.push(def);
            } else if (ast.isFunctionDeclaration(def)) {
                declarations.push(def);
            } else if (ast.isTypeDeclaration(def)) {
                declarations.push(def);
            } else if (ast.isExternFFIDecl(def)) {
                declarations.push(def);
            }
        }
        
        return declarations;
    }

    private getGlobalDeclarations(model: ast.Module): ReferencableSymbol[] {
        const declarations: ReferencableSymbol[] = [];
        
        // Get all global definitions
        // Cast to any since we know the structure but TypeScript doesn't
        const defs = model.definitions;
        for (const def of defs) {
            if (ast.isVariableDeclaration(def)) {
                declarations.push(def);
            } else if (ast.isFunctionDeclaration(def)) {
                //console.log("pushing ", def.name);
                declarations.push(def);
            } else if (ast.isTypeDeclaration(def)) {
                declarations.push(def);
                // TODO: Make this context-sensitive - only add constructors when expected type is known
                // If it's a variant type, also expose its constructors
                if (def.definition && ast.isVariantType(def.definition)) {
                    declarations.push(...def.definition.constructors);
                }
            } else if (ast.isExternFFIDecl(def)) {
                declarations.push(def);
            } else if (ast.isVariableDeclarationStatement(def)) {
                declarations.push(...def.declarations.variables);
            } else if (ast.isNamespaceDecl(def)) {
                declarations.push(def);
            } else if (ast.isBuiltinDefinition(def)) {
                declarations.push(def);
            }
        }
        
        return declarations;
    }
}