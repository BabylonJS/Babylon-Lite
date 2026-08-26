import { type ScalarTrack, type Vector2Track } from "./parsedTypes";

/**
 * Cubic bezier easing control points for a single keyframe segment.
 * `undefined` marks a keyframe with no easing handle (a hold/step segment).
 */
export type EaseHandle = { x1: number; y1: number; x2: number; y2: number } | undefined;

/**
 * Build-time input for a single scalar keyframe.
 */
export type ScalarKeyframeInput = {
    /** Time of the keyframe, in frames. */
    time: number;
    /** Value at the keyframe. */
    value: number;
    /** Easing of the segment that starts at this keyframe. */
    ease: EaseHandle;
};

/**
 * Build-time input for a single 2D-vector keyframe.
 */
export type Vector2KeyframeInput = {
    /** Time of the keyframe, in frames. */
    time: number;
    /** X value at the keyframe. */
    x: number;
    /** Y value at the keyframe. */
    y: number;
    /** Easing of the X-axis segment that starts at this keyframe. */
    ease1: EaseHandle;
    /** Easing of the Y-axis segment that starts at this keyframe. */
    ease2: EaseHandle;
};

// Writes an EaseHandle into `bezier[offset .. offset + 3]`, using a NaN x1 sentinel for a missing handle.
function WriteEase(bezier: Float32Array, offset: number, ease: EaseHandle): void {
    if (ease === undefined) {
        bezier[offset] = NaN;
        bezier[offset + 1] = 0;
        bezier[offset + 2] = 0;
        bezier[offset + 3] = 0;
        return;
    }
    bezier[offset] = ease.x1;
    bezier[offset + 1] = ease.y1;
    bezier[offset + 2] = ease.x2;
    bezier[offset + 3] = ease.y2;
}

/**
 * Packs scalar keyframes into a {@link ScalarTrack} of parallel typed arrays.
 * @param keyframes The scalar keyframes in time order.
 * @param easingSteps Number of Newton-Raphson refinement steps used when evaluating the easing curves.
 * @returns The packed scalar track.
 */
export function BuildScalarTrack(keyframes: ScalarKeyframeInput[], easingSteps: number): ScalarTrack {
    const count = keyframes.length;
    const times = new Float32Array(count);
    const values = new Float32Array(count);
    const bezier = new Float32Array(count * 4);

    for (let i = 0; i < count; i++) {
        const keyframe = keyframes[i];
        times[i] = keyframe.time;
        values[i] = keyframe.value;
        WriteEase(bezier, i * 4, keyframe.ease);
    }

    return { count, times, values, bezier, easingSteps };
}

/**
 * Packs 2D-vector keyframes into a {@link Vector2Track} of parallel typed arrays.
 * @param keyframes The vector keyframes in time order.
 * @param easingSteps Number of Newton-Raphson refinement steps used when evaluating the easing curves.
 * @returns The packed vector track.
 */
export function BuildVector2Track(keyframes: Vector2KeyframeInput[], easingSteps: number): Vector2Track {
    const count = keyframes.length;
    const times = new Float32Array(count);
    const valuesX = new Float32Array(count);
    const valuesY = new Float32Array(count);
    const bezierX = new Float32Array(count * 4);
    const bezierY = new Float32Array(count * 4);

    for (let i = 0; i < count; i++) {
        const keyframe = keyframes[i];
        times[i] = keyframe.time;
        valuesX[i] = keyframe.x;
        valuesY[i] = keyframe.y;
        WriteEase(bezierX, i * 4, keyframe.ease1);
        WriteEase(bezierY, i * 4, keyframe.ease2);
    }

    return { count, times, valuesX, valuesY, bezierX, bezierY, easingSteps };
}
