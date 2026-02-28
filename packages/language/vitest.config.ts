/*
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://vitest.dev/config/
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    resolve: {
        // Redirect the package's own name to its TypeScript source so that
        // vitest transforms source files directly and picks up edits without
        // a manual rebuild step.
        alias: {
            'type-c-language': resolve(__dirname, 'src/index.ts')
        }
    },
    test: {
        deps: {
            interopDefault: true
        },
        include: ['**/*.test.ts'],
        testTimeout: 60000
    }
});
