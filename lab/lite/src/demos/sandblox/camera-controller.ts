/**
 * Camera Controller — manages ArcRotateCamera for third-person view.
 *
 * Reads mouse drag, scroll, and arrow-key input each frame to orbit and zoom,
 * then snaps the camera target to the character's head height.
 */

import type { ArcRotateCamera, SceneContext } from "babylon-lite";
import { addToScene, createArcRotateCamera } from "babylon-lite";

import type { InputManager } from "./input-manager.js";

const ARROW_SPEED = 2; // rad/s
const DRAG_SENSITIVITY = 0.005; // rad/pixel
const SCROLL_SENSITIVITY = 0.005; // studs per deltaY unit (100 per notch → 0.5 studs)
const RADIUS_MIN = 1; // studs
const RADIUS_MAX = 50; // studs
const BETA_MIN = 0.1; // rad
const BETA_MAX = (Math.PI / 2) * 1.1; // rad
const TARGET_Y_OFFSET = 3; // studs above root (eye level)
const GROUND_MARGIN = 0.4; // camera keeps this far above the baseplate
const POP_RESTORE_RATE = 8; // 1/s — eased zoom-back-out when the obstruction clears

export class CameraController {
    private readonly _camera: ArcRotateCamera;
    private readonly _input: InputManager;
    /** The user's intended zoom; `camera.radius` holds the popped (effective) value. */
    private _desiredRadius: number;

    constructor(scene: SceneContext, input: InputManager) {
        const camera = createArcRotateCamera(-Math.PI / 2, 1.3, 15, { x: 0, y: 3, z: 0 });
        scene.camera = camera;
        addToScene(scene, camera);

        this._camera = camera;
        this._input = input;
        this._desiredRadius = camera.radius;

        camera.farPlane = 10000;
    }

    tick(dt: number, rootPosition: { x: number; y: number; z: number }): void {
        const cam = this._camera;

        // Arrow key rotation
        if (this._input.isArrowHeld("ArrowLeft")) {
            cam.alpha += ARROW_SPEED * dt;
        }
        if (this._input.isArrowHeld("ArrowRight")) {
            cam.alpha -= ARROW_SPEED * dt;
        }

        // Mouse drag orbit
        const { dx, dy, scroll } = this._input.getMouseDeltas();
        cam.alpha -= dx * DRAG_SENSITIVITY;
        cam.beta -= dy * DRAG_SENSITIVITY;

        // Scroll zoom adjusts the DESIRED radius; the popper below may shorten it.
        this._desiredRadius += scroll * SCROLL_SENSITIVITY;
        this._desiredRadius = Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, this._desiredRadius));
        cam.beta = Math.max(BETA_MIN, Math.min(BETA_MAX, cam.beta));

        // Track target to character head height
        cam.target.x = rootPosition.x;
        cam.target.y = rootPosition.y + TARGET_Y_OFFSET;
        cam.target.z = rootPosition.z;

        // ── Ground popper : never clip below the baseplate ────────────
        // Camera height = target.y + r·cosβ. When cosβ < 0 (camera below the
        // target) the y = GROUND_MARGIN plane caps the radius. Pull in
        // instantly (no clipping frames), ease back out when clear.
        const cosBeta = Math.cos(cam.beta);
        let maxRadius = Infinity;
        if (cosBeta < -1e-4) {
            maxRadius = (GROUND_MARGIN - cam.target.y) / cosBeta;
        }
        const limited = Math.max(RADIUS_MIN, Math.min(this._desiredRadius, maxRadius));
        if (limited < cam.radius) {
            cam.radius = limited; // obstruction: snap in
        } else {
            // Clear (or loosening): ease back toward what the user wants.
            const k = Math.min(1, POP_RESTORE_RATE * dt);
            cam.radius += (limited - cam.radius) * k;
        }
    }

    getAlpha(): number {
        return this._camera.alpha;
    }
}
