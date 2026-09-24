/**
 * ShadowTask — scene-owned frame-graph dispatcher for shadow-map generation.
 *
 * Filter-specific renderer code is owned by each ShadowGenerator through
 * internal hooks, keeping this scheduler filter-agnostic.
 */

import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Mesh } from "../mesh/mesh.js";
import type { ShadowGenerator } from "../shadow/shadow-generator.js";
import type { Task } from "./task.js";
import { _getShadowTaskCasterMeshes, _setShadowTaskInputPreloader } from "./shadow-inputs.js";

/** Scene-owned frame-graph task that schedules shadow-map generation across the scene's shadow generators. */
export interface ShadowTask extends Task {
    readonly name: "shadow";
}

/** @internal Create the scene-owned shadow scheduling adapter task. */
export function createShadowTask(engine: EngineContext, scene: SceneContext): ShadowTask {
    const shadowGenerators = new Set<ShadowGenerator>();
    _setShadowTaskInputPreloader(preloadShadowTaskInput);

    const task: ShadowTask = {
        name: "shadow",
        engine,
        scene,
        _passes: [],
        async _preload(): Promise<void> {
            const loads: Promise<void>[] = [];
            for (const light of scene.lights) {
                const sg = light.shadowGenerator;
                const casterMeshes = sg ? _getShadowTaskCasterMeshes(sg) : null;
                if (sg?._preloadShadowTask && casterMeshes) {
                    // Registration awaits this preload, but the scene is already `_built` by then: a rebuild
                    // the application triggers during the await (material swap, mesh added) runs
                    // `frameGraph.build()` → `record()` and would call a family factory that is still
                    // undefined. `preloadShadowTaskInput` parks the set exactly like a runtime re-supply, and a
                    // failed import rejects registration with the set still parked.
                    loads.push(preloadShadowTaskInput(sg, casterMeshes));
                }
            }
            await Promise.all(loads);
        },
        record(): void {
            task._passes.length = 0;
            for (const light of scene.lights) {
                const sg = light.shadowGenerator;
                const casterMeshes = sg ? _getShadowTaskCasterMeshes(sg) : null;
                if (sg?._ensureShadowTaskState && casterMeshes && !sg._preloadPending) {
                    shadowGenerators.add(sg);
                    const state = sg._ensureShadowTaskState(engine, scene, casterMeshes);
                    const version = scene._renderableVersion;
                    state._task.record();
                    state._recordedVersion = version;
                }
            }
        },
        execute(): number {
            let draws = 0;
            for (const light of scene.lights) {
                const sg = light.shadowGenerator;
                const casterMeshes = sg ? _getShadowTaskCasterMeshes(sg) : null;
                // A caster set supplied at runtime may still be importing the no-colour material views for
                // a family it just introduced. Skip the generator until that lands — the shadow map keeps
                // its previous contents for a frame instead of the pass throwing on an unassigned factory.
                if (sg?._ensureShadowTaskState && sg._renderShadowMap && casterMeshes && !sg._preloadPending) {
                    shadowGenerators.add(sg);
                    const existing = sg._shadowTaskState ?? null;
                    const state = sg._ensureShadowTaskState(engine, scene, casterMeshes);
                    if (state !== existing || state._recordedVersion !== scene._renderableVersion) {
                        const version = scene._renderableVersion;
                        state._task.record();
                        state._recordedVersion = version;
                    }
                    draws += sg._renderShadowMap(engine, state);
                }
            }
            return draws;
        },
        dispose(): void {
            task._passes.length = 0;
            for (const sg of shadowGenerators) {
                const state = sg._shadowTaskState;
                if (state) {
                    state._task.dispose();
                    sg._shadowTaskState = undefined;
                }
            }
            shadowGenerators.clear();
        },
    };
    return task;
}

/**
 * Park `casterMeshes` on the generator while the no-colour material views for its caster families
 * import — rendering before that would call a factory that is still undefined, so `record`/`execute`
 * skip a parked generator — then lift the park, only on success and only if no newer set superseded
 * this one meanwhile. A rejected import leaves the set parked: the factory is still missing, and
 * rendering anyway would throw inside the frame with a far less actionable stack. Shared by the
 * registration preload above, which awaits it, and — installed through `_setShadowTaskInputPreloader` —
 * by the runtime re-supply in `setShadowTaskCasterMeshes`, which cannot.
 */
async function preloadShadowTaskInput(shadowGenerator: ShadowGenerator, casterMeshes: readonly Mesh[]): Promise<void> {
    shadowGenerator._preloadPending = casterMeshes;
    await shadowGenerator._preloadShadowTask?.(casterMeshes);
    if (shadowGenerator._preloadPending === casterMeshes) {
        shadowGenerator._preloadPending = undefined;
    }
}
