/**
 * Lazy-import cycle guard for the shipped `build/lib` tree.
 *
 * A module loaded through `import()` must never statically reach (directly or transitively) the
 * module that lazy-loads it. Such a cycle makes the lazy chunk look like it keeps its own importer
 * alive. Rolldown (Vite 8) then emits the lazy chunk, plus every chunk that importer lazy-loads, even
 * when the application never reaches that code. The flow-graph block registry did this: an empty
 * scene built with Vite 8 emitted ~150 chunks, 135 of them flow-graph blocks that nothing imported.
 * See https://forum.babylonjs.com/t/lite-something-wrong-with-treeshaking-bundling-with-vite/64889.
 *
 * Fix a failure by moving what the lazy module needs out of its loader, into a leaf module both can
 * import (e.g. `physics/physics-motion-types.ts`, `engine/gpu-task-timing-snapshot.ts`).
 */
import { dirname } from "path";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findLazyImportCycles, findOrphanChunks, listJsFiles } from "../../shared/import-graph";
import { BUILD_LIB_DIR, LIB_ENTRY, cleanupTempDirs, ensureLibBuilt, makeTempEntry } from "./bundler-harness";

beforeAll(ensureLibBuilt);
afterAll(cleanupTempDirs);

describe("@babylonjs/lite lazy-import cycles", () => {
    it("no lazily imported module statically reaches the module that lazy-loads it", () => {
        // First-party `build/lib` JS, including shared `_chunks` but not bundled vendor runtimes.
        const cycles = findLazyImportCycles(listJsFiles(BUILD_LIB_DIR, ["vendor"]), BUILD_LIB_DIR);
        expect(
            cycles,
            "Each lazily imported module below statically imports (directly or transitively) the module that " +
                "lazy-loads it. Rolldown/Vite 8 then emits these chunks for apps that never use them. Move what the " +
                "lazy module needs into a leaf module that both can import.\n" +
                cycles.join("\n")
        ).toEqual([]);
    });

    it("a Vite 8 (Rolldown) build of an empty scene emits only chunks reachable from the entry", async () => {
        const entry = makeTempEntry(
            `import { createEngine, createSceneContext, registerScene, startEngine } from ${JSON.stringify(LIB_ENTRY)};\n` +
                `const engine = await createEngine(document.querySelector("canvas"));\n` +
                `const scene = createSceneContext(engine);\n` +
                `await registerScene(scene);\n` +
                `await startEngine(engine);\n`
        );
        const result = (await build({
            configFile: false,
            logLevel: "silent",
            root: dirname(entry),
            build: {
                write: false,
                minify: false,
                target: "esnext",
                modulePreload: false,
                rollupOptions: { input: entry },
            },
        })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
        const output = (Array.isArray(result) ? result[0]! : result).output;
        const orphans = findOrphanChunks(output);
        const chunkCount = output.filter((o) => o.type === "chunk").length;
        expect(orphans, `Rolldown emitted ${orphans.length} of ${chunkCount} chunks that nothing imports:\n${orphans.join("\n")}`).toEqual([]);
    }, 180_000);
});
