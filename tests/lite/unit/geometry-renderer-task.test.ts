import { describe, expect, it, vi } from "vitest";

// Lets one test hold the Standard family's optional-feature preload open; every other test runs the real one.
const standardFeaturePreload = vi.hoisted(() => ({ override: null as null | (() => Promise<void>) }));
vi.mock("../../../packages/babylon-lite/src/material/standard/geometry-view", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../packages/babylon-lite/src/material/standard/geometry-view")>();
    return {
        ...actual,
        preloadStandardGeometryFeatures: (...args: Parameters<typeof actual.preloadStandardGeometryFeatures>) =>
            standardFeaturePreload.override ? standardFeaturePreload.override() : actual.preloadStandardGeometryFeatures(...args),
    };
});

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createRenderTarget, type RenderTarget, type RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { _installMeshBlendingGeometrySupport } from "../../../packages/babylon-lite/src/frame-graph/geometry-mesh-blending";
import { createGeometryRendererTask } from "../../../packages/babylon-lite/src/frame-graph/geometry-renderer-task";
import { _computeMeshFeatures } from "../../../packages/babylon-lite/src/material/mesh-features";
import { GeometryTextureType } from "../../../packages/babylon-lite/src/frame-graph/geometry-types";
import { buildNodeGeometryRenderable } from "../../../packages/babylon-lite/src/material/node/node-geometry-renderable";
import { loadNodeBlockEmitterWithGeometry } from "../../../packages/babylon-lite/src/material/node/node-geometry-block-loader";
import { createNodeGeometryMaterialView } from "../../../packages/babylon-lite/src/material/node/node-geometry-view";
import { parseNodeMaterialFromSnippet, type NodeMaterial } from "../../../packages/babylon-lite/src/material/node/node-material";
import { createPbrComposer } from "../../../packages/babylon-lite/src/material/pbr/pbr-compose";
import { PBR_HAS_ALPHA_TEST } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { composePbrGeometryShader } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-output-shader";
import { _setActivePbrGeometryAttachments, createPbrGeometryMaterialView } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-view";
import { composeStandardGeometryShader } from "../../../packages/babylon-lite/src/material/standard/standard-geometry-output-shader";
import { buildStandardGeometryRenderable } from "../../../packages/babylon-lite/src/material/standard/standard-geometry-renderable";
import { createStandardGeometryMaterialView } from "../../../packages/babylon-lite/src/material/standard/geometry-view";
import { HAS_DIFFUSE_TEXTURE } from "../../../packages/babylon-lite/src/material/standard/standard-flags";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { MeshRebuilder, MeshRebuildResources } from "../../../packages/babylon-lite/src/render/renderable";
import { createSurfaceRenderTargetTexture } from "../../../packages/babylon-lite/src/texture/rtt-surface";
import { disposeRenderTargetTexture } from "../../../packages/babylon-lite/src/texture/rtt";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage" | "GPUShaderStage" | "GPUTextureUsage"> & {
    GPUBufferUsage?: { UNIFORM: number; COPY_DST: number; STORAGE: number };
    GPUShaderStage?: { VERTEX: number; FRAGMENT: number };
    GPUTextureUsage?: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number; COPY_DST: number };
};

gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8, STORAGE: 0x80 } as unknown as GPUBufferUsage;
gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 } as unknown as GPUShaderStage;
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4, COPY_SRC: 0x1, COPY_DST: 0x2 } as unknown as GPUTextureUsage;
_installMeshBlendingGeometrySupport();
function makeMockEngine(): EngineContext {
    const device = {
        features: new Set<GPUFeatureName>(),
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
        queue: { writeBuffer: () => undefined, onSubmittedWorkDone: async () => undefined },
    } as unknown as GPUDevice;
    const eng = {
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
            _descriptor: { format: "bgra8unorm", samples: 1, size: { width: 800, height: 600 } },
            _width: 0,
            _height: 0,
            _eager: true,
        } as unknown as import("../../../packages/babylon-lite/src/engine/render-target").RenderTarget,
        _currentDelta: 0,
        _cbs: [],
    } as unknown as EngineContext;
    const _surfaces = [eng];
    Object.assign(eng, { engine: eng, surfaces: _surfaces, _surfaces });
    return eng;
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
        expect(() => createGeometryRendererTask({ textureDescriptions: tooMany }, engine, scene)).toThrow(/too many color attachments/);
    });

    it("counts targetTexture against the 8-color-attachment limit", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const eight = Array.from({ length: 8 }, () => ({ type: GeometryTextureType.VIEW_NORMAL }));
        const target = {
            _descriptor: { format: "bgra8unorm" as const, samples: 1 as const, size: { width: 800, height: 600 } as const },
        } as unknown as import("../../../packages/babylon-lite/src/engine/render-target").RenderTarget;

        expect(() => createGeometryRendererTask({ textureDescriptions: eight, targetTexture: target }, engine, scene)).toThrow(/too many color attachments/);
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

    it("creates the scene bind group only when the task records", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const createBindGroup = vi.spyOn(engine._device, "createBindGroup");
        const task = createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }] }, engine, scene);

        expect(createBindGroup).not.toHaveBeenCalled();
        task.record();
        expect(createBindGroup).toHaveBeenCalledOnce();
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

    it("exposes an exact r8uint mesh-tag attachment with an unsigned-zero clear in any MRT slot", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const task = createGeometryRendererTask(
            {
                textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }, { type: GeometryTextureType.MESH_BLEND_TAG }, { type: GeometryTextureType.ALBEDO }],
            },
            engine,
            scene
        ) as unknown as {
            geometryMeshBlendTagTexture: RenderTarget;
            _mrt: { _descriptor: { colorFormats: GPUTextureFormat[] } };
            _colorAttachments: GPURenderPassColorAttachment[];
        };

        expect(task.geometryMeshBlendTagTexture._descriptor.format).toBe("r8uint");
        expect(task.geometryMeshBlendTagTexture._descriptor.samples).toBe(1);
        expect(task._mrt._descriptor.colorFormats).toEqual(["rgba16float", "r8uint", "rgba8unorm"]);
        expect(task._colorAttachments[1]!.clearValue).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    });

    it("rejects multisampled, reformatted, or nonzero-cleared mesh-tag attachments during preload", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const preload = (textureDescription: { type: GeometryTextureType; format?: GPUTextureFormat; clearValue?: GPUColor }, samples?: 1 | 4) =>
            (
                createGeometryRendererTask({ textureDescriptions: [textureDescription], samples }, engine, scene) as unknown as {
                    _preload(): Promise<void>;
                }
            )._preload();

        await expect(preload({ type: GeometryTextureType.MESH_BLEND_TAG }, 4)).rejects.toThrow(/requires samples: 1/);
        await expect(preload({ type: GeometryTextureType.MESH_BLEND_TAG, format: "r8unorm" })).rejects.toThrow(/format must be r8uint/);
        await expect(preload({ type: GeometryTextureType.MESH_BLEND_TAG, clearValue: { r: 1, g: 0, b: 0, a: 0 } })).rejects.toThrow(/clearValue must be unsigned integer zero/);
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
            _descriptor: { dFormat: "depth32float" as const, samples: 4 as const, size: { width: 800, height: 600 } as const },
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
        const internal = task as unknown as {
            record(): void;
            _mrt: { _depthTexture: GPUTexture | null; _depthView: GPUTextureView | null };
            _signature: { _depthCompare?: GPUCompareFunction };
        };

        const depthRt = task.geometryDepthTexture;
        expect(depthRt).toBeTruthy();
        expect(depthRt._descriptor.dFormat).toBe("depth32float");
        expect(depthRt._descriptor.depthClearValue).toBeUndefined();
        expect(depthRt._descriptor.depthCompare).toBeUndefined();
        expect(depthRt._descriptor.samples).toBe(1);
        expect(depthRt._eager).toBe(true);

        internal.record();

        // After record(): wrapper slots populated from the MRT.
        expect(depthRt._depthTexture).toBe(internal._mrt._depthTexture);
        expect(depthRt._depthView).toBe(internal._mrt._depthView);
        expect(depthRt._width).toBe(32);
        expect(depthRt._height).toBe(24);
        expect(internal._signature._depthCompare).toBe("greater-equal");
    });

    it("propagates an explicit target depth convention to owned geometry depth", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const target = {
            _descriptor: {
                format: "bgra8unorm" as const,
                depthClearValue: 1,
                depthCompare: "less-equal" as const,
                samples: 1 as const,
                size: { width: 32, height: 24 } as const,
            },
            _colorTexture: null,
            _colorView: null,
            _depthTexture: null,
            _depthView: null,
            _width: 0,
            _height: 0,
        } as unknown as import("../../../packages/babylon-lite/src/engine/render-target").RenderTarget;
        const task = createGeometryRendererTask(
            {
                textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }],
                samples: 1,
                size: { width: 32, height: 24 },
                targetTexture: target,
            },
            engine,
            scene
        );
        const internal = task as unknown as {
            record(): void;
            _mrt: { _depthTexture: GPUTexture | null; _depthView: GPUTextureView | null };
            _renderPassDescriptor: GPURenderPassDescriptor;
            _signature: { _depthCompare?: GPUCompareFunction };
        };

        const depthRt = task.geometryDepthTexture;
        expect(depthRt).toBeTruthy();
        expect(depthRt._descriptor.dFormat).toBe("depth32float");
        expect(depthRt._descriptor.depthClearValue).toBe(1);
        expect(depthRt._descriptor.depthCompare).toBe("less-equal");
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
        expect(internal._signature._depthCompare).toBe("less-equal");
        expect(internal._renderPassDescriptor.depthStencilAttachment?.depthClearValue).toBe(1);
    });

    it("returns the externally-supplied depthTexture from `geometryDepthTexture`", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const external = {
            _descriptor: {
                dFormat: "depth32float" as const,
                depthClearValue: 1,
                depthCompare: "less-equal" as const,
                samples: 1 as const,
                size: { width: 800, height: 600 } as const,
            },
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
        const signature = (task as unknown as { _signature: { _depthCompare?: GPUCompareFunction } })._signature;
        expect(signature._depthCompare).toBe("less-equal");
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
            _descriptor: { format: "bgra8unorm" as const, samples: 1 as const, size: { width: 800, height: 600 } as const },
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

    it("synchronizes sampled eager color and depth targets before recording", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const target = createRenderTarget({ format: "bgra8unorm", samples: 1, size: { width: 32, height: 24 } });
        target._eager = true;
        target._colorTexture = engine._device.createTexture({
            size: { width: 32, height: 24 },
            format: "bgra8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        target._colorView = target._colorTexture.createView();
        target._syncEager = vi.fn();
        const depth = createRenderTarget({ dFormat: "depth32float", samples: 1, size: { width: 32, height: 24 } });
        depth._eager = true;
        depth._depthTexture = engine._device.createTexture({
            size: { width: 32, height: 24 },
            format: "depth32float",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        depth._depthView = depth._depthTexture.createView();
        depth._syncEager = vi.fn();
        const task = createGeometryRendererTask(
            {
                textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }],
                samples: 1,
                size: { width: 32, height: 24 },
                targetTexture: target,
                depthTexture: depth,
            },
            engine,
            scene
        );

        task.record();

        expect(target._syncEager).toHaveBeenCalledWith(engine);
        expect(depth._syncEager).toHaveBeenCalledWith(engine);
    });

    it("keeps a scaled geometry MRT aligned with its external target across surface resize", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const size = { surface: engine, scale: 0.5 } as const;
        const target = createSurfaceRenderTargetTexture(engine, { format: "bgra8unorm", samples: 1, size });
        const task = createGeometryRendererTask(
            {
                textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }],
                samples: 1,
                size,
                targetTexture: target.rt,
            },
            engine,
            scene
        );
        const internal = task as unknown as { _mrt: { _width: number; _height: number } };

        task.record();
        expect([internal._mrt._width, internal._mrt._height]).toEqual([400, 300]);
        expect([target.rt._width, target.rt._height]).toEqual([400, 300]);

        engine.canvas.width = 66;
        engine.canvas.height = 34;
        task.record();
        expect([internal._mrt._width, internal._mrt._height]).toEqual([33, 17]);
        expect([target.rt._width, target.rt._height]).toEqual([33, 17]);

        task.dispose();
        disposeRenderTargetTexture(target);
    });

    it("throws when targetTexture sampleCount mismatches samples", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const target = {
            _descriptor: { format: "bgra8unorm" as const, samples: 4 as const, size: { width: 800, height: 600 } as const },
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
            _descriptor: { samples: 1 as const, size: { width: 800, height: 600 } as const },
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

    it("retires task-owned bound resources after task disposal using a detached generation", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const task = createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }] }, engine, scene);

        const disposeSpy = vi.fn();
        const mesh = { name: "geo-mesh" } as unknown as import("../../../packages/babylon-lite/src/mesh/mesh").Mesh;
        const lifetime = [disposeSpy];
        const internal = task as unknown as {
            _bound: Array<{ _mesh: unknown; _binding: { renderable: object }; _view: unknown; _lifetimeDisposers: (() => void)[] }>;
        };
        internal._bound.push({ _mesh: mesh, _binding: { renderable: {} }, _view: {}, _lifetimeDisposers: lifetime });

        const eng = engine as unknown as { _retirements: Array<() => void> | null };
        eng._retirements = [];

        task.dispose();
        // Deferred — not run synchronously at dispose time.
        expect(disposeSpy).not.toHaveBeenCalled();
        expect(eng._retirements!.length).toBe(1);

        // Drain retirements (simulating the next submitted frame).
        eng._retirements!.forEach((r) => r());
        expect(disposeSpy).toHaveBeenCalledOnce();
        expect(lifetime).toHaveLength(0);
    });

    it("removes and retires every matching bound entry immediately when the scene removes a mesh", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const task = createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }] }, engine, scene);
        const removedMesh = { name: "removed" };
        const keptMesh = { name: "kept" };
        const firstFree = vi.fn();
        const secondFree = vi.fn();
        const keptFree = vi.fn();
        const internal = task as unknown as {
            _removeMesh(mesh: object): void;
            _bound: Array<{ _mesh: object; _binding: { renderable: object }; _view: object; _lifetimeDisposers: (() => void)[] }>;
        };
        internal._bound.push(
            { _mesh: removedMesh, _binding: { renderable: {} }, _view: {}, _lifetimeDisposers: [firstFree] },
            { _mesh: keptMesh, _binding: { renderable: {} }, _view: {}, _lifetimeDisposers: [keptFree] },
            { _mesh: removedMesh, _binding: { renderable: {} }, _view: {}, _lifetimeDisposers: [secondFree] }
        );
        const eng = engine as unknown as { _retirements: Array<() => void> | null };
        eng._retirements = [];

        internal._removeMesh(removedMesh);

        expect(internal._bound.map((entry) => entry._mesh)).toEqual([keptMesh]);
        expect(firstFree).not.toHaveBeenCalled();
        expect(secondFree).not.toHaveBeenCalled();
        expect(keptFree).not.toHaveBeenCalled();
        expect(eng._retirements!.length).toBe(1);

        eng._retirements!.forEach((r) => r());
        expect(firstFree).toHaveBeenCalledOnce();
        expect(secondFree).toHaveBeenCalledOnce();
        expect(keptFree).not.toHaveBeenCalled();
    });

    it("executes an override-camera FO pass with coherent world / view / positional-light origins", async () => {
        const { makePackMeshWorld } = await import("../../../packages/babylon-lite/src/large-world/pack-mat4-with-offset");
        const { wrapRenderableForFO, applyLightFoOffset } = await import("../../../packages/babylon-lite/src/large-world/floating-origin");
        const { createStandardMaterial } = await import("../../../packages/babylon-lite/src/material/standard/create-standard-material");
        const { GeometryTextureType: GTT } = await import("../../../packages/babylon-lite/src/frame-graph/geometry-types");

        const makeWorld = (x: number, y: number, z: number): Float32Array => {
            const m = new Float32Array(16);
            m[0] = m[5] = m[10] = m[15] = 1;
            m[12] = x;
            m[13] = y;
            m[14] = z;
            return m;
        };
        const makeCam = (x: number, y: number, z: number) =>
            ({
                worldMatrix: makeWorld(x, y, z),
                worldMatrixVersion: 1,
                fov: 0.8,
                nearPlane: 0.1,
                farPlane: 1000,
                _viewCache: new Float32Array(16),
                _viewVer: -1,
                _projCache: new Float32Array(16),
                _projVer: -1,
                _projAspect: -1,
                _vpCache: new Float32Array(16),
                _vpVer: -1,
                _vpAspect: -1,
            }) as unknown as import("../../../packages/babylon-lite/src/camera/camera").Camera;

        // Capture every writeBuffer as a float copy so we can read back the mesh UBO world.
        const writes: Float32Array[] = [];
        const toFloats = (data: ArrayBuffer | ArrayBufferView, dataOff = 0, size?: number): Float32Array => {
            if (ArrayBuffer.isView(data)) {
                return new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
            }
            const ab = data as ArrayBuffer;
            const byteLen = size ?? ab.byteLength - dataOff;
            return new Float32Array(ab.slice(dataOff, dataOff + byteLen));
        };
        const passEncoder = {
            setBindGroup: () => undefined,
            setPipeline: () => undefined,
            setVertexBuffer: () => undefined,
            setIndexBuffer: () => undefined,
            drawIndexed: () => undefined,
            drawIndexedIndirect: () => undefined,
            end: () => undefined,
        };
        const engine = makeMockEngine();
        (engine._device as unknown as { queue: { writeBuffer: (...a: unknown[]) => void; writeTexture: () => void } }).queue = {
            writeBuffer: (...a: unknown[]) => {
                writes.push(toFloats(a[2] as ArrayBuffer | ArrayBufferView, a[3] as number | undefined, a[4] as number | undefined));
            },
            writeTexture: () => undefined,
        };
        Object.assign(engine, {
            useFloatingOrigin: true,
            _currentEncoder: { beginRenderPass: () => passEncoder } as unknown as GPUCommandEncoder,
            _makePackMeshWorld: makePackMeshWorld,
            _wrapRenderableForFO: wrapRenderableForFO,
            _applyLightFoOffset: applyLightFoOffset,
        });

        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        // Scene's active camera sits at a DIFFERENT large origin than the task override —
        // if the task incorrectly used scene.camera, the assertions below would fail.
        (scene as { camera?: unknown }).camera = makeCam(9000, 0, 0);
        const overrideCamera = makeCam(5000, 0, 0);
        // A point light (type 0) at world X=5000, Z=3.
        const light = {
            worldMatrix: makeWorld(5000, 0, 3),
            _lightVersion: 1,
            _writeLightUbo: (d: Float32Array, o: number) => {
                d[o + 3] = 0; // type tag 0 = point → applyLightFoOffset rewrites the position
            },
        };
        (scene as { lights: unknown[] }).lights = [light];

        const mesh = {
            material: createStandardMaterial(),
            worldMatrix: makeWorld(5000, 2, 0), // large absolute coords
            worldMatrixVersion: 1,
            hasVertexAlpha: false,
            skeleton: null,
            thinInstances: null,
            morphTargets: null,
            visible: true,
            _gpu: { positionBuffer: {}, normalBuffer: {}, indexBuffer: {}, indexCount: 3, indexFormat: "uint32" },
        } as unknown as import("../../../packages/babylon-lite/src/mesh/mesh").Mesh;

        const task = createGeometryRendererTask({ textureDescriptions: [{ type: GTT.WORLD_POSITION }], camera: overrideCamera, meshes: [mesh] }, engine, scene);
        const internal = task as unknown as {
            _preload(): Promise<void>;
            record(): void;
            execute(): number;
            _sceneData: Float32Array;
            _ownLightsScratch: Float32Array | null;
        };
        await internal._preload();
        internal.record();
        internal.execute();

        // (1) Mesh world packed origin-relative to the OVERRIDE camera: (5000,2,0) - (5000,0,0) = (0,2,0).
        const meshWorld = writes.find((f) => f.length >= 16 && f[13] === 2 && f[12] === 0 && f[14] === 0);
        expect(meshWorld, "mesh UBO world should be origin-relative to the override camera").toBeTruthy();
        // No write should contain the ABSOLUTE mesh translation (5000,2,0).
        expect(writes.some((f) => f.length >= 16 && f[12] === 5000 && f[13] === 2 && f[14] === 0)).toBe(false);

        // (2) Scene view matrix (data[16..31]) is origin-relative → translation column (28..30) zeroed.
        const sd = internal._sceneData;
        expect(sd[28]).toBe(0);
        expect(sd[29]).toBe(0);
        expect(sd[30]).toBe(0);
        // Eye position also zeroed under FO.
        expect(sd[32]).toBe(0);
        expect(sd[33]).toBe(0);
        expect(sd[34]).toBe(0);

        // (3) Positional light offset by the OVERRIDE origin: (5000,0,3) - (5000,0,0) = (0,0,3).
        // (If it had used scene.camera at X=9000, this would be -4000.)
        const ls = internal._ownLightsScratch!;
        expect(ls).toBeTruthy();
        expect(ls[4]).toBe(0);
        expect(ls[5]).toBe(0);
        expect(ls[6]).toBe(3);
    });

    it("uses the camera viewport's effective aspect ratio for geometry projection", async () => {
        const { createArcRotateCamera } = await import("../../../packages/babylon-lite/src/camera/arc-rotate");
        const { getViewProjectionMatrix } = await import("../../../packages/babylon-lite/src/camera/camera");
        const engine = makeMockEngine();
        const setViewport = vi.fn();
        const setScissorRect = vi.fn();
        engine._currentEncoder = {
            beginRenderPass: () =>
                ({
                    setViewport,
                    setScissorRect,
                    setBindGroup: () => undefined,
                    setPipeline: () => undefined,
                    end: () => undefined,
                }) as unknown as GPURenderPassEncoder,
        } as unknown as GPUCommandEncoder;
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        const camera = createArcRotateCamera(0, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
        camera.viewport = { x: 0, y: 0, width: 0.5, height: 1 };
        scene.camera = camera;
        const task = createGeometryRendererTask(
            {
                textureDescriptions: [{ type: GeometryTextureType.WORLD_POSITION }],
                size: { width: 200, height: 100 },
                meshes: [],
            },
            engine,
            scene
        ) as unknown as {
            _preload(): Promise<void>;
            record(): void;
            execute(): number;
            _sceneData: Float32Array;
        };

        await task._preload();
        task.record();
        task.execute();
        const effective = Array.from(getViewProjectionMatrix(camera, 1));
        const raw = Array.from(getViewProjectionMatrix(camera, 2));

        expect(Array.from(task._sceneData.subarray(0, 16))).toEqual(effective);
        expect(effective).not.toEqual(raw);
        expect(setViewport).toHaveBeenCalledExactlyOnceWith(0, 0, 100, 100, 0, 1);
        expect(setScissorRect).toHaveBeenCalledExactlyOnceWith(0, 0, 100, 100);
    });

    // ── Scene-mutation re-sync (stale `_bound` after removal / material swap) ──────
    // `execute()` re-syncs `_bound` when `scene._renderableVersion` advances so a
    // removed mesh is never drawn against destroyed UBOs/vertex buffers and a swapped
    // material's view is rebuilt make-before-break. Uses real Standard geometry
    // renderables (like the FO test) so the binding/view/disposer wiring is exercised.
    async function setupGeoTask(meshCount: number, explicitMeshes = false) {
        const { createStandardMaterial } = await import("../../../packages/babylon-lite/src/material/standard/create-standard-material");
        const makeWorld = (x: number): Float32Array => {
            const m = new Float32Array(16);
            m[0] = m[5] = m[10] = m[15] = 1;
            m[12] = x;
            return m;
        };
        const drawnIndexCounts: number[] = [];
        const passEncoder = {
            setBindGroup: () => undefined,
            setPipeline: () => undefined,
            setVertexBuffer: () => undefined,
            setIndexBuffer: () => undefined,
            drawIndexed: (indexCount: number) => drawnIndexCounts.push(indexCount),
            drawIndexedIndirect: () => undefined,
            end: () => undefined,
        };
        const engine = makeMockEngine();
        (engine._device as unknown as { queue: { writeBuffer: () => void; writeTexture: () => void } }).queue = {
            writeBuffer: () => undefined,
            writeTexture: () => undefined,
        };
        Object.assign(engine, {
            _currentEncoder: { beginRenderPass: () => passEncoder } as unknown as GPUCommandEncoder,
            _retirements: [] as Array<() => void>,
        });
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        (scene as { camera?: unknown }).camera = {
            worldMatrix: makeWorld(0),
            worldMatrixVersion: 1,
            fov: 0.8,
            nearPlane: 0.1,
            farPlane: 1000,
            _viewCache: new Float32Array(16),
            _viewVer: -1,
            _projCache: new Float32Array(16),
            _projVer: -1,
            _projAspect: -1,
            _vpCache: new Float32Array(16),
            _vpVer: -1,
            _vpAspect: -1,
        };
        type M = import("../../../packages/babylon-lite/src/mesh/mesh").Mesh;
        const meshes: M[] = [];
        for (let i = 0; i < meshCount; i++) {
            const material = createStandardMaterial();
            material.alpha = 1;
            meshes.push({
                material,
                worldMatrix: makeWorld(i),
                worldMatrixVersion: 1,
                hasVertexAlpha: false,
                skeleton: null,
                thinInstances: null,
                morphTargets: null,
                visible: true,
                // Distinct indexCount per mesh so a draw can be attributed to a mesh.
                _gpu: { positionBuffer: {}, normalBuffer: {}, indexBuffer: {}, indexCount: 10 + i, indexFormat: "uint32" },
            } as unknown as M);
        }
        scene.meshes.push(...meshes);
        const task = createGeometryRendererTask(
            {
                textureDescriptions: [{ type: GeometryTextureType.WORLD_POSITION }],
                ...(explicitMeshes ? { meshes } : {}),
            },
            engine,
            scene
        );
        const internal = task as unknown as {
            _preload(): Promise<void>;
            record(): void;
            execute(): number;
            _removeMesh(mesh: object): void;
            _bound: Array<{
                _mesh: M;
                _view: { source: unknown; _buildGroup: { _rebuildSingle?: MeshRebuilder } };
                _binding: { renderable: object };
                _lifetimeDisposers: (() => void)[];
            }>;
        };
        await internal._preload();
        internal.record();
        return { scene, internal, meshes, drawnIndexCounts, engine, createStandardMaterial };
    }

    const idxCount = (m: Mesh): number => (m as unknown as { _gpu: { indexCount: number } })._gpu.indexCount;

    function simulateMeshRemoval(scene: SceneContext, task: { _removeMesh(mesh: object): void }, mesh: Mesh): void {
        // Simulate removeFromScene: evict task-owned geometry resources first, then
        // drop the mesh from the scene and bump the mutation version.
        task._removeMesh(mesh);
        scene.meshes.splice(scene.meshes.indexOf(mesh), 1);
        scene._renderableVersion++;
    }

    it("drops a removed mesh from _bound on the next execute so it is not drawn against destroyed resources", async () => {
        const { scene, internal, meshes, drawnIndexCounts } = await setupGeoTask(2);
        expect(internal._bound.map((b) => b._mesh)).toEqual(meshes);

        const removed = meshes[1]!;
        simulateMeshRemoval(scene, internal, removed);
        expect(internal._bound.map((b) => b._mesh)).toEqual([meshes[0]]);

        drawnIndexCounts.length = 0;
        const draws = internal.execute();

        // Removed mesh is no longer bound → not drawn (its distinct indexCount absent),
        // and execute completed without touching its destroyed UBOs (no throw).
        expect(internal._bound.map((b) => b._mesh)).toEqual([meshes[0]]);
        expect(drawnIndexCounts).toContain(idxCount(meshes[0]!));
        expect(drawnIndexCounts).not.toContain(idxCount(removed));
        expect(draws).toBe(1);
    });

    it("drops a removed mesh even when the task was created with an explicit mesh list", async () => {
        const { scene, internal, meshes, drawnIndexCounts } = await setupGeoTask(2, true);
        const removed = meshes[1]!;
        simulateMeshRemoval(scene, internal, removed);

        drawnIndexCounts.length = 0;
        const draws = internal.execute();

        expect(internal._bound.map((b) => b._mesh)).toEqual([meshes[0]]);
        expect(drawnIndexCounts).not.toContain(idxCount(removed));
        expect(draws).toBe(1);
    });

    it("rebuilds a swapped mesh's geometry view on the next execute (make-before-break, no use-after-free)", async () => {
        const { scene, internal, meshes, engine, createStandardMaterial } = await setupGeoTask(1);
        const mesh = meshes[0]!;
        const oldView = internal._bound[0]!._view;
        expect(oldView.source).toBe(mesh.material);
        const oldLifetime = internal._bound[0]!._lifetimeDisposers;
        expect(oldLifetime.length).toBeGreaterThan(0);

        // Swap the material and bump the mutation version, mirroring processMaterialSwaps.
        const newMat = createStandardMaterial();
        (mesh as unknown as { material: unknown }).material = newMat;
        scene._renderableVersion++;

        const retirements = (engine as unknown as { _retirements: Array<() => void> })._retirements;
        retirements.length = 0;
        internal.execute();

        // The mesh's view is rebuilt to wrap the NEW material...
        expect(internal._bound).toHaveLength(1);
        const newView = internal._bound[0]!._view;
        expect(newView).not.toBe(oldView);
        expect(newView.source).toBe(newMat);
        // ...and the old binding is retired make-before-break (deferred GPU free queued),
        // not destroyed synchronously under a possibly-in-flight frame.
        expect(retirements.length).toBeGreaterThan(0);
        expect(oldLifetime.length).toBeGreaterThan(0);
        retirements.forEach((r) => r());
        expect(oldLifetime).toHaveLength(0);
    });

    it("binds a mesh whose material family first appears after the task was preloaded", async () => {
        // `_preload` imports a family bridge only for families present at that moment. A PBR mesh
        // added to a Standard-only scene later used to reach an unloaded bridge and throw on every
        // frame, from `execute()` and from every `frameGraph.build()`.
        const { scene, internal, meshes } = await setupGeoTask(1);
        const { createPbrMaterial } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-material");
        type M = import("../../../packages/babylon-lite/src/mesh/mesh").Mesh;
        const late = { ...(meshes[0] as unknown as Record<string, unknown>), material: createPbrMaterial() } as unknown as M;
        scene.meshes.push(late);
        scene._renderableVersion++;

        expect(() => internal.execute()).not.toThrow();
        // The Standard mesh keeps rendering while the PBR bridge loads.
        expect(internal._bound.map((b) => b._mesh)).toEqual([meshes[0]]);

        // Once the bridge is in, the bound list is marked stale so the next execute binds the late mesh.
        const lateState = internal as unknown as { _lateLoad?: Promise<void>; _createPbrGeometryView: unknown; _boundVer: number };
        expect(lateState._lateLoad).toBeInstanceOf(Promise);
        await lateState._lateLoad;
        expect(lateState._createPbrGeometryView).toBeTypeOf("function");
        expect(lateState._boundVer).toBe(-1);
        expect(lateState._lateLoad).toBeUndefined();
    });

    // A late PBR mesh is forward-built asynchronously. These drive the geometry task through that pending
    // window with the REAL PBR geometry builder, which throws on a missing or unusable context — so binding
    // the mesh too early fails the test the same way it stops the render loop.
    type LateMesh = import("../../../packages/babylon-lite/src/mesh/mesh").Mesh;
    type LateState = {
        _lateLoad?: Promise<void>;
        _createPbrGeometryView: ((source: unknown, config: unknown) => { _buildGroup: { _rebuildSingle?: unknown } }) | null;
    };

    type ForwardRenderable = { mesh?: LateMesh; _gen?: readonly [unknown, number] };

    /** What the forward PBR build tracks for a mesh when it completes: a renderable stamped with the material
     *  render-feature object and the mesh capability bits it was built for. */
    function forwardRenderableFor(mesh: LateMesh): ForwardRenderable {
        return { mesh, _gen: [(mesh.material as { _renderFeatures?: unknown })._renderFeatures, _computeMeshFeatures(mesh)] };
    }

    /** Swap the PBR view's renderable builder for a recording one: the real PBR geometry renderable needs the
     *  composed scene shader, which the mocked device cannot provide. */
    function recordPbrGeometryBuilds(state: LateState): unknown[] {
        const realFactory = state._createPbrGeometryView!;
        const builtFor: unknown[] = [];
        state._createPbrGeometryView = (source, viewConfig) => {
            const view = realFactory(source, viewConfig);
            view._buildGroup._rebuildSingle = (_scene: unknown, mesh: unknown) => {
                builtFor.push(mesh);
                const renderable = { mesh, isTransparent: false, order: 0, bind: () => ({ renderable, pipeline: {}, draw: () => 1 }) };
                return renderable;
            };
            return view;
        };
        return builtFor;
    }

    async function addLatePbrMesh(existingContext: boolean) {
        const setup = await setupGeoTask(1);
        const { scene, internal, meshes } = setup;
        const { createPbrMaterial } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-material");
        const material = createPbrMaterial();
        const late = { ...(meshes[0] as unknown as Record<string, unknown>), material, thinInstances: { count: 4 } } as unknown as LateMesh;
        const pbrScene = scene as unknown as { _pbrGeomContext?: unknown };
        // The PBR group as the runtime build leaves it while pending: the mesh has joined the group, but the
        // group's tracked output holds no renderable for it yet.
        const group = Object.assign([late], { o: [] as ForwardRenderable[] });
        scene._groups.set((material as unknown as { _buildGroup: never })._buildGroup, group as never);
        if (existingContext) {
            // An existing PBR scene: this context was composed before the late mesh existed (no thin-instance
            // helpers, no morph declarations) and is NOT sufficient to render it.
            pbrScene._pbrGeomContext = {};
        }
        scene.meshes.push(late);
        scene._renderableVersion++;

        const state = internal as unknown as LateState;
        internal.execute();
        await state._lateLoad;
        expect(state._createPbrGeometryView).toBeTypeOf("function");

        const completeForwardBuild = (): unknown[] => {
            const builtFor = recordPbrGeometryBuilds(state);
            // What the forward build does when it completes: publish the context, track the mesh's renderable
            // (stamped with the generation it was built for) in its group's output, bump the scene version.
            pbrScene._pbrGeomContext = {};
            group.o.push(forwardRenderableFor(late));
            scene._renderableVersion++;
            return builtFor;
        };
        return { ...setup, late, completeForwardBuild };
    }

    it("keeps a late PBR mesh deferred while the scene has no PBR context yet", async () => {
        // First PBR mesh in a running Standard-only scene: the geometry bridge import can win the race against
        // the forward build, and `buildPbrGeometryRenderable()` then threw "scene has no PBR context"
        // synchronously out of `execute()` — outside the late-load rejection path.
        const { scene, internal, meshes, late, completeForwardBuild } = await addLatePbrMesh(false);

        expect(() => internal.execute()).not.toThrow();
        expect(internal._bound.map((b) => b._mesh)).toEqual([meshes[0]]);
        // Unrelated scene mutations and re-records in that window keep skipping it as well.
        scene._renderableVersion++;
        expect(() => internal.execute()).not.toThrow();
        expect(internal._bound.map((b) => b._mesh)).toEqual([meshes[0]]);

        const builtFor = completeForwardBuild();
        expect(() => internal.execute()).not.toThrow();
        expect(builtFor).toEqual([late]);
        expect(internal._bound.map((b) => b._mesh)).toEqual([meshes[0], late]);
    });

    it("keeps a late PBR mesh deferred while an existing PBR context cannot render it yet", async () => {
        // Existing PBR scene, first thin-instanced PBR mesh added at runtime, resize / re-record while its
        // forward build is pending. Any context used to be treated as sufficient, so the mesh was bound
        // against the old scene-wide composer: no thin-instance helpers (every instance at the base
        // transform) and, with morph targets, an invalid shader. It has to wait for ITS forward build.
        const { scene, internal, meshes, late, completeForwardBuild } = await addLatePbrMesh(true);

        expect(() => internal.execute()).not.toThrow();
        expect(internal._bound.map((b) => b._mesh)).toEqual([meshes[0]]);
        scene._renderableVersion++;
        expect(() => internal.execute()).not.toThrow();
        expect(internal._bound.map((b) => b._mesh)).toEqual([meshes[0]]);

        const builtFor = completeForwardBuild();
        expect(() => internal.execute()).not.toThrow();
        expect(builtFor).toEqual([late]);
        expect(internal._bound.map((b) => b._mesh)).toEqual([meshes[0], late]);
    });

    it("keeps an already-built PBR mesh out while a forward rebuild for its current generation is pending", async () => {
        // The retained-old-output window. An already forward-built PBR mesh gains thin instances and its
        // material goes through a same-group rebuild. Forward rebuilds are make-before-break, so until the
        // rebuild completes the group still tracks the OLD renderable. Historical membership in `group.o`
        // therefore proves nothing: if the geometry bridge finishes loading in that window, binding the mesh
        // pairs its new state with the old context — an instanced draw without the instance-matrix buffer.
        const { scene, internal, meshes } = await setupGeoTask(1);
        const { createPbrMaterial } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-material");
        const { _computePbrMaterialFeatures } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-material-features");
        const material = createPbrMaterial() as unknown as { _buildGroup: never; _renderFeatures?: unknown };
        material._renderFeatures = _computePbrMaterialFeatures(material as never);
        const built = { ...(meshes[0] as unknown as Record<string, unknown>), material } as unknown as LateMesh;
        // Forward state of an existing PBR scene: context published, the mesh's renderable tracked by its group.
        (scene as unknown as { _pbrGeomContext?: unknown })._pbrGeomContext = {};
        const group = Object.assign([built], { o: [forwardRenderableFor(built)] });
        scene._groups.set(material._buildGroup, group as never);
        scene.meshes.push(built);
        scene._renderableVersion++;

        // The mesh changes generation twice over before the geometry bridge is even in: first thin instances...
        (built as unknown as { thinInstances: unknown }).thinInstances = { count: 4 };
        // ...and a material rebuild request, which drops the render-feature object (`rebuildMaterial`).
        material._renderFeatures = undefined;

        const state = internal as unknown as LateState;
        internal.execute();
        await state._lateLoad;
        const builtFor = recordPbrGeometryBuilds(state);

        // Late bridge completion inside the window: the old forward output is still tracked, the mesh stays out.
        expect(() => internal.execute()).not.toThrow();
        expect(builtFor).toEqual([]);
        expect(internal._bound.map((b) => b._mesh)).toEqual([meshes[0]]);

        // Each change alone is enough to keep it out. Material generation current again, capability still stale:
        group.o[0] = { ...forwardRenderableFor(built), _gen: [material._renderFeatures, _computeMeshFeatures(meshes[0]!)] };
        scene._renderableVersion++;
        internal.execute();
        expect(builtFor).toEqual([]);
        // Capability current, material generation stale:
        group.o[0] = { ...forwardRenderableFor(built), _gen: [{}, _computeMeshFeatures(built)] };
        scene._renderableVersion++;
        internal.execute();
        expect(builtFor).toEqual([]);

        // The forward rebuild completes: the group tracks a renderable built for the mesh as it is now.
        group.o[0] = forwardRenderableFor(built);
        scene._renderableVersion++;
        expect(() => internal.execute()).not.toThrow();
        expect(builtFor).toEqual([built]);
        expect(internal._bound.map((b) => b._mesh)).toEqual([meshes[0], built]);
    });

    it("still binds an off-scene PBR mesh of an explicit list against the scene-level context", async () => {
        // Caller-supplied off-scene meshes are never forward-built, so the deferral must not apply to them.
        const { scene, internal, meshes } = await setupGeoTask(1, true);
        const { createPbrMaterial } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-material");
        const offScene = { ...(meshes[0] as unknown as Record<string, unknown>), material: createPbrMaterial() } as unknown as LateMesh;
        (meshes as LateMesh[]).push(offScene);
        (scene as unknown as { _pbrGeomContext?: unknown })._pbrGeomContext = {};
        scene._renderableVersion++;

        const state = internal as unknown as LateState;
        internal.execute();
        await state._lateLoad;
        const builtFor = recordPbrGeometryBuilds(state);
        expect(() => internal.execute()).not.toThrow();
        expect(builtFor).toEqual([offScene]);
    });

    it("exposes a late Standard family only after its optional feature helpers have loaded", async () => {
        // `_preload` used to install the Standard factory BEFORE awaiting the skeletal-velocity / thin-instance
        // helpers. A resize or scene mutation landing in that window passed the readiness guard and threw
        // "... was not preloaded", stopping the render loop although the import completed a moment later.
        const { scene, internal } = await setupGeoTask(1);
        const state = internal as unknown as { _lateLoad?: Promise<void>; _createStandardGeometryView: unknown; _computeStandardFeatures: unknown; _boundVer: number };
        state._createStandardGeometryView = null; // the family has not been seen by `_preload` yet
        state._computeStandardFeatures = null;
        let release!: () => void;
        standardFeaturePreload.override = () => new Promise<void>((resolve) => (release = resolve));
        try {
            scene._renderableVersion++;
            expect(() => internal.execute()).not.toThrow();
            // Let the bridge import settle; the feature preload is still held open.
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(state._createStandardGeometryView).toBeNull();
            // A frame-graph rebuild / execute in that window must keep skipping the family, not throw.
            scene._renderableVersion++;
            expect(() => internal.execute()).not.toThrow();
            expect(internal._bound).toEqual([]);

            release();
            await state._lateLoad;
            expect(state._createStandardGeometryView).toBeTypeOf("function");
            expect(state._boundVer).toBe(-1);
        } finally {
            standardFeaturePreload.override = null;
        }
    });

    it("reports a rejected late bridge load and retries on a later frame", async () => {
        const { scene, internal, meshes } = await setupGeoTask(1);
        const { createPbrMaterial } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-material");
        type M = import("../../../packages/babylon-lite/src/mesh/mesh").Mesh;
        const late = { ...(meshes[0] as unknown as Record<string, unknown>), material: createPbrMaterial() } as unknown as M;
        scene.meshes.push(late);
        scene._renderableVersion++;

        const state = internal as unknown as { _preload(): Promise<void>; _lateLoad?: Promise<void>; _createPbrGeometryView: unknown; _boundVer: number };
        const realPreload = state._preload.bind(state);
        const failure = new Error("chunk failed to load");
        state._preload = vi.fn().mockRejectedValueOnce(failure).mockImplementation(realPreload);
        const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            internal.execute();
            await state._lateLoad;
            // Reported, not swallowed and not left as an unhandled rejection...
            expect(reported).toHaveBeenCalledWith(failure);
            // ...and neither the cached promise nor the bound list keeps the family locked out.
            expect(state._lateLoad).toBeUndefined();
            expect(state._boundVer).toBe(-1);
            expect(state._createPbrGeometryView).toBeNull();

            // The next frame starts a fresh attempt, which now succeeds.
            expect(() => internal.execute()).not.toThrow();
            expect(state._lateLoad).toBeInstanceOf(Promise);
            await state._lateLoad;
            expect(state._preload).toHaveBeenCalledTimes(2);
            expect(state._createPbrGeometryView).toBeTypeOf("function");
        } finally {
            reported.mockRestore();
        }
    });

    it("keeps previous bindings active and rolls back every staged resource when a later replacement fails", async () => {
        const { scene, internal, meshes } = await setupGeoTask(2);
        const previousBound = internal._bound;
        const buildGroup = previousBound[0]!._view._buildGroup;
        const originalRebuild = buildGroup._rebuildSingle;
        const firstDispose = vi.fn();
        const failingDispose = vi.fn();
        buildGroup._rebuildSingle = (candidateScene, mesh, material, resources) => {
            resources!._lifetimeDisposers.push(mesh === meshes[0] ? firstDispose : failingDispose);
            if (mesh === meshes[1]) {
                throw new Error("replacement build failed");
            }
            return originalRebuild!(candidateScene, mesh, material, resources);
        };
        scene._renderableVersion++;

        try {
            expect(() => internal.execute()).toThrow("replacement build failed");
            expect(internal._bound).toBe(previousBound);
            expect(firstDispose).toHaveBeenCalledOnce();
            expect(failingDispose).toHaveBeenCalledOnce();
        } finally {
            buildGroup._rebuildSingle = originalRebuild;
        }
    });

    it("stamps and rolls back the staged lifetime sink when replacement binding fails", async () => {
        const { scene, internal } = await setupGeoTask(1);
        const previousBound = internal._bound;
        const buildGroup = previousBound[0]!._view._buildGroup;
        const originalRebuild = buildGroup._rebuildSingle;
        const dispose = vi.fn();
        buildGroup._rebuildSingle = (candidateScene, mesh, material, resources) => {
            resources!._lifetimeDisposers.push(dispose);
            const renderable = originalRebuild!(candidateScene, mesh, material, resources);
            renderable.bind = () => {
                expect(renderable._lifetimeDisposers).toBe(resources!._lifetimeDisposers);
                throw new Error("replacement bind failed");
            };
            return renderable;
        };
        scene._renderableVersion++;

        try {
            expect(() => internal.execute()).toThrow("replacement bind failed");
            expect(internal._bound).toBe(previousBound);
            expect(dispose).toHaveBeenCalledOnce();
        } finally {
            buildGroup._rebuildSingle = originalRebuild;
        }
    });
});

