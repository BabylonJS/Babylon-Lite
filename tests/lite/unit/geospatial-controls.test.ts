import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachGeospatialControls } from "../../../packages/babylon-lite/src/camera/geospatial-camera-controls";
import { createGeospatialCamera } from "../../../packages/babylon-lite/src/camera/geospatial-camera";
import type { GeospatialCamera } from "../../../packages/babylon-lite/src/camera/geospatial-camera";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types";

const W = 800;
const H = 600;
const CX = 400;
const CY = 300;
const DT = 1000 / 60;

interface FakeCanvas {
    listeners: Map<string, EventListener[]>;
    width: number;
    height: number;
    addEventListener(type: string, h: EventListener, opts?: AddEventListenerOptions): void;
    removeEventListener(type: string, h: EventListener): void;
    setPointerCapture(): void;
    releasePointerCapture(): void;
    getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number };
}

function makeCanvas(): FakeCanvas {
    const listeners = new Map<string, EventListener[]>();
    return {
        listeners,
        width: W,
        height: H,
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
        getBoundingClientRect() {
            return { left: 0, top: 0, width: W, height: H, right: W, bottom: H };
        },
    };
}

let windowListeners: Map<string, EventListener[]>;

function makeScene(): SceneContext {
    return { _beforeRender: [] } as unknown as SceneContext;
}

function fire(canvas: FakeCanvas, type: string, ev: unknown): void {
    for (const h of [...(canvas.listeners.get(type) ?? [])]) {
        h(ev as Event);
    }
}

function fireWindow(type: string, ev: unknown): void {
    for (const h of [...(windowListeners.get(type) ?? [])]) {
        h(ev as Event);
    }
}

function tick(scene: SceneContext, dt = DT): void {
    for (const cb of [...(scene as unknown as { _beforeRender: Array<(d: number) => void> })._beforeRender]) {
        cb(dt);
    }
}

function pointer(type: string, clientX: number, clientY: number, button = 0): unknown {
    return { type, clientX, clientY, button, pointerId: 1, preventDefault: vi.fn() };
}

function wheel(clientX: number, clientY: number, deltaY: number): unknown {
    return { clientX, clientY, deltaY, preventDefault: vi.fn() };
}

function key(code: string): unknown {
    return { code, preventDefault: vi.fn() };
}

function tp(identifier: number, clientX: number, clientY: number): { identifier: number; clientX: number; clientY: number } {
    return { identifier, clientX, clientY };
}

function touchEvent(changed: Array<{ identifier: number; clientX: number; clientY: number }>): unknown {
    return { changedTouches: changed, preventDefault: vi.fn() };
}

function copy(v: Vec3): Vec3 {
    return { x: v.x, y: v.y, z: v.z };
}

