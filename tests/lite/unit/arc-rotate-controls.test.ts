import { beforeEach, describe, expect, it, vi } from "vitest";

import { attachControl, setCameraLimits } from "../../../packages/babylon-lite/src/camera/arc-rotate-controls";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import type { ArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

interface FakeCanvas {
    listeners: Map<string, EventListener[]>;
    addEventListener(type: string, h: EventListener): void;
    removeEventListener(type: string, h: EventListener): void;
    setPointerCapture(): void;
    releasePointerCapture(): void;
}

function makeCanvas(): FakeCanvas {
    const listeners = new Map<string, EventListener[]>();
    return {
        listeners,
        addEventListener(type, h): void {
            const arr = listeners.get(type) ?? [];
            arr.push(h);
            listeners.set(type, arr);
        },
        removeEventListener(type, h): void {
            const arr = listeners.get(type);
            if (arr) {
                const i = arr.indexOf(h);
                if (i >= 0) {
                    arr.splice(i, 1);
                }
            }
        },
        setPointerCapture(): void {
            return;
        },
        releasePointerCapture(): void {
            return;
        },
    };
}

function fire(canvas: FakeCanvas, type: string, ev: unknown): void {
    for (const h of [...(canvas.listeners.get(type) ?? [])]) {
        h(ev as Event);
    }
}

function makeCamera(radius = 10): ArcRotateCamera {
    // Use the real factory so the alpha/beta/radius setters (and the
    // setCameraLimits self-clamp hook they invoke) are exercised, not stubbed.
    return createArcRotateCamera(0, 1, radius, { x: 0, y: 0, z: 0 });
}

function makeScene(): SceneContext {
    return { _beforeRender: [] } as unknown as SceneContext;
}

function touch(identifier: number, clientX: number, clientY: number): { identifier: number; clientX: number; clientY: number } {
    return { identifier, clientX, clientY };
}

function touchEvent(changedTouches: Array<{ identifier: number; clientX: number; clientY: number }>): {
    changedTouches: typeof changedTouches;
    preventDefault: ReturnType<typeof vi.fn>;
} {
    return { changedTouches, preventDefault: vi.fn() };
}

function pointerEvent(props: Partial<{ button: number; clientX: number; clientY: number; pointerId: number }>): unknown {
    return { button: 0, clientX: 0, clientY: 0, pointerId: 1, ...props, preventDefault: vi.fn() };
}

describe("attachControl — pinch / touch handling", () => {
    let canvas: FakeCanvas;
    let camera: ArcRotateCamera;
    let scene: SceneContext;

    beforeEach(() => {
        canvas = makeCanvas();
        camera = makeCamera(10);
        scene = makeScene();
        attachControl(camera, canvas as unknown as HTMLCanvasElement, scene);
    });

    it("zooms the camera radius on a two-finger pinch (fingers apart → zoom in)", () => {
        // Start: two fingers 200px apart, radius 10.
        fire(canvas, "touchstart", touchEvent([touch(1, 0, 0), touch(2, 200, 0)]));
        // Spread to 400px apart → radius = 10 * (200/400) = 5.
        fire(canvas, "touchmove", touchEvent([touch(1, 0, 0), touch(2, 400, 0)]));
        expect(camera.radius).toBeCloseTo(5, 5);
    });

    it("zooms out when the fingers move together", () => {
        fire(canvas, "touchstart", touchEvent([touch(1, 0, 0), touch(2, 200, 0)]));
        // Pinch to 100px apart → radius = 10 * (200/100) = 20.
        fire(canvas, "touchmove", touchEvent([touch(1, 50, 0), touch(2, 150, 0)]));
        expect(camera.radius).toBeCloseTo(20, 5);
    });

    it("prevents the browser's native pinch-zoom (page zoom on iOS) during a two-finger gesture", () => {
        fire(canvas, "touchstart", touchEvent([touch(1, 0, 0), touch(2, 200, 0)]));
        const move = touchEvent([touch(1, 0, 0), touch(2, 400, 0)]);
        fire(canvas, "touchmove", move);
        expect(move.preventDefault).toHaveBeenCalled();
    });

    it("does NOT prevent default for a single-finger touchmove (lets it rotate via pointer events)", () => {
        fire(canvas, "touchstart", touchEvent([touch(1, 0, 0)]));
        const move = touchEvent([touch(1, 50, 0)]);
        fire(canvas, "touchmove", move);
        expect(move.preventDefault).not.toHaveBeenCalled();
        expect(camera.radius).toBe(10);
    });

    it("suppresses pointer-driven rotation while two fingers are down (no rotate/zoom conflict)", () => {
        fire(canvas, "pointerdown", pointerEvent({ button: 0, clientX: 0, clientY: 0, pointerId: 1 }));
        fire(canvas, "touchstart", touchEvent([touch(1, 0, 0), touch(2, 200, 0)]));
        fire(canvas, "pointermove", pointerEvent({ clientX: 80, clientY: 60, pointerId: 1 }));
        expect(camera.inertialAlphaOffset).toBe(0);
        expect(camera.inertialBetaOffset).toBe(0);
    });

    it("prevents iOS gesture events from zooming the page", () => {
        const gesture = { preventDefault: vi.fn() };
        expect(canvas.listeners.get("gesturestart")?.length).toBeGreaterThan(0);
        fire(canvas, "gesturestart", gesture);
        expect(gesture.preventDefault).toHaveBeenCalled();
    });

    it("ends the pinch when a finger lifts so a lone remaining finger does not zoom", () => {
        fire(canvas, "touchstart", touchEvent([touch(1, 0, 0), touch(2, 200, 0)]));
        fire(canvas, "touchmove", touchEvent([touch(1, 0, 0), touch(2, 400, 0)]));
        const radiusAfterPinch = camera.radius;
        // Lift the second finger → one touch remains.
        fire(canvas, "touchend", touchEvent([touch(2, 400, 0)]));
        // A lone-finger move must not change the radius (it's a rotate, not a pinch).
        fire(canvas, "touchmove", touchEvent([touch(1, 900, 0)]));
        expect(camera.radius).toBe(radiusAfterPinch);
    });

    it("still rotates on a normal single-pointer drag", () => {
        fire(canvas, "pointerdown", pointerEvent({ button: 0, clientX: 0, clientY: 0, pointerId: 1 }));
        fire(canvas, "pointermove", pointerEvent({ clientX: 10, clientY: 0, pointerId: 1 }));
        // angularSensibility = 1000, dx = 10 → inertialAlphaOffset -= 0.01.
        expect(camera.inertialAlphaOffset).toBeCloseTo(-0.01, 5);
    });

    it("registers touch/gesture listeners as non-passive so preventDefault is honored", () => {
        // Re-attach with a spy canvas to inspect the options passed to addEventListener.
        const seen: Record<string, AddEventListenerOptions | undefined> = {};
        const spyCanvas = {
            ...makeCanvas(),
            addEventListener(type: string, _h: EventListener, opts?: AddEventListenerOptions): void {
                seen[type] = opts;
            },
            removeEventListener(): void {
                return;
            },
        };
        attachControl(makeCamera(), spyCanvas as unknown as HTMLCanvasElement, makeScene());
        expect(seen["touchstart"]).toMatchObject({ passive: false });
        expect(seen["touchmove"]).toMatchObject({ passive: false });
        expect(seen["gesturestart"]).toMatchObject({ passive: false });
    });

    it("removes all listeners on dispose", () => {
        const c = makeCanvas();
        const dispose = attachControl(makeCamera(), c as unknown as HTMLCanvasElement, makeScene());
        expect(c.listeners.get("touchmove")?.length).toBe(1);
        dispose();
        expect(c.listeners.get("touchmove")?.length).toBe(0);
        expect(c.listeners.get("pointermove")?.length).toBe(0);
    });
});

describe("setCameraLimits + clamping", () => {
    function beforeRender(scene: SceneContext): void {
        for (const cb of [...(scene as unknown as { _beforeRender: Array<() => void> })._beforeRender]) {
            cb();
        }
    }

    it("clamps the current radius into range immediately (no jump on the next frame)", () => {
        const cam = makeCamera(10);
        setCameraLimits(cam, { lowerRadiusLimit: 4, upperRadiusLimit: 6 });
        // 10 is above the upper limit → snapped to 6 right away.
        expect(cam.radius).toBe(6);
    });

    it("blocks wheel zoom-out past the upper radius limit, never overshooting on any frame (no jiggle)", () => {
        const canvas = makeCanvas();
        const cam = makeCamera(6);
        const scene = makeScene();
        attachControl(cam, canvas as unknown as HTMLCanvasElement, scene);
        setCameraLimits(cam, { lowerRadiusLimit: 4, upperRadiusLimit: 6 }, scene);

        // Fling a large zoom-out (wheel deltaY > 0 → radius grows over frames).
        fire(canvas, "wheel", { deltaY: 5000, preventDefault: vi.fn() });
        let maxSeen = cam.radius;
        for (let i = 0; i < 60; i++) {
            beforeRender(scene);
            // The camera self-clamps inside its radius setter as inertia integrates,
            // so the radius the frame would render with never exceeds the wall.
            maxSeen = Math.max(maxSeen, cam.radius);
        }
        expect(maxSeen).toBeLessThanOrEqual(6);
        expect(cam.radius).toBe(6);
        expect(cam.inertialRadiusOffset).toBe(0);
    });

    it("blocks pinch zoom past the radius limits", () => {
        const canvas = makeCanvas();
        const cam = makeCamera(6);
        const scene = makeScene();
        attachControl(cam, canvas as unknown as HTMLCanvasElement, scene);
        setCameraLimits(cam, { lowerRadiusLimit: 4, upperRadiusLimit: 6 }, scene);

        // Pinch the fingers together → radius would grow to 12 (6 * 200/100).
        fire(canvas, "touchstart", touchEvent([touch(1, 0, 0), touch(2, 200, 0)]));
        fire(canvas, "touchmove", touchEvent([touch(1, 50, 0), touch(2, 150, 0)]));
        // The per-frame enforcement clamps the direct radius write before render.
        beforeRender(scene);
        expect(cam.radius).toBe(6);
    });

    it("clamps the pinch radius write immediately, before any _beforeRender runs", () => {
        // Regression: the pinch handler writes radius directly. If it leaves an
        // out-of-limit value until the per-frame `enforce` step, other
        // _beforeRender callbacks that read the camera earlier in the frame
        // (e.g. a camera-pinned skybox sync) observe a transient far-flung pose
        // for one frame — the source of the mobile pinch-zoom "blink".
        const canvas = makeCanvas();
        const cam = makeCamera(6);
        const scene = makeScene();
        attachControl(cam, canvas as unknown as HTMLCanvasElement, scene);
        setCameraLimits(cam, { lowerRadiusLimit: 4, upperRadiusLimit: 6 }, scene);

        // Pinch fingers together → radius would grow to 12 (6 * 200/100).
        fire(canvas, "touchstart", touchEvent([touch(1, 0, 0), touch(2, 200, 0)]));
        fire(canvas, "touchmove", touchEvent([touch(1, 50, 0), touch(2, 150, 0)]));
        // No beforeRender yet: the radius must already be clamped to the wall.
        expect(cam.radius).toBe(6);

        // Pinch fingers apart → radius would shrink to 3 (6 * 100/200); clamp up.
        fire(canvas, "touchstart", touchEvent([touch(1, 0, 0), touch(2, 100, 0)]));
        fire(canvas, "touchmove", touchEvent([touch(1, 0, 0), touch(2, 200, 0)]));
        expect(cam.radius).toBe(4);
    });

    it("does NOT clamp the pinch write when no limits were set (opt-in: zero clamp code in the gesture)", () => {
        const canvas = makeCanvas();
        const cam = makeCamera(6);
        const scene = makeScene();
        // attachControl but NO setCameraLimits → the input-time clamp hook is
        // never installed, so the pinch writes radius freely (the per-frame
        // enforcement that bounds it is what setCameraLimits adds, opt-in).
        attachControl(cam, canvas as unknown as HTMLCanvasElement, scene);

        fire(canvas, "touchstart", touchEvent([touch(1, 0, 0), touch(2, 200, 0)]));
        fire(canvas, "touchmove", touchEvent([touch(1, 50, 0), touch(2, 150, 0)]));
        expect(cam.radius).toBe(12); // 6 * 200/100, unclamped
    });

    it("stops clamping the pinch write after the limits disposer runs", () => {
        const canvas = makeCanvas();
        const cam = makeCamera(6);
        const scene = makeScene();
        attachControl(cam, canvas as unknown as HTMLCanvasElement, scene);
        const dispose = setCameraLimits(cam, { lowerRadiusLimit: 4, upperRadiusLimit: 6 }, scene);
        dispose();

        fire(canvas, "touchstart", touchEvent([touch(1, 0, 0), touch(2, 200, 0)]));
        fire(canvas, "touchmove", touchEvent([touch(1, 50, 0), touch(2, 150, 0)]));
        expect(cam.radius).toBe(12); // hook cleared on dispose → unclamped again
    });

    it("clamps beta against an upper beta limit during inertial rotation", () => {
        const canvas = makeCanvas();
        const cam = makeCamera(10);
        cam.beta = 1.0;
        const scene = makeScene();
        attachControl(cam, canvas as unknown as HTMLCanvasElement, scene);
        const limit = Math.PI / 2 - 0.001;
        setCameraLimits(cam, { upperBetaLimit: limit }, scene);

        // Drag upward a lot → inertialBetaOffset pushes beta up past the limit.
        fire(canvas, "pointerdown", pointerEvent({ button: 0, clientX: 0, clientY: 0, pointerId: 1 }));
        fire(canvas, "pointermove", pointerEvent({ clientX: 0, clientY: -5000, pointerId: 1 }));
        for (let i = 0; i < 60; i++) {
            beforeRender(scene);
        }
        expect(cam.beta).toBeLessThanOrEqual(limit + 1e-9);
        expect(cam.beta).toBeCloseTo(limit, 6);
        expect(cam.inertialBetaOffset).toBe(0);
    });

    it("adds NO clamping work to attachControl's loop for a limit-free camera (zero impact)", () => {
        const canvas = makeCanvas();
        const cam = makeCamera(10);
        const scene = makeScene();
        attachControl(cam, canvas as unknown as HTMLCanvasElement, scene);
        // attachControl must register exactly its own inertia step — nothing for limits.
        expect((scene as unknown as { _beforeRender: unknown[] })._beforeRender.length).toBe(1);
    });

    it("leaves a limit-free camera completely unclamped (parity-safe no-op)", () => {
        const canvas = makeCanvas();
        const cam = makeCamera(10);
        cam.beta = 0; // an out-of-the-usual value that must NOT be nudged when no limit is set
        const scene = makeScene();
        attachControl(cam, canvas as unknown as HTMLCanvasElement, scene);
        beforeRender(scene);
        expect(cam.radius).toBe(10);
        expect(cam.beta).toBe(0);
    });

    it("installs no per-frame step and self-clamps on move; the disposer stops the clamp", () => {
        const cam = makeCamera(10);
        const scene = makeScene();
        const dispose = setCameraLimits(cam, { lowerRadiusLimit: 4, upperRadiusLimit: 6 }, scene);
        // Enforcement is via the camera's setters, not a scene hook — nothing pushed.
        expect((scene as unknown as { _beforeRender: unknown[] })._beforeRender.length).toBe(0);
        // A direct move past a bound is clamped immediately by the setter.
        cam.radius = 100;
        expect(cam.radius).toBe(6);
        // After dispose the hook is gone, so the camera moves freely again.
        dispose();
        cam.radius = 100;
        expect(cam.radius).toBe(100);
    });

    it("clamps immediately even without a scene (one-shot), registering no per-frame step", () => {
        const cam = makeCamera(10);
        const dispose = setCameraLimits(cam, { upperRadiusLimit: 6 });
        expect(cam.radius).toBe(6);
        expect(typeof dispose).toBe("function");
    });

    it("merges successive calls and clears a bound when passed undefined", () => {
        const cam = makeCamera(10);
        setCameraLimits(cam, { lowerRadiusLimit: 4, upperRadiusLimit: 6 });
        expect(cam.upperRadiusLimit).toBe(6);
        setCameraLimits(cam, { upperRadiusLimit: undefined });
        expect(cam.upperRadiusLimit).toBeUndefined();
        expect(cam.lowerRadiusLimit).toBe(4); // untouched key preserved
    });
});
