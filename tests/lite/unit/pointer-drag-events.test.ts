import { describe, expect, it, vi } from "vitest";

import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { UtilityLayer } from "../../../packages/babylon-lite/src/gizmo/utility-layer";

const pickResult = {
    hit: true,
    pickedMesh: null as Mesh | null,
    pickedPoint: [0, 0, 0] as [number, number, number],
};

vi.mock("../../../packages/babylon-lite/src/picking/gpu-picker.js", () => ({
    createGpuPicker: () => ({}),
    disposePicker: () => undefined,
    pickAsync: () => Promise.resolve(pickResult),
}));

vi.mock("../../../packages/babylon-lite/src/camera/camera.js", () => ({
    getCameraPosition: () => ({ x: 0, y: 0, z: 10 }),
    getViewProjectionMatrix: () => new Float32Array(16),
}));

vi.mock("../../../packages/babylon-lite/src/camera/viewport.js", () => ({
    resolveCameraViewport: () => ({ x: 0, y: 0, width: 100, height: 100 }),
}));

vi.mock("../../../packages/babylon-lite/src/picking/ray.js", () => ({
    createPickingRay: (x: number) => ({
        origin: [0, 0, 10],
        direction: [x, 0, -10],
        length: 100,
    }),
}));

import { createPointerDrag, registerPointerDrag } from "../../../packages/babylon-lite/src/gizmo/pointer-drag";

