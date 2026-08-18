import { describe, expect, it, vi } from "vitest";

import { removeFromScene } from "../../../packages/babylon-lite/src/scene/scene-remove";
import { addToScene } from "../../../packages/babylon-lite/src/scene/scene-core";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { cloneTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import { ObservableVec3 } from "../../../packages/babylon-lite/src/math/observable-vec3";
import { ObservableQuat } from "../../../packages/babylon-lite/src/math/observable-quat";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { AssetContainer } from "../../../packages/babylon-lite/src/asset-container";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { MeshGroupBuilder } from "../../../packages/babylon-lite/src/render/renderable";

function fakeScene(): SceneContext {
    return {
        surface: { engine: { _retirements: null } },
        camera: null,
        lights: [],
        meshes: [],
        animationGroups: [],
        shadowGenerators: [],
        _beforeRender: [],
        _renderables: [],
        _materialSwapQueue: [],
        _groups: new Map(),
        _meshDisposables: new Map(),
        _meshAuxDisposables: new Map(),
        _renderableVersion: 0,
        _disposables: [],
        _frameGraph: { _tasks: [] },
    } as unknown as SceneContext;
}

/** `removeFromScene` defers GPU teardown until after the next frame submits (so it is safe to call
 *  from `onBeforeRender`), so tests that assert destruction have to drain the engine's retirement
 *  list first. Mirrors what `renderFrame` / `disposeEngine` do, minus the queue fence. */
function drainRetirements(...scenes: SceneContext[]): void {
    for (const scene of scenes) {
        disposeGpuResourceRetirements(scene.surface.engine);
    }
}

describe("removeFromScene symmetry", () => {
    it("removes a light, clears its shadow generator, queues its teardown and detaches parent", () => {
        const scene = fakeScene();
        let disposed = 0;
        // Real ShadowGenerator stores the disposable render task under _shadowTaskState._task.
        const sg = { _shadowType: "esm", _light: {}, _shadowTaskState: { _task: { dispose: () => disposed++ } } };
        const light = { lightType: "point", children: [], shadowGenerator: sg, parent: {} };
        scene.lights.push(light as never);
        scene.shadowGenerators.push(sg as never);

        removeFromScene(scene, light as never);
        expect(scene.lights).toHaveLength(0);
        expect(scene.shadowGenerators).toHaveLength(0);
        // Teardown is DEFERRED: receiver renderables built before the removal still bind this
        // generator's resources until a rebuild replaces them (see scene-rebuild.ts).
        expect(disposed).toBe(0);
        expect(scene._pendingTopologyRetirements).toHaveLength(1);
        expect(light.parent).toBeNull();
        // idempotent
        removeFromScene(scene, light as never);
        expect(scene.lights).toHaveLength(0);
        expect(scene._pendingTopologyRetirements).toHaveLength(1);
        for (const fn of scene._pendingTopologyRetirements!) {
            fn();
        }
        expect(disposed).toBe(1);
    });

    it("clears the scene camera only when it matches, detaching its parent", () => {
        const scene = fakeScene();
        const cam = { fov: 0.8, nearPlane: 0.1, children: [], parent: {} };
        scene.camera = cam as never;
        removeFromScene(scene, cam as never);
        expect(scene.camera).toBeNull();
        expect(cam.parent).toBeNull();
        const other = { fov: 1, nearPlane: 0.1, children: [] };
        scene.camera = cam as never;
        removeFromScene(scene, other as never);
        expect(scene.camera).toBe(cam);
    });

    it("undoes addToScene(container): lights, camera, anim groups and beforeRender hook", () => {
        const scene = fakeScene();
        const light = { lightType: "point", children: [] };
        const cam = { fov: 0.8, nearPlane: 0.1, children: [] };
        const group = { _stopped: false, _ctrl: { tick: () => {} } };
        const container: AssetContainer = {
            entities: [light as never],
            camera: cam as never,
            animationGroups: [group as never],
        };

        addToScene(scene, container);
        expect(scene.lights).toHaveLength(1);
        expect(scene.camera).toBe(cam);
        expect(scene.animationGroups).toHaveLength(1);
        expect(scene._beforeRender).toHaveLength(1);

        removeFromScene(scene, container);
        expect(scene.lights).toHaveLength(0);
        expect(scene.camera).toBeNull();
        expect(scene.animationGroups).toHaveLength(0);
        expect(scene._beforeRender).toHaveLength(0);
        expect(container._beforeRenderHook).toBeUndefined();
        // safe to call twice
        removeFromScene(scene, container);
        expect(scene._beforeRender).toHaveLength(0);
    });

    it("runs feature-owned scene cleanup once when its container is removed", () => {
        const scene = fakeScene();
        const cleanup = vi.fn();
        const cleanups = new WeakMap<SceneContext, () => void>();
        const container = {
            entities: [],
            _sceneCleanups: cleanups,
            _sceneSetup: (target: SceneContext) => {
                cleanups.set(target, cleanup);
                target._disposables.push(cleanup);
            },
        } as unknown as AssetContainer;

        addToScene(scene, container);
        expect(scene._disposables).toHaveLength(1);

        removeFromScene(scene, container);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(scene._disposables).toHaveLength(0);

        removeFromScene(scene, container);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("evicts task-local mesh bindings before destroying the mesh GPU", () => {
        const scene = fakeScene();
        let destroyed = false;
        const buffer = () => ({ destroy: () => undefined });
        const mesh = {
            material: null,
            children: [],
            parent: null,
            thinInstances: null,
            skeleton: null,
            vat: null,
            morphTargets: null,
            _gpu: {
                positionBuffer: { destroy: () => (destroyed = true) },
                normalBuffer: buffer(),
                uvBuffer: buffer(),
                indexBuffer: buffer(),
            },
        };
        const removeMesh = vi.fn(() => {
            expect(destroyed).toBe(false);
        });
        scene._frameGraph._tasks.push({ _removeMesh: removeMesh } as never);
        addToScene(scene, mesh as never);

        removeFromScene(scene, mesh as never);

        expect(removeMesh).toHaveBeenCalledWith(mesh);
        // Teardown is retired until after the next submit, so nothing is destroyed synchronously.
        expect(destroyed).toBe(false);
        drainRetirements(scene);
        expect(destroyed).toBe(true);
    });

    it("removes a mesh from every material group while a material migration is pending", () => {
        const scene = fakeScene();
        const oldBuilder = (() => undefined) as unknown as MeshGroupBuilder;
        const newBuilder = (() => undefined) as unknown as MeshGroupBuilder;
        const destroy = vi.fn();
        const mesh = {
            _gpu: {
                positionBuffer: { destroy },
                normalBuffer: { destroy },
                uvBuffer: { destroy },
                indexBuffer: { destroy },
                tangentBuffer: null,
                uv2Buffer: null,
                colorBuffer: null,
            },
            material: { _buildGroup: newBuilder },
            children: [],
            parent: null,
        } as unknown as Mesh;

        scene.meshes.push(mesh);
        scene._groups.set(oldBuilder, [mesh]);
        scene._groups.set(newBuilder, []);
        scene._materialSwapQueue.push(mesh);

        removeFromScene(scene, mesh);
        expect([...scene._groups.values()].every((group) => !group.includes(mesh))).toBe(true);
        expect(scene._materialSwapQueue).not.toContain(mesh);
    });

    it("keeps shared mesh GPU state until the last scene removal", () => {
        const sceneA = fakeScene();
        const sceneB = fakeScene();
        const destroy = vi.fn();
        const mesh = {
            _gpu: {
                positionBuffer: { destroy },
                normalBuffer: { destroy: vi.fn() },
                uvBuffer: { destroy: vi.fn() },
                indexBuffer: { destroy: vi.fn() },
                tangentBuffer: null,
                uv2Buffer: null,
                colorBuffer: null,
            },
            material: null,
            children: [],
            parent: null,
        } as unknown as Mesh;

        addToScene(sceneA, mesh);
        addToScene(sceneB, mesh);

        removeFromScene(sceneA, mesh);
        drainRetirements(sceneA);
        expect(destroy).not.toHaveBeenCalled();

        removeFromScene(sceneB, mesh);
        drainRetirements(sceneB);
        expect(destroy).toHaveBeenCalledOnce();
    });

    it("rejects re-adding a disposed mesh, leaving the scene untouched", () => {
        const scene = fakeScene();
        const destroy = vi.fn();
        const mesh = {
            name: "retired",
            _gpu: {
                positionBuffer: { destroy },
                normalBuffer: { destroy: vi.fn() },
                uvBuffer: { destroy: vi.fn() },
                indexBuffer: { destroy: vi.fn() },
                tangentBuffer: null,
                uv2Buffer: null,
                colorBuffer: null,
            },
            material: null,
            children: [],
            parent: null,
        } as unknown as Mesh;

        addToScene(scene, mesh);
        removeFromScene(scene, mesh);
        drainRetirements(scene);
        expect(destroy).toHaveBeenCalledOnce();

        expect(() => addToScene(scene, mesh)).toThrow(/was disposed/);
        expect(scene.meshes).toHaveLength(0);
        // A brand-new scene is no escape hatch — disposal is a property of the mesh.
        expect(() => addToScene(fakeScene(), mesh)).toThrow(/was disposed/);
    });

    it("rejects re-adding a disposed clone so its sibling's geometry is never double-released", () => {
        const scene = fakeScene();
        const gpu = {
            positionBuffer: { destroy: vi.fn() },
            normalBuffer: { destroy: vi.fn() },
            uvBuffer: { destroy: vi.fn() },
            indexBuffer: { destroy: vi.fn() },
            tangentBuffer: null,
            uv2Buffer: null,
            colorBuffer: null,
        };
        const source = {
            name: "source",
            _gpu: gpu,
            material: null,
            children: [],
            parent: null,
            position: new ObservableVec3(0, 0, 0, () => {}),
            rotationQuaternion: new ObservableQuat(0, 0, 0, 1, () => {}),
            scaling: new ObservableVec3(1, 1, 1, () => {}),
        } as unknown as Mesh;
        const clone = cloneTransformNode(source) as Mesh;
        expect(source._gpu._refCount).toBe(2);

        addToScene(scene, source);
        addToScene(scene, clone);
        removeFromScene(scene, source);
        drainRetirements(scene);
        // The clone still owns the geometry, so nothing was destroyed.
        expect(gpu.positionBuffer.destroy).not.toHaveBeenCalled();

        // Re-adding the source would let it release a second claim it no longer holds,
        // destroying buffers the clone still renders with.
        expect(() => addToScene(scene, source)).toThrow(/was disposed/);
        expect(scene.meshes).toEqual([clone]);

        removeFromScene(scene, clone);
        drainRetirements(scene);
        expect(gpu.positionBuffer.destroy).toHaveBeenCalledOnce();
    });

    it("stays idempotent for a disposed mesh instead of double-releasing its clone's geometry", () => {
        const scene = fakeScene();
        const gpu = {
            positionBuffer: { destroy: vi.fn() },
            normalBuffer: { destroy: vi.fn() },
            uvBuffer: { destroy: vi.fn() },
            indexBuffer: { destroy: vi.fn() },
            tangentBuffer: null,
            uv2Buffer: null,
            colorBuffer: null,
        };
        const source = {
            name: "source",
            _gpu: gpu,
            material: null,
            children: [],
            parent: null,
            position: new ObservableVec3(0, 0, 0, () => {}),
            rotationQuaternion: new ObservableQuat(0, 0, 0, 1, () => {}),
            scaling: new ObservableVec3(1, 1, 1, () => {}),
        } as unknown as Mesh;
        const clone = cloneTransformNode(source) as Mesh;

        addToScene(scene, source);
        addToScene(scene, clone);
        removeFromScene(scene, source);
        // The second removal must not release a second claim — the clone still renders with it.
        removeFromScene(scene, source);
        drainRetirements(scene);
        expect(gpu.positionBuffer.destroy).not.toHaveBeenCalled();
        expect(source._gpu._refCount).toBe(1);

        removeFromScene(scene, clone);
        drainRetirements(scene);
        expect(gpu.positionBuffer.destroy).toHaveBeenCalledOnce();
    });

    it("rejects a disposed mesh whose per-node skeleton died while its shared geometry survived", () => {
        const scene = fakeScene();
        const gpu = {
            positionBuffer: { destroy: vi.fn() },
            normalBuffer: { destroy: vi.fn() },
            uvBuffer: { destroy: vi.fn() },
            indexBuffer: { destroy: vi.fn() },
            tangentBuffer: null,
            uv2Buffer: null,
            colorBuffer: null,
            // Shared with a second glTF node referencing the same primitive.
            _refCount: 2,
        };
        const boneTexture = { destroy: vi.fn() };
        const mesh = {
            name: "skinned",
            _gpu: gpu,
            material: null,
            children: [],
            parent: null,
            // Per-node skeleton: not shared, so it dies with this mesh.
            skeleton: { boneTexture, jointsBuffer: { destroy: vi.fn() }, weightsBuffer: { destroy: vi.fn() }, _skinBuffers: {} },
        } as unknown as Mesh;

        addToScene(scene, mesh);
        removeFromScene(scene, mesh);
        drainRetirements(scene);
        expect(gpu.positionBuffer.destroy).not.toHaveBeenCalled();
        expect(boneTexture.destroy).toHaveBeenCalledOnce();

        expect(() => addToScene(scene, mesh)).toThrow(/was disposed/);
    });

    it("keeps a mesh addable while another scene still holds it", () => {
        const sceneA = fakeScene();
        const sceneB = fakeScene();
        const destroy = vi.fn();
        const mesh = {
            name: "shared",
            _gpu: {
                positionBuffer: { destroy },
                normalBuffer: { destroy: vi.fn() },
                uvBuffer: { destroy: vi.fn() },
                indexBuffer: { destroy: vi.fn() },
                tangentBuffer: null,
                uv2Buffer: null,
                colorBuffer: null,
            },
            material: null,
            children: [],
            parent: null,
        } as unknown as Mesh;

        addToScene(sceneA, mesh);
        addToScene(sceneB, mesh);
        removeFromScene(sceneA, mesh);
        expect(destroy).not.toHaveBeenCalled();

        // sceneB still holds the mesh, so it was never disposed and the re-add is legal.
        expect(() => addToScene(sceneA, mesh)).not.toThrow();
        expect(sceneA.meshes).toContain(mesh);
    });
});
