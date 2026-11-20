import type { AnimationGroup, TargetedAnimation } from "./animation-group.js";
import { evaluatePropertySampler, evaluateSampler } from "./evaluate.js";
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
    /** Runtime source that owns the sampler. */
    readonly source: "gltf" | "property";
    /** Current sampler mode (`linear`, `step`, or `cubicSpline`). */
    readonly interpolation: string;
    readonly componentCount: number;
    readonly quaternion: boolean;
    /** Property-track easing applied by Lite playback. */
    readonly easing?: AnimationEasing;
    /** True when another channel in this glTF clip references the same sampler. */
    readonly sharedSampler: boolean;
    readonly keys: readonly AnimationCurveKey[];
}

interface CurveSource {
    readonly target: TargetedAnimation;
    readonly sampler: AnimationSampler;
    readonly componentCount: number;
    readonly quaternion: boolean;
    readonly easing?: AnimationEasing;
    readonly sharedSampler?: boolean;
    readonly endTime: number;
    readonly replaceSampler?: (sampler: AnimationSampler) => void;
}

type MutableSamplerBuffers = { -readonly [K in "input" | "output"]: AnimationSampler[K] };

function getSource(group: AnimationGroup, trackIndex: number, inspectSharing: boolean): CurveSource | undefined {
    const gltf = group._gltfMixer;
    if (gltf) {
        const clip = gltf[0];
        const channel = clip.channels[trackIndex];
        if (!channel) {
            return undefined;
        }
        const sampler = clip.samplers[channel.samplerIdx];
        const target = group.targetedAnimations[trackIndex];
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
            sharedSampler: inspectSharing
                ? clip.channels.some((candidate, candidateIndex) => candidateIndex !== trackIndex && candidate.samplerIdx === channel.samplerIdx)
                : undefined,
            endTime: (clip._startTime ?? 0) + clip.duration,
        };
    }
    const property = group._propertyMixer;
    if (property) {
        if (property[4] !== undefined) {
            throw new Error("USD animation groups do not expose editable keyframe samplers");
        }
        const track = property[0][trackIndex];
        if (!track) {
            return undefined;
        }
        const target = group.targetedAnimations[trackIndex];
        if (!target) {
            throw new Error("Animation group has an invalid property track");
        }
        return {
            target,
            sampler: track.sampler,
            componentCount: track.stride,
            quaternion: track.quaternion,
            easing: track.easing,
            sharedSampler: false,
            endTime: property[3],
            replaceSampler: (sampler) => {
                (track as { sampler: AnimationSampler }).sampler = sampler;
            },
        };
    }
    throw new Error("Animation group does not expose editable keyframe samplers");
}

function getSources(group: AnimationGroup): CurveSource[] {
    if (group._gltfMixer) {
        return group.targetedAnimations.map((_target, index) => getSource(group, index, true)!);
    }
    const property = group._propertyMixer;
    if (!property) {
        throw new Error("Animation group does not expose editable keyframe samplers");
    }
    if (property[4] !== undefined) {
        throw new Error("USD animation groups do not expose editable keyframe samplers");
    }
    return group.targetedAnimations.map((_target, index) => getSource(group, index, true)!);
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
        const { sampler, componentCount, target, quaternion, easing, sharedSampler } = source;
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
        return {
            target,
            source: group._gltfMixer ? "gltf" : "property",
            interpolation: interpolationName(sampler),
            componentCount,
            quaternion,
            easing,
            sharedSampler: sharedSampler ?? false,
            keys,
        };
    });
}

/** Evaluate one editable group track using the same sampler path as Lite playback. */
export function evaluateAnimationTrack(group: AnimationGroup, trackIndex: number, time: number): readonly number[] {
    const source = getSource(group, trackIndex, false);
    if (!source) {
        throw new Error("Animation track index is out of range");
    }
    validateSource(source);
    const output = new Float32Array(source.componentCount);
    if (group._propertyMixer) {
        evaluatePropertySampler(source.sampler, time, source.componentCount, source.quaternion, source.easing, output, 0);
    } else {
        evaluateSampler(source.sampler, time, source.componentCount, source.quaternion, output, 0);
    }
    return Array.from(output);
}

export interface SetAnimationTrackKeysOptions {
    /** Detach a property runtime track from other groups created from the same reusable clip. */
    readonly detachPropertyTrack?: boolean;
}

/** Replace a track's keys without changing the clip duration or playback range.
 * Keys must be nonempty, ordered by strictly increasing nonnegative Float32 time,
 * and within the original clip duration; every component must be finite.
 * Cubic keys require both tangents, and other interpolations reject tangents.
 * By default the edit affects every group or channel sharing the sampler. Property
 * tracks can opt into detachment for adapter-owned independent editing. Changes take
 * effect on the next evaluation or seek; they do not refresh previously baked VAT data.
 * @throws If the group, track index, or keys are invalid. */
export function setAnimationTrackKeys(group: AnimationGroup, trackIndex: number, keys: readonly AnimationCurveKey[], options?: SetAnimationTrackKeysOptions): void {
    if (!Number.isInteger(trackIndex) || trackIndex < 0) {
        throw new Error("Animation track index is out of range");
    }
    const source = getSource(group, trackIndex, false);
    if (!source) {
        throw new Error("Animation track index is out of range");
    }
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
    if (source.replaceSampler && options?.detachPropertyTrack) {
        source.replaceSampler({ input, output, interpolation: source.sampler.interpolation });
    } else {
        const sampler = source.sampler as MutableSamplerBuffers;
        sampler.input = input;
        sampler.output = output;
    }
}
