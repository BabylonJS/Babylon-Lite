import type { GeospatialCamera } from "./geospatial-camera.js";
import { normalizeRadians } from "./geospatial-camera.js";
import type { SceneContext } from "./../scene/scene-core.js";
import type { Vec3 } from "../math/types.js";

/** Options for {@link flyGeospatialCameraToAsync}. Omitted target fields keep their current value. */
export interface GeospatialFlyOptions {
    /** Target yaw (radians). Shortest angular path is taken. */
    yaw?: number;
    /** Target pitch (radians). */
    pitch?: number;
    /** Target radius. */
    radius?: number;
    /** Target centre (ECEF). Animated along a great-circle (slerp). */
    center?: Vec3;
    /** Flight duration in ms. Default 1000. */
    durationMs?: number;
    /** Parabolic "hop" height scale for the centre animation (0 = none). */
    centerHopScale?: number;
    /** Easing applied to the normalized progress `g` ∈ [0,1]. Default cubic ease-in-out. */
    ease?: (g: number) => number;
}

/** Cubic ease-in-out (matches Babylon.js `CubicEase` with `EASINGMODE_EASEINOUT`). */
function easeInOut(g: number): number {
    if (g >= 0.5) {
        const f = 2 * (1 - g);
        return (1 - f * f * f) * 0.5 + 0.5;
    }
    const f = 2 * g;
    return f * f * f * 0.5;
}

/** Spherical interpolation of two ECEF positions (great-circle direction + lerped magnitude). */
function slerpEcef(a: Vec3, b: Vec3, t: number, out: Vec3): void {
    const la = Math.hypot(a.x, a.y, a.z) || 1;
    const lb = Math.hypot(b.x, b.y, b.z) || 1;
    const ax = a.x / la;
    const ay = a.y / la;
    const az = a.z / la;
    const bx = b.x / lb;
    const by = b.y / lb;
    const bz = b.z / lb;
    let dot = ax * bx + ay * by + az * bz;
    dot = dot < -1 ? -1 : dot > 1 ? 1 : dot;
    const theta = Math.acos(dot) * t;
    // rel = normalize(b - a*dot)
    let rx = bx - ax * dot;
    let ry = by - ay * dot;
    let rz = bz - az * dot;
    const rlen = Math.hypot(rx, ry, rz);
    if (rlen > 1e-9) {
        rx /= rlen;
        ry /= rlen;
        rz /= rlen;
    }
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const len = la + (lb - la) * t;
    out.x = (ax * ct + rx * st) * len;
    out.y = (ay * ct + ry * st) * len;
    out.z = (az * ct + rz * st) * len;
}

/**
 * Smoothly animate a {@link GeospatialCamera} to new yaw/pitch/radius/centre over
 * `durationMs`, driven by the scene's render loop. Yaw takes the shortest angular
 * path; the centre follows a great-circle (with an optional parabolic hop).
 *
 * The returned promise resolves when the flight completes; it also resolves early
 * if the flight is interrupted (by user input through `attachGeospatialControls`,
 * or by a subsequent `flyGeospatialCameraToAsync` call). Only one flight runs at a time.
 */
export function flyGeospatialCameraToAsync(camera: GeospatialCamera, scene: SceneContext, options: GeospatialFlyOptions): Promise<void> {
    // Interrupt any in-flight animation.
    camera._cancelFly?.();

    const duration = Math.max(1, options.durationMs ?? 1000);
    const hopScale = options.centerHopScale ?? 0;
    const ease = options.ease ?? easeInOut;

    const yaw0 = camera.yaw;
    const pitch0 = camera.pitch;
    const radius0 = camera.radius;
    const center0: Vec3 = { x: camera.center.x, y: camera.center.y, z: camera.center.z };

    const targetYaw = options.yaw !== undefined ? yaw0 + normalizeRadians(normalizeRadians(options.yaw) - yaw0) : yaw0;
    const targetPitch = options.pitch !== undefined ? normalizeRadians(options.pitch) : pitch0;
    const targetRadius = options.radius ?? radius0;
    const animateCenter = options.center !== undefined;
    const targetCenter: Vec3 = animateCenter ? { x: options.center!.x, y: options.center!.y, z: options.center!.z } : center0;
    const startToEndDist = Math.hypot(targetCenter.x - center0.x, targetCenter.y - center0.y, targetCenter.z - center0.z);

    const centerScratch: Vec3 = { x: 0, y: 0, z: 0 };
    let elapsed = 0;

    return new Promise<void>((resolve) => {
        const driver = (deltaMs: number): void => {
            elapsed += deltaMs > 0 ? deltaMs : 1000 / 60;
            const g = Math.min(1, elapsed / duration);
            // Force the final frame to land exactly on the target even if the easing curve
            // does not satisfy ease(1) === 1, so the flight never resolves short of its goal.
            const e = g >= 1 ? 1 : ease(g);

            const yaw = yaw0 + (targetYaw - yaw0) * e;
            const pitch = pitch0 + (targetPitch - pitch0) * e;
            const radius = radius0 + (targetRadius - radius0) * e;

            let center: Vec3 = center0;
            if (animateCenter) {
                slerpEcef(center0, targetCenter, e, centerScratch);
                if (hopScale > 0) {
                    const hopPeak = hopScale * startToEndDist;
                    const hop = hopPeak * Math.max(0, (e * e - e) / -0.25);
                    const clen = Math.hypot(centerScratch.x, centerScratch.y, centerScratch.z) || 1;
                    const k = 1 + hop / clen;
                    centerScratch.x *= k;
                    centerScratch.y *= k;
                    centerScratch.z *= k;
                }
                center = centerScratch;
            }

            camera._setOrientation(yaw, pitch, radius, center);

            if (g >= 1) {
                finish();
            }
        };

        function finish(): void {
            const idx = scene._beforeRender.indexOf(driver);
            if (idx >= 0) {
                scene._beforeRender.splice(idx, 1);
            }
            if (camera._cancelFly === finish) {
                camera._cancelFly = undefined;
            }
            resolve();
        }

        camera._cancelFly = finish;
        scene._beforeRender.push(driver);
    });
}
