/**
 * Compat gizmo interactivity and composite drag-observable APIs (issues #328 and #720).
 *
 * BJS gizmos expose `isEnabled` on each per-axis sub-gizmo and `xGizmo`/`yGizmo`/`zGizmo`
 * on the composite Position/Rotation/Scale gizmos. Setting `isEnabled = false` makes a
 * gizmo non-interactive (no drag, and — with the Lite dispatcher fix — no GPU hover pick)
 * while keeping it visible and following its node: the public, BJS-shaped replacement for
 * poking a native gizmo's private `_disposePointer()`.
 *
 * These are GPU-free unit tests: wrappers use fake Lite gizmos so no engine/device is
 * required. They cover the `isEnabled` proxy, stable composite sub-gizmo identity, and
 * Babylon.js-shaped drag lifecycle relays with disposal cleanup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const liteMocks = vi.hoisted(() => ({
    createPositionGizmo: vi.fn(),
    createRotationGizmo: vi.fn(),
    disposePositionGizmo: vi.fn(),
    disposeRotationGizmo: vi.fn(),
    setPositionGizmoLocalCoordinates: vi.fn(),
    setRotationGizmoLocalCoordinates: vi.fn(),
}));

vi.mock("babylon-lite", async (importOriginal) => ({
    ...(await importOriginal<typeof import("babylon-lite")>()),
    ...liteMocks,
}));

import type { PointerDragEndEvent, PointerDragMoveEvent, PointerDragStartEvent } from "babylon-lite";
import { AxisDragGizmo, PlaneDragGizmo, PlaneRotationGizmo, AxisScaleGizmo, PositionGizmo, RotationGizmo, ScaleGizmo } from "../src/gizmos/gizmos";
import type { DragEvent, DragStartEndEvent, UtilityLayerRenderer } from "../src/index";
import { PointerEventTypes, Vector3 } from "../src/index";

class FakeLiteObservable<T> {
    private readonly _callbacks: ((event: T) => void)[] = [];

    public add(callback: (event: T) => void): () => void {
        this._callbacks.push(callback);
        return () => {
            const index = this._callbacks.indexOf(callback);
            if (index !== -1) {
                this._callbacks.splice(index, 1);
            }
        };
    }

    public notify(event: T): void {
        for (const callback of this._callbacks.slice()) {
            callback(event);
        }
    }

    public get count(): number {
        return this._callbacks.length;
    }
}

type FakeDrag = { drag: { enabled: boolean } };
type FakeCompositeAxis = {
    drag: {
        enabled: boolean;
        onDragStart: FakeLiteObservable<PointerDragStartEvent>;
        onDrag: FakeLiteObservable<PointerDragMoveEvent>;
        onDragEnd: FakeLiteObservable<PointerDragEndEvent>;
    };
};

function fakeLite(): FakeDrag {
    return { drag: { enabled: true } };
}

/** Build a single-axis gizmo wrapper over a fake Lite sub-gizmo (no engine). */
function wrap<T>(ctor: { _fromLite(lite: unknown, layer: unknown): T }, lite: unknown): T {
    return ctor._fromLite(lite, {} as unknown);
}

describe("compat gizmo isEnabled proxy", () => {
    it.each([
        ["AxisDragGizmo", AxisDragGizmo],
        ["PlaneDragGizmo", PlaneDragGizmo],
        ["PlaneRotationGizmo", PlaneRotationGizmo],
        ["AxisScaleGizmo", AxisScaleGizmo],
    ] as const)("%s.isEnabled reads/writes the Lite drag.enabled flag", (_name, ctor) => {
        const lite = fakeLite();
        const g = wrap(ctor as unknown as { _fromLite(l: unknown, y: unknown): { isEnabled: boolean } }, lite);

        expect(g.isEnabled).toBe(true);
        g.isEnabled = false;
        expect(lite.drag.enabled).toBe(false);
        expect(g.isEnabled).toBe(false);
        g.isEnabled = true;
        expect(lite.drag.enabled).toBe(true);
    });
});

describe("compat composite gizmo sub-gizmo accessors", () => {
    function fakeComposite(): { xGizmo: FakeDrag; yGizmo: FakeDrag; zGizmo: FakeDrag } {
        return { xGizmo: fakeLite(), yGizmo: fakeLite(), zGizmo: fakeLite() };
    }

    function makeComposite<T>(Ctor: { prototype: T }, lite: unknown): T {
        const g = Object.create(Ctor.prototype as object) as { _lite: unknown; _layer: unknown };
        g._lite = lite;
        g._layer = {};
        return g as unknown as T;
    }

    it.each([
        ["PositionGizmo", PositionGizmo],
        ["RotationGizmo", RotationGizmo],
        ["ScaleGizmo", ScaleGizmo],
    ] as const)("%s exposes xGizmo/yGizmo/zGizmo that disable the matching Lite sub-drag", (_name, Ctor) => {
        const lite = fakeComposite();
        const g = makeComposite(Ctor as unknown as { prototype: unknown }, lite) as unknown as {
            xGizmo: { isEnabled: boolean };
            yGizmo: { isEnabled: boolean };
            zGizmo: { isEnabled: boolean };
        };

        // Identity is stable (cached wrappers).
        expect(g.xGizmo).toBe(g.xGizmo);

        // Making the whole gizmo display-only disables every axis' Lite drag.
        g.xGizmo.isEnabled = false;
        g.yGizmo.isEnabled = false;
        g.zGizmo.isEnabled = false;
        expect([lite.xGizmo.drag.enabled, lite.yGizmo.drag.enabled, lite.zGizmo.drag.enabled]).toEqual([false, false, false]);
    });
});

