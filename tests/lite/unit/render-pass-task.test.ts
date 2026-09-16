import { describe, it, expect, vi } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { DrawBinding, DrawUpdateBatch, DrawUpdateContext, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import { getUniformCopyBatch } from "../../../packages/babylon-lite/src/render/uniform-copy-batch";
import { createSceneContext, registerScene } from "../../../packages/babylon-lite/src/scene/scene";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { createRenderTarget, type RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { addMeshToTask, createRenderTask, removeMeshFromTask, type RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import { _removeMeshFromRenderTask, type RenderTaskBase } from "../../../packages/babylon-lite/src/frame-graph/render-task-base";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { rebuildTransferTarget, transferMeshBetweenTasks } from "../../../packages/babylon-lite/src/shadow/csm-shadow-cache";
import { enableRenderTaskTransmission, enableSceneTransmission } from "../../../packages/babylon-lite/src/frame-graph/transmission";
import { getComputeDispatchBatch } from "../../../packages/babylon-lite/src/mesh/thin-instance-gpu-culling";
import { enableDrawBatchCollection } from "../../../packages/babylon-lite/src/render/draw-update-batches";
import { invalidateRenderBundles } from "../../../packages/babylon-lite/src/mesh/mesh-factories";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage" | "GPUShaderStage" | "GPUTextureUsage"> & {
    GPUBufferUsage?: { UNIFORM: number; COPY_DST: number };
    GPUShaderStage?: { VERTEX: number; FRAGMENT: number };
    GPUTextureUsage?: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number; COPY_DST: number };
};

gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 } as unknown as GPUBufferUsage;
gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 } as unknown as GPUShaderStage;
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4, COPY_SRC: 0x1, COPY_DST: 0x2 } as unknown as GPUTextureUsage;

function makeIdentityMatrix(z = 0): Mat4 {
    const matrix = new Float32Array(16);
    matrix[0] = 1;
    matrix[5] = 1;
    matrix[10] = 1;
    matrix[12] = 0;
    matrix[13] = 0;
    matrix[14] = z;
    matrix[15] = 1;
    return matrix as unknown as Mat4;
}

function makeCamera(): Camera {
    return {
        fov: Math.PI / 4,
        nearPlane: 0.1,
        farPlane: 100,
        children: [],
        worldMatrix: makeIdentityMatrix(),
        worldMatrixVersion: 1,
        _viewCache: new Float32Array(16),
        _projCache: new Float32Array(16),
        _vpCache: new Float32Array(16),
    };
}

