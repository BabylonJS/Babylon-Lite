import { describe, expect, it, vi } from "vitest";

import { createNullEngine } from "../../../packages/babylon-lite/src/engine/null-engine";
import { createSceneContext, disposeScene } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { SceneRenderableChangeEvent } from "../../../packages/babylon-lite/src/scene/scene-renderable-collection";
import {
    addTextRenderableToScene,
    getSceneTextRenderables,
    onSceneTextRenderablesChanged,
    removeTextRenderableFromScene,
} from "../../../packages/babylon-lite/src/text/text-renderable";
import type { TextRenderable } from "../../../packages/babylon-lite/src/text/text-renderable";
import {
    addBillboardSystemToScene,
    getSceneBillboardSystems,
    onSceneBillboardSystemsChanged,
    removeBillboardSystemFromScene,
} from "../../../packages/babylon-lite/src/sprite/billboard-scene";
import type { BillboardSpriteSystem } from "../../../packages/babylon-lite/src/sprite/billboard-sprite";
import { addDepthHostedSpriteLayerToScene, getSceneDepthHostedSpriteLayers } from "../../../packages/babylon-lite/src/sprite/sprite-scene";
import type { Sprite2DLayer } from "../../../packages/babylon-lite/src/sprite/sprite-2d";

const billboardBuilds = vi.hoisted(() => [] as { renderable: { order: number }; dispose: ReturnType<typeof vi.fn> }[]);
vi.mock("../../../packages/babylon-lite/src/sprite/billboard-renderable", () => ({
    buildBillboardRenderable: () => {
        const built = { renderable: { order: 200 }, dispose: vi.fn() };
        billboardBuilds.push(built);
        return built;
    },
}));

type Destroyable = { destroy: ReturnType<typeof vi.fn> };
type TextGpuMock = { _textU: Destroyable; _instanceBuf: Destroyable; _styleBuf: Destroyable };

function createText(name: string): TextRenderable & { name: string } {
    return { name, _gpu: null } as unknown as TextRenderable & { name: string };
}

function giveTextGpu(text: TextRenderable): TextGpuMock {
    const gpu = { _textU: { destroy: vi.fn() }, _instanceBuf: { destroy: vi.fn() }, _styleBuf: { destroy: vi.fn() } };
    (text as unknown as { _gpu: TextGpuMock })._gpu = gpu;
    return gpu;
}

function createScene(): SceneContext {
    return createSceneContext(createNullEngine(), { defaultRenderTask: false });
}

async function runDeferredBuilders(scene: SceneContext): Promise<void> {
    for (const build of scene._deferredBuilders.splice(0)) {
        await build();
    }
}

function runRetirements(scene: SceneContext): void {
    for (const retire of scene.surface.engine._retirements?.splice(0) ?? []) {
        retire();
    }
}

