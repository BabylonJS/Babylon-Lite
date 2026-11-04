/**
 * Audio parameter ramping — faithful port of Babylon.js AudioV2
 * `audioUtils._GetAudioParamCurveValues` + `_WebAudioParameterComponent`,
 * re-shaped to pure functions + a small pure-state wrapper.
 *
 * The exponential/logarithmic normalized curves are cached via lazy-init
 * (never at module scope) so this module has zero import-time side effects.
 * The curve math is copied verbatim from AudioV2 to preserve identical output.
 */

/** Ramp shape used when changing an audio parameter (volume, pan, position…). */
export type AudioRampShape = "none" | "linear" | "exponential" | "logarithmic";

/** Options for ramping an audio parameter's value. */
export interface RampOptions {
    /** Ramp time, in seconds. Clamped to at least the engine's `parameterRampDuration`. */
    duration?: number;
    /** Ramp shape. Defaults to `"linear"`. */
    shape?: AudioRampShape;
}

/**
 * Supplies the audio clock and default ramp duration for a parameter ramp.
 * The `AudioEngine` state object satisfies this.
 * @internal
 */
export interface RampClock {
    /** The audio context's `currentTime`, in seconds. @internal */
    readonly _currentTime: number;
    /** Default ramp smoothing, in seconds. @internal */
    readonly _rampDuration: number;
}

const CurveLength = 100;

/**
 * Minimum ramp duration in seconds. Below this the value is set immediately —
 * there is no perceptual difference, so a curve is not scheduled.
 */
const MinRampDuration = 0.000001;

let TmpCurveValues: Float32Array | null = null;
let ExpCurve: Float32Array | null = null;
let LogCurve: Float32Array | null = null;
const TmpLineValues = new Float32Array([0, 0]); // typed-array literal — bundler-safe, no side effect.

function getExpCurve(): Float32Array {
    if (!ExpCurve) {
        ExpCurve = new Float32Array(CurveLength);
        const increment = 1 / (CurveLength - 1);
        let x = increment;
        for (let i = 1; i < CurveLength; i++) {
            ExpCurve[i] = Math.exp(-11.512925464970227 * (1 - x));
            x += increment;
        }
    }
    return ExpCurve;
}

function getLogCurve(): Float32Array {
    if (!LogCurve) {
        LogCurve = new Float32Array(CurveLength);
        const increment = 1 / CurveLength;
        let x = increment;
        for (let i = 0; i < CurveLength; i++) {
            LogCurve[i] = 1 + Math.log10(x) / Math.log10(CurveLength);
            x += increment;
        }
    }
    return LogCurve;
}

/**
 * Returns the value-curve array for a `setValueCurveAtTime` call ramping from
 * `from` to `to` with the given shape. Linear returns a shared 2-element array;
 * exp/log return a shared 100-element array. Both are reused buffers — copy if
 * you need to retain the values.
 * @internal
 */
export function getRampCurveValues(shape: Exclude<AudioRampShape, "none">, from: number, to: number): Float32Array {
    if (shape === "linear") {
        TmpLineValues[0] = from;
        TmpLineValues[1] = to;
        return TmpLineValues;
    }

    if (!TmpCurveValues) {
        TmpCurveValues = new Float32Array(CurveLength);
    }

    const normalizedCurve = shape === "exponential" ? getExpCurve() : getLogCurve();

    const direction = Math.sign(to - from);
    const range = Math.abs(to - from);

    if (direction === 1) {
        for (let i = 0; i < normalizedCurve.length; i++) {
            TmpCurveValues[i] = from + range * normalizedCurve[i]!;
        }
    } else {
        let j = CurveLength - 1;
        for (let i = 0; i < normalizedCurve.length; i++, j--) {
            TmpCurveValues[i] = from - range * (1 - normalizedCurve[j]!);
        }
    }

    return TmpCurveValues;
}

/**
 * Pure-state wrapper around a Web Audio `AudioParam` that performs shaped
 * ramping. Mirrors AudioV2 `_WebAudioParameterComponent`.
 * @internal
 */
export interface RampParam {
    /** @internal */ _param: AudioParam;
    /** @internal */ _clock: RampClock;
    /** @internal */ _targetValue: number;
    /** @internal */ _rampEndTime: number;
}

/** @internal */
export function createRampParam(param: AudioParam, clock: RampClock): RampParam {
    return { _param: param, _clock: clock, _targetValue: param.value, _rampEndTime: 0 };
}

/** Whether the parameter is currently mid-ramp. @internal */
export function isRamping(rp: RampParam): boolean {
    return rp._clock._currentTime < rp._rampEndTime;
}

let warnedRampFailure = false;

/**
 * Sets the target value of the parameter, ramping with the given shape/duration.
 * Faithful port of `_WebAudioParameterComponent.setTargetValue`.
 * @internal
 */
export function setRampTarget(rp: RampParam, value: number, options?: RampOptions): void {
    if (!Number.isFinite(value)) {
        console.warn(`Attempted to set audio parameter to non-finite value: ${value}`);
        return;
    }

    rp._param.cancelScheduledValues(0);

    const shape: AudioRampShape = typeof options?.shape === "string" ? options.shape : "linear";
    const startTime = rp._clock._currentTime;

    if (shape === "none") {
        rp._param.value = rp._targetValue = value;
        rp._rampEndTime = startTime;
        return;
    }

    rp._targetValue = value;

    const rampDuration = rp._clock._rampDuration;
    let duration = typeof options?.duration === "number" ? Math.max(options.duration, rampDuration) : rampDuration;
    duration = Math.max(rampDuration, duration);

    if (duration < MinRampDuration) {
        rp._param.setValueAtTime(value, startTime);
        return;
    }

    try {
        const from = Number.isFinite(rp._param.value) ? rp._param.value : 0;
        rp._param.setValueCurveAtTime(getRampCurveValues(shape, from, value), startTime, duration);
        rp._rampEndTime = startTime + duration;
    } catch (e) {
        if (!warnedRampFailure) {
            console.warn(`Audio parameter ramping failed: ${(e as Error).message}`);
            warnedRampFailure = true;
        }
    }
}