function makeMockEngine(options?: {
    msaaSamples?: 1 | 4;
    onBeginPass?: (descriptor: GPURenderPassDescriptor) => void;
    onCopy?: () => void;
    bindGroupLayouts?: GPUBindGroupLayoutDescriptor[];
    samplers?: GPUSamplerDescriptor[];
    textures?: GPUTextureDescriptor[];
    bundleDescriptors?: GPURenderBundleEncoderDescriptor[];
    computePasses?: {
        pipelines: GPUComputePipeline[];
        bindGroups: GPUBindGroup[];
        dispatches: [number, number | undefined, number | undefined][];
    }[];
    onWriteBuffer?: (buffer: GPUBuffer, offset: number, data: AllowSharedBufferSource, dataOffset?: number, size?: number) => void;
    bufferCopies?: [GPUBuffer, number, GPUBuffer, number, number][];
}): EngineContext {
    let currentPipeline: GPURenderPipeline | null = null;
    const pass = {
        setViewport: () => undefined,
        setScissorRect: () => undefined,
        setBindGroup: () => undefined,
        executeBundles: () => undefined,
        setPipeline: (pipeline: GPURenderPipeline) => {
            currentPipeline = pipeline;
        },
        draw: () => {
            if ((currentPipeline as { label?: string } | null)?.label === "transmission-copy") {
                options?.onCopy?.();
            }
        },
        end: () => undefined,
    } as unknown as GPURenderPassEncoder;
    const device = {
        createBindGroupLayout: (descriptor: GPUBindGroupLayoutDescriptor) => {
            options?.bindGroupLayouts?.push(descriptor);
            return descriptor as unknown as GPUBindGroupLayout;
        },
        createBuffer: (descriptor: GPUBufferDescriptor) => ({ descriptor, destroy: () => undefined }) as unknown as GPUBuffer,
        createBindGroup: (descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup,
        createSampler: (descriptor: GPUSamplerDescriptor) => {
            options?.samplers?.push(descriptor);
            return descriptor as unknown as GPUSampler;
        },
        createShaderModule: (descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule,
        createPipelineLayout: (descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout,
        createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline,
        createTexture: (descriptor: GPUTextureDescriptor) => {
            options?.textures?.push(descriptor);
            return {
                descriptor,
                format: descriptor.format,
                mipLevelCount: descriptor.mipLevelCount ?? 1,
                sampleCount: descriptor.sampleCount ?? 1,
                createView: () => ({}) as GPUTextureView,
                destroy: () => undefined,
            } as unknown as GPUTexture;
        },
        createRenderBundleEncoder: (descriptor: GPURenderBundleEncoderDescriptor) => {
            options?.bundleDescriptors?.push(descriptor);
            return {
                setBindGroup: () => undefined,
                setPipeline: () => undefined,
                finish: () => ({}) as GPURenderBundle,
            } as unknown as GPURenderBundleEncoder;
        },
        queue: {
            writeBuffer: (buffer: GPUBuffer, offset: number, data: AllowSharedBufferSource, dataOffset?: number, size?: number) =>
                options?.onWriteBuffer?.(buffer, offset, data, dataOffset, size),
        },
    } as unknown as GPUDevice;

    const eng = {
        canvas: { width: 800, height: 600 } as HTMLCanvasElement,
        msaaSamples: options?.msaaSamples ?? 4,
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
        _currentEncoder: {
            beginComputePass: () => {
                const record = {
                    pipelines: [] as GPUComputePipeline[],
                    bindGroups: [] as GPUBindGroup[],
                    dispatches: [] as [number, number | undefined, number | undefined][],
                };
                options?.computePasses?.push(record);
                return {
                    setPipeline: (pipeline: GPUComputePipeline) => record.pipelines.push(pipeline),
                    setBindGroup: (_index: number, bindGroup: GPUBindGroup) => record.bindGroups.push(bindGroup),
                    dispatchWorkgroups: (x: number, y?: number, z?: number) => record.dispatches.push([x, y, z]),
                    end: () => undefined,
                } as unknown as GPUComputePassEncoder;
            },
            beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
                options?.onBeginPass?.(descriptor);
                return pass;
            },
            copyBufferToBuffer: (source: GPUBuffer, sourceOffset: number, destination: GPUBuffer, destinationOffset: number, size: number) =>
                options?.bufferCopies?.push([source, sourceOffset, destination, destinationOffset, size]),
            copyTextureToTexture: () => options?.onCopy?.(),
        } as unknown as GPUCommandEncoder,
        scRT: {
            _colorTexture: {},
            _colorView: {},
            _depthTexture: null,
            _depthView: null,
            _descriptor: { format: "bgra8unorm", samples: 1, size: { width: 800, height: 600 } },
            _width: 800,
            _height: 600,
            _eager: true,
        } as unknown as RenderTarget,
        _currentDelta: 0,
        _cbs: [],
    } as unknown as EngineContext;
    const _surfaces = [eng];
    Object.assign(eng, { engine: eng, surfaces: _surfaces, _surfaces });
    return eng;
}

function makeComputeRenderable(id: string, pipeline: GPUComputePipeline, bindGroup: GPUBindGroup, workgroupsX: number): Renderable {
    const renderable: Renderable = {
        order: 100,
        isTransparent: false,
        bind(_engine, signature): DrawBinding {
            const batch = getComputeDispatchBatch(signature);
            return {
                renderable,
                pipeline: { id } as unknown as GPURenderPipeline,
                _updateBatches: [batch],
                update(): void {
                    batch.queue({ pipeline, bindGroup, workgroupsX });
                },
                draw(): number {
                    return 1;
                },
            };
        },
    };
    return renderable;
}

function makeUniformCopyRenderable(id: string, buffer: GPUBuffer, data: Float32Array): Renderable {
    const renderable: Renderable = {
        order: 100,
        isTransparent: false,
        bind(_engine, signature): DrawBinding {
            const batch = getUniformCopyBatch(signature);
            return {
                renderable,
                pipeline: { id } as unknown as GPURenderPipeline,
                _updateBatches: [batch],
                update(): void {
                    batch.queue(buffer, data);
                },
                draw(): number {
                    return 1;
                },
            };
        },
    };
    return renderable;
}

function makeTransparentRenderable(id: string, initialCenter: [number, number, number], updatedCenter: [number, number, number], drawOrder: string[]): Renderable {
    const renderable: Renderable = {
        order: 200,
        isTransparent: true,
        _worldCenter: initialCenter,
        bind(): DrawBinding {
            return {
                renderable,
                pipeline: { id } as unknown as GPURenderPipeline,
                update(_context: DrawUpdateContext): void {
                    renderable._worldCenter = updatedCenter;
                },
                draw(): number {
                    drawOrder.push(id);
                    return 1;
                },
            };
        },
    };
    return renderable;
}

function makeDrawOrderRenderable(id: string, flags: Partial<Pick<Renderable, "order" | "isTransparent" | "_transmissive" | "_direct">>, drawOrder: string[]): Renderable {
    const renderable: Renderable = {
        order: flags.order ?? 100,
        isTransparent: flags.isTransparent ?? false,
        _transmissive: flags._transmissive ?? false,
        _direct: flags._direct ?? false,
        bind(): DrawBinding {
            return {
                renderable,
                pipeline: { id } as unknown as GPURenderPipeline,
                draw(): number {
                    drawOrder.push(id);
                    return 1;
                },
            };
        },
    };
    return renderable;
}

describe("RenderPassTask transparent sorting", () => {
    it("keeps automatic scene rendering independent of explicit mesh ownership", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const task = scene._frameGraph._tasks[0] as RenderTaskBase;
        expect("addMesh" in task).toBe(false);
        expect("_pendingMeshes" in task).toBe(false);
        expect("_prepareRenderables" in task).toBe(false);
        scene._renderables.push(makeDrawOrderRenderable("first", {}, []));
        task.record();
        expect(task.execute!()).toBe(1);
        scene._renderables.push(makeDrawOrderRenderable("second", {}, []));
        scene._renderableVersion++;
        expect(task.execute!()).toBe(2);
        task.dispose();
        disposeGpuResourceRetirements(engine);
    });

    it("does not mark scene mutations during binding as already synchronized", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const task = scene._frameGraph._tasks[0] as RenderTaskBase;
        const first = makeDrawOrderRenderable("first", {}, []);
        const second = makeDrawOrderRenderable("second", {}, []);
        const bindFirst = first.bind.bind(first);
        let changed = false;
        first.bind = (eng, signature) => {
            const binding = bindFirst(eng, signature);
            if (!changed) {
                changed = true;
                scene._renderables.push(second);
                scene._renderableVersion++;
            }
            return binding;
        };
        scene._renderables.push(first);
        const sourceVersion = scene._renderableVersion;

        task.record();

        expect(task._renderables).toEqual([first]);
        expect(task._lastVersion).toBe(sourceVersion);
        expect(task.execute!()).toBe(2);
        expect(task._renderables).toEqual([first, second]);
        task.dispose();
        disposeGpuResourceRetirements(engine);
    });

    it.each([false, true])("preserves source versions when the scene mutates during automatic rebinding (transmission: %s)", (transmission) => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const task = scene._frameGraph._tasks[0] as RenderTask;
        const first = makeDrawOrderRenderable("first", {}, []);
        const second = makeDrawOrderRenderable("second", {}, []);
        scene._renderables.push(first);
        if (transmission) {
            enableRenderTaskTransmission(task, engine, { linear: false, generateMipmaps: false });
        }
        task.record();
        expect(task.execute!()).toBe(1);
        const bindFirst = first.bind.bind(first);
        let changed = false;
        first.bind = (eng, signature) => {
            const binding = bindFirst(eng, signature);
            if (!changed) {
                changed = true;
                scene._renderables.push(second);
                scene._renderableVersion++;
            }
            return binding;
        };
        const sourceVersion = ++scene._renderableVersion;

        expect(task.execute!()).toBe(1);
        expect(task._lastVersion).toBe(sourceVersion);
        expect(task.execute!()).toBe(2);
        expect(task._renderables).toEqual([first, second]);
        task.dispose();
        disposeGpuResourceRetirements(engine);
    });

    it.each([false, true])("reuses explicit-task bundles across unrelated scene versions (transmission: %s)", (transmission) => {
        const bundleDescriptors: GPURenderBundleEncoderDescriptor[] = [];
        const engine = makeMockEngine({ bundleDescriptors });
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const rt = createRenderTarget({ format: "rgba8unorm", dFormat: "depth24plus-stencil8", samples: 4, size: { width: 32, height: 32 } });
        const task = createRenderTask({ name: "explicit", rt, autoMirror: false }, engine, scene);
        task._renderables.push(makeDrawOrderRenderable("first", {}, []));
        if (transmission) {
            enableRenderTaskTransmission(task, engine, { linear: false, generateMipmaps: false });
        }
        task.record();
        task.execute!();
        const bundles = bundleDescriptors.length;
        scene._renderableVersion++;

        task.execute!();
        expect(bundleDescriptors).toHaveLength(bundles);
        invalidateRenderBundles(engine);
        task.execute!();
        expect(bundleDescriptors).toHaveLength(bundles + 1);
        task.dispose();
        disposeGpuResourceRetirements(engine);
    });

    it("refreshes scene bind groups without invalidating unchanged material bindings", () => {
        const bundleDescriptors: GPURenderBundleEncoderDescriptor[] = [];
        const engine = makeMockEngine({ bundleDescriptors });
        const scene = createSceneContext(engine);
        const task = scene._frameGraph._tasks[0] as RenderTask;
        const renderable = makeDrawOrderRenderable("first", {}, []);
        const bind = vi.spyOn(renderable, "bind");
        scene._renderables.push(renderable);
        task.record();
        task.execute!();
        const previousSceneGroup = task._sceneBG;
        scene._lightGpuState!._buffer = engine._device.createBuffer({ size: scene._lightGpuState!._byteSize, usage: GPUBufferUsage.UNIFORM });

        task.execute!();
        expect(task._sceneBG).not.toBe(previousSceneGroup);
        task.execute!();
        expect(bind).toHaveBeenCalledOnce();
        expect(bundleDescriptors).toHaveLength(2);
        task.dispose();
        disposeGpuResourceRetirements(engine);
    });

    it("preserves automatic draw buckets and live batches after a failed scene rebind", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const task = scene._frameGraph._tasks[0] as RenderTaskBase;
        const currentBatch = { reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() };
        const candidates: DrawUpdateBatch[] = [];
        let fail = true;
        const make = (batch: () => DrawUpdateBatch | undefined): Renderable => {
            const renderable: Renderable = {
                order: 0,
                isTransparent: false,
                bind: (_engine, signature) => {
                    enableDrawBatchCollection(signature);
                    const value = batch();
                    return { renderable, pipeline: {} as GPURenderPipeline, draw: () => 1, _updateBatches: value ? [value] : undefined };
                },
            };
            return renderable;
        };
        scene._renderables.push(make(() => currentBatch));
        task.record();
        const renderables = task._renderables;
        const bindings = task._opaqueBindings;
        const batches = task._batchState;
        const version = task._lastVersion;
        scene._renderables.push(
            make(() => {
                const batch = { reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() };
                candidates.push(batch);
                return batch;
            }),
            make(() => {
                if (fail) {
                    throw new Error("automatic binding failed");
                }
                return undefined;
            })
        );
        scene._renderableVersion++;
        expect(() => task.execute!()).toThrow("automatic binding failed");
        expect(task._renderables).toBe(renderables);
        expect(task._opaqueBindings).toBe(bindings);
        expect(task._batchState).toBe(batches);
        expect(task._lastVersion).toBe(version);
        expect(currentBatch.destroy).not.toHaveBeenCalled();
        expect(candidates[0]!.destroy).toHaveBeenCalledOnce();
        fail = false;
        expect(task.execute!()).toBe(3);
        expect(task._renderables).not.toBe(renderables);
        expect(candidates[1]!.destroy).not.toHaveBeenCalled();
        task.dispose();
        disposeGpuResourceRetirements(engine);
        expect(currentBatch.destroy).toHaveBeenCalledOnce();
        expect(candidates[1]!.destroy).toHaveBeenCalledOnce();
    });

    it("removes borrowed meshes from automatic passes without claiming scene lifetimes", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const task = scene._frameGraph._tasks[0] as RenderTaskBase;
        const mesh = {} as Mesh;
        const release = vi.fn();
        const renderable: Renderable = {
            mesh,
            order: 0,
            isTransparent: false,
            bind: () => ({ renderable, pipeline: {} as GPURenderPipeline, draw: () => 1 }),
        };
        scene._meshDisposables.set(mesh, [release]);
        scene._renderables.push(renderable);
        task.record();
        _removeMeshFromRenderTask(task, mesh);
        expect(task._renderables).toHaveLength(0);
        expect(task._opaqueBindings).toHaveLength(0);
        task.dispose();
        disposeGpuResourceRetirements(engine);
        expect(release).not.toHaveBeenCalled();
        expect(scene._meshDisposables.get(mesh)).toEqual([release]);
    });

    it("drops a mesh removed before first record from pending task inputs", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const rt = createRenderTarget({
            lbl: "pending-removal",
            dFormat: "depth24plus",
            samples: 1,
            size: { width: 16, height: 16 },
        });
        const task = createRenderTask({ name: "pending-removal", rt }, engine, scene);
        const mesh = {} as Mesh;
        const rebuildSingle = vi.fn(() => makeDrawOrderRenderable("removed", {}, []));
        const material = {
            _buildGroup: { _rebuildSingle: rebuildSingle },
        } as unknown as Material;

        addMeshToTask(task, mesh, { material });
        removeMeshFromTask(task, mesh);
        task.record();

        expect(rebuildSingle).not.toHaveBeenCalled();
        expect(task._pendingMeshes).toHaveLength(0);
        expect(task._renderables).toHaveLength(0);
    });

    it.each([false, true])("retains pending meshes until their scene-local group is ready (standalone: %s)", (standalone) => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const foreignScene = createSceneContext(makeMockEngine(), { defaultRenderTask: false });
        const rt = createRenderTarget({ lbl: "pending-group", samples: 1, size: { width: 16, height: 16 } });
        const task = createRenderTask({ name: "pending-group", rt, autoMirror: false }, engine, scene);
        const mesh = {} as Mesh;
        const foreign = vi.fn(() => makeDrawOrderRenderable("foreign", {}, []));
        const material = { _buildGroup: { _rebuildSingle: foreign, _sceneIndependentRebuild: standalone } } as unknown as Material;
        foreignScene._groups.set(material._buildGroup, Object.assign([], { r: foreign }));
        const localGroup = [mesh];
        scene._groups.set(material._buildGroup, localGroup);
        addMeshToTask(task, mesh, { material });
        expect(() => task.record()).toThrow(/initial build in this scene/);
        expect(foreign).not.toHaveBeenCalled();
        expect(task._pendingMeshes).toHaveLength(1);
        expect(task._renderables).toHaveLength(0);
        const renderable = makeDrawOrderRenderable("local", {}, []);
        const local = vi.fn(() => renderable);
        scene._groups.get(material._buildGroup)!.r = local;
        task.record();
        expect(local).toHaveBeenCalledWith(scene, mesh, material, expect.objectContaining({ _lifetimeDisposers: expect.any(Array) }));
        expect(task._pendingMeshes).toHaveLength(0);
        expect(task._renderables).toEqual([renderable]);
        task.dispose();
    });

    it("uses an explicitly scene-independent override builder without a scene group", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const rt = createRenderTarget({
            lbl: "material-override",
            dFormat: "depth24plus",
            samples: 1,
            size: { width: 16, height: 16 },
        });
        const task = createRenderTask({ name: "material-override", rt }, engine, scene);
        const mesh = {} as Mesh;
        const renderable = makeDrawOrderRenderable("override", {}, []);
        const rebuildSingle = vi.fn(() => renderable);
        const material = {
            _buildGroup: { _rebuildSingle: rebuildSingle, _sceneIndependentRebuild: true },
        } as unknown as Material;

        addMeshToTask(task, mesh, { material });
        task.record();

        expect(rebuildSingle).toHaveBeenCalledWith(scene, mesh, material, expect.objectContaining({ _lifetimeDisposers: expect.any(Array) }));
        expect(task._renderables).toEqual([renderable]);
    });

    it.each([
        [false, false],
        [false, true],
        [true, false],
        [true, true],
    ])("preserves transmission recording across mesh population (transmission first: %s, live task: %s)", (transmissionFirst, live) => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const rt = createRenderTarget({ format: "bgra8unorm", samples: 1, size: { width: 16, height: 16 } });
        const task = createRenderTask({ name: "transmission-population", rt, autoMirror: false }, engine, scene);
        const renderable = makeDrawOrderRenderable("override", {}, []);
        const material = {
            _buildGroup: { _rebuildSingle: () => renderable, _sceneIndependentRebuild: true },
        } as unknown as Material;
        const options = { linear: false, generateMipmaps: false };
        let grab = transmissionFirst ? enableRenderTaskTransmission(task, engine, options) : undefined;
        if (live) {
            task.record();
        }
        addMeshToTask(task, {} as Mesh, { material });
        grab ??= enableRenderTaskTransmission(task, engine, options);
        task.record();
        const texture = grab.texture;
        expect(texture).not.toBeNull();
        task.record();
        expect(grab.texture).not.toBe(texture);
        expect(task._renderables).toEqual([renderable]);
        task.dispose();
        disposeGpuResourceRetirements(engine);
    });

    it("transfers a resolved mesh between live tasks without rebuilding its renderable", () => {
        const draws: string[] = [];
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        scene.camera = makeCamera();
        const from = createRenderTask(
            { name: "transfer-from", rt: createRenderTarget({ lbl: "from", dFormat: "depth24plus", samples: 1, size: { width: 16, height: 16 } }), autoMirror: false },
            engine,
            scene
        );
        const to = createRenderTask(
            { name: "transfer-to", rt: createRenderTarget({ lbl: "to", dFormat: "depth24plus", samples: 1, size: { width: 16, height: 16 } }), autoMirror: false },
            engine,
            scene
        );
        const mesh = {} as Mesh;
        const renderable: Renderable = {
            order: 100,
            isTransparent: false,
            mesh,
            bind(): DrawBinding {
                return {
                    renderable,
                    pipeline: { id: "caster" } as unknown as GPURenderPipeline,
                    draw(): number {
                        draws.push("caster");
                        return 1;
                    },
                };
            },
        };
        const rebuildSingle = vi.fn(() => renderable);
        const material = { _buildGroup: { _rebuildSingle: rebuildSingle, _sceneIndependentRebuild: true } } as unknown as Material;

        addMeshToTask(from, mesh, { material });
        from.record();
        to.record();
        draws.length = 0;
        transferMeshBetweenTasks(from, to, mesh);

        expect(rebuildSingle).toHaveBeenCalledOnce();
        expect(from._renderables).toEqual([]);
        expect(to._renderables).toEqual([renderable]);
        from.execute?.();
        expect(draws).toEqual([]);
        expect(to.execute?.()).toBe(1);
        expect(draws).toEqual(["caster"]);
    });

    it("batches destination rebuilds when a pending set is supplied", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        scene.camera = makeCamera();
        const makeTask = (name: string): RenderTask =>
            createRenderTask(
                { name, rt: createRenderTarget({ lbl: name, dFormat: "depth24plus", samples: 1, size: { width: 16, height: 16 } }), autoMirror: false },
                engine,
                scene
            );
        const from = makeTask("batch-from");
        const to = makeTask("batch-to");

        const binds: number[] = [];
        const makeRenderable = (id: number): Renderable => {
            const r: Renderable = {
                order: 100,
                isTransparent: false,
                mesh: {} as Mesh,
                bind(): DrawBinding {
                    binds.push(id);
                    return { renderable: r, pipeline: {} as unknown as GPURenderPipeline, draw: () => 1 };
                },
            };
            return r;
        };
        const renderables = [makeRenderable(0), makeRenderable(1), makeRenderable(2)];
        for (const r of renderables) {
            const material = { _buildGroup: { _rebuildSingle: () => r, _sceneIndependentRebuild: true } } as unknown as Material;
            addMeshToTask(from, r.mesh!, { material });
        }
        from.record();
        to.record();

        // Eager (no pending set): every move re-binds the whole destination -> 1 + 2 + 3 binds.
        binds.length = 0;
        for (const r of renderables) {
            transferMeshBetweenTasks(from, to, r.mesh!);
        }
        expect(binds.length).toBe(6);
        expect(to._renderables).toEqual(renderables);

        // Batched: the destination is rebuilt once for the whole burst.
        for (const r of renderables) {
            transferMeshBetweenTasks(to, from, r.mesh!);
        }
        binds.length = 0;
        const pending = new Set<RenderTask>();
        for (const r of renderables) {
            transferMeshBetweenTasks(from, to, r.mesh!, pending);
        }
        expect(binds.length).toBe(0);
        expect(pending.size).toBe(1);
        for (const task of pending) {
            rebuildTransferTarget(task);
        }
        expect(binds.length).toBe(3);
        expect(to._renderables).toEqual(renderables);
    });

    it("re-records a cached bundle invalidated before scene registration", () => {
        const bundleDescriptors: GPURenderBundleEncoderDescriptor[] = [];
        const engine = makeMockEngine({ bundleDescriptors });
        const scene = createSceneContext(engine);
        scene.camera = makeCamera();
        scene._renderables.push(makeDrawOrderRenderable("opaque", { order: 100 }, []));
        const task = scene._frameGraph._tasks[0] as RenderTask;

        task.record();
        task.execute?.();
        expect(bundleDescriptors).toHaveLength(1);
        expect(engine._renderingContexts).toHaveLength(0);

        invalidateRenderBundles(engine);
        task.execute?.();

        expect(bundleDescriptors).toHaveLength(2);
    });

    it("flushes binding compute work through one compute pass per render task", async () => {
        const computePasses: NonNullable<Parameters<typeof makeMockEngine>[0]>["computePasses"] = [];
        const engine = makeMockEngine({ computePasses });
        const scene = createSceneContext(engine);
        scene.camera = makeCamera();
        const pipeline = { label: "thin-instance-cull" } as unknown as GPUComputePipeline;
        const bindGroupA = { label: "a" } as unknown as GPUBindGroup;
        const bindGroupB = { label: "b" } as unknown as GPUBindGroup;
        scene._renderables.push(makeComputeRenderable("a", pipeline, bindGroupA, 2), makeComputeRenderable("b", pipeline, bindGroupB, 5));

        await registerScene(scene);
        scene._record();

        expect(computePasses).toHaveLength(1);
        expect(computePasses![0]!.pipelines).toEqual([pipeline]);
        expect(computePasses![0]!.bindGroups).toEqual([bindGroupA, bindGroupB]);
        expect(computePasses![0]!.dispatches).toEqual([
            [2, undefined, undefined],
            [5, undefined, undefined],
        ]);
    });

    it("packs binding uniform updates into one task-local queue upload", async () => {
        const writes: [GPUBuffer, number, AllowSharedBufferSource, number | undefined, number | undefined][] = [];
        const copies: [GPUBuffer, number, GPUBuffer, number, number][] = [];
        const engine = makeMockEngine({
            onWriteBuffer: (buffer, offset, data, dataOffset, size) => writes.push([buffer, offset, data, dataOffset, size]),
            bufferCopies: copies,
        });
        const scene = createSceneContext(engine);
        scene.camera = makeCamera();
        const destinationA = { label: "a" } as unknown as GPUBuffer;
        const destinationB = { label: "b" } as unknown as GPUBuffer;
        scene._renderables.push(
            makeUniformCopyRenderable("a", destinationA, new Float32Array([1, 2, 3, 4])),
            makeUniformCopyRenderable("b", destinationB, new Float32Array([5, 6, 7, 8, 9, 10, 11, 12]))
        );

        await registerScene(scene);
        writes.length = 0;
        scene._record();

        const uploadWrites = writes.filter(([buffer]) => (buffer as unknown as { descriptor?: GPUBufferDescriptor }).descriptor?.label === "render-task-uniform-upload");
        expect(uploadWrites).toHaveLength(1);
        expect(uploadWrites[0]![4]).toBe(48);
        expect(copies).toHaveLength(2);
        expect(copies.map((copy) => [copy[1], copy[2], copy[4]])).toEqual([
            [0, destinationA, 16],
            [16, destinationB, 32],
        ]);
        expect(copies[0]![0]).toBe(copies[1]![0]);
    });

    it("preserves custom depth compare when transmission retargets a render task", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const rt = createRenderTarget({
            format: "bgra8unorm",
            dFormat: "depth32float",
            depthCompare: "less-equal",
            samples: 1,
            size: { width: 16, height: 16 },
        });
        const task = createRenderTask({ name: "standard-z-offscreen", rt }, engine, scene);

        enableRenderTaskTransmission(task, engine);

        expect(task._targetSignature._depthCompare).toBe("less-equal");
    });

    it("preserves an external depth target compare when transmission retargets a render task", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const color = createRenderTarget({
            format: "bgra8unorm",
            samples: 1,
            size: { width: 16, height: 16 },
        });
        const depth = createRenderTarget({
            dFormat: "depth32float",
            depthClearValue: 1,
            depthCompare: "less-equal",
            samples: 1,
            size: { width: 16, height: 16 },
        });
        const task = createRenderTask({ name: "standard-z-external-depth", rt: color, depth }, engine, scene);

        enableRenderTaskTransmission(task, engine);

        expect(task._targetSignature._depthCompare).toBe("less-equal");
    });

    it("preserves scaled surface sizing when transmission retargets a render task", () => {
        const engine = makeMockEngine({ msaaSamples: 1 });
        const scene = createSceneContext(engine);
        const size = { surface: engine, scale: 0.5 } as const;
        const color = createRenderTarget({ format: "bgra8unorm", samples: 1, size });
        const depth = createRenderTarget({ dFormat: "depth32float", samples: 1, size });
        const task = createRenderTask({ name: "scaled-transmission", rt: color, depth }, engine, scene);

        enableRenderTaskTransmission(task, engine);
        task.record();

        expect(task._config.rt._descriptor.size).toBe(size);
        expect(task._config.rt._width).toBe(400);
        expect(task._config.rt._height).toBe(300);
        expect(depth._width).toBe(400);
        expect(depth._height).toBe(300);
    });

    it("synchronizes sampled eager targets borrowed by a render task", () => {
        const engine = makeMockEngine({ msaaSamples: 1 });
        const scene = createSceneContext(engine);
        const color = createRenderTarget({ format: "rgba8unorm", samples: 1, size: { width: 16, height: 16 } });
        color._eager = true;
        color._colorTexture = engine._device.createTexture({
            size: { width: 16, height: 16 },
            format: "rgba8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        color._colorView = color._colorTexture.createView();
        color._syncEager = vi.fn();
        const depth = createRenderTarget({ dFormat: "depth32float", samples: 1, size: { width: 16, height: 16 } });
        depth._eager = true;
        depth._depthTexture = engine._device.createTexture({
            size: { width: 16, height: 16 },
            format: "depth32float",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        depth._depthView = depth._depthTexture.createView();
        depth._syncEager = vi.fn();
        const task = createRenderTask({ name: "borrowed-eager", rt: color, depth, sharedRt: true }, engine, scene);

        task.record();

        expect(color._syncEager).toHaveBeenCalledWith(engine);
        expect(depth._syncEager).toHaveBeenCalledWith(engine);
    });

    it("uses world centers refreshed by binding updates before sorting transparent draws", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        scene.camera = makeCamera();
        const drawOrder: string[] = [];

        scene._renderables.push(
            makeTransparentRenderable("far-after-update", [0, 0, 1], [0, 0, 10], drawOrder),
            makeTransparentRenderable("near-after-update", [0, 0, 2], [0, 0, 2], drawOrder)
        );

        await registerScene(scene);
        scene._record();

        expect(drawOrder).toEqual(["far-after-update", "near-after-update"]);
    });

    it("sorts transparent draws by camera-space depth instead of radial distance", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        scene.camera = makeCamera();
        const drawOrder: string[] = [];

        scene._renderables.push(
            makeTransparentRenderable("far-in-view", [0, 0, 0], [0, 0, 10], drawOrder),
            makeTransparentRenderable("near-but-wide", [0, 0, 0], [100, 0, 2], drawOrder)
        );

        await registerScene(scene);
        scene._record();

        expect(drawOrder).toEqual(["far-in-view", "near-but-wide"]);
    });

    it("direct-draws dynamic depth-write renderables without marking them transmissive", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        scene.camera = makeCamera();
        const drawOrder: string[] = [];

        scene._renderables.push(
            makeDrawOrderRenderable("opaque", { order: 100 }, drawOrder),
            makeDrawOrderRenderable("dynamic-depth-write", { order: 110, _direct: true }, drawOrder),
            makeDrawOrderRenderable("transmissive", { order: 140, _transmissive: true, _direct: true }, drawOrder),
            makeDrawOrderRenderable("transparent", { order: 200, isTransparent: true }, drawOrder)
        );

        await registerScene(scene);
        scene._record();

        expect(drawOrder).toEqual(["opaque", "dynamic-depth-write", "transmissive", "transparent"]);
    });

    it("updates per-task transmission snapshots according to copy count", async () => {
        let defaultCopies = 0;
        const defaultEngine = makeMockEngine({ msaaSamples: 1, onCopy: () => defaultCopies++ });
        const defaultScene = createSceneContext(defaultEngine);
        defaultScene.camera = makeCamera();
        const defaultOrder: string[] = [];
        defaultScene._renderables.push(
            makeDrawOrderRenderable("opaque", { order: 100 }, defaultOrder),
            makeDrawOrderRenderable("glass-a", { order: 150, _transmissive: true }, defaultOrder),
            makeDrawOrderRenderable("glass-b", { order: 150, _transmissive: true }, defaultOrder)
        );
        enableSceneTransmission(defaultScene, defaultEngine);
        await registerScene(defaultScene);
        defaultScene._record();
        expect(defaultCopies).toBe(1);

        let everyCopies = 0;
        const everyEngine = makeMockEngine({ msaaSamples: 1, onCopy: () => everyCopies++ });
        const everyScene = createSceneContext(everyEngine);
        everyScene.camera = makeCamera();
        const everyOrder: string[] = [];
        (everyScene._frameGraph._tasks[0]! as RenderTask)._config.transmission = { copyCount: 0 };
        everyScene._renderables.push(
            makeDrawOrderRenderable("opaque", { order: 100 }, everyOrder),
            makeDrawOrderRenderable("glass-a", { order: 150, _transmissive: true }, everyOrder),
            makeDrawOrderRenderable("glass-b", { order: 150, _transmissive: true }, everyOrder)
        );
        enableSceneTransmission(everyScene, everyEngine);
        await registerScene(everyScene);
        everyScene._record();
        expect(everyCopies).toBe(2);
    });

    it("uses a repeat anisotropic sampler for the transmission refraction texture", async () => {
        const samplers: GPUSamplerDescriptor[] = [];
        const engine = makeMockEngine({ samplers });
        const scene = createSceneContext(engine);
        scene.camera = makeCamera();
        scene._renderables.push(makeDrawOrderRenderable("transmissive", { isTransparent: true, _transmissive: true }, []));

        enableSceneTransmission(scene, engine);
        await registerScene(scene);

        expect(samplers).toContainEqual({
            magFilter: "linear",
            minFilter: "linear",
            mipmapFilter: "linear",
            addressModeU: "repeat",
            addressModeV: "repeat",
            addressModeW: "repeat",
            maxAnisotropy: 4,
        });
    });

    it("allocates only refraction mips reachable by the shader LOD bias", async () => {
        const textures: GPUTextureDescriptor[] = [];
        const engine = makeMockEngine({ textures });
        const scene = createSceneContext(engine);
        scene.camera = makeCamera();
        scene._renderables.push(makeDrawOrderRenderable("glass", { _transmissive: true }, []));

        enableSceneTransmission(scene, engine);
        await registerScene(scene);

        const refractionTexture = textures.find(
            (descriptor) => descriptor.format === "rgba16float" && (descriptor.size as GPUExtent3DDict).width === 1024 && (descriptor.usage & GPUTextureUsage.COPY_DST) !== 0
        );
        expect(refractionTexture?.mipLevelCount).toBe(7);
    });

    it("allocates only mip 0 for transmission when mipmap generation is disabled", async () => {
        const textures: GPUTextureDescriptor[] = [];
        const engine = makeMockEngine({ textures });
        const scene = createSceneContext(engine);
        scene.camera = makeCamera();
        (scene._frameGraph._tasks[0]! as RenderTask)._config.transmission = { generateMipmaps: false };
        scene._renderables.push(makeDrawOrderRenderable("glass", { _transmissive: true }, []));

        enableSceneTransmission(scene, engine);
        await registerScene(scene);

        const refractionTexture = textures.find(
            (descriptor) => descriptor.format === "rgba16float" && (descriptor.size as GPUExtent3DDict).width === 1024 && (descriptor.usage & GPUTextureUsage.COPY_DST) !== 0
        );
        expect(refractionTexture?.mipLevelCount).toBe(1);
    });

    it("samples the MSAA color texture directly for transmission copies and image processing", async () => {
        const textures: GPUTextureDescriptor[] = [];
        const bindGroupLayouts: GPUBindGroupLayoutDescriptor[] = [];
        const mainPassResolveTargets: boolean[] = [];
        const engine = makeMockEngine({
            msaaSamples: 4,
            bindGroupLayouts,
            textures,
            onBeginPass: (descriptor) => {
                if (descriptor.depthStencilAttachment) {
                    mainPassResolveTargets.push(!!((descriptor.colorAttachments as GPURenderPassColorAttachment[])[0] as GPURenderPassColorAttachment).resolveTarget);
                }
            },
        });
        const scene = createSceneContext(engine);
        scene.camera = makeCamera();
        scene._renderables.push(makeDrawOrderRenderable("opaque", { order: 100 }, []), makeDrawOrderRenderable("glass", { order: 150, _transmissive: true }, []));

        enableSceneTransmission(scene, engine);
        await registerScene(scene);
        scene._record();

        expect(textures.some((descriptor) => String(descriptor.label).includes("transmission-snapshot"))).toBe(false);
        expect(textures.some((descriptor) => String(descriptor.label).includes("transmission-scene"))).toBe(false);
        expect(mainPassResolveTargets).toEqual([false, false]);
        expect(bindGroupLayouts).toContainEqual({
            entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", multisampled: true } }],
        });
        expect(bindGroupLayouts).toContainEqual({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", multisampled: true } },
            ],
        });
    });

    it("renders remaining transmissive draws in one pass after the transmission copy cap", async () => {
        let passCount = 0;
        const engine = makeMockEngine({
            msaaSamples: 1,
            onBeginPass: (descriptor) => {
                if (descriptor.depthStencilAttachment) {
                    passCount++;
                }
            },
        });
        const scene = createSceneContext(engine);
        scene.camera = makeCamera();
        const drawOrder: string[] = [];
        scene._renderables.push(
            makeDrawOrderRenderable("opaque", { order: 100 }, drawOrder),
            makeDrawOrderRenderable("glass-a", { order: 150, _transmissive: true }, drawOrder),
            makeDrawOrderRenderable("glass-b", { order: 150, _transmissive: true }, drawOrder),
            makeDrawOrderRenderable("glass-c", { order: 150, _transmissive: true }, drawOrder)
        );

        enableSceneTransmission(scene, engine);
        await registerScene(scene);
        scene._record();

        expect(drawOrder).toEqual(["opaque", "glass-a", "glass-b", "glass-c"]);
        expect(passCount).toBe(2);
    });

    it("renders the default single-sample scene task into the engine scRT", async () => {
        // Regression: the single-sample default scene task targets the colour-only engine
        // scRT directly (with a standalone depth buffer). Its colorAttachments
        // array must be non-empty and its `view` must be the scRT's per-frame
        // color view (re-read at execute), with no `resolveTarget` (single-sample).
        const seenDescriptors: GPURenderPassDescriptor[] = [];
        const engine = makeMockEngine({
            msaaSamples: 1,
            onBeginPass: (descriptor) => {
                seenDescriptors.push(descriptor);
            },
        });
        const scene = createSceneContext(engine) as SceneContext;
        scene.camera = makeCamera();
        await registerScene(scene);
        scene._record();

        expect(seenDescriptors.length).toBeGreaterThan(0);
        const swapDescriptor = seenDescriptors[seenDescriptors.length - 1]!;
        const colorAttachments = swapDescriptor.colorAttachments as readonly GPURenderPassColorAttachment[];
        expect(colorAttachments.length).toBe(1);
        expect(colorAttachments[0]).toBeTruthy();
        expect(colorAttachments[0]!.view).toBe(engine.scRT._colorView);
        expect(colorAttachments[0]!.resolveTarget).toBeUndefined();
    });

    it("refreshes the default task from an auxiliary surface scRT every frame", async () => {
        const seenDescriptors: GPURenderPassDescriptor[] = [];
        const engine = makeMockEngine({
            msaaSamples: 1,
            onBeginPass: (descriptor) => {
                seenDescriptors.push(descriptor);
            },
        });
        const initialView = {} as GPUTextureView;
        const currentView = {} as GPUTextureView;
        const surface = {
            engine,
            canvas: { width: 320, height: 240 },
            msaaSamples: 1,
            format: engine.format,
            scRT: {
                _colorTexture: {},
                _colorView: initialView,
                _depthTexture: null,
                _depthView: null,
                _descriptor: { format: engine.format, samples: 1, size: { width: 320, height: 240 } },
                _width: 320,
                _height: 240,
                _eager: true,
            } as unknown as RenderTarget,
            _renderingContexts: [],
        } as unknown as SurfaceContext;
        const scene = createSceneContext(surface);
        await registerScene(scene);
        surface.scRT._colorView = currentView;

        scene._record();

        const swapDescriptor = seenDescriptors[seenDescriptors.length - 1]!;
        const colorAttachments = swapDescriptor.colorAttachments as readonly GPURenderPassColorAttachment[];
        expect(colorAttachments[0]!.view).toBe(currentView);
        expect(colorAttachments[0]!.view).not.toBe(engine.scRT._colorView);
    });

    it("binds an external depthTexture in place of the color RT's own depth view", async () => {
        const seenDescriptors: GPURenderPassDescriptor[] = [];
        const bundleDescriptors: GPURenderBundleEncoderDescriptor[] = [];
        const engine = makeMockEngine({ msaaSamples: 1, onBeginPass: (d) => seenDescriptors.push(d), bundleDescriptors });
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        scene.camera = makeCamera();

        // Color-only RT (no depthStencilFormat → buildRenderTarget allocates no depth).
        const colorRt = createRenderTarget({
            lbl: "scene-color",
            format: "bgra8unorm",
            samples: 1,
            size: { width: 16, height: 16 },
        });
        // Externally-supplied depth — simulates the output of a preceding GeometryRendererTask.
        const externalDepth = createRenderTarget({
            lbl: "external-depth",
            dFormat: "depth32float",
            depthClearValue: 1,
            depthCompare: "less-equal",
            samples: 1,
            size: { width: 16, height: 16 },
        });
        // Pre-populate the depth view (the geometry task would do this in record()).
        const sentinelDepthView = { tag: "external-depth-view" } as unknown as GPUTextureView;
        externalDepth._depthView = sentinelDepthView;
        externalDepth._depthTexture = {} as unknown as GPUTexture;
        externalDepth._width = 16;
        externalDepth._height = 16;
        externalDepth._eager = true;

        const task = createRenderTask({ name: "scene", rt: colorRt, depth: externalDepth }, engine, scene);
        scene._frameGraph._tasks.push(task);

        await registerScene(scene);
        scene._record();

        const descriptor = seenDescriptors.find((d) => d.depthStencilAttachment);
        expect(descriptor).toBeTruthy();
        const depthAtt = descriptor!.depthStencilAttachment as GPURenderPassDepthStencilAttachment;
        expect(depthAtt.view).toBe(sentinelDepthView);
        expect(depthAtt.depthLoadOp).toBe("load");
        expect(depthAtt.depthClearValue).toBe(1);
        // Color RT has no depth of its own — verifies depthTexture really did override it.
        expect(colorRt._depthView).toBeNull();
        // The pipeline's signature must reflect the external depth format so
        // beginRenderPass validates against pipelines with depthStencil.format = depth32float.
        expect(task._targetSignature._depthStencilFormat).toBe("depth32float");
        expect(task._targetSignature._depthCompare).toBe("less-equal");
        // Regression: the cached opaque render-bundle encoder's attachment state
        // must include the overridden depth format too. The colour RT carries no
        // depthStencilFormat of its own, so a bundle built from the RT descriptor
        // would omit it and fail WebGPU's bundle/pipeline compatibility check.
        expect(bundleDescriptors.length).toBeGreaterThan(0);
        expect(bundleDescriptors.every((d) => d.depthStencilFormat === "depth32float")).toBe(true);
    });

    it("always uses depthLoadOp 'clear' for an rt-owned depth attachment, regardless of clr", async () => {
        const seenDescriptors: GPURenderPassDescriptor[] = [];
        const engine = makeMockEngine({ msaaSamples: 1, onBeginPass: (d) => seenDescriptors.push(d) });
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        scene.camera = makeCamera();

        // Color RT with its own depth — buildRenderTarget will allocate _depthTexture/_depthView.
        const rt = createRenderTarget({
            lbl: "scene",
            format: "bgra8unorm",
            dFormat: "depth32float",
            samples: 1,
            size: { width: 16, height: 16 },
        });

        // clr=false → color uses "load", but depth must still be "clear" since the RT owns it.
        const task = createRenderTask({ name: "scene", rt, clr: false }, engine, scene);
        scene._frameGraph._tasks.push(task);

        await registerScene(scene);
        scene._record();

        const descriptor = seenDescriptors.find((d) => d.depthStencilAttachment);
        const depthAtt = descriptor!.depthStencilAttachment as GPURenderPassDepthStencilAttachment;
        expect(depthAtt.depthLoadOp).toBe("clear");
        const colorAtt = (descriptor!.colorAttachments as GPURenderPassColorAttachment[])[0]!;
        expect(colorAtt.loadOp).toBe("load");
    });

    it("loads an rt-owned depth attachment when depthClear is false", async () => {
        const seenDescriptors: GPURenderPassDescriptor[] = [];
        const engine = makeMockEngine({ msaaSamples: 1, onBeginPass: (d) => seenDescriptors.push(d) });
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        scene.camera = makeCamera();

        const rt = createRenderTarget({
            lbl: "overlay",
            format: "bgra8unorm",
            dFormat: "depth32float",
            samples: 1,
            size: { width: 16, height: 16 },
        });
        const task = createRenderTask({ name: "overlay", rt, clr: false, depthClear: false }, engine, scene);
        scene._frameGraph._tasks.push(task);

        await registerScene(scene);
        scene._record();

        const descriptor = seenDescriptors.find((d) => d.depthStencilAttachment);
        const depthAtt = descriptor!.depthStencilAttachment as GPURenderPassDepthStencilAttachment;
        expect(depthAtt.depthLoadOp).toBe("load");
        const colorAtt = (descriptor!.colorAttachments as GPURenderPassColorAttachment[])[0]!;
        expect(colorAtt.loadOp).toBe("load");
    });

    it("keeps task-managed external depth clearing when depthClear is false", async () => {
        const seenDescriptors: GPURenderPassDescriptor[] = [];
        const engine = makeMockEngine({ msaaSamples: 1, onBeginPass: (d) => seenDescriptors.push(d) });
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        scene.camera = makeCamera();

        const colorRt = createRenderTarget({
            lbl: "overlay-color",
            format: "bgra8unorm",
            samples: 1,
            size: { width: 16, height: 16 },
        });
        const externalDepth = createRenderTarget({
            lbl: "task-managed-depth",
            dFormat: "depth32float",
            samples: 1,
            size: { width: 16, height: 16 },
        });
        const task = createRenderTask({ name: "overlay", rt: colorRt, depth: externalDepth, depthClear: false }, engine, scene);
        scene._frameGraph._tasks.push(task);

        await registerScene(scene);
        scene._record();

        const descriptor = seenDescriptors.find((d) => d.depthStencilAttachment);
        const depthAtt = descriptor!.depthStencilAttachment as GPURenderPassDepthStencilAttachment;
        expect(depthAtt.depthLoadOp).toBe("clear");
    });

    it("keeps an explicit empty render list when autoMirror is false", () => {
        const engine = makeMockEngine({ msaaSamples: 1 });
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        scene.camera = makeCamera();
        scene._renderables.push(makeDrawOrderRenderable("scene", {}, []));
        const rt = createRenderTarget({ lbl: "explicit", format: "rgba8unorm", samples: 1, size: { width: 16, height: 16 } });
        const task = createRenderTask({ name: "explicit", rt, autoMirror: false }, engine, scene);

        expect(task._pendingMeshes).toBeUndefined();
        removeMeshFromTask(task, {} as Mesh);
        expect(task._pendingMeshes).toBeUndefined();
        task.record();

        expect(task._renderables).toHaveLength(0);
    });

    it("uses the scene clear color when an explicit task omits clrColor", () => {
        const seenDescriptors: GPURenderPassDescriptor[] = [];
        const engine = makeMockEngine({ msaaSamples: 1, onBeginPass: (descriptor) => seenDescriptors.push(descriptor) });
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        scene.camera = makeCamera();
        const rt = createRenderTarget({ lbl: "explicit-clear", format: "rgba8unorm", samples: 1, size: { width: 16, height: 16 } });
        const task = createRenderTask({ name: "explicit-clear", rt, autoMirror: false }, engine, scene);
        task.record();

        task.execute?.();

        const color = (seenDescriptors[0]!.colorAttachments as GPURenderPassColorAttachment[])[0]!;
        expect(color.loadOp).toBe("clear");
        expect(color.clearValue).toBe(scene.clearColor);
    });

    it("skips all pass work while disabled", () => {
        const seenDescriptors: GPURenderPassDescriptor[] = [];
        const engine = makeMockEngine({ msaaSamples: 1, onBeginPass: (descriptor) => seenDescriptors.push(descriptor) });
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        scene.camera = makeCamera();
        const rt = createRenderTarget({ lbl: "disabled", format: "rgba8unorm", samples: 1, size: { width: 16, height: 16 } });
        const task = createRenderTask({ name: "disabled", rt }, engine, scene);
        task.record();
        task.enabled = false;

        expect(task.execute?.()).toBe(0);
        expect(seenDescriptors).toHaveLength(0);
    });

    it("does not rebuild or dispose a shared render target", () => {
        const engine = makeMockEngine({ msaaSamples: 1 });
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        scene.camera = makeCamera();
        const rt = createRenderTarget({ lbl: "shared", format: "rgba8unorm", dFormat: "depth32float", samples: 1, size: { width: 16, height: 16 } });
        const owner = createRenderTask({ name: "owner", rt }, engine, scene);
        owner.record();
        const colorView = rt._colorView;
        const depthView = rt._depthView;
        const overlay = createRenderTask({ name: "overlay", rt, sharedRt: true, clr: false, depthClear: false, autoMirror: false }, engine, scene);

        overlay.record();
        expect(rt._colorView).toBe(colorView);
        expect(rt._depthView).toBe(depthView);

        overlay.dispose();
        expect(rt._colorView).toBe(colorView);
        expect(rt._depthView).toBe(depthView);
    });
});

