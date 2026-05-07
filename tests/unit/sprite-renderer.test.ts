/**
 * Sprite renderer unit tests — pure CPU. Exercises the public lifecycle
 * (`createSpriteRenderer` / `registerSpriteRenderer` /
 * `unregisterSpriteRenderer` / `disposeSpriteRenderer`) plus layer membership,
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

import {
    DEPTH_INSTANCE_FLOATS_PER_SPRITE,
    PURE_2D_INSTANCE_FLOATS_PER_SPRITE,
    PURE_2D_INSTANCE_STRIDE_BYTES,
    createSprite2DLayer,
    addSprite2DIndex,
} from "../../packages/babylon-lite/src/sprite/sprite-2d";
import {
    createSpriteRenderer,
    addSpriteRendererLayer,
    removeSpriteRendererLayer,
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
            return { _kind: "pipeline", getBindGroupLayout: vi.fn((index: number) => ({ _kind: "pipeline-bgl", index })) };
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

    it("rejects depth-hosted layers before allocating renderer GPU resources", () => {
        const { engine, counters } = makeMockEngine();
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test" });
        expect(() => createSpriteRenderer(engine, { layers: [layer] })).toThrow(/depth: "none"/);
        expect(counters.buffersCreated).toBe(0);
    });

    it("builds pure-2D pipelines with a 40-byte instance stride and no z attribute", () => {
        const { engine } = makeMockEngine();
        createSpriteRenderer(engine, { layers: [createSprite2DLayer(makeMockAtlas())] });

        const device = engine.device as unknown as { createRenderPipeline: ReturnType<typeof vi.fn>; createShaderModule: ReturnType<typeof vi.fn> };
        const descriptor = device.createRenderPipeline.mock.calls[0]![0] as GPURenderPipelineDescriptor;
        const vertexBuffer = (descriptor.vertex.buffers as GPUVertexBufferLayout[])[0]!;
        const shaderLocations = vertexBuffer.attributes.map((attr) => attr.shaderLocation);

        expect(vertexBuffer.arrayStride).toBe(PURE_2D_INSTANCE_STRIDE_BYTES);
        expect(shaderLocations).toEqual([0, 1, 2, 3, 4, 5]);

        const shaderDescriptor = device.createShaderModule.mock.calls[0]![0] as GPUShaderModuleDescriptor;
        expect(shaderDescriptor.code).not.toContain("iZ");
        expect(shaderDescriptor.code).toContain("vec4<f32>(ndc, 0.0, 1.0)");
    });
});

describe("addSpriteRendererLayer / removeSpriteRendererLayer", () => {
    it("adds layers through the renderer lifecycle API and prewarms their pipeline", () => {
        const { engine } = makeMockEngine();
        const layer = createSprite2DLayer(makeMockAtlas(), { blendMode: "premultiplied" });
        const sr = createSpriteRenderer(engine, { layers: [] });

        addSpriteRendererLayer(sr, layer);
        addSpriteRendererLayer(sr, layer);

        expect(sr.layers).toEqual([layer]);
        expect(_spriteRendererPipelineCacheSize(sr)).toBe(1);
    });

    it("rejects depth-hosted layers added after creation", () => {
        const { engine } = makeMockEngine();
        const sr = createSpriteRenderer(engine, { layers: [createSprite2DLayer(makeMockAtlas())] });
        expect(() => addSpriteRendererLayer(sr, createSprite2DLayer(makeMockAtlas(), { depth: "test-write" }))).toThrow(/depth: "none"/);
    });

    it("removes layers and destroys their per-layer GPU buffers", () => {
        const { engine, counters } = makeMockEngine();
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [10, 10], sizePx: [32, 32], frame: 0 });
        const sr = createSpriteRenderer(engine, { layers: [layer] });

        sr._update();
        const destroyedBefore = counters.buffersDestroyed;

        expect(removeSpriteRendererLayer(sr, layer)).toBe(true);
        expect(sr.layers.length).toBe(0);
        expect(counters.buffersDestroyed - destroyedBefore).toBe(2);
        expect(removeSpriteRendererLayer(sr, layer)).toBe(false);
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

describe("pure-2D instance layout", () => {
    it("uses 10 floats per sprite and does not allocate a z slot", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 1 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10], z: 0.91 });

        expect(layer._instanceFloatsPerSprite).toBe(PURE_2D_INSTANCE_FLOATS_PER_SPRITE);
        expect(layer._instanceStrideBytes).toBe(PURE_2D_INSTANCE_STRIDE_BYTES);
        expect(layer._instanceData.length).toBe(PURE_2D_INSTANCE_FLOATS_PER_SPRITE);
        expect(layer._instanceData[10]).toBeUndefined();
    });

    it("allocates and uploads pure SpriteRenderer instances as 40 bytes per sprite", () => {
        const { engine } = makeMockEngine();
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 1 });
        addSprite2DIndex(layer, { positionPx: [10, 10], sizePx: [32, 32], frame: 0, z: 0.25 });
        const sr = createSpriteRenderer(engine, { layers: [layer] });
        const device = engine.device as unknown as { createBuffer: ReturnType<typeof vi.fn>; queue: { writeBuffer: ReturnType<typeof vi.fn> } };
        device.createBuffer.mockClear();
        device.queue.writeBuffer.mockClear();

        sr._update();

        const instanceBufferCreate = device.createBuffer.mock.calls.find((call) => (call[0] as GPUBufferDescriptor).label === "sprite-layer-instances");
        expect((instanceBufferCreate![0] as GPUBufferDescriptor).size).toBe(PURE_2D_INSTANCE_STRIDE_BYTES);
        expect(device.queue.writeBuffer.mock.calls.some((call) => call[4] === PURE_2D_INSTANCE_STRIDE_BYTES)).toBe(true);
        expect(device.queue.writeBuffer.mock.calls.some((call) => call[4] === 44)).toBe(false);
    });
});

describe("createSprite2DLayer guards", () => {
    it("accepts depth: 'test' (PR 3 depth-hosted)", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test" });
        expect(layer.depth).toBe("test");
    });

    it("accepts depth: 'test-write' (PR 3 depth-hosted)", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test-write" });
        expect(layer.depth).toBe("test-write");
    });

    it("layerZ defaults to 0.5 and accepts an override", () => {
        const def = createSprite2DLayer(makeMockAtlas());
        expect(def.layerZ).toBe(0.5);
        const custom = createSprite2DLayer(makeMockAtlas(), { layerZ: 0.25 });
        expect(custom.layerZ).toBe(0.25);
    });

    it("throws on additive / multiply / cutout blend modes (later PR)", () => {
        expect(() => createSprite2DLayer(makeMockAtlas(), { blendMode: "additive" })).toThrow();
        expect(() => createSprite2DLayer(makeMockAtlas(), { blendMode: "multiply" })).toThrow();
        expect(() => createSprite2DLayer(makeMockAtlas(), { blendMode: "cutout" })).toThrow();
    });
});

describe("depth-hosted per-instance Z (slot [10] of the per-instance vertex buffer)", () => {
    it("addSprite2DIndex without `z` defaults to layer.layerZ", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test", layerZ: 0.42 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10] });
        expect(layer._instanceFloatsPerSprite).toBe(DEPTH_INSTANCE_FLOATS_PER_SPRITE);
        // Slot 10 of instance #0. `toBeCloseTo` accommodates Float32Array precision rounding.
        expect(layer._instanceData[10]).toBeCloseTo(0.42);
    });

    it("addSprite2DIndex with explicit `z` writes that value into slot [10]", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test", layerZ: 0.5 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10], z: 0.91 });
        expect(layer._instanceData[10]).toBeCloseTo(0.91);
    });

    it("each sprite carries its own `z` independently within the same layer", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test", layerZ: 0.5 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10], z: 0.6 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10], z: 0.87 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10], z: 0.95 });
        expect(layer._instanceData[0 * DEPTH_INSTANCE_FLOATS_PER_SPRITE + 10]).toBeCloseTo(0.6);
        expect(layer._instanceData[1 * DEPTH_INSTANCE_FLOATS_PER_SPRITE + 10]).toBeCloseTo(0.87);
        expect(layer._instanceData[2 * DEPTH_INSTANCE_FLOATS_PER_SPRITE + 10]).toBeCloseTo(0.95);
    });

    it("mutating layer.layerZ does not retroactively change existing sprites' z", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test", layerZ: 0.3 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10] });
        layer.layerZ = 0.8;
        // Existing sprite still at the original 0.3 default it inherited at add time.
        expect(layer._instanceData[10]).toBeCloseTo(0.3);
        // New sprite picks up the new layer default.
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10] });
        expect(layer._instanceData[1 * DEPTH_INSTANCE_FLOATS_PER_SPRITE + 10]).toBeCloseTo(0.8);
    });
});
