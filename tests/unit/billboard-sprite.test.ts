import { describe, it, expect, vi } from "vitest";

const G = globalThis as unknown as Record<string, unknown>;
G.GPUBufferUsage ??= { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8, MAP_WRITE: 1 };
G.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
G.GPUColorWrite ??= { ALL: 0xf };
G.GPUTextureUsage ??= { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };

import {
    BILLBOARD_INSTANCE_FLOATS_PER_SPRITE,
    BILLBOARD_INSTANCE_STRIDE_BYTES,
    addBillboardSpriteIndex,
    createFacingBillboardSystem,
    removeBillboardSpriteIndex,
    setBillboardSpriteFrameIndex,
    updateBillboardSpriteIndex,
} from "../../packages/babylon-lite/src/sprite/billboard-sprite";
import { addFacingBillboardSystem } from "../../packages/babylon-lite/src/sprite/billboard-scene";
import { BILLBOARD_SYSTEM_UBO_BYTES } from "../../packages/babylon-lite/src/sprite/billboard-pipeline";
import { createSceneContext, disposeScene } from "../../packages/babylon-lite/src/scene/scene";
import { registerScene } from "../../packages/babylon-lite/src/scene/scene-core";
import type { SceneContextInternal } from "../../packages/babylon-lite/src/scene/scene-core";
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
        createTexture: vi.fn(() => ({ createView: vi.fn(() => ({ _kind: "view" })), destroy: vi.fn() })),
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
        frames: [
            { uvMin: [0, 0], uvMax: [0.25, 0.25], sourceSizePx: [32, 32], pivot: [0.5, 0.5] },
            { uvMin: [0.25, 0], uvMax: [0.5, 0.25], sourceSizePx: [32, 32], pivot: [0.25, 0.75] },
        ],
        premultipliedAlpha: false,
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

describe("FacingBillboardSpriteSystem index API", () => {
    it("uses a 52-byte instance layout with position, size, UVs, rotation, pivot, and packed color", () => {
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 1 });
        const index = addBillboardSpriteIndex(system, {
            position: [1, 2, 3],
            sizeWorld: [1.5, 2.5],
            frame: 1,
            rotation: 0.25,
            color: [0.25, 0.5, 0.75, 0.5],
        });

        expect(index).toBe(0);
        expect(system._instanceFloatsPerSprite).toBe(BILLBOARD_INSTANCE_FLOATS_PER_SPRITE);
        expect(system._instanceStrideBytes).toBe(BILLBOARD_INSTANCE_STRIDE_BYTES);
        expect(system._instanceData.length).toBe(BILLBOARD_INSTANCE_FLOATS_PER_SPRITE);
        expect(Array.from(system._instanceData.slice(0, 12))).toEqual([1, 2, 3, 1.5, 2.5, 0.25, 0, 0.5, 0.25, 0.25, 0.25, 0.75]);
        expect(system._instanceDataU32[12]).toBe(0x80bf8040);
    });

    it("hides by zeroing GPU size and restores the true size on visible update", () => {
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 1 });
        addBillboardSpriteIndex(system, { position: [0, 0, 0], sizeWorld: [2, 3] });

        updateBillboardSpriteIndex(system, 0, { visible: false });
        expect(system._instanceData[3]).toBe(0);
        expect(system._instanceData[4]).toBe(0);
        expect(system._savedSize[0]).toBe(2);
        expect(system._savedSize[1]).toBe(3);

        updateBillboardSpriteIndex(system, 0, { visible: true });
        expect(system._instanceData[3]).toBe(2);
        expect(system._instanceData[4]).toBe(3);
    });

    it("updates frame UVs without changing size or pivot", () => {
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 1 });
        addBillboardSpriteIndex(system, { position: [0, 0, 0], sizeWorld: [2, 3], pivot: [0.1, 0.2], frame: 0 });

        setBillboardSpriteFrameIndex(system, 0, 1);

        expect(Array.from(system._instanceData.slice(5, 9))).toEqual([0.25, 0, 0.5, 0.25]);
        expect(system._instanceData[3]).toBe(2);
        expect(system._instanceData[4]).toBe(3);
        expect(system._instanceData[10]).toBeCloseTo(0.1);
        expect(system._instanceData[11]).toBeCloseTo(0.2);
    });

    it("preserves and clears flip state across frame updates", () => {
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 1 });
        addBillboardSpriteIndex(system, { position: [0, 0, 0], sizeWorld: [2, 3], frame: 0, flipX: true, flipY: true });

        setBillboardSpriteFrameIndex(system, 0, 1);
        expect(Array.from(system._instanceData.slice(5, 9))).toEqual([0.5, 0.25, 0.25, 0]);

        updateBillboardSpriteIndex(system, 0, { frame: 0, flipX: false });
        expect(Array.from(system._instanceData.slice(5, 9))).toEqual([0, 0.25, 0.25, 0]);

        updateBillboardSpriteIndex(system, 0, { flipY: false });
        expect(Array.from(system._instanceData.slice(5, 9))).toEqual([0, 0, 0.25, 0.25]);
    });

    it("swap-removes sprites and carries saved size with the moved instance", () => {
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 1 });
        addBillboardSpriteIndex(system, { position: [1, 0, 0], sizeWorld: [1, 1] });
        addBillboardSpriteIndex(system, { position: [2, 0, 0], sizeWorld: [4, 5] });

        removeBillboardSpriteIndex(system, 0);

        expect(system.count).toBe(1);
        expect(system._capacity).toBe(2);
        expect(system._instanceData[0]).toBe(2);
        expect(system._savedSize[0]).toBe(4);
        expect(system._savedSize[1]).toBe(5);
    });

    it("rejects unsupported blend modes in the first slice", () => {
        expect(() => createFacingBillboardSystem(makeMockAtlas(), { blendMode: "additive" })).toThrow(/later PR/);
        expect(() => createFacingBillboardSystem(makeMockAtlas(), { blendMode: "multiply" })).toThrow(/later PR/);
        expect(() => createFacingBillboardSystem(makeMockAtlas(), { blendMode: "cutout" })).toThrow(/later PR/);
    });
});

