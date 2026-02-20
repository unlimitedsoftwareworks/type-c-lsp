#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const binDir = fileURLToPath(new URL('.', import.meta.url));
const packageDir = path.resolve(binDir, '..');
const srcDir = path.join(packageDir, 'src');
const outMain = path.join(packageDir, 'out', 'main.js');
const outDir = path.join(packageDir, 'out');
const tsBuildInfo = path.join(packageDir, 'tsconfig.tsbuildinfo');

function newestTypeScriptMtimeMs(dir) {
    let newest = 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            newest = Math.max(newest, newestTypeScriptMtimeMs(full));
        } else if (entry.isFile() && full.endsWith('.ts')) {
            newest = Math.max(newest, fs.statSync(full).mtimeMs);
        }
    }
    return newest;
}

function newestBuiltOutputMtimeMs() {
    let newest = 0;

    if (fs.existsSync(outDir)) {
        const walk = (dir) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.isFile() && (full.endsWith('.js') || full.endsWith('.d.ts'))) {
                    newest = Math.max(newest, fs.statSync(full).mtimeMs);
                }
            }
        };
        walk(outDir);
    }

    if (fs.existsSync(tsBuildInfo)) {
        newest = Math.max(newest, fs.statSync(tsBuildInfo).mtimeMs);
    }

    return newest;
}

function ensureFreshBuild() {
    if (process.env.TYPEC_SKIP_AUTOBUILD === '1') {
        return;
    }

    const outMtime = newestBuiltOutputMtimeMs();
    const srcMtime = fs.existsSync(srcDir) ? newestTypeScriptMtimeMs(srcDir) : 0;
    if (outMtime >= srcMtime) {
        return;
    }

    console.log('[typec] Compiler output is stale. Building packages/compiler...');
    const result = spawnSync('npm', ['run', '-s', 'build'], {
        cwd: packageDir,
        stdio: 'inherit'
    });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

ensureFreshBuild();

const mainModule = await import(pathToFileURL(outMain).href);
await mainModule.default();
