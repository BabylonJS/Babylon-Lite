import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";
import { _setShadowTaskInputPreloader, setShadowTaskCasterMeshes } from "../../../packages/babylon-lite/src/frame-graph/shadow-inputs";
import { createShadowTask } from "../../../packages/babylon-lite/src/frame-graph/shadow-task";

/** A generator whose caster set is supplied at runtime, after the scene already booted. */
function makeGenerator(): ShadowGenerator {
    return {
        _preloadShadowTask: undefined,
        _ensureShadowTaskState: undefined,
        _renderShadowMap: undefined,
        _shadowTaskState: undefined,
    } as unknown as ShadowGenerator;
}

describe("shadow caster preload race", () => {
    it("keeps a generator out of the frame until its runtime caster preload resolves", async () => {
        const sg = makeGenerator();
        let releasePreload!: () => void;
        const preloaded = new Promise<void>((resolve) => (releasePreload = resolve));
        _setShadowTaskInputPreloader(() => preloaded);

        setShadowTaskCasterMeshes(sg, [{} as Mesh]);

        // The dynamic import for this caster family has not landed yet: rendering now would reach a
        // no-colour material factory that is still undefined.
        expect(sg._preloadPending).toBeDefined();

        releasePreload();
        await preloaded;
        await Promise.resolve();

        expect(sg._preloadPending).toBeUndefined();
    });

    it("does not build or render shadow state for a generator whose preload is still in flight", async () => {
        const sg = makeGenerator();
        const recordTask = vi.fn();
        const ensureState = vi.fn(() => ({ _task: { record: recordTask, dispose: vi.fn() }, _casterMeshes: [] }));
        const renderShadowMap = vi.fn(() => 1);
        const generator = sg as unknown as {
            _ensureShadowTaskState: unknown;
            _renderShadowMap: unknown;
        };
        generator._ensureShadowTaskState = ensureState;
        generator._renderShadowMap = renderShadowMap;

        const scene = { lights: [{ shadowGenerator: sg }], _renderableVersion: 1 } as unknown as SceneContext;
        // `createShadowTask` installs the real preloader, so the stub must be registered after it.
        const task = createShadowTask({} as EngineContext, scene);
        let releasePreload!: () => void;
        const preloaded = new Promise<void>((resolve) => (releasePreload = resolve));
        _setShadowTaskInputPreloader(() => preloaded);

        setShadowTaskCasterMeshes(sg, [{} as Mesh]);

        expect(task.execute?.()).toBe(0);
        expect(ensureState).not.toHaveBeenCalled();
        expect(renderShadowMap).not.toHaveBeenCalled();

        releasePreload();
        await preloaded;
        await Promise.resolve();
        await Promise.resolve();

        expect(task.execute?.()).toBe(1);
        expect(renderShadowMap).toHaveBeenCalledTimes(1);
    });

    it("keeps the generator skipped and reports the failure when the preload rejects", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const sg = makeGenerator();
        const rejected = Promise.reject(new Error("no-colour view import failed"));
        _setShadowTaskInputPreloader(() => rejected);

        setShadowTaskCasterMeshes(sg, [{} as Mesh]);
        await rejected.catch(() => undefined);
        await Promise.resolve();
        await Promise.resolve();

        // Rendering with a missing factory would throw inside the frame; staying skipped is the safe state.
        expect(sg._preloadPending).toBeDefined();
        expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: "no-colour view import failed" }));
        error.mockRestore();
    });
});
