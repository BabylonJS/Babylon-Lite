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
    clearBillboardSprites,
    createFacingBillboardSystem,
    createAxisLockedBillboardSystem,
    removeBillboardSpriteIndex,
    setBillboardShaderParams,
    setBillboardSpriteFrameIndex,
    updateBillboardSpriteIndex,
} from "../../../packages/babylon-lite/src/sprite/billboard-sprite";
import { addFacingBillboardSystem, addAxisLockedBillboardSystem } from "../../../packages/babylon-lite/src/sprite/billboard-scene";
import { billboardBlendAdditive, billboardBlendCutout, billboardBlendPremultiplied } from "../../../packages/babylon-lite/src/sprite/billboard-blend";
import { BILLBOARD_SYSTEM_UBO_BYTES, createBillboardPipelineCache, getOrCreateBillboardPipeline } from "../../../packages/babylon-lite/src/sprite/billboard-pipeline";
import { createBillboardCustomShader } from "../../../packages/babylon-lite/src/sprite/billboard-custom-shader";
import { SPRITE_FX_UBO_BYTES } from "../../../packages/babylon-lite/src/sprite/custom-shader-core";
import { createSceneContext, disposeScene } from "../../../packages/babylon-lite/src/scene/scene";
import { registerScene } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { SpriteAtlas } from "../../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

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
        maxDevicePixelRatio: Infinity,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
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
            { uvMin: [0.25, 0], uvMax: [0.5, 0.25], sourceSizePx: [64, 16], pivot: [0.25, 0.75] },
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

function makeIdentityViewMatrix(): Mat4 {
    const matrix = new Float32Array(16);
    matrix[0] = 1;
    matrix[5] = 1;
    matrix[10] = 1;
    matrix[15] = 1;
    return matrix as unknown as Mat4;
}

function makeIdentityCamera(worldMatrixVersion = 7): Camera {
    const worldMatrix = makeIdentityViewMatrix();
    return {
        fov: Math.PI / 4,
        nearPlane: 0.1,
        farPlane: 100,
        children: [],
        worldMatrix,
        worldMatrixVersion,
        _viewCache: new Float32Array(16),
        _projCache: new Float32Array(16),
        _vpCache: new Float32Array(16),
    } as Camera;
}

function findInstanceUploadFloats(writeBuffer: ReturnType<typeof vi.fn>, spriteCount: number): Float32Array {
    const byteLength = spriteCount * BILLBOARD_INSTANCE_STRIDE_BYTES;
    const call = writeBuffer.mock.calls.find((candidate) => candidate[4] === byteLength);
    expect(call).toBeTruthy();
    return new Float32Array(call![2] as ArrayBuffer, call![3] as number, byteLength / 4);
}

