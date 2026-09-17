import { F32 } from "../engine/typed-arrays.js";
import { tickAnimationCore } from "./animation-group.js";
import type { AnimationGroup, AnimationPropertyMixer, AnimationPropertyMixStrategy, AnimationPropertyRuntimeTrack } from "./animation-group.js";
import { ANIMATION_GROUP_TASK_CATEGORY, getAnimationGroups } from "./animation-group-task.js";
import { setAnimationTaskCategoryHandler } from "./animation-manager.js";
import type { AnimationManager } from "./animation-manager.js";
import { evaluateSampler } from "./evaluate.js";

const MIX_TRACKS = 0;
const MIX_FROM = 1;
const MIX_TO = 2;
const MIX_DURATION = 3;
const MIX_START = 4;

interface WeightedPointerBucket {
    readonly target: object;
    readonly property: string;
    readonly values: Float32Array;
    writer: (output: Float32Array, offset: number) => void;
    arity: number;
    quaternion: boolean;
    mix?: AnimationPropertyMixStrategy;
    afterWrite?: () => void;
    retained: boolean;
    contested: boolean;
    active: boolean;
    hasReference: boolean;
    totalWeight: number;
    refX: number;
    refY: number;
    refZ: number;
    refW: number;
}

interface WeightedPointerScratch {
    readonly buckets: WeightedPointerBucket[];
    readonly sample: Float32Array;
    readonly afterWrites: Set<() => void>;
}

let scratchByManager: WeakMap<AnimationManager, WeightedPointerScratch> | undefined;

/** Enables weighted property-animation blending on `manager` by registering its category handler. */
export function enablePropertyAnimationBlending(manager: AnimationManager): void {
    setAnimationTaskCategoryHandler(manager, ANIMATION_GROUP_TASK_CATEGORY, _updateWeightedPointerAnimations);
}

function getScratch(manager: AnimationManager): WeightedPointerScratch {
    scratchByManager ??= new WeakMap();
    let scratch = scratchByManager.get(manager);
    if (!scratch) {
        scratch = {
            buckets: [],
            sample: new F32(16),
            afterWrites: new Set(),
        };
        scratchByManager.set(manager, scratch);
    }
    return scratch;
}

/** @internal Drive property-mixer groups, optionally leaving every other animation-group category member untouched. */
export function _updateWeightedPointerAnimations(manager: AnimationManager, deltaMs: number, onlyPropertyGroups = false): boolean {
    const scratch = getScratch(manager);
    scratch.afterWrites.clear();
    let contestedCount = 0;
    let propertyGroupCount = 0;

    for (let bucketIndex = 0; bucketIndex < scratch.buckets.length; bucketIndex++) {
        const bucket = scratch.buckets[bucketIndex]!;
        bucket.retained = false;
        bucket.contested = false;
        bucket.active = false;
        bucket.hasReference = false;
        bucket.totalWeight = 0;
        bucket.values.fill(0);
    }

    const groups = getAnimationGroups(manager);
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex]!;
        const mixer = group._propertyMixer;
        if (group._stopped || !mixer) {
            continue;
        }
        group._mixerCleanup = clearManagerScratch;
        propertyGroupCount++;
        if (group.weight === 1) {
            continue;
        }
        const tracks = mixer[MIX_TRACKS];
        for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
            const track = tracks[trackIndex]!;
            if (trackMaskedOut(group, track)) {
                continue;
            }
            const bucket = getTrackBucket(scratch.buckets, track);
            if (!bucket.contested) {
                bucket.contested = true;
                contestedCount++;
            }
        }
    }
    for (let bucketIndex = scratch.buckets.length - 1; bucketIndex >= 0; bucketIndex--) {
        if (!scratch.buckets[bucketIndex]!.retained) {
            scratch.buckets.splice(bucketIndex, 1);
        }
    }

    if (contestedCount === 0) {
        if (!onlyPropertyGroups) {
            return false;
        }
        if (onlyPropertyGroups && propertyGroupCount) {
            for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
                const group = groups[groupIndex]!;
                if (!group._stopped && group._propertyMixer) {
                    if (group.weight === 1) {
                        tickAnimationCore(group, deltaMs, manager.engine);
                    } else {
                        advancePropertyGroupTime(group, group._propertyMixer, deltaMs);
                    }
                }
            }
            return true;
        }
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
            if (!onlyPropertyGroups) {
                tickAnimationCore(group, deltaMs, manager.engine);
            }
            continue;
        }
        if (onlyPropertyGroups && group.weight === 1) {
            tickAnimationCore(group, deltaMs, manager.engine);
            continue;
        }

        const t = advancePropertyGroupTime(group, mixer, deltaMs);
        const weight = group.weight;
        if (weight === 0) {
            continue;
        }

        for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
            const track = tracks[trackIndex]!;
            if (trackMaskedOut(group, track)) {
                continue;
            }
            evaluateSampler(track.sampler, t, track.stride, track.quaternion, scratch.sample, 0);
            const bucket = getTrackBucket(scratch.buckets, track);
            if (!bucket.contested) {
                track.writer(scratch.sample, 0);
                if (track._afterWrite) {
                    scratch.afterWrites.add(track._afterWrite);
                }
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
        bucket.mix?.finish(bucket.values, bucket.totalWeight);
        bucket.writer(bucket.values, 0);
        if (bucket.afterWrite) {
            scratch.afterWrites.add(bucket.afterWrite);
        }
    }
    for (const publish of scratch.afterWrites) {
        publish();
    }

    return true;
}

function clearManagerScratch(manager: AnimationManager): void {
    scratchByManager?.delete(manager);
}

function trackMaskedOut(group: AnimationGroup, track: AnimationPropertyRuntimeTrack): boolean {
    const mask = group.mask;
    if (!mask || mask.disabled) {
        return false;
    }
    return (mask.names.indexOf(track._targetName ?? "") !== -1) !== (mask.mode === 0);
}

function advancePropertyGroupTime(group: AnimationGroup, mixer: AnimationPropertyMixer, deltaMs: number): number {
    if (group.isPlaying) {
        group.currentTime += (deltaMs / 1000) * group.speedRatio;
    }

    const clipStart = mixer[MIX_START] ?? 0;
    const clipEnd = clipStart + mixer[MIX_DURATION];
    const fromTime = Math.max(clipStart, Math.min(mixer[MIX_FROM], clipEnd));
    const toTime = mixer[MIX_TO] > fromTime ? Math.min(mixer[MIX_TO], clipEnd) : clipEnd;
    const duration = Math.max(0, toTime - fromTime);
    if (duration <= 0) {
        group.currentTime = fromTime;
        return group.currentTime;
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
            if (!!candidate.mix !== !!track._mix) {
                throw new Error("Weighted animation channels for the same property must use the same mixing strategy");
            }
            candidate.mix = track._mix;
            candidate.afterWrite = track._afterWrite;
            candidate.retained = true;
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
        mix: track._mix,
        afterWrite: track._afterWrite,
        retained: true,
        contested: false,
        active: false,
        hasReference: false,
        totalWeight: 0,
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
    if (bucket.mix) {
        bucket.mix.accumulate(bucket.values, sample, weight, bucket.totalWeight);
        bucket.totalWeight += weight;
        return;
    }

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
    bucket.totalWeight += weight;
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
