/**
 * Babylon.js-compatible easing functions over Babylon Lite's functional curves.
 *
 * These retain Babylon.js's class hierarchy and easing modes for porting while
 * delegating curve math to tree-shakable native Lite functions.
 */

import {
    backEase,
    bezierCurveEase,
    bounceEase,
    circleEase,
    cubicEase,
    elasticEase,
    exponentialEase,
    powerEase,
    quadraticEase,
    quarticEase,
    quinticEase,
    sineEase,
} from "babylon-lite";

export const EASINGMODE_EASEIN = 0;
export const EASINGMODE_EASEOUT = 1;
export const EASINGMODE_EASEINOUT = 2;

/**
 * Contract implemented by Babylon.js easing functions.
 *
 * Custom easing objects only need to transform a normalized segment gradient.
 */
export interface IEasingFunction {
    /**
     * Transform a segment-local gradient.
     * @param gradient - Linear progress through the current keyframe segment.
     * @returns The progress used for interpolation. Values are not clamped.
     */
    ease(gradient: number): number;
}

export abstract class EasingFunction implements IEasingFunction {
    public static readonly EASINGMODE_EASEIN = EASINGMODE_EASEIN;
    public static readonly EASINGMODE_EASEOUT = EASINGMODE_EASEOUT;
    public static readonly EASINGMODE_EASEINOUT = EASINGMODE_EASEINOUT;

    private _mode = EASINGMODE_EASEIN;

    public setEasingMode(mode: number): void {
        this._mode = Math.min(2, Math.max(0, mode));
    }

    public getEasingMode(): number {
        return this._mode;
    }

    /** The raw ease-in curve, implemented by each subclass over `gradient` in [0, 1]. */
    public abstract easeInCore(gradient: number): number;

    public ease(gradient: number): number {
        switch (this._mode) {
            case EASINGMODE_EASEIN:
                return this.easeInCore(gradient);
            case EASINGMODE_EASEOUT:
                return 1 - this.easeInCore(1 - gradient);
            default:
                return gradient >= 0.5 ? 1 - this.easeInCore((1 - gradient) * 2) * 0.5 : this.easeInCore(gradient * 2) * 0.5;
        }
    }
}

export class CircleEase extends EasingFunction {
    public easeInCore(gradient: number): number {
        return circleEase(gradient);
    }
}

export class QuadraticEase extends EasingFunction {
    public easeInCore(gradient: number): number {
        return quadraticEase(gradient);
    }
}

export class CubicEase extends EasingFunction {
    public easeInCore(gradient: number): number {
        return cubicEase(gradient);
    }
}

export class QuarticEase extends EasingFunction {
    public easeInCore(gradient: number): number {
        return quarticEase(gradient);
    }
}

export class QuinticEase extends EasingFunction {
    public easeInCore(gradient: number): number {
        return quinticEase(gradient);
    }
}

export class SineEase extends EasingFunction {
    public easeInCore(gradient: number): number {
        return sineEase(gradient);
    }
}

export class ExponentialEase extends EasingFunction {
    public constructor(public exponent: number = 2) {
        super();
    }

    public easeInCore(gradient: number): number {
        return exponentialEase(gradient, this.exponent);
    }
}

export class BackEase extends EasingFunction {
    public constructor(public amplitude: number = 1) {
        super();
    }

    public easeInCore(gradient: number): number {
        return backEase(gradient, this.amplitude);
    }
}

export class ElasticEase extends EasingFunction {
    public constructor(
        public oscillations: number = 3,
        public springiness: number = 3
    ) {
        super();
    }

    public easeInCore(gradient: number): number {
        return elasticEase(gradient, this.oscillations, this.springiness);
    }
}

export class BounceEase extends EasingFunction {
    public constructor(
        public bounces: number = 3,
        public bounciness: number = 2
    ) {
        super();
    }

    public easeInCore(gradient: number): number {
        return bounceEase(gradient, this.bounces, this.bounciness);
    }
}

/**
 * Babylon.js-compatible power easing class.
 */
export class PowerEase extends EasingFunction {
    public constructor(public power: number = 2) {
        super();
    }

    public easeInCore(gradient: number): number {
        return powerEase(gradient, this.power);
    }
}

/**
 * Babylon.js-compatible cubic Bezier easing class.
 */
export class BezierCurveEase extends EasingFunction {
    public constructor(
        public x1: number = 0,
        public y1: number = 0,
        public x2: number = 1,
        public y2: number = 1
    ) {
        super();
    }

    public easeInCore(gradient: number): number {
        return bezierCurveEase(gradient, this.x1, this.y1, this.x2, this.y2);
    }
}
