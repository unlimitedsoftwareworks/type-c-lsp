import chalk from 'chalk';
import { Command } from 'commander';
import { NodeFileSystem } from 'langium/node';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import { createTypeCServices } from 'type-c-language';
import { buildWorkspace } from './compiler/module-loader.js';
const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

const packagePath = path.resolve(__dirname, '..', 'package.json');
const packageContent = await fs.readFile(packagePath, 'utf-8');

export const generateAction = async (fileName: string, opts: GenerateOptions): Promise<void> => {
    const services = createTypeCServices(NodeFileSystem).TypeC;
    const {documents} = await buildWorkspace(fileName, services);
    const allClean = documents.map(e => e.diagnostics?.filter(e => e.severity === 1)).map(e => e?.length ?? 0).filter( e => e !== 0).length === 0

    if(allClean) {
        console.log(chalk.green(`All good!.`));
    }
    else {
        console.log(chalk.red("Some fails contain errors"))
        let failed = documents.filter(e => (e.diagnostics ?? [])?.filter(e => e.severity === 1).length > 0);
        console.log(chalk.red(failed.map(e => e.uri.path).join(", ")))
    }
};

export type GenerateOptions = {
    destination?: string;
}

export default function(): void {
    const program = new Command();

    program.version(JSON.parse(packageContent).version);

    program
        .command('compile')
        .argument('<folder>', `source folder (containing module.json)`)
        .description('Compiles type-c')
        .action(generateAction);

    program.parse(process.argv);
}
