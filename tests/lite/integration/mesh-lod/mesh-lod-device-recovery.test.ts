/** MeshLoD device-recovery integration tests (Task 7.2 — architecture §14.3).
 *
 *  Device loss must restore MeshLoD coarse rendering through renderable rebuild thunks
 *  (no MeshLoD branch in the recovery module): the geometry arena and
 *  shared page state are recreated on the new device, retained pinned coarse pages are
 *  re-decoded + re-uploaded, fine pages reset for opportunistic streaming, and the PBR
 *  packets rebuild. A pinned-coarse failure marks the asset failed with
 *  MLOD_DEVICE_RECOVERY and cannot claim success. Recovery is idempotent per device.
 *  The full device-lost flow is browser-validated (scene164); here the renderable is
 *  driven directly with a swapped mock device. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMeshLoD, createMeshLoDInstance, setMeshLoDCacheBudget } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { addMeshLoDInstanceToScene, removeMeshLoDInstanceFromScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import { rebuildRenderables } from "../../../../packages/babylon-lite/src/engine/recovery-rebuild.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import { clearMeshLoDCpuPageCache } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-cache.js";
import { getMeshLoDUpdateBatch } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import { waitForGpuResourceRetirements } from "../../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js";
import { createSolidTexture2D } from "../../../../packages/babylon-lite/src/texture/solid-texture.js";
import { rebuildTexture2D } from "../../../../packages/babylon-lite/src/texture/texture-recovery.js";
import { releaseTexture } from "../../../../packages/babylon-lite/src/resource/texture-release.js";
import { _textureOwners } from "../../../../packages/babylon-lite/src/resource/texture-owner-state.js";
import type { Texture2D } from "../../../../packages/babylon-lite/src/texture/texture-2d.js";
import type { MeshLoDAsset, MeshLoDInstance, MeshLoDSelectionMode, MeshLoDLoadOptions } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import { createFillDecoder, createMockDevice, createMockEngine, createMockRenderPass } from "../../unit/mesh-lod/fixtures/gpu-mock.js";
import type { MockDevice } from "../../unit/mesh-lod/fixtures/gpu-mock.js";

const STATUE = fileURLToPath(new URL("../../../../lab/public/mesh-lod/harvard-yenching_institute_statue.mesh000.prim000.mlod", import.meta.url));
const statueSource = (): ArrayBuffer => new Uint8Array(readFileSync(STATUE)).slice().buffer as ArrayBuffer;
const SIG: RenderTargetSignature = { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth24plus-stencil8", _sampleCount: 1 };

function fakeScene(engine: EngineContext): SceneContext {
    return { _deferredBuilders: [], _renderables: [], _disposables: [], surface: { engine } } as unknown as SceneContext;
}

function fakeCamera(): Camera {
    return {
        fov: 0.8,
        nearPlane: 0.1,
        farPlane: 100,
        worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1]),
        worldMatrixVersion: 1,
        _viewCache: new Float32Array(16),
        _projCache: new Float32Array(16),
        _vpCache: new Float32Array(16),
        _viewVer: -1,
        _projVer: -1,
        _projAspect: -1,
        _vpVer: -1,
        _vpAspect: -1,
        _useFloatingOrigin: false,
    } as unknown as Camera;
}

const CONTEXT = { targetWidth: 800, targetHeight: 600, _camera: fakeCamera() };

interface Harness {
    engine: EngineContext;
    asset: MeshLoDAsset;
    instance: MeshLoDInstance;
    scene: SceneContext;
}

async function setup(selectionMode: MeshLoDSelectionMode = "gpu", options: MeshLoDLoadOptions = {}): Promise<Harness> {
    const engine = createMockEngine().engine;
    const asset = await loadMeshLoD(engine, statueSource(), { ...options, selectionMode });
    const scene = fakeScene(engine);
    const instance = createMeshLoDInstance(asset, {} as PbrMaterialProps);
    addMeshLoDInstanceToScene(scene, instance);
    for (const builder of scene._deferredBuilders.splice(0)) {
        await builder();
    }
    scene._built = true;
    scene._renderables[0]!.bind(engine, SIG).update!(CONTEXT); // one live frame on device A
    return { engine, asset, instance, scene };
}

/** Simulate device loss + recreation and replay the same renderable thunks as recovery. */
async function recover(engine: EngineContext, scene: SceneContext, replaceDevice = true, textures: readonly Texture2D[] = []): Promise<void> {
    if (replaceDevice) {
        const deviceB = createMockDevice();
        (engine as unknown as { _device: MockDevice })._device = deviceB;
    }
    for (const texture of textures) {
        await rebuildTexture2D(engine, texture);
    }
    const rebuilds = scene._renderables.flatMap((renderable) => (renderable._rebuild ? [renderable._rebuild] : []));
    scene._renderables.length = 0;
    scene._renderables.push(...(await rebuildRenderables(rebuilds)));
}

