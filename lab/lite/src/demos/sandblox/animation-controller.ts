/**
 * Animation Controller — procedural clips for rest, walk, and jump states
 * with cross-fade blending.
 *
 * Defines three animation clips that target the four limb pivots, manages an
 * AnimationManager with blending, and exposes crossFadeTo(state) for smooth
 * state transitions.
 */

import type { AnimationGroup, AnimationManager, TransformNode } from "babylon-lite";
import {
    createAnimationManager,
    createPropertyAnimationClip,
    createPropertyAnimationGroup,
    crossFadeAnimationGroups,
    enablePropertyAnimationBlending,
    setAnimationWeight,
    stopAnimation,
    playAnimation,
    updateAnimationManager,
} from "babylon-lite";

import type { CharacterNodes } from "./character.js";

type PlayerState = "rest" | "walk" | "jump";

const CROSS_FADE_MS = 150;
const JUMP_CLIP_FRAMES = 5;
const JUMP_ARM_RAISE_ANGLE = -Math.PI * 0.98;

/** Quaternion for X-axis rotation by `angle` radians: (sin(θ/2), 0, 0, cos(θ/2)). */
function quatX(angle: number): readonly [number, number, number, number] {
    return [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];
}

interface HingeDriver {
    angle: number;
}

function createHingeDriver(pivot: TransformNode): HingeDriver {
    let currentAngle = 0;
    return {
        get angle() {
            return currentAngle;
        },
        set angle(nextAngle: number) {
            currentAngle = nextAngle;
            const q = quatX(nextAngle);
            pivot.rotationQuaternion.x = q[0];
            pivot.rotationQuaternion.y = q[1];
            pivot.rotationQuaternion.z = q[2];
            pivot.rotationQuaternion.w = q[3];
        },
    };
}

export class AnimationController {
    private readonly _manager: AnimationManager;
    private readonly _groups: Record<PlayerState, AnimationGroup>;
    private _currentState: PlayerState = "rest";

    constructor(character: CharacterNodes) {
        this._manager = createAnimationManager();
        enablePropertyAnimationBlending(this._manager);

        const target = {
            leftArm: createHingeDriver(character.leftArmPivot),
            rightArm: createHingeDriver(character.rightArmPivot),
            leftLeg: createHingeDriver(character.leftLegPivot),
            rightLeg: createHingeDriver(character.rightLegPivot),
        };

        // ── Rest clip (60 frames @ 30fps = 2s) — subtle idle sway ───────────
        const restClip = createPropertyAnimationClip("rest", [
            {
                path: "leftArm.angle",
                frameRate: 30,
                keys: [
                    { frame: 0, value: 0.044 },
                    { frame: 30, value: -0.044 },
                    { frame: 60, value: 0.044 },
                ],
            },
            {
                path: "rightArm.angle",
                frameRate: 30,
                keys: [
                    { frame: 0, value: -0.044 },
                    { frame: 30, value: 0.044 },
                    { frame: 60, value: -0.044 },
                ],
            },
            {
                path: "leftLeg.angle",
                frameRate: 30,
                keys: [{ frame: 0, value: 0 }],
            },
            {
                path: "rightLeg.angle",
                frameRate: 30,
                keys: [{ frame: 0, value: 0 }],
            },
        ]);

        // ── Walk clip (20 frames @ 30fps ≈ 0.67s) — alternating arm/leg swing
        const walkClip = createPropertyAnimationClip("walk", [
            {
                path: "leftArm.angle",
                frameRate: 30,
                keys: [
                    { frame: 0, value: 0 },
                    { frame: 5, value: Math.PI / 5 },
                    { frame: 15, value: -Math.PI / 5 },
                    { frame: 20, value: 0 },
                ],
            },
            {
                path: "rightArm.angle",
                frameRate: 30,
                keys: [
                    { frame: 0, value: 0 },
                    { frame: 5, value: -Math.PI / 5 },
                    { frame: 15, value: Math.PI / 5 },
                    { frame: 20, value: 0 },
                ],
            },
            {
                path: "leftLeg.angle",
                frameRate: 30,
                keys: [
                    { frame: 0, value: 0 },
                    { frame: 5, value: -Math.PI / 5 },
                    { frame: 15, value: Math.PI / 5 },
                    { frame: 20, value: 0 },
                ],
            },
            {
                path: "rightLeg.angle",
                frameRate: 30,
                keys: [
                    { frame: 0, value: 0 },
                    { frame: 5, value: Math.PI / 5 },
                    { frame: 15, value: -Math.PI / 5 },
                    { frame: 20, value: 0 },
                ],
            },
        ]);

        // ── Jump clip (~0.17s @ 30fps) — arms raised, legs tucked ───────────
        const jumpClip = createPropertyAnimationClip("jump", [
            {
                path: "leftArm.angle",
                frameRate: 30,
                keys: [
                    { frame: 0, value: 0 },
                    { frame: JUMP_CLIP_FRAMES, value: JUMP_ARM_RAISE_ANGLE },
                ],
            },
            {
                path: "rightArm.angle",
                frameRate: 30,
                keys: [
                    { frame: 0, value: 0 },
                    { frame: JUMP_CLIP_FRAMES, value: JUMP_ARM_RAISE_ANGLE },
                ],
            },
            {
                path: "leftLeg.angle",
                frameRate: 30,
                keys: [
                    { frame: 0, value: 0 },
                    { frame: JUMP_CLIP_FRAMES, value: 0 },
                ],
            },
            {
                path: "rightLeg.angle",
                frameRate: 30,
                keys: [
                    { frame: 0, value: 0 },
                    { frame: JUMP_CLIP_FRAMES, value: 0 },
                ],
            },
        ]);

        // ── Bind clips to target and create animation groups ─────────────────
        this._groups = {
            rest: createPropertyAnimationGroup(this._manager, target, restClip, { loop: true }),
            walk: createPropertyAnimationGroup(this._manager, target, walkClip, { loop: true }),
            jump: createPropertyAnimationGroup(this._manager, target, jumpClip, { loop: false }),
        };

        // All groups start playing at weight=1 by default. Stop walk/jump and
        // zero their weights so only rest is active at startup.
        stopAnimation(this._groups.walk);
        setAnimationWeight(this._groups.walk, 0);
        stopAnimation(this._groups.jump);
        setAnimationWeight(this._groups.jump, 0);
    }

    crossFadeTo(state: PlayerState): void {
        if (state === this._currentState) {
            return;
        }
        const fromGroup = this._groups[this._currentState];
        const toGroup = this._groups[state];
        if (!toGroup.loopAnimation) {
            toGroup.currentTime = 0;
        }
        playAnimation(toGroup);
        crossFadeAnimationGroups(this._manager, fromGroup, toGroup, { durationMs: CROSS_FADE_MS });
        this._currentState = state;
    }

    tick(dt: number): void {
        updateAnimationManager(this._manager, dt * 1000);
    }
}
