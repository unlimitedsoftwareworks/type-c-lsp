import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URI, type WorkspaceFolder } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { parseHelper } from 'langium/test';
import { createTypeCServices, type Module } from 'type-c-language';
import { describe, expect, test } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.join(__dirname, 'test-cases/import-overload-workspace');

async function getErrorsForSource(documentName: string, source: string) {
    const services = createTypeCServices(NodeFileSystem);
    const workspaceFolder: WorkspaceFolder = {
        uri: URI.file(workspaceRoot).toString(),
        name: 'import-overload-workspace'
    };

    await services.shared.workspace.WorkspaceManager.initializeWorkspace([workspaceFolder]);

    const parse = parseHelper<Module>(services.TypeC);
    const document = await parse(source, {
        documentUri: URI.file(path.join(workspaceRoot, '__tmp__', `${documentName}.tc`)).toString(),
        validation: true
    });

    return (document.diagnostics ?? []).filter(d => d.severity === 1);
}

describe('Import overload scope resolution', () => {
    test('named imports include all overloads with the same function name', async () => {
        const errors = await getErrorsForSource('named-overload', `
from import_overload.library import pick

fn main() {
    let a: u32 = pick(1u32)
    let b: string = pick("hello")
}
`);

        expect(errors).toHaveLength(0);
    });

    test('aliased named imports include all overloads with the same function name', async () => {
        const errors = await getErrorsForSource('aliased-overload', `
from import_overload.library import pick as choose

fn main() {
    let a: u32 = choose(1u32)
    let b: string = choose("hello")
}
`);

        expect(errors).toHaveLength(0);
    });

    test('named import does not leak non-imported declarations', async () => {
        const errors = await getErrorsForSource('no-leak', `
from import_overload.library import pick

fn main() {
    let a: u32 = pick(1u32)
    let b = keep(true)
}
`);

        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some(error => error.message.includes('keep'))).toBe(true);
    });
});
