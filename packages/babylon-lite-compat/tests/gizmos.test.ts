/**
 * Compat gizmo interactivity API (issue #328).
 *
 * BJS gizmos expose `isEnabled` on each per-axis sub-gizmo and `xGizmo`/`yGizmo`/`zGizmo`
 * on the composite Position/Rotation/Scale gizmos. Setting `isEnabled = false` makes a
 * gizmo non-interactive (no drag, and — with the Lite dispatcher fix — no GPU hover pick)
 * while keeping it visible and following its node: the public, BJS-shaped replacement for
 * poking a native gizmo's private `_disposePointer()`.
 *
 * These are GPU-free unit tests: the wrappers are built with `Object.create` over a fake
 * Lite gizmo so no engine/device is required. They pin down that `isEnabled` proxies to the
 * Lite `drag.enabled` flag and that the composite sub-gizmo accessors reach the real
 * sub-gizmos with stable identity.
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
import { PointerEventTypes, PointerInfo, Vector3 } from "../src/index";

type FakeDrag = { drag: { enabled: boolean } };

function fakeLite(): FakeDrag {
    return { drag: { enabled: true } };
}

class FakeObservable<T> {
    private readonly _observers: ((event: T) => void)[] = [];

    public add(observer: (event: T) => void): () => void {
        this._observers.push(observer);
        return () => {
            const index = this._observers.indexOf(observer);
            if (index !== -1) {
                this._observers.splice(index, 1);
            }
        };
    }

    public notify(event: T): void {
        for (const observer of this._observers.slice()) {
            observer(event);
        }
    }
}

type FakeCompositeDrag = {
    onDragStart: FakeObservable<PointerDragStartEvent>;
    onDrag: FakeObservable<PointerDragMoveEvent>;
    onDragEnd: FakeObservable<PointerDragEndEvent>;
};

type FakeCompositeLite = {
    xGizmo: { drag: FakeCompositeDrag };
    yGizmo: { drag: FakeCompositeDrag };
    zGizmo: { drag: FakeCompositeDrag };
};

function fakeCompositeLite(): FakeCompositeLite {
    const subGizmo = () => ({
        drag: {
            onDragStart: new FakeObservable<PointerDragStartEvent>(),
            onDrag: new FakeObservable<PointerDragMoveEvent>(),
            onDragEnd: new FakeObservable<PointerDragEndEvent>(),
        },
    });
    return { xGizmo: subGizmo(), yGizmo: subGizmo(), zGizmo: subGizmo() };
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
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        ["PositionGizmo", PositionGizmo, liteMocks.createPositionGizmo, liteMocks.disposePositionGizmo],
        ["RotationGizmo", RotationGizmo, liteMocks.createRotationGizmo, liteMocks.disposeRotationGizmo],
    ] as const)("%s relays every axis with Babylon.js payloads and cleans up on dispose", (_name, Ctor, create, dispose) => {
        const lite = fakeCompositeLite();
        create.mockReturnValue(lite);
        const layer = { _engine: {}, _lite: {} } as UtilityLayerRenderer;
        const gizmo = new Ctor(layer);
        const starts: DragStartEndEvent[] = [];
        const moves: DragEvent[] = [];
        const ends: DragStartEndEvent[] = [];
        gizmo.onDragStartObservable.add((event) => starts.push(event));
        gizmo.onDragObservable.add((event) => moves.push(event));
        gizmo.onDragEndObservable.add((event) => ends.push(event));
        const downEvents: PointerEvent[] = [];

        for (const [axisIndex, subGizmo] of [lite.xGizmo, lite.yGizmo, lite.zGizmo].entries()) {
            const pointerId = axisIndex + 1;
            const down = { pointerId } as PointerEvent;
            const up = { pointerId } as PointerEvent;
            downEvents.push(down);
            subGizmo.drag.onDragStart.notify({
                dragPlanePoint: { x: axisIndex, y: 2, z: 3 },
                pointerId,
                pointerEvent: down,
            });
            subGizmo.drag.onDrag.notify({
                delta: { x: 1, y: 0, z: 0 },
                dragPlanePoint: { x: axisIndex + 0.5, y: 2, z: 3 },
                dragPlaneNormal: { x: 0, y: 1, z: 0 },
                dragDistance: 0.5,
                pointerId,
            });
            subGizmo.drag.onDragEnd.notify({
                dragPlanePoint: { x: axisIndex + 0.5, y: 2, z: 3 },
                pointerId,
                pointerEvent: up,
            });
        }

        expect(starts).toHaveLength(3);
        expect(moves).toHaveLength(3);
        expect(ends).toHaveLength(3);
        expect(starts[0]).toEqual({
            dragPlanePoint: new Vector3(0, 2, 3),
            pointerId: 1,
            pointerInfo: new PointerInfo(PointerEventTypes.POINTERDOWN, downEvents[0]!, null),
        });
        expect(moves[1]).toEqual({
            delta: new Vector3(1, 0, 0),
            dragPlanePoint: new Vector3(1.5, 2, 3),
            dragPlaneNormal: new Vector3(0, 1, 0),
            dragDistance: 0.5,
            pointerId: 2,
            pointerInfo: new PointerInfo(PointerEventTypes.POINTERDOWN, downEvents[1]!, null),
        });
        expect(ends[2]).toEqual({
            dragPlanePoint: new Vector3(2.5, 2, 3),
            pointerId: 3,
            pointerInfo: new PointerInfo(PointerEventTypes.POINTERDOWN, downEvents[2]!, null),
        });
        expect(moves[0]!.pointerInfo).toBe(starts[0]!.pointerInfo);
        expect(ends[0]!.pointerInfo).toBe(starts[0]!.pointerInfo);
        expect(starts[0]!.dragPlanePoint).toBeInstanceOf(Vector3);
        expect(moves[0]!.delta).toBeInstanceOf(Vector3);
        expect(moves[0]!.dragPlaneNormal).toBeInstanceOf(Vector3);

        const cancelDown = { pointerId: 4 } as PointerEvent;
        lite.xGizmo.drag.onDragStart.notify({
            dragPlanePoint: { x: 4, y: 2, z: 3 },
            pointerId: 4,
            pointerEvent: cancelDown,
        });
        dispose.mockImplementationOnce((value: FakeCompositeLite) => {
            value.xGizmo.drag.onDragEnd.notify({
                dragPlanePoint: { x: 4, y: 2, z: 3 },
                pointerId: 4,
                pointerEvent: null,
            });
        });
        gizmo.dispose();
        expect(dispose).toHaveBeenCalledWith(lite, layer._lite);
        expect(ends).toHaveLength(4);
        expect(ends[3]!.pointerInfo).toBe(starts[3]!.pointerInfo);
        expect(gizmo.onDragStartObservable.hasObservers()).toBe(false);
        expect(gizmo.onDragObservable.hasObservers()).toBe(false);
        expect(gizmo.onDragEndObservable.hasObservers()).toBe(false);

        lite.xGizmo.drag.onDragStart.notify({
            dragPlanePoint: { x: 0, y: 0, z: 0 },
            pointerId: 4,
            pointerEvent: { pointerId: 4 } as PointerEvent,
        });
        expect(starts).toHaveLength(4);
    });
});