describe("FacingBillboardSpriteSystem index API", () => {
    it("uses a 64-byte instance layout with position, size, UVs, rotation, pivot, and float color", () => {
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 1 });
        const index = addBillboardSpriteIndex(system, {
            position: [1, 2, 3],
            sizeWorld: [1.5, 2.5],
            frame: 1,
            rotation: 0.25,
            color: [0.25, 0.5, 0.75, 0.5],
        });

        expect(index).toBe(0);
        expect(system._entityType).toBe("billboard-sprite-system");
        expect(system._orientation).toBe("facing");
        expect(system._depthMode).toBe("transparent");
        expect(system.alphaCutoff).toBe(0);
        expect(system._instanceFloatsPerSprite).toBe(BILLBOARD_INSTANCE_FLOATS_PER_SPRITE);
        expect(system._instanceStrideBytes).toBe(BILLBOARD_INSTANCE_STRIDE_BYTES);
        expect(system._instanceData.length).toBe(BILLBOARD_INSTANCE_FLOATS_PER_SPRITE);
        expect(Array.from(system._instanceData)).toEqual([1, 2, 3, 1.5, 2.5, 0.25, 0, 0.5, 0.25, 0.25, 0.25, 0.75, 0.25, 0.5, 0.75, 0.5]);
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

    it("setBillboardSpriteFrameIndex updates UVs while preserving size and current pivot", () => {
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 1 });
        addBillboardSpriteIndex(system, { position: [0, 0, 0], sizeWorld: [2, 3], pivot: [0.1, 0.2], frame: 0 });

        setBillboardSpriteFrameIndex(system, 0, 1);

        expect(Array.from(system._instanceData.slice(5, 9))).toEqual([0.25, 0, 0.5, 0.25]);
        expect(system._instanceData[3]).toBe(2);
        expect(system._instanceData[4]).toBe(3);
        expect(system._savedSize[0]).toBe(2);
        expect(system._savedSize[1]).toBe(3);
        expect(system._instanceData[10]).toBeCloseTo(0.1);
        expect(system._instanceData[11]).toBeCloseTo(0.2);

        updateBillboardSpriteIndex(system, 0, { frame: 0, pivot: [0.75, 0.25] });
        expect(Array.from(system._instanceData.slice(5, 9))).toEqual([0, 0, 0.25, 0.25]);
        expect(system._instanceData[10]).toBeCloseTo(0.75);
        expect(system._instanceData[11]).toBeCloseTo(0.25);
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

    it("preserves billboard flip state for narrow non-degenerate frames", () => {
        const atlas = makeMockAtlas();
        const narrowAtlas: SpriteAtlas = {
            ...atlas,
            textureSizePx: [256, 32],
            frames: [
                { uvMin: [0, 0], uvMax: [1 / 256, 1], sourceSizePx: [1, 32], pivot: [0.5, 0.5] },
                { uvMin: [1 / 256, 0], uvMax: [2 / 256, 1], sourceSizePx: [1, 32], pivot: [0.5, 0.5] },
            ],
        };
        const system = createFacingBillboardSystem(narrowAtlas, { capacity: 1 });
        addBillboardSpriteIndex(system, { position: [0, 0, 0], sizeWorld: [2, 3], frame: 0, flipX: true });

        setBillboardSpriteFrameIndex(system, 0, 1);

        expect(system._instanceData[5]).toBeGreaterThan(system._instanceData[7]!);
        expect(system._instanceData[5]).toBeCloseTo(2 / 256);
        expect(system._instanceData[7]).toBeCloseTo(1 / 256);
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

    it("clears sprites through the Index API and bumps the version", () => {
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 2 });
        addBillboardSpriteIndex(system, { position: [1, 0, 0], sizeWorld: [1, 1] });
        addBillboardSpriteIndex(system, { position: [2, 0, 0], sizeWorld: [4, 5] });
        const version = system._version;

        clearBillboardSprites(system);

        expect(system.count).toBe(0);
        expect(system._savedSize.slice(0, 4)).toEqual(new Float32Array([0, 0, 0, 0]));
        expect(system._dirtyMin).toBe(0);
        expect(system._dirtyMax).toBe(0);
        expect(system._version).toBe((version + 1) | 0);

        addBillboardSpriteIndex(system, { position: [3, 0, 0], sizeWorld: [6, 7] });
        expect(system.count).toBe(1);
        expect(system._instanceData[0]).toBe(3);
        expect(system._savedSize[0]).toBe(6);
        expect(system._savedSize[1]).toBe(7);
    });

    it("supports cutout as a depth-write billboard mode with cutoff defaults", () => {
        const cutout = createFacingBillboardSystem(makeMockAtlas(), { blendMode: billboardBlendCutout });
        expect(cutout.blendMode).toBe(billboardBlendCutout);
        expect(cutout._depthMode).toBe("cutout");
        expect(cutout.alphaCutoff).toBe(0.5);
        expect(cutout.order).toBe(100);

        const explicit = createAxisLockedBillboardSystem(makeMockAtlas(), [0, 1, 0], { blendMode: billboardBlendCutout, alphaCutoff: 0.35, order: 177 });
        expect(explicit._depthMode).toBe("cutout");
        expect(explicit.alphaCutoff).toBe(0.35);
        expect(explicit.order).toBe(177);
    });

    it("exposes additive blend mode with src-alpha/one factors on the transparent depth path", () => {
        expect(billboardBlendAdditive._key).toBe("additive");
        expect(billboardBlendAdditive._depthMode).toBe("transparent");
        expect(billboardBlendAdditive._descriptor).toEqual({
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
        });
        const additive = createFacingBillboardSystem(makeMockAtlas(), { blendMode: billboardBlendAdditive });
        expect(additive.blendMode).toBe(billboardBlendAdditive);
        expect(additive._depthMode).toBe("transparent");
    });

    it("rejects non-finite alpha cutoff values", () => {
        expect(() => createFacingBillboardSystem(makeMockAtlas(), { blendMode: billboardBlendCutout, alphaCutoff: NaN })).toThrow(/finite/);
        expect(() => createFacingBillboardSystem(makeMockAtlas(), { blendMode: billboardBlendCutout, alphaCutoff: Infinity })).toThrow(/finite/);
    });

    it("rejects non-finite opacity values", () => {
        expect(() => createFacingBillboardSystem(makeMockAtlas(), { opacity: NaN })).toThrow(/opacity.*finite/);
    });
});

