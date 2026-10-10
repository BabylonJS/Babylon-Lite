import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { AssetContainer } from "../../../packages/babylon-lite/src/asset-container.js";
import { createSceneContext, addToScene, disposeScene } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import { createPlane } from "../../../packages/babylon-lite/src/mesh/mesh-factories.js";
import { retainMeshResources, detachMeshFromScene, releaseMeshResources } from "../../../packages/babylon-lite/src/mesh/mesh-retention.js";
import { waitForGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node.js";
import { createHemisphericLight } from "../../../packages/babylon-lite/src/light/hemispheric.js";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate.js";
import { pickWithRay } from "../../../packages/babylon-lite/src/picking/ray-pick.js";

function stub<T extends object>(value: Partial<T>): T {
    return value as T;
}

function fixture() {
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) =>
        stub<GPUBuffer>({
            destroy: vi.fn(() => undefined),
            getMappedRange: () => new ArrayBuffer(Number(descriptor.size)),
            unmap: () => undefined,
        })
    );
    const engine = stub<EngineContext>({
        _device: stub<GPUDevice>({ createBuffer, queue: stub<GPUQueue>({ onSubmittedWorkDone: async () => undefined }) }),
    });
    const surface = stub<EngineContext>({ engine, _renderingContexts: [] });
    const scene = createSceneContext(surface, { defaultRenderTask: false });
    const mesh = (name: string) => {
        const value = createPlane(engine, { size: 2 });
        value.name = name;
        return value;
    };
    return { engine, surface, scene, mesh, createBuffer };
}

describe("retained hierarchy admission", () => {
    it("restores a detached leased child through an attached parent, with fresh order, picks and the same geometry claim", async () => {
        const f = fixture();
        const parent = f.mesh("parent");
        const child = f.mesh("child");
        const peer = f.mesh("peer");
        parent.position.x = 3;
        child.position.x = -3;
        parent.children.push(child);
        addToScene(f.scene, parent);
        addToScene(f.scene, peer);
        const lease = retainMeshResources(f.engine, child);
        const gpu = child._gpu;
        const allocations = f.createBuffer.mock.calls.length;
        const parentVersion = parent.worldMatrixVersion;
        detachMeshFromScene(f.scene, child);
        const ray = { origin: [0, 0, -5] as [number, number, number], direction: [0, 0, 1] as [number, number, number], length: 10 };
        expect(pickWithRay(f.scene, ray, { predicate: (mesh) => mesh === child }).hit).toBe(false);
        await waitForGpuResourceRetirements(f.engine);
        addToScene(f.scene, parent);
        expect(f.scene.meshes).toEqual([parent, peer, child]);
        expect(child.parent).toBe(parent);
        expect(child.worldMatrix[12]).toBe(0);
        expect(parent.worldMatrixVersion).toBe(parentVersion);
        expect(pickWithRay(f.scene, ray, { predicate: (mesh) => mesh === child }).pickedMesh).toBe(child);
        expect(child._gpu).toBe(gpu);
        expect(gpu._refCount ?? 1).toBe(1);
        expect(f.createBuffer).toHaveBeenCalledTimes(allocations);
        const queued = f.scene._materialSwapQueue.slice();
        const groups = [...f.scene._groups.values()].map((group) => group.slice());
        addToScene(f.scene, parent);
        expect(f.scene.meshes).toEqual([parent, peer, child]);
        expect(f.scene._materialSwapQueue).toEqual(queued);
        expect([...f.scene._groups.values()].map((group) => group.slice())).toEqual(groups);
        detachMeshFromScene(f.scene, child);
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(f.engine);
        for (const buffer of [gpu.positionBuffer, gpu.normalBuffer, gpu.uvBuffer, gpu.indexBuffer]) {
            expect(buffer.destroy).toHaveBeenCalledOnce();
        }
        disposeScene(f.scene);
    });

    it("admits new nested descendants through duplicate mesh and light parents without changing existing membership order", () => {
        const f = fixture();
        const parent = f.mesh("parent");
        const existing = f.mesh("existing");
        const light = createHemisphericLight([0, 1, 0]);
        parent.children.push(existing, light);
        addToScene(f.scene, parent);
        const lease = retainMeshResources(f.engine, existing);
        const node = createTransformNode("nested");
        const camera = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
        const fresh = f.mesh("fresh");
        const nested = f.mesh("nested-card");
        node.children.push(nested);
        const cameraChild = f.mesh("camera-child");
        camera.children.push(cameraChild);
        addToScene(f.scene, camera);
        parent.children.push(fresh, node);
        const lightChild = f.mesh("light-child");
        light.children.push(lightChild);
        addToScene(f.scene, parent);
        expect(f.scene.meshes).toEqual([parent, existing, cameraChild, lightChild, fresh, nested]);
        expect(f.scene.lights).toEqual([light]);
        expect(fresh.parent).toBe(parent);
        expect(node.parent).toBe(parent);
        expect(nested.parent).toBe(node);
        expect(cameraChild.parent).toBe(camera);
        expect(lightChild.parent).toBe(light);
        expect(f.scene.camera).toBeNull();
        addToScene(f.scene, light);
        addToScene(f.scene, parent);
        expect(f.scene.meshes).toEqual([parent, existing, cameraChild, lightChild, fresh, nested]);
        expect(f.scene.lights).toEqual([light]);
        disposeScene(f.scene);
        releaseMeshResources(lease);
    });

    it("keeps scene ownership independent and preserves source last-parent semantics for shared descendants and containers", async () => {
        const f = fixture();
        const other = createSceneContext(f.surface, { defaultRenderTask: false });
        const parent = f.mesh("parent");
        const child = f.mesh("shared-child");
        parent.children.push(child);
        const lease = retainMeshResources(f.engine, child);
        addToScene(f.scene, parent);
        addToScene(other, parent);
        detachMeshFromScene(f.scene, child);
        const gpu = child._gpu;
        const second = createTransformNode("second-parent");
        second.children.push(child, child);
        const container = stub<AssetContainer>({ entities: [parent, second] });
        addToScene(f.scene, container);
        expect(f.scene.meshes).toEqual([parent, child]);
        expect(other.meshes).toEqual([parent, child]);
        expect(child.parent).toBe(second);
        expect(child._gpu).toBe(gpu);
        expect(gpu._refCount ?? 1).toBe(1);
        disposeScene(f.scene);
        await waitForGpuResourceRetirements(f.engine);
        expect(child._disposed).not.toBe(true);
        expect(other.meshes).toEqual([parent, child]);
        disposeScene(other);
        expect(child._disposed).not.toBe(true);
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(f.engine);
        expect(child._disposed).toBe(true);
    });

    it.each([false, true])("preserves the source cycle failure rather than silently accepting a cyclic hierarchy (retained=%s)", (retained) => {
        const f = fixture();
        const parent = f.mesh("cyclic");
        addToScene(f.scene, parent);
        const lease = retained ? retainMeshResources(f.engine, parent) : null;
        parent.children.push(parent);
        try {
            expect(() => addToScene(f.scene, parent)).toThrow(RangeError);
        } finally {
            parent.parent = null;
            parent.children.length = 0;
            disposeScene(f.scene);
            if (lease) {
                releaseMeshResources(lease);
            }
        }
    });
});
