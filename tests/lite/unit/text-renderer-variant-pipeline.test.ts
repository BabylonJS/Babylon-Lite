/**
 * Text renderer pipeline selection across mixed base / shader-variant draw groups.
 *
 * A `TextData` may hold both plain draw groups and groups whose runs need the composed
 * shader variant (currently: runs carrying a font-weight offset). The recorded command
 * stream must switch pipelines exactly at the group boundaries and nowhere else, and the
 * variant pipeline must be resolved during `_update` — never inside the draw/record loop,
 * which would rebuild a cache key every frame.
 *
 * Pure CPU — the GPU device and the render-bundle encoder are mocked. Real weighted text
 * pixels are covered by the parity scenes.
 */
import { describe, expect, it, vi } from "vitest";

import type { GlyphCurves } from "../../../packages/babylon-lite/src/text/glyph-storage";
import { createGlyphStorage } from "../../../packages/babylon-lite/src/text/glyph-storage";
import type { GlyphRun } from "../../../packages/babylon-lite/src/text/text-data";
import { createTextData } from "../../../packages/babylon-lite/src/text/text-data";
import type { TextLayer, TextRenderer } from "../../../packages/babylon-lite/src/text/text-renderer";
import { createTextLayer, createTextRenderer } from "../../../packages/babylon-lite/src/text/text-renderer";
import { setFontWeightOffset } from "../../../packages/babylon-lite/src/text/set-font-weight-offset";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";

// ── Mock GPU device + bundle encoder ──────────────────────────────────

type MockModule = { __label: string; __code: string };
type MockPipeline = { __vertModule: MockModule };
type Cmd = { op: "pipeline"; module: string } | { op: "bindGroup"; index: number } | { op: "draw"; instances: number; first: number } | { op: "vertexBuffer"; slot: number };

function createMockSurface() {
    const commands: Cmd[] = [];
    const counters = { pipelinesCreated: 0, bundlesFinished: 0 };

    const bundleEncoder = {
        setPipeline: (p: MockPipeline) => commands.push({ op: "pipeline", module: p.__vertModule.__label }),
        setVertexBuffer: (slot: number) => commands.push({ op: "vertexBuffer", slot }),
        setBindGroup: (index: number) => commands.push({ op: "bindGroup", index }),
        draw: (_v: number, instances: number, _fv: number, first: number) => commands.push({ op: "draw", instances, first }),
        finish: () => {
            counters.bundlesFinished++;
            return { __bundle: counters.bundlesFinished };
        },
    };

    const device = {
        createBuffer: vi.fn((desc: { size: number }) => ({
            getMappedRange: () => new ArrayBuffer(desc.size),
            unmap: vi.fn(),
            destroy: vi.fn(),
        })),
        createTexture: vi.fn(() => ({ createView: () => ({}), destroy: vi.fn() })),
        createBindGroup: vi.fn(() => ({})),
        createBindGroupLayout: vi.fn(() => ({})),
        createPipelineLayout: vi.fn(() => ({})),
        createShaderModule: vi.fn((desc: { label: string; code: string }): MockModule => ({ __label: desc.label, __code: desc.code })),
        createRenderPipeline: vi.fn((desc: { vertex: { module: MockModule } }): MockPipeline => {
            counters.pipelinesCreated++;
            return { __vertModule: desc.vertex.module };
        }),
        createRenderBundleEncoder: vi.fn(() => bundleEncoder),
        queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
    };

    const pass = { executeBundles: vi.fn(), end: vi.fn() };
    const engine = { _device: device, _currentEncoder: { beginRenderPass: vi.fn(() => pass) } };
    const surface = {
        engine,
        canvas: { width: 800, height: 600 },
        format: "bgra8unorm",
        scRT: { _colorView: {} },
    } as unknown as SurfaceContext;

    return { surface, commands, counters, device };
}

// ── Fixtures ──────────────────────────────────────────────────────────

function makeGlyph(glyphId: number): GlyphCurves {
    return {
        glyphId,
        curves: [
            { p0x: 0, p0y: 0, p1x: 50, p1y: 100, p2x: 100, p2y: 0 },
            { p0x: 100, p0y: 0, p1x: 50, p1y: -20, p2x: 0, p2y: 0 },
        ],
        bounds: { xMin: 0, yMin: -20, xMax: 100, yMax: 100 },
    };
}

