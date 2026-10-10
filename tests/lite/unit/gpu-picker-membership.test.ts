import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AdvancedDraw from "../../../packages/babylon-lite/src/picking/picking-advanced-draw.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import { addToScene } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate.js";
import { createPlane } from "../../../packages/babylon-lite/src/mesh/mesh-factories.js";
import { detachMeshFromScene, releaseMeshResources, retainMeshResources } from "../../../packages/babylon-lite/src/mesh/mesh-retention.js";
import { waitForGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js";
import { createGpuPicker, disposePicker, pickAsync } from "../../../packages/babylon-lite/src/picking/gpu-picker.js";
import { pickWithRay } from "../../../packages/babylon-lite/src/picking/ray-pick.js";

const preparation = vi.hoisted(() => ({ pause: null as (() => Promise<void>) | null }));
vi.mock("../../../packages/babylon-lite/src/picking/picking-advanced-draw.js", async (original) => {
    const actual = await original<typeof AdvancedDraw>();
    return {
        ...actual,
        async prepareAdvancedDraw(...args: Parameters<typeof actual.prepareAdvancedDraw>) {
            const pause = preparation.pause;
            preparation.pause = null;
            await pause?.();
            return actual.prepareAdvancedDraw(...args);
        },
    };
});

function stub<T extends object>(value: Partial<T>): T {
    return value as T;
}

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function fixture() {
    const bytes = new WeakMap<GPUBuffer, ArrayBuffer>();
    const destroyed = new WeakSet<GPUBuffer>();
    const bound: GPUBuffer[] = [];
    const draws: { buffer: GPUBuffer; retired: boolean; count: number; id: number }[] = [];
    const layout = stub<GPUBindGroupLayout>({});
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => {
        const data = new ArrayBuffer(Number(descriptor.size));
        const buffer: GPUBuffer = stub<GPUBuffer>({
            label: descriptor.label ?? "",
            getMappedRange: () => data,
            unmap: vi.fn(),
            mapAsync: async () => undefined,
            destroy: vi.fn((): undefined => {
                destroyed.add(buffer);
                return undefined;
            }),
        });
        bytes.set(buffer, data);
        return buffer;
    });
    const device = stub<GPUDevice>({
        createBuffer,
        createTexture: (descriptor) => stub<GPUTexture>({ label: descriptor.label ?? "", createView: () => stub<GPUTextureView>({}), destroy: vi.fn() }),
        createBindGroupLayout: () => layout,
        createPipelineLayout: () => stub<GPUPipelineLayout>({}),
        createShaderModule: () => stub<GPUShaderModule>({}),
        createRenderPipeline: () => stub<GPURenderPipeline>({ getBindGroupLayout: () => layout }),
        createBindGroup: (descriptor) => {
            const group = stub<GPUBindGroup>({});
            groups.set(group, descriptor);
            return group;
        },
        createCommandEncoder: vi.fn(() => {
            let position!: GPUBuffer;
            let id = 0;
            let firstId = 0;
            const pass = stub<GPURenderPassEncoder>({
                setPipeline: vi.fn(),
                setBindGroup: (index, group) => {
                    if (index === 1 && group) {
                        const resource = [...groups.get(group)!.entries][0]!.resource;
                        if ("buffer" in resource) {
                            id = new Uint32Array(bytes.get(resource.buffer)!)[16]!;
                        }
                    }
                },
                setVertexBuffer: (slot, buffer) => {
                    if (buffer) {
                        if (slot === 0) {
                            position = buffer;
                        }
                        bound.push(buffer);
                    }
                },
                setIndexBuffer: vi.fn(),
                drawIndexed: (count) => {
                    firstId ||= id;
                    draws.push({ buffer: position, retired: destroyed.has(position), count, id });
                },
                end: vi.fn(),
            });
            return stub<GPUCommandEncoder>({
                beginRenderPass: () => pass,
                copyTextureToBuffer: (source, target) => {
                    const data = bytes.get(target.buffer)!;
                    if (source.texture.label === "pick-color") {
                        new Uint8Array(data).set([firstId >> 16, firstId >> 8, firstId & 255, 255]);
                    } else {
                        new Float32Array(data)[0] = 0.5;
                    }
                },
                finish: () => stub<GPUCommandBuffer>({}),
            });
        }),
        queue: stub<GPUQueue>({
            writeBuffer: (buffer, offset, source, start = 0, length) => {
                const view = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
                new Uint8Array(bytes.get(buffer)!).set(view.subarray(Number(start), length === undefined ? undefined : Number(start) + Number(length)), Number(offset));
            },
            submit: vi.fn(),
            onSubmittedWorkDone: async () => undefined,
        }),
    });
    const groups = new WeakMap<GPUBindGroup, GPUBindGroupDescriptor>();
    const engine = stub<EngineContext>({ _device: device, format: "rgba8unorm", msaaSamples: 1 });
    const scene = stub<SceneContext>({
        surface: stub<SceneContext["surface"]>({ engine, canvas: stub<HTMLCanvasElement>({ width: 32, height: 32, clientWidth: 32, clientHeight: 32 }) }),
        camera: createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 5, { x: 0, y: 0, z: 0 }),
        meshes: [],
        lights: [],
        _pickSources: [],
        _groups: new Map(),
        _meshDisposables: new Map(),
        _disposables: [],
        _renderables: [],
        _materialSwapQueue: [],
        _renderableVersion: 0,
        _frameGraph: stub<SceneContext["_frameGraph"]>({ _tasks: [] }),
    });
    const mesh = createPlane(engine, { size: 2 });
    addToScene(scene, mesh);
    const lease = retainMeshResources(engine, mesh);
    const picker = createGpuPicker(scene);
    const entered = deferred();
    const resume = deferred();
    preparation.pause = () => {
        entered.resolve();
        return resume.promise;
    };
    const options = { discard: { key: "membership", vertexData: "normal" as const, wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return false; }" } };
    return { engine, scene, mesh, lease, picker, entered, resume, options, draws, bound, destroyed };
}