describe("addFacingBillboardSystem", () => {
    it("registers a deferred builder without eager GPU work", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        const device = engine.device as unknown as { createBuffer: ReturnType<typeof vi.fn> };
        device.createBuffer.mockClear();

        addFacingBillboardSystem(scene, createFacingBillboardSystem(makeMockAtlas()));

        expect(scene._deferredBuilders.length).toBe(1);
        expect(device.createBuffer).not.toHaveBeenCalled();
    });

    it("routes into a transparent depth-tested scene renderable after registerScene", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        const system = createFacingBillboardSystem(makeMockAtlas(), { order: 230 });
        addFacingBillboardSystem(scene, system);

        await registerScene(engine, scene);

        expect(scene._renderables.length).toBe(1);
        expect(scene._renderables[0]!.isTransparent).toBe(true);
        expect(scene._renderables[0]!.isTransmissive).toBe(false);
        expect(scene._renderables[0]!.order).toBe(230);
    });

    it("builds a scene-UBO billboard pipeline with depth test and no depth write", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 1, blendMode: "premultiplied" });
        addBillboardSpriteIndex(system, { position: [1, 2, 3], sizeWorld: [2, 2], frame: 0 });
        addFacingBillboardSystem(scene, system);
        await registerScene(engine, scene);

        const device = engine.device as unknown as {
            createRenderPipeline: ReturnType<typeof vi.fn>;
            createShaderModule: ReturnType<typeof vi.fn>;
            queue: { writeBuffer: ReturnType<typeof vi.fn> };
        };
        device.createRenderPipeline.mockClear();
        const binding = scene._renderables[0]!.bind(engine, { colorFormat: "bgra8unorm", depthStencilFormat: "depth32float", sampleCount: 1 });

        expect(device.createRenderPipeline).toHaveBeenCalledTimes(1);
        const descriptor = device.createRenderPipeline.mock.calls[0]![0] as GPURenderPipelineDescriptor;
        expect(descriptor.depthStencil?.format).toBe("depth32float");
        expect(descriptor.depthStencil?.depthCompare).toBe("less-equal");
        expect(descriptor.depthStencil?.depthWriteEnabled).toBe(false);
        const vertexBuffer = (descriptor.vertex.buffers as GPUVertexBufferLayout[])[0]!;
        expect(vertexBuffer.arrayStride).toBe(BILLBOARD_INSTANCE_STRIDE_BYTES);
        expect(vertexBuffer.attributes.map((attribute) => attribute.shaderLocation)).toEqual([0, 1, 2, 3, 4, 5, 6]);

        const shaderDescriptor = device.createShaderModule.mock.calls.find((call) =>
            (call[0] as GPUShaderModuleDescriptor).code.includes("cameraRight")
        )![0] as GPUShaderModuleDescriptor;
        expect(shaderDescriptor.code).toContain("scene.viewProjection");
        expect(shaderDescriptor.code).toContain("scene.view[0][0]");

        device.queue.writeBuffer.mockClear();
        binding.update?.({ targetWidth: 512, targetHeight: 256 });
        expect(device.queue.writeBuffer.mock.calls.some((call) => call[4] === BILLBOARD_INSTANCE_STRIDE_BYTES)).toBe(true);
        expect(device.queue.writeBuffer.mock.calls.some((call) => call[4] === BILLBOARD_SYSTEM_UBO_BYTES)).toBe(true);
    });

    it("draws with the billboard bind group at group 1 and disposes GPU buffers with the scene", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 1 });
        addBillboardSpriteIndex(system, { position: [0, 0, 0], sizeWorld: [1, 1] });
        addFacingBillboardSystem(scene, system);
        await registerScene(engine, scene);

        const binding = scene._renderables[0]!.bind(engine, { colorFormat: "bgra8unorm", depthStencilFormat: "depth24plus-stencil8", sampleCount: 1 });
        const pass = makeDrawPassMock();
        expect(binding.draw(pass, engine)).toBe(1);
        expect(pass.setBindGroup).toHaveBeenCalledWith(1, expect.anything());
        expect(pass.drawIndexed).toHaveBeenCalledWith(6, 1, 0, 0, 0);

        const device = engine.device as unknown as { createBuffer: ReturnType<typeof vi.fn> };
        const destroySpies = device.createBuffer.mock.results.map((result) => (result.value as MockBuffer).destroy);
        disposeScene(scene);
        expect(destroySpies.filter((destroy) => destroy.mock.calls.length > 0).length).toBeGreaterThanOrEqual(3);
    });
});
