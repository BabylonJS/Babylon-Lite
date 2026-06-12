/** Pitch/yaw/radius bounds for a {@link GeospatialCamera}.
 *
 *  Pure state, mirroring Babylon.js `GeospatialLimits`. Behaviour
 *  ({@link getEffectivePitchMax}, {@link clampZoomDistance}) lives in
 *  standalone functions so unused limit logic is tree-shaken.
 *
 *  All angles are in radians. Pitch is measured from "looking straight down at
 *  the planet centre" (0) to "looking at the horizon" (π/2). */
export interface GeospatialLimits {
    /** Radius of the planet — used for altitude/radius conversions. */
    planetRadius: number;
    /** Minimum camera distance from its centre point (closest zoom). Default 10. */
    radiusMin: number;
    /** Maximum camera distance from its centre point (farthest zoom). Default `planetRadius * 4`. */
    radiusMax: number;
    /** Minimum pitch angle (≈0 = looking straight down at the planet). */
    pitchMin: number;
    /** Maximum pitch angle (π/2 = looking at the horizon). */
    pitchMax: number;
    /**
     * Controls how pitch is disabled as the camera zooms out.
     * `x` = radius scale at which full pitch is allowed (e.g. 2 ⇒ 2·planetRadius),
     * `y` = radius scale at which pitch is fully disabled (forced to `pitchMin`).
     * `null` disables this feature (full pitch at every radius).
     */
    pitchDisabledRadiusScale: { x: number; y: number } | null;
    /** Minimum yaw angle (rotation about the geocentric up axis). Default -Infinity. */
    yawMin: number;
    /** Maximum yaw angle. Default +Infinity. */
    yawMax: number;
}

/** Babylon.js `Epsilon` (used as the default minimum pitch so the camera never looks exactly straight down). */
export const GEO_EPSILON = 0.001;

/** Create geospatial limits for a planet of the given radius, matching Babylon.js defaults. */
export function createGeospatialLimits(planetRadius: number): GeospatialLimits {
    return {
        planetRadius,
        radiusMin: 10,
        radiusMax: planetRadius * 4,
        pitchMin: GEO_EPSILON,
        pitchMax: Math.PI / 2 - 0.01,
        pitchDisabledRadiusScale: { x: 2, y: 4 },
        yawMin: -Infinity,
        yawMax: Infinity,
    };
}

/**
 * Computes the effective maximum pitch for a given camera radius. When
 * `pitchDisabledRadiusScale` is set, pitch is interpolated from `pitchMax` down
 * to `pitchMin` as the camera zooms out from `x·planetRadius` to `y·planetRadius`
 * (so a fully zoomed-out camera looks straight down).
 */
export function getEffectivePitchMax(limits: GeospatialLimits, currentRadius: number): number {
    const scale = limits.pitchDisabledRadiusScale;
    if (!scale) {
        return limits.pitchMax;
    }
    const fullPitchRadius = scale.x * limits.planetRadius;
    const noPitchRadius = scale.y * limits.planetRadius;
    if (currentRadius <= fullPitchRadius) {
        return limits.pitchMax;
    }
    if (currentRadius >= noPitchRadius) {
        return limits.pitchMin;
    }
    const t = (currentRadius - fullPitchRadius) / (noPitchRadius - fullPitchRadius);
    const clampedT = t < 0 ? 0 : t > 1 ? 1 : t;
    return limits.pitchMax * (1 - clampedT) + limits.pitchMin * clampedT;
}

/**
 * Clamps a requested zoom distance so it respects the radius limits.
 * @param limits - The geospatial limits.
 * @param zoomDistance - Requested zoom (positive = zoom in, negative = zoom out).
 * @param currentRadius - Current camera radius.
 * @param distanceToTarget - Optional distance to the zoom target point (used for zoom-in clamping).
 * @returns The clamped zoom distance.
 */
export function clampZoomDistance(limits: GeospatialLimits, zoomDistance: number, currentRadius: number, distanceToTarget?: number): number {
    if (zoomDistance > 0) {
        const maxZoomIn = (distanceToTarget ?? currentRadius) - limits.radiusMin;
        return Math.min(zoomDistance, Math.max(0, maxZoomIn));
    }
    const maxZoomOut = limits.radiusMax - currentRadius;
    return Math.max(zoomDistance, -Math.max(0, maxZoomOut));
}