beforeEach(() => vi.stubGlobal("GPUMapMode", { READ: 1 }));
afterEach(() => {
    preparation.pause = null;
    vi.unstubAllGlobals();
});

describe("GPU pick preparation membership", () => {
    it("rebuilds advanced candidates after retirement and admits a fresh identity without binding old buffers", async () => {
        const f = fixture();
        const oldBuffer = f.mesh._gpu.positionBuffer;
        const pending = pickAsync(f.picker, 16, 16, f.options);
        const queued = pickAsync(f.picker, 16, 16, f.options);
        await f.entered.promise;
        detachMeshFromScene(f.scene, f.mesh);
        releaseMeshResources(f.lease);
        await waitForGpuResourceRetirements(f.engine);
        expect(f.destroyed.has(oldBuffer)).toBe(true);
        expect(pickWithRay(f.scene, { origin: [0, 0, -2], direction: [0, 0, 1], length: 10 }).hit).toBe(false);
        const fresh = createPlane(f.engine, { size: 2 });
        addToScene(f.scene, fresh);
        f.resume.resolve();
        const results = await Promise.all([pending, queued]);
        expect(f.bound).not.toContain(oldBuffer);
        expect(f.draws.map((draw) => draw.retired)).toEqual([false, false]);
        expect(f.draws.map((draw) => draw.count)).toEqual([6, 6]);
        expect(results.map((result) => result.pickedMesh)).toEqual([fresh, fresh]);
        disposePicker(f.picker);
    });

    it("rebuilds fresh admission order and filter selection after a retained identity is reinserted", async () => {
        const f = fixture();
        const peer = createPlane(f.engine, { size: 2 });
        addToScene(f.scene, peer);
        const pending = pickAsync(f.picker, 16, 16, f.options);
        await f.entered.promise;
        detachMeshFromScene(f.scene, f.mesh);
        f.mesh.material = peer.material;
        addToScene(f.scene, f.mesh);
        f.resume.resolve();
        expect((await pending).pickedMesh).toBe(peer);
        expect(f.draws.map((draw) => draw.buffer)).toEqual([peer._gpu.positionBuffer, f.mesh._gpu.positionBuffer]);
        expect(f.draws.map((draw) => draw.id)).toEqual([1, 2]);
        expect((await pickAsync(f.picker, 16, 16, { ...f.options, filter: (mesh) => mesh === f.mesh })).pickedMesh).toBe(f.mesh);
        disposePicker(f.picker);
        releaseMeshResources(f.lease);
    });

    it("cancels preparation when the picker is disposed without recording or reviving its targets", async () => {
        const f = fixture();
        const pending = pickAsync(f.picker, 16, 16, f.options);
        await f.entered.promise;
        disposePicker(f.picker);
        f.resume.resolve();
        expect((await pending).hit).toBe(false);
        expect(f.engine._device.createCommandEncoder).not.toHaveBeenCalled();
        expect(f.picker._rt).toBeNull();
        releaseMeshResources(f.lease);
    });

    it("propagates a preparation failure and lets the next queued public promise complete", async () => {
        const f = fixture();
        const pending = pickAsync(f.picker, 16, 16, f.options);
        const failure = expect(pending).rejects.toThrow("controlled import failure");
        const queued = pickAsync(f.picker, 16, 16, f.options);
        await f.entered.promise;
        f.resume.reject(new Error("controlled import failure"));
        await failure;
        expect((await queued).pickedMesh).toBe(f.mesh);
        expect(f.draws).toHaveLength(1);
        disposePicker(f.picker);
        releaseMeshResources(f.lease);
    });
});
