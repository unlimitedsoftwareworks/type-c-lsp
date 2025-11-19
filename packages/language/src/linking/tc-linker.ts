import { AstNode, AstNodeDescription, DefaultLinker, LinkingError, Reference, ReferenceInfo, stream } from "langium";
import * as ast from "../generated/ast.js";
import { TypeCServices } from "../type-c-module.js";
import { TypeCTypeProvider } from "../typing/type-c-type-provider.js";
import { FunctionTypeDescription, isFunctionType } from "../typing/type-c-types.js";

export interface TCReferenceInfo extends ReferenceInfo {
    reference: Reference
    container: AstNode
    property: string
    index?: number
	candidates: AstNodeDescription[]
}


export class TypeCLinker extends DefaultLinker {
	private readonly typeProvider: TypeCTypeProvider;
	// Store candidates for references that need overload resolution
	private readonly candidateMap = new WeakMap<Reference, AstNodeDescription[]>();

	constructor(services: TypeCServices) {
		super(services);
		this.typeProvider = services.typing.TypeProvider;
	}

	/**
	 * Get candidates for a reference (used by type provider for overload resolution)
	 */
	getCandidatesForReference(ref: Reference): AstNodeDescription[] | undefined {
		return this.candidateMap.get(ref);
	}

    override getCandidate(refInfo: TCReferenceInfo): AstNodeDescription | LinkingError {
        const scope = this.scopeProvider.getScope(refInfo);
        const unfilteredDescriptions = scope.getAllElements().filter(e => e.name === refInfo.reference.$refText);
		// Remove duplicates (same path, different names)
		const allDescriptions = stream(unfilteredDescriptions.reduce((acc, d) => {
			if(!acc.some(t => t.path === d.path)) {
				acc.push(d);
			}
			return acc;
		}, [] as AstNodeDescription[]));
		refInfo.candidates = allDescriptions.toArray();

		// Store candidates in WeakMap for type provider to access later
		if (allDescriptions.count() > 1) {
			this.candidateMap.set(refInfo.reference, refInfo.candidates);
		}
		
		if((ast.isFunctionCall(refInfo.container.$container) || ast.isFunctionCall(refInfo.container?.$container?.$container))&& allDescriptions.count() > 1) {
			const fnCallNode = ast.isFunctionCall(refInfo.container.$container) ? refInfo.container.$container : refInfo.container?.$container?.$container as ast.FunctionCall;
			if(!fnCallNode) {
				return {
					info: refInfo,
					message: `Unknown  reference to '${refInfo.reference.$refText}', no function call node found.`,
				};
			}

			const candidates = this.typeProvider.resolveFunctionCall(
				fnCallNode.args, 
				allDescriptions
					.toArray()
					.map(d => this.typeProvider.getType(d.node as ast.FunctionDeclaration))
					.filter(d => isFunctionType(d)) as FunctionTypeDescription[]
			);
			if(candidates.length === 1) {
				return allDescriptions.toArray()[candidates[0]];
			}
			else if(candidates.length > 1) {
				return {
					info: refInfo,
					message: `Ambiguous reference to '${refInfo.reference.$refText}', too many candidates.`,
				};
			}
		}

		if(allDescriptions.count() === 1) {
			return allDescriptions.toArray()[0];
		}
		else if(allDescriptions.count() > 1) {
			// Multiple candidates but not in a function call context
			// Return first candidate as placeholder - type provider will resolve based on expected type
			return allDescriptions.toArray()[0];
		}
		else {
			return this.createLinkingError(refInfo);
		}
    }

	override getCandidates(refInfo: ReferenceInfo): AstNodeDescription[] | LinkingError {
		const scope = this.scopeProvider.getScope(refInfo);
		const unfilteredDescriptions = scope.getAllElements().filter(e => e.name === refInfo.reference.$refText);
		// Remove duplicates (same path, different names)
		const allDescriptions = stream(unfilteredDescriptions.reduce((acc, d) => {
			if(!acc.some(t => t.path === d.path)) {
				acc.push(d);
			}
			return acc;
		}, [] as AstNodeDescription[]));

		return allDescriptions.toArray();
	}
}
