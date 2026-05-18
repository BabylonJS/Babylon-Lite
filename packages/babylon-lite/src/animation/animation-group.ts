// AnimationGroup — user-facing handle for a single animation clip.
// Stored on scene.animationGroups[]. Pure state interface.

import type { EngineContext } from "../engine/engine.js";
import type { AnimationChannel, AnimationSampler, GltfAnimationData } from "./types.js";
import { PATH_POINTER } from "./types.js";
import { createAnimationController } from "../skeleton/skeleton-updater.js";
import type { AnimationController } from "../skeleton/skeleton-updater.js";

const DEFAULT_FRAME_RATE = 60;

export type AnimationPropertyMixer = readonly [readonly AnimationChannel[], readonly AnimationSampler[], number, number, number];

/** User-facing animation group — one per glTF animation clip. Pure state. */
export interface AnimationGroup {
    /** Name of this animation (from glTF). */
    readonly name: string;
    /** Duration in seconds. */
    readonly duration: number;
    /** Frame rate used by goToFrame(). */
    readonly frameRate: number;
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
    if (group._ctrl) {
        group._ctrl.time = frame / group.frameRate;
        group._ctrl.playing = false;
        if (!group._ctrl.requiresEngine || engine) {
            group._ctrl.tick(0, engine, true);
        }
    }
}

/** @internal Advance animation by deltaMs. Called by the engine each frame. */
export function tickAnimation(group: AnimationGroup, deltaMs: number, engine?: EngineContext): void {
    if (group._stopped) {
        return;
    }
    if (group._ctrl) {
        group._ctrl.tick(deltaMs, engine);
    }
}

/** Create AnimationGroup(s) from parsed glTF animation data.
 *  Returns one group per animation clip. */
export function createAnimationGroups(animData: GltfAnimationData): AnimationGroup[] {
    const hasPointer = animData.clips.some((c) => c.channels.some((ch) => ch.path === PATH_POINTER));
    if (animData.clips.length === 0 || (animData.skeletons.length === 0 && animData.morphBindings.length === 0 && !hasPointer)) {
        return [];
    }

    return animData.clips.map((clip, clipIndex) => {
        const clipAnimData: GltfAnimationData = {
            clips: [clip],
            nodes: animData.nodes,
            skeletons: animData.skeletons,
            morphBindings: animData.morphBindings,
        };
        const ctrl: AnimationController = createAnimationController(clipAnimData);
        // Auto-play by default (matches Babylon.js behavior)
        ctrl.playing = true;

        const group: AnimationGroup = {
            name: clip.name || `animation_${clipIndex}`,
            duration: clip.duration,
            frameRate: clip.frameRate ?? DEFAULT_FRAME_RATE,

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
        return group;
    });
}
