/**
 * Profiling utilities for measuring Type-C compiler pipeline performance.
 *
 * This module provides a simple, low-overhead profiling system for measuring:
 * - Phase-level timing (workspace init, document build)
 * - Type inference metrics (getType calls, cache hits/misses, total time)
 * - Per-validator timing
 */

import { performance } from 'perf_hooks';

export interface TypeInferenceStats {
    totalCalls: number;
    cacheMisses: number;
    totalTimeMs: number;
}

export interface ValidatorStats {
    name: string;
    totalCalls: number;
    totalTimeMs: number;
}

export interface PhaseStats {
    name: string;
    startMs: number;
    endMs: number;
    durationMs: number;
}

export class CompilerProfiler {
    private phases: PhaseStats[] = [];
    private currentPhase: { name: string; startMs: number } | undefined;

    typeInference: TypeInferenceStats = {
        totalCalls: 0,
        cacheMisses: 0,
        totalTimeMs: 0,
    };

    validators: Map<string, ValidatorStats> = new Map();

    // --- Phase tracking ---

    startPhase(name: string): void {
        this.currentPhase = { name, startMs: performance.now() };
    }

    endPhase(): void {
        if (this.currentPhase) {
            const endMs = performance.now();
            this.phases.push({
                name: this.currentPhase.name,
                startMs: this.currentPhase.startMs,
                endMs,
                durationMs: endMs - this.currentPhase.startMs,
            });
            this.currentPhase = undefined;
        }
    }

    // --- Type inference tracking ---

    recordGetTypeCall(wasCacheMiss: boolean, durationMs: number): void {
        this.typeInference.totalCalls++;
        if (wasCacheMiss) {
            this.typeInference.cacheMisses++;
        }
        this.typeInference.totalTimeMs += durationMs;
    }

    // --- Validator tracking ---

    recordValidatorCall(name: string, durationMs: number): void {
        let stats = this.validators.get(name);
        if (!stats) {
            stats = { name, totalCalls: 0, totalTimeMs: 0 };
            this.validators.set(name, stats);
        }
        stats.totalCalls++;
        stats.totalTimeMs += durationMs;
    }

    // --- Reporting ---

    report(): string {
        const lines: string[] = [];
        lines.push('');
        lines.push('=== Type-C Compiler Performance Profile ===');
        lines.push('');

        // Phases
        lines.push('--- Pipeline Phases ---');
        let totalPipelineMs = 0;
        for (const phase of this.phases) {
            lines.push(`  ${phase.name}: ${phase.durationMs.toFixed(2)} ms`);
            totalPipelineMs += phase.durationMs;
        }
        lines.push(`  TOTAL: ${totalPipelineMs.toFixed(2)} ms`);
        lines.push('');

        // Type inference
        lines.push('--- Type Inference ---');
        const cacheHits = this.typeInference.totalCalls - this.typeInference.cacheMisses;
        const hitRate = this.typeInference.totalCalls > 0
            ? ((cacheHits / this.typeInference.totalCalls) * 100).toFixed(1)
            : '0.0';
        lines.push(`  Total getType() calls: ${this.typeInference.totalCalls}`);
        lines.push(`  Cache hits:            ${cacheHits} (${hitRate}%)`);
        lines.push(`  Cache misses:          ${this.typeInference.cacheMisses}`);
        lines.push(`  Total inference time:  ${this.typeInference.totalTimeMs.toFixed(2)} ms`);
        if (this.typeInference.cacheMisses > 0) {
            lines.push(`  Avg miss time:         ${(this.typeInference.totalTimeMs / this.typeInference.cacheMisses).toFixed(4)} ms`);
        }
        lines.push('');

        // Validators
        lines.push('--- Validators ---');
        const sortedValidators = [...this.validators.values()].sort((a, b) => b.totalTimeMs - a.totalTimeMs);
        let totalValidatorMs = 0;
        for (const v of sortedValidators) {
            lines.push(`  ${v.name.padEnd(40)} ${v.totalCalls.toString().padStart(6)} calls  ${v.totalTimeMs.toFixed(2).padStart(10)} ms`);
            totalValidatorMs += v.totalTimeMs;
        }
        lines.push(`  ${'TOTAL'.padEnd(40)} ${''.padStart(6)}        ${totalValidatorMs.toFixed(2).padStart(10)} ms`);
        lines.push('');

        lines.push('===========================================');
        return lines.join('\n');
    }

    reset(): void {
        this.phases = [];
        this.currentPhase = undefined;
        this.typeInference = { totalCalls: 0, cacheMisses: 0, totalTimeMs: 0 };
        this.validators.clear();
    }
}

/** Global singleton profiler instance */
export const profiler = new CompilerProfiler();
