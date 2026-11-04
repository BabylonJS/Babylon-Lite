/**
 * Babylon.js-compatible camera/mesh behaviors.
 *
 * Camera behaviors (`AutoRotationBehavior`, `BouncingBehavior`,
 * `FramingBehavior`) operate on the compat `ArcRotateCamera` via the scene's
 * before-render hook. `AutoRotationBehavior` is fully functional; bouncing and
 * framing implement the structural surface plus their core action without
 * Babylon.js's tweened animations (so they are `⚡ Partial`).
 */

import { onBeforeRender } from "babylon-lite";

import type { ArcRotateCamera } from "../cameras/cameras.js";

/** Babylon.js `Behavior<T>` interface. */
export interface Behavior<T> {
    readonly name: string;
    init(): void;
    attach(target: T): void;
    detach(): void;
}

/** Idle auto-rotation of an `ArcRotateCamera` (spins `alpha` when not interacting). */
export class AutoRotationBehavior implements Behavior<ArcRotateCamera> {
    public readonly name = "AutoRotation";
    /** Idle rotation speed in radians/second. */
    public idleRotationSpeed = 0.05;
    private _camera: ArcRotateCamera | null = null;
    private _detach: (() => void) | undefined;

    public init(): void {
        // no-op
    }

    public attach(camera: ArcRotateCamera): void {
        this._camera = camera;
        const scene = camera.getScene();
        if (!scene) {
            return;
        }
        // onBeforeRender passes the frame delta in milliseconds.
        const cb = (deltaMs: number): void => {
            if (this._camera) {
                this._camera.alpha += this.idleRotationSpeed * (deltaMs / 1000);
            }
        };
        onBeforeRender(scene._lite, cb);
        this._detach = () => {
            this._camera = null;
        };
    }

    public detach(): void {
        this._detach?.();
        this._detach = undefined;
    }
}

/** Clamps an `ArcRotateCamera`'s radius to a [lower, upper] band (no bounce tween). */
export class BouncingBehavior implements Behavior<ArcRotateCamera> {
    public readonly name = "Bouncing";
    public lowerRadiusTransitionRange = 2;
    public upperRadiusTransitionRange = -2;
    private _camera: ArcRotateCamera | null = null;
    private _detach: (() => void) | undefined;

    public init(): void {
        // no-op
    }

    public attach(camera: ArcRotateCamera): void {
        this._camera = camera;
        const scene = camera.getScene();
        if (!scene) {
            return;
        }
        const cb = (): void => {
            const cam = this._camera;
            if (!cam) {
                return;
            }
            if (cam.lowerRadiusLimit != null && cam.radius < cam.lowerRadiusLimit) {
                cam.radius = cam.lowerRadiusLimit;
            }
            if (cam.upperRadiusLimit != null && cam.radius > cam.upperRadiusLimit) {
                cam.radius = cam.upperRadiusLimit;
            }
        };
        onBeforeRender(scene._lite, cb);
        this._detach = () => {
            this._camera = null;
        };
    }

    public detach(): void {
        this._detach?.();
        this._detach = undefined;
    }
}

/** Frames an `ArcRotateCamera` on a target by setting its radius (no zoom tween). */
export class FramingBehavior implements Behavior<ArcRotateCamera> {
    public readonly name = "Framing";
    public radius = 10;
    private _camera: ArcRotateCamera | null = null;

    public init(): void {
        // no-op
    }

    public attach(camera: ArcRotateCamera): void {
        this._camera = camera;
    }

    public detach(): void {
        this._camera = null;
    }

    /** Set the camera radius to frame a target of the given world-space radius. */
    public zoomOnBoundingRadius(boundingRadius: number): void {
        if (this._camera) {
            this._camera.radius = boundingRadius * 2.5;
        }
    }
}