function makeStorage() {
    const curves = (ids: number[]) => new Map<number, GlyphCurves>(ids.map((id) => [id, makeGlyph(id)]));
    return createGlyphStorage(
        new Map([
            ["f", curves([1, 2, 3])],
            ["g", curves([1, 2, 3])],
        ])
    );
}

function run(curveSet: string, x: number, glyphIds: number[] = [1, 2]): GlyphRun {
    return {
        curveSet,
        glyphs: glyphIds.map((glyphId, i) => ({ glyphId, x: x + i, y: 0 })),
        pixelsPerFontUnit: 1,
    };
}

function layerGpu(rr: TextRenderer, layer: TextLayer) {
    const lg = rr._layerGpu.get(layer);
    expect(lg).toBeDefined();
    return lg!;
}

/** Only the pipeline switches, in order. */
function pipelineSequence(commands: Cmd[]): string[] {
    return commands.filter((c): c is Extract<Cmd, { op: "pipeline" }> => c.op === "pipeline").map((c) => c.module);
}

describe("text renderer variant pipeline selection", () => {
    it("records base → variant → base for a mixed layer, switching only at group boundaries", () => {
        const { surface, commands, counters, device } = createMockSurface();
        const storage = makeStorage();

        const baseF = run("f", 0);
        const weightedF = run("f", 10);
        const baseG = run("g", 20);

        const data = createTextData(storage, [baseF, weightedF, baseG]);
        setFontWeightOffset(data, weightedF, 12);
        // First-seen key order: "f" (base) → interned token for "f" (weighted) → "g" (base).
        expect(data._groups.map((g) => g._groupKey === g._curveSetId)).toEqual([true, false, true]);

        const layer = createTextLayer(data);
        const rr = createTextRenderer(surface, { layers: [layer] });

        rr._update();
        // Both pipelines are resolved during update, before any command is recorded.
        const lg = layerGpu(rr, layer);
        expect(lg._pipeline).not.toBeNull();
        expect(lg._variantPipeline).not.toBe(lg._pipeline);
        expect(commands.length).toBe(0);

        const pipelinesAfterUpdate = counters.pipelinesCreated;
        expect(pipelinesAfterUpdate).toBe(2);

        rr._record();

        expect(pipelineSequence(commands)).toEqual(["text-vert", "text-vert-w", "text-vert"]);
        // Three draws, one per group, in group order.
        expect(commands.filter((c) => c.op === "draw")).toHaveLength(3);
        // Recording created no pipeline and compiled no module — resolution happened in update.
        expect(counters.pipelinesCreated).toBe(pipelinesAfterUpdate);
        expect(device.createShaderModule).toHaveBeenCalledTimes(4); // base pair + variant pair

        // The composed variant module is the one carrying the weight fragment's WGSL, and it
        // still declares the shared base logic exactly once.
        const variantFrag = device.createShaderModule.mock.results.map((r) => r.value as MockModule).find((m) => m.__label === "text-frag-w")!;
        expect(variantFrag.__code).toContain("fn wdst(");
        expect(variantFrag.__code.split("fn rcode(").length - 1).toBe(1);
    });

    it("records exactly one setPipeline for an all-base layer", () => {
        const { surface, commands } = createMockSurface();
        const storage = makeStorage();
        const data = createTextData(storage, [run("f", 0), run("g", 10)]);
        const layer = createTextLayer(data);
        const rr = createTextRenderer(surface, { layers: [layer] });

        rr._update();
        rr._record();

        expect(pipelineSequence(commands)).toEqual(["text-vert"]);
        expect(commands.filter((c) => c.op === "draw")).toHaveLength(2);
    });

    it("records exactly one setPipeline for an all-weighted layer", () => {
        const { surface, commands } = createMockSurface();
        const storage = makeStorage();
        const w1 = run("f", 0);
        const w2 = run("g", 10);
        const data = createTextData(storage, [w1, w2]);
        setFontWeightOffset(data, w1, 5);
        setFontWeightOffset(data, w2, 10);
        const layer = createTextLayer(data);
        const rr = createTextRenderer(surface, { layers: [layer] });

        rr._update();
        rr._record();

        // The bundle opens on the base pipeline (its declared pipeline), then switches once.
        expect(pipelineSequence(commands)).toEqual(["text-vert", "text-vert-w"]);
        expect(commands.filter((c) => c.op === "draw")).toHaveLength(2);
    });

    it("replays the cached bundle without re-recording when nothing structural changed", () => {
        const { surface, commands } = createMockSurface();
        const storage = makeStorage();
        const weighted = run("f", 10);
        const data = createTextData(storage, [run("f", 0), weighted]);
        setFontWeightOffset(data, weighted, 12);
        const layer = createTextLayer(data);
        const rr = createTextRenderer(surface, { layers: [layer] });

        rr._update();
        rr._record();
        const afterFirst = commands.length;

        rr._update();
        rr._record();

        expect(commands.length).toBe(afterFirst);
    });
});