describe("addFacingBillboardSystem", () => {
    it("registers a deferred builder without eager GPU work", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const device = engine._device as unknown as { createBuffer: ReturnType<typeof vi.fn> };
        device.createBuffer.mockClear();

        addFacingBillboardSystem(scene, createFacingBillboardSystem(makeMockAtlas()));

        expect(scene._deferredBuilders.length).toBe(1);
        expect(device.createBuffer).not.toHaveBeenCalled();
    });

    it("routes into a transparent depth-tested scene renderable after registerScene", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const system = createFacingBillboardSystem(makeMockAtlas(), { order: 230 });
        addFacingBillboardSystem(scene, system);

        await registerScene(engine, scene);

        expect(scene._renderables.length).toBe(1);
        expect(scene._renderables[0]!.isTransparent).toBe(true);
        expect(scene._renderables[0]!._transmissive).toBeFalsy();
        expect(scene._renderables[0]!._direct).toBe(false);
        expect(scene._renderables[0]!.order).toBe(230);
    });

    it("routes cutout billboards into the direct depth-write bucket", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const system = createFacingBillboardSystem(makeMockAtlas(), { blendMode: billboardBlendCutout, order: 120 });
        addFacingBillboardSystem(scene, system);

        await registerScene(engine, scene);

        expect(scene._renderables.length).toBe(1);
        expect(scene._renderables[0]!.isTransparent).toBe(false);
        expect(scene._renderables[0]!._transmissive).toBeFalsy();
        expect(scene._renderables[0]!._direct).toBe(true);
        expect(scene._renderables[0]!.order).toBe(120);
    });

    it("builds a scene-UBO billboard pipeline with depth test and no depth write", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 1, blendMode: billboardBlendPremultiplied });
        addBillboardSpriteIndex(system, { position: [1, 2, 3], sizeWorld: [2, 2], frame: 0 });
        addFacingBillboardSystem(scene, system);
        await registerScene(engine, scene);

        const device = engine._device as unknown as {
            createRenderPipeline: ReturnType<typeof vi.fn>;
            createShaderModule: ReturnType<typeof vi.fn>;
            queue: { writeBuffer: ReturnType<typeof vi.fn> };
        };
        device.createRenderPipeline.mockClear();
        const binding = scene._renderables[0]!.bind(engine, { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth32float", _sampleCount: 1 });

        expect(device.createRenderPipeline).toHaveBeenCalledTimes(1);
        const descriptor = device.createRenderPipeline.mock.calls[0]![0] as GPURenderPipelineDescriptor;
        expect(descriptor.depthStencil?.format).toBe("depth32float");
        expect(descriptor.depthStencil?.depthCompare).toBe("greater-equal");
        expect(descriptor.depthStencil?.depthWriteEnabled).toBe(false);
        expect(descriptor.label).toBe("facing-billboard-sprite-pipeline");
        const vertexBuffer = (descriptor.vertex.buffers as GPUVertexBufferLayout[])[0]!;
        expect(vertexBuffer.arrayStride).toBe(BILLBOARD_INSTANCE_STRIDE_BYTES);
        expect((vertexBuffer.attributes as GPUVertexAttribute[]).map((attribute) => attribute.shaderLocation)).toEqual([0, 1, 2, 3, 4, 5, 6]);

        const shaderDescriptor = device.createShaderModule.mock.calls.find((call) =>
            (call[0] as GPUShaderModuleDescriptor).code.includes("cameraRight")
        )![0] as GPUShaderModuleDescriptor;
        expect(shaderDescriptor.code).toContain("scene.viewProjection");
        expect(shaderDescriptor.code).toContain("getBillboardBasis");
        expect(shaderDescriptor.code).toContain("scene.view[0][0]");

        device.queue.writeBuffer.mockClear();
        binding.update?.({ targetWidth: 512, targetHeight: 256 });
        expect(device.queue.writeBuffer.mock.calls.some((call) => call[4] === BILLBOARD_INSTANCE_STRIDE_BYTES)).toBe(true);
        expect(device.queue.writeBuffer.mock.calls.some((call) => call[4] === BILLBOARD_SYSTEM_UBO_BYTES)).toBe(true);
    });

    it("builds a cutout billboard pipeline with alpha discard and depth write", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 1, blendMode: billboardBlendCutout, alphaCutoff: 0.42 });
        addBillboardSpriteIndex(system, { position: [1, 2, 3], sizeWorld: [2, 2], frame: 0 });
        addFacingBillboardSystem(scene, system);
        await registerScene(engine, scene);

        const device = engine._device as unknown as {
            createRenderPipeline: ReturnType<typeof vi.fn>;
            createShaderModule: ReturnType<typeof vi.fn>;
            queue: { writeBuffer: ReturnType<typeof vi.fn> };
        };
        device.createRenderPipeline.mockClear();
        const binding = scene._renderables[0]!.bind(engine, { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth32float", _sampleCount: 1 });

        expect(device.createRenderPipeline).toHaveBeenCalledTimes(1);
        const descriptor = device.createRenderPipeline.mock.calls[0]![0] as GPURenderPipelineDescriptor;
        expect(descriptor.depthStencil?.depthCompare).toBe("greater-equal");
        expect(descriptor.depthStencil?.depthWriteEnabled).toBe(true);
        const vertexBuffer = (descriptor.vertex.buffers as GPUVertexBufferLayout[])[0]!;
        expect(vertexBuffer.arrayStride).toBe(BILLBOARD_INSTANCE_STRIDE_BYTES);
        expect(vertexBuffer.attributes).toContainEqual({ shaderLocation: 6, offset: 48, format: "float32x4" });
        const target = (descriptor.fragment!.targets as GPUColorTargetState[])[0]!;
        expect(target.blend).toBeUndefined();

        const shaderDescriptor = device.createShaderModule.mock.calls.find((call) =>
            (call[0] as GPUShaderModuleDescriptor).code.includes("discard")
        )![0] as GPUShaderModuleDescriptor;
        expect(shaderDescriptor.code).toContain("sampleColor.a < billboards.axisAndCutoff.w");
        expect(shaderDescriptor.code).toContain("discard");

        device.queue.writeBuffer.mockClear();
        binding.update?.({ targetWidth: 512, targetHeight: 256 });
        const uboCall = device.queue.writeBuffer.mock.calls.find((call) => call[4] === BILLBOARD_SYSTEM_UBO_BYTES);
        expect(uboCall).toBeTruthy();
        const uboData = new Float32Array(uboCall![2] as ArrayBuffer, uboCall![3] as number, BILLBOARD_SYSTEM_UBO_BYTES / 4);
        expect(uboData[7]).toBeCloseTo(0.42);
    });

    it("uploads transparent billboards far-to-near without reordering logical instance data", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 3 });
        addBillboardSpriteIndex(system, { position: [0, 0, 1], sizeWorld: [1, 1], frame: 0 });
        addBillboardSpriteIndex(system, { position: [100, 0, 2], sizeWorld: [1, 1], frame: 0 });
        addBillboardSpriteIndex(system, { position: [101, 0, 10], sizeWorld: [1, 1], frame: 0 });
        addFacingBillboardSystem(scene, system);
        await registerScene(engine, scene);

        const device = engine._device as unknown as { queue: { writeBuffer: ReturnType<typeof vi.fn> } };
        const binding = scene._renderables[0]!.bind(engine, { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth32float", _sampleCount: 1 });
        device.queue.writeBuffer.mockClear();

        const camera = makeIdentityCamera();
        binding.update?.({ targetWidth: 512, targetHeight: 256, _camera: camera });

        const uploaded = findInstanceUploadFloats(device.queue.writeBuffer, 3);
        expect([uploaded[2], uploaded[BILLBOARD_INSTANCE_FLOATS_PER_SPRITE + 2], uploaded[BILLBOARD_INSTANCE_FLOATS_PER_SPRITE * 2 + 2]]).toEqual([10, 2, 1]);
        expect([
            system._instanceData[2],
            system._instanceData[BILLBOARD_INSTANCE_FLOATS_PER_SPRITE + 2],
            system._instanceData[BILLBOARD_INSTANCE_FLOATS_PER_SPRITE * 2 + 2],
        ]).toEqual([1, 2, 10]);
        expect(scene._renderables[0]!._worldCenter).toEqual([50.5, 0, 5.5]);

        device.queue.writeBuffer.mockClear();
        binding.update?.({ targetWidth: 512, targetHeight: 256, _camera: camera });
        expect(device.queue.writeBuffer.mock.calls.some((call) => call[4] === 3 * BILLBOARD_INSTANCE_STRIDE_BYTES)).toBe(false);

        updateBillboardSpriteIndex(system, 0, { position: [200, 0, 4] });
        binding.update?.({ targetWidth: 512, targetHeight: 256, _camera: camera });
        expect(scene._renderables[0]!._worldCenter).toEqual([150, 0, 6]);
    });

    it("ignores hidden billboards when refreshing world center and skips all-hidden draws", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 2 });
        const visibleIndex = addBillboardSpriteIndex(system, { position: [1, 2, 3], sizeWorld: [1, 1], frame: 0 });
        addBillboardSpriteIndex(system, { position: [1000, 0, 1000], sizeWorld: [1, 1], frame: 0, visible: false });
        addFacingBillboardSystem(scene, system);
        await registerScene(engine, scene);

        const binding = scene._renderables[0]!.bind(engine, { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth32float", _sampleCount: 1 });
        const camera = makeIdentityCamera();
        binding.update?.({ targetWidth: 512, targetHeight: 256, _camera: camera });
        expect(scene._renderables[0]!._worldCenter).toEqual([1, 2, 3]);

        const visiblePass = makeDrawPassMock();
        expect(binding.draw(visiblePass, engine)).toBe(1);
        expect(visiblePass.drawIndexed).toHaveBeenCalledWith(6, 2, 0, 0, 0);

        updateBillboardSpriteIndex(system, visibleIndex, { visible: false });
        binding.update?.({ targetWidth: 512, targetHeight: 256, _camera: camera });
        expect(scene._renderables[0]!._worldCenter).toEqual([0, 0, 0]);

        const hiddenPass = makeDrawPassMock();
        expect(binding.draw(hiddenPass, engine)).toBe(0);
        expect(hiddenPass.drawIndexed).not.toHaveBeenCalled();
    });

    it("uploads transparent billboards in logical order when no camera is supplied", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 3 });
        addBillboardSpriteIndex(system, { position: [10, 0, 1], sizeWorld: [1, 1], frame: 0 });
        addBillboardSpriteIndex(system, { position: [20, 0, 2], sizeWorld: [1, 1], frame: 0 });
        addBillboardSpriteIndex(system, { position: [30, 0, 3], sizeWorld: [1, 1], frame: 0 });
        addFacingBillboardSystem(scene, system);
        await registerScene(engine, scene);

        const device = engine._device as unknown as { queue: { writeBuffer: ReturnType<typeof vi.fn> } };
        const binding = scene._renderables[0]!.bind(engine, { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth32float", _sampleCount: 1 });
        device.queue.writeBuffer.mockClear();

        binding.update?.({ targetWidth: 512, targetHeight: 256 });

        const uploaded = findInstanceUploadFloats(device.queue.writeBuffer, 3);
        expect([uploaded[2], uploaded[BILLBOARD_INSTANCE_FLOATS_PER_SPRITE + 2], uploaded[BILLBOARD_INSTANCE_FLOATS_PER_SPRITE * 2 + 2]]).toEqual([1, 2, 3]);
    });

    it("uploads cutout billboards in logical order without transparent sorting", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 3, blendMode: billboardBlendCutout });
        addBillboardSpriteIndex(system, { position: [10, 0, 1], sizeWorld: [1, 1], frame: 0 });
        addBillboardSpriteIndex(system, { position: [20, 0, 2], sizeWorld: [1, 1], frame: 0 });
        addBillboardSpriteIndex(system, { position: [30, 0, 3], sizeWorld: [1, 1], frame: 0 });
        addFacingBillboardSystem(scene, system);
        await registerScene(engine, scene);

        const device = engine._device as unknown as { queue: { writeBuffer: ReturnType<typeof vi.fn> } };
        const binding = scene._renderables[0]!.bind(engine, { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth32float", _sampleCount: 1 });
        device.queue.writeBuffer.mockClear();

        const camera = makeIdentityCamera();
        binding.update?.({ targetWidth: 512, targetHeight: 256, _camera: camera });

        const uploaded = findInstanceUploadFloats(device.queue.writeBuffer, 3);
        expect([uploaded[2], uploaded[BILLBOARD_INSTANCE_FLOATS_PER_SPRITE + 2], uploaded[BILLBOARD_INSTANCE_FLOATS_PER_SPRITE * 2 + 2]]).toEqual([1, 2, 3]);
    });

    it("draws with the billboard bind group at group 1 and disposes GPU buffers with the scene", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const system = createFacingBillboardSystem(makeMockAtlas(), { capacity: 1 });
        addBillboardSpriteIndex(system, { position: [0, 0, 0], sizeWorld: [1, 1] });
        addFacingBillboardSystem(scene, system);
        await registerScene(engine, scene);

        const binding = scene._renderables[0]!.bind(engine, { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth24plus-stencil8", _sampleCount: 1 });
        const pass = makeDrawPassMock();
        expect(binding.draw(pass, engine)).toBe(1);
        expect(pass.setBindGroup).toHaveBeenCalledWith(1, expect.anything());
        expect(pass.drawIndexed).toHaveBeenCalledWith(6, 1, 0, 0, 0);

        const device = engine._device as unknown as { createBuffer: ReturnType<typeof vi.fn> };
        const destroySpies = device.createBuffer.mock.results.map((result) => (result.value as MockBuffer).destroy);
        disposeScene(scene);
        expect(destroySpies.filter((destroy) => destroy.mock.calls.length > 0).length).toBeGreaterThanOrEqual(3);
    });
});

