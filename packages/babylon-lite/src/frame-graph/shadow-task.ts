/**
 * ShadowTask — scene-owned frame-graph dispatcher for shadow-map generation.
 *
 * Filter-specific renderer code is owned by each ShadowGenerator through
 * internal hooks, keeping this scheduler filter-agnostic.
 */

import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { ShadowGenerator } from "../shadow/shadow-generator.js";
import { casterBoundsReady } from "../shadow/caster-world-aabb.js";
import type { Task } from "./task.js";
import { _getShadowTaskInput, _setShadowTaskInputPreloader, type ShadowTaskInput } from "./shadow-inputs.js";

function ensureShadowInputReady(shadowGenerator: ShadowGenerator, input: ShadowTaskInput): boolean {
    if (input.promise !== null || !input.casterMeshes.every(casterBoundsReady)) {
        // record/execute are synchronous, so start the scheduler-owned preload without
        // awaiting it and gate rendering until a later call observes the completed load.
        void preloadShadowTaskInput(shadowGenerator, input);
        return false;
    }
    return true;
}

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
                const input = sg ? _getShadowTaskInput(sg) : null;
                if (sg?._preloadShadowTask && input) {
                    shadowGenerators.add(sg);
                    loads.push(preloadShadowTaskInput(sg, input));
                }
            }
            await Promise.all(loads);
        },
        record(): void {
            task._passes.length = 0;
            for (const light of scene.lights) {
                const sg = light.shadowGenerator;
                const input = sg ? _getShadowTaskInput(sg) : null;
                if (sg?._ensureShadowTaskState && input && ensureShadowInputReady(sg, input)) {
                    shadowGenerators.add(sg);
                    const state = sg._ensureShadowTaskState(engine, scene, input.casterMeshes);
                    state._task.record();
                }
            }
        },
        execute(): number {
            let draws = 0;
            for (const light of scene.lights) {
                const sg = light.shadowGenerator;
                const input = sg ? _getShadowTaskInput(sg) : null;
                if (sg?._ensureShadowTaskState && sg._renderShadowMap && input && ensureShadowInputReady(sg, input)) {
                    shadowGenerators.add(sg);
                    const existing = sg._shadowTaskState ?? null;
                    const state = sg._ensureShadowTaskState(engine, scene, input.casterMeshes);
                    if (!existing || existing._casterMeshes !== input.casterMeshes || recordedVersion.get(sg) !== scene._renderableVersion) {
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

async function preloadShadowTaskInput(shadowGenerator: ShadowGenerator, input: ShadowTaskInput): Promise<void> {
    // Runs when a generator's caster set is (re)supplied (e.g. the Viewer wiring casters after a model
    // load), and when an existing caster gains deformable or thin-instance data. The registration-time
    // `_preload` above awaits the same load, so scenes built through it are correct from frame one.
    const casterMeshes = input.casterMeshes;
    if (input.promise === null && casterMeshes.every(casterBoundsReady)) {
        return;
    }
    if (input.promise) {
        return input.promise;
    }
    return (input.promise = Promise.all([
        shadowGenerator._preloadShadowTask!(casterMeshes),
        // These imports install synchronous implementations into caster-world-aabb.
        // Scheduler ownership keeps record-time bounds lookup side-effect free.
        casterMeshes.some((mesh) => mesh.skeleton?.weights && mesh.skeleton.boneMatrices) && import("../shadow/skinned-caster-aabb.js").then((mod) => mod.enable(casterMeshes)),
        casterMeshes.some((mesh) => mesh.morphTargets) && import("../shadow/morph-caster-aabb.js").then((mod) => mod.enable(casterMeshes)),
        casterMeshes.some((mesh) => mesh.thinInstances) && import("../shadow/thin-caster-aabb.js").then((mod) => mod.enable(casterMeshes)),
    ]).then(() => {
        input.promise = null;
    }));
}
