// AnimationGroup — user-facing handle for a single animation clip.
// Stored on scene.animationGroups[]. Pure state interface.

import type { EngineContext } from "../engine/engine.js";
import type { AnimationChannel, AnimationClip, AnimationSampler, GltfAnimationData, NodeRest, SkeletonBinding } from "./types.js";
import { PATH_POINTER } from "./types.js";
import { createAnimationController } from "../skeleton/skeleton-updater.js";
import type { AnimationController } from "../skeleton/skeleton-updater.js";

export type AnimationPropertyMixer = readonly [readonly AnimationChannel[], readonly AnimationSampler[], number, number, number];
export type AnimationGltfMixer = readonly [AnimationClip, readonly NodeRest[], readonly SkeletonBinding[]];
export interface AnimationAdditiveMixer {
    readonly referenceTime: number;
}

/** User-facing animation group — one per glTF animation clip. Pure state. */
export interface AnimationGroup {
    /** Name of this animation (from glTF). */
    readonly name: string;
    /** Duration in seconds. */
    readonly duration: number;
    /** Frame rate used by goToFrame(). */
    readonly frameRate?: number;
    /** True if currently playing. */
    readonly isPlaying: boolean;
    /** Current playback time in seconds. */
    currentFrame: number;
    /** Playback speed multiplier (default 1). */
    speedRatio: number;
    /** Whether animation loops (default true). */
    loopAnimation: boolean;
    /** Weighted contribution used by AnimationManager mixing (default 1). */
    weight: number;
    /** Debug: internal animation controller. */
    readonly _ctrl?: AnimationController;
    /** @internal Manual property animation metadata used by the optional weighted mixer. */
    _pm?: AnimationPropertyMixer;
    /** @internal glTF skeleton metadata used by the optional weighted mixer. */
    _gm?: AnimationGltfMixer;
    /** @internal Additive animation metadata used by the optional blending mixer. */
    _am?: AnimationAdditiveMixer;
    /** @internal Whether stop() was called (suppresses _tick). */
    _stopped: boolean;
}

/** Start playing an animation group. */
export function playAnimation(group: AnimationGroup): void {
    if (group._ctrl) {
        group._ctrl.playing = true;
    }
    group._stopped = false;
}

/** Pause playback of an animation group. */
export function pauseAnimation(group: AnimationGroup): void {
    if (group._ctrl) {
        group._ctrl.playing = false;
    }
}

/** Stop playback and reset to frame 0. */
export function stopAnimation(group: AnimationGroup): void {
    if (group._ctrl) {
        group._ctrl.playing = false;
        group._ctrl.time = 0;
    }
    group._stopped = true;
}

/** Seek to a specific frame, apply the pose, and pause. */
export function goToFrame(group: AnimationGroup, frame: number, engine?: EngineContext): void {
    const ctrl = group._ctrl;
    if (ctrl) {
        ctrl.time = frame / (group.frameRate || 60);
        ctrl.playing = false;
        if (engine || !group._stopped || !group._gm) {
            ctrl.tick(0, engine);
        }
    }
}

/** @internal Advance animation by deltaMs. Called by the engine each frame. */
export function tickAnimation(group: AnimationGroup, deltaMs: number, engine?: EngineContext): void {
    if (!group._stopped && group._ctrl) {
        group._ctrl.tick(deltaMs, engine);
    }
}

/** Create AnimationGroup(s) from parsed glTF animation data.
 *  Returns one group per animation clip. */
export function createAnimationGroups(animData: GltfAnimationData): AnimationGroup[] {
    const { clips, nodes, skeletons, morphBindings } = animData;
    const hasPointer = clips.some((c) => c.channels.some((ch) => ch.path === PATH_POINTER));
    if (clips.length === 0 || (skeletons.length === 0 && morphBindings.length === 0 && !hasPointer)) {
        return [];
    }

    return clips.map((clip, clipIndex) => {
        const ctrl: AnimationController = createAnimationController(clip, nodes, skeletons, morphBindings);
        // Auto-play by default (matches Babylon.js behavior)
        ctrl.playing = true;

        const group: AnimationGroup = {
            name: clip.name || `animation_${clipIndex}`,
            duration: clip.duration,

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
        if (skeletons[0]) {
            group._gm = [clip, nodes, skeletons];
        }
        return group;
    });
}