describe("AxisLockedBillboardSpriteSystem", () => {
    it("creates an axis-locked billboard system with normalized axis", () => {
        const system = createAxisLockedBillboardSystem(makeMockAtlas(), [0, 3, 0], { capacity: 1 });
        expect(system._entityType).toBe("billboard-sprite-system");
        expect(system._orientation).toBe("axis-locked");
        expect(system._depthMode).toBe("transparent");
        expect(system._axis).toEqual([0, 1, 0]);
    });

    it("normalizes arbitrary axis vectors", () => {
        const system = createAxisLockedBillboardSystem(makeMockAtlas(), [3, 4, 0], { capacity: 1 });
        expect(system._axis[0]).toBeCloseTo(0.6);
        expect(system._axis[1]).toBeCloseTo(0.8);
        expect(system._axis[2]).toBeCloseTo(0);
    });

    it("rejects non-finite axis components", () => {
        expect(() => createAxisLockedBillboardSystem(makeMockAtlas(), [NaN, 1, 0])).toThrow(/finite/);
        expect(() => createAxisLockedBillboardSystem(makeMockAtlas(), [1, Infinity, 0])).toThrow(/finite/);
    });

    it("rejects zero-length axis vectors", () => {
        expect(() => createAxisLockedBillboardSystem(makeMockAtlas(), [0, 0, 0])).toThrow(/non-zero/);
        expect(() => createAxisLockedBillboardSystem(makeMockAtlas(), [1e-10, 0, 0])).toThrow(/non-zero/);
    });

    it("adds to scene and builds a renderable with axis-locked pipeline", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const system = createAxisLockedBillboardSystem(makeMockAtlas(), [0, 1, 0], { capacity: 1 });
        addBillboardSpriteIndex(system, { position: [1, 2, 3], sizeWorld: [2, 2], frame: 0 });
        addAxisLockedBillboardSystem(scene, system);
        await registerScene(engine, scene);

        expect(scene._renderables.length).toBe(1);
        expect(scene._renderables[0]!.isTransparent).toBe(true);
    });

    it("generates axis-locked shader with billboards.axisAndCutoff and projectedRight", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const system = createAxisLockedBillboardSystem(makeMockAtlas(), [0, 1, 0], { capacity: 1 });
        addBillboardSpriteIndex(system, { position: [1, 2, 3], sizeWorld: [2, 2], frame: 0 });
        addAxisLockedBillboardSystem(scene, system);
        await registerScene(engine, scene);

        const device = engine._device as unknown as {
            createRenderPipeline: ReturnType<typeof vi.fn>;
            createShaderModule: ReturnType<typeof vi.fn>;
        };
        device.createRenderPipeline.mockClear();
        scene._renderables[0]!.bind(engine, { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth32float", _sampleCount: 1 });

        expect(device.createRenderPipeline).toHaveBeenCalledTimes(1);
        const descriptor = device.createRenderPipeline.mock.calls[0]![0] as GPURenderPipelineDescriptor;
        expect(descriptor.label).toBe("axis-locked-billboard-sprite-pipeline");

        const shaderDescriptor = device.createShaderModule.mock.calls.find((call) =>
            (call[0] as GPUShaderModuleDescriptor).code.includes("billboards.axisAndCutoff")
        )![0] as GPUShaderModuleDescriptor;
        expect(shaderDescriptor.code).toContain("billboards.axisAndCutoff");
        expect(shaderDescriptor.code).toContain("projectedRight");
        expect(shaderDescriptor.code).toContain("lockAxis");
        expect(shaderDescriptor.code).toContain("getBillboardBasis");
    });

    it("writes axis data to UBO after opacity", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const system = createAxisLockedBillboardSystem(makeMockAtlas(), [0.35, 1, 0.2], { capacity: 1, opacity: 0.75 });
        addBillboardSpriteIndex(system, { position: [1, 2, 3], sizeWorld: [2, 2], frame: 0 });
        addAxisLockedBillboardSystem(scene, system);
        await registerScene(engine, scene);

        const device = engine._device as unknown as { queue: { writeBuffer: ReturnType<typeof vi.fn> } };
        const binding = scene._renderables[0]!.bind(engine, { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth32float", _sampleCount: 1 });
        device.queue.writeBuffer.mockClear();

        binding.update?.({ targetWidth: 512, targetHeight: 256 });

        const uboCall = device.queue.writeBuffer.mock.calls.find((call) => call[4] === BILLBOARD_SYSTEM_UBO_BYTES);
        expect(uboCall).toBeTruthy();
        const uboData = new Float32Array(uboCall![2] as ArrayBuffer, uboCall![3] as number, BILLBOARD_SYSTEM_UBO_BYTES / 4);
        expect(uboData[0]).toBeCloseTo(1);
        expect(uboData[1]).toBeCloseTo(1);
        expect(uboData[2]).toBeCloseTo(1);
        expect(uboData[3]).toBeCloseTo(0.75);
        const axisLen = Math.sqrt(0.35 * 0.35 + 1 * 1 + 0.2 * 0.2);
        expect(uboData[4]).toBeCloseTo(0.35 / axisLen);
        expect(uboData[5]).toBeCloseTo(1 / axisLen);
        expect(uboData[6]).toBeCloseTo(0.2 / axisLen);
        expect(uboData[7]).toBe(0);
    });
});

describe("Billboard custom shader", () => {
    const FX_FRAGMENT = `let base = textureSample(atlasTex, atlasSamp, in.uv) * in.tint * billboards.opacityMul;
return vec4<f32>(base.rgb * (0.5 + 0.5 * sin(fx.time + fx.params.x)), base.a);`;

    const makeTex = () => ({ view: {}, sampler: {} }) as unknown as Texture2D;

    it("createBillboardCustomShader returns a descriptor and rejects empty source", () => {
        const cs = createBillboardCustomShader({ fragment: FX_FRAGMENT });
        expect(cs._entityType).toBe("billboard-custom-shader");
        expect(typeof cs._key).toBe("string");
        expect(() => createBillboardCustomShader({ fragment: "   " })).toThrow();
    });

    it("assigns distinct keys to distinct shaders and rejects invalid extra-texture names", () => {
        const a = createBillboardCustomShader({ fragment: FX_FRAGMENT });
        const b = createBillboardCustomShader({ fragment: FX_FRAGMENT });
        expect(a._key).not.toBe(b._key);
        expect(() => createBillboardCustomShader({ fragment: FX_FRAGMENT, extraTextures: [{ name: "1bad", texture: makeTex() }] })).toThrow();
    });

    it("composes WGSL that wraps the user fragment body with the SpriteFx UBO, vWorldPos varying, and fs entry point", () => {
        const cs = createBillboardCustomShader({ fragment: FX_FRAGMENT });

        const facing = cs._composeWgsl("facing", "transparent");
        expect(facing).toContain("@group(1) @binding(3) var<uniform> fx: SpriteFx");
        expect(facing).toContain("fn fs(in: VOut) -> @location(0) vec4<f32>");
        expect(facing).toContain(FX_FRAGMENT);
        expect(facing).toContain("@location(3) vWorldPos: vec3<f32>");
        expect(facing).toContain("out.vWorldPos = worldPos;");
        expect(facing).toContain("getBillboardBasis");
        expect(facing).toContain("cameraRight");

        // Axis-locked uses a different basis but the same fragment contract.
        const axisLocked = cs._composeWgsl("axis-locked", "transparent");
        expect(axisLocked).toContain("projectedRight");
        expect(axisLocked).toContain("lockAxis");
        expect(axisLocked).toContain("@location(3) vWorldPos: vec3<f32>");
    });

    it("places the fx UBO after extra textures and binds them at group 1", () => {
        const cs = createBillboardCustomShader({
            fragment: FX_FRAGMENT,
            extraTextures: [
                { name: "palette", texture: makeTex() },
                { name: "noise", texture: makeTex() },
            ],
        });
        const wgsl = cs._composeWgsl("facing", "transparent");
        expect(wgsl).toContain("@group(1) @binding(3) var paletteTex: texture_2d<f32>");
        expect(wgsl).toContain("@group(1) @binding(4) var paletteSamp: sampler");
        expect(wgsl).toContain("@group(1) @binding(5) var noiseTex: texture_2d<f32>");
        expect(wgsl).toContain("@group(1) @binding(6) var noiseSamp: sampler");
        expect(wgsl).toContain("@group(1) @binding(7) var<uniform> fx: SpriteFx");
    });

    it("getOrCreateBillboardPipeline builds a distinct pipeline + module for a custom shader and caches it", () => {
        const engine = makeMockEngine();
        const cache = createBillboardPipelineCache();
        const sceneBGL = {} as GPUBindGroupLayout;
        const device = engine._device as unknown as { createShaderModule: ReturnType<typeof vi.fn> };

        const plain = getOrCreateBillboardPipeline(engine, cache, engine.format, 1, createFacingBillboardSystem(makeMockAtlas()), "depth32float", sceneBGL);
        const modulesAfterPlain = device.createShaderModule.mock.calls.length;

        const cs = createBillboardCustomShader({ fragment: FX_FRAGMENT });
        const customSystem = createFacingBillboardSystem(makeMockAtlas(), { customShader: cs });
        const custom = getOrCreateBillboardPipeline(engine, cache, engine.format, 1, customSystem, "depth32float", sceneBGL);

        expect(custom).not.toBe(plain);
        expect(device.createShaderModule.mock.calls.length).toBeGreaterThan(modulesAfterPlain);

        // Re-requesting the same custom shader hits the cache (no new pipeline).
        const again = getOrCreateBillboardPipeline(engine, cache, engine.format, 1, customSystem, "depth32float", sceneBGL);
        expect(again).toBe(custom);
    });

    it("buildBillboardPipeline appends the FX UBO binding to the bind-group layout for a custom shader", () => {
        const engine = makeMockEngine();
        const cache = createBillboardPipelineCache();
        const sceneBGL = {} as GPUBindGroupLayout;
        const device = engine._device as unknown as { createBindGroupLayout: ReturnType<typeof vi.fn> };

        const cs = createBillboardCustomShader({ fragment: FX_FRAGMENT, extraTextures: [{ name: "palette", texture: makeTex() }] });
        const system = createFacingBillboardSystem(makeMockAtlas(), { customShader: cs });
        getOrCreateBillboardPipeline(engine, cache, engine.format, 1, system, "depth32float", sceneBGL);

        const layoutCall = device.createBindGroupLayout.mock.calls.at(-1)![0] as GPUBindGroupLayoutDescriptor;
        const bindings = (layoutCall.entries as GPUBindGroupLayoutEntry[]).map((entry) => entry.binding);
        // atlas UBO 0, atlasTex 1, atlasSamp 2, paletteTex 3, paletteSamp 4, fx UBO 5.
        expect(bindings).toEqual([0, 1, 2, 3, 4, 5]);
        const fxEntry = (layoutCall.entries as GPUBindGroupLayoutEntry[]).find((entry) => entry.binding === 5)!;
        expect(fxEntry.buffer?.type).toBe("uniform");
    });

    it("createFacingBillboardSystem stores the custom shader and setBillboardShaderParams mutates the params vec4", () => {
        const cs = createBillboardCustomShader({ fragment: FX_FRAGMENT });
        const system = createFacingBillboardSystem(makeMockAtlas(), { customShader: cs });
        expect(system._customShader).toBe(cs);
        expect(system.shaderParams).toEqual([0, 0, 0, 0]);

        setBillboardShaderParams(system, [1, 2, 3, 4]);
        expect(system.shaderParams).toEqual([1, 2, 3, 4]);

        // The shared FX UBO byte size is the same 32-byte contract as the 2D sprite path.
        expect(SPRITE_FX_UBO_BYTES).toBe(32);
    });
});
