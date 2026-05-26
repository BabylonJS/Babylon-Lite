/**
 * Sprite depth-hosted routing tests (PR 3).
 *
 * Verifies that adding a `Sprite2DLayer` with `depth: "test"` or
 * `"test-write"` to a `SceneContext` via `addDepthHostedSpriteLayer`:
 *   - registers a deferred builder (no eager GPU work),
 *   - lands the produced `Renderable` in `scene._renderables` with the right
 *     transparency/order metadata for frame-graph bucketing,
 *   - registers a disposable that runs on `disposeScene`.
 *
 * Also verifies that `depth: "none"` layers throw with a message that names
 * the depth-mode requirement (`SpriteRenderer` is the correct path for HUD overlays).
 */
import { describe, it, expect, vi } from "vitest";

// Stub WebGPU bit-flag enums the renderable / pipeline modules read at module-call time.
const G = globalThis as unknown as Record<string, unknown>;
G.GPUBufferUsage ??= { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8, MAP_WRITE: 1 };
G.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
G.GPUColorWrite ??= { ALL: 0xf };
G.GPUTextureUsage ??= { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };

import { DEPTH_INSTANCE_STRIDE_BYTES, addSprite2DIndex, createSprite2DLayer } from "../../packages/babylon-lite/src/sprite/sprite-2d";
import { addDepthHostedSpriteLayer } from "../../packages/babylon-lite/src/sprite/sprite-scene";
import { createSceneContext, disposeScene } from "../../packages/babylon-lite/src/scene/scene";
import { registerScene } from "../../packages/babylon-lite/src/scene/scene-core";
import type { SceneContextInternal } from "../../packages/babylon-lite/src/scene/scene-core";
import { LAYER_UBO_BYTES } from "../../packages/babylon-lite/src/sprite/sprite-pipeline";
import type { SpriteAtlas } from "../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import type { Texture2D } from "../../packages/babylon-lite/src/texture/texture-2d";
import type { EngineContext, EngineContextInternal } from "../../packages/babylon-lite/src/engine/engine";

interface MockBuffer {
    destroy: ReturnType<typeof vi.fn>;
    getMappedRange: ReturnType<typeof vi.fn>;
    unmap: ReturnType<typeof vi.fn>;
}

function mockBuffer(): MockBuffer {
    return {
        destroy: vi.fn(),
        getMappedRange: vi.fn(() => new ArrayBuffer(64)),
        unmap: vi.fn(),
    };
}

function makeMockEngine(): EngineContext {
    const queue = { writeBuffer: vi.fn() };
    const device = {
        createBuffer: vi.fn(() => mockBuffer()),
        createShaderModule: vi.fn(() => ({ _kind: "shader" })),
        createBindGroupLayout: vi.fn(() => ({ _kind: "bgl" })),
        createPipelineLayout: vi.fn(() => ({ _kind: "pl" })),
        createRenderPipeline: vi.fn(() => ({ _kind: "pipeline", getBindGroupLayout: vi.fn((index: number) => ({ _kind: "pipeline-bgl", index })) })),
        createBindGroup: vi.fn(() => ({ _kind: "bg" })),
        createTexture: vi.fn(() => ({
            createView: vi.fn(() => ({ _kind: "view" })),
            destroy: vi.fn(),
        })),
        queue,
    } as unknown as GPUDevice;

    return {
        canvas: { width: 800, height: 600 } as HTMLCanvasElement,
        msaaSamples: 4,
        drawCallCount: 0,
        device,
        context: {} as GPUCanvasContext,
        format: "bgra8unorm",
        alphaMode: "opaque",
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
        _currentEncoder: {} as GPUCommandEncoder,
        _swapchainView: {} as GPUTextureView,
        _currentDelta: 0,
        _cbs: [],
    } as EngineContextInternal;
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
        frames: [{ uvMin: [0, 0], uvMax: [0.25, 0.25], sourceSizePx: [32, 32], pivot: [0.5, 0.5] }],
        premultipliedAlpha: true,
    };
}

function makeDrawPassMock(): GPURenderPassEncoder {
    return {
        setBindGroup: vi.fn(),
        setIndexBuffer: vi.fn(),
        setVertexBuffer: vi.fn(),
        drawIndexed: vi.fn(),
    } as unknown as GPURenderPassEncoder;
}

