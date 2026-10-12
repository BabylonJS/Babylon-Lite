/** A segment-local animation progress transform. */
export type AnimationEasing = (gradient: number) => number;

/** Circular ease-in. */
export function circleEase(gradient: number): number {
    const clamped = Math.max(0, Math.min(1, gradient));
    return 1 - Math.sqrt(1 - clamped * clamped);
}

/** Quadratic ease-in. */
export function quadraticEase(gradient: number): number {
    return gradient * gradient;
}

/** Cubic ease-in. */
export function cubicEase(gradient: number): number {
    return gradient * gradient * gradient;
}

/** Quartic ease-in. */
export function quarticEase(gradient: number): number {
    const squared = gradient * gradient;
    return squared * squared;
}

/** Quintic ease-in. */
export function quinticEase(gradient: number): number {
    const squared = gradient * gradient;
    return squared * squared * gradient;
}

/** Sinusoidal ease-in. */
export function sineEase(gradient: number): number {
    return 1 - Math.sin((Math.PI / 2) * (1 - gradient));
}

/** Power ease-in. */
export function powerEase(gradient: number, power = 2): number {
    return Math.pow(gradient, Math.max(0, power));
}

/** Exponential ease-in. */
export function exponentialEase(gradient: number, exponent = 2): number {
    return exponent <= 0 ? gradient : (Math.exp(exponent * gradient) - 1) / (Math.exp(exponent) - 1);
}

/** Back ease-in. */
export function backEase(gradient: number, amplitude = 1): number {
    return gradient * gradient * gradient - gradient * Math.max(0, amplitude) * Math.sin(Math.PI * gradient);
}

/** Elastic ease-in. */
export function elasticEase(gradient: number, oscillations = 3, springiness = 3): number {
    const clampedOscillations = Math.max(0, oscillations);
    const clampedSpringiness = Math.max(0, springiness);
    const magnitude = clampedSpringiness === 0 ? gradient : (Math.exp(clampedSpringiness * gradient) - 1) / (Math.exp(clampedSpringiness) - 1);
    return magnitude * Math.sin((2 * Math.PI * clampedOscillations + Math.PI / 2) * gradient);
}

/** Bounce ease-in. */
export function bounceEase(gradient: number, bounces = 3, bounciness = 2): number {
    const clampedBounces = Math.max(0, bounces);
    const safeBounciness = bounciness <= 1 ? 1.001 : bounciness;
    const bouncePower = Math.pow(safeBounciness, clampedBounces);
    const inverseScale = 1 - safeBounciness;
    const scale = (1 - bouncePower) / inverseScale + bouncePower * 0.5;
    const scaledGradient = gradient * scale;
    const bounce = Math.floor(Math.log(-scaledGradient * inverseScale + 1) / Math.log(safeBounciness));
    const nextBounce = bounce + 1;
    const start = (1 - Math.pow(safeBounciness, bounce)) / (inverseScale * scale);
    const end = (1 - Math.pow(safeBounciness, nextBounce)) / (inverseScale * scale);
    const midpoint = (start + end) * 0.5;
    const offset = gradient - midpoint;
    const radius = midpoint - start;
    return (-Math.pow(1 / safeBounciness, clampedBounces - bounce) / (radius * radius)) * (offset - radius) * (offset + radius);
}

/**
 * Cubic Bezier ease-in from (0, 0) to (1, 1).
 *
 * The control-point x coordinates define time, so the curve parameter is refined
 * before sampling y. Results outside the animation interval settle to an endpoint.
 */
export function bezierCurveEase(gradient: number, x1 = 0, y1 = 0, x2 = 1, y2 = 1): number {
    if (gradient === 0) {
        return 0;
    }
    const xCubic = 1 - 3 * x2 + 3 * x1;
    const xQuadratic = 3 * x2 - 6 * x1;
    const xLinear = 3 * x1;
    let curveTime = gradient;
    for (let iteration = 0; iteration < 5; iteration++) {
        const squaredTime = curveTime * curveTime;
        const x = xCubic * squaredTime * curveTime + xQuadratic * squaredTime + xLinear * curveTime;
        const derivative = 3 * xCubic * squaredTime + 2 * xQuadratic * curveTime + xLinear;
        curveTime -= (x - gradient) / derivative;
        curveTime = Math.min(1, Math.max(0, curveTime));
    }
    const inverseTime = 1 - curveTime;
    return 3 * inverseTime * inverseTime * curveTime * y1 + 3 * inverseTime * curveTime * curveTime * y2 + curveTime * curveTime * curveTime;
}

/** Create a callback using a fixed power. */
export function createPowerEase(power = 2): AnimationEasing {
    return (gradient) => powerEase(gradient, power);
}

/** Create a callback using a fixed exponential exponent. */
export function createExponentialEase(exponent = 2): AnimationEasing {
    return (gradient) => exponentialEase(gradient, exponent);
}

/** Create a callback using a fixed back amplitude. */
export function createBackEase(amplitude = 1): AnimationEasing {
    return (gradient) => backEase(gradient, amplitude);
}

/** Create a callback using fixed elastic parameters. */
export function createElasticEase(oscillations = 3, springiness = 3): AnimationEasing {
    return (gradient) => elasticEase(gradient, oscillations, springiness);
}

/** Create a callback using fixed bounce parameters. */
export function createBounceEase(bounces = 3, bounciness = 2): AnimationEasing {
    return (gradient) => bounceEase(gradient, bounces, bounciness);
}

/** Create a callback using fixed cubic Bezier control points. */
export function createBezierCurveEase(x1 = 0, y1 = 0, x2 = 1, y2 = 1): AnimationEasing {
    return (gradient) => bezierCurveEase(gradient, x1, y1, x2, y2);
}
