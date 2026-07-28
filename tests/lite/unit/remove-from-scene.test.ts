import { describe, expect, it, vi } from "vitest";

import { removeFromScene } from "../../../packages/babylon-lite/src/scene/scene-remove";
import { addToScene } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { AssetContainer } from "../../../packages/babylon-lite/src/asset-container";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { MeshGroupBuilder } from "../../../packages/babylon-lite/src/render/renderable";

function fakeScene(): SceneContext {
    return {
        surface: { engine: {} },
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
        expect(destroy).not.toHaveBeenCalled();

        removeFromScene(sceneB, mesh);
        expect(destroy).toHaveBeenCalledOnce();
    });
});