function makeFakeCanvas() {
    const handlers = new Map<string, (event: PointerEvent) => void>();
    return {
        handlers,
        width: 100,
        height: 100,
        clientWidth: 100,
        clientHeight: 100,
        setAttribute: () => undefined,
        setPointerCapture: () => undefined,
        releasePointerCapture: () => undefined,
        addEventListener: (type: string, handler: (event: PointerEvent) => void) => handlers.set(type, handler),
        removeEventListener: (type: string) => handlers.delete(type),
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pointer drag event payloads", () => {
    it("preserves native cumulative distance and pointer state through release and disposal", async () => {
        const collider = {} as Mesh;
        pickResult.pickedMesh = collider;
        const scene = { camera: {} } as SceneContext;
        const layer = { scene } as UtilityLayer;
        const canvas = makeFakeCanvas();
        const drag = createPointerDrag({ dragAxis: { x: 1, y: 0, z: 0 } });
        drag._colliders.push(collider);
        const starts: Parameters<typeof drag.onDragStart.notify>[0][] = [];
        const moves: Parameters<typeof drag.onDrag.notify>[0][] = [];
        const ends: Parameters<typeof drag.onDragEnd.notify>[0][] = [];
        drag.onDragStart.add((event) => starts.push(event));
        drag.onDrag.add((event) => moves.push(event));
        drag.onDragEnd.add((event) => ends.push(event));
        const unregister = registerPointerDrag(layer, canvas as unknown as HTMLCanvasElement, drag);

        const down = { button: 0, pointerId: 7, offsetX: 0, offsetY: 0 } as PointerEvent;
        const firstMove = { pointerId: 7, offsetX: 1, offsetY: 0 } as PointerEvent;
        const secondMove = { pointerId: 7, offsetX: 2, offsetY: 0 } as PointerEvent;
        const up = { pointerId: 7 } as PointerEvent;
        canvas.handlers.get("pointerdown")!(down);
        await flush();
        canvas.handlers.get("pointermove")!(firstMove);
        canvas.handlers.get("pointermove")!(secondMove);
        canvas.handlers.get("pointerup")!(up);

        expect(starts).toEqual([
            {
                dragPlanePoint: { x: 0, y: 0, z: 0 },
                dragPlaneNormal: { x: 0, y: 0, z: 1 },
                pickInfo: pickResult,
                pointerId: 7,
                pointerEvent: down,
            },
        ]);
        expect(starts[0]!.pickInfo.ray).toEqual({ origin: [0, 0, 10], direction: [0, 0, -10], length: 100 });
        expect(moves).toEqual([
            {
                delta: { x: 1, y: 0, z: 0 },
                dragPlanePoint: { x: 1, y: 0, z: 0 },
                dragDistance: 1,
                dragPlaneNormal: { x: 0, y: 0, z: 1 },
                pointerId: 7,
            },
            {
                delta: { x: 1, y: 0, z: 0 },
                dragPlanePoint: { x: 2, y: 0, z: 0 },
                dragDistance: 2,
                dragPlaneNormal: { x: 0, y: 0, z: 1 },
                pointerId: 7,
            },
        ]);
        expect(ends).toEqual([{ dragPlanePoint: { x: 2, y: 0, z: 0 }, pointerId: 7, pointerEvent: up }]);

        const secondDown = { button: 0, pointerId: 8, offsetX: 0, offsetY: 0 } as PointerEvent;
        canvas.handlers.get("pointerdown")!(secondDown);
        await flush();
        unregister();
        expect(ends[1]).toEqual({ dragPlanePoint: { x: 0, y: 0, z: 0 }, pointerId: 8, pointerEvent: null });
    });

    it("intersects the retained plane before publishing the refreshed normal", async () => {
        const collider = {} as Mesh;
        pickResult.pickedMesh = collider;
        const layer = { scene: { camera: {} } as SceneContext } as UtilityLayer;
        const canvas = makeFakeCanvas();
        const planeNormal = { x: 0, y: 0, z: 1 };
        const drag = createPointerDrag({ dragPlaneNormal: planeNormal });
        drag._colliders.push(collider);
        const moves: Parameters<typeof drag.onDrag.notify>[0][] = [];
        drag.onDrag.add((event) => moves.push(event));
        const unregister = registerPointerDrag(layer, canvas as unknown as HTMLCanvasElement, drag);

        canvas.handlers.get("pointerdown")!({ button: 0, pointerId: 9, offsetX: 0, offsetY: 0 } as PointerEvent);
        await flush();
        planeNormal.y = 1;
        planeNormal.z = 0;
        canvas.handlers.get("pointermove")!({ pointerId: 9, offsetX: 1, offsetY: 0 } as PointerEvent);

        expect(moves).toHaveLength(1);
        expect(moves[0]!.dragPlanePoint).toEqual({ x: 1, y: 0, z: 0 });
        expect(moves[0]!.dragPlaneNormal).toEqual({ x: 0, y: 1, z: 0 });
        unregister();
    });

    it("keeps both the plane normal and anchor frozen when updates are disabled", async () => {
        const collider = {} as Mesh;
        pickResult.pickedMesh = collider;
        const layer = { scene: { camera: {} } as SceneContext } as UtilityLayer;
        const canvas = makeFakeCanvas();
        const planePoint = { x: 0, y: 0, z: 0 };
        const getPlanePoint = vi.fn(() => planePoint);
        const drag = createPointerDrag({
            dragAxis: { x: 1, y: 0, z: 0 },
            getPlanePoint,
            updateDragPlane: false,
        });
        drag._colliders.push(collider);
        const moves: Parameters<typeof drag.onDrag.notify>[0][] = [];
        drag.onDrag.add((event) => moves.push(event));
        const unregister = registerPointerDrag(layer, canvas as unknown as HTMLCanvasElement, drag);

        canvas.handlers.get("pointerdown")!({ button: 0, pointerId: 12, offsetX: 1, offsetY: 0 } as PointerEvent);
        await flush();
        planePoint.z = 5;
        canvas.handlers.get("pointermove")!({ pointerId: 12, offsetX: 1, offsetY: 0 } as PointerEvent);

        expect(getPlanePoint).toHaveBeenCalledTimes(1);
        expect(moves).toHaveLength(1);
        expect(moves[0]!.dragPlanePoint).toEqual({ x: 1, y: 0, z: 0 });
        expect(moves[0]!.delta).toEqual({ x: 0, y: 0, z: 0 });
        unregister();
    });

    it("ends at the last fully notified point when disposed during a move", async () => {
        const collider = {} as Mesh;
        pickResult.pickedMesh = collider;
        const layer = { scene: { camera: {} } as SceneContext } as UtilityLayer;
        const canvas = makeFakeCanvas();
        const drag = createPointerDrag({ dragAxis: { x: 1, y: 0, z: 0 } });
        drag._colliders.push(collider);
        const ends: Parameters<typeof drag.onDragEnd.notify>[0][] = [];
        drag.onDragEnd.add((event) => ends.push(event));
        let unregister: () => void = () => undefined;
        drag.onDrag.add(() => unregister());
        unregister = registerPointerDrag(layer, canvas as unknown as HTMLCanvasElement, drag);

        canvas.handlers.get("pointerdown")!({ button: 0, pointerId: 10, offsetX: 0, offsetY: 0 } as PointerEvent);
        await flush();
        canvas.handlers.get("pointermove")!({ pointerId: 10, offsetX: 1, offsetY: 0 } as PointerEvent);

        expect(ends).toEqual([{ dragPlanePoint: { x: 0, y: 0, z: 0 }, pointerId: 10, pointerEvent: null }]);
    });

    it("does not emit twice when disposed from an end observer", async () => {
        const collider = {} as Mesh;
        pickResult.pickedMesh = collider;
        const layer = { scene: { camera: {} } as SceneContext } as UtilityLayer;
        const canvas = makeFakeCanvas();
        const drag = createPointerDrag({ dragAxis: { x: 1, y: 0, z: 0 } });
        drag._colliders.push(collider);
        let endCount = 0;
        let unregister: () => void = () => undefined;
        drag.onDragEnd.add(() => {
            endCount++;
            unregister();
        });
        unregister = registerPointerDrag(layer, canvas as unknown as HTMLCanvasElement, drag);

        canvas.handlers.get("pointerdown")!({ button: 0, pointerId: 11, offsetX: 0, offsetY: 0 } as PointerEvent);
        await flush();
        canvas.handlers.get("pointerup")!({ pointerId: 11 } as PointerEvent);

        expect(endCount).toBe(1);
    });
});
