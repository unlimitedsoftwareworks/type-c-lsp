import { AstNode, AstUtils, ReferenceInfo } from "langium";
import * as ast from "../generated/ast.js";

type ReferencableSymbol =
    ast.VariableDeclaration |
    ast.DestructuringElement |
    ast.FunctionDeclaration |
    ast.TypeDeclaration |
    ast.NamespaceDecl |
    ast.FunctionParameter |
    ast.FunctionTypeParameter |
    ast.GenericType |
    ast.ExternFFIDecl |
    ast.SubModule |
    ast.BuiltinDefinition |
    ast.ClassAttributeDecl |
    ast.ClassMethod |
    ast.MethodHeader |
    ast.VariantConstructor |
    ast.IteratorVar |
    ast.VariablePattern;


export function isMemberResolution(container: AstNode, context: ReferenceInfo): boolean {
    // Check if we're resolving a member/method in any form
    if (ast.isMemberAccess(container) && (context.property === 'element')) {
        return true;
    }

    // Check if we're in a QualifiedReference and resolving a member/method
    if (container.$type === ast.QualifiedReference.$type) {
        // If we're resolving methods or members arrays
        if (context.property === 'methods' || context.property === 'members') {
            return true;
        }
    }

    // Handle edge case: parser creates TypeGuard in expression context
    // This happens when typing "result." and triggering autocomplete in a return statement
    // The parser ambiguously interprets it as a potential TypeGuard (x is Type)
    // but it's actually member access on an expression
    if (ast.isTypeGuard(container) && context.property === 'param' && context.reference.$refText === '') {
        // Empty reference text suggests we're at autocomplete position after a dot
        // Check if parent is a QualifiedReference in expression context
        if (ast.isQualifiedReference(container.$container)) {
            return true;
        }
    }

    return false;
}

export function isRefTypeQualifiedReference(container: AstNode, context: ReferenceInfo): boolean {
    if((ast.isReferenceType(container) && context.property === 'field')) {
        return true;
    }

    return false;
}

