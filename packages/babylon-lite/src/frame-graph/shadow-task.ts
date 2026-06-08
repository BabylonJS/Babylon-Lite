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
    // Last scene renderable-version each generator's render bundle was recorded at — re-record when the
    // scene mutated (e.g. resizeMeshGeometry reallocated a caster's GPU buffers, bumping
    // scene._renderableVersion), since the cached bundle binds raw buffer handles that would otherwise
    // point at freed buffers.
    const recordedVersion = new WeakMap<ShadowGenerator, number>();
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
                    shadowGenerators.add(sg);
                    loads.push(sg._preloadShadowTask(casterMeshes));
                }
            }
            await Promise.all(loads);
        },
        record(): void {
            task._passes.length = 0;
            for (const light of scene.lights) {
                const sg = light.shadowGenerator;
                const casterMeshes = sg ? _getShadowTaskCasterMeshes(sg) : null;
                if (sg?._ensureShadowTaskState && casterMeshes) {
                    shadowGenerators.add(sg);
                    const state = sg._ensureShadowTaskState(engine, scene, casterMeshes);
                    state._task.record();
                }
            }
        },
        execute(): number {
            let draws = 0;
            for (const light of scene.lights) {
                const sg = light.shadowGenerator;
                const casterMeshes = sg ? _getShadowTaskCasterMeshes(sg) : null;
                if (sg?._ensureShadowTaskState && sg._renderShadowMap && casterMeshes) {
                    shadowGenerators.add(sg);
                    const existing = sg._shadowTaskState ?? null;
                    const state = sg._ensureShadowTaskState(engine, scene, casterMeshes);
                    if (!existing || existing._casterMeshes !== casterMeshes || recordedVersion.get(sg) !== scene._renderableVersion) {
                        state._task.record();
                        recordedVersion.set(sg, scene._renderableVersion);
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

async function preloadShadowTaskInput(shadowGenerator: ShadowGenerator, casterMeshes: readonly Mesh[]): Promise<void> {
    await shadowGenerator._preloadShadowTask?.(casterMeshes);
}
