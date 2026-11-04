/**
 * Player Controller — composes all sub-controllers and orchestrates the
 * per-frame tick order. Implements the three-state machine (rest / walk / jump)
 * that drives animation cross-fades.
 */

import type { SceneContext } from "babylon-lite";
import { onBeforeRender } from "babylon-lite";

import { AnimationController } from "./animation-controller.js";
import type { CharacterNodes } from "./character.js";
import { CameraController } from "./camera-controller.js";
import { EventEmitter } from "./events.js";
import type { PlayerEvents } from "./events.js";
import { InputManager } from "./input-manager.js";
import { MovementController } from "./movement-controller.js";
import type { RigidBodySource } from "./physics-controller.js";
import { PhysicsController } from "./physics-controller.js";
import type { Sounds } from "./sounds.js";

type PlayerState = "rest" | "walk" | "jump";

/** Walk clip: 20 frames @ 30 fps = 0.667 s per cycle, 2 steps per cycle. */
const FOOTSTEP_INTERVAL_S = 1 / 3;

export class PlayerController {
    private readonly _events: EventEmitter<PlayerEvents>;
    private readonly _input: InputManager;
    private readonly _physics: PhysicsController;
    private readonly _camera: CameraController;
    private readonly _movement: MovementController;
    private readonly _animation: AnimationController;
    private readonly _character: CharacterNodes;
    private readonly _sounds: Sounds | null;
    private _state: PlayerState = "rest";
    private _footstepClock = 0;

    constructor(canvas: HTMLCanvasElement, character: CharacterNodes, scene: SceneContext, bodies: RigidBodySource = () => [], sounds: Sounds | null = null) {
        this._character = character;
        this._sounds = sounds;
        this._events = new EventEmitter<PlayerEvents>();
        this._input = new InputManager(canvas, this._events);
        this._camera = new CameraController(scene, this._input);
        this._physics = new PhysicsController(character.root, this._input, this._events, bodies);
        this._movement = new MovementController(character.root, this._input, this._camera, bodies);
        this._animation = new AnimationController(character);

        // ── State machine transitions ────────────────────────────────────────
        this._events.on("startedMoving", () => {
            if (this._state === "rest") {
                this._state = "walk";
                this._animation.crossFadeTo("walk");
            }
        });

        this._events.on("stoppedMoving", () => {
            if (this._state === "walk") {
                this._state = "rest";
                this._animation.crossFadeTo("rest");
            }
        });

        this._events.on("jumped", () => {
            this._sounds?.playJump();
            if (this._state === "rest" || this._state === "walk") {
                this._state = "jump";
                this._animation.crossFadeTo("jump");
            }
        });

        this._events.on("landed", () => {
            if (this._state === "jump") {
                if (this._input.isMovementKeyHeld()) {
                    this._state = "walk";
                    this._animation.crossFadeTo("walk");
                } else {
                    this._state = "rest";
                    this._animation.crossFadeTo("rest");
                }
            }
        });

        // ── Game loop ────────────────────────────────────────────────────────
        onBeforeRender(scene, (deltaMs: number) => {
            const dt = Math.min(deltaMs / 1000, 0.05);
            this._tick(dt);
        });
    }

    private _tick(dt: number): void {
        this._input.tick(dt);
        this._physics.tick(dt);
        this._movement.tick(dt);

        // Footstep cadence: classic plastic taps while walking on the ground.
        if (this._state === "walk" && this._physics.isGrounded()) {
            this._footstepClock += dt;
            if (this._footstepClock >= FOOTSTEP_INTERVAL_S) {
                this._footstepClock = 0;
                this._sounds?.playFootstep();
            }
        } else {
            this._footstepClock = FOOTSTEP_INTERVAL_S; // first step lands immediately
        }

        this._animation.tick(dt);
        this._camera.tick(dt, {
            x: this._character.root.position.x,
            y: this._character.root.position.y,
            z: this._character.root.position.z,
        });
        this._input.resetFrameDeltas();
    }

    dispose(): void {
        this._input.dispose();
        this._events.clear();
    }
}
