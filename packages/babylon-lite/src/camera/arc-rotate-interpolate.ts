import type { Vec3 } from "../math/types.js";
import type { ArcRotateCamera } from "./arc-rotate.js";
import type { SceneContext } from "../scene/scene-core.js";
import { runFrameInterpolation } from "../animation/frame-interpolation.js";
import { expDampFactor, dampScalar, lerpAngleShortest } from "../math/damp.js";
import { lerpVec3ToRef } from "../math/vec3-ref.js";

/**
 * Destination pose for {@link interpolateArcRotateCamera}. Every field is
 * optional; an omitted (or `NaN`) field keeps the camera's current value for that
 * channel, so you can interpolate only the radius, only the target, and so on.
 * `target` is copied, not retained, so the caller may reuse the vector afterwards.
 */
export interface ArcRotateInterpolationGoal {
    /** Goal orbit angle (radians). Interpolated along the shortest arc. */
    alpha?: number;
    /** Goal elevation angle (radians). Interpolated along the shortest arc. */
    beta?: number;
    /** Goal distance from target. */
    radius?: number;
    /** Goal orbit target point (copied). */
    target?: Vec3;
}

/**
 * Tuning for {@link interpolateArcRotateCamera}.
 */
export interface ArcRotateInterpolationOptions {
    /**
     * Exponential smoothing time constant passed to {@link expDampFactor}. Smaller
     * is snappier, larger is slower. Defaults to `0.1` to match core ArcRotateCamera.
     */
    interpolationFactor?: number;
}

const DefaultInterpolationFactor = 0.1;
const TerminationEpsilon = 1e-3;

/**
 * Smoothly interpolate an {@link ArcRotateCamera} toward a goal pose, mirroring
 * core `ArcRotateCamera.interpolateTo`. On the first frame it discards any leftover
 * inertia; each frame it advances alpha/beta (shortest arc), radius, and target
 * toward the goal using frame-rate-independent damping.
 *
 * The transition is bidirectionally interruptible: if anything other than this
 * interpolation changes the camera pose between frames — a user drag/zoom/pan,
 * decaying inertia, a direct pose write, or a superseding interpolation — the
 * transition cancels and the returned promise rejects. Starting a new
 * interpolation therefore causes any in-progress one on the same camera to reject.
 *
 * @param camera - The camera to move.
 * @param scene - The scene whose render loop drives the transition.
 * @param goal - The destination pose; omitted fields hold the current value.
 * @param signal - Optional abort signal to cancel the transition externally.
 * @param options - Optional easing tuning.
 * @returns A promise that resolves when the camera reaches the goal, and rejects
 *   if the transition is interrupted (by the signal, user interaction, or a
 *   superseding change).
 */
export function interpolateArcRotateCamera(
    camera: ArcRotateCamera,
    scene: SceneContext,
    goal: ArcRotateInterpolationGoal,
    signal?: AbortSignal,
    options?: ArcRotateInterpolationOptions
): Promise<void> {
    const factor = options?.interpolationFactor ?? DefaultInterpolationFactor;

    const hasAlpha = goal.alpha !== undefined && !isNaN(goal.alpha);
    const hasBeta = goal.beta !== undefined && !isNaN(goal.beta);
    const hasRadius = goal.radius !== undefined && !isNaN(goal.radius);
    const hasTarget = goal.target !== undefined;

    // Goal channels are resolved lazily on the first frame so that fields left to
    // "current" reflect the camera's pose at the moment interpolation truly begins.
    let goalAlpha = 0;
    let goalBeta = 0;
    let goalRadius = 0;
    const goalTarget: Vec3 = { x: 0, y: 0, z: 0 };

    // The pose this interpolation last wrote (post-clamp). Compared against the
    // camera each frame to detect external interference.
    let lastAlpha = 0;
    let lastBeta = 0;
    let lastRadius = 0;
    const lastTarget: Vec3 = { x: 0, y: 0, z: 0 };

    let first = true;

    const step = (deltaSeconds: number): boolean => {
        if (first) {
            first = false;

            // Starting an interpolation discards any leftover momentum, matching core.
            camera.inertialAlphaOffset = 0;
            camera.inertialBetaOffset = 0;
            camera.inertialRadiusOffset = 0;
            camera.inertialPanningX = 0;
            camera.inertialPanningY = 0;

            goalAlpha = hasAlpha ? goal.alpha! : camera.alpha;
            goalBeta = hasBeta ? goal.beta! : camera.beta;
            goalRadius = hasRadius ? goal.radius! : camera.radius;
            goalTarget.x = hasTarget ? goal.target!.x : camera.target.x;
            goalTarget.y = hasTarget ? goal.target!.y : camera.target.y;
            goalTarget.z = hasTarget ? goal.target!.z : camera.target.z;
        } else if (
            camera.alpha !== lastAlpha ||
            camera.beta !== lastBeta ||
            camera.radius !== lastRadius ||
            camera.target.x !== lastTarget.x ||
            camera.target.y !== lastTarget.y ||
            camera.target.z !== lastTarget.z
        ) {
            // The camera moved between frames by something other than this
            // interpolation (user input, inertia, or a superseding change) — bail.
            throw new Error("ArcRotate camera interpolation was interrupted.");
        }

        const t = expDampFactor(deltaSeconds, factor);

        camera.alpha = lerpAngleShortest(camera.alpha, goalAlpha, t);
        camera.beta = lerpAngleShortest(camera.beta, goalBeta, t);
        camera.radius = dampScalar(camera.radius, goalRadius, t);
        lerpVec3ToRef(camera.target, goalTarget, t, camera.target);

        // Snap-and-finish once every active channel is visually at its goal. Scale
        // the radius/target tolerances by the goal radius so termination is
        // consistent across scene scales. Reuse lerpAngleShortest at t=1 to recover
        // the shortest signed angular delta without duplicating the wrap-around math.
        const radiusScale = Math.abs(goalRadius) > 1e-6 ? Math.abs(goalRadius) : 1;
        const alphaRemaining = Math.abs(lerpAngleShortest(camera.alpha, goalAlpha, 1) - camera.alpha);
        const betaRemaining = Math.abs(lerpAngleShortest(camera.beta, goalBeta, 1) - camera.beta);
        const radiusRemaining = Math.abs(goalRadius - camera.radius) / radiusScale;
        const dx = goalTarget.x - camera.target.x;
        const dy = goalTarget.y - camera.target.y;
        const dz = goalTarget.z - camera.target.z;
        const targetRemaining = Math.hypot(dx, dy, dz) / radiusScale;

        if (alphaRemaining < TerminationEpsilon && betaRemaining < TerminationEpsilon && radiusRemaining < TerminationEpsilon && targetRemaining < TerminationEpsilon) {
            camera.alpha = goalAlpha;
            camera.beta = goalBeta;
            camera.radius = goalRadius;
            camera.target.x = goalTarget.x;
            camera.target.y = goalTarget.y;
            camera.target.z = goalTarget.z;
            return false;
        }

        // Record the actual post-write pose (limit setters may have clamped it) so
        // the interference check compares against what the camera really holds.
        lastAlpha = camera.alpha;
        lastBeta = camera.beta;
        lastRadius = camera.radius;
        lastTarget.x = camera.target.x;
        lastTarget.y = camera.target.y;
        lastTarget.z = camera.target.z;

        return true;
    };

    return runFrameInterpolation(scene, step, signal);
}
