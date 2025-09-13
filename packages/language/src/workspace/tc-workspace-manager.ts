import { DefaultWorkspaceManager, LangiumDocument, LangiumDocumentFactory, URI, WorkspaceFolder } from "langium";
import { LangiumSharedServices } from "langium/lsp";
import { builtins } from "../builtins/index.js";

export class TCWorkspaceManager extends DefaultWorkspaceManager {
    private readonly documentFactory: LangiumDocumentFactory;

    constructor(services: LangiumSharedServices) {
        super(services);
        this.documentFactory = services.workspace.LangiumDocumentFactory;
    }

    protected override async loadAdditionalDocuments(_folders: WorkspaceFolder[], collector: (document: LangiumDocument) => void): Promise<void> {
        for (const [uri, content] of Object.entries(builtins)) {
            collector(this.documentFactory.fromString(content, URI.parse(uri)));
        }
    }
}