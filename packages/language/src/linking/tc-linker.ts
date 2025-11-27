import { AstNodeDescription, DefaultLinker, LinkingError, ReferenceInfo } from "langium";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";
import { FunctionTypeDescription, isFunctionType } from "../typing/type-c-types.js";

export class TypeCLinker extends DefaultLinker {
    private readonly typeProvider: TypeCTypeProvider;

    constructor(services: TypeCServices) {
        super(services);
        this.typeProvider = services.typing.TypeProvider;
    }

    override getCandidate(refInfo: ReferenceInfo): AstNodeDescription | LinkingError {
        const scope = this.scopeProvider.getScope(refInfo);
        const unfilteredDescriptions = scope.getAllElements().filter(e => e.name === refInfo.reference.$refText);

        // Remove duplicates (same path, different names)
        const uniqueDescriptions: AstNodeDescription[] = [];
        for (const d of unfilteredDescriptions) {
            if (!uniqueDescriptions.some(t => t.path === d.path)) {
                uniqueDescriptions.push(d);
            }
        }
        const allDescArray = uniqueDescriptions;

        // If only one or no candidates, return immediately
        if (allDescArray.length === 0) {
            return this.createLinkingError(refInfo);
        }
        if (allDescArray.length === 1) {
            return allDescArray[0];
        }

        // Multiple candidates - check if we should resolve overloads
        const fnCallNode = this.getFunctionCallContext(refInfo);
        const shouldResolveOverload = fnCallNode !== undefined &&
            this.allCandidatesAreFunctions(allDescArray);

        if (shouldResolveOverload) {
            return this.resolveOverloadedFunction(fnCallNode!, allDescArray, refInfo);
        }

        // Not resolving overload - return first candidate (closest scope)
        return allDescArray[0];
    }

    /**
     * Checks if the reference is within a function call context
     */
    private getFunctionCallContext(refInfo: ReferenceInfo): ast.FunctionCall | undefined {
        const directParent = refInfo.container.$container;
        const grandParent = refInfo.container.$container?.$container;

        if (ast.isFunctionCall(directParent)) {
            return directParent;
        }
        if (ast.isFunctionCall(grandParent)) {
            return grandParent;
        }
        return undefined;
    }

    /**
     * Checks if all candidates are function declarations.
     * This is important to avoid triggering type inference on variables
     * that might be in the middle of initialization (shadowing case).
     */
    private allCandidatesAreFunctions(candidates: AstNodeDescription[]): boolean {
        return candidates.every(d =>
            ast.isFunctionDeclaration(d.node) ||
            ast.isClassMethod(d.node) ||
            ast.isImplementationMethodDecl(d.node) ||
            ast.isBuiltinSymbolFn(d.node) ||
            ast.isMethodHeader(d.node)
        );
    }

    /**
     * Resolves function overloads by comparing argument types
     */
    private resolveOverloadedFunction(
        fnCallNode: ast.FunctionCall,
        candidates: AstNodeDescription[],
        refInfo: ReferenceInfo
    ): AstNodeDescription | LinkingError {
        const candidateTypes = candidates
            .map(d => {
                if (ast.isFunctionDeclaration(d.node) ||
                    ast.isClassMethod(d.node) ||
                    ast.isImplementationMethodDecl(d.node) ||
                    ast.isBuiltinSymbolFn(d.node) ||
                    ast.isMethodHeader(d.node) 
                ) {
                    return this.typeProvider.getType(d.node);
                }
                return undefined;
            })
            .filter((d): d is FunctionTypeDescription => d !== undefined && isFunctionType(d));

        const matchingIndices = this.typeProvider.resolveFunctionCall(fnCallNode.args, candidateTypes);

        if (matchingIndices.length === 1) {
            return candidates[matchingIndices[0]];
        }

        if (matchingIndices.length > 1) {
            return {
                info: refInfo,
                message: `Ambiguous reference to '${refInfo.reference.$refText}', too many candidates.`,
            };
        }

        // No matches found - return first candidate
        return candidates[0];
    }
}
