// Per-execution MUTABLE state (`FgContext`) and per-graph RESOLVED capabilities
// (`FgEnv`) — both plain data. A def is stateless; everything mutable lives here
// keyed by block id. The loader wires `FgEnv` (accessors, animations, caps, bus)
// before the graph runs so blocks never touch the scene directly.

import type { AnimationGroup } from "../animation/animation-group.js";
import type { FgBlockDef } from "./block-def.js";
import type { FgEventBus } from "./event-bus.js";
import type { FgGraph, FgType, FgValue } from "./types.js";

/** Per-execution-instance MUTABLE state — plain data. */
export interface FgContext {
    /** Data transport slots: `${blockId}:${socket}` → last value the producer
     *  wrote. NOT a validity cache — producers recompute on every pull. */
    readonly connectionValues: Record<string, FgValue>;
    /** Per-block scratch: `${blockId}:${key}` → value (counters, async tokens,
     *  the data-pull resolving guard, last event payload). */
    readonly executionVariables: Record<string, unknown>;
    /** Live graph variable values (seeded from `FgGraph.variables`). */
    readonly userVariables: Record<string, FgValue>;
    /** Async task records, ticked each frame (deduped; carry cancel tokens). */
    readonly pending: FgPendingTask[];
    /** glTF graphs are right-handed; drives Z/handedness coercion on read. */
    readonly rightHanded: boolean;
    /** @internal Monotonic token source for `addPending`. */
    _tokenSeq: number;
}

/** One outstanding async task (a delay, an animation). The unique `token`
 *  enables precise cancellation and lets a block own several tasks at once. */
export interface FgPendingTask {
    readonly blockId: string;
    /** Unique per task; a block may own several concurrently. */
    readonly token: number;
    canceled: boolean;
    /** Set by a def's `onTick` when the task has finished; compacted out after
     *  the frame's pending loop. */
    done: boolean;
    /** Task-local state (e.g. `remainingMs`, `delayIndex`, animation handle). */
    state: Record<string, unknown>;
}

/** Scene-owned capabilities a block may invoke WITHOUT a scene reference.
 *  Provided by the loader/animation subsystem. All optional — Phase 1 ships
 *  none; animation/interpolation blocks (Phase 3) consume these. */
export interface FgCapabilities {
    /** Play an animation group (resolved from a glTF animation index). */
    readonly playAnimation?: (group: AnimationGroup, opts?: { speed?: number; loop?: boolean; from?: number; to?: number }) => void;
    /** Stop a playing animation group. */
    readonly stopAnimation?: (group: AnimationGroup) => void;
    /** Halt a playing animation group at a specific frame (glTF `animation/stopAt`). */
    readonly stopAnimationAt?: (group: AnimationGroup, frame: number) => void;
    /** Subscribe to an animation group's end; returns an unsubscribe fn. */
    readonly onAnimationEnd?: (group: AnimationGroup, cb: () => void) => () => void;
}

/** Per-graph RESOLVED capabilities, wired by the loader. Read-mostly. */
export interface FgEnv {
    readonly graph: FgGraph;
    /** Block defs resolved up-front (awaited dynamic imports), type → def. */
    readonly defs: Record<string, FgBlockDef>;
    /** Scene-object accessors resolved from JSON pointers, keyed by pointer id. */
    readonly accessors: Record<string, FgAccessor>;
    /** Animation handles by glTF animation index. */
    readonly animations: readonly AnimationGroup[];
    /** Scene-owned capabilities blocks may invoke without a scene reference. */
    readonly caps: FgCapabilities;
    /** Event bus the scene driver feeds (shared across graphs in a scene). */
    readonly events: FgEventBus;
}

/** A resolved JSON-pointer accessor onto a scene object property. */
export interface FgAccessor {
    readonly type: FgType;
    readonly get: () => FgValue;
    readonly set?: (value: FgValue) => void;
    readonly target?: unknown;
}

/** Pre-resolved inputs to `createFgEnv`. Everything scene-dependent is wired
 *  here by the loader; the runtime only resolves block defs from these + the
 *  registry. */
export interface FgWiring {
    accessors?: Record<string, FgAccessor>;
    animations?: readonly AnimationGroup[];
    caps?: FgCapabilities;
    /** Shared scene/coordinator bus. A fresh one is created if omitted. */
    events?: FgEventBus;
    /** Pre-supplied defs by type — bypasses the dynamic-import registry. Used by
     *  tests (hand-built defs) and to override/extend the registry. */
    defs?: Record<string, FgBlockDef>;
}

/** A flow graph loaded from a file (e.g. glTF KHR_interactivity), carried on the
 *  `AssetContainer` until `addToScene` wires it to the scene. Spec-agnostic: the
 *  graph + its JSON-pointer accessors are fully resolved at load time; animations
 *  and capabilities are bound at attach time from the scene/container. */
export interface LoadedFlowGraph {
    readonly graph: FgGraph;
    /** JSON-pointer-string → resolved scene-object accessor. */
    readonly accessors: Record<string, FgAccessor>;
}