describe("Mesh-blending geometry shader contracts", () => {
    it("emits a u32 Standard tag output after the existing alpha/discard path", () => {
        const composed = composeStandardGeometryShader(HAS_DIFFUSE_TEXTURE, 0, [], [GeometryTextureType.VIEW_NORMAL, GeometryTextureType.MESH_BLEND_TAG]);

        expect(composed._fragmentWGSL).toContain("@location(0) f0: vec4<f32>,");
        expect(composed._fragmentWGSL).toContain("@location(1) meshBlendTag1: u32,");
        expect(composed._fragmentWGSL).toContain("out.meshBlendTag1 = select(select(0u, mesh.lc >> 8u, alpha > 0.4), mesh.lc >> 8u, mat.aCut > 0.0);");
        expect(composed._meshUboSpec._offsets.has("meshBlendTag")).toBe(false);
        expect(composed._meshUboSpec._offsets.has("lc")).toBe(true);
    });

    it("validates the resolved raw Standard mesh tag before its geometry UBO upload", async () => {
        const { createStandardMaterial } = await import("../../../packages/babylon-lite/src/material/standard/create-standard-material");
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        const material = createStandardMaterial();
        const view = createStandardGeometryMaterialView(material, {
            attachments: [GeometryTextureType.MESH_BLEND_TAG],
            emitColor: false,
        });
        const clone = {
            material,
            meshBlendingTag: 64,
            worldMatrix: new Float32Array(16),
            worldMatrixVersion: 1,
            hasVertexAlpha: false,
            skeleton: null,
            thinInstances: null,
            morphTargets: null,
            visible: true,
            _gpu: {
                positionBuffer: {} as GPUBuffer,
                normalBuffer: {} as GPUBuffer,
                indexBuffer: {} as GPUBuffer,
                indexCount: 3,
                indexFormat: "uint32",
            },
        } as unknown as Mesh;
        const resources: MeshRebuildResources = { _lifetimeDisposers: [] };

        expect(() => buildStandardGeometryRenderable(scene, clone, view, resources)).toThrow(/group ID/);
        resources._lifetimeDisposers.forEach((dispose) => dispose());
    });

    it("emits a corrected u32 PBR tag output and preserves the alpha-tested raw-tag contract", async () => {
        const { _installMeshBlendingPbrSupport } = await import("../../../packages/babylon-lite/src/post-process/mesh-blending-pbr-support");
        _installMeshBlendingPbrSupport();
        const attachments = [GeometryTextureType.ALBEDO, GeometryTextureType.MESH_BLEND_TAG] as const;
        const source = { _renderFeatures: { features: PBR_HAS_ALPHA_TEST, features2: 0 } };
        const view = createPbrGeometryMaterialView(source as never, { attachments, emitColor: false });
        const composePbr = createPbrComposer({
            _singleLightWGSL: "",
            _getSingleLightBlock: null,
            _multiLightWGSL: "",
            _multiLightLoop: "",
            _tm: undefined,
            _fogHelper: "",
            _fogBlock: "",
            _createPbrTemplateExt: null,
            _flatNormalWgsl: "",
            _createPbrShadowFragment: null,
            _shadowLights: [],
            _createThinInstanceFragment: null,
        });
        const previousAttachments = _setActivePbrGeometryAttachments(attachments);
        const composed = (() => {
            try {
                return composePbrGeometryShader(composePbr, view._renderFeatures.features, view._renderFeatures.features2 ?? 0, 0, 0, 0, "", "", undefined, "", attachments, false);
            } finally {
                _setActivePbrGeometryAttachments(previousAttachments);
            }
        })();

        expect(composed._fragmentWGSL).toContain("@location(0) f0: vec4<f32>,");
        expect(composed._fragmentWGSL).toContain("@location(1) meshBlendTag1: u32,");
        expect(composed._fragmentWGSL).toContain("out.meshBlendTag1 = mesh.lc >> 8u;");
        expect(composed._vertexWGSL).toContain("meshBlendNormalWorld=transposeMat3(inverseMat3(meshBlendNormalWorld));");
        expect(composed._materialUboSpec!._offsets.has("meshBlendTag")).toBe(false);
        expect(composed._meshUboSpec._offsets.has("lc")).toBe(true);
    });

    it("re-emits a Node geometry graph with an engine-owned u32 mesh-tag slot and geometry-safe additive blending", async () => {
        const engine = makeMockEngine();
        const graph = {
            blocks: [
                { customType: "BABYLON.InputBlock", id: 1, name: "position", mode: 1, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
                { customType: "BABYLON.InputBlock", id: 2, name: "wvp", mode: 0, type: 0x80, inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.TransformBlock",
                    id: 3,
                    name: "transform",
                    complementW: 1,
                    inputs: [
                        { name: "vector", targetBlockId: 1, targetConnectionName: "output" },
                        { name: "transform", targetBlockId: 2, targetConnectionName: "output" },
                    ],
                    outputs: [{ name: "output" }],
                },
                {
                    customType: "BABYLON.VertexOutputBlock",
                    id: 4,
                    name: "vertexOutput",
                    inputs: [{ name: "vector", targetBlockId: 3, targetConnectionName: "output" }],
                    outputs: [],
                },
                { customType: "BABYLON.InputBlock", id: 5, name: "color", mode: 0, type: 0x8, value: [1, 1, 1], inputs: [], outputs: [{ name: "output" }] },
                {
                    customType: "BABYLON.FragmentOutputBlock",
                    id: 6,
                    name: "fragmentOutput",
                    inputs: [{ name: "rgb", targetBlockId: 5, targetConnectionName: "output" }],
                    outputs: [],
                },
                { customType: "BABYLON.GeometryTextureOutputBlock", id: 7, name: "geometryOutput", inputs: [], outputs: [] },
            ],
            outputNodes: [4, 6, 7],
        };
        const material = await parseNodeMaterialFromSnippet(engine, "", { json: graph, blockLoader: loadNodeBlockEmitterWithGeometry });
        const view = createNodeGeometryMaterialView(material, {
            attachments: [GeometryTextureType.WORLD_NORMAL, GeometryTextureType.MESH_BLEND_TAG],
            emitColor: false,
        });
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        const mesh = {
            material,
            worldMatrix: new Float32Array(16),
            worldMatrixVersion: 1,
            receiveShadows: false,
            visible: true,
            children: [],
            _gpu: {
                positionBuffer: {} as GPUBuffer,
                indexBuffer: {} as GPUBuffer,
                indexCount: 3,
                indexFormat: "uint32",
            },
        } as unknown as Mesh;
        const resources: MeshRebuildResources = { _lifetimeDisposers: [] };

        buildNodeGeometryRenderable(scene, mesh, view, resources);
        const geometry = view._geometry as {
            _struct: string;
            _fsReturn: string;
        };
        expect(geometry._struct).toContain("@location(0) f0: vec4<f32>,");
        expect(geometry._struct).toContain("@location(1) meshBlendTag1: u32,");
        expect(geometry._fsReturn).toContain("out.meshBlendTag1 = u32(meshU.receivesShadow.x);");
        resources._lifetimeDisposers.forEach((dispose) => dispose());

        (material as NodeMaterial & { _needsAlphaBlending: boolean })._needsAlphaBlending = true;
        (material._graph as { alphaMode: number }).alphaMode = 1;

        const transparentView = createNodeGeometryMaterialView(material, {
            attachments: [GeometryTextureType.VIEW_DEPTH, GeometryTextureType.ALBEDO],
            emitColor: false,
        });
        const transparentResources: MeshRebuildResources = { _lifetimeDisposers: [] };
        const transparentRenderable = buildNodeGeometryRenderable(scene, mesh, transparentView, transparentResources);
        const createPipeline = vi.spyOn(engine._device, "createRenderPipeline");
        expect(() =>
            transparentRenderable.bind(engine, {
                _colorFormat: "r32float",
                _colorFormats: ["r32float", "rgba8unorm"],
                _depthStencilFormat: "depth32float",
                _depthCompare: "greater-equal",
                _sampleCount: 1,
            } as unknown as RenderTargetSignature)
        ).toThrow(/float32-blendable/);

        transparentRenderable.bind(engine, {
            _colorFormat: "r16float",
            _colorFormats: ["r16float", "rgba8unorm"],
            _depthStencilFormat: "depth32float",
            _depthCompare: "greater-equal",
            _sampleCount: 1,
        } as unknown as RenderTargetSignature);
        const transparentPipeline = createPipeline.mock.calls.at(-1)![0];
        const geometryBlend = {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        };
        expect(transparentPipeline.fragment!.targets[0]).toEqual({ format: "r16float", blend: geometryBlend });
        expect(transparentPipeline.fragment!.targets[1]).toEqual({ format: "rgba8unorm", blend: geometryBlend });
        expect(transparentPipeline.depthStencil!.depthWriteEnabled).toBe(false);
        transparentResources._lifetimeDisposers.forEach((dispose) => dispose());

        const taggedTask = createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.MESH_BLEND_TAG }], meshes: [mesh] }, engine, scene) as unknown as {
            _preload(): Promise<void>;
            record(): void;
            dispose(): void;
        };
        await taggedTask._preload();
        expect(() => taggedTask.record()).toThrow(/transparent Node materials cannot write MESH_BLEND_TAG/);
        taggedTask.dispose();
    });

    it("omits blend state only from the r8uint target in a transparent Standard MRT pipeline", async () => {
        const { createStandardMaterial } = await import("../../../packages/babylon-lite/src/material/standard/create-standard-material");
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        const material = createStandardMaterial();
        material.alpha = 0.5;
        const view = createStandardGeometryMaterialView(material, {
            attachments: [GeometryTextureType.MESH_BLEND_TAG, GeometryTextureType.ALBEDO],
            emitColor: false,
        });
        const mesh = {
            material,
            worldMatrix: new Float32Array(16),
            worldMatrixVersion: 1,
            hasVertexAlpha: false,
            skeleton: null,
            thinInstances: null,
            morphTargets: null,
            visible: true,
            _gpu: {
                positionBuffer: {} as GPUBuffer,
                normalBuffer: {} as GPUBuffer,
                indexBuffer: {} as GPUBuffer,
                indexCount: 3,
                indexFormat: "uint32",
            },
        } as unknown as Mesh;
        const resources: MeshRebuildResources = { _lifetimeDisposers: [] };
        const renderable = buildStandardGeometryRenderable(scene, mesh, view, resources);
        const createPipeline = vi.spyOn(engine._device, "createRenderPipeline");

        renderable.bind(engine, {
            _colorFormat: "r8uint",
            _colorFormats: ["r8uint", "rgba8unorm"],
            _depthStencilFormat: "depth32float",
            _depthCompare: "greater-equal",
            _sampleCount: 1,
        } as unknown as RenderTargetSignature);

        const descriptor = createPipeline.mock.calls.at(-1)![0];
        const targets = descriptor.fragment!.targets as GPUColorTargetState[];
        expect(targets[0]).toEqual({ format: "r8uint" });
        expect(targets[1]).toMatchObject({ format: "rgba8unorm", blend: expect.any(Object) });
        resources._lifetimeDisposers.forEach((dispose) => dispose());
    });
});
