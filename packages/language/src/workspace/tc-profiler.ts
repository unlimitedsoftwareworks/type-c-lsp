import * as fs from 'node:fs/promises';

export type ProfilingPhase = 'parsing' | 'linking' | 'validating';

export interface FileProfile {
    file: string;
    parsing: number;    // ms
    linking: number;    // ms
    validating: number; // ms
}

export interface TypeNodeStats {
    nodeType: string;
    calls: number;
    totalMs: number;
    meanMs: number;
}

export interface ProfilingData {
    files: FileProfile[];
    summary: Record<ProfilingPhase, { total: number; max: number; mean: number }>;
    typeInference: TypeNodeStats[];
}

// ── Type provider profiler ────────────────────────────────────────────────────

export class TypeProviderProfiler {
    private readonly stats = new Map<string, { calls: number; totalMs: number }>();

    record(nodeType: string, ms: number): void {
        const existing = this.stats.get(nodeType);
        if (existing) {
            existing.calls++;
            existing.totalMs += ms;
        } else {
            this.stats.set(nodeType, { calls: 1, totalMs: ms });
        }
    }

    getData(): TypeNodeStats[] {
        return Array.from(this.stats.entries())
            .map(([nodeType, s]) => ({ nodeType, calls: s.calls, totalMs: s.totalMs, meanMs: s.totalMs / s.calls }))
            .sort((a, b) => b.totalMs - a.totalMs);
    }
}

// ── Document-phase profiler ───────────────────────────────────────────────────

export class TCProfiler {
    private readonly records = new Map<string, FileProfile>();
    readonly typeProvider = new TypeProviderProfiler();

    ensure(uri: string, file: string): void {
        if (!this.records.has(uri)) {
            this.records.set(uri, { file, parsing: 0, linking: 0, validating: 0 });
        }
    }

    record(uri: string, phase: ProfilingPhase, ms: number): void {
        const rec = this.records.get(uri);
        if (rec) rec[phase] = ms;
    }

    getData(): ProfilingData {
        const files = Array.from(this.records.values());
        const summary = {} as ProfilingData['summary'];
        for (const phase of ['parsing', 'linking', 'validating'] as ProfilingPhase[]) {
            const times = files.map(f => f[phase]);
            const total = times.reduce((a, b) => a + b, 0);
            summary[phase] = {
                total,
                max: times.length ? Math.max(...times) : 0,
                mean: times.length ? total / times.length : 0,
            };
        }
        return { files, summary, typeInference: this.typeProvider.getData() };
    }

    async writeJSON(outputPath: string): Promise<void> {
        await fs.writeFile(outputPath, JSON.stringify(this.getData(), null, 2), 'utf-8');
    }
}
