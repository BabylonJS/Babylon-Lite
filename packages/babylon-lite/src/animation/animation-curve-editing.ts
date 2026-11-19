import type { AnimationGroup, TargetedAnimation } from "./animation-group.js";
import type { AnimationEasing } from "./easing.js";
import { INTERP_CUBICSPLINE, INTERP_LINEAR, INTERP_STEP, PATH_POINTER, PATH_ROTATION } from "./types.js";
import type { AnimationSampler } from "./types.js";

/** Sampler-space components at a time in seconds. Cubic tangents are derivatives per second. */
export interface AnimationCurveKey {
    readonly time: number;
    readonly value: readonly number[];
    readonly inTangent?: readonly number[];
    readonly outTangent?: readonly number[];
}

/** A detached keyframe snapshot, aligned with an entry in `targetedAnimations`. */
export interface AnimationCurveTrack {
    readonly target: TargetedAnimation;
    /** Current sampler mode (`linear`, `step`, or `cubicSpline`). */
    readonly interpolation: string;
    /** Property track's segment-progress transform, shared with playback. Ignored for STEP; undefined for glTF and non-eased tracks. */
    readonly easing?: AnimationEasing;
    readonly componentCount: number;
    readonly quaternion: boolean;
    readonly keys: readonly AnimationCurveKey[];
}

interface CurveSource {
    readonly target: TargetedAnimation;
    readonly sampler: AnimationSampler;
    readonly easing?: AnimationEasing;
    readonly componentCount: number;
    readonly quaternion: boolean;
    readonly endTime: number;
}

type MutableSamplerBuffers = { -readonly [K in "input" | "output"]: AnimationSampler[K] };

function getSources(group: AnimationGroup): CurveSource[] {
    const gltf = group._gltfMixer;
    if (gltf) {
        const clip = gltf[0];
        return clip.channels.map((channel, index) => {
            const sampler = clip.samplers[channel.samplerIdx];
            const target = group.targetedAnimations[index];
            if (!sampler || !target) {
                throw new Error("Animation group has an invalid channel");
            }
            const multiplier = sampler.interpolation === INTERP_CUBICSPLINE ? 3 : 1;
            const componentCount = sampler.output.length / (sampler.input.length * multiplier);
            return {
                target,
                sampler,
                componentCount,
                quaternion: channel.path === PATH_ROTATION || (channel.path === PATH_POINTER && channel.pointerQuaternion === true),
                endTime: (clip._startTime ?? 0) + clip.duration,
            };
        });
    }
    const property = group._propertyMixer;
    if (property) {
        if (property[4] !== undefined) {
            throw new Error("USD animation groups do not expose editable keyframe samplers");
        }
        return property[0].map((track, index) => {
            const target = group.targetedAnimations[index];
            if (!target) {
                throw new Error("Animation group has an invalid property track");
            }
            return { target, sampler: track.sampler, easing: track.easing, componentCount: track.stride, quaternion: track.quaternion, endTime: property[3] };
        });
    }
    throw new Error("Animation group does not expose editable keyframe samplers");
}

function interpolationName(sampler: AnimationSampler): string {
    switch (sampler.interpolation) {
        case INTERP_LINEAR:
            return "linear";
        case INTERP_STEP:
            return "step";
        case INTERP_CUBICSPLINE:
            return "cubicSpline";
        default:
            throw new Error("Unsupported animation interpolation");
    }
}

function validateSource(source: CurveSource): void {
    const { sampler, componentCount } = source;
    const multiplier = sampler.interpolation === INTERP_CUBICSPLINE ? 3 : 1;
    interpolationName(sampler);
    if (!Number.isInteger(componentCount) || componentCount < 1 || sampler.input.length === 0 || sampler.output.length !== sampler.input.length * componentCount * multiplier) {
        throw new Error("Animation group has a malformed sampler");
    }
}

/** Read detached keyframe snapshots from a glTF or property animation group.
 * Tracks match the order of `group.targetedAnimations`. Times are seconds and
 * values (including cubic tangents) are in the runtime sampler's component space.
 * @throws If the group has no supported samplers or contains malformed data. */
export function getAnimationGroupTracks(group: AnimationGroup): readonly AnimationCurveTrack[] {
    return getSources(group).map((source) => {
        validateSource(source);
        const { sampler, easing, componentCount, target, quaternion } = source;
        const cubic = sampler.interpolation === INTERP_CUBICSPLINE;
        const stride = componentCount * (cubic ? 3 : 1);
        const keys = Array.from(sampler.input, (time, index): AnimationCurveKey => {
            const offset = index * stride;
            if (cubic) {
                return {
                    time,
                    inTangent: Array.from(sampler.output.subarray(offset, offset + componentCount)),
                    value: Array.from(sampler.output.subarray(offset + componentCount, offset + 2 * componentCount)),
                    outTangent: Array.from(sampler.output.subarray(offset + 2 * componentCount, offset + stride)),
                };
            }
            return { time, value: Array.from(sampler.output.subarray(offset, offset + stride)) };
        });
        return { target, interpolation: interpolationName(sampler), easing, componentCount, quaternion, keys };
    });
}

/** Replace a track's keys without changing the clip duration or playback range.
 * Keys must be nonempty, ordered by strictly increasing nonnegative Float32 time,
 * and within the original clip duration; every component must be finite.
 * Cubic keys require both tangents, and other interpolations reject tangents.
 * The edit affects every group or channel sharing the sampler and takes effect
 * on the next evaluation or seek; it does not refresh previously baked VAT data.
 * @throws If the group, track index, or keys are invalid. */
export function setAnimationTrackKeys(group: AnimationGroup, trackIndex: number, keys: readonly AnimationCurveKey[]): void {
    const sources = getSources(group);
    if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= sources.length) {
        throw new Error("Animation track index is out of range");
    }
    const source = sources[trackIndex]!;
    validateSource(source);
    if (keys.length === 0) {
        throw new Error("Animation track requires at least one key");
    }
    const cubic = source.sampler.interpolation === INTERP_CUBICSPLINE;
    const stride = source.componentCount;
    const input = new Float32Array(keys.length);
    const output = new Float32Array(keys.length * stride * (cubic ? 3 : 1));
    let previous = -Infinity;
    const write = (values: readonly number[] | undefined, offset: number): void => {
        if (!values || values.length !== stride) {
            throw new Error(`Animation key requires ${stride} components`);
        }
        for (let i = 0; i < stride; i++) {
            const value = Math.fround(values[i]!);
            if (!Number.isFinite(value)) {
                throw new Error("Animation key components must be finite Float32 values");
            }
            output[offset + i] = value;
        }
    };
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const time = Math.fround(key.time);
        if (!Number.isFinite(time) || key.time < 0 || key.time > source.endTime || time > source.endTime || time <= previous) {
            throw new Error("Animation key times must be strictly increasing and within the original clip duration");
        }
        input[i] = time;
        previous = time;
        const offset = i * stride * (cubic ? 3 : 1);
        if (cubic) {
            write(key.inTangent, offset);
            write(key.value, offset + stride);
            write(key.outTangent, offset + 2 * stride);
        } else {
            if (key.inTangent !== undefined || key.outTangent !== undefined) {
                throw new Error("Tangents require cubic spline interpolation");
            }
            write(key.value, offset);
        }
    }
    const sampler = source.sampler as MutableSamplerBuffers;
    sampler.input = input;
    sampler.output = output;
}
