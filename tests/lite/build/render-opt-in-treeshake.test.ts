import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { build } from "vite";
import { createLiteCodeSplitting } from "../../../scripts/bundle-scenes-core";
import { BUILD_LIB_DIR, cleanupTempDirs, ensureLibBuilt, isExternalRequest, LIB_ENTRY, makeTempEntry, runRollup } from "./bundler-harness";

beforeAll(ensureLibBuilt, 300_000);
afterAll(cleanupTempDirs);

async function initialViteCode(source: string): Promise<string> {
    const entry = makeTempEntry(source);
    const result = await build({
        root: dirname(entry),
        configFile: false,
        publicDir: false,
        logLevel: "silent",
        build: {
            target: "esnext",
            write: false,
            minify: false,
            modulePreload: false,
            rolldownOptions: {
                input: entry,
                external: isExternalRequest,
                output: { format: "es", codeSplitting: createLiteCodeSplitting() },
            },
        },
    });
    if (Array.isArray(result) || !("output" in result)) {
        throw new Error("Expected one in-memory Vite bundle.");
    }
    const initial = result.output.find((chunk) => chunk.type === "chunk" && chunk.isEntry);
    if (!initial || initial.type !== "chunk") {
        throw new Error("Vite did not emit the engine entry chunk.");
    }
    const chunks = new Map(result.output.filter((chunk) => chunk.type === "chunk").map((chunk) => [chunk.fileName, chunk] as const));
    const pending = [initial];
    const visited = new Set<string>();
    let initialCode = "";
    while (pending.length) {
        const chunk = pending.pop()!;
        if (visited.has(chunk.fileName)) {
            continue;
        }
        visited.add(chunk.fileName);
        initialCode += chunk.code;
        for (const imported of chunk.imports) {
            const dependency = chunks.get(imported);
            if (dependency) {
                pending.push(dependency);
            }
        }
    }
    return initialCode;
}

