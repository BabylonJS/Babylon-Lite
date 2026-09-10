import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";
import { setShadowTaskCasterMeshes } from "../../../packages/babylon-lite/src/frame-graph/shadow-inputs";
import { createShadowTask } from "../../../packages/babylon-lite/src/frame-graph/shadow-task";
import { getNoColorView, preloadPcfShadowTaskState } from "../../../packages/babylon-lite/src/shadow/pcf-shadow-task-hooks";

type Preload = (casterMeshes: readonly Mesh[]) => Promise<void>;

/**
 * A generator whose no-colour view import is driven by the test through `_preloadShadowTask`, plus a spy on
 * its state builder. The preloader that parks the set is the real one: `createShadowTask` installs it for
 * the runtime re-supply path and uses it for the registration preload.
 */
function makeGenerator(preloadShadowTask: Preload = () => Promise.resolve()) {
    const ensureState = vi.fn(() => ({ _task: { record: vi.fn(), dispose: vi.fn() }, _casterMeshes: [] }));
    const renderShadowMap = vi.fn(() => 1);
    const sg = {
        _preloadShadowTask: preloadShadowTask,
        _ensureShadowTaskState: ensureState,
        _renderShadowMap: renderShadowMap,
        _shadowTaskState: undefined,
    } as unknown as ShadowGenerator;
    const scene = { lights: [{ shadowGenerator: sg }], _renderableVersion: 1 } as unknown as SceneContext;
    const task = createShadowTask({} as EngineContext, scene);
    return { sg, task, ensureState, renderShadowMap };
}

/** A per-set import the test releases by hand. */
function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { promise, release };
}

async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe("shadow caster preload race", () => {
    it("keeps a generator out of the frame until its runtime caster preload resolves", async () => {
        const preload = gate();
        const { sg } = makeGenerator(() => preload.promise);

        setShadowTaskCasterMeshes(sg, [{} as Mesh]);

        // The dynamic import for this caster family has not landed yet: rendering now would reach a
        // no-colour material factory that is still undefined.
        expect(sg._preloadPending).toBeDefined();

        preload.release();
        await settle();

        expect(sg._preloadPending).toBeUndefined();
    });

    it("does not build or render shadow state for a generator whose preload is still in flight", async () => {
        const preload = gate();
        const { sg, task, ensureState, renderShadowMap } = makeGenerator(() => preload.promise);

        setShadowTaskCasterMeshes(sg, [{} as Mesh]);

        expect(task.execute?.()).toBe(0);
        expect(ensureState).not.toHaveBeenCalled();
        expect(renderShadowMap).not.toHaveBeenCalled();

        preload.release();
        await settle();

        expect(task.execute?.()).toBe(1);
        expect(renderShadowMap).toHaveBeenCalledTimes(1);
    });

    it("keeps the generator skipped and reports the failure when the preload rejects", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const { sg } = makeGenerator(() => Promise.reject(new Error("no-colour view import failed")));

        setShadowTaskCasterMeshes(sg, [{} as Mesh]);
        await settle();

        // Rendering with a missing factory would throw inside the frame; staying skipped is the safe state.
        expect(sg._preloadPending).toBeDefined();
        expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: "no-colour view import failed" }));
        error.mockRestore();
    });

    it("does not let a superseded caster set clear the pending flag of the one that replaced it", async () => {
        const first = gate();
        const second = gate();
        let call = 0;
        const { sg } = makeGenerator(() => (call++ === 0 ? first.promise : second.promise));

        setShadowTaskCasterMeshes(sg, [{} as Mesh]);
        const secondSet = [{} as Mesh];
        setShadowTaskCasterMeshes(sg, secondSet);

        // The first set resolving must not unblock the generator: the views for the SECOND set are the
        // ones the next frame will need.
        first.release();
        await settle();
        expect(sg._preloadPending).toBe(secondSet);

        second.release();
        await settle();
        expect(sg._preloadPending).toBeUndefined();
    });

    it("preloads the family of an explicit shadow-caster override, not the receive material", async () => {
        // `getNoColorView` recurses into `_shadowCasterMaterial`, so the OVERRIDE's family is the one whose
        // factory must be imported. Scanning only `mesh.material` left it undefined and the shadow pass
        // then called an unassigned factory.
        const override = { _buildGroup: { _materialFamily: "pbr" } } as unknown as Material;
        const receive = { _buildGroup: { _materialFamily: "standard" }, _shadowCasterMaterial: override } as unknown as Material;
        const mesh = { material: receive } as unknown as Mesh;

        await preloadPcfShadowTaskState([mesh]);

        let thrown: unknown;
        try {
            getNoColorView(receive, new Map());
        } catch (error) {
            thrown = error;
        }
        // The PBR factory must have been imported. Building the view can still fail on this stub material,
        // but never because the factory itself is missing.
        expect(String(thrown ?? "")).not.toContain("is not a function");
    });
});