describe("scene custom-renderable collections", () => {
    it("allocates nothing until a family is used, and families stay independent", () => {
        const scene = createScene();
        expect(getSceneTextRenderables(scene)).toEqual([]);
        expect(scene._renderableCollections).toBeUndefined();

        const text = createText("a");
        addTextRenderableToScene(scene, text);

        expect(getSceneTextRenderables(scene)).toEqual([text]);
        expect(getSceneBillboardSystems(scene)).toEqual([]);
        expect(scene.meshes).toEqual([]);
        disposeScene(scene);
    });

    it("adds idempotently, reports removal results, keeps add order, and publishes only real changes", () => {
        const scene = createScene();
        const a = createText("a");
        const b = createText("b");
        const events: string[] = [];
        onSceneTextRenderablesChanged(scene, (event) => events.push(`${event.type}:${(event.entity as typeof a).name}`));

        addTextRenderableToScene(scene, a);
        addTextRenderableToScene(scene, a);
        addTextRenderableToScene(scene, b);
        expect(scene._deferredBuilders).toHaveLength(2);
        expect(getSceneTextRenderables(scene)).toEqual([a, b]);

        expect(removeTextRenderableFromScene(scene, a)).toBe(true);
        expect(removeTextRenderableFromScene(scene, a)).toBe(false);
        expect(removeTextRenderableFromScene(scene, createText("never"))).toBe(false);
        addTextRenderableToScene(scene, a);

        expect(getSceneTextRenderables(scene)).toEqual([b, a]);
        expect(events).toEqual(["added:a", "added:b", "removed:a", "added:a"]);
        disposeScene(scene);
    });

    it("returns a snapshot rather than live membership", () => {
        const scene = createScene();
        const a = createText("a");
        addTextRenderableToScene(scene, a);
        const snapshot = getSceneTextRenderables(scene);
        removeTextRenderableFromScene(scene, a);
        expect(snapshot).toEqual([a]);
        disposeScene(scene);
    });

    it("draws a member removed and re-added before build exactly once", async () => {
        const scene = createScene();
        const text = createText("a");
        addTextRenderableToScene(scene, text);
        removeTextRenderableFromScene(scene, text);
        addTextRenderableToScene(scene, text);

        await runDeferredBuilders(scene);

        expect(scene._renderables).toEqual([text]);
        disposeScene(scene);
    });

    it("does not draw a member removed before build", async () => {
        const scene = createScene();
        const text = createText("a");
        addTextRenderableToScene(scene, text);
        removeTextRenderableFromScene(scene, text);

        await runDeferredBuilders(scene);

        expect(scene._renderables).toEqual([]);
        disposeScene(scene);
    });

    it("never draws a member removed at any point while its attachment resolves", async () => {
        for (let ticks = 0; ticks < 8; ticks++) {
            const scene = createScene();
            const text = createText("a");
            addTextRenderableToScene(scene, text);
            const building = scene._deferredBuilders.splice(0).map((build) => build());
            for (let i = 0; i < ticks; i++) {
                await Promise.resolve();
            }
            removeTextRenderableFromScene(scene, text);
            await Promise.all(building);

            expect(scene._renderables, `removed after ${ticks} microtasks`).toEqual([]);
            disposeScene(scene);
        }
    });

    it("drops a removed member's disposal hook so add/remove cycles do not accumulate", async () => {
        const scene = createScene();
        const text = createText("a");
        const baseline = scene._disposables.length;
        for (let i = 0; i < 3; i++) {
            addTextRenderableToScene(scene, text);
            await runDeferredBuilders(scene);
            expect(scene._disposables).toHaveLength(baseline + 1);
            removeTextRenderableFromScene(scene, text);
            expect(scene._disposables).toHaveLength(baseline);
        }
        disposeScene(scene);
    });

    it("stops drawing a built member at once and releases its GPU record after in-flight frames", async () => {
        const scene = createScene();
        const text = createText("a");
        addTextRenderableToScene(scene, text);
        await runDeferredBuilders(scene);
        const gpu = giveTextGpu(text);
        const version = scene._renderableVersion;

        expect(removeTextRenderableFromScene(scene, text)).toBe(true);

        expect(scene._renderables).toEqual([]);
        expect(scene._renderableVersion).toBe(version + 1);
        // Detached now, so a re-add's next binding creates a fresh record instead of reusing this one.
        expect(text._gpu).toBeNull();
        expect(gpu._textU.destroy).not.toHaveBeenCalled();
        runRetirements(scene);
        expect(gpu._textU.destroy).toHaveBeenCalledOnce();
        expect(gpu._instanceBuf.destroy).toHaveBeenCalledOnce();
        expect(gpu._styleBuf.destroy).toHaveBeenCalledOnce();
        disposeScene(scene);
    });

    it("releases members on scene disposal without publishing removals", async () => {
        const scene = createScene();
        const text = createText("a");
        const listener = vi.fn();
        onSceneTextRenderablesChanged(scene, listener);
        addTextRenderableToScene(scene, text);
        await runDeferredBuilders(scene);
        const gpu = giveTextGpu(text);
        listener.mockClear();

        disposeScene(scene);

        expect(gpu._textU.destroy).toHaveBeenCalledOnce();
        expect(listener).not.toHaveBeenCalled();
        expect(getSceneTextRenderables(scene)).toEqual([]);
        expect(removeTextRenderableFromScene(scene, text)).toBe(false);
        expect(() => onSceneTextRenderablesChanged(scene, listener)).toThrow("Cannot observe a disposed scene.");
    });

    it("queues listener-made changes, isolates listener failures, and unsubscribes idempotently", () => {
        const scene = createScene();
        const a = createText("a");
        const b = createText("b");
        const seen: string[] = [];
        const failure = new Error("listener failed");
        onSceneTextRenderablesChanged(scene, (event: SceneRenderableChangeEvent<TextRenderable>) => {
            seen.push(`first:${event.type}:${(event.entity as typeof a).name}`);
            if (event.entity === a && event.type === "added") {
                addTextRenderableToScene(scene, b);
                throw failure;
            }
        });
        const unsubscribe = onSceneTextRenderablesChanged(scene, (event) => seen.push(`second:${event.type}:${(event.entity as typeof a).name}`));

        expect(() => addTextRenderableToScene(scene, a)).toThrow(failure);

        expect(seen).toEqual(["first:added:a", "second:added:a", "first:added:b", "second:added:b"]);
        expect(getSceneTextRenderables(scene)).toEqual([a, b]);
        unsubscribe();
        unsubscribe();
        removeTextRenderableFromScene(scene, b);
        expect(seen.at(-1)).toBe("first:removed:b");
        disposeScene(scene);
    });

    it("unregisters a billboard's pick source and retires its built resources on removal", async () => {
        const scene = createScene();
        const system = { count: 0 } as unknown as BillboardSpriteSystem;
        addBillboardSystemToScene(scene, system);
        addBillboardSystemToScene(scene, system);
        expect(scene._pickSources).toHaveLength(1);
        await runDeferredBuilders(scene);
        const built = billboardBuilds.at(-1)!;
        expect(scene._renderables).toEqual([built.renderable]);

        expect(removeBillboardSystemFromScene(scene, system)).toBe(true);

        expect(scene._pickSources).toHaveLength(0);
        expect(scene._renderables).toEqual([]);
        expect(built.dispose).not.toHaveBeenCalled();
        runRetirements(scene);
        expect(built.dispose).toHaveBeenCalledOnce();
        expect(getSceneBillboardSystems(scene)).toEqual([]);
        disposeScene(scene);
    });

    it("registers a billboard's pick source before publishing its addition", () => {
        const scene = createScene();
        const system = { count: 0 } as unknown as BillboardSpriteSystem;
        const pickSourcesSeen: number[] = [];
        onSceneBillboardSystemsChanged(scene, (event) => {
            pickSourcesSeen.push(scene._pickSources.length);
            if (event.type === "added") {
                removeBillboardSystemFromScene(scene, system);
            }
        });

        addBillboardSystemToScene(scene, system);

        expect(pickSourcesSeen).toEqual([1, 0]);
        expect(scene._pickSources).toHaveLength(0);
        expect(getSceneBillboardSystems(scene)).toEqual([]);
        disposeScene(scene);
    });

    it("rejects depth-less sprite layers without recording membership", () => {
        const scene = createScene();
        const layer = { depth: "none" } as unknown as Sprite2DLayer;
        expect(() => addDepthHostedSpriteLayerToScene(scene, layer)).toThrow('Depth-hosted sprites require depth != "none".');
        expect(getSceneDepthHostedSpriteLayers(scene)).toEqual([]);
        disposeScene(scene);
    });
});
