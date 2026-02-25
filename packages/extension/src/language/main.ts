import { startLanguageServer } from 'langium/lsp';
import { DocumentState } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node.js';
import { createTypeCServices } from 'type-c-language';
import { profiler } from 'type-c-language/profiling';

// Create a connection to the client
const connection = createConnection(ProposedFeatures.all);

// Inject the shared services and language-specific services
const { shared } = createTypeCServices({ connection, ...NodeFileSystem });

// Hook into the validation phase to log profiling data
shared.workspace.DocumentBuilder.onBuildPhase(DocumentState.Validated, (docs) => {
    const report = profiler.report();
    connection.console.log(report);
    connection.console.log(`Documents in this build: ${docs.length}`);
    profiler.reset();
});

// Start the language server with the shared services
startLanguageServer(shared);
