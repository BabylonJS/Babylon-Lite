import { playAnimation } from "./animation-group.js";
import type { AnimationGroup } from "./animation-group.js";
import { addAnimationGroup } from "./animation-manager-core.js";
import type { AnimationManager } from "./animation-manager-core.js";
import { INTERP_LINEAR, INTERP_STEP, PATH_POINTER } from "./types.js";
import type { AnimationChannel, AnimationClip, AnimationSampler } from "./types.js";
import { evaluateSampler } from "./evaluate.js";
import type { AnimationController } from "../skeleton/skeleton-updater.js";

export {
    addAnimationGroup,
    addAnimationGroups,
    clearAnimationManager,
    createAnimationManager,
    removeAnimationGroup,
    startAnimationManager,
    stopAnimationManager,
    updateAnimationManager,
} from "./animation-manager-core.js";
export type { AnimationManager, AnimationManagerOptions } from "./animation-manager-core.js";

const DEFAULT_FRAME_RATE = 60;

export type AnimationKeyframeValue = number | readonly number[];

export interface AnimationKeyframe {
    readonly time?: number;
    readonly frame?: number;
    readonly value: AnimationKeyframeValue;
}

export type PropertyAnimationInterpolation = "linear" | "step";

export interface PropertyAnimationTrackOptions {
    readonly path: string;
    readonly keys: readonly AnimationKeyframe[];
    readonly frameRate?: number;
    readonly interpolation?: PropertyAnimationInterpolation;
    readonly quaternion?: boolean;
}

export interface PropertyAnimationClipOptions {
    readonly frameRate?: number;
}

export interface PropertyAnimationTrack {
    readonly path: string;
    readonly sampler: AnimationSampler;
    readonly stride: number;
    readonly quaternion: boolean;
}

export interface PropertyAnimationClip {
    readonly name: string;
    readonly tracks: readonly PropertyAnimationTrack[];
    readonly duration: number;
    readonly frameRate: number;
}

export interface CreatePropertyAnimationGroupOptions {
    readonly loop?: boolean;
    readonly speedRatio?: number;
    readonly fromFrame?: number;
    readonly toFrame?: number;
    readonly fromTime?: number;
    readonly toTime?: number;
}

type PropertyWriter = (output: Float32Array, offset: number) => void;

type PropertyBinding = readonly [object, PropertyWriter, number];

interface PathSettable {
    set: (...values: number[]) => void;
}

const _propertyBindings = new WeakMap<object, Map<string, PropertyBinding>>();

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

export function createPropertyAnimationGroup(
    manager: AnimationManager,
    target: object,
    clip: PropertyAnimationClip,
    options?: CreatePropertyAnimationGroupOptions
): AnimationGroup {
    const samplers: AnimationSampler[] = [];
    const channels: AnimationChannel[] = [];
    for (let i = 0; i < clip.tracks.length; i++) {
        const track = clip.tracks[i]!;
        const binding = resolvePropertyBinding(target, track.path, track.stride);
        samplers.push(track.sampler);
        channels.push({
            samplerIdx: i,
            nodeIdx: -1,
            path: PATH_POINTER,
            pointerArity: track.stride,
            pointerQuaternion: track.quaternion,
            pointerWriter: binding[1],
            _mk: binding[0],
        });
    }

    const runtimeClip: AnimationClip = {
        name: clip.name,
        channels,
        samplers,
        duration: clip.duration,
        frameRate: clip.frameRate,
    };

    const fromTime = options?.fromTime ?? (options?.fromFrame !== undefined ? options.fromFrame / clip.frameRate : 0);
    const toTime = options?.toTime ?? (options?.toFrame !== undefined ? options.toFrame / clip.frameRate : clip.duration);
    if (!(toTime > fromTime)) {
        throw new Error("Animation play range must have toTime greater than fromTime");
    }

    const group = createPointerAnimationGroup(runtimeClip, fromTime, toTime, options);
    group.loopAnimation = options?.loop ?? true;
    group.speedRatio = options?.speedRatio ?? 1;
    group._pm = [channels, samplers, fromTime, toTime, clip.duration];
    playAnimation(group);
    addAnimationGroup(manager, group);
    return group;
}

