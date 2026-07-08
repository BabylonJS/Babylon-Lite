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
 * Clamp `value` to the camera's `[lower, upper]` bound for one channel. An
 * undefined bound means unbounded on that side. Mirrors the alpha/beta/radius
 * clamping the limit setters apply (see `clampCameraToLimits` in arc-rotate-controls),
 * so an interpolation goal outside the limits resolves to the value the camera will
 * actually settle at — otherwise the per-frame clamp would peg the camera at the wall
 * while the goal stayed unreachable, and the transition would never terminate.
 */
function clampToLimit(value: number, lower: number | undefined, upper: number | undefined): number {
    if (lower !== undefined && value < lower) {
        return lower;
    }
    if (upper !== undefined && value > upper) {
        return upper;
    }
    return value;
}

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

    // Raw goal channels, resolved lazily on the first frame so that fields left to "current" reflect the
    // camera's pose at the moment interpolation truly begins. These stay UNCLAMPED — the orbit channels
    // are clamped to the camera's current limits each frame in the step (so a mid-transition limit change
    // is tracked), while the target is never limit-constrained.
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

            // Resolve each goal channel to its raw (unclamped) value. Omitted channels hold the camera's
            // current value at the moment interpolation begins. The orbit channels are clamped to the
            // camera's limits every frame below (not just here) so the goal tracks the reachable pose even
            // if the limits change mid-transition — otherwise the per-frame limit setters would peg the
            // camera at the wall while an out-of-range goal stayed unreachable, and the termination check
            // would never fire (the driver would leak in _beforeRender forever).
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

        // Clamp the orbit goals to the camera's CURRENT limits each frame. Target is not limit-constrained.
        const clampedAlpha = clampToLimit(goalAlpha, camera.lowerAlphaLimit, camera.upperAlphaLimit);
        const clampedBeta = clampToLimit(goalBeta, camera.lowerBetaLimit, camera.upperBetaLimit);
        const clampedRadius = clampToLimit(goalRadius, camera.lowerRadiusLimit, camera.upperRadiusLimit);

        const t = expDampFactor(deltaSeconds, factor);

        camera.alpha = lerpAngleShortest(camera.alpha, clampedAlpha, t);
        camera.beta = lerpAngleShortest(camera.beta, clampedBeta, t);
        camera.radius = dampScalar(camera.radius, clampedRadius, t);
        lerpVec3ToRef(camera.target, goalTarget, t, camera.target);

        // Snap-and-finish once every active channel is visually at its (clamped) goal. Scale the
        // radius/target tolerances by the goal radius so termination is consistent across scene scales.
        // Reuse lerpAngleShortest at t=1 to recover the shortest signed angular delta without duplicating
        // the wrap-around math.
        const radiusScale = Math.abs(clampedRadius) > 1e-6 ? Math.abs(clampedRadius) : 1;
        const alphaRemaining = Math.abs(lerpAngleShortest(camera.alpha, clampedAlpha, 1) - camera.alpha);
        const betaRemaining = Math.abs(lerpAngleShortest(camera.beta, clampedBeta, 1) - camera.beta);
        const radiusRemaining = Math.abs(clampedRadius - camera.radius) / radiusScale;
        const dx = goalTarget.x - camera.target.x;
        const dy = goalTarget.y - camera.target.y;
        const dz = goalTarget.z - camera.target.z;
        const targetRemaining = Math.hypot(dx, dy, dz) / radiusScale;

        if (alphaRemaining < TerminationEpsilon && betaRemaining < TerminationEpsilon && radiusRemaining < TerminationEpsilon && targetRemaining < TerminationEpsilon) {
            camera.alpha = clampedAlpha;
            camera.beta = clampedBeta;
            camera.radius = clampedRadius;
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
