import { beforeEach, describe, expect, it, vi } from "vitest";

class NativeObservable<T> {
    private readonly _observers: Array<(event: T) => void> = [];

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

    public get observerCount(): number {
        return this._observers.length;
    }
}

interface NativeStartEvent {
    dragPlanePoint: { x: number; y: number; z: number };
    pointerId: number;
    pointerEvent: PointerEvent;
    pickInfo: ReturnType<typeof pickInfo>;
    pickedMesh: ReturnType<typeof pickInfo>["pickedMesh"];
}

interface NativeMoveEvent {
    delta: { x: number; y: number; z: number };
    dragPlanePoint: { x: number; y: number; z: number };
    dragPlaneNormal: { x: number; y: number; z: number };
    dragDistance: number;
    pointerId: number;
    pointerEvent: PointerEvent;
}

interface NativeEndEvent {
    dragPlanePoint: { x: number; y: number; z: number };
    pointerId: number;
    pointerEvent: PointerEvent | null;
}

interface NativeDrag {
    enabled: boolean;
    onDragStart: NativeObservable<NativeStartEvent>;
    onDrag: NativeObservable<NativeMoveEvent>;
    onDragEnd: NativeObservable<NativeEndEvent>;
}

interface NativeComposite {
    xGizmo: { drag: NativeDrag };
    yGizmo: { drag: NativeDrag };
    zGizmo: { drag: NativeDrag };
}

const liteMocks = vi.hoisted(() => ({
    createPositionGizmo: vi.fn(),
    createRotationGizmo: vi.fn(),
    disposePositionGizmo: vi.fn(),
    disposeRotationGizmo: vi.fn(),
    setPositionGizmoLocalCoordinates: vi.fn(),
    setRotationGizmoLocalCoordinates: vi.fn(),
}));

vi.mock("babylon-lite", async (importActual) => ({
    ...(await importActual<typeof import("babylon-lite")>()),
    ...liteMocks,
}));

import { PointerEventTypes } from "../src/events/pointer-events";
import { PositionGizmo, RotationGizmo } from "../src/gizmos/gizmos";
import { Vector3 } from "../src/math/vector";

function nativeDrag(): NativeDrag {
    return {
        enabled: true,
        onDragStart: new NativeObservable(),
        onDrag: new NativeObservable(),
        onDragEnd: new NativeObservable(),
    };
}

function nativeComposite(): NativeComposite {
    return {
        xGizmo: { drag: nativeDrag() },
        yGizmo: { drag: nativeDrag() },
        zGizmo: { drag: nativeDrag() },
    };
}

function fakeLayer() {
    return { _engine: {}, _lite: {} };
}

function pointerEvent(pointerId: number): PointerEvent {
    return { pointerId } as PointerEvent;
}

function pickInfo() {
    return {
        hit: true,
        distance: 4,
        pickedPoint: [1, 2, 3] as [number, number, number],
        pickedNormal: [0, 1, 0] as [number, number, number],
        pickedNormalWorld: [0, 1, 0] as [number, number, number],
        pickedFaceNormal: null,
        pickedFaceNormalWorld: null,
        pickedMesh: {
            name: "axis-collider",
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scaling: { x: 1, y: 1, z: 1 },
            children: [],
        },
        faceId: 2,
        bu: 0.25,
        bv: 0.5,
        subMeshId: 1,
        thinInstanceIndex: -1,
        ray: null,
    };
}

