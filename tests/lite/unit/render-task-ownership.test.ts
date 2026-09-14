import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { createRenderTask, removeMeshFromTask, type RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import { buildStandardMeshRenderables } from "../../../packages/babylon-lite/src/material/standard/standard-renderable";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { DrawUpdateBatch, MeshGroupBuilder, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import { _textureOwners } from "../../../packages/babylon-lite/src/resource/gpu-pool";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { processMaterialSwaps } from "../../../packages/babylon-lite/src/scene/scene-material-swap";
import { rebuildTransferTarget, transferMeshBetweenTasks } from "../../../packages/babylon-lite/src/shadow/csm-shadow-cache";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

function fixture() {
    const buffers: GPUBuffer[] = [];
    const failure = { bufferAt: -1, upload: false, bindGroup: false, pipeline: false };
    const device = {
        features: new Set(),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            if (buffers.length === failure.bufferAt) throw new Error("buffer allocation failed");
            const buffer = { size: descriptor.size, destroy: vi.fn() } as unknown as GPUBuffer;
            buffers.push(buffer);
            return buffer;
        }),
        createTexture: vi.fn(
            (descriptor: GPUTextureDescriptor) =>
                ({
                    format: descriptor.format,
                    sampleCount: descriptor.sampleCount ?? 1,
                    mipLevelCount: descriptor.mipLevelCount ?? 1,
                    createView: vi.fn(() => ({}) as GPUTextureView),
                    destroy: vi.fn(),
                }) as unknown as GPUTexture
        ),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => {
            if (failure.bindGroup) throw new Error("bind group failed");
            return descriptor as unknown as GPUBindGroup;
        }),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createSampler: vi.fn(() => ({}) as GPUSampler),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => {
            if (failure.pipeline) throw new Error("pipeline failed");
            return descriptor as unknown as GPURenderPipeline;
        }),
        queue: {
            writeBuffer: vi.fn(() => {
                if (failure.upload) throw new Error("upload failed");
            }),
            writeTexture: vi.fn(),
        },
    };
    const engine = { _device: device, format: "rgba8unorm", canvas: { width: 16, height: 16 }, msaaSamples: 1 } as unknown as EngineContext;
    Object.assign(engine, { engine });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    const task = () =>
        createRenderTask(
            {
                name: "explicit",
                autoMirror: false,
                rt: createRenderTarget({ format: "rgba8unorm", dFormat: "depth24plus", samples: 1, size: { width: 16, height: 16 } }),
            },
            engine,
            scene
        );
    return { engine, scene, task, device, buffers, failure };
}

function mesh(material: Material): Mesh {
    const worldMatrix = new Float32Array(16);
    worldMatrix[0] = worldMatrix[5] = worldMatrix[10] = worldMatrix[15] = 1;
    return {
        material,
        worldMatrix,
        worldMatrixVersion: 1,
        morphTargets: null,
        receiveShadows: false,
        _gpu: { positionBuffer: { size: 36 }, normalBuffer: { size: 36 }, uvBuffer: { size: 24 }, indexBuffer: { size: 6 }, indexCount: 3, indexFormat: "uint16" },
    } as unknown as Mesh;
}

function familyMaterial(family: "standard" | "pbr", texture?: Texture2D): Material {
    if (family === "pbr") return createPbrMaterial({ baseColorTexture: texture, ormTexture: texture });
    const material = createStandardMaterial();
    material.diffuseTexture = texture ?? null;
    return material;
}

async function familyFixture(family: "standard" | "pbr") {
    const f = fixture();
    const raw = f.device.createTexture({ format: "rgba8unorm", size: [1, 1], usage: 4 });
    const texture = { texture: raw, view: raw.createView(), sampler: {}, width: 1, height: 1 } as Texture2D;
    const material = familyMaterial(family, texture);
    const mainMesh = mesh(material);
    f.scene._groups.set(material._buildGroup, [mainMesh]);
    const result = family === "standard" ? buildStandardMeshRenderables(f.scene, [mainMesh], {}) : await buildPbrRenderables(f.scene, [mainMesh], undefined);
    f.scene._groups.set(material._buildGroup, Object.assign([mainMesh], { r: result.rebuildSingle, o: result.renderables }));
    f.scene.meshes.push(mainMesh);
    f.scene._renderables.push(...result.renderables);
    const main = f.scene._meshDisposables.get(mainMesh)!;
    const aux = [vi.fn()];
    f.scene._meshAuxDisposables.set(mainMesh, aux);
    return { ...f, mainMesh, material, texture, main, aux };
}

