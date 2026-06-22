import { F32 } from "../engine/typed-arrays.js";
import { tickAnimation } from "./animation-group.js";
import type { AnimationGroup, AnimationPropertyMixer, AnimationPropertyRuntimeTrack } from "./animation-group.js";
import { ANIMATION_GROUP_TASK_CATEGORY, getAnimationGroups } from "./animation-group-task.js";
import { setAnimationTaskCategoryHandler } from "./animation-manager.js";
import type { AnimationManager } from "./animation-manager.js";
import { evaluateSampler } from "./evaluate.js";

const MIX_TRACKS = 0;
const MIX_FROM = 1;
const MIX_TO = 2;
const MIX_DURATION = 3;

interface WeightedPointerBucket {
    readonly target: object;
    readonly property: string;
    readonly values: Float32Array;
    writer: (output: Float32Array, offset: number) => void;
    arity: number;
    quaternion: boolean;
    contested: boolean;
    active: boolean;
    hasReference: boolean;
    refX: number;
    refY: number;
    refZ: number;
    refW: number;
}

interface WeightedPointerScratch {
    readonly buckets: WeightedPointerBucket[];
    readonly sample: Float32Array;
    readonly fades: AnimationWeightFade[];
}

let scratchByManager: WeakMap<AnimationManager, WeightedPointerScratch> | undefined;

interface AnimationWeightFade {
    readonly group: AnimationGroup;
    readonly from: number;
    readonly to: number;
    readonly durationMs: number;
    elapsedMs: number;
}

/** Options for {@link fadeAnimationWeight}. */
export interface FadeAnimationWeightOptions {
    readonly to: number;
    readonly durationMs: number;
    readonly from?: number;
}

/** Options for {@link crossFadeAnimationGroups}. */
export interface CrossFadeAnimationGroupsOptions {
    readonly durationMs: number;
    readonly toWeight?: number;
}

/** Enables weighted property-animation blending on `manager` by registering its category handler. */
export function enablePropertyAnimationBlending(manager: AnimationManager): void {
    setAnimationTaskCategoryHandler(manager, ANIMATION_GROUP_TASK_CATEGORY, updateWeightedPointerAnimations);
}

function getScratch(manager: AnimationManager): WeightedPointerScratch {
    scratchByManager ??= new WeakMap();
    let scratch = scratchByManager.get(manager);
    if (!scratch) {
        scratch = {
            buckets: [],
            sample: new F32(16),
            fades: [],
        };
        scratchByManager.set(manager, scratch);
    }
    return scratch;
}

/** Animates `group`'s blend weight toward `options.to` over `options.durationMs`, enabling blending on `manager`.
 *  @throws If `to`/`from` are outside `[0, 1]` or the duration is not a finite positive number. */
export function fadeAnimationWeight(manager: AnimationManager, group: AnimationGroup, options: FadeAnimationWeightOptions): void {
    const to = validateWeight(options.to);
    const from = options.from === undefined ? group.weight : validateWeight(options.from);
    if (!(options.durationMs > 0) || !Number.isFinite(options.durationMs)) {
        throw new Error(`Animation weight fade duration must be a finite positive number, got ${options.durationMs}`);
    }

    enablePropertyAnimationBlending(manager);
    group.weight = from;
    const scratch = getScratch(manager);
    for (let i = scratch.fades.length - 1; i >= 0; i--) {
        if (scratch.fades[i]!.group === group) {
            scratch.fades.splice(i, 1);
        }
    }
    scratch.fades.push({ group, from, to, durationMs: options.durationMs, elapsedMs: 0 });
}

/** Cross-fades from `fromGroup` to `toGroup`, fading the first to weight 0 and the second to `options.toWeight` (default 1). */
export function crossFadeAnimationGroups(manager: AnimationManager, fromGroup: AnimationGroup, toGroup: AnimationGroup, options: CrossFadeAnimationGroupsOptions): void {
    const toWeight = validateWeight(options.toWeight ?? 1);
    fadeAnimationWeight(manager, fromGroup, { to: 0, durationMs: options.durationMs });
    fadeAnimationWeight(manager, toGroup, { to: toWeight, durationMs: options.durationMs });
}

