import { describe, expect, it, vi } from "vitest";

import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { UtilityLayer } from "../../../packages/babylon-lite/src/gizmo/utility-layer";

const pickedMesh = {} as Mesh;
const pickResult = {
    hit: true,
    distance: 10,
    pickedPoint: [1, 0, 0] as [number, number, number],
    pickedNormal: null,
    pickedNormalWorld: null,
    pickedFaceNormal: null,
    pickedFaceNormalWorld: null,
    pickedMesh,
    faceId: 0,
    bu: 0,
    bv: 0,
    subMeshId: 0,
    thinInstanceIndex: -1,
    ray: null,
};

vi.mock("../../../packages/babylon-lite/src/picking/gpu-picker.js", () => ({
    createGpuPicker: () => ({}),
    disposePicker: () => undefined,
    pickAsync: () => Promise.resolve(pickResult),
}));

vi.mock("../../../packages/babylon-lite/src/picking/ray.js", () => ({
    createPickingRay: (x: number) => ({ origin: [x, 0, 10], direction: [0, 0, -1] }),
}));

vi.mock("../../../packages/babylon-lite/src/camera/camera.js", () => ({
    getViewProjectionMatrix: () => new Float32Array(16),
    getCameraPosition: () => ({ x: 0, y: 0, z: 10 }),
}));

vi.mock("../../../packages/babylon-lite/src/camera/viewport.js", () => ({
    resolveCameraViewport: () => ({ x: 0, y: 0, width: 100, height: 100 }),
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

function pointerEvent(type: string, offsetX: number, pointerId = 7): PointerEvent {
    return { type, button: 0, offsetX, offsetY: 0, pointerId } as PointerEvent;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pointer drag event payloads", () => {
    it("emits complete BJS-backable payloads and per-move axis distance", async () => {
        const scene = { camera: {} } as SceneContext;
        const layer = { scene } as UtilityLayer;
        const canvas = makeFakeCanvas();
        const drag = createPointerDrag({ dragAxis: { x: 1, y: 0, z: 0 } });
        drag._colliders.push(pickedMesh);
        const starts: Parameters<typeof drag.onDragStart.notify>[0][] = [];
        const moves: Parameters<typeof drag.onDrag.notify>[0][] = [];
        const ends: Parameters<typeof drag.onDragEnd.notify>[0][] = [];
        drag.onDragStart.add((event) => starts.push(event));
        drag.onDrag.add((event) => moves.push(event));
        drag.onDragEnd.add((event) => ends.push(event));
        const dispose = registerPointerDrag(layer, canvas as unknown as HTMLCanvasElement, drag);

        canvas.handlers.get("pointerdown")!(pointerEvent("pointerdown", 1));
        await flush();
        canvas.handlers.get("pointermove")!(pointerEvent("pointermove", 3));
        canvas.handlers.get("pointermove")!(pointerEvent("pointermove", 4));
        canvas.handlers.get("pointerup")!(pointerEvent("pointerup", 4));

        expect(starts).toEqual([
            {
                dragPlanePoint: { x: 1, y: 0, z: 0 },
                pointerId: 7,
                pointerEvent: expect.objectContaining({ type: "pointerdown" }),
                pickInfo: pickResult,
                pickedMesh,
            },
        ]);
        expect(moves).toHaveLength(2);
        expect(moves[0]).toMatchObject({
            delta: { x: 2, y: 0, z: 0 },
            dragPlanePoint: { x: 3, y: 0, z: 0 },
            dragPlaneNormal: { x: 0, y: 0, z: 1 },
            dragDistance: 2,
            pointerId: 7,
        });
        expect(moves[1]).toMatchObject({
            delta: { x: 1, y: 0, z: 0 },
            dragPlanePoint: { x: 4, y: 0, z: 0 },
            dragDistance: 1,
            pointerId: 7,
        });
        expect(ends).toEqual([
            {
                dragPlanePoint: { x: 4, y: 0, z: 0 },
                pointerId: 7,
                pointerEvent: expect.objectContaining({ type: "pointerup" }),
            },
        ]);

        dispose();
    });
});
