/**
 * Axis-locked billboard — sprites locked to an arbitrary normalized world axis.
 *
 * Quad basis: the locked axis is `up`, and `right` is built from the
 * camera-projected direction perpendicular to that axis. Passing `[0,1,0]` is
 * functionally equivalent to the yaw-locked variant, but each variant has its
 * own pipeline + UBO so there is no per-frame branch.
 *
 * The axis lives in this system's `AxisLockedBillboardSystemUBO` — it is
 * **not** per-sprite — and replaces the per-layer `SpriteLayerUBO` at
 * `@group(1) @binding(2)`. Both UBOs expose `.opacity` at offset 0 so the
 * shared fragment shader pattern still applies.
 */

import type { SpriteAtlas } from "./shared/sprite-atlas.js";
import type { BillboardBasisFn, BillboardSpriteSystem, BillboardSpriteSystemOptions } from "./sprite-billboard-shared.js";
import { _createBillboardSystem } from "./sprite-billboard-shared.js";

function normalize(v: [number, number, number]): [number, number, number] {
    const len = Math.hypot(v[0], v[1], v[2]);
    if (len < 1e-12) {
        return [0, 1, 0];
    }
    return [v[0] / len, v[1] / len, v[2] / len];
}

/** Axis-locked basis builder — closes over the (normalized) lock axis so the
 *  CPU helper does not need to inspect `system._lockAxis` (and never branches
 *  on `system._variant`). Mirrors the WGSL math in `composeAxisLockedBillboard`. */
function makeAxisBasisFn(axis: [number, number, number]): BillboardBasisFn {
    const ax = axis[0];
    const ay = axis[1];
    const az = axis[2];
    return (worldPos, _camRight, _camUp, camPos) => {
        let tx = camPos[0] - worldPos[0];
        let ty = camPos[1] - worldPos[1];
        let tz = camPos[2] - worldPos[2];
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl;
        ty /= tl;
        tz /= tl;
        const dotAT = ax * tx + ay * ty + az * tz;
        let fx = tx - ax * dotAT;
        let fy = ty - ay * dotAT;
        let fz = tz - az * dotAT;
        const fl = Math.hypot(fx, fy, fz);
        if (fl < 1e-4) {
            // Degenerate fallback (matches WGSL).
            fx = Math.abs(ax) < 0.9 ? 0 : 1;
            fy = 0;
            fz = Math.abs(ax) < 0.9 ? 1 : 0;
        } else {
            fx /= fl;
            fy /= fl;
            fz /= fl;
        }
        let rx = ay * fz - az * fy;
        let ry = az * fx - ax * fz;
        let rz = ax * fy - ay * fx;
        const rl = Math.hypot(rx, ry, rz) || 1;
        rx /= rl;
        ry /= rl;
        rz /= rl;
        return { right: [rx, ry, rz], up: [ax, ay, az] };
    };
}

/** Arbitrary axis-locked billboard. Axis is normalized at creation time. */
export function createAxisLockedBillboardSystem(atlas: SpriteAtlas, axis: [number, number, number], opts: BillboardSpriteSystemOptions = {}): BillboardSpriteSystem {
    const normalized = normalize(axis);
    const system = _createBillboardSystem(atlas, "axis", normalized, opts);
    system._basisFn = makeAxisBasisFn(normalized);
    system._deferredBuild = async (scene): Promise<void> => {
        const mod = await import("./sprite-billboard-axis-renderable.js");
        await mod.buildAxisLockedBillboardRenderable(system, scene);
    };
    return system;
}
