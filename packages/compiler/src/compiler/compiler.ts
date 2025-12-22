
import type { TypeCModuleConfig, TypeCServices } from 'type-c-language';

import chalk from 'chalk';
import type { LangiumDocument } from 'langium';
import { URI } from 'langium';
import * as fs from 'node:fs';
import * as path from 'node:path';

function fail(msg: string) {
    console.error(chalk.red(msg));
    process.exit(1);
}

export async function buildWorkspace(dirPath: string, services: TypeCServices): Promise<{entry: LangiumDocument, documents: LangiumDocument[]}> {
    const configPath = path.join(dirPath, "module.json");
    if(!fs.existsSync(configPath)){
        fail(`Folder ${dirPath} is not a valid Type-C Project.`);
    }

    const config: TypeCModuleConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    if(!config) {
        fail(`Config ${configPath} is invalid`);
    }

    const folderPath = path.dirname(configPath)
    const folderName = path.basename(folderPath);;
    console.log({name: folderName, uri: URI.file(path.resolve(folderName)).fsPath})
    await services.shared.workspace.WorkspaceManager.initializeWorkspace([{name: folderName, uri: URI.file(path.resolve(folderPath)).fsPath}])

    const docs = (await services.shared.workspace.LangiumDocuments.all).toArray();
    console.log(docs.length, "Documents found", docs.map(e => e.uri.fsPath).join('\n'))
    
    const document = await services.shared.workspace.LangiumDocuments.getDocument(URI.file(path.resolve(
        path.join(dirPath, config.sourceFolder, config.compiler.entry)
    )));

    if(!document) {
        fail("Entry file not found");
    }

    const allDocs = (await services.shared.workspace.LangiumDocuments.all).toArray();

    await services.shared.workspace.DocumentBuilder.build(allDocs, { validation: true,  });

    const validationErrors = (document?.diagnostics ?? []).filter(e => e.severity === 1);
    if (validationErrors.length > 0) {
        console.error(chalk.red('There are validation errors:'));
        for (const validationError of validationErrors) {
            console.error(chalk.red(
                `line ${validationError.range.start.line + 1}: ${validationError.message} [${document?.textDocument.getText(validationError.range)}]`
            ));
        }
        process.exit(1);
    }

    return {
        entry: document!,
        documents: allDocs
    }!;
}
