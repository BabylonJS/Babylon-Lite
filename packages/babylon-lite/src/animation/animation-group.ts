// AnimationGroup — user-facing handle for a single animation clip.
// Stored on scene.animationGroups[]. Pure state interface.

import type { EngineContext } from "../engine/engine.js";
import type { AnimationClip, AnimationSampler, GltfAnimationData, NodeRest, SkeletonBinding } from "./types.js";
import type { AnimationGroupMask } from "./animation-group-mask.js";
import { PATH_POINTER, PATH_TRANSLATION, PATH_ROTATION, PATH_SCALE } from "./types.js";
import { createAnimationController } from "../skeleton/skeleton-updater.js";
import type { AnimationController } from "../skeleton/skeleton-updater.js";

const DEFAULT_FRAME_RATE = 60;

export interface AnimationPropertyRuntimeTrack {
    readonly sampler: AnimationSampler;
    readonly stride: number;
    readonly quaternion: boolean;
    readonly writer: (output: Float32Array, offset: number) => void;
    readonly mixTarget: object;
    readonly mixProperty: string;
}
export type AnimationPropertyMixer = readonly [readonly AnimationPropertyRuntimeTrack[], number, number, number];
export type AnimationGltfMixer = readonly [AnimationClip, readonly NodeRest[], readonly SkeletonBinding[]];
export interface AnimationAdditiveMixer {
    readonly referenceTime: number;
}

/** User-facing animation group — one per animation clip. Pure state. */
export interface AnimationGroup {
    /** Name of this animation. */
    readonly name: string;
    /** Duration in seconds. */
    readonly duration: number;
    /** Frame rate used by goToFrame(). */
    readonly frameRate?: number;
    /** True if currently playing. */
    isPlaying: boolean;
    /** Current playback time in seconds. */
    currentFrame: number;
    /** Playback speed multiplier (default 1). */
    speedRatio: number;
    /** Whether animation loops (default true). */
    loopAnimation: boolean;
    /** Weighted contribution used by AnimationManager mixing (default 1). */
    weight: number;
    /** Optional include/exclude target-name mask. When set, only targets the mask retains
     *  animate; masked-out targets stay at their bind/rest pose. Matched by glTF node /
     *  bone name. See {@link createAnimationGroupMask}. To update an active mask, change
     *  its `mode`/`disabled`, replace its `names` array, or reassign `group.mask`;
     *  in-place same-length edits of `names` are not picked up. */
    mask?: AnimationGroupMask;
    /** @internal Debug: internal animation controller. */
    readonly _ctrl?: AnimationController;
    /** @internal Manual property animation metadata used by the optional weighted mixer. */
    _propertyMixer?: AnimationPropertyMixer;
    /** @internal glTF skeleton metadata used by the optional weighted mixer. */
    _gltfMixer?: AnimationGltfMixer;
    /** @internal Additive animation metadata used by the optional blending mixer. */
    _additive?: AnimationAdditiveMixer;
    /** @internal Whether stop() was called (suppresses tickAnimation). */
    _stopped: boolean;
}

/** Start playing an animation group. */
export function playAnimation(group: AnimationGroup): void {
    group.isPlaying = true;
    group._stopped = false;
}

/** Pause playback of an animation group. */
export function pauseAnimation(group: AnimationGroup): void {
    group.isPlaying = false;
}

/** Stop playback and reset to frame 0. */
export function stopAnimation(group: AnimationGroup): void {
    group.isPlaying = false;
    group.currentFrame = 0;
    group._stopped = true;
}

/** Seek to a specific frame, apply the pose, and pause. */
export function goToFrame(group: AnimationGroup, frame: number, engine?: EngineContext): void {
    const ctrl = group._ctrl;
    group.currentFrame = frame / (group.frameRate || DEFAULT_FRAME_RATE);
    group.isPlaying = false;
    if (ctrl) {
        syncControllerFromGroup(group, ctrl);
        if (engine || !group._stopped || !group._gltfMixer) {
            ctrl.tick(0, engine);
            group.currentFrame = ctrl.time;
        }
    }
}

/** @internal Advance animation by deltaMs. Called by the engine each frame. */
export function tickAnimation(group: AnimationGroup, deltaMs: number, engine?: EngineContext): void {
    if (!group._stopped && group._ctrl) {
        syncControllerFromGroup(group, group._ctrl);
        group._ctrl.tick(deltaMs, engine);
        group.currentFrame = group._ctrl.time;
    }
}

function syncControllerFromGroup(group: AnimationGroup, ctrl: AnimationController): void {
    ctrl.time = group.currentFrame;
    ctrl.playing = group.isPlaying;
    ctrl.speedRatio = group.speedRatio;
    ctrl.loop = group.loopAnimation;
    ctrl._setMask?.(group.mask ?? null);
}

/** Create AnimationGroup(s) from parsed glTF animation data.
 *  Returns one group per animation clip. */
export function createAnimationGroups(animData: GltfAnimationData): AnimationGroup[] {
    const { clips, nodes, skeletons, morphBindings, nodeTargets, excludedNodeIndices, nodeNames, boneOverrides } = animData;
    const hasPointer = clips.some((c) => c.channels.some((ch) => ch.path === PATH_POINTER));
    const hasNodeWriteback = clips.some((c) =>
        c.channels.some(
            (ch) =>
                (ch.path === PATH_TRANSLATION || ch.path === PATH_ROTATION || ch.path === PATH_SCALE) &&
                ch.nodeIdx >= 0 &&
                !excludedNodeIndices.has(ch.nodeIdx) &&
                !!nodeTargets[ch.nodeIdx]
        )
    );
    if (clips.length === 0 || (skeletons.length === 0 && morphBindings.length === 0 && !hasPointer && !hasNodeWriteback)) {
        return [];
    }

    return clips.map((clip, clipIndex) => {
        const ctrl: AnimationController = createAnimationController(clip, nodes, skeletons, morphBindings, nodeTargets, excludedNodeIndices, boneOverrides, nodeNames);
        const group: AnimationGroup = {
            name: clip.name || `animation_${clipIndex}`,
            duration: clip.duration,
            frameRate: clip.frameRate || DEFAULT_FRAME_RATE,
            isPlaying: true,
            currentFrame: 0,
            speedRatio: 1,
            loopAnimation: true,
            weight: 1,
            _ctrl: ctrl,
            _stopped: false,
        };
        if (skeletons[0]) {
            group._gltfMixer = [clip, nodes, skeletons];
        }
        return group;
    });
}
