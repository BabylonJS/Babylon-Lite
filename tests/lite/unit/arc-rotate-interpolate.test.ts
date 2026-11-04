import { describe, expect, it } from "vitest";

import { interpolateArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate-interpolate";
import type { ArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

function makeScene(): SceneContext {
    return { _beforeRender: [] } as unknown as SceneContext;
}

function makeCamera(alpha: number, beta: number, radius: number, target = { x: 0, y: 0, z: 0 }): ArcRotateCamera {
    return {
        alpha,
        beta,
        radius,
        target: { x: target.x, y: target.y, z: target.z },
        inertialAlphaOffset: 0,
        inertialBetaOffset: 0,
        inertialRadiusOffset: 0,
        inertialPanningX: 0,
        inertialPanningY: 0,
    } as unknown as ArcRotateCamera;
}

interface CameraLimits {
    lowerAlphaLimit?: number;
    upperAlphaLimit?: number;
    lowerBetaLimit?: number;
    upperBetaLimit?: number;
    lowerRadiusLimit?: number;
    upperRadiusLimit?: number;
}

/**
 * A camera whose alpha/beta/radius setters clamp to its OWN live limit fields on every write, matching
 * the real ArcRotateCamera's self-clamp hook. This is what makes an unclamped goal loop forever: the
 * setter pegs the pose at the wall each frame while the goal stays unreachable. Because the setters read
 * the camera's own limit fields, reassigning e.g. `camera.lowerRadiusLimit` mid-interpolation changes the
 * clamp exactly as it would on a real camera.
 */
function makeLimitedCamera(alpha: number, beta: number, radius: number, limits: CameraLimits): ArcRotateCamera {
    let a = alpha;
    let b = beta;
    let r = radius;
    const cam: Record<string, unknown> = {
        target: { x: 0, y: 0, z: 0 },
        inertialAlphaOffset: 0,
        inertialBetaOffset: 0,
        inertialRadiusOffset: 0,
        inertialPanningX: 0,
        inertialPanningY: 0,
        ...limits,
        get alpha(): number {
            return a;
        },
        set alpha(v: number) {
            a = clamp(v, cam.lowerAlphaLimit as number | undefined, cam.upperAlphaLimit as number | undefined);
        },
        get beta(): number {
            return b;
        },
        set beta(v: number) {
            b = clamp(v, cam.lowerBetaLimit as number | undefined, cam.upperBetaLimit as number | undefined);
        },
        get radius(): number {
            return r;
        },
        set radius(v: number) {
            r = clamp(v, cam.lowerRadiusLimit as number | undefined, cam.upperRadiusLimit as number | undefined);
        },
    };
    return cam as unknown as ArcRotateCamera;
}

function clamp(value: number, lower: number | undefined, upper: number | undefined): number {
    if (lower !== undefined && value < lower) {
        return lower;
    }
    if (upper !== undefined && value > upper) {
        return upper;
    }
    return value;
}

function tick(scene: SceneContext, deltaMs = 16): void {
    for (const cb of [...scene._beforeRender]) {
        cb(deltaMs);
    }
}

/** Tick until no interpolation drivers remain (completed/canceled) or a frame cap is hit. */
function runToSettle(scene: SceneContext, maxFrames = 2000): number {
    let frames = 0;
    while (scene._beforeRender.length > 0 && frames < maxFrames) {
        tick(scene);
        frames++;
    }
    return frames;
}

describe("interpolateArcRotateCamera", () => {
    it("converges to the goal pose, snaps exactly, and resolves", async () => {
        const scene = makeScene();
        const camera = makeCamera(0, 1, 10);
        const promise = interpolateArcRotateCamera(camera, scene, { alpha: 1.5, beta: 0.7, radius: 4, target: { x: 2, y: 3, z: -1 } });

        runToSettle(scene);
        await expect(promise).resolves.toBeUndefined();

        expect(camera.alpha).toBe(1.5);
        expect(camera.beta).toBe(0.7);
        expect(camera.radius).toBe(4);
        expect(camera.target.x).toBe(2);
        expect(camera.target.y).toBe(3);
        expect(camera.target.z).toBe(-1);
        expect(scene._beforeRender.length).toBe(0);
    });

    it("discards leftover inertia on the first frame", async () => {
        const scene = makeScene();
        const camera = makeCamera(0, 1, 10);
        camera.inertialAlphaOffset = 5;
        camera.inertialBetaOffset = -3;
        camera.inertialRadiusOffset = 2;
        camera.inertialPanningX = 1;
        camera.inertialPanningY = -1;

        const promise = interpolateArcRotateCamera(camera, scene, { radius: 5 });
        tick(scene); // first frame

        expect(camera.inertialAlphaOffset).toBe(0);
        expect(camera.inertialBetaOffset).toBe(0);
        expect(camera.inertialRadiusOffset).toBe(0);
        expect(camera.inertialPanningX).toBe(0);
        expect(camera.inertialPanningY).toBe(0);

        runToSettle(scene);
        await promise;
    });

    it("holds channels whose goal fields are omitted", async () => {
        const scene = makeScene();
        const camera = makeCamera(0.4, 0.9, 10, { x: 1, y: 2, z: 3 });
        const promise = interpolateArcRotateCamera(camera, scene, { radius: 6 });

        runToSettle(scene);
        await promise;

        expect(camera.alpha).toBe(0.4);
        expect(camera.beta).toBe(0.9);
        expect(camera.radius).toBe(6);
        expect(camera.target.x).toBe(1);
        expect(camera.target.y).toBe(2);
        expect(camera.target.z).toBe(3);
    });

    it("takes the shortest arc for alpha across the +/-PI wrap", async () => {
        const scene = makeScene();
        const camera = makeCamera(3.0, 0.5, 10);
        const promise = interpolateArcRotateCamera(camera, scene, { alpha: -3.0 });

        // After the first frame it should move toward +PI (the short way), not toward 0 (the long way).
        tick(scene);
        expect(camera.alpha).toBeGreaterThan(3.0);

        runToSettle(scene);
        await promise;
        expect(camera.alpha).toBe(-3.0);
    });

    it("rejects when the camera is moved by something else between frames", async () => {
        const scene = makeScene();
        const camera = makeCamera(0, 1, 10);
        const promise = interpolateArcRotateCamera(camera, scene, { alpha: 2, radius: 5 });

        tick(scene); // first frame establishes the last-written pose
        camera.beta += 1; // simulate a user drag between frames
        tick(scene); // interference detected

        await expect(promise).rejects.toThrow(/interrupted/i);
        expect(scene._beforeRender.length).toBe(0);
    });

    it("rejects when the abort signal fires", async () => {
        const scene = makeScene();
        const camera = makeCamera(0, 1, 10);
        const controller = new AbortController();
        const promise = interpolateArcRotateCamera(camera, scene, { alpha: 2 }, controller.signal);

        tick(scene);
        controller.abort(new Error("canceled"));

        await expect(promise).rejects.toThrow(/canceled/);
        expect(scene._beforeRender.length).toBe(0);
    });

    it("lets a superseding interpolation cancel the previous one", async () => {
        const scene = makeScene();
        const camera = makeCamera(0, 1, 10);

        const first = interpolateArcRotateCamera(camera, scene, { alpha: 2, radius: 5 });
        const firstRejected = expect(first).rejects.toThrow(/interrupted/i);

        tick(scene); // first frame of the first interpolation

        const second = interpolateArcRotateCamera(camera, scene, { alpha: -1, radius: 8 });
        runToSettle(scene);

        await firstRejected;
        await expect(second).resolves.toBeUndefined();
        expect(camera.alpha).toBe(-1);
        expect(camera.radius).toBe(8);
    });

    it("clamps an out-of-range goal to the camera limits and still detaches the driver", async () => {
        const scene = makeScene();
        // Radius limited to [5, 20]; ask to interpolate to radius 1 (below lowerRadiusLimit). Without the
        // goal clamp the setter pegs the radius at 5 every frame while the goal stays 1, so the remaining
        // distance never reaches zero, the promise never resolves, and the driver leaks forever.
        const camera = makeLimitedCamera(0, 1, 10, { lowerRadiusLimit: 5, upperRadiusLimit: 20 });
        const promise = interpolateArcRotateCamera(camera, scene, { radius: 1 });

        const frames = runToSettle(scene);

        await expect(promise).resolves.toBeUndefined();
        // Converged to the reachable clamped limit, terminated well within the frame cap, and detached.
        expect(camera.radius).toBe(5);
        expect(frames).toBeLessThan(2000);
        expect(scene._beforeRender.length).toBe(0);
    });

    it("re-clamps to limits that tighten mid-interpolation and still detaches the driver", async () => {
        const scene = makeScene();
        // Start unbounded, interpolating from radius 20 down to a reachable goal of 3.
        const camera = makeLimitedCamera(0, 1, 20, {});
        const promise = interpolateArcRotateCamera(camera, scene, { radius: 3 });

        // Run a few frames, then tighten the lower radius limit past the goal via DIRECT field assignment
        // (which, unlike setCameraLimits, does not re-clamp the current pose — so no interference is
        // detected). With only a first-frame clamp the goal would stay at the now-unreachable 3 and the
        // driver would loop forever; re-clamping each frame tracks the new wall so it terminates at 8.
        for (let i = 0; i < 5 && scene._beforeRender.length > 0; i++) {
            tick(scene);
        }
        camera.lowerRadiusLimit = 8;

        const frames = runToSettle(scene);

        await expect(promise).resolves.toBeUndefined();
        expect(camera.radius).toBe(8);
        expect(frames).toBeLessThan(2000);
        expect(scene._beforeRender.length).toBe(0);
    });
});
