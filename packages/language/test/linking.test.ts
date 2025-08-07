import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { EmptyFileSystem, type LangiumDocument } from "langium";
import { expandToString as s } from "langium/generate";
import { clearDocuments, parseHelper } from "langium/test";
import type { Module } from "type-c-language";
import { createTypeCServices, isModule } from "type-c-language";

let services: ReturnType<typeof createTypeCServices>;
let parse:    ReturnType<typeof parseHelper<Module>>;
let document: LangiumDocument<Module> | undefined;

beforeAll(async () => {
    services = createTypeCServices(EmptyFileSystem);
    parse = parseHelper<Module>(services.TypeC);

    // activate the following if your linking test requires elements from a built-in library, for example
    // await services.shared.workspace.WorkspaceManager.initializeWorkspace([]);
});

afterEach(async () => {
    document && clearDocuments(services.shared, [ document ]);
});

describe('Linking tests', () => {

    test('linking of greetings', async () => {
        document = await parse(`
            person Langium
            Hello Langium!
        `);

        expect(
            checkDocumentValid(document)
        ).toBe(s`
            Langium
        `);
    });
});

function checkDocumentValid(document: LangiumDocument): string | undefined {
    return document.parseResult.parserErrors.length && s`
        Parser errors:
          ${document.parseResult.parserErrors.map(e => e.message).join('\n  ')}
    `
        || document.parseResult.value === undefined && `ParseResult is 'undefined'.`
        || !isModule(document.parseResult.value) && `Root AST object is a ${document.parseResult.value.$type}, expected a 'Module'.`
        || undefined;
}