function generation(task: RenderTask) {
    return {
        renderables: task._renderables,
        entries: task._meshEntries,
        opaque: task._opaqueBindings,
        direct: task._directBindings,
        transparent: task._transparentBindings,
        batches: task._updateBatches,
        bundles: task._ob,
        pending: task._pendingMeshes,
        auto: task._af,
        version: task._lastVersion,
        recorded: task._recorded,
        sceneBG: task._sceneBG,
    };
}

function syntheticMaterial(f: ReturnType<typeof fixture>) {
    const built: { renderable: Renderable; lifetime: ReturnType<typeof vi.fn>; bindings: ReturnType<typeof vi.fn>[]; batch: DrawUpdateBatch }[] = [];
    let failBind = false;
    let failBuild = false;
    const builder: MeshGroupBuilder = async () => {
        throw new Error("unexpected group build");
    };
    const material: Material = { _buildGroup: builder, _uboVersion: 0 };
    const target = mesh(material);
    const main = [vi.fn()];
    const aux = [vi.fn()];
    f.scene._meshDisposables.set(target, main);
    f.scene._meshAuxDisposables.set(target, aux);
    const rebuild = vi.fn((): Renderable => {
        const lifetime = vi.fn();
        const bindings: ReturnType<typeof vi.fn>[] = [];
        const batch = { reset: vi.fn(), flush: vi.fn(), destroy: vi.fn() };
        f.scene._meshDisposables.set(target, [lifetime]);
        const renderable: Renderable = {
            mesh: target,
            order: 100,
            isTransparent: false,
            bind() {
                const dispose = vi.fn();
                bindings.push(dispose);
                f.scene._meshAuxDisposables.get(target)!.push(dispose);
                if (failBind) throw new Error("binding failed");
                return { renderable, pipeline: {} as GPURenderPipeline, draw: () => 1, _updateBatches: [batch] };
            },
        };
        built.push({ renderable, lifetime, bindings, batch });
        if (failBuild) throw new Error("build failed");
        return renderable;
    });
    const group = Object.assign([target], { r: rebuild as MeshGroupBuilder["_rebuildSingle"] });
    f.scene._groups.set(builder, group);
    return {
        material,
        mesh: target,
        main,
        aux,
        group,
        built,
        rebuild,
        fail: (phase?: "build" | "bind") => {
            failBuild = phase === "build";
            failBind = phase === "bind";
        },
    };
}

