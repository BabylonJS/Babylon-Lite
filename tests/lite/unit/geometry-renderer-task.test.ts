import { describe, expect, it } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createGeometryRendererTask } from "../../../packages/babylon-lite/src/frame-graph/geometry-renderer-task";
import { GeometryTextureType } from "../../../packages/babylon-lite/src/frame-graph/geometry-types";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage" | "GPUShaderStage" | "GPUTextureUsage"> & {
    GPUBufferUsage?: { UNIFORM: number; COPY_DST: number; STORAGE: number };
    GPUShaderStage?: { VERTEX: number; FRAGMENT: number };
    GPUTextureUsage?: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number; COPY_DST: number };
};

gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8, STORAGE: 0x80 } as unknown as GPUBufferUsage;
gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 } as unknown as GPUShaderStage;
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4, COPY_SRC: 0x1, COPY_DST: 0x2 } as unknown as GPUTextureUsage;

function makeMockEngine(): EngineContext {
    const device = {
        createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => d as unknown as GPUBindGroupLayout,
        createBindGroup: (d: GPUBindGroupDescriptor) => d as unknown as GPUBindGroup,
        createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => d as unknown as GPUPipelineLayout,
        createRenderPipeline: (d: GPURenderPipelineDescriptor) => d as unknown as GPURenderPipeline,
        createShaderModule: (d: GPUShaderModuleDescriptor) => d as unknown as GPUShaderModule,
        createSampler: (d: GPUSamplerDescriptor) => d as unknown as GPUSampler,
        createBuffer: (d: GPUBufferDescriptor) => ({ descriptor: d, destroy: () => undefined }) as unknown as GPUBuffer,
        createTexture: (d: GPUTextureDescriptor) =>
            ({
                descriptor: d,
                format: d.format,
                sampleCount: d.sampleCount ?? 1,
                mipLevelCount: d.mipLevelCount ?? 1,
                createView: () => ({}) as GPUTextureView,
                destroy: () => undefined,
            }) as unknown as GPUTexture,
        queue: { writeBuffer: () => undefined },
    } as unknown as GPUDevice;
    return {
        canvas: { width: 800, height: 600 } as HTMLCanvasElement,
        msaaSamples: 1,
        drawCallCount: 0,
        maxDevicePixelRatio: Infinity,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        _device: device,
        _context: { configure: () => undefined } as unknown as GPUCanvasContext,
        format: "bgra8unorm",
        _alphaMode: "opaque",
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
        _currentEncoder: {} as unknown as GPUCommandEncoder,
        scRT: {
            _colorView: { id: "swap" },
            _colorTexture: {},
            _depthTexture: null,
            _depthView: null,
            _descriptor: { format: "bgra8unorm", samples: 1, size: "canvas" },
            _width: 0,
            _height: 0,
            _eager: true,
        } as unknown as import("../../../packages/babylon-lite/src/engine/render-target").RenderTarget,
        _currentDelta: 0,
        _cbs: [],
    };
}

