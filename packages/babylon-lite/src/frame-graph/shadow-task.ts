/**
 * ShadowTask — scene-owned frame-graph dispatcher for shadow-map generation.
 *
 * Filter-specific renderer code is owned by each ShadowGenerator through
 * internal hooks, keeping this scheduler filter-agnostic.
 */

import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { SceneContext, SceneContextInternal } from "../scene/scene-core.js";
import type { Mesh } from "../mesh/mesh.js";
import type { ShadowGenerator } from "../shadow/shadow-generator.js";
import type { Task } from "./task.js";
import { _getShadowTaskCasterMeshes, _setShadowTaskInputPreloader } from "./shadow-inputs.js";

export interface ShadowTask extends Task {
    readonly name: "shadow";
}

/** @internal Create the scene-owned shadow scheduling adapter task. */
export function createShadowTask(engine: EngineContext, scene: SceneContext): ShadowTask {
    const eng = engine as EngineContextInternal;
    const sc = scene as SceneContextInternal;
    const shadowGenerators = new Set<ShadowGenerator>();
    _setShadowTaskInputPreloader(preloadShadowTaskInput);

    const task: ShadowTask = {
        name: "shadow",
        engine: eng,
        scene: sc,
        _passes: [],
        async _preload(): Promise<void> {
            const loads: Promise<void>[] = [];
            for (const light of sc.lights) {
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
            for (const light of sc.lights) {
                const sg = light.shadowGenerator;
                const casterMeshes = sg ? _getShadowTaskCasterMeshes(sg) : null;
                if (sg?._ensureShadowTaskState && casterMeshes) {
                    shadowGenerators.add(sg);
                    const state = sg._ensureShadowTaskState(eng, sc, casterMeshes);
                    state._task.record();
                }
            }
        },
        execute(): number {
            let draws = 0;
            for (const light of sc.lights) {
                const sg = light.shadowGenerator;
                const casterMeshes = sg ? _getShadowTaskCasterMeshes(sg) : null;
                if (sg?._ensureShadowTaskState && sg._renderShadowMap && casterMeshes) {
                    shadowGenerators.add(sg);
                    const existing = sg._shadowTaskState ?? null;
                    const state = sg._ensureShadowTaskState(eng, sc, casterMeshes);
                    if (!existing || existing._casterMeshes !== casterMeshes) {
                        state._task.record();
                    }
                    draws += sg._renderShadowMap(eng, state);
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
