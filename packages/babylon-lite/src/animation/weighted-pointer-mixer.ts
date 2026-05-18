import { tickAnimation } from "./animation-group.js";
import type { AnimationGroup, AnimationPropertyMixer } from "./animation-group.js";
import type { AnimationManager } from "./animation-manager-core.js";
import type { AnimationChannel } from "./types.js";
import { evaluateSampler } from "./evaluate.js";

const MIX_CHANNELS = 0;
const MIX_SAMPLERS = 1;
const MIX_FROM = 2;
const MIX_TO = 3;
const MIX_DURATION = 4;

interface WeightedPointerBucket {
    readonly values: Float32Array;
    writer: (output: Float32Array, offset: number) => void;
    arity: number;
    quaternion: boolean;
    active: boolean;
    hasReference: boolean;
    refX: number;
    refY: number;
    refZ: number;
    refW: number;
}

interface WeightedPointerScratch {
    readonly keys: Set<object>;
    readonly buckets: Map<object, WeightedPointerBucket>;
    readonly sample: Float32Array;
    readonly fades: AnimationWeightFade[];
}

const _scratch = new WeakMap<AnimationManager, WeightedPointerScratch>();

interface AnimationWeightFade {
    readonly group: AnimationGroup;
    readonly from: number;
    readonly to: number;
    readonly durationMs: number;
    elapsedMs: number;
}

export interface FadeAnimationWeightOptions {
    readonly to: number;
    readonly durationMs: number;
    readonly from?: number;
}

export interface CrossFadeAnimationGroupsOptions {
    readonly durationMs: number;
    readonly toWeight?: number;
}

export function attachWeightedAnimationMixer(manager: AnimationManager): void {
    manager._wu = updateWeightedPointerAnimations;
}

function getScratch(manager: AnimationManager): WeightedPointerScratch {
    let scratch = _scratch.get(manager);
    if (!scratch) {
        scratch = {
            keys: new Set<object>(),
            buckets: new Map<object, WeightedPointerBucket>(),
            sample: new Float32Array(16),
            fades: [],
        };
        _scratch.set(manager, scratch);
    }
    return scratch;
}

export function fadeAnimationWeight(manager: AnimationManager, group: AnimationGroup, options: FadeAnimationWeightOptions): void {
    const to = validateWeight(options.to);
    const from = options.from === undefined ? group.weight : validateWeight(options.from);
    if (!(options.durationMs > 0) || !Number.isFinite(options.durationMs)) {
        throw new Error(`Animation weight fade duration must be a finite positive number, got ${options.durationMs}`);
    }

    attachWeightedAnimationMixer(manager);
    group.weight = from;
    const scratch = getScratch(manager);
    for (let i = scratch.fades.length - 1; i >= 0; i--) {
        if (scratch.fades[i]!.group === group) {
            scratch.fades.splice(i, 1);
        }
    }
    scratch.fades.push({ group, from, to, durationMs: options.durationMs, elapsedMs: 0 });
}

export function crossFadeAnimationGroups(manager: AnimationManager, fromGroup: AnimationGroup, toGroup: AnimationGroup, options: CrossFadeAnimationGroupsOptions): void {
    const toWeight = validateWeight(options.toWeight ?? 1);
    fadeAnimationWeight(manager, fromGroup, { to: 0, durationMs: options.durationMs });
    fadeAnimationWeight(manager, toGroup, { to: toWeight, durationMs: options.durationMs });
}

function updateWeightedPointerAnimations(manager: AnimationManager, deltaMs: number): boolean {
    const scratch = getScratch(manager);
    updateFades(scratch, deltaMs);
    const keys = scratch.keys;
    keys.clear();

    for (const group of manager.animationGroups) {
        const mixer = group._pm;
        if (group._stopped || group.weight === 1 || !mixer) {
            continue;
        }
        for (const ch of mixer[MIX_CHANNELS]) {
            if (ch._mk) {
                keys.add(ch._mk);
            }
        }
    }

    if (keys.size === 0) {
        return false;
    }

    for (const bucket of scratch.buckets.values()) {
        bucket.active = false;
        bucket.hasReference = false;
        bucket.values.fill(0);
    }

    for (const group of manager.animationGroups) {
        if (group._stopped) {
            continue;
        }

        const mixer = group._pm;
        if (!mixer || !hasWeightedChannel(mixer[MIX_CHANNELS], keys)) {
            tickAnimation(group, deltaMs, manager.engine);
            continue;
        }

        const t = advancePropertyGroupTime(group, mixer, deltaMs);
        const samplers = mixer[MIX_SAMPLERS];
        const weight = group.weight;
        if (weight === 0) {
            continue;
        }

        for (const channel of mixer[MIX_CHANNELS]) {
            if (!channel.pointerArity || !channel.pointerWriter) {
                continue;
            }
            evaluateSampler(samplers[channel.samplerIdx]!, t, channel.pointerArity, channel.pointerQuaternion === true, scratch.sample, 0);
            if (!channel._mk || !keys.has(channel._mk)) {
                channel.pointerWriter(scratch.sample, 0);
                continue;
            }
            accumulateWeightedChannel(scratch.buckets, channel, scratch.sample, weight);
        }
    }

    for (const bucket of scratch.buckets.values()) {
        if (!bucket.active) {
            continue;
        }
        if (bucket.quaternion && bucket.arity === 4) {
            normalizeQuaternion(bucket.values);
        }
        bucket.writer(bucket.values, 0);
    }

    return true;
}

