/**
 * Babylon.js-compatible camera classes implemented over the Babylon Lite camera
 * factories.
 *
 * Babylon.js cameras take the scene in their constructor and become the active
 * camera; these wrappers do the same by assigning `scene.activeCamera` when a
 * scene is supplied. `attachControl()` is a method here (Lite separates it into
 * standalone functions) and returns the detach handle Lite already provides.
 */

import {
    createArcRotateCamera,
    createFreeCamera,
    createGeospatialCamera,
    setGeospatialOrientation,
    attachGeospatialControls,
    attachControl as liteAttachControl,
    attachFreeControl,
    getCameraPosition,
    getViewMatrix as liteGetViewMatrix,
    getProjectionMatrix as liteGetProjectionMatrix,
    onBeforeRender,
} from "babylon-lite";
import type { ArcRotateCamera as LiteArcRotateCamera, FreeCamera as LiteFreeCamera, GeospatialCamera as LiteGeospatialCamera, Camera as LiteCamera } from "babylon-lite";

import { unsupported } from "../error.js";
import { Vector3 } from "../math/vector.js";
import { Matrix } from "../math/matrix.js";
import { Node } from "../node/node.js";
import type { Scene } from "../scene/scene.js";

/** Babylon.js `Camera` — base class for all cameras (derives from `Node`). */
export abstract class Camera extends Node {
    /** @internal Underlying Babylon Lite camera. */
    public abstract readonly _lite: LiteCamera;
    private _detach: (() => void) | undefined;

    protected constructor(name: string, scene?: Scene) {
        super(name, scene);
        scene?._registerCamera(this);
    }

    public override getClassName(): string {
        return "Camera";
    }

    public get fov(): number {
        return this._lite.fov;
    }
    public set fov(value: number) {
        this._lite.fov = value;
    }

    public get minZ(): number {
        return this._lite.nearPlane;
    }
    public set minZ(value: number) {
        this._lite.nearPlane = value;
    }

    public get maxZ(): number {
        return this._lite.farPlane;
    }
    public set maxZ(value: number) {
        this._lite.farPlane = value;
    }

    /** World-space position of the camera. */
    public get globalPosition(): Vector3 {
        const p = getCameraPosition(this._lite);
        return new Vector3(p.x, p.y, p.z);
    }

    /** Babylon.js `camera.getViewMatrix()` — the camera's view matrix. */
    public getViewMatrix(): Matrix {
        return Matrix.FromArray(liteGetViewMatrix(this._lite));
    }

    /** Babylon.js `camera.getProjectionMatrix()` — the camera's projection matrix. */
    public getProjectionMatrix(): Matrix {
        return Matrix.FromArray(liteGetProjectionMatrix(this._lite, this._aspectRatio()));
    }

    private _aspectRatio(): number {
        const scene = this._scene;
        const canvas = scene?.getEngine().getRenderingCanvas() as { width?: number; height?: number } | undefined;
        const w = canvas?.width ?? 1;
        const h = canvas?.height ?? 1;
        return h !== 0 ? w / h : 1;
    }

    public abstract attachControl(canvas: HTMLCanvasElement, noPreventDefault?: boolean): void;

    public detachControl(): void {
        if (this._detach) {
            this._detach();
            this._detach = undefined;
        }
    }

    /** @internal Store the detach handle returned by Lite's attach function. */
    protected _setDetach(detach: () => void): void {
        this._detach = detach;
    }

    protected _makeActive(scene: Scene | undefined): void {
        // Babylon.js sets `scene.activeCamera` to the **first** camera constructed
        // against a scene; later cameras are added but do not steal the active
        // slot (e.g. a `CameraGizmo`'s subject camera must not become the view).
        if (scene && !scene.activeCamera) {
            scene.activeCamera = this;
        }
    }
}

export class ArcRotateCamera extends Camera {
    /** @internal Underlying Babylon Lite arc-rotate camera. */
    public readonly _lite: LiteArcRotateCamera;

    public constructor(name: string, alpha: number, beta: number, radius: number, target: Vector3, scene?: Scene);
    // Internal overload (used by `_adopt`): adopt an already-built Lite arc-rotate
    // camera (e.g. from `createDefaultCamera`) instead of creating a new one.
    public constructor(name: string, alpha: number, beta: number, radius: number, target: Vector3, scene: Scene | undefined, adoptLite: LiteArcRotateCamera);
    public constructor(name: string, alpha: number, beta: number, radius: number, target: Vector3, scene?: Scene, adoptLite?: LiteArcRotateCamera) {
        super(name, scene);
        this._lite = adoptLite ?? createArcRotateCamera(alpha, beta, radius, { x: target.x, y: target.y, z: target.z });
        if (!adoptLite) {
            this._makeActive(scene);
        }
    }

