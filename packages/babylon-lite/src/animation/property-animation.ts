import { F32 } from "../engine/typed-arrays.js";
import { playAnimation } from "./animation-group.js";
import type { AnimationGroup, AnimationPropertyRuntimeTrack } from "./animation-group.js";
import { addAnimationGroup } from "./animation-group-task.js";
import type { AnimationManager } from "./animation-manager.js";
import { INTERP_LINEAR, INTERP_STEP } from "./types.js";
import type { AnimationSampler } from "./types.js";
import { evaluateSampler } from "./evaluate.js";
import type { AnimationController } from "../skeleton/skeleton-updater.js";

const DEFAULT_FRAME_RATE = 60;

/** A keyframe value: a single scalar or a fixed-length tuple of components (e.g. a vector or quaternion). */
export type AnimationKeyframeValue = number | readonly number[];

/** A single keyframe on a property animation track. Supply exactly one of `time` (seconds) or `frame`. */
export interface AnimationKeyframe {
    readonly time?: number;
    readonly frame?: number;
    readonly value: AnimationKeyframeValue;
}

/** Interpolation mode between keyframes: smooth `"linear"` or hold-previous `"step"`. */
export type PropertyAnimationInterpolation = "linear" | "step";

/** Options describing one animated property track passed to {@link createPropertyAnimationClip}. */
export interface PropertyAnimationTrackOptions {
    readonly path: string;
    readonly keys: readonly AnimationKeyframe[];
    readonly frameRate?: number;
    readonly interpolation?: PropertyAnimationInterpolation;
    readonly quaternion?: boolean;
}

/** Options for {@link createPropertyAnimationClip}. */
export interface PropertyAnimationClipOptions {
    readonly frameRate?: number;
}

/** A compiled animation track: a sampler plus the metadata needed to evaluate and write its property. */
export interface PropertyAnimationTrack {
    readonly path: string;
    readonly sampler: AnimationSampler;
    readonly stride: number;
    readonly quaternion: boolean;
}

/** A reusable, target-independent set of compiled property tracks with a total duration. */
export interface PropertyAnimationClip {
    readonly name: string;
    readonly tracks: readonly PropertyAnimationTrack[];
    readonly duration: number;
    readonly frameRate: number;
}

/** Options for {@link createPropertyAnimationGroup}, controlling looping, speed, and play range. */
export interface CreatePropertyAnimationGroupOptions {
    readonly loop?: boolean;
    readonly speedRatio?: number;
    readonly fromFrame?: number;
    readonly toFrame?: number;
    readonly fromTime?: number;
    readonly toTime?: number;
}

type PropertyWriter = (output: Float32Array, offset: number) => void;

interface ResolvedPropertyBinding {
    readonly mixTarget: object;
    readonly mixProperty: string;
    readonly writer: PropertyWriter;
}

interface PathSettable {
    set: (...values: number[]) => void;
}

/** Compiles a set of track definitions into a reusable {@link PropertyAnimationClip}.
 *  @param name - Clip name.
 *  @param tracks - One or more track definitions; their keyframes are sorted and baked into samplers.
 *  @param options - Optional default frame rate.
 *  @returns The compiled clip, with its duration set to the longest track.
 *  @throws If no tracks are provided. */
export function createPropertyAnimationClip(name: string, tracks: readonly PropertyAnimationTrackOptions[], options?: PropertyAnimationClipOptions): PropertyAnimationClip {
    if (tracks.length === 0) {
        throw new Error("createPropertyAnimationClip requires at least one track");
    }
    const frameRate = options?.frameRate ?? tracks[0]?.frameRate ?? DEFAULT_FRAME_RATE;
    let duration = 0;
    const builtTracks = tracks.map((track) => {
        const trackFrameRate = track.frameRate ?? frameRate;
        const sampler = createSampler(track, trackFrameRate);
        const trackDuration = sampler.input[sampler.input.length - 1] ?? 0;
        if (trackDuration > duration) {
            duration = trackDuration;
        }
        return {
            path: track.path,
            sampler,
            stride: getTrackStride(track),
            quaternion: track.quaternion === true || track.path === "rotationQuaternion" || track.path.endsWith(".rotationQuaternion"),
        };
    });
    return { name, tracks: builtTracks, duration, frameRate };
}

