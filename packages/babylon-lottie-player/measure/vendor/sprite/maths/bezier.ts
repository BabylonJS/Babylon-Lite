/**
 * Babylon.js thin cubic-bezier easing evaluation.
 *
 * We only expose what the Lottie renderer truly needs, avoiding a dependency on the full
 * Babylon.js animation system. Easing curves are stored as flat control points in typed-array
 * tracks (see `Vector2Track`/`ScalarTrack`), so this is a standalone function rather than a class:
 * it carries no per-keyframe object overhead and can be called directly from the per-frame
 * interpolation path.
 */

/**
 * Evaluates a cubic bezier easing curve at a given normalized time.
 * @see http://cubic-bezier.com/#.17,.67,.83,.67
 * @param x1 The x component of the start tangent. `NaN` marks a keyframe with no easing handle (a hold/step segment), for which the function returns 0.
 * @param y1 The y component of the start tangent.
 * @param x2 The x component of the end tangent.
 * @param y2 The y component of the end tangent.
 * @param easingSteps Number of Newton-Raphson refinement steps used to invert the curve's x mapping.
 * @param t The normalized time to evaluate at, between 0 and 1.
 * @returns The eased value at time `t`.
 */
export function InterpolateBezierEase(x1: number, y1: number, x2: number, y2: number, easingSteps: number, t: number): number {
    if (t === 0) {
        return 0;
    }

    if (t === 1) {
        return 1;
    }

    // A NaN x1 marks a keyframe with no easing handle (hold/step segment): keep the start value.
    if (Number.isNaN(x1)) {
        return 0;
    }

    // Coefficients of the bezier's x(t) mapping.
    const f0 = 1 - 3 * x2 + 3 * x1;
    const f1 = 3 * x2 - 6 * x1;
    const f2 = 3 * x1;

    let refinedT = t;
    for (let i = 0; i < easingSteps; i++) {
        const refinedT2 = refinedT * refinedT;
        const refinedT3 = refinedT2 * refinedT;
        const x = f0 * refinedT3 + f1 * refinedT2 + f2 * refinedT;
        const slope = 1.0 / (3.0 * f0 * refinedT2 + 2.0 * f1 * refinedT + f2);
        refinedT -= (x - t) * slope;
        refinedT = Math.min(1, Math.max(0, refinedT));
    }

    // Resolve cubic bezier for the refined parameter.
    return 3 * (1 - refinedT) * (1 - refinedT) * refinedT * y1 + 3 * (1 - refinedT) * refinedT * refinedT * y2 + refinedT * refinedT * refinedT;
}
