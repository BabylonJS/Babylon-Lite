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

/**
 * Invoke callbacks the way scene-core does: a live `for...of` over the array itself (no snapshot).
 * This is the iteration mode that a mid-frame `splice` would corrupt, so it is what the
 * concurrent-completion regression test below exercises.
 */
function tickLive(scene: SceneContext, deltaMs = 16): void {
    for (const cb of scene._beforeRender) {
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

    it("does not skip a concurrent interpolation when one completes mid-frame under live iteration", async () => {
        const scene = makeScene();
        let firstFrames = 0;
        let secondFrames = 0;

        // The first interpolation completes on its first frame (returns false), so its driver retires
        // itself from _beforeRender while scene-core is still iterating that array. If retirement used
        // splice(), the live for...of would skip the very next element — the second interpolation —
        // that frame. Retiring in place (noop) must keep the second driver running this same frame.
        const firstPromise = runFrameInterpolation(scene, () => {
            firstFrames++;
            return false;
        });
        const secondPromise = runFrameInterpolation(scene, () => {
            secondFrames++;
            return secondFrames < 2; // needs a second frame to complete
        });

        expect(scene._beforeRender.length).toBe(2);

        tickLive(scene); // first completes and retires; second must still tick this frame
        expect(firstFrames).toBe(1);
        expect(secondFrames).toBe(1);
        await expect(firstPromise).resolves.toBeUndefined();

        tickLive(scene); // second completes on its next frame
        expect(secondFrames).toBe(2);
        await expect(secondPromise).resolves.toBeUndefined();

        // Both drivers are gone and no retired-noop slots are left dangling.
        expect(scene._beforeRender.length).toBe(0);
    });
});
