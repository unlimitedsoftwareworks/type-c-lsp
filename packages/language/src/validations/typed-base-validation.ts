import { AstNode, AstUtils, ValidationAcceptor } from "langium";
import { ErrorCode } from "../codes/errors.js";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";
import {
    isErrorType,
    isNullableType,
    isVariantConstructorType,
    TypeDescription
} from "../typing/type-c-types.js";
import { TypeCTypeUtils } from "../typing/type-utils.js";
import { TypeCTypeFactory } from "../typing/type-factory.js";
import { TypeCBaseValidation } from "./base-validation.js";

/**
 * Typed base validation class providing shared helpers for all validators
 * that need access to the type system (type provider, type utils, type factory).
 *
 * Validators that perform type checking should extend this class instead of
 * TypeCBaseValidation directly.
 */
export abstract class TypeCTypedValidation extends TypeCBaseValidation {
    protected readonly typeProvider: TypeCTypeProvider;
    protected readonly typeUtils: TypeCTypeUtils;
    protected readonly typeFactory: TypeCTypeFactory;

    constructor(services: TypeCServices) {
        super();
        this.typeProvider = services.typing.TypeProvider;
        this.typeUtils = services.typing.TypeUtils;
        this.typeFactory = services.typing.TypeFactory;
    }

    /**
     * Check type compatibility using the centralized assignability check.
     */
    protected isTypeCompatible(actual_: TypeDescription, expected_: TypeDescription): { success: boolean; message?: string } {
        const actual = this.typeUtils.resolveIfReference(actual_);
        const expected = this.typeUtils.resolveIfReference(expected_);
        return this.typeUtils.isAssignable(actual, expected);
    }

    /**
     * Check if an expression's type is an error type and report it.
     * Registered for many AST node types to catch type errors during inference.
     */
    checkExpressionForErrors = (node: AstNode, accept: ValidationAcceptor): void => {
        // Trigger type inference (side effect: populates diagnostic map)
        const exprType = this.typeProvider.getType(node);

        // Report only SOURCE errors from the diagnostic map.
        // This prevents cascading: propagated error types from sub-expressions
        // won't produce duplicate diagnostics at every parent node.
        const diagnostics = this.typeProvider.getTypeDiagnostics(node);
        for (const diag of diagnostics) {
            accept('error', diag.message, {
                node,
                code: diag.code || ErrorCode.TC_EXPRESSION_TYPE_ERROR
            });
        }

        // Fallback for errors not yet recorded in the diagnostic map.
        // Report if this is the originating node, or if the origin node
        // has no diagnostics recorded (meaning no one else will report it).
        if (diagnostics.length === 0 && isErrorType(exprType)) {
            const message = exprType.message;

            if (message === '__recursion_placeholder__' ||
                message === '__contextual_placeholder__' ||
                message?.includes('placeholder')) {
                return;
            }

            const originNode = exprType.node;
            const originHasDiagnostics = originNode
                ? this.typeProvider.getTypeDiagnostics(originNode).length > 0
                : false;

            if (originNode === node || !originHasDiagnostics) {
                accept('error', message || 'Type error', {
                    node,
                    code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
                });

                // Mark the origin as "handled" so subsequent expressions in the
                // chain that propagate the same error don't report it again.
                if (originNode && originNode !== node) {
                    this.typeProvider.recordTypeError(originNode, message || 'Type error');
                }
            }
            return;
        }

        const baseExpr = this.typeUtils.resolveIfReference(exprType);

        // Check the errors field for any errors caught during generic substitution
        if (baseExpr.errors && baseExpr.errors.length > 0) {
            for (const errorMsg of baseExpr.errors) {
                accept('error', errorMsg, {
                    node,
                    code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
                });
            }
        }

        // For variant-constructor types, also check the baseVariant's errors
        if (isVariantConstructorType(baseExpr) && baseExpr.baseVariant.errors && baseExpr.baseVariant.errors.length > 0) {
            for (const errorMsg of baseExpr.baseVariant.errors) {
                accept('error', errorMsg, {
                    node,
                    code: ErrorCode.TC_EXPRESSION_TYPE_ERROR
                });
            }
        }
    }