/** Binds `clip` to `target`'s properties, creates a playing animation group, and attaches it to `manager`.
 *  @param manager - Animation manager that drives the resulting group.
 *  @param target - Object whose properties (resolved by each track's dotted path) are animated.
 *  @param clip - Compiled clip to play.
 *  @param options - Optional looping, speed, and play-range overrides.
 *  @returns The started animation group.
 *  @throws If the resolved play range does not have `toTime` greater than `fromTime`. */
export function createPropertyAnimationGroup(
    manager: AnimationManager,
    target: object,
    clip: PropertyAnimationClip,
    options?: CreatePropertyAnimationGroupOptions
): AnimationGroup {
    const runtimeTracks: AnimationPropertyRuntimeTrack[] = [];
    for (let i = 0; i < clip.tracks.length; i++) {
        const track = clip.tracks[i]!;
        const binding = resolvePropertyBinding(target, track.path, track.stride);
        runtimeTracks.push({
            sampler: track.sampler,
            stride: track.stride,
            quaternion: track.quaternion,
            writer: binding.writer,
            mixTarget: binding.mixTarget,
            mixProperty: binding.mixProperty,
        });
    }

    const fromTime = options?.fromTime ?? (options?.fromFrame !== undefined ? options.fromFrame / clip.frameRate : 0);
    const toTime = options?.toTime ?? (options?.toFrame !== undefined ? options.toFrame / clip.frameRate : clip.duration);
    if (!(toTime > fromTime)) {
        throw new Error("Animation play range must have toTime greater than fromTime");
    }

    const group = createPointerAnimationGroup(clip.name, clip.duration, clip.frameRate, runtimeTracks, fromTime, toTime, options);
    group.loopAnimation = options?.loop ?? true;
    group.speedRatio = options?.speedRatio ?? 1;
    group._propertyMixer = [runtimeTracks, fromTime, toTime, clip.duration];
    playAnimation(group);
    addAnimationGroup(manager, group);
    return group;
}

function createPointerAnimationGroup(
    name: string,
    duration: number,
    frameRate: number,
    tracks: readonly AnimationPropertyRuntimeTrack[],
    fromTime: number,
    toTime: number,
    options?: CreatePropertyAnimationGroupOptions
): AnimationGroup {
    const ctrl: AnimationController = {
        time: fromTime,
        playing: false,
        speedRatio: options?.speedRatio ?? 1,
        loop: options?.loop ?? true,
        tick(deltaMs: number): void {
            if (ctrl.playing) {
                ctrl.time += (deltaMs / 1000) * ctrl.speedRatio;
            }
            const duration = Math.max(0, toTime - fromTime);
            if (duration <= 0) {
                return;
            }
            if (ctrl.loop && ctrl.playing) {
                ctrl.time = fromTime + ((ctrl.time - fromTime) % duration);
                if (ctrl.time < fromTime) {
                    ctrl.time += duration;
                }
            } else {
                ctrl.time = Math.min(Math.max(ctrl.time, fromTime), toTime);
            }
            for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
                const track = tracks[trackIndex]!;
                evaluateSampler(track.sampler, ctrl.time, track.stride, track.quaternion, _pointerScratch, 0);
                track.writer(_pointerScratch, 0);
            }
        },
    };
    return {
        name,
        duration,
        frameRate: frameRate || DEFAULT_FRAME_RATE,
        isPlaying: false,
        currentTime: fromTime,
        targetedAnimations: tracks.map((track) => ({ target: track.mixTarget, path: track.mixProperty })),
        speedRatio: options?.speedRatio ?? 1,
        loopAnimation: options?.loop ?? true,
        weight: 1,
        _ctrl: ctrl,
        _stopped: false,
    };
}

const _pointerScratch = new F32(16);