describe("addDepthHostedSpriteLayer", () => {
    it("rejects depth: 'none' layers before registering scene work", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "none" });
        expect(() => addDepthHostedSpriteLayer(scene, layer)).toThrow(/depth/);
        expect(scene._deferredBuilders.length).toBe(0);
    });

    it("registers a deferred builder for depth: 'test' (no eager GPU work)", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        const device = engine.device as unknown as { createBuffer: ReturnType<typeof vi.fn> };
        device.createBuffer.mockClear();
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test" });
        addDepthHostedSpriteLayer(scene, layer);
        expect(scene._deferredBuilders.length).toBe(1);
        // No buffers/pipelines created until registerScene runs the builder.
        expect(device.createBuffer).not.toHaveBeenCalled();
    });

    it("routes depth: 'test' into a transparent frame-graph renderable after registerScene", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        addDepthHostedSpriteLayer(scene, createSprite2DLayer(makeMockAtlas(), { depth: "test" }));
        await registerScene(engine, scene);
        expect(scene._renderables.length).toBe(1);
        expect(scene._renderables[0]!.isTransparent).toBe(true);
        expect(scene._renderables[0]!._transmissive).toBeFalsy();
        expect(scene._renderables[0]!._direct).toBe(false);
        expect(scene._renderables[0]!.order).toBe(200);
    });

    it("routes depth: 'test-write' into a direct-draw depth-writing renderable after registerScene", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        addDepthHostedSpriteLayer(scene, createSprite2DLayer(makeMockAtlas(), { depth: "test-write" }));
        await registerScene(engine, scene);
        expect(scene._renderables.length).toBe(1);
        expect(scene._renderables[0]!.isTransparent).toBe(false);
        expect(scene._renderables[0]!._transmissive).toBeFalsy();
        expect(scene._renderables[0]!._direct).toBe(true);
        expect(scene._renderables[0]!.order).toBe(100);
    });

    it("uses the render target depth-stencil format for depth-hosted sprite pipelines", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        addDepthHostedSpriteLayer(scene, createSprite2DLayer(makeMockAtlas(), { depth: "test-write" }));
        await registerScene(engine, scene);

        const device = engine.device as unknown as { createRenderPipeline: ReturnType<typeof vi.fn>; createShaderModule: ReturnType<typeof vi.fn> };
        const depthShaderDescriptor = device.createShaderModule.mock.calls
            .map((call) => call[0] as GPUShaderModuleDescriptor)
            .find((descriptor) => descriptor.code.includes("@location(6) iZ: f32"));
        expect(depthShaderDescriptor?.code).toContain("vec4<f32>(ndc, in.iZ, 1.0)");
        device.createRenderPipeline.mockClear();
        const renderable = scene._renderables[0]!;

        const first = renderable.bind(engine, { colorFormat: "bgra8unorm", depthStencilFormat: "depth32float", sampleCount: 1 });
        expect(device.createRenderPipeline).toHaveBeenCalledTimes(1);
        let descriptor = device.createRenderPipeline.mock.calls[0]![0] as GPURenderPipelineDescriptor;
        expect(descriptor.depthStencil?.format).toBe("depth32float");
        let vertexBuffer = (descriptor.vertex.buffers as GPUVertexBufferLayout[])[0]!;
        expect(vertexBuffer.arrayStride).toBe(DEPTH_INSTANCE_STRIDE_BYTES);
        expect(vertexBuffer.attributes.map((attr) => attr.shaderLocation)).toEqual([0, 1, 2, 3, 4, 5, 6]);

        const second = renderable.bind(engine, { colorFormat: "bgra8unorm", depthStencilFormat: "depth24plus-stencil8", sampleCount: 1 });
        expect(second.pipeline).not.toBe(first.pipeline);
        expect(device.createRenderPipeline).toHaveBeenCalledTimes(2);
        descriptor = device.createRenderPipeline.mock.calls[1]![0] as GPURenderPipelineDescriptor;
        expect(descriptor.depthStencil?.format).toBe("depth24plus-stencil8");
        vertexBuffer = (descriptor.vertex.buffers as GPUVertexBufferLayout[])[0]!;
        expect(vertexBuffer.arrayStride).toBe(DEPTH_INSTANCE_STRIDE_BYTES);
        expect(vertexBuffer.attributes.map((attr) => attr.shaderLocation)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it("allocates and uploads depth-hosted instances as 56 bytes per sprite", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test-write", capacity: 1 });
        addSprite2DIndex(layer, { positionPx: [10, 20], sizePx: [32, 32], z: 0.75 });
        addDepthHostedSpriteLayer(scene, layer);
        await registerScene(engine, scene);

        const device = engine.device as unknown as { createBuffer: ReturnType<typeof vi.fn>; queue: { writeBuffer: ReturnType<typeof vi.fn> } };
        const instanceBufferCreate = device.createBuffer.mock.calls.find((call) => (call[0] as GPUBufferDescriptor).label === "sprite-depth-hosted-instances");
        expect((instanceBufferCreate![0] as GPUBufferDescriptor).size).toBe(DEPTH_INSTANCE_STRIDE_BYTES);

        const binding = scene._renderables[0]!.bind(engine, { colorFormat: "bgra8unorm", depthStencilFormat: "depth24plus-stencil8", sampleCount: 1 });
        device.queue.writeBuffer.mockClear();
        binding.update?.({ targetWidth: 512, targetHeight: 256 });

        expect(device.queue.writeBuffer.mock.calls.some((call) => call[4] === DEPTH_INSTANCE_STRIDE_BYTES)).toBe(true);
    });

    it("uses the pass update context dimensions for the sprite layer UBO", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test-write" });
        addSprite2DIndex(layer, { positionPx: [10, 20], sizePx: [32, 32] });
        addDepthHostedSpriteLayer(scene, layer);
        await registerScene(engine, scene);

        const binding = scene._renderables[0]!.bind(engine, { colorFormat: "bgra8unorm", depthStencilFormat: "depth24plus-stencil8", sampleCount: 1 });
        const queue = (engine.device as unknown as { queue: { writeBuffer: ReturnType<typeof vi.fn> } }).queue;
        queue.writeBuffer.mockClear();
        binding.update?.({ targetWidth: 512, targetHeight: 256 });

        const uboCall = queue.writeBuffer.mock.calls.find((call) => call[4] === LAYER_UBO_BYTES);
        expect(uboCall).toBeDefined();
        const data = uboCall![2] as ArrayBuffer;
        const byteOffset = uboCall![3] as number;
        const ubo = new Float32Array(data, byteOffset, LAYER_UBO_BYTES / 4);
        expect(ubo[4]).toBe(512);
        expect(ubo[5]).toBe(256);
    });

    it("keeps bind groups compatible with each target-specific sprite pipeline", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test-write" });
        addSprite2DIndex(layer, { positionPx: [10, 20], sizePx: [32, 32] });
        addDepthHostedSpriteLayer(scene, layer);
        await registerScene(engine, scene);

        const device = engine.device as unknown as { createBindGroup: ReturnType<typeof vi.fn> };
        device.createBindGroup.mockClear();

        const renderable = scene._renderables[0]!;
        const first = renderable.bind(engine, { colorFormat: "bgra8unorm", depthStencilFormat: "depth32float", sampleCount: 1 });
        const second = renderable.bind(engine, { colorFormat: "rgba16float", depthStencilFormat: "depth32float", sampleCount: 1 });

        expect(second.pipeline).not.toBe(first.pipeline);
        expect(device.createBindGroup).toHaveBeenCalledTimes(2);

        const pass = makeDrawPassMock();
        device.createBindGroup.mockClear();

        first.draw(pass, engine);
        second.draw(pass, engine);

        expect(device.createBindGroup).not.toHaveBeenCalled();
    });

    it("disposeScene runs the depth-hosted sprite disposable", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        addDepthHostedSpriteLayer(scene, createSprite2DLayer(makeMockAtlas(), { depth: "test-write" }));
        await registerScene(engine, scene);
        const device = engine.device as unknown as { createBuffer: ReturnType<typeof vi.fn> };
        const buffersBefore = device.createBuffer.mock.results.length;
        // Each created buffer is a MockBuffer with a tracked `destroy` spy.
        const allDestroySpies = device.createBuffer.mock.results.map((r) => (r.value as MockBuffer).destroy);
        expect(allDestroySpies.length).toBe(buffersBefore);
        disposeScene(scene);
        // The renderable owns 3 buffers (instance + UBO + index) → at least 3 destroys fire.
        const destroyed = allDestroySpies.filter((spy) => spy.mock.calls.length > 0).length;
        expect(destroyed).toBeGreaterThanOrEqual(3);
    });
});
