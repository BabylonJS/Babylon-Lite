import { describe, expect, it, vi } from "vitest";

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
            _descriptor: { dFormat: "depth32float" as const, samples: 1 as const, size: { width: 800, height: 600 } as const },
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

    it("retires bound resources via DEFERRED retirement after task disposal (detached copy)", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const task = createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }] }, engine, scene);

        // Inject a bound entry exposing a geometry disposer (as the standard geometry
        // renderable would). If dispose passed the live `_bound` by reference and then
        // emptied it, the deferred callback would iterate nothing and this spy would
        // never fire.
        const disposeSpy = vi.fn();
        const mesh = { name: "geo-mesh" } as unknown as import("../../../packages/babylon-lite/src/mesh/mesh").Mesh;
        const internal = task as unknown as { _bound: Array<{ _mesh: unknown; _binding: { renderable: { _geometryDispose?: () => void } }; _view: unknown }> };
        internal._bound.push({ _mesh: mesh, _binding: { renderable: { _geometryDispose: disposeSpy } }, _view: {} });

        const eng = engine as unknown as { _retirements: Array<() => void> | null };
        eng._retirements = [];

        task.dispose();
        // Deferred — not run synchronously at dispose time.
        expect(disposeSpy).not.toHaveBeenCalled();
        expect(eng._retirements!.length).toBe(1);

        // Drain retirements (simulating the next submitted frame).
        eng._retirements!.forEach((r) => r());
        expect(disposeSpy).toHaveBeenCalledOnce();
    });

    // ── Cross-family retirement contract ────────────────────────────────────────
    // All three geometry families (Standard, PBR, Node) produce the SAME ownership
    // shape: an idempotent per-mesh `_geometryDispose` closure that is also the SAME
    // reference registered on `scene._meshAuxDisposables`, plus (Standard/Node) a view
    // exposing `_disposeGeometryResources`. `registerAux` below mirrors the inline aux
    // registration each family performs. These tests drive that shape through the task's
    // make-before-break retirement to prove: the per-mesh disposer is DETACHED from the
    // aux list synchronously (so re-records don't grow it), the GPU frees are DEFERRED
    // past the in-flight frame, and both the per-mesh and per-view disposers run exactly
    // once — with a material-swap-style aux drain making a second retirement a safe
    // no-op (idempotent, no double free).
    const registerAux = (scene: SceneContext, mesh: unknown, free: () => void): (() => void) => {
        let disposed = false;
        const dispose = (): void => {
            if (disposed) {
                return;
            }
            disposed = true;
            free();
        };
        const m = mesh as import("../../../packages/babylon-lite/src/mesh/mesh").Mesh;
        const list = scene._meshAuxDisposables.get(m) ?? [];
        list.push(dispose);
        scene._meshAuxDisposables.set(m, list);
        return dispose;
    };

    it("detaches the per-mesh aux disposer synchronously then defers the per-mesh + per-view frees, running each once", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;
        const task = createGeometryRendererTask({ textureDescriptions: [{ type: GeometryTextureType.VIEW_NORMAL }] }, engine, scene);

        const mesh = { name: "geo-mesh" } as unknown as import("../../../packages/babylon-lite/src/mesh/mesh").Mesh;
        const free = vi.fn();
        // The renderable's `_geometryDispose` IS the closure registered on the aux list.
        const dispose = registerAux(scene, mesh, free);
        expect(scene._meshAuxDisposables.get(mesh)).toEqual([dispose]);
        expect(scene._meshDisposables.has(mesh)).toBe(false);

        const viewDispose = vi.fn();
        const view = { _disposeGeometryResources: viewDispose };
        const internal = task as unknown as {
            _bound: Array<{ _mesh: unknown; _binding: { renderable: { _geometryDispose?: () => void } }; _view: unknown }>;
            _views: Map<string, unknown>;
        };
        internal._bound.push({ _mesh: mesh, _binding: { renderable: { _geometryDispose: dispose } }, _view: view });
        internal._views.set("k", view);

        const eng = engine as unknown as { _retirements: Array<() => void> | null };
        eng._retirements = [];

        task.dispose();
        // Aux disposer detached synchronously (outside any scene drain) so the list
        // neither grows across re-records nor keeps a dead reference.
        expect(scene._meshAuxDisposables.has(mesh)).toBe(false);
        // Both frees deferred — nothing run synchronously.
        expect(free).not.toHaveBeenCalled();
        expect(viewDispose).not.toHaveBeenCalled();
        expect(eng._retirements!.length).toBe(1);

        eng._retirements!.forEach((r) => r());
        expect(free).toHaveBeenCalledOnce();
        expect(viewDispose).toHaveBeenCalledOnce();

        // Idempotent: a subsequent aux drain (real scene-remove) is a safe no-op.
        dispose();
        expect(free).toHaveBeenCalledOnce();
    });

    it("cannot invalidate live geometry on a material swap: the disposer lives on _meshAuxDisposables, which swaps never drain", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContext;

        const mesh = { name: "swap-mesh" } as unknown as import("../../../packages/babylon-lite/src/mesh/mesh").Mesh;
        const free = vi.fn();
        registerAux(scene, mesh, free);

        // A MAIN-material swap drains + rebuilds ONLY `_meshDisposables` (never the aux
        // map). Simulate that drain: the geometry packet must survive so the live
        // geometry bind group's buffers are not destroyed under an in-flight pass.
        const mainList = scene._meshDisposables.get(mesh);
        for (const fn of mainList ?? []) {
            fn();
        }
        scene._meshDisposables.delete(mesh);

        expect(free).not.toHaveBeenCalled();
        expect(scene._meshAuxDisposables.get(mesh)).toHaveLength(1);
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
            meshes.push({
                material: createStandardMaterial(),
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
                _view: { source: unknown; _buildGroup: { _rebuildSingle?: () => unknown } };
                _binding: { renderable: { _geometryDispose?: () => void } };
            }>;
        };
        await internal._preload();
        internal.record();
        return { scene, internal, meshes, drawnIndexCounts, engine, createStandardMaterial };
    }

    const idxCount = (m: import("../../../packages/babylon-lite/src/mesh/mesh").Mesh): number => (m as unknown as { _gpu: { indexCount: number } })._gpu.indexCount;

    function simulateMeshRemoval(scene: SceneContext, task: { _removeMesh(mesh: object): void }, mesh: import("../../../packages/babylon-lite/src/mesh/mesh").Mesh): void {
        // Simulate removeFromScene: evict task-local bindings before draining the
        // mesh's AUX disposer, then drop it from the scene and bump the mutation version.
        task._removeMesh(mesh);
        const auxDisposers = scene._meshAuxDisposables.get(mesh) ?? [];
        expect(auxDisposers.length).toBeGreaterThan(0);
        for (const fn of auxDisposers) {
            fn();
        }
        scene._meshAuxDisposables.delete(mesh);
        scene.meshes.splice(scene.meshes.indexOf(mesh), 1);
        scene._renderableVersion++;
    }

    it("drops a removed mesh from _bound on the next execute so it is not drawn against destroyed resources", async () => {
        const { scene, internal, meshes, drawnIndexCounts } = await setupGeoTask(2);
        expect(internal._bound.map((b) => b._mesh)).toEqual(meshes);

        const removed = meshes[1]!;
        simulateMeshRemoval(scene, internal, removed);

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
        const oldDispose = internal._bound[0]!._binding.renderable._geometryDispose;
        expect(typeof oldDispose).toBe("function");

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
        // Draining the deferred retirement disposes the old binding exactly once (idempotent).
        retirements.forEach((r) => r());
        expect(() => oldDispose!()).not.toThrow();
    });

    it("keeps the previous bindings active when a replacement build fails", async () => {
        const { scene, internal, meshes, createStandardMaterial } = await setupGeoTask(1);
        const previousBound = internal._bound;
        const buildGroup = previousBound[0]!._view._buildGroup;
        const originalRebuild = buildGroup._rebuildSingle;
        buildGroup._rebuildSingle = () => {
            throw new Error("replacement build failed");
        };
        meshes[0]!.material = createStandardMaterial();
        scene._renderableVersion++;

        try {
            expect(() => internal.execute()).toThrow("replacement build failed");
            expect(internal._bound).toBe(previousBound);
        } finally {
            buildGroup._rebuildSingle = originalRebuild;
        }
    });
});
