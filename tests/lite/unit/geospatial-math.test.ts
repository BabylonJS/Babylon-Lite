import { describe, expect, it } from "vitest";

import {
    normalizeRadians,
    computeLocalBasis,
    computeLookAtFromYawPitch,
    computeYawPitchFromLookAt,
    clampCenterFromPoles,
    createGeospatialCamera,
} from "../../../packages/babylon-lite/src/camera/geospatial-camera";
import { createGeospatialLimits, getEffectivePitchMax, clampZoomDistance } from "../../../packages/babylon-lite/src/camera/geospatial-limits";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types";

const POLE_SINE_LIMIT = 0.998749218;

function dot(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}
function len(a: Vec3): number {
    return Math.hypot(a.x, a.y, a.z);
}

describe("normalizeRadians", () => {
    it("wraps angles into [-π, π)", () => {
        expect(normalizeRadians(0)).toBeCloseTo(0, 12);
        expect(normalizeRadians(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12);
        // 3π wraps to -π.
        expect(normalizeRadians(3 * Math.PI)).toBeCloseTo(-Math.PI, 12);
        // A large positive angle and its +2π are congruent after wrapping.
        const a = normalizeRadians(10.5);
        const b = normalizeRadians(10.5 + 2 * Math.PI);
        expect(b).toBeCloseTo(a, 12);
        expect(a).toBeGreaterThanOrEqual(-Math.PI);
        expect(a).toBeLessThan(Math.PI);
    });
});

describe("computeLocalBasis", () => {
    it("produces an orthonormal east/north/up frame with up = normalized position", () => {
        const pos: Vec3 = { x: 3, y: -4, z: 12 }; // mag 13
        const east: Vec3 = { x: 0, y: 0, z: 0 };
        const north: Vec3 = { x: 0, y: 0, z: 0 };
        const up: Vec3 = { x: 0, y: 0, z: 0 };
        computeLocalBasis(pos, east, north, up);

        expect(len(east)).toBeCloseTo(1, 9);
        expect(len(north)).toBeCloseTo(1, 9);
        expect(len(up)).toBeCloseTo(1, 9);
        expect(dot(east, north)).toBeCloseTo(0, 9);
        expect(dot(east, up)).toBeCloseTo(0, 9);
        expect(dot(north, up)).toBeCloseTo(0, 9);
        // up is the geocentric normal.
        expect(up.x).toBeCloseTo(3 / 13, 9);
        expect(up.y).toBeCloseTo(-4 / 13, 9);
        expect(up.z).toBeCloseTo(12 / 13, 9);
    });

    it("falls back to a valid frame at the pole (cross(up, north) degenerate)", () => {
        const pos: Vec3 = { x: 0, y: 0, z: 5 };
        const east: Vec3 = { x: 0, y: 0, z: 0 };
        const north: Vec3 = { x: 0, y: 0, z: 0 };
        const up: Vec3 = { x: 0, y: 0, z: 0 };
        computeLocalBasis(pos, east, north, up);

        for (const v of [east, north, up]) {
            expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true);
            expect(len(v)).toBeCloseTo(1, 9);
        }
        expect(dot(east, north)).toBeCloseTo(0, 9);
        expect(dot(east, up)).toBeCloseTo(0, 9);
        expect(dot(north, up)).toBeCloseTo(0, 9);
    });
});

describe("yaw/pitch ↔ lookAt round-trip", () => {
    it("recovers the yaw/pitch that generated a lookAt direction", () => {
        const center: Vec3 = { x: 6, y: 0, z: 0 };
        for (const yaw of [-1.2, 0.0, 0.5, 2.7]) {
            for (const pitch of [0.2, 0.7, 1.3]) {
                const lookAt: Vec3 = { x: 0, y: 0, z: 0 };
                computeLookAtFromYawPitch(yaw, pitch, center, lookAt);
                expect(len(lookAt)).toBeCloseTo(1, 9);

                const out = { x: 0, y: 0 };
                computeYawPitchFromLookAt(lookAt, center, 0, out);
                // Compare yaw modulo 2π (atan2 result vs the input angle).
                const dy = normalizeRadians(out.x - yaw);
                expect(dy).toBeCloseTo(0, 6);
                expect(out.y).toBeCloseTo(pitch, 6);
            }
        }
    });

    it("preserves the previous yaw when looking straight down (pitch ≈ 0)", () => {
        const center: Vec3 = { x: 0, y: 7, z: 0 };
        const up: Vec3 = { x: 0, y: 1, z: 0 };
        // lookAt straight down = -up.
        const lookAt: Vec3 = { x: -up.x, y: -up.y, z: -up.z };
        const out = { x: 0, y: 0 };
        computeYawPitchFromLookAt(lookAt, center, 1.234, out);
        expect(out.y).toBeCloseTo(0, 6);
        expect(out.x).toBeCloseTo(1.234, 9); // previous yaw preserved
    });
});

