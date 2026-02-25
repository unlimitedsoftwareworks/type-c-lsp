import { AstNode, AstUtils, ValidationAcceptor, ValidationChecks } from "langium";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";
import { TypeCBaseValidation } from "./base-validation.js";

/**
 * Thin Langium validator that:
 * 1. Walks AST calling checkAndStoreErrors() on expression/pattern nodes (triggers lazy inference + error reporting)
 * 2. Triggers declaration-level validation for non-expression nodes
 * 3. Runs deferred validation for class methods (after all types are cached)
 * 4. Replays all stored diagnostics through Langium's ValidationAcceptor
 */
export class TypeDiagnosticsValidator extends TypeCBaseValidation {
    private readonly typeProvider: TypeCTypeProvider;

    constructor(services: TypeCServices) {
        super();
        this.typeProvider = services.typing.TypeProvider;
    }

    getChecks(): ValidationChecks<ast.TypeCAstType> {
        return {
            Module: this.validateModule,
        };
    }

    validateModule = (module: ast.Module, accept: ValidationAcceptor): void => {
        // Step 1: Walk AST triggering inference + validation.
        // For expressions/patterns: checkAndStoreErrors (inference + error type reporting).
        // For FunctionDeclaration/LambdaExpression: inference triggers validation hooks.
        // For ClassMethod: just collect (validation deferred to step 2).
        // For declaration nodes: validateDeclarationNode dispatches to the right check.
        const classMethods: ast.ClassMethod[] = [];
        this.triggerTypeInference(module, classMethods);

        // Step 2: Validate class methods AFTER all types are cached.
        // This avoids cycles that would occur if validation ran during inferClassMethod.
        for (const method of classMethods) {
            this.typeProvider.validateClassMethodReturnType(method);
        }

        // Step 3: Replay diagnostics from the type provider's inference store
        const documentUri = AstUtils.getDocument(module).uri;
        for (const diag of this.typeProvider.getDiagnosticsForDocument(documentUri)) {
            accept(diag.severity, diag.message, {
                node: diag.node,
                code: diag.code,
                property: diag.property as any,
            });
        }
    };

    /**
     * Walk the AST triggering type inference on all relevant nodes.
     * Collects ClassMethod nodes for deferred validation.
     */
    private triggerTypeInference(root: AstNode, classMethods: ast.ClassMethod[]): void {
        const visit = (node: AstNode): void => {
            // Trigger type inference + error storage for expressions and pattern nodes
            if (ast.isExpression(node) || ast.isVariablePattern(node)) {
                this.typeProvider.checkAndStoreErrors(node);
            }

            // Trigger inference for function declarations (validation hooks run during inference)
            if (ast.isFunctionDeclaration(node)) {
                this.typeProvider.getType(node);
            }

            // Collect class methods for deferred validation (don't trigger inference
            // here — early inference of methods before the class type is fully
            // constructed causes wrong types for 'this' references)
            if (ast.isClassMethod(node)) {
                classMethods.push(node);
            }

            // Trigger declaration-level validation for non-expression/non-function nodes
            if (ast.isVariableDeclSingle(node) ||
                ast.isVariableDeclArrayDestructuring(node) ||
                ast.isVariableDeclStructDestructuring(node) ||
                ast.isVariableDeclTupleDestructuring(node) ||
                ast.isFunctionParameter(node) ||
                ast.isClassAttributeDecl(node) ||
                ast.isIteratorVar(node) ||
                ast.isVariablePattern(node) ||
                ast.isForEachIterator(node) ||
                ast.isForRangeIterator(node) ||
                ast.isNullableType(node) ||
                ast.isReferenceType(node) ||
                ast.isQualifiedReference(node) ||
                ast.isDataType(node) ||
                ast.isImplementationMethodDecl(node) ||
                ast.isInterfaceType(node) ||
                ast.isClassType(node) ||
                ast.isImplementationType(node) ||
                ast.isClassImplementationMethodDecl(node) ||
                ast.isMatchCasePattern(node)) {
                this.typeProvider.validateDeclarationNode(node);
            }

            // Recurse into children
            for (const child of AstUtils.streamContents(node)) {
                visit(child);
            }
        };

        visit(root);
    }
}
