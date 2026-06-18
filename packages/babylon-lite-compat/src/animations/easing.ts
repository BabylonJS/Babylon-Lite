/**
 * Babylon.js-compatible easing functions (pure, no Babylon Lite dependency).
 *
 * These mirror Babylon.js's `EasingFunction` hierarchy and easing modes for use
 * with property animations. They are fully unit-testable.
 */

export const EASINGMODE_EASEIN = 0;
export const EASINGMODE_EASEOUT = 1;
export const EASINGMODE_EASEINOUT = 2;

export abstract class EasingFunction {
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
        const g = Math.max(0, Math.min(1, gradient));
        return 1 - Math.sqrt(1 - g * g);
    }
}

export class QuadraticEase extends EasingFunction {
    public easeInCore(gradient: number): number {
        return gradient * gradient;
    }
}

export class CubicEase extends EasingFunction {
    public easeInCore(gradient: number): number {
        return gradient * gradient * gradient;
    }
}

export class QuarticEase extends EasingFunction {
    public easeInCore(gradient: number): number {
        return gradient * gradient * gradient * gradient;
    }
}

export class QuinticEase extends EasingFunction {
    public easeInCore(gradient: number): number {
        return gradient * gradient * gradient * gradient * gradient;
    }
}

export class SineEase extends EasingFunction {
    public easeInCore(gradient: number): number {
        return 1 - Math.sin((Math.PI / 2) * (1 - gradient));
    }
}

export class ExponentialEase extends EasingFunction {
    public constructor(private readonly exponent: number = 2) {
        super();
    }

    public easeInCore(gradient: number): number {
        if (this.exponent <= 0) {
            return gradient;
        }
        return (Math.exp(this.exponent * gradient) - 1) / (Math.exp(this.exponent) - 1);
    }
}

export class BackEase extends EasingFunction {
    public constructor(private readonly amplitude: number = 1) {
        super();
    }

    public easeInCore(gradient: number): number {
        const num = Math.max(0, this.amplitude);
        return Math.pow(gradient, 3) - gradient * num * Math.sin(Math.PI * gradient);
    }
}

export class ElasticEase extends EasingFunction {
    public constructor(
        private readonly oscillations: number = 3,
        private readonly springiness: number = 3
    ) {
        super();
    }

    public easeInCore(gradient: number): number {
        const num2 = Math.max(0, this.oscillations);
        const num3 = Math.max(0, this.springiness);
        const num = num3 === 0 ? gradient : (Math.exp(num3 * gradient) - 1) / (Math.exp(num3) - 1);
        return num * Math.sin((2 * Math.PI * num2 + Math.PI / 2) * gradient);
    }
}

export class BounceEase extends EasingFunction {
    public constructor(
        private readonly bounces: number = 3,
        private readonly bounciness: number = 2
    ) {
        super();
    }

    public easeInCore(gradient: number): number {
        const num = Math.max(0, this.bounces);
        let bounciness = this.bounciness;
        if (bounciness <= 1) {
            bounciness = 1.001;
        }
        const num2 = Math.pow(bounciness, num);
        const num3 = 1 - bounciness;
        const num4 = (1 - num2) / num3 + num2 * 0.5;
        const num5 = gradient * num4;
        const num6 = Math.log(-num5 * (1 - bounciness) + 1) / Math.log(bounciness);
        const num7 = Math.floor(num6);
        const num8 = num7 + 1;
        const num9 = (1 - Math.pow(bounciness, num7)) / (num3 * num4);
        const num10 = (1 - Math.pow(bounciness, num8)) / (num3 * num4);
        const num11 = (num9 + num10) * 0.5;
        const num12 = gradient - num11;
        const num13 = num11 - num9;
        return (-Math.pow(1 / bounciness, num - num7) / (num13 * num13)) * (num12 - num13) * (num12 + num13);
    }
}
