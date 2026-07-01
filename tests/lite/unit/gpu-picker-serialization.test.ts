/**
 * GPU picker serialization / no-deadlock tests (issue #328).
 *
 * A `GpuPicker` owns a single pair of 1×1 staging buffers (`pick-color-staging` /
 * `pick-depth-staging`). Two picks that map them concurrently crash WebGPU with
 * "buffer already mapped". `pickAsync` therefore serializes: each pick waits for the
 * previous one to settle before starting. The risk with any such gate is a permanent
 * lock — a pick that never resolves, or a rejected pick that poisons the chain, would
 * block every future pick forever. These tests pin down that the gate:
 *   - runs picks strictly one-at-a-time (never overlapping),
 *   - lets a failed pick be followed by a successful one (no poison / permanent lock),
 *   - never leaves the internal gate rejected.
 *
 * They drive the REAL `pickAsync` wrapper via `pickImpl`'s no-camera fast path (a scene
 * with `camera: null` returns an empty `PickingInfo` immediately), so the serialization
 * logic is exercised without a WebGPU device.
 */
import { describe, expect, it } from "vitest";

import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { createGpuPicker, pickAsync } from "../../../packages/babylon-lite/src/picking/gpu-picker";

/** A scene that makes `pickImpl` return an empty pick immediately (no camera, no device work). */
function makeIdleScene(): SceneContext {
    return {
        surface: { engine: { _device: {} }, canvas: {} },
        camera: null,
    } as unknown as SceneContext;
}

describe("gpu picker pick serialization", () => {
    it("resolves every pick when many are started concurrently (no deadlock)", async () => {
        const picker = createGpuPicker(makeIdleScene());

        const results = await Promise.all([pickAsync(picker, 0, 0), pickAsync(picker, 1, 1), pickAsync(picker, 2, 2), pickAsync(picker, 3, 3)]);

        expect(results).toHaveLength(4);
        expect(results.every((r) => r.hit === false)).toBe(true);
    });

    it("starts each pick only after the previous one has settled (strict serialization)", async () => {
        let started = 0;
        let settled = 0;
        let violation = false;
        // `camera` is read exactly once per pickImpl, right before the no-camera early return.
        // For strict serialization, every previously-started pick must have settled by then.
        const scene = {
            surface: { engine: { _device: {} }, canvas: {} },
            get camera() {
                if (started !== settled) {
                    violation = true;
                }
                started++;
                return null;
            },
        } as unknown as SceneContext;

        const picker = createGpuPicker(scene);
        const runs = [0, 1, 2, 3, 4].map((i) =>
            pickAsync(picker, i, i).finally(() => {
                settled++;
            })
        );
        await Promise.all(runs);

        expect(violation).toBe(false);
        expect(started).toBe(5);
    });

    it("does not let a failed pick permanently block later picks", async () => {
        // First scene throws inside pickImpl → that pick rejects.
        const throwingScene = {
            get surface(): never {
                throw new Error("boom");
            },
            camera: null,
        } as unknown as SceneContext;

        const picker = createGpuPicker(throwingScene);
        await expect(pickAsync(picker, 0, 0)).rejects.toThrow("boom");

        // Swap to a healthy scene: the chain must have advanced despite the rejection.
        (picker as { _scene: SceneContext })._scene = makeIdleScene();
        const info = await pickAsync(picker, 1, 1);
        expect(info.hit).toBe(false);
    });

    it("keeps the internal gate resolved (never rejected) after a failed pick", async () => {
        const throwingScene = {
            get surface(): never {
                throw new Error("boom");
            },
            camera: null,
        } as unknown as SceneContext;

        const picker = createGpuPicker(throwingScene);
        await expect(pickAsync(picker, 0, 0)).rejects.toThrow("boom");

        // The gate the next pick will wait on must be a resolved promise.
        await expect((picker as unknown as { _inflight: Promise<void> })._inflight).resolves.toBeUndefined();
    });

    it("preserves submission order across serialized picks", async () => {
        const order: number[] = [];
        const picker = createGpuPicker(makeIdleScene());

        const runs = [10, 20, 30].map((tag) =>
            pickAsync(picker, tag, tag).then(() => {
                order.push(tag);
            })
        );
        await Promise.all(runs);

        expect(order).toEqual([10, 20, 30]);
    });
});