describe("rendering opt-in boundaries", () => {
    it.each([false, true])("keeps retirement out of Vite's initial engine graph unless disposal is requested (%s)", async (dispose) => {
        const initialCode = await initialViteCode(`import { createEngine, startEngine${dispose ? ", disposeEngine" : ""} } from ${JSON.stringify(LIB_ENTRY)};
console.log(createEngine, startEngine${dispose ? ", disposeEngine" : ""});`);
        expect(initialCode.includes("GPU resource retirement failed.")).toBe(dispose);
    });

    it.each([
        ["createEngine, startEngine, createSpriteRenderer, loadSpriteAtlas", false],
        ["acquireTexture", false],
        ["acquireTexture, releaseTexture", true],
    ] as const)("keeps texture release out of acquisition-only Vite graphs: %s", async (imports, retained) => {
        const code = await initialViteCode(`import { ${imports} } from ${JSON.stringify(LIB_ENTRY)}; console.log(${imports});`);
        expect(code.includes("function releaseTexture")).toBe(retained);
    });

    it("keeps pipeline signature keys out of the sprite-only Vite graph", async () => {
        const code = await initialViteCode(`import { createEngine, startEngine, createSpriteRenderer, loadSpriteAtlas } from ${JSON.stringify(LIB_ENTRY)};
console.log(createEngine, startEngine, createSpriteRenderer, loadSpriteAtlas);`);
        expect(code).not.toContain("function targetSignatureKey");
    });

    it.each([
        ["createEngine, startEngine, createSpriteRenderer, loadSpriteAtlas", false],
        ["getOrCreateSampler", true],
    ] as const)("loads comparison/LOD sampler normalization only for the general API: %s", async (imports, retained) => {
        const code = await initialViteCode(`import { ${imports} } from ${JSON.stringify(LIB_ENTRY)}; console.log(${imports});`);
        expect(code.includes("descriptor.compare")).toBe(retained);
        expect(code.includes("descriptor.lodMinClamp")).toBe(retained);
        expect(code.includes("descriptor.lodMaxClamp")).toBe(retained);
    });

    it.each([
        [["material", "standard", "standard-renderable.js"], "buildStandardMeshRenderables", false],
        [["material", "pbr", "pbr-renderable.js"], "buildPbrRenderables", false],
        [["shadow", "material-shadow-bindings.js"], "createMaterialShadowBindings", true],
    ] as const)("keeps shadow binding construction behind its receiver feature: %s", async (module, symbol, retained) => {
        const code = await initialViteCode(`import { ${symbol} } from ${JSON.stringify(join(BUILD_LIB_DIR, ...module))}; console.log(${symbol});`);
        expect(code.includes("function createMaterialShadowBindings")).toBe(retained);
        if (!retained) {
            expect(code).not.toContain("standardShadowVariantKey");
        }
    });

    it.each([
        ['format: "rgba8unorm"', false],
        ["format: globalThis.engine.format", false],
        ['format: "rgba8unorm", dFormat: "depth32float"', false],
        ['dFormat: "depth32float"', false],
        ['dFormat: "depth32float"', true],
        ['format: "rgba8unorm", dFormat: "depth32float"', true],
    ] as const)("retains sampled-depth code only when explicitly requested by %s", async (format, sampleDepth) => {
        const result = await runRollup({
            entrySource: `import { createRenderTargetTexture${sampleDepth ? ", withSampledDepthTexture" : ""} } from ${JSON.stringify(LIB_ENTRY)};
console.log(createRenderTargetTexture(globalThis.engine, {
    ${format}, samples: 1, size: { width: 32, height: 32 },
}${sampleDepth ? ", withSampledDepthTexture" : ""}));`,
            format: "es",
            minify: false,
        });
        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code.includes("_sampleType")).toBe(sampleDepth);
    });

    it.each([
        ["createEngine, startEngine", "GPU resource retirement failed.", false],
        ["createEngine, disposeEngine", "GPU resource retirement failed.", true],
        ["createSceneContext, removeFromScene", "transactRenderTask", false],
        ["createRenderTask, removeMeshFromTask", "transactRenderTask", false],
        ["createRenderTask, addMeshToTask", "transactRenderTask", true],
        ["createSceneContext, registerScene", "function retireGpuResourceBatch", false],
        ["createRenderTask, removeMeshFromTask", "function retireGpuResourceBatch", false],
        ["createRenderTask, addMeshToTask", "function retireGpuResourceBatch", true],
        ["createSceneContext, createRenderTask, registerScene", "function releaseBatches", false],
        ["createSceneContext, createShaderMaterial, registerScene", "function releaseBatches", true],
        ["createRenderTask, enableRenderTaskMeshRefresh", "transactRenderTask", true],
        ["createRenderTask, registerScene", "prepareTaskRenderables", false],
        ["createRenderTask, registerScene, enableAsyncShaderPipelineCompilation", "prepareTaskRenderables", true],
        ["createRenderTargetTexture, cloneTexture2D", "_resizeCallbacks", false],
        ["createSurfaceRenderTargetTexture, onRenderTargetTextureResize", "_resizeCallbacks", true],
        ["createRenderTargetTexture, cloneTexture2D", "RenderTargetTexture resize callbacks failed.", false],
        ["createSurfaceRenderTargetTexture, onRenderTargetTextureResize", "RenderTargetTexture resize callbacks failed.", true],
    ] as const)("keeps only requested capabilities for %s", async (imports, marker, retained) => {
        const result = await runRollup({
            entrySource: `import { ${imports} } from ${JSON.stringify(LIB_ENTRY)};\nconsole.log(${imports});\n`,
            format: "es",
            minify: false,
        });
        expect(result.errors).toEqual([]);
        expect(result.significantWarnings).toEqual([]);
        expect(result.code.includes(marker)).toBe(retained);
    });
});