describe("base RenderTask ownership", () => {
    it.each(["standard", "pbr"] as const)("owns %s auxiliary UBOs and texture leases without stealing the scene lists", async (family) => {
        const f = await familyFixture(family);
        const initialOwners = _textureOwners(f.texture);
        expect(initialOwners).toBeGreaterThan(0);
        for (let cycle = 0; cycle < 3; cycle++) {
            const task = f.task();
            const start = f.buffers.length;
            task.addMesh(f.mainMesh, { material: f.material });
            task.record();
            const privateBuffers = f.buffers.slice(start);
            expect(privateBuffers.length).toBeGreaterThanOrEqual(2);
            expect(f.scene._meshDisposables.get(f.mainMesh)).toBe(f.main);
            expect(f.scene._meshAuxDisposables.get(f.mainMesh)).toBe(f.aux);
            expect(_textureOwners(f.texture)).toBeGreaterThan(initialOwners);
            task.dispose();
            task.dispose();
            for (const buffer of privateBuffers) expect(buffer.destroy).not.toHaveBeenCalled();
            disposeGpuResourceRetirements(f.engine);
            for (const buffer of privateBuffers) expect(buffer.destroy).toHaveBeenCalledOnce();
            expect(_textureOwners(f.texture)).toBe(initialOwners);
            expect(f.texture.texture.destroy).not.toHaveBeenCalled();
            expect(f.aux[0]).not.toHaveBeenCalled();
        }
        for (const dispose of f.main) dispose();
        expect(f.texture.texture.destroy).toHaveBeenCalledOnce();
    });

    it.each(["standard", "pbr"] as const)("keeps a %s task alive through a main-scene material swap and releases it on mesh removal", async (family) => {
        const f = await familyFixture(family);
        const task = f.task();
        const start = f.buffers.length;
        task.addMesh(f.mainMesh, { material: f.material });
        task.record();
        const privateBuffers = f.buffers.slice(start);
        f.mainMesh.material = familyMaterial(family);
        f.scene._materialSwapQueue.push(f.mainMesh);
        await processMaterialSwaps(f.scene);
        disposeGpuResourceRetirements(f.engine);
        for (const buffer of privateBuffers) expect(buffer.destroy).not.toHaveBeenCalled();
        expect(f.texture.texture.destroy).not.toHaveBeenCalled();
        removeMeshFromTask(task, f.mainMesh);
        expect(task._renderables).toHaveLength(0);
        disposeGpuResourceRetirements(f.engine);
        for (const buffer of privateBuffers) expect(buffer.destroy).toHaveBeenCalledOnce();
        expect(f.texture.texture.destroy).toHaveBeenCalledOnce();
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
        for (const buffer of privateBuffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    });

    it.each(["standard", "pbr"] as const)("rolls back %s construction and binding allocation failures", async (family) => {
        for (const phase of ["allocation", "upload", "bindGroup", "pipeline"] as const) {
            const f = await familyFixture(family);
            const initialOwners = _textureOwners(f.texture);
            const task = f.task();
            task.addMesh(f.mainMesh, { material: f.material });
            const previous = generation(task);
            const start = f.buffers.length;
            if (phase === "allocation") f.failure.bufferAt = start + 1;
            else f.failure[phase] = true;
            expect(() => task.record()).toThrow(/failed/);
            expect(generation(task)).toEqual(previous);
            expect(task._pendingMeshes).toHaveLength(1);
            expect(f.scene._meshDisposables.get(f.mainMesh)).toBe(f.main);
            expect(f.scene._meshAuxDisposables.get(f.mainMesh)).toBe(f.aux);
            for (const buffer of f.buffers.slice(start)) expect(buffer.destroy).toHaveBeenCalledOnce();
            expect(_textureOwners(f.texture)).toBe(initialOwners);
            f.failure.bufferAt = -1;
            f.failure.upload = f.failure.bindGroup = f.failure.pipeline = false;
            task.record();
            expect(task._renderables).toHaveLength(1);
            expect(task._pendingMeshes).toHaveLength(0);
            task.dispose();
            disposeGpuResourceRetirements(f.engine);
            for (const dispose of f.main) dispose();
        }
    });

    it.each([false, true])("retains the entire pending queue after a later unready mesh (live: %s)", (live) => {
        const f = fixture();
        const first = syntheticMaterial(f);
        const second = syntheticMaterial(f);
        const rebuildSecond = second.group.r;
        second.group.r = undefined;
        const task = f.task();
        if (live) task.record();
        // Queue both before triggering the same transaction that a live add uses.
        task._pendingMeshes.push({ mesh: first.mesh, material: first.material });
        const before = generation(task);
        if (live) expect(() => task.addMesh(second.mesh)).toThrow(/initial build/);
        else {
            task.addMesh(second.mesh);
            expect(() => task.record()).toThrow(/initial build/);
        }
        expect(generation(task)).toEqual(before);
        expect(task._pendingMeshes).toHaveLength(2);
        expect(first.built[0]!.lifetime).toHaveBeenCalledOnce();
        second.group.r = rebuildSecond;
        task.record();
        expect(task._renderables).toHaveLength(2);
        expect(first.rebuild).toHaveBeenCalledTimes(2);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("rolls back live binding failure and retained binding generations", () => {
        const f = fixture();
        const first = syntheticMaterial(f);
        const next = syntheticMaterial(f);
        const task = f.task();
        task.addMesh(first.mesh);
        task.record();
        const before = generation(task);
        next.fail("bind");
        expect(() => task.addMesh(next.mesh)).toThrow("binding failed");
        expect(generation(task)).toEqual(before);
        expect(task._pendingMeshes).toHaveLength(1);
        expect(first.built[0]!.lifetime).not.toHaveBeenCalled();
        expect(first.built[0]!.bindings[0]).not.toHaveBeenCalled();
        expect(first.built[0]!.bindings[1]).toHaveBeenCalledOnce();
        expect(next.built[0]!.lifetime).toHaveBeenCalledOnce();
        next.fail();
        // Retry the live path without adding the pending request again.
        task.record();
        disposeGpuResourceRetirements(f.engine);
        expect(task._renderables).toHaveLength(2);
        expect(first.built[0]!.bindings[0]).toHaveBeenCalledOnce();
        expect(first.built[0]!.bindings[2]).not.toHaveBeenCalled();
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("preserves auto-mirroring until a live explicit addition commits", () => {
        const f = fixture();
        const next = syntheticMaterial(f);
        const borrowed: Renderable = {
            order: 0,
            isTransparent: false,
            bind: () => ({ renderable: borrowed, pipeline: {} as GPURenderPipeline, draw: () => 1 }),
        };
        f.scene._renderables.push(borrowed);
        const task = createRenderTask({ name: "mirrored", rt: createRenderTarget({ format: "rgba8unorm", samples: 1, size: { width: 16, height: 16 } }) }, f.engine, f.scene);
        task.record();
        expect(task._af).toBe(true);
        const before = generation(task);
        next.fail("bind");
        expect(() => task.addMesh(next.mesh)).toThrow("binding failed");
        expect(generation(task)).toEqual(before);
        expect(task._af).toBe(true);
        next.fail();
        task.record();
        expect(task._af).toBe(false);
        expect(task._renderables).toHaveLength(1);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
    });

    it("destroys candidate update batches without touching the live batches on rollback", () => {
        const f = fixture();
        const live = syntheticMaterial(f);
        const candidate = syntheticMaterial(f);
        const failing = syntheticMaterial(f);
        const task = f.task();
        task.addMesh(live.mesh);
        task.record();
        const current = generation(task);
        task._pendingMeshes.push({ mesh: candidate.mesh, material: candidate.material });
        failing.fail("bind");
        expect(() => task.addMesh(failing.mesh)).toThrow("binding failed");
        expect(generation(task)).toEqual(current);
        expect(live.built[0]!.batch.destroy).not.toHaveBeenCalled();
        expect(candidate.built[0]!.batch.destroy).toHaveBeenCalledOnce();
        failing.fail();
        task.record();
        expect(task._updateBatches).toHaveLength(3);
        task.dispose();
        disposeGpuResourceRetirements(f.engine);
        expect(live.built[0]!.batch.destroy).toHaveBeenCalledOnce();
        expect(candidate.built[0]!.batch.destroy).toHaveBeenCalledOnce();
        expect(candidate.built[1]!.batch.destroy).toHaveBeenCalledOnce();
    });

    it.each([false, true])("transfers lifetime ownership only after destination binding succeeds (batched: %s)", (batched) => {
        const f = fixture();
        const material = syntheticMaterial(f);
        const from = f.task();
        const to = f.task();
        from.addMesh(material.mesh);
        from.record();
        to.record();
        const source = generation(from);
        const destination = generation(to);
        const targets = batched ? new Set<RenderTask>() : undefined;
        material.fail("bind");
        if (targets) {
            transferMeshBetweenTasks(from, to, material.mesh, targets);
            expect(() => rebuildTransferTarget(to)).toThrow("binding failed");
        } else {
            expect(() => transferMeshBetweenTasks(from, to, material.mesh)).toThrow("binding failed");
        }
        expect(generation(from)).toEqual(source);
        expect(generation(to)).toEqual(destination);
        expect(material.built[0]!.lifetime).not.toHaveBeenCalled();
        material.fail();
        if (targets) rebuildTransferTarget(to);
        else transferMeshBetweenTasks(from, to, material.mesh);
        expect(from._renderables).toHaveLength(0);
        expect(to._renderables).toEqual([material.built[0]!.renderable]);
        expect(material.rebuild).toHaveBeenCalledOnce();
        from.dispose();
        disposeGpuResourceRetirements(f.engine);
        expect(material.built[0]!.lifetime).not.toHaveBeenCalled();
        to.dispose();
        disposeGpuResourceRetirements(f.engine);
        expect(material.built[0]!.lifetime).toHaveBeenCalledOnce();
        for (const callback of material.built[0]!.bindings) expect(callback).toHaveBeenCalledOnce();
    });
});
