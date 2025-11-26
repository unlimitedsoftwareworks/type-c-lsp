import { AstNode, EmptyFileSystem, isAstNode, LangiumCoreServices, LangiumSharedCoreServices, type LangiumDocument } from "langium";
import { expandToString as s } from "langium/generate";
import { clearDocuments, parseHelper } from "langium/test";
import { createTypeCServices, isModule, Module } from "type-c-language";
import { expect } from "vitest";
import type { Diagnostic } from "vscode-languageserver-types";
import { LibraryScheme } from "../src/builtins/index.js";

export function setupLanguageServices() {
    let services: ReturnType<typeof createTypeCServices> = createTypeCServices(EmptyFileSystem);
    const initialized = services.shared.workspace.WorkspaceManager.initializeWorkspace([]);
    const parseHelp = parseHelper<Module>(services.TypeC);
    let parse:    ReturnType<typeof parseHelper<Module>> = async (input, options) => {
        await initialized;
        return parseHelp(input, options);
    };
    const typeProvider = services.TypeC.typing.TypeProvider;

    expect.extend({
        
        toHaveType(received: unknown, expected: string) {
            const { isNot } = this;
            if (!isAstNode(received)) {
                throw new Error('Did not receive an AstNode.');
            }
            const typeName = typeProvider.getType(received).toString();
            return {
                pass: (typeName !== expected) === Boolean(isNot),
                message: () => {
                    return isNot
                        ? `Received '${typeName}' but expected another type`
                        : `Expected type '${expected}', but got '${typeName}'`;
                }
            }
        },
        toExpectType(_received: unknown, _expected: string) {
            return {
                pass: false,
                message: () => 'Not implemented'
            }
        },
        /**
         * Makes sure the document is completely valid, 
         * no parse errors and/or no validation errors.
         */
        toBeValidDocument<T extends AstNode>(received: LangiumDocument<T>) {
            let parseErrors =  received.parseResult.parserErrors.length;
            let validationErrors = received.diagnostics?.length ?? 0;
            return {
                pass: parseErrors === 0 && validationErrors === 0,
                message: () => {
                    return parseErrors 
                        ? `Document is not valid as parser errors are present: ${received.parseResult.parserErrors.map(e => e.message).join('\n')}` 
                        : validationErrors 
                            ? `Document is not valid as validation errors are present: ${received.diagnostics?.map(e => e.message).join('\n')}` 
                            : 'Document is valid';
                }
            }
        }
    });

    return {
        services,
        parse,
        parseAndValidate: (input: string) => parse(input, { validation: true }),
        initialized,
        typeProvider
    }
}

/**
 * Convenience checker asserting the satisfaction of 'condition'.
 * Can nicely be used for the sake of asserting the 'defined'-ness of a variable, like
 *
 *      const newOrderSingleDecl = messages[0].declRef.ref
 *      expect(newOrderSingleDecl?.name).toBe('NewOrderSingle');
 *      expectValid(newOrderSingleDecl);
 *      ...
 */
export function expectValid(condition: unknown): asserts condition {
    expect(condition, 'Condition does not hold.').toBeTruthy();
}

export function checkDocumentValid(document: LangiumDocument): string | undefined {
    return document.parseResult.parserErrors.length && s`
        Parser errors:
          ${document.parseResult.parserErrors.map(e => `Line ${e.token.startLine}, pos ${e.token.startColumn}: ${e.message}`).join('\n  ')}
    `
        || document.parseResult.value === undefined && `ParseResult is 'undefined'.`
        || !isModule(document.parseResult.value) && `Root AST object is a ${document.parseResult.value.$type}, expected a '${Module}'.`
        || undefined;
}

export async function clearFileDocuments(services: LangiumSharedCoreServices | LangiumCoreServices): Promise<void> {
    const shared = 'shared' in services ? services.shared : services;
    const docs = shared.workspace.LangiumDocuments.all.filter(e => e.uri.scheme !== LibraryScheme).toArray();
    await clearDocuments(services, docs);
}

export function diagnosticToString(d: Diagnostic) {
    return `[${d.range.start.line}:${d.range.start.character}..${d.range.end.line}:${d.range.end.character}]: ${d.message}`;
}