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
        origin: [x, 0, 1],
        direction: [0, 0, -1],
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
    it("reports per-move distance and preserves pointer state through release and disposal", async () => {
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

        expect(starts).toEqual([{ dragPlanePoint: { x: 0, y: 0, z: 0 }, pointerId: 7, pointerEvent: down }]);
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
                dragDistance: 1,
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
});