    public override getClassName(): string {
        return "ArcRotateCamera";
    }

    public get alpha(): number {
        return this._lite.alpha;
    }
    public set alpha(value: number) {
        this._lite.alpha = value;
    }

    public get beta(): number {
        return this._lite.beta;
    }
    public set beta(value: number) {
        this._lite.beta = value;
    }

    public get radius(): number {
        return this._lite.radius;
    }
    public set radius(value: number) {
        this._lite.radius = value;
    }

    public get target(): Vector3 {
        const t = this._lite.target;
        return new Vector3(t.x, t.y, t.z);
    }
    public set target(value: Vector3) {
        this._lite.target = { x: value.x, y: value.y, z: value.z };
    }

    /** Babylon.js `setTarget` — point the arc-rotate camera at a world-space target. */
    public setTarget(target: Vector3): void {
        this.target = target;
    }

    public get lowerRadiusLimit(): number | undefined {
        return this._lite.lowerRadiusLimit;
    }
    public set lowerRadiusLimit(value: number | undefined) {
        this._lite.lowerRadiusLimit = value;
    }

    public get upperRadiusLimit(): number | undefined {
        return this._lite.upperRadiusLimit;
    }
    public set upperRadiusLimit(value: number | undefined) {
        this._lite.upperRadiusLimit = value;
    }

    public attachControl(canvas: HTMLCanvasElement, _noPreventDefault?: boolean): void {
        const detach = liteAttachControl(this._lite, canvas, this._scene?._lite);
        this._setDetach(detach);
    }

    /** @internal Wrap an already-built Lite arc-rotate camera (e.g. from `createDefaultCamera`). */
    public static _adopt(name: string, lite: LiteArcRotateCamera, scene?: Scene): ArcRotateCamera {
        return new ArcRotateCamera(name, lite.alpha, lite.beta, lite.radius, new Vector3(lite.target.x, lite.target.y, lite.target.z), scene, lite);
    }
}

/**
 * Babylon.js `TargetCamera` — a free-moving camera with a look-at target. Base
 * for `FreeCamera`/`UniversalCamera`/`TouchCamera`/`FlyCamera`/`FollowCamera`.
 */
export class TargetCamera extends Camera {
    /** @internal Underlying Babylon Lite free camera. */
    public readonly _lite: LiteFreeCamera;

    public constructor(name: string, position: Vector3, scene?: Scene);
    // Internal overload (used by `_adopt`): adopt an already-built Lite free
    // camera (e.g. one parsed from a `.babylon` file) instead of creating a new one.
    public constructor(name: string, position: Vector3, scene: Scene | undefined, adoptLite: LiteFreeCamera);
    public constructor(name: string, position: Vector3, scene?: Scene, adoptLite?: LiteFreeCamera) {
        super(name, scene);
        this._lite = adoptLite ?? createFreeCamera({ x: position.x, y: position.y, z: position.z }, { x: position.x, y: position.y, z: position.z - 1 });
        this._makeActive(scene);
    }

    public override getClassName(): string {
        return "TargetCamera";
    }

    public get position(): Vector3 {
        const p = this._lite.position;
        return new Vector3(p.x, p.y, p.z);
    }
    public set position(value: Vector3) {
        this._lite.position.set(value.x, value.y, value.z);
    }

    public get speed(): number {
        return this._lite.speed;
    }
    public set speed(value: number) {
        this._lite.speed = value;
    }

    /** Babylon.js `setTarget` — aim the camera at a world-space point. */
    public setTarget(target: Vector3): void {
        this._lite.target.set(target.x, target.y, target.z);
    }

    public attachControl(canvas: HTMLCanvasElement, _noPreventDefault?: boolean): void {
        const detach = attachFreeControl(this._lite, canvas, this._scene?._lite);
        this._setDetach(detach);
    }
}

/** Babylon.js `FreeCamera` — keyboard/mouse free camera. */
export class FreeCamera extends TargetCamera {
    public override getClassName(): string {
        return "FreeCamera";
    }

    /** @internal Wrap an already-built Lite free camera (e.g. one parsed from a `.babylon` file). */
    public static _adopt(name: string, lite: LiteFreeCamera, scene?: Scene): FreeCamera {
        const p = lite.position;
        return new FreeCamera(name, new Vector3(p.x, p.y, p.z), scene, lite);
    }
}

/** Babylon.js `UniversalCamera` — touch-friendly free camera. */
export class UniversalCamera extends FreeCamera {
    public override getClassName(): string {
        return "UniversalCamera";
    }
}

/** Babylon.js `TouchCamera` — touch-controlled free camera. */
export class TouchCamera extends FreeCamera {
    public override getClassName(): string {
        return "TouchCamera";
    }
}

