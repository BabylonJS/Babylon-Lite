import { describe, expect, it } from "vitest";

import { removeFromScene } from "../../../packages/babylon-lite/src/scene/scene-remove";
import { addToScene } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { AssetContainer } from "../../../packages/babylon-lite/src/asset-container";

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
        _frameGraph: { _tasks: [] },
    } as unknown as SceneContext;
}

describe("removeFromScene symmetry", () => {
    it("removes a light, clears its shadow generator, disposes its task and detaches parent", () => {
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
        expect(disposed).toBe(1);
        expect(light.parent).toBeNull();
        // idempotent
        removeFromScene(scene, light as never);
        expect(scene.lights).toHaveLength(0);
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
});
