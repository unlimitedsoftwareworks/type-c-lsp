import { DefaultDocumentBuilder, DocumentState, type LangiumDocument, type LangiumSharedCoreServices, type MaybePromise } from 'langium';
import type { CancellationToken } from 'vscode-jsonrpc';
import * as path from 'node:path';
import { TCProfiler, type ProfilingPhase } from './tc-profiler.js';

const STATE_PHASE: Partial<Record<number, ProfilingPhase>> = {
    [DocumentState.Parsed]: 'parsing',
    [DocumentState.Linked]: 'linking',
    [DocumentState.Validated]: 'validating',
};

export class TCDocumentBuilder extends DefaultDocumentBuilder {
    readonly profiler = new TCProfiler();

    constructor(services: LangiumSharedCoreServices) {
        super(services);
    }

    protected override runCancelable(
        documents: LangiumDocument[],
        targetState: DocumentState,
        cancelToken: CancellationToken,
        callback: (document: LangiumDocument) => MaybePromise<unknown>,
    ): Promise<void> {
        const phase = STATE_PHASE[targetState];
        if (!phase) {
            return super.runCancelable(documents, targetState, cancelToken, callback);
        }

        return super.runCancelable(documents, targetState, cancelToken, async (doc) => {
            const uri = doc.uri.toString();
            const file = path.basename(doc.uri.fsPath ?? uri);
            this.profiler.ensure(uri, file);

            const t0 = performance.now();
            await callback(doc);
            this.profiler.record(uri, phase, performance.now() - t0);
        });
    }
}
