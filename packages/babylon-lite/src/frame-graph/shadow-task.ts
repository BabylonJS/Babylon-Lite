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

interface ShadowInputLoad {
    casterMeshes: readonly Mesh[];
    // Three references per caster: qualifying skeleton, morph targets, thin instances.
    // Tracking the references catches features added inside an unchanged caster array.
    boundsInputs: readonly unknown[];
    ready: boolean;
    promise: Promise<void>;
}

const SKINNED_CASTER_BOUNDS = 1;
const MORPH_CASTER_BOUNDS = 2;
const THIN_INSTANCE_CASTER_BOUNDS = 4;

let shadowInputLoads: WeakMap<ShadowGenerator, ShadowInputLoad> | null = null;

function ensureShadowInputReady(shadowGenerator: ShadowGenerator, casterMeshes: readonly Mesh[]): boolean {
    const load = shadowInputLoads?.get(shadowGenerator);
    if (!load || !shadowInputMatches(load, casterMeshes)) {
        // record/execute are synchronous, so start the scheduler-owned preload without
        // awaiting it and gate rendering until a later call observes the completed load.
        void preloadShadowTaskInput(shadowGenerator, casterMeshes);
        return false;
    }
    return load.ready;
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
                const casterMeshes = sg ? _getShadowTaskCasterMeshes(sg) : null;
                if (sg?._preloadShadowTask && casterMeshes) {
                    shadowGenerators.add(sg);
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
                if (sg?._ensureShadowTaskState && casterMeshes && ensureShadowInputReady(sg, casterMeshes)) {
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
                if (sg?._ensureShadowTaskState && sg._renderShadowMap && casterMeshes && ensureShadowInputReady(sg, casterMeshes)) {
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

function preloadShadowTaskInput(shadowGenerator: ShadowGenerator, casterMeshes: readonly Mesh[]): Promise<void> {
    // Runs when a generator's caster set is (re)supplied (e.g. the Viewer wiring casters after a model
    // load), and when an existing caster gains deformable or thin-instance data. The registration-time
    // `_preload` above awaits the same load, so scenes built through it are correct from frame one.
    const existing = shadowInputLoads?.get(shadowGenerator);
    if (existing && shadowInputMatches(existing, casterMeshes)) {
        return existing.promise;
    }
    const { boundsFeatures, boundsInputs } = captureShadowInputFeatures(casterMeshes);
    const promise = Promise.all([shadowGenerator._preloadShadowTask?.(casterMeshes), preloadOptionalCasterBounds(casterMeshes, boundsFeatures)]).then(() => {
        const current = shadowInputLoads?.get(shadowGenerator);
        // A newer input may have started loading while this promise was pending. Only the
        // promise still registered for the generator is allowed to open the rendering gate.
        if (current?.promise === promise) {
            current.ready = true;
        }
    });
    const load: ShadowInputLoad = { casterMeshes, boundsInputs, ready: false, promise };
    (shadowInputLoads ??= new WeakMap()).set(shadowGenerator, load);
    return promise;
}

function deformableSkeleton(mesh: Mesh): Mesh["skeleton"] | undefined {
    const skeleton = mesh.skeleton;
    // A skeleton object alone is not enough: posed CPU bounds require both vertex
    // influences and the current CPU bone-matrix mirror.
    return skeleton && skeleton.weights && skeleton.boneMatrices ? skeleton : undefined;
}

function shadowInputMatches(load: ShadowInputLoad, casterMeshes: readonly Mesh[]): boolean {
    if (load.casterMeshes !== casterMeshes || load.boundsInputs.length !== casterMeshes.length * 3) {
        return false;
    }
    for (let i = 0; i < casterMeshes.length; i++) {
        const mesh = casterMeshes[i]!;
        const offset = i * 3;
        if (load.boundsInputs[offset] !== deformableSkeleton(mesh) || load.boundsInputs[offset + 1] !== mesh.morphTargets || load.boundsInputs[offset + 2] !== mesh.thinInstances) {
            return false;
        }
    }
    return true;
}

function captureShadowInputFeatures(casterMeshes: readonly Mesh[]): { boundsFeatures: number; boundsInputs: unknown[] } {
    let boundsFeatures = 0;
    // Allocate the snapshot only when inputs change; matching record/execute calls scan it
    // allocation-free in shadowInputMatches.
    const boundsInputs = new Array<unknown>(casterMeshes.length * 3);
    for (let i = 0; i < casterMeshes.length; i++) {
        const mesh = casterMeshes[i]!;
        const skeleton = deformableSkeleton(mesh);
        const offset = i * 3;
        boundsInputs[offset] = skeleton;
        boundsInputs[offset + 1] = mesh.morphTargets;
        boundsInputs[offset + 2] = mesh.thinInstances;
        if (skeleton) {
            boundsFeatures |= SKINNED_CASTER_BOUNDS;
        }
        if (mesh.morphTargets) {
            boundsFeatures |= MORPH_CASTER_BOUNDS;
        }
        if (mesh.thinInstances) {
            boundsFeatures |= THIN_INSTANCE_CASTER_BOUNDS;
        }
    }
    return { boundsFeatures, boundsInputs };
}

function preloadOptionalCasterBounds(casterMeshes: readonly Mesh[], boundsFeatures: number): Promise<void> {
    const loads: Promise<void>[] = [];
    // These imports install synchronous implementations into caster-world-aabb. Keeping
    // import ownership here makes record-time bounds lookup side-effect free.
    if (boundsFeatures & SKINNED_CASTER_BOUNDS) {
        loads.push(import("../shadow/skinned-caster-aabb.js").then((mod) => mod.enableSkinnedCasterAabb(casterMeshes)));
    }
    if (boundsFeatures & MORPH_CASTER_BOUNDS) {
        loads.push(import("../shadow/morph-caster-aabb.js").then((mod) => mod.enableMorphCasterAabb(casterMeshes)));
    }
    if (boundsFeatures & THIN_INSTANCE_CASTER_BOUNDS) {
        loads.push(import("../shadow/thin-caster-aabb.js").then((mod) => mod.enableThinCasterAabb()));
    }
    return Promise.all(loads).then(() => {});
}
