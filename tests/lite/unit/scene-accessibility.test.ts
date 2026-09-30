import { describe, expect, it, vi } from "vitest";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import { createNullEngine } from "../../../packages/babylon-lite/src/engine/null-engine";
import { createHemisphericLight } from "../../../packages/babylon-lite/src/light/hemispheric";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { addToScene, createSceneContext, disposeScene, onSceneDispose } from "../../../packages/babylon-lite/src/scene/scene-core";
import { removeFromScene } from "../../../packages/babylon-lite/src/scene/scene-remove";
import { createSceneHtmlTwin } from "../../../packages/babylon-lite/src/scene/scene-html-twin";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import { setParent } from "../../../packages/babylon-lite/src/scene/set-parent";
import { onAccessibilityTreeChanged } from "../../../packages/babylon-lite/src/accessibility/accessibility-tree";
import { observeProperty } from "../../../packages/babylon-lite/src/accessibility/observe-property";
import {
    createSceneAccessibility,
    getAccessibilityNode,
    getAccessibilityTag,
    setAccessibilityParent,
    setAccessibilityTag,
    updateSceneAccessibility,
} from "../../../packages/babylon-lite/src/accessibility/scene-accessibility";

describe("scene accessibility", () => {
    it("rejects a headless projection after scene disposal without installing a binding", () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        disposeScene(scene);

        expect(() => createSceneAccessibility(scene)).toThrow(/disposed/i);
        expect(scene._accessibility).toBeUndefined();
    });

    it("rejects a missing DOM host before installing the scene binding", () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });

        expect(() => createSceneHtmlTwin(scene)).toThrow(/DOM canvas.*parent/i);
        expect(scene._accessibility).toBeUndefined();

        disposeScene(scene);
    });

    it("publishes immutable tags only after validation", async () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const source = createTransformNode("Mars");
        const aria = { "aria-live": "polite", "aria-hidden": false, "aria-disabled": true };
        setAccessibilityTag(source, { name: "Mars", hidden: false, disabled: true, aria });

        aria["aria-live"] = "assertive";
        expect(getAccessibilityTag(source)).toEqual({
            name: "Mars",
            hidden: false,
            disabled: true,
            aria: { "aria-live": "polite", "aria-hidden": false, "aria-disabled": true },
        });
        expect(Object.isFrozen(getAccessibilityTag(source))).toBe(true);
        expect(Object.isFrozen(getAccessibilityTag(source)?.aria)).toBe(true);

        const accessibility = createSceneAccessibility(scene, { roots: [source] });
        const snapshot = getAccessibilityTag(source);
        let notifications = 0;
        onAccessibilityTreeChanged(accessibility.tree, () => notifications++);

        expect(() => setAccessibilityTag(source, { aria: { label: "Invalid" } as never })).toThrow(/aria/i);
        expect(() => setAccessibilityTag(source, { hidden: true, aria: { "aria-hidden": false } })).toThrow(/conflict/i);
        expect(() => setAccessibilityTag(source, { disabled: true, aria: { "aria-disabled": false } })).toThrow(/conflict/i);
        expect(getAccessibilityTag(source)).toBe(snapshot);
        await Promise.resolve();
        expect(notifications).toBe(0);

        setAccessibilityTag(source, { hidden: true, disabled: false, aria: { "aria-hidden": true, "aria-disabled": false } });
        await Promise.resolve();
        expect(getAccessibilityTag(source)).toEqual({
            hidden: true,
            disabled: false,
            aria: { "aria-hidden": true, "aria-disabled": false },
        });
        expect(notifications).toBe(1);

        setAccessibilityTag(source, null);
        expect(getAccessibilityTag(source)).toBeNull();
        disposeScene(scene);
    });

    it("tracks passive metadata, hierarchy, visibility, and scene membership", async () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const accessibility = createSceneAccessibility(scene);
        const group = createTransformNode("Group");
        const child = createTransformNode("Child");

        setAccessibilityTag(group, { name: "Objects", role: "group" });
        setAccessibilityTag(child, {
            name: "Cube",
            description: "A red cube",
            role: "button",
            aria: { "aria-hidden": false, "aria-pressed": false },
        });
        setParent(child, group);
        addToScene(scene, group);
        await Promise.resolve();

        const childNode = getAccessibilityNode(accessibility, child)!;
        expect(childNode.parent).toBe(getAccessibilityNode(accessibility, group));
        expect(childNode.tag?.aria?.["aria-pressed"]).toBe(false);

        child.visible = false;
        await Promise.resolve();
        expect(childNode.hidden).toBe(true);
        expect(childNode.tag?.aria?.["aria-hidden"]).toBe(true);

        child.visible = true;
        child.name = "Renamed";
        setAccessibilityTag(child, { description: "Updated description", role: "img" });
        await Promise.resolve();
        expect(childNode).toMatchObject({
            hidden: false,
            tag: { description: "Updated description", role: "img" },
        });

        setAccessibilityTag(child, { role: "img" });
        await Promise.resolve();
        expect(childNode.tag).toEqual({ name: "Renamed", role: "img", aria: undefined });

        removeFromScene(scene, child);
        await Promise.resolve();
        expect(getAccessibilityNode(accessibility, child)).toBeUndefined();

        disposeScene(scene);
        expect(accessibility.tree.disposed).toBe(true);
    });

    it("includes lights that were added before the binding", () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const light = createHemisphericLight();
        setAccessibilityTag(light, { name: "Ambient light" });
        addToScene(scene, light);

        const accessibility = createSceneAccessibility(scene);

        expect(getAccessibilityNode(accessibility, light)?.tag?.name).toBe("Ambient light");
        disposeScene(scene);
    });

    it("reconciles direct scene-array edits without dropping hook-only or explicit roots", async () => {
        const engine = createNullEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const explicit = createTransformNode("Explicit");
        const hookOnly = createTransformNode("Hook only");
        const mesh = createTransformNode("Mesh") as unknown as Mesh;
        const light = createHemisphericLight();
        const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
        const accessibility = createSceneAccessibility(scene, { roots: [explicit] });

        addToScene(scene, hookOnly);
        await Promise.resolve();
        expect(getAccessibilityNode(accessibility, explicit)).toBeDefined();
        expect(getAccessibilityNode(accessibility, hookOnly)).toBeDefined();

        scene.meshes.push(mesh);
        scene.lights.push(light);
        scene.camera = camera;
        updateSceneAccessibility(accessibility);
        expect(getAccessibilityNode(accessibility, mesh)).toBeDefined();
        expect(getAccessibilityNode(accessibility, light)).toBeDefined();
        expect(getAccessibilityNode(accessibility, camera)).toBeDefined();

        scene.meshes.length = 0;
        scene.lights.length = 0;
        scene.camera = null;
        updateSceneAccessibility(accessibility);
        expect(getAccessibilityNode(accessibility, mesh)).toBeUndefined();
        expect(getAccessibilityNode(accessibility, light)).toBeUndefined();
        expect(getAccessibilityNode(accessibility, camera)).toBeUndefined();
        expect(getAccessibilityNode(accessibility, explicit)).toBeDefined();
        expect(getAccessibilityNode(accessibility, hookOnly)).toBeDefined();
        disposeScene(scene);
    });

    it("classifies scene additions without scanning retained arrays", async () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        createSceneAccessibility(scene);
        const meshIncludes = vi.spyOn(scene.meshes, "includes");
        const lightIncludes = vi.spyOn(scene.lights, "includes");

        addToScene(scene, createTransformNode("Hook only"));
        await Promise.resolve();

        expect(meshIncludes).not.toHaveBeenCalled();
        expect(lightIncludes).not.toHaveBeenCalled();
        disposeScene(scene);
    });

    it("routes the shared lifecycle hook to each scene projection", async () => {
        const engine = createNullEngine();
        const firstScene = createSceneContext(engine, { defaultRenderTask: false });
        const secondScene = createSceneContext(engine, { defaultRenderTask: false });
        const plainScene = createSceneContext(engine, { defaultRenderTask: false });
        const firstAccessibility = createSceneAccessibility(firstScene);
        const secondAccessibility = createSceneAccessibility(secondScene);
        const firstSource = createTransformNode("First");
        const secondSource = createTransformNode("Second");
        const plainSource = createTransformNode("Plain");

        addToScene(firstScene, firstSource);
        addToScene(secondScene, secondSource);
        addToScene(plainScene, plainSource);
        await Promise.resolve();

        expect(getAccessibilityNode(firstAccessibility, firstSource)).toBeDefined();
        expect(getAccessibilityNode(firstAccessibility, secondSource)).toBeUndefined();
        expect(getAccessibilityNode(secondAccessibility, secondSource)).toBeDefined();
        expect(getAccessibilityNode(secondAccessibility, firstSource)).toBeUndefined();
        expect(plainScene._accessibility).toBeUndefined();

        disposeScene(plainScene);
        disposeScene(firstScene);
        expect(firstAccessibility.tree.disposed).toBe(true);
        expect(secondAccessibility.tree.disposed).toBe(false);

        removeFromScene(secondScene, secondSource);
        await Promise.resolve();
        expect(getAccessibilityNode(secondAccessibility, secondSource)).toBeUndefined();
        disposeScene(secondScene);
    });

    it("creates new hierarchy bindings at their final semantic parent", async () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const accessibility = createSceneAccessibility(scene);
        const group = createTransformNode("Group");
        const children = Array.from({ length: 24 }, (_, index) => {
            const child = createTransformNode(`Child ${index}`);
            setParent(child, group);
            return child;
        });
        const roots = accessibility.tree._roots;
        const splice = roots.splice.bind(roots);
        let rootDetachCount = 0;
        roots.splice = ((start: number, deleteCount = roots.length - start, ...items: Array<(typeof roots)[number]>) => {
            if (deleteCount) {
                rootDetachCount += deleteCount;
            }
            return splice(start, deleteCount, ...items);
        }) as typeof roots.splice;

        addToScene(scene, group);
        await Promise.resolve();
        roots.splice = splice;

        expect(rootDetachCount).toBe(0);
        expect(getAccessibilityNode(accessibility, group)?.children).toHaveLength(children.length);
        disposeScene(scene);
    });

    it("excludes detached children beneath explicit roots and the active camera", async () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const explicitRoot = createTransformNode("Explicit root");
        const explicitChild = createTransformNode("Explicit child");
        const camera = createArcRotateCamera(0, 1, 10, { x: 0, y: 0, z: 0 });
        const cameraChild = createTransformNode("Camera child");
        setParent(explicitChild, explicitRoot);
        setParent(cameraChild, camera);
        scene.camera = camera;
        const accessibility = createSceneAccessibility(scene, { roots: [explicitRoot] });
        addToScene(scene, explicitChild);
        addToScene(scene, cameraChild);
        await Promise.resolve();

        removeFromScene(scene, explicitChild);
        removeFromScene(scene, cameraChild);
        await Promise.resolve();

        expect(explicitRoot.children).toContain(explicitChild);
        expect(camera.children).toContain(cameraChild);
        expect(explicitChild.parent).toBeNull();
        expect(cameraChild.parent).toBeNull();
        expect(getAccessibilityNode(accessibility, explicitChild)).toBeUndefined();
        expect(getAccessibilityNode(accessibility, cameraChild)).toBeUndefined();
        expect(getAccessibilityNode(accessibility, explicitRoot)).toBeDefined();
        expect(getAccessibilityNode(accessibility, camera)).toBeDefined();
        disposeScene(scene);
    });

    it("supports semantic grouping without changing transforms", async () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const group = createTransformNode("Semantic group");
        const child = createTransformNode("Child");
        const accessibility = createSceneAccessibility(scene);
        addToScene(scene, group);
        addToScene(scene, child);

        setAccessibilityParent(accessibility, child, group);
        await Promise.resolve();
        expect(getAccessibilityNode(accessibility, child)?.parent).toBe(getAccessibilityNode(accessibility, group));
        expect(child.parent).toBeNull();

        setAccessibilityParent(accessibility, child, undefined);
        await Promise.resolve();
        expect(getAccessibilityNode(accessibility, child)?.parent).toBeNull();

        setAccessibilityParent(accessibility, child, group);
        removeFromScene(scene, group);
        await Promise.resolve();
        expect(getAccessibilityNode(accessibility, group)).toBeUndefined();
        expect(getAccessibilityNode(accessibility, child)?.parent).toBeNull();

        addToScene(scene, group);
        await Promise.resolve();
        expect(getAccessibilityNode(accessibility, child)?.parent).toBeNull();

        setAccessibilityParent(accessibility, child, group);
        removeFromScene(scene, child);
        await Promise.resolve();
        addToScene(scene, child);
        await Promise.resolve();
        expect(getAccessibilityNode(accessibility, child)?.parent).toBeNull();
        disposeScene(scene);
    });

    it("reconciles a coalesced semantic parent reversal in final-parent order", async () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const parent = createTransformNode("Parent");
        const child = createTransformNode("Child");
        const accessibility = createSceneAccessibility(scene);
        addToScene(scene, parent);
        addToScene(scene, child);
        setAccessibilityParent(accessibility, child, parent);
        await Promise.resolve();

        setAccessibilityParent(accessibility, child, null);
        setAccessibilityParent(accessibility, parent, child);
        await Promise.resolve();

        const parentNode = getAccessibilityNode(accessibility, parent)!;
        const childNode = getAccessibilityNode(accessibility, child)!;
        expect(accessibility.tree.roots).toEqual([childNode]);
        expect(childNode.children).toEqual([parentNode]);
        expect(parentNode.parent).toBe(childNode);

        setAccessibilityTag(parent, { name: "Still usable" });
        await Promise.resolve();
        expect(parentNode.tag?.name).toBe("Still usable");
        disposeScene(scene);
    });

    it("reconciles a multilevel reversal and retains nodes after an intermediate parent leaves", async () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const first = createTransformNode("First");
        const second = createTransformNode("Second");
        const third = createTransformNode("Third");
        const accessibility = createSceneAccessibility(scene);
        addToScene(scene, first);
        addToScene(scene, second);
        addToScene(scene, third);
        setAccessibilityParent(accessibility, second, first);
        setAccessibilityParent(accessibility, third, second);
        await Promise.resolve();

        setAccessibilityParent(accessibility, third, null);
        setAccessibilityParent(accessibility, second, third);
        setAccessibilityParent(accessibility, first, second);
        await Promise.resolve();

        const firstNode = getAccessibilityNode(accessibility, first)!;
        const secondNode = getAccessibilityNode(accessibility, second)!;
        const thirdNode = getAccessibilityNode(accessibility, third)!;
        expect(accessibility.tree.roots).toEqual([thirdNode]);
        expect(thirdNode.children).toEqual([secondNode]);
        expect(secondNode.children).toEqual([firstNode]);

        removeFromScene(scene, second);
        await Promise.resolve();
        expect(getAccessibilityNode(accessibility, second)).toBeUndefined();
        expect(accessibility.tree.roots).toEqual([thirdNode, firstNode]);
        expect(firstNode.parent).toBeNull();
        expect(thirdNode.parent).toBeNull();
        disposeScene(scene);
    });

    it("rejects semantic cycles synchronously without changing the last valid tree", async () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const group = createTransformNode("Group");
        const child = createTransformNode("Child");
        const accessibility = createSceneAccessibility(scene);
        addToScene(scene, group);
        addToScene(scene, child);

        setAccessibilityParent(accessibility, child, group);
        await Promise.resolve();
        expect(() => setAccessibilityParent(accessibility, group, child)).toThrow(/cycle/i);
        expect(getAccessibilityNode(accessibility, group)?.parent).toBeNull();
        expect(getAccessibilityNode(accessibility, child)?.parent).toBe(getAccessibilityNode(accessibility, group));

        setAccessibilityTag(child, { name: "Still usable" });
        await Promise.resolve();
        expect(getAccessibilityNode(accessibility, child)?.tag?.name).toBe("Still usable");
        disposeScene(scene);
    });

    it("rejects cycles when restoring natural parentage without changing the valid override", async () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const naturalParent = createTransformNode("Natural parent");
        const child = createTransformNode("Child");
        setParent(child, naturalParent);
        const accessibility = createSceneAccessibility(scene);
        addToScene(scene, naturalParent);

        setAccessibilityParent(accessibility, child, null);
        setAccessibilityParent(accessibility, naturalParent, child);
        await Promise.resolve();
        expect(() => setAccessibilityParent(accessibility, child, undefined)).toThrow(/cycle/i);
        expect(getAccessibilityNode(accessibility, child)?.parent).toBeNull();
        expect(getAccessibilityNode(accessibility, naturalParent)?.parent).toBe(getAccessibilityNode(accessibility, child));

        setAccessibilityTag(naturalParent, { name: "Still usable" });
        await Promise.resolve();
        expect(getAccessibilityNode(accessibility, naturalParent)?.tag?.name).toBe("Still usable");
        disposeScene(scene);
    });

    it("completes canonical scene cleanup before surfacing accessibility disposal errors", () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const accessibility = createSceneAccessibility(scene);
        const cleanup = vi.fn();
        const failure = new Error("observer failed");
        onSceneDispose(scene, cleanup);
        onAccessibilityTreeChanged(accessibility.tree, () => {
            throw failure;
        });

        expect(() => disposeScene(scene)).toThrow(failure);
        expect(cleanup).toHaveBeenCalledOnce();
        expect(scene._accessibility).toBeUndefined();
        expect(scene._disposables).toEqual([]);
        expect(scene.meshes).toEqual([]);
        expect(scene.lights).toEqual([]);
    });

    it("disposes the accessibility projection when canonical scene cleanup throws", () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const source = createTransformNode("Observed");
        const accessibility = createSceneAccessibility(scene, { roots: [source] });
        const failure = new Error("canonical cleanup failed");
        onSceneDispose(scene, () => {
            throw failure;
        });

        expect(() => disposeScene(scene)).toThrow(failure);
        expect(accessibility._disposed).toBe(true);
        expect(accessibility.tree.disposed).toBe(true);
        expect(accessibility._bindings.size).toBe(0);
        expect(scene._accessibility).toBeUndefined();
        expect(scene._disposables).toEqual([]);
        expect(Object.getOwnPropertyDescriptor(source, "name")).toMatchObject({
            configurable: true,
            enumerable: true,
            writable: true,
            value: "Observed",
        });
    });

    it("aggregates canonical and accessibility disposal failures without losing undefined", () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const accessibility = createSceneAccessibility(scene);
        const observerFailure = new Error("observer failed");
        onSceneDispose(scene, () => {
            throw undefined;
        });
        onAccessibilityTreeChanged(accessibility.tree, () => {
            throw observerFailure;
        });

        let failure: unknown;
        try {
            disposeScene(scene);
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([undefined, observerFailure]);
        expect(accessibility._disposed).toBe(true);
        expect(accessibility.tree.disposed).toBe(true);
        expect(scene._accessibility).toBeUndefined();
        expect(scene._disposables).toEqual([]);
    });

    it("does not reconcile property changes queued during canonical scene cleanup", async () => {
        const scene = createSceneContext(createNullEngine(), { defaultRenderTask: false });
        const source = createTransformNode("Before cleanup");
        const accessibility = createSceneAccessibility(scene, { roots: [source] });
        const update = vi.fn();
        onAccessibilityTreeChanged(accessibility.tree, update);
        onSceneDispose(scene, () => {
            source.name = "During cleanup";
        });

        disposeScene(scene);
        await Promise.resolve();

        expect(accessibility.tree.disposed).toBe(true);
        expect(scene._accessibility).toBeUndefined();
        expect(update).toHaveBeenCalledOnce();
    });

    it("restores inherited accessors and retains ordinary data writes after observation", () => {
        let stored = "initial";
        const prototype = Object.create(null) as { value?: string };
        Object.defineProperty(prototype, "value", {
            configurable: true,
            get: () => stored,
            set: (value: string) => {
                stored = value;
            },
        });
        const accessorTarget = Object.create(prototype) as { value: string };
        const first = vi.fn();
        const second = vi.fn();
        const unsubscribeFirst = observeProperty(accessorTarget, "value", first);
        const unsubscribeSecond = observeProperty(accessorTarget, "value", second);

        accessorTarget.value = "updated";
        unsubscribeFirst();
        expect(Object.hasOwn(accessorTarget, "value")).toBe(true);
        unsubscribeSecond();

        expect(stored).toBe("updated");
        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
        expect(Object.hasOwn(accessorTarget, "value")).toBe(false);
        expect(accessorTarget.value).toBe("updated");

        const dataTarget = { value: "before" };
        const unsubscribeData = observeProperty(dataTarget, "value", vi.fn());
        dataTarget.value = "after";
        unsubscribeData();
        expect(Object.getOwnPropertyDescriptor(dataTarget, "value")).toMatchObject({
            configurable: true,
            enumerable: true,
            writable: true,
            value: "after",
        });
    });
});
