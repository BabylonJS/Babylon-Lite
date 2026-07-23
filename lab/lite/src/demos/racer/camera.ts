/**
 * Racer camera rig — a follow camera with three switchable modes: Chase (the
 * classic boom behind the car), Hood (low and close, looking ahead), and
 * Cinematic (far, low and wide, framing the horizon and sky). Each mode is a set
 * of orbit parameters and easing rates; `cycle()` eases smoothly between them.
 */

import type { ArcRotateCamera, SceneContext } from "babylon-lite";
import { addToScene, createArcRotateCamera } from "babylon-lite";

type CameraModeName = "Chase" | "Hood" | "Cinematic";

interface CamMode {
    readonly name: CameraModeName;
    /** Elevation from +Y — larger is lower / more horizontal, so more sky is in frame. */
    readonly beta: number;
    readonly radiusMin: number; // distance at rest
    readonly radiusMax: number; // distance at full speed
    readonly targetY: number; // aim height above the road
    readonly lookAhead: number; // shift the aim point ahead of the car (hood view)
    readonly fov: number;
    readonly posEase: number; // target-follow rate
    readonly turnEase: number; // swing-behind rate
    readonly settleEase: number; // beta / radius / fov ease rate
}

const MODES: readonly CamMode[] = [
    { name: "Chase", beta: 1.02, radiusMin: 9, radiusMax: 15, targetY: 1.1, lookAhead: 0, fov: 0.7, posEase: 5, turnEase: 3, settleEase: 1.5 },
    { name: "Hood", beta: 1.4, radiusMin: 3.5, radiusMax: 4, targetY: 0.7, lookAhead: 6, fov: 0.92, posEase: 16, turnEase: 10, settleEase: 5 },
    { name: "Cinematic", beta: 1.2, radiusMin: 14, radiusMax: 17, targetY: 1.5, lookAhead: 0, fov: 0.85, posEase: 4, turnEase: 2.5, settleEase: 1.4 },
];

const FOV_KICK = 0.12; // extra FOV blended in at full speed for a rush-of-speed feel

/** ArcRotate alpha that places the camera directly behind a forward vector.
 *  Camera horizontal offset from target is (cosα, sinα) in (x, z); to sit behind
 *  the car it must point opposite the forward vector. */
function trailingAlpha(fx: number, fz: number): number {
    return Math.atan2(-fz, -fx);
}

/** Ease `from` toward `to` along the shortest angular arc. */
function easeAngle(from: number, to: number, t: number): number {
    let d = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) {
        d += Math.PI * 2;
    }
    return from + d * Math.min(1, t);
}

export class CameraRig {
    private readonly _camera: ArcRotateCamera;
    private _mode: number;
    private _tx: number;
    private _ty: number;
    private _tz: number;
    private _alpha: number;
    private _beta: number;
    private readonly _label: HTMLElement;

    constructor(scene: SceneContext, start: { x: number; y: number; z: number }, forward: { x: number; z: number }, initialMode: CameraModeName = "Chase") {
        this._mode = MODES.findIndex((mode) => mode.name === initialMode);
        if (this._mode < 0) {
            this._mode = 0;
        }
        const m = MODES[this._mode]!;
        this._tx = start.x;
        this._ty = start.y + m.targetY;
        this._tz = start.z;
        this._alpha = trailingAlpha(forward.x, forward.z);
        this._beta = m.beta;
        const camera = createArcRotateCamera(this._alpha, m.beta, m.radiusMin, { x: start.x, y: start.y + m.targetY, z: start.z });
        camera.fov = m.fov;
        camera.nearPlane = 0.5;
        camera.farPlane = 400;
        scene.camera = camera;
        addToScene(scene, camera);
        this._camera = camera;
        this._label = this._buildLabel(m.name);
    }

    /** Switch to the next camera mode (Chase → Hood → Cinematic → …). */
    cycle(): void {
        this._mode = (this._mode + 1) % MODES.length;
        this._label.textContent = `CAM · ${MODES[this._mode]!.name}`;
    }

    tick(dt: number, car: { x: number; y: number; z: number }, speed: number, forward: { x: number; z: number }): void {
        const cam = this._camera;
        const m = MODES[this._mode]!;

        // Aim point: the car, optionally shifted ahead (hood view), eased.
        const aimX = car.x + forward.x * m.lookAhead;
        const aimZ = car.z + forward.z * m.lookAhead;
        const k = Math.min(1, m.posEase * dt);
        this._tx += (aimX - this._tx) * k;
        this._tz += (aimZ - this._tz) * k;
        // Track height more slowly than the horizontal follow so a quick bump-hop
        // lets the car bob within the frame instead of throwing the boom up (which
        // would otherwise punch the trailing camera through low scenery like the arch).
        const ky = Math.min(1, m.posEase * 0.4 * dt);
        this._ty += (car.y + m.targetY - this._ty) * ky;
        cam.target.x = this._tx;
        cam.target.y = this._ty;
        cam.target.z = this._tz;

        // Swing behind the heading.
        this._alpha = easeAngle(this._alpha, trailingAlpha(forward.x, forward.z), m.turnEase * dt);
        cam.alpha = this._alpha;

        // Ease elevation, distance (speed-scaled) and FOV toward the current mode.
        const s = Math.min(1, m.settleEase * dt);
        this._beta += (m.beta - this._beta) * s;
        cam.beta = this._beta;
        const desiredRadius = m.radiusMin + (m.radiusMax - m.radiusMin) * Math.min(1, Math.abs(speed));
        cam.radius += (desiredRadius - cam.radius) * s;
        const desiredFov = m.fov + FOV_KICK * Math.min(1, Math.abs(speed));
        cam.fov += (desiredFov - cam.fov) * s;
    }

    private _buildLabel(initialMode: CameraModeName): HTMLElement {
        const el = document.createElement("div");
        el.className = "racer-camera-label";
        el.textContent = `CAM · ${initialMode}`;
        el.style.cssText =
            "position:fixed;right:12px;bottom:16px;z-index:10;padding:5px 12px;border-radius:999px;background:rgba(0,0,0,0.45);color:#fff;backdrop-filter:blur(3px);font:600 12px system-ui,sans-serif;letter-spacing:0.03em;";
        document.body.appendChild(el);
        return el;
    }
}