function updateWeightedPointerAnimations(manager: AnimationManager, deltaMs: number): boolean {
    const scratch = getScratch(manager);
    updateFades(scratch, deltaMs);
    let contestedCount = 0;

    for (let bucketIndex = 0; bucketIndex < scratch.buckets.length; bucketIndex++) {
        const bucket = scratch.buckets[bucketIndex]!;
        bucket.contested = false;
        bucket.active = false;
        bucket.hasReference = false;
        bucket.values.fill(0);
    }

    const groups = getAnimationGroups(manager);
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex]!;
        const mixer = group._propertyMixer;
        if (group._stopped || group.weight === 1 || !mixer) {
            continue;
        }
        const tracks = mixer[MIX_TRACKS];
        for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
            const track = tracks[trackIndex]!;
            const bucket = getTrackBucket(scratch.buckets, track);
            if (!bucket.contested) {
                bucket.contested = true;
                contestedCount++;
            }
        }
    }

    if (contestedCount === 0) {
        return false;
    }

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex]!;
        if (group._stopped) {
            continue;
        }

        const mixer = group._propertyMixer;
        const tracks = mixer?.[MIX_TRACKS];
        if (!tracks) {
            tickAnimation(group, deltaMs, manager.engine);
            continue;
        }

        const t = advancePropertyGroupTime(group, mixer, deltaMs);
        const weight = group.weight;
        if (weight === 0) {
            continue;
        }

        for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
            const track = tracks[trackIndex]!;
            evaluateSampler(track.sampler, t, track.stride, track.quaternion, scratch.sample, 0);
            const bucket = getTrackBucket(scratch.buckets, track);
            if (!bucket.contested) {
                track.writer(scratch.sample, 0);
                continue;
            }
            if (weight !== 0) {
                accumulateWeightedTrack(bucket, track, scratch.sample, weight);
            }
        }
    }

    for (let bucketIndex = 0; bucketIndex < scratch.buckets.length; bucketIndex++) {
        const bucket = scratch.buckets[bucketIndex]!;
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
        group.currentTime += (deltaMs / 1000) * group.speedRatio;
    }

    const fromTime = Math.max(0, Math.min(mixer[MIX_FROM], mixer[MIX_DURATION]));
    const toTime = mixer[MIX_TO] > fromTime ? Math.min(mixer[MIX_TO], mixer[MIX_DURATION]) : mixer[MIX_DURATION];
    const duration = Math.max(0, toTime - fromTime);
    if (duration <= 0) {
        return fromTime;
    }

    if (group.loopAnimation) {
        group.currentTime = fromTime + ((group.currentTime - fromTime) % duration);
        if (group.currentTime < fromTime) {
            group.currentTime += duration;
        }
    } else {
        group.currentTime = Math.min(Math.max(group.currentTime, fromTime), toTime);
    }
    return group.currentTime;
}

function getTrackBucket(buckets: WeightedPointerBucket[], track: AnimationPropertyRuntimeTrack): WeightedPointerBucket {
    const arity = track.stride;
    for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
        const candidate = buckets[bucketIndex]!;
        if (candidate.target === track.mixTarget && candidate.property === track.mixProperty) {
            if (candidate.arity !== arity) {
                throw new Error("Weighted animation channels for the same property must use the same value size");
            }
            candidate.writer = track.writer;
            candidate.quaternion = track.quaternion;
            return candidate;
        }
    }

    const bucket: WeightedPointerBucket = {
        target: track.mixTarget,
        property: track.mixProperty,
        values: new F32(arity),
        writer: track.writer,
        arity,
        quaternion: track.quaternion,
        contested: false,
        active: false,
        hasReference: false,
        refX: 0,
        refY: 0,
        refZ: 0,
        refW: 1,
    };
    buckets.push(bucket);
    return bucket;
}

function accumulateWeightedTrack(bucket: WeightedPointerBucket, track: AnimationPropertyRuntimeTrack, sample: Float32Array, weight: number): void {
    bucket.active = true;

    let sign = 1;
    if (bucket.quaternion && track.stride === 4) {
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

    for (let i = 0; i < track.stride; i++) {
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
