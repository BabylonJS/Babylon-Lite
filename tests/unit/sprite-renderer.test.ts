/**
 * Sprite renderer unit tests — pure CPU. Exercises the public lifecycle
 * (`createSpriteRenderer` / `registerSpriteRenderer` /
 * `unregisterSpriteRenderer` / `disposeSpriteRenderer`) plus the
 * pipeline-cache and depth-mode guard rails. Real GPU draws are covered
 * by the `scene50-sprite-grid` parity test.
 *
 * Note on test layout: vitest runs `tests/**\/*.test.ts` per
 * `vitest.config.ts`, so this file lives under `tests/unit/` rather than
 * inside the package.
 */
import { describe, it, expect, vi } from "vitest";

// Node has no WebGPU globals — stub the bit-flag enums the renderer reads at module-call time.
const G = globalThis as unknown as Record<string, unknown>;
G.GPUBufferUsage ??= { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8 };
G.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
G.GPUColorWrite ??= { ALL: 0xf };

import { createSprite2DLayer, addSprite2DIndex } from "../../packages/babylon-lite/src/sprite/sprite-2d";
import {
    createSpriteRenderer,
    registerSpriteRenderer,
    unregisterSpriteRenderer,
    disposeSpriteRenderer,
    _spriteRendererPipelineCacheSize,
} from "../../packages/babylon-lite/src/sprite/sprite-renderer";
import type { SpriteAtlas } from "../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import type { Texture2D } from "../../packages/babylon-lite/src/texture/texture-2d";
import type { EngineContext, EngineContextInternal } from "../../packages/babylon-lite/src/engine/engine";

// ── Mock GPU device ───────────────────────────────────────────────

interface MockBuffer {
    destroy: ReturnType<typeof vi.fn>;
    getMappedRange: ReturnType<typeof vi.fn>;
    unmap: ReturnType<typeof vi.fn>;
    _destroyed: boolean;
}

interface MockCounters {
    buffersCreated: number;
    buffersDestroyed: number;
    pipelinesBuilt: number;
    shaderModules: number;
}

function mockBuffer(counters: MockCounters): MockBuffer {
    counters.buffersCreated++;
    const buf: MockBuffer = {
        _destroyed: false,
        destroy: vi.fn(() => {
            if (!buf._destroyed) {
                buf._destroyed = true;
                counters.buffersDestroyed++;
            }
        }),
        getMappedRange: vi.fn(() => new ArrayBuffer(64)),
        unmap: vi.fn(),
    };
    return buf;
}

function makeMockEngine(): { engine: EngineContext; counters: MockCounters } {
    const counters: MockCounters = { buffersCreated: 0, buffersDestroyed: 0, pipelinesBuilt: 0, shaderModules: 0 };
    const queue = { writeBuffer: vi.fn() };
    const device = {
        createBuffer: vi.fn(() => mockBuffer(counters)),
        createShaderModule: vi.fn(() => {
            counters.shaderModules++;
            return { _kind: "shader" };
        }),
        createBindGroupLayout: vi.fn(() => ({ _kind: "bgl" })),
        createPipelineLayout: vi.fn(() => ({ _kind: "pl" })),
        createRenderPipeline: vi.fn(() => {
            counters.pipelinesBuilt++;
            return { _kind: "pipeline" };
        }),
        createBindGroup: vi.fn(() => ({ _kind: "bg" })),
        queue,
    } as unknown as GPUDevice;

    const eng: EngineContextInternal = {
        canvas: {} as HTMLCanvasElement,
        msaaSamples: 4,
        drawCallCount: 0,
        device,
        context: {} as GPUCanvasContext,
        format: "bgra8unorm",
        _targets: {
            msaaTexture: {} as GPUTexture,
            msaaView: {} as GPUTextureView,
            depthTexture: {} as GPUTexture,
            depthView: {} as GPUTextureView,
            width: 800,
            height: 600,
        } as EngineContextInternal["_targets"],
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
    };

    return { engine: eng, counters };
}

