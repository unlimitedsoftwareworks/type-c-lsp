import { DefaultWorkspaceManager, LangiumDocument, LangiumDocumentFactory, URI, WorkspaceFolder } from "langium";
import { LangiumSharedServices } from "langium/lsp";
import * as path from "node:path";
import { builtins } from "../builtins/index.js";
import { TypeCModuleConfig } from "./tc-module.js";

export class TCWorkspaceManager extends DefaultWorkspaceManager {
    private readonly documentFactory: LangiumDocumentFactory;
    private moduleConfig: TypeCModuleConfig | undefined;
    private moduleRootPath: URI | undefined;

    constructor(services: LangiumSharedServices) {
        super(services);
        this.documentFactory = services.workspace.LangiumDocumentFactory;
    }

    protected override async loadAdditionalDocuments(_folders: WorkspaceFolder[], collector: (document: LangiumDocument) => void): Promise<void> {
        for (const [uri, content] of Object.entries(builtins)) {
            // Skip non-document entries like libraryScheme
            if (uri === 'libraryScheme') continue;
            collector(this.documentFactory.fromString(content, URI.parse(uri)));
        }
    }

    public getModuleConfig(): TypeCModuleConfig | undefined {
        if (this.moduleConfig) {
            return this.moduleConfig;
        }

        const workingDirs = this.folders?.map(folder => URI.parse(folder.uri).fsPath);
        if(!workingDirs) {
            return undefined;
        }

        // find the module.json file in the working directories
        const moduleJsonPaths = workingDirs.map(dir => path.join(dir, 'module.json'));

        // Find the first module.json file that exists
        const moduleJsonPath = moduleJsonPaths.find(path => this.fileSystemProvider.existsSync(URI.parse(path)));
        // Assign the module root to where the module.json file is found
        this.moduleRootPath = moduleJsonPath ? URI.file(path.dirname(moduleJsonPath)) : undefined;
        
        if (!moduleJsonPath) {
            console.error('No module.json file found');
            return undefined;
        }
        const content = this.fileSystemProvider.readFileSync(URI.parse(moduleJsonPath));
        const parsed = JSON.parse(content);
        // Validate it's a proper TypeCModuleConfig object
        if (typeof parsed === 'object' && parsed !== null) {
            this.moduleConfig = parsed;
        }
        return this.moduleConfig;
    }

    /**
     * Returns the dependencies folder for the current module as a URI,
     */
    getDependenciesFolder(): URI | undefined {
        if (!this.moduleConfig?.dependenciesFolder) {
            return undefined;
        }

        return URI.parse(this.moduleConfig?.dependenciesFolder);
    }

    findLibrary(baseName: string): URI | undefined {
        if(!this.moduleConfig) {
            // Try and get the module config 
            this.getModuleConfig();
        }
    
        const sourceFolder = URI.file(path.join(this.moduleRootPath?.fsPath ?? '', this.moduleConfig?.sourceFolder ?? ''));
        const libsFolder = URI.file(path.join(this.moduleRootPath?.fsPath ?? '', this.moduleConfig?.dependenciesFolder ?? ''));

        //console.log(`Source folder: ${sourceFolder.toString()}, libs folder: ${libsFolder.toString()}`);
        
        // Create URIs for the library paths
        const sourceLibrary = URI.file(path.join(sourceFolder.fsPath, baseName));
        const libsLibrary = URI.file(path.join(libsFolder.fsPath, baseName));

        //console.log(`Source library: ${sourceLibrary.toString()}, libs library: ${libsLibrary.toString()}`);
        
        // Check existence with URI objects
        if (this.fileSystemProvider.existsSync(sourceLibrary)) {
            return sourceLibrary;
        }
        if (this.fileSystemProvider.existsSync(libsLibrary)) {
            return libsLibrary;
        }
        return undefined;
    }
}