import { AstNode, ValidationAcceptor, ValidationChecks } from "langium";
import * as ast from "../generated/ast.js";
import { ErrorCode } from "../codes/errors.js";
import { TypeCBaseValidation } from "./base-validation.js";

/**
 * Validates control flow statements (break, continue).
 * 
 * This validator ensures that:
 * 1. `break` statements only appear within loops
 * 2. `continue` statements only appear within loops
 * 
 * Valid loop contexts: for, foreach, while, do-while
 */
export class TypeCControlFlowValidator extends TypeCBaseValidation {
    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            BreakStatement: this.checkBreakStatement,
            ContinueStatement: this.checkContinueStatement,
        };
    }

    /**
     * Check if a break statement is within a loop.
     */
    private checkBreakStatement = (node: ast.BreakStatement, accept: ValidationAcceptor): void => {
        if (!this.isWithinLoop(node)) {
            const errorCode = ErrorCode.TC_BREAK_OUTSIDE_LOOP;
            accept('error',
                `Control flow error: 'break' statement can only be used inside a loop (for, foreach, while, do-while).`,
                { node, code: errorCode }
            );
        }
    }

    /**
     * Check if a continue statement is within a loop.
     */
    private checkContinueStatement = (node: ast.ContinueStatement, accept: ValidationAcceptor): void => {
        if (!this.isWithinLoop(node)) {
            const errorCode = ErrorCode.TC_CONTINUE_OUTSIDE_LOOP;
            accept('error',
                `Control flow error: 'continue' statement can only be used inside a loop (for, foreach, while, do-while).`,
                { node, code: errorCode }
            );
        }
    }

    /**
     * Check if a node is within a loop statement.
     * Traverses up the AST tree to find a loop container.
     */
    private isWithinLoop(node: AstNode): boolean {
        let current: AstNode | undefined = node.$container;

        while (current) {
            // Check if we're in a loop statement
            if (ast.isForStatement(current) ||
                ast.isForeachStatement(current) ||
                ast.isWhileStatement(current) ||
                ast.isDoWhileStatement(current)) {
                return true;
            }

            // Stop at function/coroutine boundaries - loops don't cross function boundaries
            if (ast.isFunctionDeclaration(current) ||
                ast.isLambdaExpression(current) ||
                ast.isCoroutineExpression(current)) {
                return false;
            }

            current = current.$container;
        }

        return false;
    }
}