function makeMockAtlas(): SpriteAtlas {
    const texture = {
        texture: {} as GPUTexture,
        view: {} as GPUTextureView,
        sampler: {} as GPUSampler,
        width: 128,
        height: 128,
    } satisfies Texture2D;

    return {
        texture,
        textureSizePx: [128, 128],
        frames: [
            { uvMin: [0, 0], uvMax: [0.25, 0.25], sourceSizePx: [32, 32], pivot: [0.5, 0.5] },
            { uvMin: [0.25, 0], uvMax: [0.5, 0.25], sourceSizePx: [32, 32], pivot: [0.5, 0.5] },
        ],
        premultipliedAlpha: true,
    };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("createSpriteRenderer", () => {
    it("returns an object with _kind === 'sprite-renderer' and the RenderingContext methods", () => {
        const { engine } = makeMockEngine();
        const atlas = makeMockAtlas();
        const layer = createSprite2DLayer(atlas);
        const sr = createSpriteRenderer(engine, { layers: [layer] });
        expect(sr._kind).toBe("sprite-renderer");
        expect(typeof sr._update).toBe("function");
        expect(typeof sr._record).toBe("function");
        expect(sr._drawCallsPre).toBe(0);
        expect(sr.clearColor).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    });

    it("uses the supplied clearValue when provided", () => {
        const { engine } = makeMockEngine();
        const sr = createSpriteRenderer(engine, {
            layers: [createSprite2DLayer(makeMockAtlas())],
            clearValue: { r: 0.1, g: 0.2, b: 0.3, a: 1 },
        });
        expect(sr.clearColor).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    });
});

describe("registerSpriteRenderer / unregisterSpriteRenderer", () => {
    it("pushes the renderer onto its engine._renderingContexts", () => {
        const { engine } = makeMockEngine();
        const sr = createSpriteRenderer(engine, { layers: [createSprite2DLayer(makeMockAtlas())] });
        const list = (engine as EngineContextInternal)._renderingContexts;
        const before = list.length;
        registerSpriteRenderer(sr);
        expect(list.length).toBe(before + 1);
        expect(list[list.length - 1]).toBe(sr);
    });

    it("is idempotent — a second register call is a no-op", () => {
        const { engine } = makeMockEngine();
        const sr = createSpriteRenderer(engine, { layers: [createSprite2DLayer(makeMockAtlas())] });
        const list = (engine as EngineContextInternal)._renderingContexts;
        registerSpriteRenderer(sr);
        const len = list.length;
        registerSpriteRenderer(sr);
        expect(list.length).toBe(len);
    });

    it("registers only with the engine that created the renderer", () => {
        const { engine } = makeMockEngine();
        const { engine: otherEngine } = makeMockEngine();
        const sr = createSpriteRenderer(engine, { layers: [createSprite2DLayer(makeMockAtlas())] });

        registerSpriteRenderer(sr);

        expect((engine as EngineContextInternal)._renderingContexts).toContain(sr);
        expect((otherEngine as EngineContextInternal)._renderingContexts).not.toContain(sr);
    });

    it("splices the renderer out", () => {
        const { engine } = makeMockEngine();
        const sr = createSpriteRenderer(engine, { layers: [createSprite2DLayer(makeMockAtlas())] });
        const list = (engine as EngineContextInternal)._renderingContexts;
        const before = list.length;
        registerSpriteRenderer(sr);
        unregisterSpriteRenderer(sr);
        expect(list.length).toBe(before);
    });
});

describe("disposeSpriteRenderer", () => {
    it("unregisters the renderer from the engine", () => {
        const { engine } = makeMockEngine();
        const sr = createSpriteRenderer(engine, { layers: [createSprite2DLayer(makeMockAtlas())] });
        const list = (engine as EngineContextInternal)._renderingContexts;

        registerSpriteRenderer(sr);
        expect(list).toContain(sr);

        disposeSpriteRenderer(sr);

        expect(list).not.toContain(sr);
    });

    it("is idempotent after unregistering from the engine", () => {
        const { engine } = makeMockEngine();
        const sr = createSpriteRenderer(engine, { layers: [createSprite2DLayer(makeMockAtlas())] });
        const list = (engine as EngineContextInternal)._renderingContexts;

        registerSpriteRenderer(sr);
        disposeSpriteRenderer(sr);
        disposeSpriteRenderer(sr);

        expect(list).not.toContain(sr);
    });

    it("clears layers and destroys internal GPU buffers", () => {
        const { engine, counters } = makeMockEngine();
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [10, 10], sizePx: [32, 32], frame: 0 });
        const sr = createSpriteRenderer(engine, { layers: [layer] });

        // Force layer GPU resources to be allocated by running an update.
        const fakeEncoder = {} as GPUCommandEncoder;
        sr._update(fakeEncoder, 16);
        const createdBefore = counters.buffersCreated;
        expect(createdBefore).toBeGreaterThan(0);

        const destroyedBefore = counters.buffersDestroyed;
        disposeSpriteRenderer(sr);
        expect(sr.layers.length).toBe(0);
        expect(counters.buffersDestroyed).toBe(createdBefore);
        // Sanity: at least the new buffers (vs. before dispose) were destroyed.
        expect(counters.buffersDestroyed).toBeGreaterThan(destroyedBefore);
    });
});

describe("pipeline cache", () => {
    it("holds at most two entries when alpha + premultiplied layers are added", () => {
        const { engine } = makeMockEngine();
        const atlas = makeMockAtlas();
        const a = createSprite2DLayer(atlas, { blendMode: "alpha" });
        const b = createSprite2DLayer(atlas, { blendMode: "premultiplied" });
        const sr = createSpriteRenderer(engine, { layers: [a, b] });
        expect(_spriteRendererPipelineCacheSize(sr)).toBeLessThanOrEqual(2);
        expect(_spriteRendererPipelineCacheSize(sr)).toBe(2);
    });

    it("collapses identical-blendMode layers into a single pipeline-cache entry", () => {
        const { engine } = makeMockEngine();
        const atlas = makeMockAtlas();
        const a = createSprite2DLayer(atlas, { blendMode: "alpha" });
        const b = createSprite2DLayer(atlas, { blendMode: "alpha" });
        const sr = createSpriteRenderer(engine, { layers: [a, b] });
        expect(_spriteRendererPipelineCacheSize(sr)).toBe(1);
    });
});

describe("createSprite2DLayer guards", () => {
    it("throws on depth: 'test' (PR 3 territory)", () => {
        expect(() => createSprite2DLayer(makeMockAtlas(), { depth: "test" })).toThrow(/PR 3/);
    });

    it("throws on depth: 'test-write' (PR 3 territory)", () => {
        expect(() => createSprite2DLayer(makeMockAtlas(), { depth: "test-write" })).toThrow(/PR 3/);
    });

    it("throws on additive / multiply / cutout blend modes (later PR)", () => {
        expect(() => createSprite2DLayer(makeMockAtlas(), { blendMode: "additive" })).toThrow();
        expect(() => createSprite2DLayer(makeMockAtlas(), { blendMode: "multiply" })).toThrow();
        expect(() => createSprite2DLayer(makeMockAtlas(), { blendMode: "cutout" })).toThrow();
    });
});
