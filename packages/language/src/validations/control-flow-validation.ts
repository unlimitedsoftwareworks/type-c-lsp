import { AstNode, ValidationAcceptor, ValidationChecks } from "langium";
import * as ast from "../generated/ast.js";
import { ErrorCode } from "../codes/errors.js";
import { TypeCBaseValidation } from "./base-validation.js";
import * as valUtils from "./tc-valdiation-helper.js";

/**
 * Validates control flow statements (break, continue, return).
 *
 * This validator ensures that:
 * 1. `break` statements only appear within loops
 * 2. `continue` statements only appear within loops
 * 3. `return` statements only appear within valid contexts (functions or do-expressions)
 *
 * Valid loop contexts: for, foreach, while, do-while
 * Valid return contexts: functions, lambdas, coroutines, do-expressions
 */
export class TypeCControlFlowValidator extends TypeCBaseValidation {
    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            BreakStatement: this.checkBreakStatement,
            ContinueStatement: this.checkContinueStatement,
            ReturnStatement: this.checkReturnStatement,
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
     * Check if a return statement is within a valid context.
     * Valid contexts are:
     * 1. Inside a function (FunctionDeclaration, LambdaExpression, CoroutineExpression)
     * 2. Inside a do-expression block
     *
     * Additionally checks that:
     * - Returns within do statements cannot have tuple expressions (only functions can return tuples)
     */
    private checkReturnStatement = (node: ast.ReturnStatement, accept: ValidationAcceptor): void => {
        if (!this.isWithinValidReturnContext(node)) {
            const errorCode = ErrorCode.TC_RETURN_OUTSIDE_VALID_CONTEXT;
            accept('error',
                `Control flow error: 'return' statement can only be used inside a function or a 'do' expression.`,
                { node, code: errorCode }
            );
            return;
        }

        // Check if we're in a do expression (not a function)
        const doExpr = valUtils.getContainingDoExpression(node);
        if (doExpr) {
            // Do expressions cannot return tuple expressions
            if (node.expr && ast.isTupleExpression(node.expr) && node.expr.expressions.length > 1) {
                const errorCode = ErrorCode.TC_RETURN_TUPLE_IN_DO_EXPRESSION;
                accept('error',
                    `Control flow error: 'do' expressions cannot return tuple values. Tuple returns are only allowed in functions.`,
                    { node: node.expr, code: errorCode }
                );
            }
        }
    }

    /**
     * Check if a node is within a valid return context.
     * Traverses up the AST tree to find a function or do-expression container.
     */
    private isWithinValidReturnContext(node: AstNode): boolean {
        let current: AstNode | undefined = node.$container;

        while (current) {
            // Check if we're in a function or do-expression
            if (ast.isFunctionDeclaration(current) ||
                ast.isClassMethod(current) ||
                ast.isLambdaExpression(current) ||
                ast.isCoroutineExpression(current) ||
                ast.isDoExpression(current)) {
                return true;
            }

            // Stop at top-level constructs - return doesn't cross these boundaries
            if (ast.isNamespaceDecl(current) ||
                ast.isModule(current)) {
                return false;
            }

            current = current.$container;
        }

        return false;
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