describe("RenderTask MSAA resolveTarget", () => {
    it("wires a single-sample resolveTarget at execution when the RT is MSAA", () => {
        const engine = makeMockEngine({ msaaSamples: 4 });
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        scene.camera = makeCamera();

        const msaaRt = createRenderTarget({
            lbl: "msaa-color",
            format: "rgba8unorm",
            dFormat: "depth32float",
            samples: 4,
            size: { width: 32, height: 16 },
        });
        const resolveTarget = createRenderTarget({
            lbl: "resolve-color",
            format: "rgba8unorm",
            samples: 1,
            size: { width: 32, height: 16 },
        });

        const task = createRenderTask({ name: "msaa-scene", rt: msaaRt, rst: resolveTarget }, engine, scene);
        task.record();
        task.execute!();

        // The resolve target's color view must be allocated and used as the
        // attachment's resolveTarget so WebGPU resolves the 4x MSAA in-pass.
        expect(resolveTarget._colorView).toBeTruthy();
        expect(task._colorAttachment.view).toBe(msaaRt._colorView);
        expect(task._colorAttachment.resolveTarget).toBe(resolveTarget._colorView);
    });

    it("ignores resolveTarget when the render target is single-sample", () => {
        const engine = makeMockEngine({ msaaSamples: 1 });
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        scene.camera = makeCamera();

        const ssRt = createRenderTarget({
            lbl: "ss-color",
            format: "rgba8unorm",
            dFormat: "depth32float",
            samples: 1,
            size: { width: 32, height: 16 },
        });
        const resolveTarget = createRenderTarget({
            lbl: "resolve-color",
            format: "rgba8unorm",
            samples: 1,
            size: { width: 32, height: 16 },
        });

        const task = createRenderTask({ name: "ss-scene", rt: ssRt, rst: resolveTarget }, engine, scene);
        task.record();

        // Single-sample rt: the resolve target is neither built (no wasted GPU
        // allocation) nor wired as the attachment's resolveTarget.
        expect(resolveTarget._colorView).toBeNull();
        expect(task._colorAttachment.resolveTarget).toBeUndefined();
    });
});
