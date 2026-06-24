import type { XrHandedness, XrTargetRayMode } from "./xr-support.js";

/**
 * XR input sources — controller / hand target-ray + grip poses and
 * select/squeeze events. Pure data + free functions (pillar 4b/4b′). No teleport,
 * hand-joint tracking, or haptics in this pass.
 */

/** Per-frame state for a single XR input source (controller, gaze, transient pointer). */
export interface XrInputSource {
    /** The underlying WebXR input source. */
    readonly source: XRInputSource_;
    /** `"left"`, `"right"`, or `"none"`. */
    readonly handedness: XrHandedness;
    /** How the target ray is produced (`"gaze"`, `"tracked-pointer"`, `"screen"`). */
    readonly targetRayMode: XrTargetRayMode;
    /** World-space target-ray pose (column-major 4×4). Valid only when {@link targetRayTracked}. */
    readonly targetRayMatrix: Float32Array;
    /** True when a valid target-ray pose was obtained for the current frame. */
    targetRayTracked: boolean;
    /** World-space grip pose (column-major 4×4). Valid only when {@link gripTracked}. */
    readonly gripMatrix: Float32Array;
    /** True when a valid grip pose was obtained for the current frame (false if the source has no grip space). */
    gripTracked: boolean;
    /** True between `selectstart` and `selectend`. */
    selecting: boolean;
    /** True between `squeezestart` and `squeezeend`. */
    squeezing: boolean;
    /** Associated gamepad (buttons / axes), if the source exposes one. */
    readonly gamepad: Gamepad | null;
}

// `@types/webxr` names the source interface `XRInputSource`; alias it so our
// per-frame wrapper can reuse the friendlier `XrInputSource` name above.
type XRInputSource_ = XRInputSource;

/** Optional callbacks fired by the input manager during a session. */
export interface XrInputCallbacks {
    /** Fired when the session's input-source list changes (connect/disconnect). */
    onInputSourcesChange?: (added: readonly XrInputSource[], removed: readonly XrInputSource[]) => void;
    onSelectStart?: (input: XrInputSource) => void;
    /** Fired on a completed primary action (trigger). */
    onSelect?: (input: XrInputSource) => void;
    onSelectEnd?: (input: XrInputSource) => void;
    onSqueezeStart?: (input: XrInputSource) => void;
    /** Fired on a completed squeeze action (grip). */
    onSqueeze?: (input: XrInputSource) => void;
    onSqueezeEnd?: (input: XrInputSource) => void;
}

/** Tracks XR input sources for a session and surfaces their poses + events. */
export interface XrInputManager {
    /** Live list of tracked input sources (kept in sync with the session). */
    readonly inputSources: readonly XrInputSource[];
    /** @internal */
    _list: XrInputSource[];
    /** @internal */
    _bySource: Map<XRInputSource_, XrInputSource>;
    /** @internal */
    _session: XRSession;
    /** @internal */
    _cbs: XrInputCallbacks;
    /** @internal Bound event handlers, retained for removal on dispose. */
    _handlers: { type: string; fn: EventListener }[];
}

function wrap(source: XRInputSource_): XrInputSource {
    return {
        source,
        handedness: source.handedness,
        targetRayMode: source.targetRayMode,
        targetRayMatrix: new Float32Array(16),
        targetRayTracked: false,
        gripMatrix: new Float32Array(16),
        gripTracked: false,
        selecting: false,
        squeezing: false,
        gamepad: source.gamepad ?? null,
    };
}

/**
 * Create an input manager for an active XR session. Wires `select*`/`squeeze*` and
 * `inputsourceschange` listeners and seeds the current source list.
 */
export function createXrInputManager(session: XRSession, callbacks: XrInputCallbacks): XrInputManager {
    const list: XrInputSource[] = [];
    const bySource = new Map<XRInputSource_, XrInputSource>();
    const mgr: XrInputManager = {
        get inputSources() {
            return mgr._list;
        },
        _list: list,
        _bySource: bySource,
        _session: session,
        _cbs: callbacks,
        _handlers: [],
    };

    const addSources = (sources: ArrayLike<XRInputSource_>): XrInputSource[] => {
        const added: XrInputSource[] = [];
        for (let i = 0; i < sources.length; i++) {
            const s = sources[i]!;
            if (bySource.has(s)) {
                continue;
            }
            const w = wrap(s);
            bySource.set(s, w);
            list.push(w);
            added.push(w);
        }
        return added;
    };
    const removeSources = (sources: ArrayLike<XRInputSource_>): XrInputSource[] => {
        const removed: XrInputSource[] = [];
        for (let i = 0; i < sources.length; i++) {
            const s = sources[i]!;
            const w = bySource.get(s);
            if (!w) {
                continue;
            }
            bySource.delete(s);
            const idx = list.indexOf(w);
            if (idx >= 0) {
                list.splice(idx, 1);
            }
            removed.push(w);
        }
        return removed;
    };

    const on = (type: string, fn: EventListener): void => {
        session.addEventListener(type, fn);
        mgr._handlers.push({ type, fn });
    };

    on("inputsourceschange", ((e: XRInputSourcesChangeEvent) => {
        const added = addSources(e.added as unknown as ArrayLike<XRInputSource_>);
        const removed = removeSources(e.removed as unknown as ArrayLike<XRInputSource_>);
        callbacks.onInputSourcesChange?.(added, removed);
    }) as EventListener);

    const action = (type: string, flag: "selecting" | "squeezing", cb?: (i: XrInputSource) => void): void => {
        on(type, ((e: XRInputSourceEvent) => {
            const w = bySource.get(e.inputSource);
            if (!w) {
                return;
            }
            if (type.endsWith("start")) {
                w[flag] = true;
            } else if (type.endsWith("end")) {
                w[flag] = false;
            }
            cb?.(w);
        }) as EventListener);
    };
    action("selectstart", "selecting", callbacks.onSelectStart);
    action("select", "selecting", callbacks.onSelect);
    action("selectend", "selecting", callbacks.onSelectEnd);
    action("squeezestart", "squeezing", callbacks.onSqueezeStart);
    action("squeeze", "squeezing", callbacks.onSqueeze);
    action("squeezeend", "squeezing", callbacks.onSqueezeEnd);

    // Seed with any sources already present.
    addSources(session.inputSources as unknown as ArrayLike<XRInputSource_>);
    return mgr;
}

/**
 * Refresh every tracked source's target-ray and grip pose for the current frame.
 * Call once per `XRFrame`, before reading `inputSources`.
 */
export function updateXrInputPoses(mgr: XrInputManager, frame: XRFrame, referenceSpace: XRReferenceSpace): void {
    for (const w of mgr._list) {
        const rayPose = frame.getPose(w.source.targetRaySpace, referenceSpace);
        if (rayPose) {
            w.targetRayMatrix.set(rayPose.transform.matrix);
            w.targetRayTracked = true;
        } else {
            w.targetRayTracked = false;
        }
        const grip = w.source.gripSpace;
        if (grip) {
            const gripPose = frame.getPose(grip, referenceSpace);
            if (gripPose) {
                w.gripMatrix.set(gripPose.transform.matrix);
                w.gripTracked = true;
            } else {
                w.gripTracked = false;
            }
        } else {
            w.gripTracked = false;
        }
    }
}

/** Detach all session listeners and clear tracked sources. */
export function disposeXrInputManager(mgr: XrInputManager): void {
    for (const { type, fn } of mgr._handlers) {
        mgr._session.removeEventListener(type, fn);
    }
    mgr._handlers.length = 0;
    mgr._list.length = 0;
    mgr._bySource.clear();
}
