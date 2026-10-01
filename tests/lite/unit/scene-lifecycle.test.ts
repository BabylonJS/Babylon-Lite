import { describe, expect, it, vi } from "vitest";

import { createNullEngine } from "../../../packages/babylon-lite/src/engine/null-engine";
import { addToScene, createSceneContext, disposeScene } from "../../../packages/babylon-lite/src/scene/scene-core";
import { onSceneChange, onSceneDispose } from "../../../packages/babylon-lite/src/scene/scene";
import { removeFromScene } from "../../../packages/babylon-lite/src/scene/scene-remove";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import type { AssetContainer } from "../../../packages/babylon-lite/src/asset-container";
import type { SceneChangeEvent } from "../../../packages/babylon-lite/src/scene/scene-core";

describe("scene lifecycle", () => {
    it("allocates change state only while a scene has subscribers", () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });

        expect(scene._sceneChanges).toBeUndefined();
        const unsubscribe = onSceneChange(scene, () => {});
        expect(scene._sceneChanges).toBeDefined();

        unsubscribe();
        unsubscribe();
        expect(scene._sceneChanges).toBeUndefined();
        disposeScene(scene);
    });

    it("publishes committed recursive add and remove changes to independent consumers", () => {
        const engine = createNullEngine();
        const firstScene = createSceneContext(engine, { defaultRenderTask: false });
        const secondScene = createSceneContext(engine, { defaultRenderTask: false });
        const parent = createTransformNode("Parent");
        const child = createTransformNode("Child");
        const other = createTransformNode("Other");
        parent.children.push(child);
        const firstEvents: SceneChangeEvent[] = [];
        const secondEvents: SceneChangeEvent[] = [];
        const otherEvents: SceneChangeEvent[] = [];
        const unsubscribeFirst = onSceneChange(firstScene, (event) => firstEvents.push(event));
        onSceneChange(firstScene, (event) => secondEvents.push(event));
        onSceneChange(secondScene, (event) => otherEvents.push(event));

        addToScene(firstScene, parent);
        addToScene(secondScene, other);
        unsubscribeFirst();
        removeFromScene(firstScene, parent);

        expect(firstEvents).toEqual([
            { type: "added", entity: parent },
            { type: "added", entity: child },
        ]);
        expect(secondEvents).toEqual([
            { type: "added", entity: parent },
            { type: "added", entity: child },
            { type: "removed", entity: parent },
            { type: "removed", entity: child },
        ]);
        expect(otherEvents).toEqual([{ type: "added", entity: other }]);
        expect(child.parent).toBeNull();

        disposeScene(firstScene);
        disposeScene(secondScene);
    });

    it("reports asset-container contents and the container after recursive membership commits", () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const parent = createTransformNode("Parent");
        const child = createTransformNode("Child");
        parent.children.push(child);
        const container = { entities: [parent] } as AssetContainer;
        const events: SceneChangeEvent[] = [];
        onSceneChange(scene, (event) => events.push(event));

        addToScene(scene, container);
        removeFromScene(scene, container);

        expect(events).toEqual([
            { type: "added", entity: parent },
            { type: "added", entity: child },
            { type: "added", entity: container },
            { type: "removed", entity: parent },
            { type: "removed", entity: child },
            { type: "removed", entity: container },
        ]);
        disposeScene(scene);
    });

    it("finishes dispatch, honors unsubscription, and drains reentrant changes before surfacing failures", () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const first = createTransformNode("First");
        const reentrant = createTransformNode("Reentrant");
        const failure = new Error("listener failed");
        const events: string[] = [];
        const removed = vi.fn();
        let unsubscribeRemoved = (): void => {};

        onSceneChange(scene, (event) => {
            events.push(`first:${"name" in event.entity ? event.entity.name : "container"}`);
            unsubscribeRemoved();
            if (event.entity === first) {
                addToScene(scene, reentrant);
            }
            throw failure;
        });
        unsubscribeRemoved = onSceneChange(scene, removed);
        onSceneChange(scene, (event) => events.push(`last:${"name" in event.entity ? event.entity.name : "container"}`));

        expect(() => addToScene(scene, first)).toThrow(
            expect.objectContaining({
                errors: [failure, failure],
            })
        );
        expect(removed).not.toHaveBeenCalled();
        expect(events).toEqual(["first:First", "last:First", "first:Reentrant", "last:Reentrant"]);

        disposeScene(scene);
    });

    it("returns idempotent disposal unsubscriptions and attempts every cleanup", () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const skipped = vi.fn();
        const firstFailure = new Error("first cleanup failed");
        const secondFailure = new Error("second cleanup failed");
        const unsubscribe = onSceneDispose(scene, skipped);
        const completed = vi.fn();
        onSceneDispose(scene, () => {
            throw firstFailure;
        });
        onSceneDispose(scene, completed);
        onSceneDispose(scene, () => {
            throw secondFailure;
        });

        unsubscribe();
        unsubscribe();

        expect(() => disposeScene(scene)).toThrow(
            expect.objectContaining({
                errors: [firstFailure, secondFailure],
            })
        );
        expect(skipped).not.toHaveBeenCalled();
        expect(completed).toHaveBeenCalledOnce();
        expect(scene._disposables).toEqual([]);
    });

    it("unsubscribes only the selected duplicate disposal registration", () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const calls: string[] = [];
        const duplicate = () => calls.push("duplicate");

        onSceneDispose(scene, duplicate);
        onSceneDispose(scene, () => calls.push("middle"));
        const unsubscribeLast = onSceneDispose(scene, duplicate);

        unsubscribeLast();
        disposeScene(scene);

        expect(calls).toEqual(["duplicate", "middle"]);
    });

    it("clears retained scene-change state during disposal without affecting other scenes", () => {
        const engine = createNullEngine();
        const disposedScene = createSceneContext(engine, { defaultRenderTask: false });
        const liveScene = createSceneContext(engine, { defaultRenderTask: false });
        const disposedListener = vi.fn();
        const liveListener = vi.fn();
        const unsubscribe = onSceneChange(disposedScene, disposedListener);
        onSceneChange(disposedScene, vi.fn());
        onSceneChange(liveScene, liveListener);
        const disposedState = disposedScene._sceneChanges!;
        const liveEntity = createTransformNode("Live");

        disposeScene(disposedScene);
        unsubscribe();
        unsubscribe();
        addToScene(liveScene, liveEntity);

        expect(disposedState.listeners.size).toBe(0);
        expect(disposedState.pending).toEqual([]);
        expect(disposedScene._sceneChanges).toBeUndefined();
        expect(liveListener).toHaveBeenCalledWith({ type: "added", entity: liveEntity });

        disposeScene(liveScene);
    });

    it("stops listeners and queued events when disposal occurs during dispatch", () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const first = createTransformNode("First");
        const queued = createTransformNode("Queued");
        const events: string[] = [];
        const laterListener = vi.fn();

        onSceneChange(scene, (event) => {
            events.push("name" in event.entity ? (event.entity.name ?? "unnamed") : "container");
            addToScene(scene, queued);
            disposeScene(scene);
        });
        onSceneChange(scene, laterListener);

        addToScene(scene, first);

        expect(events).toEqual(["First"]);
        expect(laterListener).not.toHaveBeenCalled();
        expect(scene._sceneChanges).toBeUndefined();
    });
});
