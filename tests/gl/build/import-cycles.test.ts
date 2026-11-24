/**
 * Import-cycle guard for the shipped `@babylonjs/lite-gl` `dist/` tree, the GL counterpart of
 * `tests/lite/build/lazy-import-cycles.test.ts`.
 *
 * `dist/` is a 1:1 `tsc` emit of `src/` (see `packages/babylon-lite-gl/build.mjs`), so consumers'
 * bundlers see exactly the module graph checked here. Two invariants keep it tree-shakeable:
 *
 * - A module loaded through `import()` must never statically reach the module that lazy-loads it.
 *   Rolldown (Vite 8) otherwise emits the lazy chunk and everything its loader lazy-loads, even for
 *   apps that never use them (the `@babylonjs/lite` flow-graph regression, see
 *   https://forum.babylonjs.com/t/lite-something-wrong-with-treeshaking-bundling-with-vite/64889).
 * - The runtime (value) import graph is acyclic, so module initialisation order never depends on
 *   which module a consumer imports first. Type-only cycles are fine: `import type` is erased by `tsc`
 *   and never reaches `dist/`.
 *
 * Fix a failure by moving the shared code into a leaf module that both sides import.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findLazyImportCycles, findOrphanChunks, findStaticImportCycles, listJsFiles } from "../../shared/import-graph";

const PACKAGE_DIR = resolve(__dirname, "../../../packages/babylon-lite-gl");
const SRC = resolve(PACKAGE_DIR, "src");
const DIST = resolve(PACKAGE_DIR, "dist");
const WEB_ENTRY = resolve(DIST, "index.js");
const NATIVE_ENTRY = resolve(DIST, "native/index.js");

const tempDirs: string[] = [];

function newestMtime(dir: string): number {
    let newest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
        if (entry.isFile()) {
            newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
        }
    }
    return newest;
}

/** Builds `dist/` only when it is missing or older than `src/`, so a sibling `gl-build` file that
 *  just rebuilt it is not clobbered (the project runs its files sequentially). */
function ensureDistBuilt(): void {
    if (existsSync(WEB_ENTRY) && statSync(WEB_ENTRY).mtimeMs >= newestMtime(SRC)) {
        return;
    }
    const built = spawnSync(process.execPath, [resolve(PACKAGE_DIR, "build.mjs")], { cwd: PACKAGE_DIR, encoding: "utf-8" });
    if (built.status !== 0) {
        throw new Error(`babylon-lite-gl build failed:\n${built.stdout ?? ""}${built.stderr ?? ""}`);
    }
}

async function viteOrphanChunks(source: string): Promise<{ orphans: string[]; chunkCount: number }> {
    const dir = mkdtempSync(join(tmpdir(), "lite-gl-cycles-"));
    tempDirs.push(dir);
    const entry = join(dir, "entry.mjs");
    writeFileSync(entry, source);
    const result = (await build({
        configFile: false,
        logLevel: "silent",
        root: dir,
        build: {
            write: false,
            minify: false,
            target: "esnext",
            modulePreload: false,
            rollupOptions: { input: entry },
        },
    })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
    const output = (Array.isArray(result) ? result[0]! : result).output;
    return { orphans: findOrphanChunks(output), chunkCount: output.filter((o) => o.type === "chunk").length };
}

beforeAll(ensureDistBuilt);
afterAll(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("@babylonjs/lite-gl import cycles", () => {
    it("no lazily imported module statically reaches the module that lazy-loads it", () => {
        const cycles = findLazyImportCycles(listJsFiles(DIST), DIST);
        expect(
            cycles,
            "Each lazily imported module below statically imports (directly or transitively) the module that " +
                "lazy-loads it. Rolldown/Vite 8 then emits these chunks for apps that never use them. Move what the " +
                "lazy module needs into a leaf module that both can import.\n" +
                cycles.join("\n")
        ).toEqual([]);
    });

    it("the shipped runtime import graph has no static cycles", () => {
        const files = listJsFiles(DIST);
        expect(files.length, "no JS emitted to dist/").toBeGreaterThan(0);
        const cycles = findStaticImportCycles(files, DIST);
        expect(
            cycles,
            "These dist/ modules import each other at runtime (types-only imports are erased and do not count). " +
                "Move the shared code into a leaf module, or make the back-edge `import type` if it only needs types.\n" +
                cycles.join("\n")
        ).toEqual([]);
    });

    for (const [name, source] of [
        [
            "an empty web scene",
            `import { clearEngine, createGLEngine, runRenderLoop } from ${JSON.stringify(WEB_ENTRY)};\n` +
                `const engine = createGLEngine(document.querySelector("canvas"));\n` +
                `runRenderLoop(engine, () => clearEngine(engine, { color: { r: 0, g: 0, b: 0 }, depth: true }));\n`,
        ],
        ["the native entry", `import * as native from ${JSON.stringify(NATIVE_ENTRY)};\nconsole.log(Object.keys(native).length);\n`],
    ] as const) {
        it(`a Vite 8 (Rolldown) build of ${name} emits only chunks reachable from the entry`, async () => {
            const { orphans, chunkCount } = await viteOrphanChunks(source);
            expect(orphans, `Rolldown emitted ${orphans.length} of ${chunkCount} chunks that nothing imports:\n${orphans.join("\n")}`).toEqual([]);
        }, 180_000);
    }
});
