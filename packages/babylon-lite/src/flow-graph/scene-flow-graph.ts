// Scene attachment for flow-graph runtimes. Byte-neutral for non-interactivity
// scenes: this module is only pulled into a bundle when something imports it
// (the glTF KHR_interactivity feature, or explicit user code). It drives graphs
// through the scene's generic `onBeforeRender` / `onSceneDispose` seams instead
// of hardcoding a loop in scene-core (GUIDANCE §4c′ — always extensions).

import { onBeforeRender, onSceneDispose, type SceneContext } from "../scene/scene-core.js";
import type { FgRuntime } from "./runtime.js";
import { advanceFlowGraphTasks, createFgRuntime, disposeFlowGraph, pumpFlowGraphTick, startFlowGraphs } from "./runtime.js";
import type { AnimationGroup } from "../animation/animation-group.js";
import { playAnimation as agPlay, stopAnimation as agStop, goToFrame as agGoToFrame } from "../animation/animation-group.js";
import type { FgCapabilities, FgWiring, LoadedFlowGraph } from "./context.js";
import type { FgEventBus } from "./event-bus.js";
import { clearFgEventBus, createFgEventBus, flushFgEvents, pumpFgEvent } from "./event-bus.js";
import { FgEventType } from "./types.js";
import type { FgGraph, FgValue } from "./types.js";

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
    ensureFlowGraphCoordinator(scene);
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
    if (list?.length === 0) {
        removeFlowGraphCoordinator(scene);
    }
}

function ensureFlowGraphCoordinator(scene: SceneContext): void {
    if (scene._flowGraphTick) {
        return;
    }
    const tick = (deltaMs: number) => {
        const runtimes = scene._flowGraphs?.slice() ?? [];
        const eventBuses = new Set(runtimes.map((runtime) => runtime.env.events));
        eventBuses.forEach(flushFgEvents);
        const isAttached = (runtime: FgRuntime) => scene._flowGraphs?.includes(runtime) ?? false;
        startFlowGraphs(runtimes, isAttached);
        for (const runtime of runtimes) {
            if (isAttached(runtime)) {
                pumpFlowGraphTick(runtime, deltaMs);
            }
        }
        for (const runtime of runtimes) {
            if (isAttached(runtime)) {
                advanceFlowGraphTasks(runtime, deltaMs);
            }
        }
    };
    const dispose = () => {
        const runtimes = scene._flowGraphs?.splice(0) ?? [];
        runtimes.forEach(disposeFlowGraph);
        removeFlowGraphCoordinator(scene);
    };
    scene._flowGraphTick = tick;
    scene._flowGraphDispose = dispose;
    onBeforeRender(scene, tick);
    onSceneDispose(scene, dispose);
}

function removeFlowGraphCoordinator(scene: SceneContext): void {
    const tick = scene._flowGraphTick;
    if (tick) {
        const index = scene._beforeRender.indexOf(tick);
        if (index >= 0) {
            scene._beforeRender.splice(index, 1);
        }
    }
    const dispose = scene._flowGraphDispose;
    if (dispose) {
        const index = scene._disposables.indexOf(dispose);
        if (index >= 0) {
            scene._disposables.splice(index, 1);
        }
    }
    scene._flowGraphTick = undefined;
    scene._flowGraphDispose = undefined;
    if (scene._flowGraphBus) {
        clearFgEventBus(scene._flowGraphBus);
        scene._flowGraphBus = undefined;
    }
}

/** The flow-graph runtimes currently attached to `scene` (read-only snapshot). */
export function flowGraphRuntimes(scene: SceneContext): readonly FgRuntime[] {
    return scene._flowGraphs ?? [];
}

/** Get (or lazily create) the scene-scoped event bus shared by every flow graph
 *  attached to `scene`. Sharing one bus lets graphs exchange custom events
 *  (BJS `FlowGraphSceneEventCoordinator`). */
export function flowGraphBus(scene: SceneContext): FgEventBus {
    let bus = scene._flowGraphBus;
    if (!bus) {
        bus = createFgEventBus();
        scene._flowGraphBus = bus;
    }
    return bus;
}

/** Imperatively build, attach, and drive a flow graph on a scene WITHOUT a glTF
 *  asset (BJS `FlowGraphCoordinator.addFlowGraph` + run). Defaults to the
 *  scene-owned animation caps and the shared scene bus (so it can exchange custom
 *  events with other graphs); both are overridable via `wiring`. The runtime
 *  starts on the next frame and auto-disposes on scene dispose. */
export async function addFlowGraph(scene: SceneContext, graph: FgGraph, wiring: FgWiring = {}, opts?: { rightHanded?: boolean }): Promise<FgRuntime> {
    const rt = await createFgRuntime(
        graph,
        {
            caps: sceneAnimationCaps(),
            ...wiring,
            events: wiring.events ?? flowGraphBus(scene),
        },
        opts
    );
    attachFlowGraph(scene, rt);
    return rt;
}

/** Dispatch a custom event into every graph attached to `scene` (delivered to
 *  matching `ReceiveCustomEvent` blocks on the shared scene bus). */
export function dispatchFlowGraphEvent(scene: SceneContext, eventId: string, values: Record<string, FgValue> = {}): void {
    pumpFgEvent(flowGraphBus(scene), FgEventType.CustomEvent, { eventName: eventId, values });
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
    const events = flowGraphBus(scene);
    const runtimes: FgRuntime[] = [];
    for (const lg of loaded) {
        const resolveAccessor = lg.resolveAccessor ? (pointer: string) => lg.resolveAccessor!(pointer, scene, animations) : undefined;
        const rt = await createFgRuntime(lg.graph, { accessors: { ...lg.accessors }, resolveAccessor, animations, caps, events }, { rightHanded: lg.rightHanded ?? true });
        attachFlowGraph(scene, rt);
        runtimes.push(rt);
    }
    return runtimes;
}