function createPointerAnimationGroup(clip: AnimationClip, fromTime: number, toTime: number, options?: CreatePropertyAnimationGroupOptions): AnimationGroup {
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
            for (const ch of clip.channels) {
                if (ch.pointerArity && ch.pointerWriter) {
                    evaluateSampler(clip.samplers[ch.samplerIdx]!, ctrl.time, ch.pointerArity, ch.pointerQuaternion === true, _pointerScratch, 0);
                    ch.pointerWriter(_pointerScratch, 0);
                }
            }
        },
    };
    return {
        name: clip.name,
        duration: clip.duration,
        frameRate: clip.frameRate || DEFAULT_FRAME_RATE,
        get isPlaying(): boolean {
            return ctrl.playing;
        },
        get currentFrame(): number {
            return ctrl.time;
        },
        set currentFrame(v: number) {
            ctrl.time = v;
        },
        get speedRatio(): number {
            return ctrl.speedRatio;
        },
        set speedRatio(v: number) {
            ctrl.speedRatio = v;
        },
        get loopAnimation(): boolean {
            return ctrl.loop;
        },
        set loopAnimation(v: boolean) {
            ctrl.loop = v;
        },
        weight: 1,
        _ctrl: ctrl,
        _stopped: false,
    };
}

const _pointerScratch = new Float32Array(16);

function createSampler(track: PropertyAnimationTrackOptions, frameRate: number): AnimationSampler {
    if (track.keys.length === 0) {
        throw new Error(`Animation track "${track.path}" requires at least one key`);
    }
    if (!(frameRate > 0)) {
        throw new Error(`Animation track "${track.path}" requires a positive frameRate`);
    }

    const stride = getTrackStride(track);
    const sorted = [...track.keys].sort((a, b) => getKeyTime(a, frameRate, track.path) - getKeyTime(b, frameRate, track.path));
    const input = new Float32Array(sorted.length);
    const output = new Float32Array(sorted.length * stride);
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

function resolvePropertyBinding(target: object, path: string, stride: number): PropertyBinding {
    let bindings = _propertyBindings.get(target);
    if (!bindings) {
        bindings = new Map<string, PropertyBinding>();
        _propertyBindings.set(target, bindings);
    }
    const cached = bindings.get(path);
    if (cached) {
        if (cached[2] !== stride) {
            throw new Error("Stride mismatch");
        }
        return cached;
    }

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

    let writer: PropertyWriter;
    if (stride === 1) {
        writer = (output, offset) => {
            record[property] = output[offset]!;
        };
    } else {
        const targetValue = record[property];
        const settable = isSettable(targetValue) ? targetValue : null;
        if (settable) {
            writer = createSetWriter(settable, stride, path);
        } else {
            const valueRecord = asRecord(targetValue, path);
            writer = createComponentWriter(valueRecord, stride, path);
        }
    }

    const binding: PropertyBinding = [{}, writer, stride];
    bindings.set(path, binding);
    return binding;
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

function createSetWriter(target: PathSettable, stride: number, path: string): PropertyWriter {
    switch (stride) {
        case 2:
            return (output, offset) => target.set(output[offset]!, output[offset + 1]!);
        case 3:
            return (output, offset) => target.set(output[offset]!, output[offset + 1]!, output[offset + 2]!);
        case 4:
            return (output, offset) => target.set(output[offset]!, output[offset + 1]!, output[offset + 2]!, output[offset + 3]!);
        default:
            throw new Error(`Animation property path "${path}" has unsupported vector size ${stride}`);
    }
}

function createComponentWriter(target: Record<string, unknown>, stride: number, path: string): PropertyWriter {
    if (stride > 4) {
        throw new Error(`Animation property path "${path}" has unsupported vector size ${stride}`);
    }
    const components = ["x", "y", "z", "w"];
    for (let i = 0; i < stride; i++) {
        if (!(components[i]! in target)) {
            throw new Error(`Animation property path "${path}" could not resolve component "${components[i]!}"`);
        }
    }
    return (output, offset) => {
        for (let i = 0; i < stride; i++) {
            target[components[i]!] = output[offset + i]!;
        }
    };
}
