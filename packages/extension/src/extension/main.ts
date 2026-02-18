import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node.js';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node.js';
import { TypeCFileSystemProvider } from './tc-file-system-provider.js';
import { generateAction } from 'type-c-compiler';

let client: LanguageClient;
let compilerOutputChannel: vscode.OutputChannel | undefined;

async function compileProject(): Promise<{ outputTvbc: string } | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('Type-C: No workspace folder is open.');
        return null;
    }
    const projectRoot = workspaceFolder.uri.fsPath;
    if (!fs.existsSync(path.join(projectRoot, 'module.json'))) {
        vscode.window.showErrorMessage('Type-C: No module.json found in workspace root. Is this a Type-C project?');
        return null;
    }
    const outDir = path.join(projectRoot, 'out');
    const outputTvbc = path.join(outDir, 'output.tvbc');
    fs.mkdirSync(outDir, { recursive: true });

    if (!compilerOutputChannel) {
        compilerOutputChannel = vscode.window.createOutputChannel('Type-C Compiler');
    }
    compilerOutputChannel.clear();
    compilerOutputChannel.show(true);
    compilerOutputChannel.appendLine(`Compiling ${projectRoot} ...`);

    try {
        await generateAction(projectRoot, { output: outputTvbc });
        compilerOutputChannel.appendLine(`Done. Output: ${outputTvbc}`);
        return { outputTvbc };
    } catch (e) {
        compilerOutputChannel.appendLine(`Error: ${(e as Error).message}`);
        vscode.window.showErrorMessage(`Type-C compile failed: ${(e as Error).message}`);
        return null;
    }
}

async function compile(): Promise<void> {
    await compileProject();
}

async function compileAndRun(): Promise<void> {
    const result = await compileProject();
    if (!result) return;

    const config = vscode.workspace.getConfiguration('typeC');
    const typevBinaryPath: string = config.get('typevBinaryPath', '');
    if (!typevBinaryPath) {
        vscode.window.showErrorMessage('Type-C: Set "typeC.typevBinaryPath" in settings to run the VM.');
        return;
    }

    if (!compilerOutputChannel) {
        compilerOutputChannel = vscode.window.createOutputChannel('Type-C Compiler');
    }
    compilerOutputChannel.appendLine(`\nRunning: ${typevBinaryPath} ${result.outputTvbc}\n`);
    compilerOutputChannel.show(true);

    const typevDir = path.dirname(typevBinaryPath);
    const proc = spawn(typevBinaryPath, [result.outputTvbc], { cwd: typevDir });

    proc.stdout.on('data', (data: Buffer) => compilerOutputChannel!.append(data.toString()));
    proc.stderr.on('data', (data: Buffer) => compilerOutputChannel!.append(data.toString()));
    proc.on('close', (code: number) => {
        compilerOutputChannel!.appendLine(`\nProcess exited with code ${code}`);
    });
}

// This function is called when the extension is activated.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('tcd', new TypeCFileSystemProvider(), {
        isReadonly: true,
        isCaseSensitive: true
    }));

    context.subscriptions.push(
        vscode.commands.registerCommand('typeC.compile', compile),
        vscode.commands.registerCommand('typeC.compileAndRun', compileAndRun)
    );

    // Set context so keybindings activate in any Type-C workspace
    const isTypeCProject = vscode.workspace.workspaceFolders?.some(
        f => fs.existsSync(path.join(f.uri.fsPath, 'module.json'))
    ) ?? false;
    vscode.commands.executeCommand('setContext', 'typeC.isProject', isTypeCProject);

    client = await startLanguageClient(context);
}

// This function is called when the extension is deactivated.
export function deactivate(): Thenable<void> | undefined {
    if (client) {
        return client.stop();
    }
    return undefined;
}

async function startLanguageClient(context: vscode.ExtensionContext): Promise<LanguageClient> {
    const serverModule = context.asAbsolutePath(path.join('out', 'language', 'main.cjs'));
    // The debug options for the server
    // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging.
    // By setting `process.env.DEBUG_BREAK` to a truthy value, the language server will wait until a debugger is attached.
    const debugOptions = { execArgv: ['--nolazy', `--inspect${process.env.DEBUG_BREAK ? '-brk' : ''}=${process.env.DEBUG_SOCKET || '6009'}`] };

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: '*', language: 'type-c' }]
    };

    // Create the language client and start the client.
    const client = new LanguageClient(
        'type-c',
        'Type-C',
        serverOptions,
        clientOptions
    );

    // Start the client. This will also launch the server
    await client.start();
    return client;
}