describe("clampCenterFromPoles", () => {
    it("enforces |sin(lat)| ≤ 0.998749218 while preserving magnitude and longitude", () => {
        const center: Vec3 = { x: 1, y: 0, z: 100 }; // nearly at the pole
        const magBefore = len(center);
        const lonBefore = Math.atan2(center.y, center.x);
        clampCenterFromPoles(center);
        const mag = len(center);
        expect(mag).toBeCloseTo(magBefore, 6);
        expect(Math.abs(center.z / mag)).toBeCloseTo(POLE_SINE_LIMIT, 9);
        expect(Math.atan2(center.y, center.x)).toBeCloseTo(lonBefore, 9);
    });

    it("leaves an equatorial centre untouched", () => {
        const center: Vec3 = { x: 50, y: 50, z: 0 };
        clampCenterFromPoles(center);
        expect(center).toEqual({ x: 50, y: 50, z: 0 });
    });
});

describe("createGeospatialCamera — default pose & view matrix", () => {
    it("rests looking straight down at (planetRadius,0,0) from radiusMax", () => {
        const cam = createGeospatialCamera({ planetRadius: 100 });
        expect(cam.radius).toBe(400); // planetRadius * 4
        expect(cam.center).toEqual({ x: 100, y: 0, z: 0 });

        // position = center - lookAt*radius, lookAt ≈ -up = (-1,0,~0).
        expect(cam.position.x).toBeCloseTo(500, 1);
        expect(cam.position.y).toBeCloseTo(0, 3);
        expect(Math.abs(cam.position.z)).toBeLessThan(1);

        // worldMatrix translation column equals the eye position (Float32 precision).
        const w = cam.worldMatrix as unknown as number[];
        expect(w[12]).toBeCloseTo(cam.position.x, 3);
        expect(w[13]).toBeCloseTo(cam.position.y, 3);
        expect(w[14]).toBeCloseTo(cam.position.z, 3);
        expect(w[15]).toBe(1);
    });

    it("keeps the eye outside the planet at a sample tilted pose", () => {
        const cam = createGeospatialCamera({ planetRadius: 100 });
        cam.radius = 150; // within full-pitch range
        cam.pitch = 0.6;
        cam.yaw = 0.4;
        expect(len(cam.position)).toBeGreaterThan(100);
        expect(len(cam.upVector)).toBeCloseTo(1, 6);
    });
});

describe("geospatial limits", () => {
    it("getEffectivePitchMax disables pitch as the camera zooms out", () => {
        const limits = createGeospatialLimits(100);
        expect(getEffectivePitchMax(limits, 150)).toBeCloseTo(limits.pitchMax, 9); // ≤ 2·R
        expect(getEffectivePitchMax(limits, 400)).toBeCloseTo(limits.pitchMin, 9); // ≥ 4·R
        const mid = getEffectivePitchMax(limits, 300); // halfway between 2R and 4R
        expect(mid).toBeGreaterThan(limits.pitchMin);
        expect(mid).toBeLessThan(limits.pitchMax);
        expect(mid).toBeCloseTo((limits.pitchMax + limits.pitchMin) / 2, 9);
    });

    it("clampZoomDistance respects the radius bounds in both directions", () => {
        const limits = createGeospatialLimits(100); // radiusMin 10, radiusMax 400
        // Zoom in cannot pass radiusMin given a distance to the target.
        expect(clampZoomDistance(limits, 1000, 50, 50)).toBeCloseTo(40, 9); // 50 - 10
        // Zoom out cannot pass radiusMax.
        expect(clampZoomDistance(limits, -1000, 380)).toBeCloseTo(-20, 9); // -(400 - 380)
        // A modest in-range zoom passes through unchanged.
        expect(clampZoomDistance(limits, 5, 200, 200)).toBeCloseTo(5, 9);
    });
});