/** Babylon.js `GamepadCamera` — gamepad-controlled free camera. */
export class GamepadCamera extends UniversalCamera {
    public override getClassName(): string {
        return "GamepadCamera";
    }
}

/** Babylon.js `FlyCamera` — 6-DOF free-flight camera. */
export class FlyCamera extends TargetCamera {
    public override getClassName(): string {
        return "FlyCamera";
    }
}

interface LockedTarget {
    position: { x: number; y: number; z: number };
}

/**
 * Babylon.js `FollowCamera` — follows a `lockedTarget` at a fixed radius /
 * height / rotation offset, updated each frame via the scene's before-render hook.
 */
export class FollowCamera extends TargetCamera {
    public lockedTarget: LockedTarget | null = null;
    public radius = 12;
    public heightOffset = 4;
    /** Rotation offset around the target, in degrees. */
    public rotationOffset = 0;

    public constructor(name: string, position: Vector3, scene?: Scene, lockedTarget?: LockedTarget) {
        super(name, position, scene);
        this.lockedTarget = lockedTarget ?? null;
        if (scene) {
            onBeforeRender(scene._lite, () => this._follow());
        }
    }

    public override getClassName(): string {
        return "FollowCamera";
    }

    private _follow(): void {
        const target = this.lockedTarget;
        if (!target) {
            return;
        }
        const radians = (this.rotationOffset * Math.PI) / 180;
        const x = target.position.x + this.radius * Math.sin(radians);
        const z = target.position.z + this.radius * Math.cos(radians);
        const y = target.position.y + this.heightOffset;
        this._lite.position.set(x, y, z);
        this.setTarget(new Vector3(target.position.x, target.position.y, target.position.z));
    }
}

/**
 * Babylon.js `GeospatialCamera` — globe-orbit camera anchored to a surface
 * `center` (ECEF), orbiting at `radius` with `yaw`/`pitch`. Wraps Babylon Lite's
 * `createGeospatialCamera` + `setGeospatialOrientation` (which clamps pitch
 * against the effective max for the current radius, so each orientation field is
 * applied through Lite with the others left at their current values).
 */
export class GeospatialCamera extends Camera {
    /** @internal Underlying Babylon Lite geospatial camera. */
    public readonly _lite: LiteGeospatialCamera;

    public constructor(name: string, scene?: Scene, options?: { planetRadius: number }) {
        super(name, scene);
        this._lite = createGeospatialCamera({ planetRadius: options?.planetRadius ?? 1 });
        this._makeActive(scene);
    }

    public override getClassName(): string {
        return "GeospatialCamera";
    }

    /** Anchored surface point the camera orbits (ECEF coordinates). */
    public get center(): Vector3 {
        const c = this._lite.center;
        return new Vector3(c.x, c.y, c.z);
    }
    public set center(value: Vector3) {
        setGeospatialOrientation(this._lite, { center: { x: value.x, y: value.y, z: value.z } });
    }

    /** Distance from the camera to its centre point. */
    public get radius(): number {
        return this._lite.radius;
    }
    public set radius(value: number) {
        setGeospatialOrientation(this._lite, { radius: value });
    }

    /** Yaw about the geocentric up axis (0 = north, π/2 = east). */
    public get yaw(): number {
        return this._lite.yaw;
    }
    public set yaw(value: number) {
        setGeospatialOrientation(this._lite, { yaw: value });
    }

    /** Pitch from looking straight down (0) to the horizon (π/2). */
    public get pitch(): number {
        return this._lite.pitch;
    }
    public set pitch(value: number) {
        setGeospatialOrientation(this._lite, { pitch: value });
    }

    public attachControl(canvas: HTMLCanvasElement, _noPreventDefault?: boolean): void {
        if (this._scene) {
            const detach = attachGeospatialControls(this._lite, canvas, this._scene._lite);
            this._setDetach(detach);
        }
    }
}

/** Babylon.js `DeviceOrientationCamera` — device-orientation input is not available in Babylon Lite. */
export class DeviceOrientationCamera {
    public constructor() {
        unsupported("DeviceOrientationCamera", "Device-orientation input is not part of Babylon Lite.");
    }
}

/** Babylon.js `WebXRCamera` — WebXR is not part of Babylon Lite. */
export class WebXRCamera {
    public constructor() {
        unsupported("WebXRCamera", "WebXR is not part of Babylon Lite.");
    }
}

/** Babylon.js `AnaglyphArcRotateCamera` — stereoscopic camera rigs are not implemented in Babylon Lite. */
export class AnaglyphArcRotateCamera {
    public constructor() {
        unsupported("AnaglyphArcRotateCamera", "Stereoscopic camera rigs are not implemented in Babylon Lite. (An anaglyph post-process exists separately.)");
    }
}