function updateFades(scratch: WeightedPointerScratch, deltaMs: number): void {
    for (let i = scratch.fades.length - 1; i >= 0; i--) {
        const fade = scratch.fades[i]!;
        fade.elapsedMs = Math.min(fade.durationMs, fade.elapsedMs + Math.max(0, deltaMs));
        const t = fade.elapsedMs / fade.durationMs;
        fade.group.weight = fade.from + (fade.to - fade.from) * t;
        if (fade.elapsedMs >= fade.durationMs) {
            fade.group.weight = fade.to;
            scratch.fades.splice(i, 1);
        }
    }
}

function validateWeight(weight: number): number {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
        throw new Error(`Animation weight must be a finite number between 0 and 1, got ${weight}`);
    }
    return weight;
}

function advancePropertyGroupTime(group: AnimationGroup, mixer: AnimationPropertyMixer, deltaMs: number): number {
    if (group.isPlaying) {
        group.currentFrame += (deltaMs / 1000) * group.speedRatio;
    }

    const fromTime = Math.max(0, Math.min(mixer[MIX_FROM], mixer[MIX_DURATION]));
    const toTime = mixer[MIX_TO] > fromTime ? Math.min(mixer[MIX_TO], mixer[MIX_DURATION]) : mixer[MIX_DURATION];
    const duration = Math.max(0, toTime - fromTime);
    if (duration <= 0) {
        return fromTime;
    }

    if (group.loopAnimation) {
        group.currentFrame = fromTime + ((group.currentFrame - fromTime) % duration);
        if (group.currentFrame < fromTime) {
            group.currentFrame += duration;
        }
    } else {
        group.currentFrame = Math.min(Math.max(group.currentFrame, fromTime), toTime);
    }
    return group.currentFrame;
}

function hasWeightedChannel(channels: readonly AnimationChannel[], keys: Set<object>): boolean {
    for (const ch of channels) {
        if (ch._mk && keys.has(ch._mk)) {
            return true;
        }
    }
    return false;
}

function getChannelScratch(buckets: Map<object, WeightedPointerBucket>, channel: AnimationChannel): WeightedPointerBucket {
    const key = channel._mk!;
    const arity = channel.pointerArity!;
    const writer = channel.pointerWriter!;
    let bucket = buckets.get(key);
    if (!bucket) {
        bucket = {
            values: new Float32Array(arity),
            writer,
            arity,
            quaternion: channel.pointerQuaternion === true,
            active: false,
            hasReference: false,
            refX: 0,
            refY: 0,
            refZ: 0,
            refW: 1,
        };
        buckets.set(key, bucket);
    } else if (bucket.arity !== arity) {
        throw new Error("Weighted animation channels for the same property must use the same value size");
    }

    bucket.writer = writer;
    bucket.quaternion = channel.pointerQuaternion === true;
    return bucket;
}

function accumulateWeightedChannel(buckets: Map<object, WeightedPointerBucket>, channel: AnimationChannel, sample: Float32Array, weight: number): void {
    const bucket = getChannelScratch(buckets, channel);
    bucket.active = true;

    let sign = 1;
    if (bucket.quaternion && channel.pointerArity === 4) {
        if (!bucket.hasReference) {
            bucket.refX = sample[0]!;
            bucket.refY = sample[1]!;
            bucket.refZ = sample[2]!;
            bucket.refW = sample[3]!;
            bucket.hasReference = true;
        } else {
            const dot = bucket.refX * sample[0]! + bucket.refY * sample[1]! + bucket.refZ * sample[2]! + bucket.refW * sample[3]!;
            sign = dot < 0 ? -1 : 1;
        }
    }

    for (let i = 0; i < channel.pointerArity!; i++) {
        bucket.values[i] = bucket.values[i]! + sample[i]! * weight * sign;
    }
}

function normalizeQuaternion(values: Float32Array): void {
    const x = values[0]!;
    const y = values[1]!;
    const z = values[2]!;
    const w = values[3]!;
    const lenSq = x * x + y * y + z * z + w * w;
    if (lenSq > 0) {
        const inv = 1 / Math.sqrt(lenSq);
        values[0] = x * inv;
        values[1] = y * inv;
        values[2] = z * inv;
        values[3] = w * inv;
    }
}