/**
 * Defect regression: a `TextRenderable`'s scene binding is built once, not per frame, so a
 * styling feature enabled *after* the bind used to leave weighted groups drawing with the
 * base pipeline until an unrelated scene mutation rebuilt the binding. With the live-data
 * setter that ordering is the normal one, so the binding's `update` must refresh the
 * late-installed variant pipeline.
 *
 * Runs against a *fresh* module registry so no earlier test in this file has installed the
 * variant resolver — the "no feature yet at bind time" state is the whole point.
 */
describe("text renderable late-installed variant pipeline", () => {
    it("refreshes the variant pipeline on the frame path after the feature is enabled post-bind", async () => {
        vi.resetModules();
        const [glyphStorageMod, textDataMod, renderableMod, weightMod] = await Promise.all([
            import("../../../packages/babylon-lite/src/text/glyph-storage"),
            import("../../../packages/babylon-lite/src/text/text-data"),
            import("../../../packages/babylon-lite/src/text/text-renderable"),
            import("../../../packages/babylon-lite/src/text/set-font-weight-offset"),
        ]);

        const { device } = createMockSurface();
        const engine = { _device: device } as unknown as EngineContext;
        const target = { _colorFormat: "bgra8unorm", _sampleCount: 1, _depthStencilFormat: "depth24plus" } as unknown as RenderTargetSignature;

        const curves = (ids: number[]) => new Map<number, GlyphCurves>(ids.map((id) => [id, makeGlyph(id)]));
        const storage = glyphStorageMod.createGlyphStorage(
            new Map([
                ["f", curves([1, 2])],
                ["g", curves([1, 2])],
            ])
        );

        const baseF = run("f", 0);
        const weightedF = run("f", 10);
        const baseG = run("g", 20);
        const data = textDataMod.createTextData(storage, [baseF, weightedF, baseG]);

        const renderable = renderableMod.createTextRenderable(data);
        const binding = renderable.bind(engine, target);
        const context = { targetWidth: 800, targetHeight: 600, _camera: null };

        const drawn: string[] = [];
        const pass = {
            setPipeline: (p: MockPipeline) => drawn.push(p.__vertModule.__label),
            setVertexBuffer: () => {},
            setBindGroup: () => {},
            draw: () => {},
        } as unknown as GPURenderPassEncoder;

        // Frame 1: no styling feature exists, so the variant pipeline aliases the base one and
        // every group draws with the pipeline the draw list already bound.
        binding.update!(context);
        const gpu = renderable._gpu!;
        expect(gpu._variantPipeline).toBe(gpu._pipeline);
        pass.setPipeline(binding.pipeline);
        binding.draw(pass, engine);
        expect(drawn).toEqual(["text-vert"]);

        // Enable the feature on the live data. The binding is deliberately NOT rebuilt.
        weightMod.setFontWeightOffset(data, weightedF, 12);
        expect(data._groups.map((g) => g._groupKey === g._curveSetId)).toEqual([true, false, true]);
        expect(gpu._variantPipeline).toBe(gpu._pipeline);

        // Frame 2: the binding update resolves the newly installed variant pipeline.
        binding.update!(context);
        expect(gpu._variantPipeline).not.toBe(gpu._pipeline);

        drawn.length = 0;
        pass.setPipeline(binding.pipeline);
        binding.draw(pass, engine);
        expect(drawn).toEqual(["text-vert", "text-vert-w", "text-vert"]);

        // Frame 3: already resolved — the identity test fails on its first term, so nothing is
        // re-resolved and the draw sequence is unchanged.
        const resolved = gpu._variantPipeline;
        const pipelinesBefore = device.createRenderPipeline.mock.calls.length;
        binding.update!(context);
        expect(gpu._variantPipeline).toBe(resolved);
        expect(device.createRenderPipeline.mock.calls.length).toBe(pipelinesBefore);
    });
});