describe("compat composite gizmo drag observables", () => {
    function fakeAxis(): FakeCompositeAxis {
        return {
            drag: {
                enabled: true,
                onDragStart: new FakeLiteObservable(),
                onDrag: new FakeLiteObservable(),
                onDragEnd: new FakeLiteObservable(),
            },
        };
    }

    function fakeDragComposite(): { xGizmo: FakeCompositeAxis; yGizmo: FakeCompositeAxis; zGizmo: FakeCompositeAxis } {
        return { xGizmo: fakeAxis(), yGizmo: fakeAxis(), zGizmo: fakeAxis() };
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        ["PositionGizmo", PositionGizmo, liteMocks.createPositionGizmo, liteMocks.disposePositionGizmo],
        ["RotationGizmo", RotationGizmo, liteMocks.createRotationGizmo, liteMocks.disposeRotationGizmo],
    ] as const)("%s relays every axis with Babylon.js payloads and cleans up on disposal", (_name, Ctor, create, dispose) => {
        const lite = fakeDragComposite();
        create.mockReturnValue(lite);
        const layer = { _engine: {}, _lite: {} } as UtilityLayerRenderer;
        const gizmo = new Ctor(layer);
        const starts: DragStartEndEvent[] = [];
        const moves: DragEvent[] = [];
        const ends: DragStartEndEvent[] = [];
        gizmo.onDragStartObservable.add((event) => starts.push(event));
        gizmo.onDragObservable.add((event) => moves.push(event));
        gizmo.onDragEndObservable.add((event) => ends.push(event));

        for (const [axisIndex, axis] of [lite.xGizmo, lite.yGizmo, lite.zGizmo].entries()) {
            const pointerId = axisIndex + 1;
            const startEvent = { pointerId } as PointerEvent;
            const endEvent = { pointerId } as PointerEvent;
            axis.drag.onDragStart.notify({ dragPlanePoint: { x: axisIndex, y: 2, z: 3 }, pointerEvent: startEvent });
            axis.drag.onDrag.notify({
                delta: { x: 0.25, y: 0.5, z: 0.75 },
                dragPlanePoint: { x: axisIndex + 1, y: 3, z: 4 },
                dragPlaneNormal: { x: 0, y: 1, z: 0 },
                dragDistance: axisIndex + 0.5,
            });
            axis.drag.onDragEnd.notify({ dragPlanePoint: { x: axisIndex + 1, y: 3, z: 4 }, pointerEvent: endEvent });

            expect(starts[axisIndex]).toMatchObject({
                dragPlanePoint: new Vector3(axisIndex, 2, 3),
                pointerId,
                pointerInfo: { type: PointerEventTypes.POINTERDOWN, event: startEvent },
            });
            expect(moves[axisIndex]).toMatchObject({
                delta: new Vector3(0.25, 0.5, 0.75),
                dragPlanePoint: new Vector3(axisIndex + 1, 3, 4),
                dragPlaneNormal: new Vector3(0, 1, 0),
                dragDistance: axisIndex + 0.5,
                pointerId,
                pointerInfo: { type: PointerEventTypes.POINTERDOWN, event: startEvent },
            });
            expect(ends[axisIndex]).toMatchObject({
                dragPlanePoint: new Vector3(axisIndex + 1, 3, 4),
                pointerId,
                pointerInfo: { type: PointerEventTypes.POINTERDOWN, event: startEvent },
            });
            expect(moves[axisIndex]!.pointerInfo).toBe(starts[axisIndex]!.pointerInfo);
            expect(ends[axisIndex]!.pointerInfo).toBe(starts[axisIndex]!.pointerInfo);
        }

        expect(starts).toHaveLength(3);
        expect(moves).toHaveLength(3);
        expect(ends).toHaveLength(3);

        const disposePointerEvent = { pointerId: 99 } as PointerEvent;
        lite.xGizmo.drag.onDragStart.notify({ dragPlanePoint: { x: 5, y: 6, z: 7 }, pointerEvent: disposePointerEvent });
        const disposePointerInfo = starts.at(-1)!.pointerInfo;
        dispose.mockImplementationOnce((value: typeof lite) => {
            value.xGizmo.drag.onDragEnd.notify({ dragPlanePoint: { x: 8, y: 9, z: 10 }, pointerEvent: null });
        });

        gizmo.dispose();

        expect(dispose).toHaveBeenCalledOnce();
        expect(ends.at(-1)).toMatchObject({
            dragPlanePoint: new Vector3(8, 9, 10),
            pointerId: 99,
            pointerInfo: { type: PointerEventTypes.POINTERDOWN, event: disposePointerEvent },
        });
        expect(ends.at(-1)!.pointerInfo).toBe(disposePointerInfo);
        expect(gizmo.onDragStartObservable.hasObservers()).toBe(false);
        expect(gizmo.onDragObservable.hasObservers()).toBe(false);
        expect(gizmo.onDragEndObservable.hasObservers()).toBe(false);
        for (const axis of [lite.xGizmo, lite.yGizmo, lite.zGizmo]) {
            expect(axis.drag.onDragStart.count).toBe(0);
            expect(axis.drag.onDrag.count).toBe(0);
            expect(axis.drag.onDragEnd.count).toBe(0);
        }
    });
});
