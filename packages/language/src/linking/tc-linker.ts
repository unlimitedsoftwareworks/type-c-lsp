import { AstNodeDescription, DefaultLinker, LinkingError, ReferenceInfo, stream } from "langium";
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
		const allDescriptions = stream(unfilteredDescriptions.reduce((acc, d) => {
			if(!acc.some(t => t.path === d.path)) {
				acc.push(d);
			}
			return acc;
		}, [] as AstNodeDescription[]));

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

		if(allDescriptions.count() > 0) {
			return allDescriptions.toArray()[0];
		}
		else if(allDescriptions.count() > 1) {
			// if we are not referencing a function, we just grab the first one (could be improved later)
			if(allDescriptions.map((d) => {
				const node = d.node;
				if(ast.isFunctionDeclaration(node) || ast.isMethodHeader(node)) {
					return true;
				}
				return false;
			}).reduce((acc, curr) => acc || curr, false)) {
				return allDescriptions.toArray()[0];
			}
			return {
				info: refInfo,
				message: `Ambiguous reference to '${refInfo.reference.$refText}', too many candidates.`,
			};
		}
		else {
			return this.createLinkingError(refInfo);
		}
    }
}
