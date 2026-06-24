import * as esbuild from "esbuild-wasm";
import esbuildWasmUrl from "esbuild-wasm/esbuild.wasm?url";

let initPromise: Promise<void> | null = null;

/**
 * Lazily initialise the esbuild-wasm runtime exactly once. The wasm binary is
 * resolved through Vite's asset pipeline (`?url`) so it is served locally.
 */
function ensureInitialized(): Promise<void> {
    if (!initPromise) {
        initPromise = esbuild.initialize({ wasmURL: esbuildWasmUrl });
    }
    return initPromise;
}

/**
 * Transpile the user's TypeScript snippet to runnable ESM.
 *
 * Phase 1 is single-file: bare imports (e.g. `@babylonjs/lite`) are preserved
 * verbatim and resolved by the runner iframe's import map at execution time. A
 * future multi-file phase will switch this to a bundling build with virtual-FS
 * resolution and `@babylonjs/lite*` marked external.
 */
export async function transpile(source: string): Promise<string> {
    await ensureInitialized();
    const result = await esbuild.transform(source, {
        loader: "ts",
        format: "esm",
        target: "esnext",
        sourcemap: "inline",
        sourcefile: "playground.ts",
    });
    // Name the module so runtime error stacks read `playground.ts:<line>` rather
    // than an opaque `blob:` URL. esbuild's `transform` preserves line numbers,
    // so the reported line matches the user's snippet line.
    return `${result.code}\n//# sourceURL=playground.ts\n`;
}