describe("GeometryRendererTask", () => {
    it("throws when textureDescriptions is empty", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        expect(() => createGeometryRendererTask({ textureDescriptions: [] }, engine, scene)).toThrow(/at least one/);
    });

    it("throws when textureDescriptions exceeds 8 attachments", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const tooMany = Array.from({ length: 9 }, () => ({ type: GeometryTextureType.VIEW_NORMAL }));
        expect(() => createGeometryRendererTask({ textureDescriptions: tooMany }, engine, scene)).toThrow(/exceeds the WebGPU max of 8/);
    });

    it("exposes per-type accessors only for requested types", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const task = createGeometryRendererTask(
            {
                textureDescriptions: [
                    { type: GeometryTextureType.VIEW_DEPTH },
                    { type: GeometryTextureType.VIEW_NORMAL },
                    { type: GeometryTextureType.REFLECTIVITY },
                    { type: GeometryTextureType.LINEAR_VELOCITY },
                ],
            },
            engine,
            scene
        );

        expect(task.geometryViewDepthTexture).not.toBeNull();
        expect(task.geometryViewNormalTexture).not.toBeNull();
        expect(task.geometryReflectivityTexture).not.toBeNull();
        expect(task.geometryLinearVelocityTexture).not.toBeNull();

        expect(task.geometryWorldNormalTexture).toBeNull();
        expect(task.geometryWorldPositionTexture).toBeNull();
        expect(task.geometryLocalPositionTexture).toBeNull();
        expect(task.geometryAlbedoTexture).toBeNull();
        expect(task.geometryIrradianceTexture).toBeNull();
        expect(task.geometryNormalizedViewDepthTexture).toBeNull();
        expect(task.geometryScreenspaceDepthTexture).toBeNull();
    });

    it("outputTarget MRT colorFormats matches textureDescriptions order and length", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const task = createGeometryRendererTask(
            {
                textureDescriptions: [
                    { type: GeometryTextureType.VIEW_DEPTH },
                    { type: GeometryTextureType.VIEW_NORMAL },
                    { type: GeometryTextureType.REFLECTIVITY },
                    // Format override:
                    { type: GeometryTextureType.WORLD_POSITION, format: "rgba32float" },
                ],
            },
            engine,
            scene
        ) as unknown as { _mrt: { _descriptor: { colorFormats: GPUTextureFormat[] } } };
        const formats = task._mrt._descriptor.colorFormats;
        expect(formats).toHaveLength(4);
        expect(formats[0]).toBe("r32float"); // VIEW_DEPTH default
        expect(formats[1]).toBe("rgba16float"); // VIEW_NORMAL default
        expect(formats[2]).toBe("rgba8unorm"); // REFLECTIVITY default
        expect(formats[3]).toBe("rgba32float"); // override
    });

    it("wrapper RT exposes single-attachment format matching the underlying MRT slot", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const task = createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.VIEW_DEPTH }, { type: GeometryTextureType.VIEW_NORMAL }] }, engine, scene);
        const wrapper = task.geometryViewNormalTexture!;
        expect(wrapper._descriptor.format).toBe("rgba16float");
        expect(wrapper._descriptor.samples).toBe(1);
        expect(wrapper._eager).toBe(true);
    });

    it("excludeFromVelocity and includeInVelocity toggle membership", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const task = createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.LINEAR_VELOCITY }] }, engine, scene);
        const mesh = { name: "mesh-1" } as unknown as import("../../../packages/babylon-lite/src/mesh/mesh").Mesh;

        // Toggle without exception.
        task.excludeFromVelocity(mesh);
        task.includeInVelocity(mesh);
        // Idempotency:
        task.includeInVelocity(mesh);
    });

    it("throws when depthTexture sampleCount mismatches samples", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const depth = {
            _descriptor: { dFormat: "depth32float" as const, samples: 4 as const, size: "canvas" as const },
            _colorTexture: null,
            _colorView: null,
            _depthTexture: null,
            _depthView: null,
            _width: 0,
            _height: 0,
        } as unknown as import("../../../packages/babylon-lite/src/engine/render-target").RenderTarget;
        expect(() => createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.VIEW_DEPTH }], samples: 1, depthTexture: depth }, engine, scene)).toThrow(
            /sampleCount/
        );
    });

    it("exposes its owned depth as `geometryDepthTexture` for downstream tasks", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const task = createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }], samples: 1, size: { width: 32, height: 24 } }, engine, scene);
        const internal = task as unknown as { record(): void; _mrt: { _depthTexture: GPUTexture | null; _depthView: GPUTextureView | null } };

        const depthRt = task.geometryDepthTexture;
        expect(depthRt).toBeTruthy();
        expect(depthRt._descriptor.dFormat).toBe("depth32float");
        expect(depthRt._descriptor.samples).toBe(1);
        expect(depthRt._eager).toBe(true);

        // Before record(): no GPU resources yet.
        expect(depthRt._depthView).toBeNull();

        internal.record();

        // After record(): wrapper slots populated from the MRT.
        expect(depthRt._depthTexture).toBe(internal._mrt._depthTexture);
        expect(depthRt._depthView).toBe(internal._mrt._depthView);
        expect(depthRt._width).toBe(32);
        expect(depthRt._height).toBe(24);
    });

    it("returns the externally-supplied depthTexture from `geometryDepthTexture`", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const external = {
            _descriptor: { dFormat: "depth32float" as const, samples: 1 as const, size: "canvas" as const },
            _colorTexture: null,
            _colorView: null,
            _depthTexture: null,
            _depthView: null,
            _width: 0,
            _height: 0,
        } as unknown as import("../../../packages/babylon-lite/src/engine/render-target").RenderTarget;
        const task = createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }], samples: 1, depthTexture: external }, engine, scene);
        // The accessor returns the same object the caller passed in.
        expect(task.geometryDepthTexture).toBe(external);
    });

    it("outputTexture is undefined when targetTexture is not provided", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const task = createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }], samples: 1 }, engine, scene);
        expect(task.outputTexture).toBeUndefined();
    });

    it("outputTexture is set to the targetTexture when provided", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const target = {
            _descriptor: { format: "bgra8unorm" as const, samples: 1 as const, size: "canvas" as const },
            _colorTexture: null,
            _colorView: null,
            _depthTexture: null,
            _depthView: null,
            _width: 0,
            _height: 0,
        } as unknown as import("../../../packages/babylon-lite/src/engine/render-target").RenderTarget;
        const task = createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }], samples: 1, targetTexture: target }, engine, scene);
        expect(task.outputTexture).toBe(target);
    });

    it("throws when targetTexture sampleCount mismatches samples", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const target = {
            _descriptor: { format: "bgra8unorm" as const, samples: 4 as const, size: "canvas" as const },
            _colorTexture: null,
            _colorView: null,
            _depthTexture: null,
            _depthView: null,
            _width: 0,
            _height: 0,
        } as unknown as import("../../../packages/babylon-lite/src/engine/render-target").RenderTarget;
        expect(() => createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }], samples: 1, targetTexture: target }, engine, scene)).toThrow(
            /sampleCount/
        );
    });

    it("throws when targetTexture has no format", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const target = {
            _descriptor: { samples: 1 as const, size: "canvas" as const },
            _colorTexture: null,
            _colorView: null,
            _depthTexture: null,
            _depthView: null,
            _width: 0,
            _height: 0,
        } as unknown as import("../../../packages/babylon-lite/src/engine/render-target").RenderTarget;
        expect(() => createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }], samples: 1, targetTexture: target }, engine, scene)).toThrow(
            /format/
        );
    });
});
