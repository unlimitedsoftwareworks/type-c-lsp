import { AstNode, AstUtils, ValidationAcceptor, ValidationChecks } from "langium";
import * as ast from "../generated/ast.js";
import { ErrorCode } from "../codes/errors.js";
import { TypeCBaseValidation } from "./base-validation.js";

/**
 * Validates that variables are not used before they are declared.
 * 
 * This validator ensures proper declaration order by checking that:
 * 1. Variables are declared before they are referenced
 * 2. Variables are not used in their own initialization expression
 * 3. Variables in the same block are declared before use
 * 
 * Note: This validation only applies to local variables within the same scope.
 * Global variables, function parameters, and imported symbols are handled separately.
 */
export class TypeCVariableUsageValidator extends TypeCBaseValidation {
    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            QualifiedReference: this.checkVariableUsage,
        };
    }

    /**
     * Check if a variable reference occurs before its declaration.
     */
    private checkVariableUsage = (node: ast.QualifiedReference, accept: ValidationAcceptor): void => {
        // Get the referenced declaration
        const ref = node.reference?.ref;
        if (!ref) {
            // Reference is not resolved, linker will handle this
            return;
        }

        // Only check variable declarations (not functions, types, etc.)
        if (!ast.isVariableDeclaration(ref) && !ast.isDestructuringElement(ref)) {
            return;
        }

        // Find the container where the variable is declared
        const declarationContainer = this.findDeclarationContainer(ref);
        if (!declarationContainer) {
            return;
        }

        // Find the container where the variable is used
        const usageContainer = this.findUsageContainer(node);
        if (!usageContainer) {
            return;
        }

        // Check if they're in the same container
        if (declarationContainer !== usageContainer) {
            return;
        }

        // Check if usage comes before declaration in the same block
        if (ast.isBlockStatement(declarationContainer)) {
            if (this.isUsedBeforeDeclaredInBlock(node, ref, declarationContainer)) {
                const errorCode = ErrorCode.TC_VARIABLE_USED_BEFORE_DECLARATION;
                accept('error',
                    `Variable usage error: Variable '${this.getVariableName(ref)}' is used before it is declared. Declare variables before using them.`,
                    { node, code: errorCode }
                );
            }
        }
        // Check if variable is used in its own initializer
        else if (this.isUsedInOwnInitializer(node, ref)) {
            const errorCode = ErrorCode.TC_VARIABLE_USED_BEFORE_DECLARATION;
            accept('error',
                `Variable usage error: Variable '${this.getVariableName(ref)}' is used in its own initializer expression. A variable cannot reference itself during initialization.`,
                { node, code: errorCode }
            );
        }
    }

    /**
     * Get the variable name from a declaration or destructuring element.
     */
    private getVariableName(decl: ast.VariableDeclaration | ast.DestructuringElement): string {
        if (ast.isVariableDeclaration(decl)) {
            return decl.name;
        }
        return decl.name || '_';
    }

    /**
     * Find the container where the variable is declared.
     * This could be a BlockStatement, Module, LetInExpression, etc.
     */
    private findDeclarationContainer(decl: ast.VariableDeclaration | ast.DestructuringElement): AstNode | undefined {
        let current: AstNode | undefined = decl;
        
        while (current) {
            // For simple variable declarations
            if (ast.isVariableDeclaration(current)) {
                current = current.$container;
                continue;
            }
            
            // For destructuring elements
            if (ast.isDestructuringElement(current)) {
                current = current.$container;
                continue;
            }

            // For variables declarations statement
            if (ast.isVariablesDeclarations(current)) {
                current = current.$container;
                continue;
            }

            // For variable declaration statements
            if (ast.isVariableDeclarationStatement(current)) {
                current = current.$container;
                continue;
            }

            // Found a scope container
            if (ast.isBlockStatement(current) || 
                ast.isModule(current) || 
                ast.isLetInExpression(current) ||
                ast.isForStatement(current)) {
                return current;
            }

            current = current.$container;
        }

        return undefined;
    }

    /**
     * Find the container where the variable is being used.
     */
    private findUsageContainer(node: ast.QualifiedReference): AstNode | undefined {
        let current: AstNode | undefined = node.$container;

        while (current) {
            if (ast.isBlockStatement(current) || 
                ast.isModule(current) || 
                ast.isLetInExpression(current) ||
                ast.isForStatement(current)) {
                return current;
            }
            current = current.$container;
        }

        return undefined;
    }

    /**
     * Check if a variable is used before it's declared in a block statement.
     */
    private isUsedBeforeDeclaredInBlock(
        usage: ast.QualifiedReference, 
        decl: ast.VariableDeclaration | ast.DestructuringElement, 
        block: ast.BlockStatement
    ): boolean {
        // Find the statement containing the declaration
        const declStatement = this.findContainingStatement(decl, block);
        if (!declStatement) {
            return false;
        }

        // Find the statement containing the usage
        const usageStatement = this.findContainingStatement(usage, block);
        if (!usageStatement) {
            return false;
        }

        // Get the indices of both statements in the block
        const declIndex = block.statements.indexOf(declStatement);
        const usageIndex = block.statements.indexOf(usageStatement);

        // If both indices are valid and usage comes before declaration
        if (declIndex >= 0 && usageIndex >= 0 && usageIndex < declIndex) {
            return true;
        }

        // If they're in the same statement, check if usage is in the initializer
        if (declIndex === usageIndex) {
            return this.isUsedInOwnInitializer(usage, decl);
        }

        return false;
    }

    /**
     * Find the statement in a block that contains the given node.
     */
    private findContainingStatement(node: AstNode, block: ast.BlockStatement): ast.Statement | undefined {
        let current: AstNode | undefined = node;

        while (current && current !== block) {
            if (ast.isStatement(current) && block.statements.includes(current)) {
                return current;
            }
            current = current.$container;
        }

        return undefined;
    }

    /**
     * Check if a variable is used in its own initializer.
     * Example: let x = x + 1; // Error: x used in its own initializer
     */
    private isUsedInOwnInitializer(usage: ast.QualifiedReference, decl: ast.VariableDeclaration | ast.DestructuringElement): boolean {
        // Find the variable declaration that contains this declaration
        let varDecl: ast.VariableDeclaration | undefined;
        
        if (ast.isVariableDeclaration(decl)) {
            varDecl = decl;
        } else if (ast.isDestructuringElement(decl)) {
            // For destructuring, find the parent variable declaration
            let current: AstNode | undefined = decl.$container;
            while (current) {
                if (ast.isVariableDeclaration(current)) {
                    varDecl = current;
                    break;
                }
                current = current.$container;
            }
        }

        if (!varDecl || !varDecl.initializer) {
            return false;
        }

        // Check if the usage is within the initializer
        return AstUtils.hasContainerOfType(usage, (n): n is ast.Expression => n === varDecl.initializer);
    }
}