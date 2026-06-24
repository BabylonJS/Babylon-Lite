// Scene attachment for flow-graph runtimes. Byte-neutral for non-interactivity
// scenes: this module is only pulled into a bundle when something imports it
// (the glTF KHR_interactivity feature, or explicit user code). It drives graphs
// through the scene's generic `onBeforeRender` / `onSceneDispose` seams instead
// of hardcoding a loop in scene-core (GUIDANCE §4c′ — always extensions).

import { onBeforeRender, onSceneDispose, type SceneContext } from "../scene/scene-core.js";
import type { FgRuntime } from "./runtime.js";
import { createFgRuntime, disposeFlowGraph, startFlowGraph, tickFlowGraph } from "./runtime.js";
import type { AnimationGroup } from "../animation/animation-group.js";
import { playAnimation as agPlay, stopAnimation as agStop, goToFrame as agGoToFrame } from "../animation/animation-group.js";
import type { FgCapabilities, LoadedFlowGraph } from "./context.js";

/** Attach a flow-graph runtime to a scene. The runtime starts on the first
 *  frame (after which event listeners are live) and ticks every frame. The
 *  runtime is auto-disposed when the scene is disposed. */
export function attachFlowGraph(scene: SceneContext, rt: FgRuntime): void {
    let list = scene._flowGraphs;
    if (!list) {
        list = [];
        scene._flowGraphs = list;
    }
    list.push(rt);

    onBeforeRender(scene, (deltaMs: number) => {
        // Early-out if detached (the closure persists until scene dispose).
        if (!scene._flowGraphs || scene._flowGraphs.indexOf(rt) < 0) {
            return;
        }
        if (!rt.started) {
            startFlowGraph(rt);
        }
        tickFlowGraph(rt, deltaMs);
    });

    onSceneDispose(scene, () => detachFlowGraph(scene, rt));
}

/** Detach and dispose a flow-graph runtime previously attached to `scene`. */
export function detachFlowGraph(scene: SceneContext, rt: FgRuntime): void {
    const list = scene._flowGraphs;
    if (list) {
        const i = list.indexOf(rt);
        if (i >= 0) {
            list.splice(i, 1);
        }
    }
    disposeFlowGraph(rt);
}

/** Scene-owned animation capabilities backing the Play/Stop animation blocks.
 *  Pure delegation to the animation-group functions so blocks never import the
 *  scene. `from`/`to` frame-range playback is a Phase 3 refinement. */
function sceneAnimationCaps(): FgCapabilities {
    return {
        playAnimation: (group: AnimationGroup, opts) => {
            group.speedRatio = opts?.speed ?? 1;
            group.loopAnimation = opts?.loop ?? false;
            agPlay(group);
        },
        stopAnimation: (group: AnimationGroup) => agStop(group),
        // Halt at the requested frame (goToFrame sets currentTime + clears
        // isPlaying), leaving the target posed at that frame rather than reset.
        stopAnimationAt: (group: AnimationGroup, frame: number) => agGoToFrame(group, frame),
    };
}

/** Build + attach a runtime for every flow graph loaded onto a container. Binds
 *  the graph's pre-resolved accessors, the container's animation groups (indexed
 *  by glTF order), and scene-owned animation capabilities, then drives each
 *  runtime through the scene's frame loop. Returns the attached runtimes. */
export async function runFlowGraphs(scene: SceneContext, loaded: readonly LoadedFlowGraph[], animations: readonly AnimationGroup[] = []): Promise<FgRuntime[]> {
    const caps = sceneAnimationCaps();
    const runtimes: FgRuntime[] = [];
    for (const lg of loaded) {
        const rt = await createFgRuntime(lg.graph, { accessors: lg.accessors, animations, caps }, { rightHanded: true });
        attachFlowGraph(scene, rt);
        runtimes.push(rt);
    }
    return runtimes;
}