export function getContainerHierarchy(node: AstNode): AstNode[] {
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

export function getDeclarationsFromContainer(container: AstNode): ReferencableSymbol[] {
    const declarations: ReferencableSymbol[] = [];

    // Add debug logging
    //console.log('Processing container type:', container.$type);

    if (ast.isFunctionDeclaration(container)) {
        // Add generic parameters
        declarations.push(...container.genericParameters ?? []);
        // Add parameters
        declarations.push(...container.header?.args ?? []);
    }
    else if (ast.isLambdaExpression(container)) {
        declarations.push(...container.header?.args ?? []);
    }
    else if (ast.isFunctionType(container)) {
        // Add function type parameters to scope (for type guards like "v is string")
        declarations.push(...container.header?.args ?? []);
    }
    else if (ast.isBuiltinSymbolFn(container)) {
        declarations.push(...container?.genericParameters ?? []);
    }
    else if (ast.isBlockStatement(container)) {
        //console.log('Found block statement');
        declarations.push(...getVariableDeclarations(container));
    }
    else if (ast.isNamespaceDecl(container)) {
        //console.log('Found namespace declaration');
        declarations.push(...getNamespaceDeclarations(container));
    }
    else if (ast.isModule(container)) {
        //console.log('Found program');
        declarations.push(...getGlobalDeclarations(container));
    }
    else if (ast.isVariableDeclarationStatement(container)) {
        //console.log('Found variable declaration statement');
        container.declarations.variables.forEach(v => {
           if(ast.isVariableDeclSingle(v)) {
            declarations.push(v);
           } else if(ast.isVariableDeclArrayDestructuring(v)
           || ast.isVariableDeclStructDestructuring(v)
           || ast.isVariableDeclTupleDestructuring(v)) {
            v.elements.forEach(e => declarations.push(e));
           } 
        });
    }
    else if (ast.isTypeDeclaration(container)) {
        // Add generic parameters
        declarations.push(...container?.genericParameters ?? []);
    }
    else if (ast.isLetInExpression(container)) {
        declarations.push(...container?.vars ?? []);
    }
    /*
    if(isGenericType(container)) {
        declarations.push(container);
    }
    */
    else if(ast.isClassMethod(container)) {
        // Add parameters
        declarations.push(...container?.method?.header?.args ?? []);
        // Add generic parameters
        declarations.push(...container?.method?.genericParameters ?? []);
    }
    else if (ast.isForStatement(container)) {
        if (container.init) {
            declarations.push(...getDeclarationsFromContainer(container.init));
        }
    }
    else if (ast.isForeachStatement(container)){
        if(container.indexVar){
            declarations.push(container.indexVar)
        }

        declarations.push(container?.valueVar)
    }
    else if (ast.isClassType(container)) {
        // Add class attributes and methods
        declarations.push(...container?.attributes ?? []);
        // Push ClassMethod nodes (not MethodHeader) because ClassMethod is in IdentifiableReference
        // but MethodHeader is not, so Langium's reference type filtering will work correctly
        declarations.push(...container?.methods ?? []);
    }
    else if (ast.isMatchCaseExpression(container)) {
        // Extract all variable bindings from the pattern
        declarations.push(...extractPatternVariables(container.pattern));
    }
    else if (ast.isMatchCaseStatement(container)) {
        // Extract all variable bindings from the pattern
        declarations.push(...extractPatternVariables(container.pattern));
    }
    return declarations;
}

/**
 * Extracts all variable bindings from a match pattern.
 *
 * Uses AstUtils.streamAllContents to traverse the pattern AST and collect
 * all VariablePattern nodes, regardless of nesting depth. This automatically
 * handles all pattern types including nested arrays, structs, and trail variables.
 *
 * **Examples:**
 * - `a` → [VariablePattern{name: "a"}]
 * - `[a, b]` → [VariablePattern{name: "a"}, VariablePattern{name: "b"}]
 * - `[a, b, ...rest]` → [VariablePattern{name: "a"}, VariablePattern{name: "b"}, VariablePattern{name: "rest"}]
 * - `[[a, b], c]` → [VariablePattern{name: "a"}, VariablePattern{name: "b"}, VariablePattern{name: "c"}]
 * - `{x: y}` → [VariablePattern{name: "y"}]
 * - `{name: "Bob", courses: [{name: courseName, ...tail}], ...rest}` → [VariablePattern{name: "courseName"}, VariablePattern{name: "tail"}, VariablePattern{name: "rest"}]
 * - `Result.Ok(value)` → [VariablePattern{name: "value"}]
 */
export function extractPatternVariables(pattern: ast.MatchCasePattern | undefined): ReferencableSymbol[] {
    if (!pattern) {
        return [];
    }

    const variables: ReferencableSymbol[] = [];
    
    // First, check if the pattern itself is a VariablePattern
    // This handles simple cases like: match x { a => ... }
    if (ast.isVariablePattern(pattern)) {
        variables.push(pattern);
    }
    
    // Then, stream all nested contents to find VariablePatterns in complex patterns
    // This handles nested cases like: match x { [a, b] => ..., {x: y} => ... }
    AstUtils.streamAllContents(pattern)
        .filter(node => ast.isVariablePattern(node))
        .forEach(node => {
            variables.push(node);
        }
    );
    
    return variables;
}

export function getVariableDeclarations(block: ast.BlockStatement): ReferencableSymbol[] {
    const declarations: ReferencableSymbol[] = [];
    
    // Visit all children of the block
    for (const statement of block.statements ?? []) {
        if (ast.isVariableDeclarationStatement(statement)) {
            statement.declarations.variables.forEach(v => {
                if(ast.isVariableDeclSingle(v)) {
                    declarations.push(v);
                } else if(ast.isVariableDeclArrayDestructuring(v)
                || ast.isVariableDeclStructDestructuring(v)
                || ast.isVariableDeclTupleDestructuring(v)) {
                    v.elements.forEach(e => declarations.push(e));
                } 
            });
        } else if (ast.isFunctionDeclarationStatement(statement)) {
            declarations.push(statement.fn);
        }
    }
    
    return declarations;
}

export function getNamespaceDeclarations(namespace: ast.NamespaceDecl): ReferencableSymbol[] {
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

export function getGlobalDeclarations(model: ast.Module): ReferencableSymbol[] {
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