    /**
     * Check if an optional chaining expression returns a basic type without ?? handling.
     */
    checkOptionalChainingBasicType = (node: AstNode, accept: ValidationAcceptor): void => {
        if (!ast.isExpression(node)) {
            return;
        }

        const usesOptionalChaining = this.hasOptionalChaining(node);
        if (!usesOptionalChaining) {
            return;
        }

        const exprType = this.typeProvider.getType(node);

        if (this.typeUtils.isTypeBasic(exprType)) {
            const parent = node.$container;
            const isWrappedWithNullishCoalescing =
                parent &&
                ast.isBinaryExpression(parent) &&
                parent.op === '??' &&
                parent.left === node;

            if (!isWrappedWithNullishCoalescing) {
                const errorCode = ErrorCode.TC_OPTIONAL_CHAINING_BASIC_TYPE_REQUIRES_NULLISH_COALESCING;
                accept('error',
                    `Optional chaining expression returns basic type '${exprType.toString()}' which could be null. ` +
                    `Basic types cannot be nullable, so you must handle the null case using the nullish coalescing operator '??'. ` +
                    `Example: ${node.$cstNode?.text || 'expression'} ?? defaultValue`,
                    {
                        node,
                        code: errorCode
                    }
                );
            }
        }
    }

    /**
     * Helper method to get the name of a referenced entity.
     */
    protected getReferenceName(ref: AstNode): string {
        if (ast.isVariableDeclaration(ref)) {
            return ref.name;
        }
        if (ast.isFunctionParameter(ref)) {
            return ref.name ?? '';
        }
        if (ast.isClassAttributeDecl(ref)) {
            return ref.name;
        }
        if (ast.isIteratorVar(ref)) {
            return ref.name || 'unknown';
        }
        if (ast.isVariablePattern(ref)) {
            return ref.name || 'unknown';
        }
        return 'unknown';
    }

    /**
     * Check if an expression is a const source that requires const assignment.
     *
     * Returns information about the const source if found, undefined otherwise.
     *
     * Const sources include:
     * - Const variables
     * - Immutable parameters (parameters without 'mut')
     * - Members accessed from const variables or immutable parameters
     *
     * @param expr The expression to check
     * @returns Info about the const source if found, undefined otherwise
     */
    protected getConstSource(expr: ast.Expression): { description: string } | undefined {
        // Check qualified references (variables, parameters)
        if (ast.isQualifiedReference(expr)) {
            const ref = expr.reference?.ref;
            if (!ref) {
                return undefined;
            }

            // Const variable
            if (ast.isVariableDeclaration(ref) && ref.isConst) {
                return { description: `const variable '${ref.name}'` };
            }

            // Immutable parameter (parameters are const by default)
            if (ast.isFunctionParameter(ref) && !ref.isMut) {
                return { description: `immutable parameter '${ref.name}'` };
            }

            return undefined;
        }

        // Check member access - if base is const, member access is const
        if (ast.isMemberAccess(expr)) {
            // Check if accessing from a const base
            const baseConstSource = this.getConstSource(expr.expr);
            if (baseConstSource) {
                const element = expr.element?.ref;
                const memberName = element && ast.isClassAttributeDecl(element) ? element.name : 'member';
                return { description: `${baseConstSource.description}.${memberName}` };
            }
            return undefined;
        }

        return undefined;
    }

    /**
     * Helper method to infer return type from a block body.
     * This is extracted from the type provider for reuse in validation.
     */
    protected inferReturnTypeFromBody(body: ast.BlockStatement): TypeDescription {
        const returnStatements = this.collectReturnStatements(body);

        if (returnStatements.length === 0) {
            return this.typeFactory.createVoidType();
        }

        // Get types of all return expressions
        const allReturnTypes = returnStatements
            .map(stmt => stmt.expr ? this.typeProvider.getType(stmt.expr) : this.typeFactory.createVoidType());

        // Filter out recursion placeholders
        const nonPlaceholderTypes = allReturnTypes.filter(type => {
            if (isErrorType(type)) {
                return type.message !== '__recursion_placeholder__';
            }
            return true;
        });

        const returnTypes = nonPlaceholderTypes.length > 0 ? nonPlaceholderTypes : allReturnTypes;

        if (returnTypes.length === 0) {
            return this.typeFactory.createVoidType();
        }

        // Find common type
        return this.typeUtils.getCommonType(returnTypes);
    }

