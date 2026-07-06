import { describe, expect, it } from "vitest";

import { runFrameInterpolation } from "../../../packages/babylon-lite/src/animation/frame-interpolation";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

function makeScene(): SceneContext {
    return { _beforeRender: [] } as unknown as SceneContext;
}

/** Invoke every registered _beforeRender callback once, over a snapshot so mid-tick removal is safe. */
function tick(scene: SceneContext, deltaMs = 16): void {
    for (const cb of [...scene._beforeRender]) {
        cb(deltaMs);
    }
}

describe("runFrameInterpolation", () => {
    it("resolves when the step returns false and detaches the driver", async () => {
        const scene = makeScene();
        let frames = 0;
        const promise = runFrameInterpolation(scene, () => {
            frames++;
            return frames < 3; // continue for 2 frames, complete on the 3rd
        });

        expect(scene._beforeRender.length).toBe(1);
        tick(scene);
        tick(scene);
        tick(scene);

        await expect(promise).resolves.toBeUndefined();
        expect(frames).toBe(3);
        expect(scene._beforeRender.length).toBe(0);
    });

    it("passes delta time in seconds to the step", async () => {
        const scene = makeScene();
        let seenSeconds = -1;
        const promise = runFrameInterpolation(scene, (dt) => {
            seenSeconds = dt;
            return false;
        });
        tick(scene, 32);
        await promise;
        expect(seenSeconds).toBeCloseTo(0.032, 6);
    });

    it("falls back to a 60 FPS step for a non-positive delta", async () => {
        const scene = makeScene();
        let seenSeconds = -1;
        const promise = runFrameInterpolation(scene, (dt) => {
            seenSeconds = dt;
            return false;
        });
        tick(scene, 0);
        await promise;
        expect(seenSeconds).toBeCloseTo(1 / 60, 6);
    });

    it("rejects with the thrown value when the step throws, and detaches the driver", async () => {
        const scene = makeScene();
        const boom = new Error("interrupted");
        const promise = runFrameInterpolation(scene, () => {
            throw boom;
        });
        tick(scene);
        await expect(promise).rejects.toBe(boom);
        expect(scene._beforeRender.length).toBe(0);
    });

    it("rejects immediately with the signal reason when already aborted, without registering a driver", async () => {
        const scene = makeScene();
        const controller = new AbortController();
        const reason = new Error("already-aborted");
        controller.abort(reason);
        const promise = runFrameInterpolation(scene, () => true, controller.signal);
        expect(scene._beforeRender.length).toBe(0);
        await expect(promise).rejects.toBe(reason);
    });

    it("rejects and detaches when the signal aborts mid-flight", async () => {
        const scene = makeScene();
        const controller = new AbortController();
        const reason = new Error("mid-flight-abort");
        const promise = runFrameInterpolation(scene, () => true, controller.signal);

        tick(scene); // one frame, still going
        expect(scene._beforeRender.length).toBe(1);

        controller.abort(reason);
        await expect(promise).rejects.toBe(reason);
        expect(scene._beforeRender.length).toBe(0);
    });
});