beforeEach(() => {
    _setMeshLoDPageDecoder(createFillDecoder().decoder);
});
afterEach(() => {
    _setMeshLoDPageDecoder(null);
    vi.restoreAllMocks();
});

describe("MeshLoD device recovery", () => {
    it.each(["cpu", "gpu"] as const)("reconciles effective budgets with smaller replacement arenas (%s)", async (mode) => {
        const block = 64 * 1024;
        const { engine, asset, scene } = await setup(mode, { cacheCapacityBytes: 4 * block, cacheBudgetBytes: 4 * block });
        for (const capacity of [2 * block, block]) {
            (engine as unknown as { _device: MockDevice })._device = createMockDevice(capacity + 1);
            await recover(engine, scene, false);
            expect(asset.state).toBe("ready");
            expect(asset._runtime.gpu.arena.capacityBytes).toBe(capacity);
            expect(asset._runtime.settings.cacheCapacityBytes).toBe(capacity);
            expect(asset._runtime.settings.cacheBudgetBytes).toBe(capacity);
            expect(asset.diagnostics.gpuCacheCapacityBytes).toBe(capacity);
            expect(asset.diagnostics.gpuCacheBudgetBytes).toBe(capacity);
            expect(() => setMeshLoDCacheBudget(asset, capacity + 1)).toThrowError(expect.objectContaining({ code: "MLOD_INVALID_OPTION" }));
            setMeshLoDCacheBudget(asset, capacity);
        }
    });

    it("registers one renderable rebuild thunk for the MeshLoD batch", async () => {
        const { scene } = await setup();
        expect(scene._renderables).toHaveLength(1);
        expect(scene._renderables[0]?._rebuild).toBeTypeOf("function");
    });

    it("rebuilds coarse residency + renderables on the recovered device", async () => {
        const { engine, asset, scene } = await setup();
        const runtime = asset._runtime;
        const oldArena = runtime.gpu.arena.buffer;
        const oldDevice = runtime.gpuDevice;
        const pinnedCount = runtime.pageRecords.filter((r) => r.pinned).length;

        await recover(engine, scene);

        expect(asset.state).toBe("ready");
        expect(runtime.gpuDevice).not.toBe(oldDevice);
        expect(runtime.gpuDevice).toBe(engine._device);
        expect(runtime.gpu.arena.buffer).not.toBe(oldArena); // a fresh arena on the new device
        expect(runtime.gpu.residentPageCount).toBe(pinnedCount); // pinned coarse fully restored
        expect(runtime.gpuSelection).toBeNull(); // shared selection buffers rebuild lazily
        expect(scene._renderables).toHaveLength(1);

        // The recovered coarse geometry renders on the new device.
        const binding = scene._renderables[0]!.bind(engine, SIG);
        binding.update!(CONTEXT);
        const pass = createMockRenderPass();
        expect(binding.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(1);
    });

    it("is idempotent per device (a second rebuild does not re-recover)", async () => {
        const { engine, asset, scene } = await setup();
        await recover(engine, scene);
        const arenaAfterFirst = asset._runtime.gpu.arena.buffer;
        const genAfterFirst = asset._runtime.generation;

        // Re-running the thunk on the same device rebuilds renderables but not residency.
        await recover(engine, scene, false);
        expect(asset._runtime.gpu.arena.buffer).toBe(arenaAfterFirst);
        expect(asset._runtime.generation).toBe(genAfterFirst);
    });

    it.each(["cpu", "gpu"] as const)("retires every outgoing packet generation on a persistent bound target (%s)", async (selectionMode) => {
        const { engine, scene, asset, instance } = await setup(selectionMode);
        const texture = createSolidTexture2D(engine, 1, 0, 0);
        texture._recoverySource = { kind: "solid", rgba: [1, 0, 0, 1] };
        instance.material.baseColorTexture = texture;
        await recover(engine, scene, false);
        releaseTexture(texture); // The packet now owns the only texture lease.
        const target = { ...SIG };
        const updateBatch = getMeshLoDUpdateBatch(target);
        const disposers = new Set<() => void>();
        const addDisposer = updateBatch.addDisposer.bind(updateBatch);
        vi.spyOn(updateBatch, "addDisposer").mockImplementation((dispose) => {
            disposers.add(dispose);
            const unregister = addDisposer(dispose);
            return () => {
                disposers.delete(dispose);
                unregister();
            };
        });
        const bindAndUpdate = () => {
            const binding = scene._renderables[0]!.bind(engine, target);
            updateBatch.reset();
            binding.update!(CONTEXT);
            updateBatch.flush(engine);
            expect(binding._updateBatches).toEqual([updateBatch]);
            expect(disposers.size).toBe(1);
            return binding;
        };
        let binding = bindAndUpdate();
        for (const replaceDevice of [true, false, true, false]) {
            const old = scene._meshLoDRegistry!.batches[0]!._packet as {
                disposed: boolean;
                drawScratch: Uint32Array;
                instanceScratch: Float32Array;
                cpuHistory: Map<number, unknown>;
                gpuBatchState: unknown;
                gpuInstanceState: unknown;
            };
            expect(old.drawScratch.length).toBeGreaterThan(0);
            expect(old.instanceScratch.length).toBeGreaterThan(0);
            const oldDevice = engine._device as unknown as MockDevice;
            const oldBuffers = oldDevice.buffers.filter((buffer) =>
                ["mesh-lod-material", "mesh-lod-draw-vertices", "mesh-lod-instances", "mesh-lod-indirect"].includes(buffer.label ?? "")
            );
            await recover(engine, scene, replaceDevice, [texture]);
            expect(old.disposed).toBe(true);
            expect(old.drawScratch.length).toBe(0);
            expect(old.instanceScratch.length).toBe(0);
            expect(old.cpuHistory.size).toBe(0);
            expect(old.gpuBatchState).toBeNull();
            expect(old.gpuInstanceState).toBeNull();
            expect(disposers.size).toBe(0);
            expect(binding.draw(createMockRenderPass() as unknown as GPURenderPassEncoder, engine)).toBe(0);
            const destroy = vi.spyOn(texture.texture, "destroy");
            Object.assign(engine._device.queue, { onSubmittedWorkDone: () => Promise.resolve() });
            await waitForGpuResourceRetirements(engine);
            expect(oldBuffers.every((buffer) => buffer.destroyed)).toBe(true);
            expect(destroy).not.toHaveBeenCalled();
            expect(_textureOwners(texture)).toBe(1);
            binding = bindAndUpdate();
            expect(binding.draw(createMockRenderPass() as unknown as GPURenderPassEncoder, engine)).toBe(1);
            expect(asset._runtime._frameSnapshots.size).toBeLessThanOrEqual(1);
        }
        scene._disposables.forEach((dispose) => dispose());
        scene._disposables.forEach((dispose) => dispose());
        await waitForGpuResourceRetirements(engine);
        expect(disposers.size).toBe(0);
        expect(_textureOwners(texture)).toBe(0);
        updateBatch.destroy();
    });

    it("marks the asset failed with MLOD_DEVICE_RECOVERY when retained pinned bytes are gone", async () => {
        const { engine, asset, scene } = await setup();
        // The retained pinned coarse bytes vanish before recovery (e.g. dropped cache).
        clearMeshLoDCpuPageCache(asset._runtime.cpuPageCache);

        await expect(recover(engine, scene)).rejects.toMatchObject({ code: "MLOD_DEVICE_RECOVERY" });

        expect(asset.state).toBe("failed");
        expect(asset.error?.code).toBe("MLOD_DEVICE_RECOVERY");
        expect(scene._renderables).toHaveLength(0); // the failed asset's batch is skipped
    });

    it.each(["cpu", "gpu"] as const)("rejects reactivation of an empty batch dropped during recovery (%s)", async (selectionMode) => {
        const { engine, asset, instance, scene } = await setup(selectionMode);
        const registry = scene._meshLoDRegistry!;
        const batch = registry.batches[0]!;
        expect(batch.renderable).toBe(scene._renderables[0]);
        expect(scene._deferredBuilders).toHaveLength(0);
        removeMeshLoDInstanceFromScene(scene, instance);

        await recover(engine, scene);

        expect(scene._renderables).toHaveLength(0);
        expect(batch.renderable).toBeUndefined();
        expect(asset._runtime.gpuDevice).toBe(engine._device);
        expect(() => addMeshLoDInstanceToScene(scene, instance)).toThrowError(expect.objectContaining({ code: "MLOD_INVALID_OPTION" }));
        expect(batch.instances).toHaveLength(0);
        expect(instance._selectionVersion).toBe(1);
        expect(scene._meshLoDRegistry).toBe(registry);
        expect(registry.batches).toEqual([batch]);
        expect(registry.byAsset.get(asset)?.get(instance.material)).toBe(batch);
        expect(registry.builderRegistered).toBe(true);
        expect(scene._deferredBuilders).toHaveLength(0);
        expect(scene._renderables).toHaveLength(0);
    });

    it.each(["cpu", "gpu"] as const)("retains remove/re-add support while the recovered batch has a live renderable (%s)", async (selectionMode) => {
        const { engine, instance, scene } = await setup(selectionMode);
        const batch = scene._meshLoDRegistry!.batches[0]!;
        const oldRenderable = batch.renderable;
        await recover(engine, scene);
        expect(batch.renderable).toBe(scene._renderables[0]);
        expect(batch.renderable).not.toBe(oldRenderable);
        removeMeshLoDInstanceFromScene(scene, instance);
        addMeshLoDInstanceToScene(scene, instance);
        expect(batch.instances).toEqual([instance]);
        expect(scene._deferredBuilders).toHaveLength(0);

        const binding = scene._renderables[0]!.bind(engine, SIG);
        binding.update!(CONTEXT);
        const pass = createMockRenderPass();
        expect(binding.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(1);
    });
});