function createSampler(track: PropertyAnimationTrackOptions, frameRate: number): AnimationSampler {
    if (track.keys.length === 0) {
        throw new Error(`Animation track "${track.path}" requires at least one key`);
    }
    if (!(frameRate > 0)) {
        throw new Error(`Animation track "${track.path}" requires a positive frameRate`);
    }

    const stride = getTrackStride(track);
    const sorted = [...track.keys].sort((a, b) => getKeyTime(a, frameRate, track.path) - getKeyTime(b, frameRate, track.path));
    const input = new F32(sorted.length);
    const output = new F32(sorted.length * stride);
    let lastTime = -Infinity;
    for (let i = 0; i < sorted.length; i++) {
        const key = sorted[i]!;
        const time = getKeyTime(key, frameRate, track.path);
        if (time < lastTime) {
            throw new Error(`Animation track "${track.path}" key times must be monotonically increasing`);
        }
        input[i] = time;
        lastTime = time;
        writeKeyValue(track.path, key.value, stride, output, i * stride);
    }
    return {
        input,
        output,
        interpolation: track.interpolation === "step" ? INTERP_STEP : INTERP_LINEAR,
    };
}

function getTrackStride(track: PropertyAnimationTrackOptions): number {
    const value = track.keys[0]?.value;
    if (value === undefined) {
        throw new Error(`Animation track "${track.path}" requires at least one key`);
    }
    return typeof value === "number" ? 1 : value.length;
}

function getKeyTime(key: AnimationKeyframe, frameRate: number, path: string): number {
    const hasTime = key.time !== undefined;
    const hasFrame = key.frame !== undefined;
    if (hasTime === hasFrame) {
        throw new Error(`Animation key for "${path}" must provide exactly one of time or frame`);
    }
    const time = hasTime ? key.time! : key.frame! / frameRate;
    if (!(time >= 0)) {
        throw new Error(`Animation key for "${path}" must have a non-negative time`);
    }
    return time;
}

function writeKeyValue(path: string, value: AnimationKeyframeValue, stride: number, output: Float32Array, offset: number): void {
    if (typeof value === "number") {
        if (stride !== 1) {
            throw new Error(`Animation key for "${path}" expected ${stride} values`);
        }
        output[offset] = value;
        return;
    }
    if (value.length !== stride) {
        throw new Error(`Animation key for "${path}" expected ${stride} values`);
    }
    for (let i = 0; i < stride; i++) {
        output[offset + i] = value[i]!;
    }
}

function resolvePropertyBinding(target: object, path: string, stride: number): ResolvedPropertyBinding {
    const parts = path.split(".");
    if (parts.length === 0 || parts.some((p) => p.length === 0)) {
        throw new Error(`Invalid animation property path "${path}"`);
    }

    let owner: unknown = target;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]!;
        const record = asRecord(owner, path);
        if (!(part in record)) {
            throw new Error(`Animation property path "${path}" could not resolve "${part}"`);
        }
        owner = record[part];
    }

    const property = parts[parts.length - 1]!;
    const record = asRecord(owner, path);
    if (!(property in record)) {
        throw new Error(`Animation property path "${path}" could not resolve "${property}"`);
    }

    return { mixTarget: record, mixProperty: property, writer: createPropertyWriter(record, property, stride, path) };
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
        throw new Error(`Animation property path "${path}" reached a non-object value`);
    }
    return value as Record<string, unknown>;
}

function isSettable(value: unknown): value is PathSettable {
    return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { set?: unknown }).set === "function";
}

function createPropertyWriter(target: Record<string, unknown>, property: string, stride: number, path: string): PropertyWriter {
    if (stride === 1) {
        return (output, offset) => {
            target[property] = output[offset]!;
        };
    }
    if (stride > 4) {
        throw new Error(`Animation property path "${path}" has unsupported vector size ${stride}`);
    }

    const targetValue = target[property];
    if (isSettable(targetValue)) {
        switch (stride) {
            case 2:
                return (output, offset) => targetValue.set(output[offset]!, output[offset + 1]!);
            case 3:
                return (output, offset) => targetValue.set(output[offset]!, output[offset + 1]!, output[offset + 2]!);
            case 4:
                return (output, offset) => targetValue.set(output[offset]!, output[offset + 1]!, output[offset + 2]!, output[offset + 3]!);
        }
    }

    const valueRecord = asRecord(targetValue, path);
    const components = "xyzw";
    for (let i = 0; i < stride; i++) {
        if (!(components[i]! in valueRecord)) {
            throw new Error(`Animation property path "${path}" could not resolve component "${components[i]!}"`);
        }
    }
    return (output, offset) => {
        for (let i = 0; i < stride; i++) {
            valueRecord[components[i]!] = output[offset + i]!;
        }
    };
}
