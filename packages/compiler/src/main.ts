import chalk from 'chalk';
import { Command } from 'commander';
import { NodeFileSystem } from 'langium/node';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';
import { createTypeCServices } from 'type-c-language';
import { buildWorkspace } from './compiler/module-loader.js';
import { IRGenerator } from './compiler/tc-compiler.js';
import { serializeProgram } from './ir/serializer.js';
import { generateBytecode } from './codegen/index.js';
export const generateAction = async (fileName: string, opts: GenerateOptions): Promise<void> => {
    const services = createTypeCServices(NodeFileSystem).TypeC;
    const {documents} = await buildWorkspace(fileName, services);
    const allClean = documents.map(e => e.diagnostics?.filter(e => e.severity === 1)).map(e => e?.length ?? 0).filter( e => e !== 0).length === 0

    if(allClean) {
        console.log(chalk.green(`All documents are valid!.`));
    }
    else {
        console.log(chalk.red("Some fails contain errors"))
        let failed = documents.filter(e => (e.diagnostics ?? [])?.filter(e => e.severity === 1).length > 0);
        const failedPaths = failed.map(e => e.uri.path).join(", ");
        console.log(chalk.red(failedPaths))
        throw new Error(`Compilation failed: errors in ${failedPaths}`);
    }

    let generator = new IRGenerator(services);
    const irProgram = generator.generate(documents);

    // Code generation: IR → Type-V bytecode
    if (irProgram) {
        try {
            const outPath = opts.output
                ?? path.join(opts.destination ?? path.dirname(fileName), 'output.tvbc');
            const outPathParsed = path.parse(outPath);
            const irPath = path.join(outPathParsed.dir, `${outPathParsed.name}.ir`);

            // Always emit textual IR next to the bytecode output for easy debugging/grep.
            await fs.writeFile(irPath, serializeProgram(irProgram));
            console.log(chalk.green(`IR written to ${irPath}`));

            const binary = generateBytecode(irProgram);
            await fs.writeFile(outPath, binary);
            console.log(chalk.green(`Bytecode written to ${outPath} (${binary.length} bytes)`));
        } catch (e) {
            const message = (e as Error).message;
            console.log(chalk.red(`Codegen failed: ${message}`));
            throw new Error(`Codegen failed: ${message}`);
        }
    }
};

export type GenerateOptions = {
    destination?: string;
    output?: string;
}

export default async function(): Promise<void> {
    const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
    const packagePath = path.resolve(__dirname, '..', 'package.json');
    const packageContent = await fs.readFile(packagePath, 'utf-8');
    const program = new Command();

    program.version(JSON.parse(packageContent).version);

    program
        .command('compile')
        .argument('<folder>', `source folder (containing module.json)`)
        .option('-o, --output <path>', 'output file path for the .tvbc binary')
        .description('Compiles type-c')
        .action(async (folder, opts) => {
            try {
                await generateAction(folder, opts);
            } catch {
                process.exit(-1);
            }
        });

    program.parse(process.argv);
}
