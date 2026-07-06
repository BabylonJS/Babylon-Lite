/**
 * Frame-rate-independent interpolation primitives.
 *
 * These are pure, allocation-free helpers shared by higher-level interpolation
 * code (e.g. camera transitions). They have no scene or scheduling knowledge, so
 * a consumer that imports only these pays for nothing else, and a consumer that
 * imports none of them pulls in zero code.
 */

/**
 * Exponential damping weight for one frame, matching the frame-rate-independent
 * easing used by core ArcRotateCamera: `1 - 2^(-deltaSeconds / factor)`. Feed the
 * returned value as the `t` of a lerp/damp so the same motion plays identically
 * regardless of frame rate.
 * @param deltaSeconds - Elapsed time this frame, in seconds. Non-positive values return `0` (no
 *   progress), so a stalled or backwards frame delta never moves the value the wrong way.
 * @param factor - Smoothing time constant. Smaller is snappier, larger is slower.
 *   Values `<= 0` return `1` (snap immediately to the goal).
 * @returns The per-frame interpolation weight in `[0, 1]`.
 */
export function expDampFactor(deltaSeconds: number, factor: number): number {
    if (factor <= 0) {
        return 1;
    }
    if (deltaSeconds <= 0) {
        return 0;
    }
    return 1 - Math.pow(2, -deltaSeconds / factor);
}

/**
 * Blend a scalar toward a goal by weight `t`.
 * @param current - The current value.
 * @param goal - The goal value.
 * @param t - The interpolation weight (typically from {@link expDampFactor}).
 * @returns `current + (goal - current) * t`.
 */
export function dampScalar(current: number, goal: number, t: number): number {
    return current + (goal - current) * t;
}

/**
 * Blend an angle (radians) toward a goal along the shortest arc, correctly
 * handling wrap-around past `±PI` (e.g. `3.1 -> -3.1` takes the short way). This
 * is the lightweight alternative to quaternion slerp when only a single angle is
 * being interpolated. The result is not normalized to any particular range.
 * @param current - The current angle, in radians.
 * @param goal - The goal angle, in radians.
 * @param t - The interpolation weight (typically from {@link expDampFactor}).
 * @returns The new angle, stepped `t` of the way along the shortest arc.
 */
export function lerpAngleShortest(current: number, goal: number, t: number): number {
    const twoPi = Math.PI * 2;
    let delta = (goal - current) % twoPi;
    if (delta > Math.PI) {
        delta -= twoPi;
    } else if (delta < -Math.PI) {
        delta += twoPi;
    }
    return current + delta * t;
}
