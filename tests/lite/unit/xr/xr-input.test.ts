import { describe, it, expect, vi } from "vitest";

import { createXrInputManager, updateXrInputPoses, disposeXrInputManager } from "../../../../packages/babylon-lite/src/xr/xr-input";
import type { XrInputSource } from "../../../../packages/babylon-lite/src/xr/xr-input";

interface FakeListener {
    type: string;
    fn: EventListener;
}

/** Minimal EventTarget-like XRSession stand-in with manual dispatch + inputSources. */
class FakeXrSession {
    listeners: FakeListener[] = [];
    inputSources: unknown[] = [];

    addEventListener(type: string, fn: EventListener): void {
        this.listeners.push({ type, fn });
    }
    removeEventListener(type: string, fn: EventListener): void {
        this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn));
    }
    dispatch(type: string, event: unknown): void {
        for (const l of this.listeners.filter((l) => l.type === type)) {
            l.fn(event as Event);
        }
    }
}

function makeSource(handedness: XRHandedness, opts?: { grip?: boolean; gamepad?: Gamepad }): XRInputSource {
    return {
        handedness,
        targetRayMode: "tracked-pointer",
        targetRaySpace: { id: `ray-${handedness}` } as unknown as XRSpace,
        gripSpace: opts?.grip === false ? undefined : ({ id: `grip-${handedness}` } as unknown as XRSpace),
        gamepad: opts?.gamepad ?? null,
        profiles: [],
    } as unknown as XRInputSource;
}

