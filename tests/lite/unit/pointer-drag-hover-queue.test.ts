/**
 * Gizmo dispatcher hover-pick queue regression.
 *
 * GPU picks share staging buffers and are serialized per picker. Submitting one
 * hover pick for every pointer-move creates an unbounded queue, so a later
 * pointer-down pick (and camera controls waiting on it) can be delayed by
 * seconds. The dispatcher must keep at most one hover pick in flight and
 * coalesce newer hover positions.
 */
import { describe, expect, it, vi } from "vitest";

import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { PickingInfo } from "../../../packages/babylon-lite/src/picking/picking-info";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { UtilityLayer } from "../../../packages/babylon-lite/src/gizmo/utility-layer";

interface PendingPick {
    x: number;
    y: number;
    resolve: (result: PickingInfo) => void;
}

const pendingPicks: PendingPick[] = [];

vi.mock("../../../packages/babylon-lite/src/picking/gpu-picker.js", () => ({
    createGpuPicker: () => ({}),
    disposePicker: () => undefined,
    pickAsync: (_picker: unknown, x: number, y: number) =>
        new Promise<PickingInfo>((resolve) => {
            pendingPicks.push({ x, y, resolve });
        }),
}));

import { createPointerDrag, isGizmoPickPending, registerPointerDrag } from "../../../packages/babylon-lite/src/gizmo/pointer-drag";

function makeFakeCanvas() {
    const handlers = new Map<string, (event: unknown) => void>();
    return {
        handlers,
        setAttribute: () => undefined,
        setPointerCapture: () => undefined,
        releasePointerCapture: () => undefined,
        addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
        removeEventListener: (type: string) => handlers.delete(type),
    };
}

const miss = { hit: false, pickedMesh: null as Mesh | null } as PickingInfo;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("gizmo hover-pick queue", () => {
    it("coalesces a burst of hover moves so pointer-down follows at most one hover pick", async () => {
        pendingPicks.length = 0;
        const layer = { scene: {} as SceneContext } as UtilityLayer;
        const canvas = makeFakeCanvas();
        const drag = createPointerDrag({ dragAxis: { x: 1, y: 0, z: 0 } });
        const dispose = registerPointerDrag(layer, canvas as unknown as HTMLCanvasElement, drag);
        const move = canvas.handlers.get("pointermove")!;
        const down = canvas.handlers.get("pointerdown")!;

        for (let i = 0; i < 100; i++) {
            move({ offsetX: i, offsetY: i + 1, pointerId: 1 });
        }

        expect(pendingPicks).toHaveLength(1);
        expect(pendingPicks[0]).toMatchObject({ x: 0, y: 1 });

        down({ button: 0, offsetX: 400, offsetY: 300, pointerId: 1 });
        expect(isGizmoPickPending(canvas as unknown as HTMLCanvasElement)).toBe(true);
        expect(pendingPicks).toHaveLength(2);
        expect(pendingPicks[1]).toMatchObject({ x: 400, y: 300 });

        pendingPicks[0]!.resolve(miss);
        pendingPicks[1]!.resolve(miss);
        await flush();

        expect(isGizmoPickPending(canvas as unknown as HTMLCanvasElement)).toBe(false);
        expect(pendingPicks).toHaveLength(2);
        dispose();
    });
});