describe.each([
    ["PositionGizmo", PositionGizmo, liteMocks.createPositionGizmo, liteMocks.disposePositionGizmo],
    ["RotationGizmo", RotationGizmo, liteMocks.createRotationGizmo, liteMocks.disposeRotationGizmo],
] as const)("%s composite drag observables", (_name, Gizmo, createGizmo, disposeGizmo) => {
    let native: NativeComposite;

    beforeEach(() => {
        vi.clearAllMocks();
        native = nativeComposite();
        createGizmo.mockReturnValue(native);
    });

    it("relays every axis once in start, move, end order with Babylon.js payloads", () => {
        const gizmo = new Gizmo(fakeLayer() as never);
        const events: Array<{ phase: string; payload: unknown }> = [];
        gizmo.onDragStartObservable.add((payload) => events.push({ phase: "start", payload }));
        gizmo.onDragObservable.add((payload) => events.push({ phase: "move", payload }));
        gizmo.onDragEndObservable.add((payload) => events.push({ phase: "end", payload }));
        const downEvents: PointerEvent[] = [];

        for (const [axisIndex, subGizmo] of [native.xGizmo, native.yGizmo, native.zGizmo].entries()) {
            const pointerId = axisIndex + 11;
            const downEvent = pointerEvent(pointerId);
            downEvents.push(downEvent);
            const moveEvent = pointerEvent(pointerId);
            const upEvent = pointerEvent(pointerId);
            const nativePickInfo = pickInfo();
            subGizmo.drag.onDragStart.notify({
                dragPlanePoint: { x: axisIndex, y: 2, z: 3 },
                pointerId,
                pointerEvent: downEvent,
                pickInfo: nativePickInfo,
                pickedMesh: nativePickInfo.pickedMesh,
            });
            subGizmo.drag.onDrag.notify({
                delta: { x: 4, y: 5, z: 6 },
                dragPlanePoint: { x: 7, y: 8, z: 9 },
                dragPlaneNormal: { x: 0, y: 1, z: 0 },
                dragDistance: 10,
                pointerId,
                pointerEvent: moveEvent,
            });
            subGizmo.drag.onDragEnd.notify({ dragPlanePoint: { x: 7, y: 8, z: 9 }, pointerId, pointerEvent: upEvent });
        }

        expect(events.map(({ phase }) => phase)).toEqual(["start", "move", "end", "start", "move", "end", "start", "move", "end"]);
        expect(events[0]!.payload).toMatchObject({
            dragPlanePoint: new Vector3(0, 2, 3),
            pointerId: 11,
            pointerInfo: { type: PointerEventTypes.POINTERDOWN },
        });
        expect(events[1]!.payload).toMatchObject({
            delta: new Vector3(4, 5, 6),
            dragPlanePoint: new Vector3(7, 8, 9),
            dragPlaneNormal: new Vector3(0, 1, 0),
            dragDistance: 10,
            pointerId: 11,
            pointerInfo: { type: PointerEventTypes.POINTERDOWN },
        });
        expect(events[2]!.payload).toMatchObject({
            dragPlanePoint: new Vector3(7, 8, 9),
            pointerId: 11,
            pointerInfo: { type: PointerEventTypes.POINTERDOWN },
        });
        expect((events[1]!.payload as { delta: unknown }).delta).toBeInstanceOf(Vector3);
        const startPointerInfo = (events[0]!.payload as { pointerInfo: { event: PointerEvent; pickInfo: { pickedPoint: Vector3; pickedMesh: { name: string } } } }).pointerInfo;
        expect((events[1]!.payload as { pointerInfo: unknown }).pointerInfo).toBe(startPointerInfo);
        expect((events[2]!.payload as { pointerInfo: unknown }).pointerInfo).toBe(startPointerInfo);
        expect(startPointerInfo.event).toBe(downEvents[0]);
        expect(startPointerInfo.pickInfo.pickedPoint).toEqual(new Vector3(1, 2, 3));
        expect(startPointerInfo.pickInfo.pickedMesh.name).toBe("axis-collider");
    });

    it("removes native subscriptions and clears public observers on disposal", () => {
        const gizmo = new Gizmo(fakeLayer() as never);
        const observer = vi.fn();
        gizmo.onDragStartObservable.add(observer);
        gizmo.onDragObservable.add(observer);
        gizmo.onDragEndObservable.add(observer);

        gizmo.dispose();

        for (const subGizmo of [native.xGizmo, native.yGizmo, native.zGizmo]) {
            expect(subGizmo.drag.onDragStart.observerCount).toBe(0);
            expect(subGizmo.drag.onDrag.observerCount).toBe(0);
            expect(subGizmo.drag.onDragEnd.observerCount).toBe(0);
            subGizmo.drag.onDragStart.notify({
                dragPlanePoint: { x: 0, y: 0, z: 0 },
                pointerId: 1,
                pointerEvent: pointerEvent(1),
                pickInfo: pickInfo(),
                pickedMesh: pickInfo().pickedMesh,
            });
        }
        expect(gizmo.onDragStartObservable.hasObservers()).toBe(false);
        expect(gizmo.onDragObservable.hasObservers()).toBe(false);
        expect(gizmo.onDragEndObservable.hasObservers()).toBe(false);
        expect(observer).not.toHaveBeenCalled();
        expect(disposeGizmo).toHaveBeenCalledOnce();
    });

    it("relays an active drag end before clearing observers during disposal", () => {
        const gizmo = new Gizmo(fakeLayer() as never);
        const endObserver = vi.fn();
        const downEvent = pointerEvent(19);
        gizmo.onDragEndObservable.add(endObserver);
        const nativePickInfo = pickInfo();
        native.xGizmo.drag.onDragStart.notify({
            dragPlanePoint: { x: 1, y: 2, z: 3 },
            pointerId: 19,
            pointerEvent: downEvent,
            pickInfo: nativePickInfo,
            pickedMesh: nativePickInfo.pickedMesh,
        });
        disposeGizmo.mockImplementationOnce(() => {
            native.xGizmo.drag.onDragEnd.notify({ dragPlanePoint: { x: 4, y: 5, z: 6 }, pointerId: 19, pointerEvent: null });
        });

        gizmo.dispose();

        expect(endObserver).toHaveBeenCalledWith({
            dragPlanePoint: new Vector3(4, 5, 6),
            pointerId: 19,
            pointerInfo: expect.objectContaining({ type: PointerEventTypes.POINTERDOWN, event: downEvent }),
        });
        expect(gizmo.onDragEndObservable.hasObservers()).toBe(false);
    });
});