function moved(a: Vec3, b: Vec3): number {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe("attachGeospatialControls — pointer / wheel (M5)", () => {
    let canvas: FakeCanvas;
    let camera: GeospatialCamera;
    let scene: SceneContext;

    beforeEach(() => {
        windowListeners = new Map();
        (globalThis as Record<string, unknown>).window = {
            addEventListener(type: string, h: EventListener): void {
                const arr = windowListeners.get(type) ?? [];
                arr.push(h);
                windowListeners.set(type, arr);
            },
            removeEventListener(type: string, h: EventListener): void {
                const arr = windowListeners.get(type);
                if (arr) {
                    const i = arr.indexOf(h);
                    if (i >= 0) {
                        arr.splice(i, 1);
                    }
                }
            },
        };
        canvas = makeCanvas();
        camera = createGeospatialCamera({ planetRadius: 100 });
        scene = makeScene();
        attachGeospatialControls(camera, canvas as unknown as HTMLCanvasElement, scene);
    });

    afterEach(() => {
        delete (globalThis as Record<string, unknown>).window;
    });

    it("a left-drag pans the globe centre", () => {
        const before = copy(camera.center);
        fire(canvas, "pointerdown", pointer("pointerdown", CX, CY, 0));
        fire(canvas, "pointermove", pointer("pointermove", CX + 30, CY, 0));
        tick(scene);
        expect(moved(camera.center, before)).toBeGreaterThan(1e-4);
    });

    it("returning the cursor to the drag start cancels the pan (drag-plane anchor)", () => {
        const before = copy(camera.center);
        fire(canvas, "pointerdown", pointer("pointerdown", CX, CY, 0));
        fire(canvas, "pointermove", pointer("pointermove", CX + 20, CY, 0));
        fire(canvas, "pointermove", pointer("pointermove", CX, CY, 0)); // back to start
        tick(scene);
        // The accumulated pan over the round-trip nets to ~0, so the anchored
        // surface point (and thus the centre) returns to where it started.
        expect(moved(camera.center, before)).toBeLessThan(0.5);
    });

    it("a click with no movement does not pan", () => {
        const before = copy(camera.center);
        fire(canvas, "pointerdown", pointer("pointerdown", CX, CY, 0));
        fire(canvas, "pointerup", pointer("pointerup", CX, CY, 0));
        tick(scene);
        expect(camera.center).toEqual(before);
    });

    it("the wheel zooms toward the cursor (radius decreases on zoom-in)", () => {
        const before = camera.radius;
        fire(canvas, "wheel", wheel(CX, CY, -100)); // deltaY < 0 = zoom in
        for (let i = 0; i < 10; i++) {
            tick(scene);
        }
        expect(camera.radius).toBeLessThan(before);
    });
});

describe("attachGeospatialControls — keyboard (M6)", () => {
    let canvas: FakeCanvas;
    let camera: GeospatialCamera;
    let scene: SceneContext;

    beforeEach(() => {
        windowListeners = new Map();
        (globalThis as Record<string, unknown>).window = {
            addEventListener(type: string, h: EventListener): void {
                const arr = windowListeners.get(type) ?? [];
                arr.push(h);
                windowListeners.set(type, arr);
            },
            removeEventListener(): void {
                return;
            },
        };
        canvas = makeCanvas();
        camera = createGeospatialCamera({ planetRadius: 100 });
        scene = makeScene();
        attachGeospatialControls(camera, canvas as unknown as HTMLCanvasElement, scene);
    });

    afterEach(() => {
        delete (globalThis as Record<string, unknown>).window;
    });

    it("an arrow key pans the centre (no modifier = pan)", () => {
        const before = copy(camera.center);
        fireWindow("keydown", key("ArrowUp"));
        tick(scene);
        // ArrowUp pans north → centre gains +z.
        expect(camera.center.z).toBeGreaterThan(0);
        expect(moved(camera.center, before)).toBeGreaterThan(1e-4);
    });

    it("Ctrl+arrow tilts (changes pitch) instead of panning", () => {
        camera.radius = 150; // open the pitch range (≤ 2·planetRadius)
        const beforePitch = camera.pitch;
        const beforeCenter = copy(camera.center);
        fireWindow("keydown", key("ControlLeft"));
        fireWindow("keydown", key("ArrowUp"));
        tick(scene);
        tick(scene);
        expect(camera.pitch).toBeGreaterThan(beforePitch);
        // A tilt should not translate the centre.
        expect(moved(camera.center, beforeCenter)).toBeLessThan(1e-6);
    });

    it("+/- zooms along the look vector (radius decreases on +)", () => {
        const before = camera.radius;
        fireWindow("keydown", key("Equal"));
        for (let i = 0; i < 5; i++) {
            tick(scene);
        }
        expect(camera.radius).toBeLessThan(before);
    });
});

describe("attachGeospatialControls — touch pinch (M6)", () => {
    let canvas: FakeCanvas;
    let camera: GeospatialCamera;
    let scene: SceneContext;

    beforeEach(() => {
        windowListeners = new Map();
        (globalThis as Record<string, unknown>).window = {
            addEventListener(): void {
                return;
            },
            removeEventListener(): void {
                return;
            },
        };
        canvas = makeCanvas();
        camera = createGeospatialCamera({ planetRadius: 100 });
        scene = makeScene();
        attachGeospatialControls(camera, canvas as unknown as HTMLCanvasElement, scene);
    });

    afterEach(() => {
        delete (globalThis as Record<string, unknown>).window;
    });

    it("a two-finger spread zooms in (radius decreases)", () => {
        const before = camera.radius;
        fire(canvas, "touchstart", touchEvent([tp(1, 300, 300), tp(2, 500, 300)])); // 200 px apart
        fire(canvas, "touchmove", touchEvent([tp(1, 200, 300), tp(2, 600, 300)])); // 400 px apart
        for (let i = 0; i < 8; i++) {
            tick(scene);
        }
        expect(camera.radius).toBeLessThan(before);
    });

    it("prevents the browser's native pinch-zoom during a two-finger gesture", () => {
        fire(canvas, "touchstart", touchEvent([tp(1, 300, 300), tp(2, 500, 300)]));
        const move = touchEvent([tp(1, 200, 300), tp(2, 600, 300)]) as { preventDefault: ReturnType<typeof vi.fn> };
        fire(canvas, "touchmove", move);
        expect(move.preventDefault).toHaveBeenCalled();
    });

    it("promotes the pinch to a pan once the centroid drifts past the 20 px threshold", () => {
        const beforeCenter = copy(camera.center);
        const beforeRadius = camera.radius;
        // Translate both fingers together (constant spread) so the centroid drifts > 20 px.
        fire(canvas, "touchstart", touchEvent([tp(1, 300, 300), tp(2, 500, 300)])); // centroid 400
        fire(canvas, "touchmove", touchEvent([tp(1, 330, 300), tp(2, 530, 300)])); // centroid 430 → engages pan
        fire(canvas, "touchmove", touchEvent([tp(1, 370, 300), tp(2, 570, 300)])); // centroid 470 → drag delta
        tick(scene);
        expect(moved(camera.center, beforeCenter)).toBeGreaterThan(1e-4); // panned
        expect(camera.radius).toBeCloseTo(beforeRadius, 6); // zoom suppressed mid-drag
    });

    it("a single-finger touch does not pinch-zoom (left to pointer events)", () => {
        const before = camera.radius;
        fire(canvas, "touchstart", touchEvent([tp(1, 300, 300)]));
        const move = touchEvent([tp(1, 360, 300)]) as { preventDefault: ReturnType<typeof vi.fn> };
        fire(canvas, "touchmove", move);
        tick(scene);
        expect(camera.radius).toBe(before);
        expect(move.preventDefault).not.toHaveBeenCalled();
    });

    it("ends the pinch when a finger lifts so a lone finger does not keep zooming", () => {
        fire(canvas, "touchstart", touchEvent([tp(1, 300, 300), tp(2, 500, 300)]));
        fire(canvas, "touchmove", touchEvent([tp(1, 200, 300), tp(2, 600, 300)]));
        for (let i = 0; i < 4; i++) {
            tick(scene);
        }
        fire(canvas, "touchend", touchEvent([tp(2, 600, 300)])); // lift one finger
        const afterLift = camera.radius;
        // A lone-finger move must inject no zoom (it returns early with < 2 touches).
        // Assert without ticking so inertial coast can't mask the check.
        const move = touchEvent([tp(1, 50, 300)]) as { preventDefault: ReturnType<typeof vi.fn> };
        fire(canvas, "touchmove", move);
        expect(camera.radius).toBe(afterLift);
        expect(move.preventDefault).not.toHaveBeenCalled();
    });

    it("registers touch/gesture listeners and removes everything on dispose", () => {
        const c = makeCanvas();
        const cam = createGeospatialCamera({ planetRadius: 100 });
        const dispose = attachGeospatialControls(cam, c as unknown as HTMLCanvasElement, makeScene());
        expect(c.listeners.get("touchmove")?.length).toBe(1);
        expect(c.listeners.get("touchstart")?.length).toBe(1);
        dispose();
        expect(c.listeners.get("touchmove")?.length).toBe(0);
        expect(c.listeners.get("pointermove")?.length).toBe(0);
    });
});
