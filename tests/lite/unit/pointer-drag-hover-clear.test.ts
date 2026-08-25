/**
 * Gizmo dispatcher stale-hover clearing (issue #328 review follow-up).
 *
 * When a gizmo is hovered and then disabled at runtime (`drag.enabled = false`,
 * i.e. it becomes display-only), the very next idle pointer-move must clear the
 * lingering hover so the gizmo drops back to its normal material instead of
 * staying stuck in its hover material. The dispatcher achieves this by still
 * calling `handleHoverMove` on every move — the enabled-check lives INSIDE
 * `handleHoverMove`, which skips the GPU pick when nothing is interactive but
 * still runs the hover-transition (clear) logic.
 *
 * Unlike the sibling hover-skip test (which uses the picker's no-camera fast
 * path), this test mocks the GPU picker module so `pickAsync` can return a real
 * hit against a registered collider mesh — the only way to establish a hover
 * state without a WebGPU device.
 */
import { describe, expect, it, vi } from "vitest";

import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { UtilityLayer } from "../../../packages/babylon-lite/src/gizmo/utility-layer";

// Mutable pick result the mocked `pickAsync` returns; tests flip it per move.
const pickResult: { hit: boolean; pickedMesh: Mesh | null } = { hit: false, pickedMesh: null };

vi.mock("../../../packages/babylon-lite/src/picking/gpu-picker.js", () => ({
    createGpuPicker: () => ({}),
    disposePicker: () => undefined,
    pickAsync: () => Promise.resolve(pickResult),
}));

import { createPointerDrag, registerPointerDrag } from "../../../packages/babylon-lite/src/gizmo/pointer-drag";

function makeFakeCanvas() {
    const handlers = new Map<string, (e: unknown) => void>();
    return {
        handlers,
        setAttribute: () => undefined,
        setPointerCapture: () => undefined,
        releasePointerCapture: () => undefined,
        addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
        removeEventListener: (type: string) => handlers.delete(type),
    };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("gizmo stale-hover clearing (display-only toggle)", () => {
    it("clears a lingering hover when the hovered drag is disabled at runtime", async () => {
        const layer = { scene: {} as SceneContext } as unknown as UtilityLayer;
        const canvas = makeFakeCanvas();

        const drag = createPointerDrag({ dragAxis: { x: 1, y: 0, z: 0 } });
        drag.enabled = true;
        const collider = { name: "x-collider" } as unknown as Mesh;
        drag._colliders.push(collider);

        const dispose = registerPointerDrag(layer, canvas as unknown as HTMLCanvasElement, drag);
        const move = canvas.handlers.get("pointermove")!;

        // Pointer hovers the collider -> hover engaged.
        pickResult.hit = true;
        pickResult.pickedMesh = collider;
        move({ offsetX: 10, offsetY: 10, pointerId: 1 });
        await flush();
        expect(drag.hovering).toBe(true);

        // Gizmo becomes display-only. Next move must clear the stuck hover even
        // though no GPU pick runs (the pick result still reports a hit).
        drag.enabled = false;
        move({ offsetX: 11, offsetY: 11, pointerId: 1 });
        await flush();
        expect(drag.hovering).toBe(false);

        dispose();
    });
});
