/** MeshLoD opt-in tree-shaking (build).
 *
 *  MeshLoD is a dynamically-imported opt-in feature: importing unrelated engine
 *  APIs must retain NONE of the MeshLoD runtime, PBR renderable/compose (WGSL), or
 *  page-decoder code, and even a `loadMeshLoD` consumer must keep those behind
 *  dynamic-import chunk boundaries (never inlined into the entry chunk). This
 *  bundles representative entries with Vite/Rollup and asserts the boundary holds
 *  (REQ-INT-2, REQ-INT-8, T-22). */

import { build } from "vite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const SRC_ENTRY = resolve(ROOT, "packages/babylon-lite/src/index.ts");

// Identifiers that only exist in MeshLoD source (facade, runtime, decoder, WGSL).
const MESHLOD_SENTINELS = [
    "MLOD_INVALID_OPTION",
    "MLOD_PAGE_INTEGRITY",
    "composeMeshLoDWgsl",
    "decodeMeshLoDPage",
    "selectMeshLoDCpu",
    "MESHLOD\\0",
    "buildMeshLoDBatchRenderable",
];
const FACADE_SENTINELS = ["loadMeshLoD", "createMeshLoDInstance"];

let workDir: string;

interface Chunk {
    file: string;
    code: string;
}

async function bundleChunks(entrySource: string): Promise<Chunk[]> {
    const entry = resolve(workDir, `entry-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(entry, entrySource);
    const result = (await build({
        configFile: false,
        logLevel: "silent",
        build: {
            write: false,
            minify: false,
            target: "esnext",
            lib: { entry, formats: ["es"], fileName: "out" },
            rollupOptions: { output: { entryFileNames: "entry.js", chunkFileNames: "[name].js" } },
        },
    })) as unknown as { output: { type: string; code?: string; fileName: string }[] };
    const output = Array.isArray(result) ? (result[0] as { output: typeof result.output }).output : result.output;
    return output.filter((o) => o.type === "chunk").map((o) => ({ file: o.fileName, code: o.code ?? "" }));
}

function allCode(chunks: Chunk[]): string {
    return chunks.map((c) => c.code).join("\n");
}

beforeAll(() => {
    workDir = mkdtempSync(resolve(tmpdir(), "lite-mesh-lod-ts-"));
});
afterAll(() => {
    if (workDir) {
        rmSync(workDir, { recursive: true, force: true });
    }
});

describe("MeshLoD is opt-in and tree-shakable", () => {
    it("retains zero MeshLoD code when only unrelated APIs are imported", async () => {
        const code = allCode(
            await bundleChunks(
                `import { createEngine, createSceneContext, createPbrMaterial, createHemisphericLight } from ${JSON.stringify(SRC_ENTRY)};\n` +
                    `console.log(createEngine, createSceneContext, createPbrMaterial, createHemisphericLight);\n`
            )
        );
        for (const sentinel of [...MESHLOD_SENTINELS, ...FACADE_SENTINELS]) {
            expect(code, `unrelated import retained MeshLoD code (${sentinel})`).not.toContain(sentinel);
        }
    }, 180_000);

    it("keeps the MeshLoD runtime/renderable/decoder behind dynamic-import chunks for a loadMeshLoD consumer", async () => {
        const chunks = await bundleChunks(`import { loadMeshLoD, createMeshLoDInstance } from ${JSON.stringify(SRC_ENTRY)};\nconsole.log(loadMeshLoD, createMeshLoDInstance);\n`);
        // Splitting must have happened — the runtime is not inlined into one chunk.
        expect(chunks.length, "dynamic imports must split MeshLoD into separate chunks").toBeGreaterThan(1);
        // `createMeshLoDInstance` is facade-unique (unlike `loadMeshLoD`, whose substring
        // appears in the runtime's `_loadMeshLoD`). The facade chunk must not inline the
        // heavy runtime/renderable/decoder/WGSL, which live only in dynamic-import chunks.
        const facadeChunks = chunks.filter((c) => c.code.includes("createMeshLoDInstance"));
        expect(facadeChunks.length, "the facade (createMeshLoDInstance) must be retained").toBeGreaterThan(0);
        for (const chunk of facadeChunks) {
            for (const sentinel of ["composeMeshLoDWgsl", "decodeMeshLoDPage", "selectMeshLoDCpu", "buildMeshLoDBatchRenderable"]) {
                expect(chunk.code, `MeshLoD heavy module (${sentinel}) leaked into the facade chunk ${chunk.file}`).not.toContain(sentinel);
            }
        }
    }, 180_000);

    it("positive control: importing loadMeshLoD DOES emit the MeshLoD runtime chunk somewhere", async () => {
        const code = allCode(await bundleChunks(`import { loadMeshLoD } from ${JSON.stringify(SRC_ENTRY)};\nconsole.log(loadMeshLoD);\n`));
        // Guards against the boundary test passing because nothing was emitted at all.
        expect(code).toContain("MLOD_INVALID_OPTION");
    }, 180_000);
});
