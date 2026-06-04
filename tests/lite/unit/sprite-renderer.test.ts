/**
 * Sprite renderer unit tests — pure CPU. Exercises the public lifecycle
 * (`createSpriteRenderer` / `registerSpriteRenderer` /
 * `unregisterSpriteRenderer` / `disposeSpriteRenderer`) plus layer membership,
 * pipeline-cache and depth-mode guard rails. Real GPU draws are covered
 * by the `scene50-sprite-grid` parity test.
 *
 * Note on test layout: vitest runs `tests/lite/**\/*.test.ts` per
 * `vitest.config.ts`, so this file lives under `tests/lite/unit/` rather than
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
    DEPTH_INSTANCE_STRIDE_BYTES,
    DEPTH_UVSCROLL_FLOATS_PER_SPRITE,
    DEPTH_UVSCROLL_STRIDE_BYTES,
    PURE_2D_INSTANCE_FLOATS_PER_SPRITE,
    PURE_2D_INSTANCE_STRIDE_BYTES,
    PURE_2D_UVSCROLL_FLOATS_PER_SPRITE,
    PURE_2D_UVSCROLL_STRIDE_BYTES,
    addSprite2DIndex,
    clearSprite2DLayer,
    createSprite2DLayer,
    setSprite2DShaderParams,
    setSprite2DUvOffset,
    updateSprite2DIndex,
} from "../../../packages/babylon-lite/src/sprite/sprite-2d";
import {
    createSpriteRenderer,
    addSpriteRendererLayer,
    removeSpriteRendererLayer,
    registerSpriteRenderer,
    unregisterSpriteRenderer,
    disposeSpriteRenderer,
    _spriteRendererPipelineCacheSize,
} from "../../../packages/babylon-lite/src/sprite/sprite-renderer";
import { createSpritePipelineCache, getOrCreateSpritePipeline } from "../../../packages/babylon-lite/src/sprite/sprite-pipeline";
import { spriteBlendAlpha, spriteBlendAdditive, spriteBlendPremultiplied, spriteBlendMultiply } from "../../../packages/babylon-lite/src/sprite/sprite-blend";
import { createSprite2DCustomShader } from "../../../packages/babylon-lite/src/sprite/sprite-custom-shader";
import type { SpriteAtlas } from "../../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

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

    const eng = {
        canvas: {} as HTMLCanvasElement,
        msaaSamples: 4,
        drawCallCount: 0,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        maxDevicePixelRatio: Infinity,
        _device: device,
        _context: {} as GPUCanvasContext,
        format: "bgra8unorm",
        _alphaMode: "opaque",
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
        _currentEncoder: {} as GPUCommandEncoder,
        _swapchainView: {} as GPUTextureView,
        _currentDelta: 0,
        _cbs: [],
    } as EngineContext;

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

    it("builds pure-2D pipelines with a 52-byte instance stride and no z attribute", () => {
        const { engine } = makeMockEngine();
        createSpriteRenderer(engine, { layers: [createSprite2DLayer(makeMockAtlas())] });

        const device = engine._device as unknown as { createRenderPipeline: ReturnType<typeof vi.fn>; createShaderModule: ReturnType<typeof vi.fn> };
        const descriptor = device.createRenderPipeline.mock.calls[0]![0] as GPURenderPipelineDescriptor;
        const vertexBuffer = (descriptor.vertex.buffers as GPUVertexBufferLayout[])[0]!;
        const shaderLocations = (vertexBuffer.attributes as GPUVertexAttribute[]).map((attr) => attr.shaderLocation);

        expect(vertexBuffer.arrayStride).toBe(PURE_2D_INSTANCE_STRIDE_BYTES);
        expect(shaderLocations).toEqual([0, 1, 2, 3, 4, 5]);

        const shaderDescriptor = device.createShaderModule.mock.calls[0]![0] as GPUShaderModuleDescriptor;
        expect(shaderDescriptor.code).not.toContain("iZ");
        expect(shaderDescriptor.code).not.toContain("iUvOffset");
        expect(shaderDescriptor.code).toContain("vec4<f32>(ndc, 0.0, 1.0)");
    });

    it("converts depth-hosted sprite NDC Z to reverse-Z clip depth", () => {
        const { engine } = makeMockEngine();
        const cache = createSpritePipelineCache();
        const sceneBGL = {} as GPUBindGroupLayout;

        getOrCreateSpritePipeline(engine, cache, "bgra8unorm", 4, spriteBlendAlpha, true, false, "depth24plus-stencil8", sceneBGL);

        const device = engine._device as unknown as { createRenderPipeline: ReturnType<typeof vi.fn>; createShaderModule: ReturnType<typeof vi.fn> };
        const shaderDescriptor = device.createShaderModule.mock.calls[0]![0] as GPUShaderModuleDescriptor;
        const descriptor = device.createRenderPipeline.mock.calls[0]![0] as GPURenderPipelineDescriptor;
        expect(shaderDescriptor.code).toContain("vec4<f32>(ndc, 1.0 - in.iZ, 1.0)");
        expect(descriptor.depthStencil?.depthCompare).toBe("greater-equal");
    });
});

describe("uvScroll (per-sprite uvOffset)", () => {
    it("widens the pure-2D layer to 15 floats / 60 bytes and never names _uvScroll when off", () => {
        const off = createSprite2DLayer(makeMockAtlas());
        expect(off._instanceFloatsPerSprite).toBe(PURE_2D_INSTANCE_FLOATS_PER_SPRITE);
        expect(off._instanceStrideBytes).toBe(PURE_2D_INSTANCE_STRIDE_BYTES);
        expect(Object.prototype.hasOwnProperty.call(off, "_uvScroll")).toBe(false);

        const on = createSprite2DLayer(makeMockAtlas(), { uvScroll: true });
        expect(on._uvScroll).toBe(true);
        expect(on._instanceFloatsPerSprite).toBe(PURE_2D_UVSCROLL_FLOATS_PER_SPRITE);
        expect(on._instanceStrideBytes).toBe(PURE_2D_UVSCROLL_STRIDE_BYTES);
        expect(PURE_2D_UVSCROLL_STRIDE_BYTES).toBe(60);
    });

    it("widens the depth-hosted layer to 16 floats / 64 bytes (Z stays at slot 13)", () => {
        const on = createSprite2DLayer(makeMockAtlas(), { depth: "test", uvScroll: true });
        expect(on._instanceFloatsPerSprite).toBe(DEPTH_UVSCROLL_FLOATS_PER_SPRITE);
        expect(on._instanceStrideBytes).toBe(DEPTH_UVSCROLL_STRIDE_BYTES);
        expect(DEPTH_UVSCROLL_STRIDE_BYTES).toBe(64);
    });

    it("builds a pure-2D uvScroll pipeline with a 60-byte stride and a location-7 iUvOffset attribute", () => {
        const { engine } = makeMockEngine();
        const cache = createSpritePipelineCache();
        const layer = createSprite2DLayer(makeMockAtlas(), { uvScroll: true });

        getOrCreateSpritePipeline(engine, cache, "bgra8unorm", 4, spriteBlendAlpha, false, false, undefined, undefined, layer);

        const device = engine._device as unknown as { createRenderPipeline: ReturnType<typeof vi.fn>; createShaderModule: ReturnType<typeof vi.fn> };
        const descriptor = device.createRenderPipeline.mock.calls[0]![0] as GPURenderPipelineDescriptor;
        const vertexBuffer = (descriptor.vertex.buffers as GPUVertexBufferLayout[])[0]!;
        const shaderLocations = (vertexBuffer.attributes as GPUVertexAttribute[]).map((attr) => attr.shaderLocation);

        expect(vertexBuffer.arrayStride).toBe(PURE_2D_UVSCROLL_STRIDE_BYTES);
        expect(shaderLocations).toEqual([0, 1, 2, 3, 4, 5, 7]);
        const uvAttr = (vertexBuffer.attributes as GPUVertexAttribute[]).find((a) => a.shaderLocation === 7)!;
        expect(uvAttr.offset).toBe(52);
        expect(uvAttr.format).toBe("float32x2");

        const shaderDescriptor = device.createShaderModule.mock.calls[0]![0] as GPUShaderModuleDescriptor;
        expect(shaderDescriptor.code).toContain("@location(7) iUvOffset: vec2<f32>");
        expect(shaderDescriptor.code).toContain("+ in.iUvOffset");
    });

    it("builds a depth-hosted uvScroll pipeline with a 64-byte stride and uvOffset at byte offset 56", () => {
        const { engine } = makeMockEngine();
        const cache = createSpritePipelineCache();
        const sceneBGL = {} as GPUBindGroupLayout;
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test", uvScroll: true });

        getOrCreateSpritePipeline(engine, cache, "bgra8unorm", 4, spriteBlendAlpha, true, false, "depth24plus-stencil8", sceneBGL, layer);

        const device = engine._device as unknown as { createRenderPipeline: ReturnType<typeof vi.fn> };
        const descriptor = device.createRenderPipeline.mock.calls[0]![0] as GPURenderPipelineDescriptor;
        const vertexBuffer = (descriptor.vertex.buffers as GPUVertexBufferLayout[])[0]!;
        const shaderLocations = (vertexBuffer.attributes as GPUVertexAttribute[]).map((attr) => attr.shaderLocation);

        expect(vertexBuffer.arrayStride).toBe(DEPTH_UVSCROLL_STRIDE_BYTES);
        expect(shaderLocations).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        const uvAttr = (vertexBuffer.attributes as GPUVertexAttribute[]).find((a) => a.shaderLocation === 7)!;
        expect(uvAttr.offset).toBe(56);
    });

    it("writes uvOffset into slot 13 on add (pure-2D), preserves on update, and defaults to [0,0]", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { uvScroll: true });
        const i0 = addSprite2DIndex(layer, { positionPx: [10, 20], sizePx: [32, 32], frame: 0, uvOffset: [0.25, 0.5] });
        const i1 = addSprite2DIndex(layer, { positionPx: [40, 50], sizePx: [32, 32], frame: 0 });

        const stride = layer._instanceFloatsPerSprite;
        expect(layer._instanceData[i0 * stride + 13]).toBeCloseTo(0.25);
        expect(layer._instanceData[i0 * stride + 14]).toBeCloseTo(0.5);
        // Omitted on add → cleared to [0,0].
        expect(layer._instanceData[i1 * stride + 13]).toBe(0);
        expect(layer._instanceData[i1 * stride + 14]).toBe(0);

        // Update without uvOffset preserves it; position still moves.
        updateSprite2DIndex(layer, i0, { positionPx: [11, 21] });
        expect(layer._instanceData[i0 * stride + 13]).toBeCloseTo(0.25);
        expect(layer._instanceData[i0 * stride + 14]).toBeCloseTo(0.5);
    });

    it("writes uvOffset into slot 14 on a depth-hosted layer and leaves Z at slot 13 intact", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test", uvScroll: true, layerZ: 0.3 });
        const i = addSprite2DIndex(layer, { positionPx: [10, 20], sizePx: [32, 32], frame: 0, z: 0.7, uvOffset: [0.1, 0.2] });
        const stride = layer._instanceFloatsPerSprite;
        expect(layer._instanceData[i * stride + 13]).toBeCloseTo(0.7); // Z
        expect(layer._instanceData[i * stride + 14]).toBeCloseTo(0.1);
        expect(layer._instanceData[i * stride + 15]).toBeCloseTo(0.2);
    });

    it("setSprite2DUvOffset writes the live offset and throws on a non-uvScroll layer", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { uvScroll: true });
        const i = addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0 });
        setSprite2DUvOffset(layer, i, [0.75, 0.125]);
        const stride = layer._instanceFloatsPerSprite;
        expect(layer._instanceData[i * stride + 13]).toBeCloseTo(0.75);
        expect(layer._instanceData[i * stride + 14]).toBeCloseTo(0.125);

        const plain = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(plain, { positionPx: [0, 0], sizePx: [32, 32], frame: 0 });
        expect(() => setSprite2DUvOffset(plain, 0, [0, 0])).toThrow(/uvScroll/);
    });

    it("keeps the non-uvScroll instance buffer byte-identical (no uvOffset slot)", () => {
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [10, 20], sizePx: [32, 32], frame: 0 });
        expect(layer._instanceData.length).toBe(layer._capacity * PURE_2D_INSTANCE_FLOATS_PER_SPRITE);
        // The public uvOffset prop is silently ignored when the layer is not a uvScroll layer.
        expect(() => addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [32, 32], frame: 0, uvOffset: [0.5, 0.5] })).not.toThrow();
    });
});

describe("addSpriteRendererLayer / removeSpriteRendererLayer", () => {
    it("adds layers through the renderer lifecycle API and prewarms their pipeline", () => {
        const { engine } = makeMockEngine();
        const layer = createSprite2DLayer(makeMockAtlas(), { blendMode: spriteBlendPremultiplied });
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
        const list = engine._renderingContexts;
        const before = list.length;
        registerSpriteRenderer(sr);
        expect(list.length).toBe(before + 1);
        expect(list[list.length - 1]).toBe(sr);
    });

    it("is idempotent — a second register call is a no-op", () => {
        const { engine } = makeMockEngine();
        const sr = createSpriteRenderer(engine, { layers: [createSprite2DLayer(makeMockAtlas())] });
        const list = engine._renderingContexts;
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

        expect(engine._renderingContexts).toContain(sr);
        expect(otherEngine._renderingContexts).not.toContain(sr);
    });

    it("splices the renderer out", () => {
        const { engine } = makeMockEngine();
        const sr = createSpriteRenderer(engine, { layers: [createSprite2DLayer(makeMockAtlas())] });
        const list = engine._renderingContexts;
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
        const list = engine._renderingContexts;

        registerSpriteRenderer(sr);
        expect(list).toContain(sr);

        disposeSpriteRenderer(sr);

        expect(list).not.toContain(sr);
    });

    it("is idempotent after unregistering from the engine", () => {
        const { engine } = makeMockEngine();
        const sr = createSpriteRenderer(engine, { layers: [createSprite2DLayer(makeMockAtlas())] });
        const list = engine._renderingContexts;

        registerSpriteRenderer(sr);
        disposeSpriteRenderer(sr);
        disposeSpriteRenderer(sr);

        expect(list).not.toContain(sr);
    });

    it("runs internal disposal callbacks once", () => {
        const { engine } = makeMockEngine();
        const sr = createSpriteRenderer(engine, { layers: [createSprite2DLayer(makeMockAtlas())] });
        const internal = sr as unknown as { _disposeCallbacks: Array<() => void> };
        const callback = vi.fn();

        internal._disposeCallbacks.push(callback);
        disposeSpriteRenderer(sr);
        disposeSpriteRenderer(sr);

        expect(callback).toHaveBeenCalledTimes(1);
        expect(internal._disposeCallbacks).toEqual([]);
    });

    it("clears layers and destroys internal GPU buffers", () => {
        const { engine, counters } = makeMockEngine();
        const layer = createSprite2DLayer(makeMockAtlas());
        addSprite2DIndex(layer, { positionPx: [10, 10], sizePx: [32, 32], frame: 0 });
        const sr = createSpriteRenderer(engine, { layers: [layer] });

        // Force layer GPU resources to be allocated by running an update.
        const fakeEncoder = {} as GPUCommandEncoder;
        (sr._update as (...args: unknown[]) => void)(fakeEncoder, 16);
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
        const a = createSprite2DLayer(atlas, { blendMode: spriteBlendAlpha });
        const b = createSprite2DLayer(atlas, { blendMode: spriteBlendPremultiplied });
        const sr = createSpriteRenderer(engine, { layers: [a, b] });
        expect(_spriteRendererPipelineCacheSize(sr)).toBeLessThanOrEqual(2);
        expect(_spriteRendererPipelineCacheSize(sr)).toBe(2);
    });

    it("collapses identical-blendMode layers into a single pipeline-cache entry", () => {
        const { engine } = makeMockEngine();
        const atlas = makeMockAtlas();
        const a = createSprite2DLayer(atlas, { blendMode: spriteBlendAlpha });
        const b = createSprite2DLayer(atlas, { blendMode: spriteBlendAlpha });
        const sr = createSpriteRenderer(engine, { layers: [a, b] });
        expect(_spriteRendererPipelineCacheSize(sr)).toBe(1);
    });
});

describe("pure-2D instance layout", () => {
    it("uses 13 floats per sprite and does not allocate a z slot", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 1 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10], z: 0.91 });

        expect(layer._instanceFloatsPerSprite).toBe(PURE_2D_INSTANCE_FLOATS_PER_SPRITE);
        expect(layer._instanceStrideBytes).toBe(PURE_2D_INSTANCE_STRIDE_BYTES);
        expect(layer._instanceData.length).toBe(PURE_2D_INSTANCE_FLOATS_PER_SPRITE);
        expect(layer._instanceData[13]).toBeUndefined();
    });

    it("allocates and uploads pure SpriteRenderer instances as 52 bytes per sprite", () => {
        const { engine } = makeMockEngine();
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 1 });
        addSprite2DIndex(layer, { positionPx: [10, 10], sizePx: [32, 32], frame: 0, z: 0.25 });
        const sr = createSpriteRenderer(engine, { layers: [layer] });
        const device = engine._device as unknown as { createBuffer: ReturnType<typeof vi.fn>; queue: { writeBuffer: ReturnType<typeof vi.fn> } };
        device.createBuffer.mockClear();
        device.queue.writeBuffer.mockClear();

        sr._update();

        const instanceBufferCreate = device.createBuffer.mock.calls.find((call) => (call[0] as GPUBufferDescriptor).label === "sprite-layer-instances");
        expect((instanceBufferCreate![0] as GPUBufferDescriptor).size).toBe(PURE_2D_INSTANCE_STRIDE_BYTES);
        expect(device.queue.writeBuffer.mock.calls.some((call) => call[4] === PURE_2D_INSTANCE_STRIDE_BYTES)).toBe(true);
        expect(device.queue.writeBuffer.mock.calls.some((call) => call[4] === DEPTH_INSTANCE_STRIDE_BYTES)).toBe(false);
    });
});

describe("Sprite2D custom shader", () => {
    const FX_FRAGMENT = `return textureSample(atlasTex, atlasSamp, in.uv) * in.tint * (0.5 + 0.5 * sin(fx.time + fx.params.x));`;

    it("createSprite2DCustomShader returns a descriptor and rejects empty source", () => {
        const cs = createSprite2DCustomShader({ fragment: FX_FRAGMENT });
        expect(cs._entityType).toBe("sprite-2d-custom-shader");
        expect(typeof cs._key).toBe("string");
        expect(() => createSprite2DCustomShader({ fragment: "   " })).toThrow();
    });

    it("assigns distinct keys to distinct shaders", () => {
        const a = createSprite2DCustomShader({ fragment: FX_FRAGMENT });
        const b = createSprite2DCustomShader({ fragment: FX_FRAGMENT });
        expect(a._key).not.toBe(b._key);
    });

    it("rejects invalid extra-texture names", () => {
        const makeTex = () => ({ view: {}, sampler: {} }) as unknown as import("../../../packages/babylon-lite/src/texture/texture-2d").Texture2D;
        expect(() => createSprite2DCustomShader({ fragment: FX_FRAGMENT, extraTextures: [{ name: "1bad", texture: makeTex() }] })).toThrow();
    });

    it("composes WGSL that wraps the user fragment body with the SpriteFx UBO and fs entry point", () => {
        const cs = createSprite2DCustomShader({ fragment: FX_FRAGMENT });
        const wgsl = cs._composeWgsl(false, 0, false);
        expect(wgsl).toContain("@binding(3) var<uniform> fx: SpriteFx");
        expect(wgsl).toContain("fn fs(in: VOut) -> @location(0) vec4<f32>");
        expect(wgsl).toContain(FX_FRAGMENT);
        // The vertex prologue must still be present.
        expect(wgsl).toContain("fn vs(in: VIn)");
        expect(wgsl).toContain("var atlasTex");
    });

    it("places the fx UBO after extra textures and binds them", () => {
        const makeTex = () => ({ view: {}, sampler: {} }) as unknown as import("../../../packages/babylon-lite/src/texture/texture-2d").Texture2D;
        const cs = createSprite2DCustomShader({
            fragment: FX_FRAGMENT,
            extraTextures: [
                { name: "palette", texture: makeTex() },
                { name: "noise", texture: makeTex() },
            ],
        });
        const wgsl = cs._composeWgsl(false, 0, false);
        expect(wgsl).toContain("@binding(3) var paletteTex: texture_2d<f32>");
        expect(wgsl).toContain("@binding(4) var paletteSamp: sampler");
        expect(wgsl).toContain("@binding(5) var noiseTex: texture_2d<f32>");
        expect(wgsl).toContain("@binding(6) var noiseSamp: sampler");
        expect(wgsl).toContain("@binding(7) var<uniform> fx: SpriteFx");
    });

    it("createSprite2DLayer stores the custom shader on pure-2D and depth-hosted layers", () => {
        const cs = createSprite2DCustomShader({ fragment: FX_FRAGMENT });
        const layer = createSprite2DLayer(makeMockAtlas(), { customShader: cs });
        expect(layer.customShader).toBe(cs);
        expect(layer.shaderParams).toEqual([0, 0, 0, 0]);
        const depthLayer = createSprite2DLayer(makeMockAtlas(), { customShader: cs, depth: "test" });
        expect(depthLayer.customShader).toBe(cs);
    });

    it("setSprite2DShaderParams mutates the params vec4 in place", () => {
        const layer = createSprite2DLayer(makeMockAtlas());
        setSprite2DShaderParams(layer, [1, 2, 3, 4]);
        expect(layer.shaderParams).toEqual([1, 2, 3, 4]);
    });

    it("getOrCreateSpritePipeline builds a distinct pipeline + module for a custom shader", () => {
        const { engine, counters } = makeMockEngine();
        const eng = engine;
        const cache = createSpritePipelineCache();
        const plain = getOrCreateSpritePipeline(eng, cache, eng.format, 1, spriteBlendAlpha, false);
        const modulesAfterPlain = counters.shaderModules;
        const cs = createSprite2DCustomShader({ fragment: FX_FRAGMENT });
        const customLayer = createSprite2DLayer(makeMockAtlas(), { customShader: cs });
        const custom = getOrCreateSpritePipeline(eng, cache, eng.format, 1, spriteBlendAlpha, false, false, undefined, undefined, customLayer);
        expect(custom).not.toBe(plain);
        expect(counters.shaderModules).toBeGreaterThan(modulesAfterPlain);
        // Re-requesting the same custom shader hits the cache (no new pipeline).
        const again = getOrCreateSpritePipeline(eng, cache, eng.format, 1, spriteBlendAlpha, false, false, undefined, undefined, customLayer);
        expect(again).toBe(custom);
    });

    it("renderer allocates a 32-byte FX UBO and uploads time/params for a custom-shader layer", () => {
        const { engine } = makeMockEngine();
        const cs = createSprite2DCustomShader({ fragment: FX_FRAGMENT });
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 1, customShader: cs });
        addSprite2DIndex(layer, { positionPx: [10, 10], sizePx: [32, 32] });
        const sr = createSpriteRenderer(engine, { layers: [layer] });
        const device = engine._device as unknown as { createBuffer: ReturnType<typeof vi.fn>; queue: { writeBuffer: ReturnType<typeof vi.fn> } };

        sr._update();

        const fxCreate = device.createBuffer.mock.calls.find((call) => (call[0] as GPUBufferDescriptor).label === "sprite-layer-fx-ubo");
        expect(fxCreate).toBeDefined();
        expect((fxCreate![0] as GPUBufferDescriptor).size).toBe(32);
        expect(device.queue.writeBuffer.mock.calls.some((call) => call[4] === 32)).toBe(true);
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

    it("accepts additive blend mode and stores it", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { blendMode: spriteBlendAdditive });
        expect(layer.blendMode).toBe(spriteBlendAdditive);
    });

    it("exposes multiply blend mode with src*dst factors and no premultiplied opacity", () => {
        expect(spriteBlendMultiply._key).toBe("multiply");
        expect(spriteBlendMultiply._premultipliedOpacity).toBeUndefined();
        expect(spriteBlendMultiply._descriptor).toEqual({
            color: { srcFactor: "dst", dstFactor: "zero", operation: "add" },
            alpha: { srcFactor: "dst-alpha", dstFactor: "zero", operation: "add" },
        });
        const layer = createSprite2DLayer(makeMockAtlas(), { blendMode: spriteBlendMultiply });
        expect(layer.blendMode).toBe(spriteBlendMultiply);
    });
});

describe("Sprite2DLayer index lifecycle", () => {
    it("clears sprites while preserving capacity and bumping version once", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { capacity: 4 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10] });
        addSprite2DIndex(layer, { positionPx: [20, 0], sizePx: [10, 10], visible: false });
        const versionBefore = layer._version;

        clearSprite2DLayer(layer);

        expect(layer.count).toBe(0);
        expect(layer._capacity).toBe(4);
        expect(layer._dirtyMin).toBe(0);
        expect(layer._dirtyMax).toBe(0);
        expect(layer._version).toBe((versionBefore + 1) | 0);
        expect(Array.from(layer._savedSize.slice(0, 4))).toEqual([0, 0, 0, 0]);
    });
});

describe("depth-hosted per-instance Z (slot [13] of the per-instance vertex buffer)", () => {
    it("addSprite2DIndex without `z` defaults to layer.layerZ", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test", layerZ: 0.42 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10] });
        expect(layer._instanceFloatsPerSprite).toBe(DEPTH_INSTANCE_FLOATS_PER_SPRITE);
        // Slot 13 of instance #0. `toBeCloseTo` accommodates Float32Array precision rounding.
        expect(layer._instanceData[13]).toBeCloseTo(0.42);
    });

    it("addSprite2DIndex with explicit `z` writes that value into slot [13]", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test", layerZ: 0.5 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10], z: 0.91 });
        expect(layer._instanceData[13]).toBeCloseTo(0.91);
    });

    it("each sprite carries its own `z` independently within the same layer", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test", layerZ: 0.5 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10], z: 0.6 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10], z: 0.87 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10], z: 0.95 });
        expect(layer._instanceData[0 * DEPTH_INSTANCE_FLOATS_PER_SPRITE + 13]).toBeCloseTo(0.6);
        expect(layer._instanceData[1 * DEPTH_INSTANCE_FLOATS_PER_SPRITE + 13]).toBeCloseTo(0.87);
        expect(layer._instanceData[2 * DEPTH_INSTANCE_FLOATS_PER_SPRITE + 13]).toBeCloseTo(0.95);
    });

    it("mutating layer.layerZ does not retroactively change existing sprites' z", () => {
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test", layerZ: 0.3 });
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10] });
        layer.layerZ = 0.8;
        // Existing sprite still at the original 0.3 default it inherited at add time.
        expect(layer._instanceData[13]).toBeCloseTo(0.3);
        // New sprite picks up the new layer default.
        addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [10, 10] });
        expect(layer._instanceData[1 * DEPTH_INSTANCE_FLOATS_PER_SPRITE + 13]).toBeCloseTo(0.8);
    });
});
