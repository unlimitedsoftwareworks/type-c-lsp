import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node.js';
import { createTypeCServices } from 'type-c-language';

// Create a connection to the client
const connection = createConnection(ProposedFeatures.all);

// Inject the shared services and language-specific services
const { shared } = createTypeCServices({ connection, ...NodeFileSystem });

// Start the language server with the shared services
startLanguageServer(shared);
