import * as vscode from 'vscode';
import { builtins } from '../../../language/src/builtins/index.js';

const buffers = Object.fromEntries(
    Object.entries(builtins).map(([path, content]) => [path, Buffer.from(content)])
);

export class TypeCFileSystemProvider implements vscode.FileSystemProvider {

    onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event;
    watch(): vscode.Disposable {
        return new vscode.Disposable(() => { });
    }
    stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
        const content = buffers[uri.toString(true)];
        if (content) {
            return {
                type: vscode.FileType.File,
                ctime: 0,
                mtime: 0,
                size: content.length
            }
        } else {
            throw new Error('File not found');
        }
    }
    readDirectory(): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
        throw new Error('Method not implemented.');
    }
    createDirectory(): void | Thenable<void> {
        throw new Error('Method not implemented.');
    }
    readFile(uri: vscode.Uri): Uint8Array | Thenable<Uint8Array> {
        const content = buffers[uri.toString(true)];
        return content;
    }
    writeFile(): void | Thenable<void> {
        throw new Error('Method not implemented.');
    }
    delete(): void | Thenable<void> {
        throw new Error('Method not implemented.');
    }
    rename(): void | Thenable<void> {
        throw new Error('Method not implemented.');
    }
}
