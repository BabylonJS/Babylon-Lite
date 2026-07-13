/**
 * Gizmo dispatcher hover-pick gating (issue #328).
 *
 * `handleHoverMove` GPU-picks the utility-layer scene on every idle pointer-move
 * so gizmos can swap to a hover material. A DISABLED gizmo (`drag.enabled = false`,
 * i.e. a display-only / non-interactive gizmo) must NOT drive a GPU pick — otherwise
 * moving the pointer over a display-only gizmo keeps issuing async picks that share
 * the picker's staging buffers for no benefit. The dispatcher therefore skips hover
 * picking entirely when no registered drag is enabled.
 *
 * The test drives the REAL dispatcher (`registerPointerDrag` → `onPointerMove`) with a
 * fake canvas + the picker's no-camera fast path (a scene with `camera: null` returns an
 * empty pick immediately), so the gating is exercised without a WebGPU device. Each pick
 * reads `scene.camera` exactly once, so a camera-read counter equals the pick count.
 */
import { describe, expect, it } from "vitest";

import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { UtilityLayer } from "../../../packages/babylon-lite/src/gizmo/utility-layer";
import { createPointerDrag, registerPointerDrag } from "../../../packages/babylon-lite/src/gizmo/pointer-drag";

/** Minimal canvas double: captures the dispatcher's event handlers by type. */
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

/** A scene whose `camera` getter counts each pick (read once per `pickAsyncImpl`). */
function makeCountingScene(): { scene: SceneContext; reads: () => number } {
    let count = 0;
    const scene = {
        surface: { engine: { _device: {} }, canvas: {} },
        get camera() {
            count++;
            return null;
        },
    } as unknown as SceneContext;
    return { scene, reads: () => count };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("gizmo hover-pick gating (display-only gizmos)", () => {
    it("does NOT GPU-pick on pointer-move when every registered drag is disabled", async () => {
        const { scene, reads } = makeCountingScene();
        const layer = { scene } as unknown as UtilityLayer;
        const canvas = makeFakeCanvas();

        const drag = createPointerDrag({ dragAxis: { x: 1, y: 0, z: 0 } });
        drag.enabled = false; // display-only: no interaction
        const dispose = registerPointerDrag(layer, canvas as unknown as HTMLCanvasElement, drag);

        const move = canvas.handlers.get("pointermove")!;
        move({ offsetX: 10, offsetY: 10, pointerId: 1 });
        move({ offsetX: 20, offsetY: 20, pointerId: 1 });
        await flush();

        expect(reads()).toBe(0);
        dispose();
    });

    it("DOES GPU-pick on pointer-move once a drag is enabled", async () => {
        const { scene, reads } = makeCountingScene();
        const layer = { scene } as unknown as UtilityLayer;
        const canvas = makeFakeCanvas();

        const drag = createPointerDrag({ dragAxis: { x: 1, y: 0, z: 0 } });
        drag.enabled = true;
        const dispose = registerPointerDrag(layer, canvas as unknown as HTMLCanvasElement, drag);

        const move = canvas.handlers.get("pointermove")!;
        move({ offsetX: 10, offsetY: 10, pointerId: 1 });
        await flush();

        expect(reads()).toBe(1);
        dispose();
    });

    it("stops picking again when the last enabled drag is disabled at runtime", async () => {
        const { scene, reads } = makeCountingScene();
        const layer = { scene } as unknown as UtilityLayer;
        const canvas = makeFakeCanvas();

        const drag = createPointerDrag({ dragAxis: { x: 1, y: 0, z: 0 } });
        drag.enabled = true;
        const dispose = registerPointerDrag(layer, canvas as unknown as HTMLCanvasElement, drag);
        const move = canvas.handlers.get("pointermove")!;

        move({ offsetX: 5, offsetY: 5, pointerId: 1 });
        await flush();
        expect(reads()).toBe(1);

        drag.enabled = false; // toggle to display-only
        move({ offsetX: 6, offsetY: 6, pointerId: 1 });
        await flush();
        expect(reads()).toBe(1); // unchanged — no new pick

        dispose();
    });
});
