import { type IVector2Like } from "../babylonTypes";

import { type AnimationNode } from "../nodes/node";

/**
 * Represents a Babylon.js thin version of a Lottie animation.
 */
export type AnimationInfo = {
    /**
     * Frame number where the animation starts.
     */
    startFrame: number;
    /**
     * Frame number where the animation ends.
     */
    endFrame: number;
    /**
     * Frame rate of the animation.
     */
    frameRate: number;
    /**
     * Width of the animation in pixels
     */
    widthPx: number;
    /**
     * Height of the animation in pixels
     */
    heightPx: number;
    /**
     * Nodes representing the animation
     */
    nodes: AnimationNode[];
};

/**
 * Transform properties for a Lottie animation.
 * Any of these properties may be animated.
 */
export type Transform = {
    /**
     * The anchor point of the layer, which is the point around which transformations are applied.
     */
    anchorPoint: Vector2Property;
    /**
     * The position of the layer in the animation.
     */
    position: Vector2Property;
    /**
     * The rotation of the layer in degrees.
     */
    rotation: ScalarProperty;
    /**
     * The scale of the layer in the X and Y axis.
     */
    scale: Vector2Property;
    /**
     * The opacity of the layer, represented as a scalar value.
     */
    opacity: ScalarProperty;
};

/**
 * Animated scalar keyframe data packed into parallel typed arrays for a compact, allocation-free,
 * cache-friendly per-frame evaluation path. There is one entry per keyframe; the easing of the
 * segment that starts at keyframe `i` is stored at `bezier[i * 4 ... i * 4 + 3]` as the cubic
 * bezier control points `[x1, y1, x2, y2]`. A `NaN` in the `x1` slot marks a keyframe with no
 * easing handle (a hold/step segment).
 */
export type ScalarTrack = {
    /** Number of keyframes in the track. */
    count: number;
    /** Keyframe times in frames, length `count`. */
    times: Float32Array;
    /** Keyframe values, length `count`. */
    values: Float32Array;
    /** Per-keyframe cubic bezier easing control points `[x1, y1, x2, y2]`, length `count * 4`. */
    bezier: Float32Array;
    /** Number of Newton-Raphson refinement steps used when evaluating the easing curves. */
    easingSteps: number;
};

/**
 * Animated 2D-vector keyframe data packed into parallel typed arrays. Same layout as
 * {@link ScalarTrack} but with separate X/Y value arrays and separate X/Y easing curves
 * (Lottie allows per-axis easing).
 */
export type Vector2Track = {
    /** Number of keyframes in the track. */
    count: number;
    /** Keyframe times in frames, length `count`. */
    times: Float32Array;
    /** Keyframe X values, length `count`. */
    valuesX: Float32Array;
    /** Keyframe Y values, length `count`. */
    valuesY: Float32Array;
    /** Per-keyframe X-axis bezier easing control points `[x1, y1, x2, y2]`, length `count * 4`. */
    bezierX: Float32Array;
    /** Per-keyframe Y-axis bezier easing control points `[x1, y1, x2, y2]`, length `count * 4`. */
    bezierY: Float32Array;
    /** Number of Newton-Raphson refinement steps used when evaluating the easing curves. */
    easingSteps: number;
};

/**
 * Represents a scalar that can be animated.
 */
export type ScalarProperty = {
    /**
     * The initial value of the property at the start of the animation.
     */
    startValue: number;
    /**
     * The current value of the property during the animation.
     */
    currentValue: number;
    /**
     * Typed-array keyframe data for the property, present only when the property is animated.
     */
    track?: ScalarTrack;
    /**
     * The index of the current keyframe being processed in the animation.
     */
    currentKeyframeIndex: number;
};

/**
 * Represents a 2D vector that can be animated.
 */
export type Vector2Property = {
    /**
     * The initial value at the start of the animation.
     */
    startValue: IVector2Like;
    /**
     * The current value during the animation.
     */
    currentValue: IVector2Like;
    /**
     * Typed-array keyframe data for the property, present only when the property is animated.
     */
    track?: Vector2Track;
    /**
     * The index of the current keyframe being processed in the animation.
     */
    currentKeyframeIndex: number;
};