describe("xr-input manager", () => {
    it("seeds the list from session.inputSources", () => {
        const session = new FakeXrSession();
        const left = makeSource("left");
        session.inputSources = [left];
        const mgr = createXrInputManager(session as unknown as XRSession, {});
        expect(mgr.inputSources).toHaveLength(1);
        expect(mgr.inputSources[0]!.handedness).toBe("left");
        expect(mgr.inputSources[0]!.source).toBe(left);
    });

    it("adds and removes sources on inputsourceschange and fires the callback", () => {
        const session = new FakeXrSession();
        const onChange = vi.fn();
        const mgr = createXrInputManager(session as unknown as XRSession, { onInputSourcesChange: onChange });

        const right = makeSource("right");
        session.dispatch("inputsourceschange", { added: [right], removed: [] });
        expect(mgr.inputSources).toHaveLength(1);
        expect(onChange).toHaveBeenCalledTimes(1);
        const [added, removed] = onChange.mock.calls[0]!;
        expect(added).toHaveLength(1);
        expect(removed).toHaveLength(0);

        session.dispatch("inputsourceschange", { added: [], removed: [right] });
        expect(mgr.inputSources).toHaveLength(0);
        expect(onChange).toHaveBeenCalledTimes(2);
    });

    it("does not duplicate a source that is added twice", () => {
        const session = new FakeXrSession();
        const left = makeSource("left");
        const mgr = createXrInputManager(session as unknown as XRSession, {});
        session.dispatch("inputsourceschange", { added: [left], removed: [] });
        session.dispatch("inputsourceschange", { added: [left], removed: [] });
        expect(mgr.inputSources).toHaveLength(1);
    });

    it("toggles the selecting flag and fires select callbacks", () => {
        const session = new FakeXrSession();
        const onStart = vi.fn();
        const onSelect = vi.fn();
        const onEnd = vi.fn();
        const left = makeSource("left");
        session.inputSources = [left];
        const mgr = createXrInputManager(session as unknown as XRSession, {
            onSelectStart: onStart,
            onSelect,
            onSelectEnd: onEnd,
        });
        const wrapped = mgr.inputSources[0]!;

        session.dispatch("selectstart", { inputSource: left });
        expect(wrapped.selecting).toBe(true);
        expect(onStart).toHaveBeenCalledOnce();

        session.dispatch("select", { inputSource: left });
        expect(onSelect).toHaveBeenCalledOnce();
        // "select" is neither *start nor *end → flag unchanged.
        expect(wrapped.selecting).toBe(true);

        session.dispatch("selectend", { inputSource: left });
        expect(wrapped.selecting).toBe(false);
        expect(onEnd).toHaveBeenCalledOnce();
    });

    it("toggles the squeezing flag and fires squeeze callbacks", () => {
        const session = new FakeXrSession();
        const onSqueeze = vi.fn();
        const right = makeSource("right");
        session.inputSources = [right];
        const mgr = createXrInputManager(session as unknown as XRSession, { onSqueeze });
        const wrapped = mgr.inputSources[0]!;

        session.dispatch("squeezestart", { inputSource: right });
        expect(wrapped.squeezing).toBe(true);
        session.dispatch("squeeze", { inputSource: right });
        expect(onSqueeze).toHaveBeenCalledOnce();
        session.dispatch("squeezeend", { inputSource: right });
        expect(wrapped.squeezing).toBe(false);
    });

    it("ignores events for sources it is not tracking", () => {
        const session = new FakeXrSession();
        const onSelect = vi.fn();
        const mgr = createXrInputManager(session as unknown as XRSession, { onSelect });
        session.dispatch("select", { inputSource: makeSource("none") });
        expect(onSelect).not.toHaveBeenCalled();
        expect(mgr.inputSources).toHaveLength(0);
    });

    it("updates target-ray and grip poses from the frame", () => {
        const session = new FakeXrSession();
        const left = makeSource("left", { grip: true });
        session.inputSources = [left];
        const mgr = createXrInputManager(session as unknown as XRSession, {});

        const rayM = new Float32Array(16).fill(2);
        const gripM = new Float32Array(16).fill(7);
        const frame = {
            getPose: (space: XRSpace) => {
                const id = (space as unknown as { id: string }).id;
                if (id === "ray-left") {
                    return { transform: { matrix: rayM } } as unknown as XRPose;
                }
                if (id === "grip-left") {
                    return { transform: { matrix: gripM } } as unknown as XRPose;
                }
                return null;
            },
        } as unknown as XRFrame;

        updateXrInputPoses(mgr, frame, {} as XRReferenceSpace);
        const w = mgr.inputSources[0]!;
        expect(w.targetRayTracked).toBe(true);
        expect(Array.from(w.targetRayMatrix)).toEqual(Array.from(rayM));
        expect(w.gripTracked).toBe(true);
        expect(Array.from(w.gripMatrix)).toEqual(Array.from(gripM));
    });

    it("marks poses untracked when the frame returns no pose", () => {
        const session = new FakeXrSession();
        const left = makeSource("left", { grip: true });
        session.inputSources = [left];
        const mgr = createXrInputManager(session as unknown as XRSession, {});
        const frame = { getPose: () => null } as unknown as XRFrame;
        updateXrInputPoses(mgr, frame, {} as XRReferenceSpace);
        const w = mgr.inputSources[0]!;
        expect(w.targetRayTracked).toBe(false);
        expect(w.gripTracked).toBe(false);
    });

    it("reports gripTracked false for sources with no grip space", () => {
        const session = new FakeXrSession();
        const gaze = makeSource("none", { grip: false });
        session.inputSources = [gaze];
        const mgr = createXrInputManager(session as unknown as XRSession, {});
        const frame = {
            getPose: () => ({ transform: { matrix: new Float32Array(16) } }) as unknown as XRPose,
        } as unknown as XRFrame;
        updateXrInputPoses(mgr, frame, {} as XRReferenceSpace);
        expect(mgr.inputSources[0]!.gripTracked).toBe(false);
    });

    it("detaches all listeners and clears sources on dispose", () => {
        const session = new FakeXrSession();
        session.inputSources = [makeSource("left")];
        const mgr = createXrInputManager(session as unknown as XRSession, {});
        expect(session.listeners.length).toBeGreaterThan(0);
        disposeXrInputManager(mgr);
        expect(session.listeners).toHaveLength(0);
        expect(mgr.inputSources).toHaveLength(0);
        // Events after dispose are no-ops.
        const onSelect = vi.fn();
        const remgr = createXrInputManager(session as unknown as XRSession, { onSelect });
        disposeXrInputManager(remgr);
        session.dispatch("select", { inputSource: session.inputSources[0] as XRInputSource });
        expect(onSelect).not.toHaveBeenCalled();
    });
});

// Type-only usage so the import is exercised.
const _typecheck: XrInputSource | undefined = undefined;
void _typecheck;