describe("shadow caster preload during scene registration", () => {
    /**
     * The first `_preloadShadowTask` call belongs to the runtime registration of `casters` and resolves at
     * once, so the park is lifted before the test starts; every later call is driven by `next`.
     */
    function makeRegisteringGenerator(next: Preload) {
        let first = true;
        return makeGenerator((casterMeshes) => {
            if (first) {
                first = false;
                return Promise.resolve();
            }
            return next(casterMeshes);
        });
    }

    async function registerCasters(sg: ShadowGenerator, casters: readonly Mesh[]): Promise<void> {
        setShadowTaskCasterMeshes(sg, casters);
        await settle();
        expect(sg._preloadPending).toBeUndefined();
    }

    it("parks the caster set on the generator until the registration preload resolves", async () => {
        const preload = gate();
        const { sg, task, ensureState } = makeRegisteringGenerator(() => preload.promise);
        const casters = [{} as Mesh];
        await registerCasters(sg, casters);

        // Registration: `_preload()` is awaited, but the scene is already `_built`, so an application
        // rebuild can call `record()` in the meantime. The generator must stay parked until the import lands.
        const preloading = task._preload!();
        expect(sg._preloadPending).toBe(casters);
        task.record();
        expect(ensureState).not.toHaveBeenCalled();

        preload.release();
        await preloading;
        expect(sg._preloadPending).toBeUndefined();
        task.record();
        expect(ensureState).toHaveBeenCalledTimes(1);
    });

    it("lets a runtime re-supply supersede an in-flight registration preload", async () => {
        const gates = new Map<readonly Mesh[], ReturnType<typeof gate>>();
        const { sg, task, ensureState } = makeRegisteringGenerator((casterMeshes) => {
            const g = gate();
            gates.set(casterMeshes, g);
            return g.promise;
        });
        const first = [{} as Mesh];
        const second = [{} as Mesh];
        await registerCasters(sg, first);

        const preloading = task._preload!();
        expect(sg._preloadPending).toBe(first);
        // The application re-supplies the casters while registration is still importing the first set.
        setShadowTaskCasterMeshes(sg, second);
        expect(sg._preloadPending).toBe(second);

        // The older preload landing must not lift the park that now belongs to the newer set.
        gates.get(first)!.release();
        await preloading;
        expect(sg._preloadPending).toBe(second);
        task.record();
        expect(ensureState).not.toHaveBeenCalled();

        gates.get(second)!.release();
        await settle();
        expect(sg._preloadPending).toBeUndefined();
        task.record();
        expect(ensureState).toHaveBeenCalledTimes(1);
    });

    it("keeps the set parked and rejects registration when the preload fails", async () => {
        const { sg, task, ensureState } = makeRegisteringGenerator(() => Promise.reject(new Error("no-colour view import failed")));
        const casters = [{} as Mesh];
        await registerCasters(sg, casters);

        await expect(task._preload!()).rejects.toThrow("no-colour view import failed");
        // The factory is still missing: the generator stays out of the frame rather than throwing inside it.
        expect(sg._preloadPending).toBe(casters);
        task.record();
        expect(ensureState).not.toHaveBeenCalled();
    });
});