    /**
     * Collect all return statements from a block (only from this function level).
     * Does NOT collect returns from nested functions OR do expressions!
     */
    protected collectReturnStatements(block: ast.BlockStatement): ast.ReturnStatement[] {
        const returns: ast.ReturnStatement[] = [];

        const visit = (node: AstNode) => {
            // Stop if we hit a nested function - don't collect its returns!
            if (ast.isFunctionDeclaration(node) || ast.isLambdaExpression(node)) {
                return;
            }

            // Stop if we hit a do expression - it has its own return scope
            if (ast.isDoExpression(node)) {
                return;
            }

            if (ast.isReturnStatement(node)) {
                returns.push(node);
            }

            // Traverse children
            for (const child of AstUtils.streamContents(node)) {
                visit(child);
            }
        };

        // Visit all statements in the block
        for (const stmt of block.statements || []) {
            visit(stmt);
        }

        return returns;
    }

    /**
     * Helper method to infer yield type from a coroutine body.
     * Similar to inferReturnTypeFromBody but for yield expressions.
     */
    protected inferYieldTypeFromBody(body: ast.BlockStatement): TypeDescription {
        const yieldStatements = this.collectYieldExpressions(body);

        if (yieldStatements.length === 0) {
            return this.typeFactory.createVoidType();
        }

        // Get types of all yield expressions
        const allYieldTypes = yieldStatements
            .map(stmt => stmt.expr ? this.typeProvider.getType(stmt.expr) : this.typeFactory.createVoidType());

        // Filter out recursion placeholders
        const nonPlaceholderTypes = allYieldTypes.filter(type => {
            if (isErrorType(type)) {
                return type.message !== '__recursion_placeholder__';
            }
            return true;
        });

        const yieldTypes = nonPlaceholderTypes.length > 0 ? nonPlaceholderTypes : allYieldTypes;

        if (yieldTypes.length === 0) {
            return this.typeFactory.createVoidType();
        }

        // Find common type
        return this.typeUtils.getCommonType(yieldTypes);
    }

    /**
     * Collect all yield expressions from a block (only from this coroutine level).
     * Does NOT collect yields from nested functions OR do expressions!
     */
    protected collectYieldExpressions(block: ast.BlockStatement): ast.YieldExpression[] {
        const yields: ast.YieldExpression[] = [];

        const visit = (node: AstNode) => {
            // Stop if we hit a nested function or coroutine - don't collect its yields!
            if (ast.isFunctionDeclaration(node) || ast.isLambdaExpression(node) || ast.isCoroutineExpression(node)) {
                return;
            }

            // Stop if we hit a do expression - it has its own scope
            if (ast.isDoExpression(node)) {
                return;
            }

            if (ast.isYieldExpression(node)) {
                yields.push(node);
            }

            // Traverse children
            for (const child of AstUtils.streamContents(node)) {
                visit(child);
            }
        };

        // Visit all statements in the block
        for (const stmt of block.statements || []) {
            visit(stmt);
        }

        return yields;
    }

    /**
     * Helper method to check if a type (after resolution) is a nullable basic type.
     * Returns error message if it is, undefined otherwise.
     */
    protected checkForNullableBasicType(type: TypeDescription): string | undefined {
        // Resolve references to get actual type
        type = this.typeUtils.resolveIfReference(type);

        // Check if it's a nullable basic type
        if (isNullableType(type) && this.typeUtils.isTypeBasic(type.baseType)) {
            return `Nullable basic type '${type.toString()}' is not allowed. ` +
                   `Basic types cannot be nullable. ` +
                   `Consider using a reference type or handling null with the ?? operator.`;
        }

        return undefined;
    }

    /**
     * Check if an expression or any of its parent expressions use optional chaining.
     */
    protected hasOptionalChaining(expr: ast.Expression): boolean {
        if (ast.isMemberAccess(expr)) {
            if (expr.isNullable) {
                return true;
            }
            return this.hasOptionalChaining(expr.expr);
        }

        if (ast.isFunctionCall(expr)) {
            return this.hasOptionalChaining(expr.expr);
        }

        if (ast.isIndexAccess(expr)) {
            return this.hasOptionalChaining(expr.expr);
        }

        if (ast.isReverseIndexAccess(expr)) {
            return this.hasOptionalChaining(expr.expr);
        }

        if (ast.isTypeCastExpression(expr)) {
            return this.hasOptionalChaining(expr.left);
        }

        if (ast.isPostfixOp(expr)) {
            return this.hasOptionalChaining(expr.expr);
        }

        if (ast.isUnaryExpression(expr)) {
            return this.hasOptionalChaining(expr.expr);
        }

        return false;
    }
}
