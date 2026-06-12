import type { Camera, NormalizedViewport } from "./camera.js";
import type { Vec3, Mat4, Mat4Storage } from "../math/types.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { IWorldMatrixProvider, IParentable } from "../scene/parentable.js";
import { createWorldMatrixState, attachWorldMatrixState } from "../scene/world-matrix-state.js";
import { allocateMat4 } from "../math/_matrix-allocator.js";
import { mat4LookAtLH } from "../math/mat4-look-at-lh.js";
import type { GeospatialLimits } from "./geospatial-limits.js";
import { createGeospatialLimits, getEffectivePitchMax, GEO_EPSILON } from "./geospatial-limits.js";

const TWO_PI = Math.PI * 2;
/** Babylon.js world "north" axis in a left-handed scene = +Z (LeftHandedForward). */
const WORLD_NORTH: Vec3 = { x: 0, y: 0, z: 1 };
const WORLD_RIGHT: Vec3 = { x: 1, y: 0, z: 0 };
/** sin of the spherical-latitude limit (~89.96°) used to keep the centre off the poles. */
const POLE_SINE_LIMIT = 0.998749218;

/** Options for {@link createGeospatialCamera}. */
export interface GeospatialCameraOptions {
    /** Radius of the planet being orbited. */
    planetRadius: number;
}

/** A delta to apply via {@link setGeospatialOrientation}; omitted fields keep their current value. */
export interface GeospatialOrientation {
    /** Yaw in radians (0 = north, π/2 = east). */
    yaw?: number;
    /** Pitch in radians (0 = looking straight down at the planet centre, π/2 = horizon). */
    pitch?: number;
    /** Distance from the camera to its centre point. */
    radius?: number;
    /** Anchor point on the globe (ECEF) that the camera orbits. */
    center?: Vec3;
}

/** Camera that orbits a spherical planet centred at the world origin (Babylon.js `GeospatialCamera`).
 *
 *  Orientation is fully described by `center` (the anchored point on the globe in
 *  ECEF coordinates), `yaw`, `pitch`, and `radius`. Setting any of these
 *  recomputes the derived `position` / `upVector` and the view matrix.
 *
 *  Pure state — behaviour is provided by standalone functions
 *  ({@link setGeospatialOrientation}, `attachGeospatialControls`,
 *  `flyGeospatialCameraToAsync`). The camera never references the scene. */
export interface GeospatialCamera extends Camera, IWorldMatrixProvider, IParentable {
    /** The anchored point on the globe (ECEF). Assigning re-orbits around the new centre. */
    center: Vec3;
    /** Yaw about the geocentric up axis. Wrapped to [-π, π). 0 = north, π/2 = east. */
    yaw: number;
    /** Pitch from looking straight down (0) to the horizon (π/2). Wrapped to [-π, π). */
    pitch: number;
    /** Distance from the camera to its centre point (distinct from `planetRadius`). */
    radius: number;
    /** Limits governing yaw/pitch/radius clamping. Mutable; clamping applies on the next orientation change. */
    limits: GeospatialLimits;
    /** Derived world-space eye position. Read-only — driven by center/yaw/pitch/radius. */
    readonly position: Vec3;
    /** Derived camera up vector. Read-only. */
    readonly upVector: Vec3;

    fov: number;
    nearPlane: number;
    farPlane: number;
    viewport?: NormalizedViewport;
    children: SceneNode[];
    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;

    /** @internal Current normalized lookAt (unit) direction. */
    _lookAt: Vec3;
    /** @internal Recompute orientation from raw yaw/pitch/radius/center, applying limits.
     *  Used by the controls/flyTo modules to drive the camera in one shot. */
    _setOrientation: (yaw: number, pitch: number, radius: number, center: Vec3) => void;
    /** @internal Cancels an in-flight `flyGeospatialCameraToAsync` animation. Set while a
     *  flight is active; the controls loop calls it when user input arrives. */
    _cancelFly?: () => void;
}

/** Wrap an angle to [-π, π), matching Babylon.js `Scalar.NormalizeRadians`. */
export function normalizeRadians(angle: number): number {
    return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

function clamp(v: number, min: number, max: number): number {
    return v < min ? min : v > max ? max : v;
}

/**
 * Build the east/north/up orthonormal basis at a point on the globe (left-handed
 * convention). `up` is the geocentric normal (normalized position); `east` and
 * `north` complete a right-handed-looking tangent frame given the LH world.
 * Writes into the provided result objects and returns nothing.
 */
export function computeLocalBasis(worldPos: Vec3, refEast: Vec3, refNorth: Vec3, refUp: Vec3): void {
    // up = normalized position (geocentric normal)
    const upLen = Math.hypot(worldPos.x, worldPos.y, worldPos.z) || 1;
    refUp.x = worldPos.x / upLen;
    refUp.y = worldPos.y / upLen;
    refUp.z = worldPos.z / upLen;

    // east = cross(up, worldNorth)
    cross(refUp, WORLD_NORTH, refEast);
    if (lengthSq(refEast) < GEO_EPSILON) {
        // At a pole, cross with worldRight instead.
        cross(refUp, WORLD_RIGHT, refEast);
    }
    normalizeInPlace(refEast);

    // north = cross(east, up)
    cross(refEast, refUp, refNorth);
    normalizeInPlace(refNorth);
}

/**
 * Compute the lookAt direction from yaw/pitch at a centre point (forward formula).
 * Writes the normalized direction into `result`.
 */
export function computeLookAtFromYawPitch(yaw: number, pitch: number, center: Vec3, result: Vec3): Vec3 {
    const east = { x: 0, y: 0, z: 0 };
    const north = { x: 0, y: 0, z: 0 };
    const up = { x: 0, y: 0, z: 0 };
    computeLocalBasis(center, east, north, up);

    const sinPitch = Math.sin(pitch);
    const cosPitch = Math.cos(pitch);
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);

    // horiz = north*cos(yaw) + east*sin(yaw)
    const hx = north.x * cosYaw + east.x * sinYaw;
    const hy = north.y * cosYaw + east.y * sinYaw;
    const hz = north.z * cosYaw + east.z * sinYaw;

    // lookAt = horiz*sinPitch - up*cosPitch
    result.x = hx * sinPitch - up.x * cosPitch;
    result.y = hy * sinPitch - up.y * cosPitch;
    result.z = hz * sinPitch - up.z * cosPitch;
    return normalizeInPlace(result);
}

/**
 * Inverse of {@link computeLookAtFromYawPitch}: given a lookAt direction and centre,
 * recover the yaw/pitch that would produce it. Writes `[yaw, pitch]` into `result`.
 * `currentYaw` is used as a fallback when looking straight down/up (yaw undefined).
 */
export function computeYawPitchFromLookAt(lookAt: Vec3, center: Vec3, currentYaw: number, result: { x: number; y: number }): { x: number; y: number } {
    const east = { x: 0, y: 0, z: 0 };
    const north = { x: 0, y: 0, z: 0 };
    const up = { x: 0, y: 0, z: 0 };
    computeLocalBasis(center, east, north, up);

    const lookDotUp = lookAt.x * up.x + lookAt.y * up.y + lookAt.z * up.z;
    const cosPitch = -lookDotUp;
    const pitch = Math.acos(clamp(cosPitch, -1, 1));

    // lookHorizontal = lookAt + up*cosPitch = horiz*sinPitch
    const lhx = lookAt.x + up.x * cosPitch;
    const lhy = lookAt.y + up.y * cosPitch;
    const lhz = lookAt.z + up.z * cosPitch;

    const sinPitch = Math.sin(pitch);
    if (Math.abs(sinPitch) < GEO_EPSILON) {
        result.x = currentYaw;
        result.y = pitch;
        return result;
    }
    const inv = 1 / sinPitch;
    const hx = lhx * inv;
    const hy = lhy * inv;
    const hz = lhz * inv;

    const cosYaw = hx * north.x + hy * north.y + hz * north.z;
    const sinYaw = hx * east.x + hy * east.y + hz * east.z;
    result.x = Math.atan2(sinYaw, cosYaw);
    result.y = pitch;
    return result;
}

/**
 * Clamp the camera centre away from the geographic poles (in place), so the
 * tangent basis stays well-defined. Mirrors Babylon.js `ClampCenterFromPolesInPlace`.
 */
export function clampCenterFromPoles(center: Vec3): Vec3 {
    const mag = Math.hypot(center.x, center.y, center.z);
    if (mag > GEO_EPSILON) {
        const sinLat = center.z / mag;
        if (Math.abs(sinLat) > POLE_SINE_LIMIT) {
            const sinClamped = clamp(sinLat, -POLE_SINE_LIMIT, POLE_SINE_LIMIT);
            const cosClamped = Math.sqrt(1 - sinClamped * sinClamped);
            const lon = Math.atan2(center.y, center.x);
            center.x = mag * Math.cos(lon) * cosClamped;
            center.y = mag * Math.sin(lon) * cosClamped;
            center.z = mag * sinClamped;
        }
    }
    return center;
}

/** Set one or more orientation fields at once (single recompute). Omitted fields keep their value. */
export function setGeospatialOrientation(camera: GeospatialCamera, orientation: GeospatialOrientation): void {
    camera._setOrientation(orientation.yaw ?? camera.yaw, orientation.pitch ?? camera.pitch, orientation.radius ?? camera.radius, orientation.center ?? camera.center);
}

/** Create a {@link GeospatialCamera} for a planet of the given radius. Pure data, no scene knowledge. */
export function createGeospatialCamera(options: GeospatialCameraOptions): GeospatialCamera {
    const limits = createGeospatialLimits(options.planetRadius);

    const center: Vec3 = { x: options.planetRadius, y: 0, z: 0 };
    const position: Vec3 = { x: 0, y: 0, z: 0 };
    const upVector: Vec3 = { x: 0, y: 1, z: 0 };
    const lookAt: Vec3 = { x: 0, y: 0, z: 0 };
    const scalars = { yaw: 0, pitch: 0, radius: 0 };

    const _localMat: Mat4 = allocateMat4();

    function cameraLocalWorldMatrix(): Mat4 {
        // camera-to-world = transpose(view R) + eye, like FreeCamera.
        const center3: Vec3 = { x: position.x + lookAt.x, y: position.y + lookAt.y, z: position.z + lookAt.z };
        const view = mat4LookAtLH(position, center3, upVector);
        const m = _localMat as unknown as Mat4Storage;
        m[0] = view[0]!;
        m[1] = view[4]!;
        m[2] = view[8]!;
        m[3] = 0;
        m[4] = view[1]!;
        m[5] = view[5]!;
        m[6] = view[9]!;
        m[7] = 0;
        m[8] = view[2]!;
        m[9] = view[6]!;
        m[10] = view[10]!;
        m[11] = 0;
        m[12] = position.x;
        m[13] = position.y;
        m[14] = position.z;
        m[15] = 1;
        return _localMat;
    }

    const wm = createWorldMatrixState(cameraLocalWorldMatrix);

    function applyOrientation(yaw: number, pitch: number, radius: number, newCenter: Vec3): void {
        scalars.yaw = normalizeRadians(yaw);
        scalars.pitch = normalizeRadians(pitch);
        scalars.radius = radius;
        center.x = newCenter.x;
        center.y = newCenter.y;
        center.z = newCenter.z;

        // Clamp to limits.
        scalars.yaw = clamp(scalars.yaw, limits.yawMin, limits.yawMax);
        scalars.pitch = clamp(scalars.pitch, limits.pitchMin, getEffectivePitchMax(limits, scalars.radius));
        scalars.radius = clamp(scalars.radius, limits.radiusMin, limits.radiusMax);
        clampCenterFromPoles(center);

        // Tangent basis at the (clamped) centre.
        const east = { x: 0, y: 0, z: 0 };
        const north = { x: 0, y: 0, z: 0 };
        const up = { x: 0, y: 0, z: 0 };
        computeLocalBasis(center, east, north, up);

        // lookAt from yaw/pitch.
        computeLookAtFromYawPitch(scalars.yaw, scalars.pitch, center, lookAt);

        // Build an orthonormal camera up aligned with geocentric up.
        const right = { x: 0, y: 0, z: 0 };
        cross(up, lookAt, right);
        if (lengthSq(right) < GEO_EPSILON) {
            // Looking straight down: lookAt ∥ up → use the horizontal direction.
            const cy = Math.cos(scalars.yaw);
            const sy = Math.sin(scalars.yaw);
            const horiz = { x: north.x * cy + east.x * sy, y: north.y * cy + east.y * sy, z: north.z * cy + east.z * sy };
            cross(horiz, lookAt, right);
        }
        normalizeInPlace(right);

        // up = normalize(cross(look, right))
        cross(lookAt, right, upVector);
        normalizeInPlace(upVector);

        // position = center - look*radius
        position.x = center.x - lookAt.x * scalars.radius;
        position.y = center.y - lookAt.y * scalars.radius;
        position.z = center.z - lookAt.z * scalars.radius;

        wm.markLocalDirty();
    }

    const cam = {
        fov: 0.8,
        nearPlane: 1,
        farPlane: options.planetRadius * 16,
        children: [] as SceneNode[],
        limits,
        position,
        upVector,

        _lookAt: lookAt,
        _setOrientation: applyOrientation,

        _viewCache: allocateMat4() as unknown as Mat4Storage,
        _projCache: allocateMat4() as unknown as Mat4Storage,
        _vpCache: allocateMat4() as unknown as Mat4Storage,

        get parent() {
            return wm.parent;
        },
        set parent(v: IWorldMatrixProvider | null) {
            wm.parent = v;
        },
        get worldMatrix() {
            return wm.getWorldMatrix();
        },
        get worldMatrixVersion() {
            return wm.getWorldMatrixVersion();
        },

        get center() {
            return center;
        },
        set center(v: Vec3) {
            applyOrientation(scalars.yaw, scalars.pitch, scalars.radius, v);
        },
        get yaw() {
            return scalars.yaw;
        },
        set yaw(v: number) {
            if (v !== scalars.yaw) {
                applyOrientation(v, scalars.pitch, scalars.radius, center);
            }
        },
        get pitch() {
            return scalars.pitch;
        },
        set pitch(v: number) {
            if (v !== scalars.pitch) {
                applyOrientation(scalars.yaw, v, scalars.radius, center);
            }
        },
        get radius() {
            return scalars.radius;
        },
        set radius(v: number) {
            if (v !== scalars.radius) {
                applyOrientation(scalars.yaw, scalars.pitch, v, center);
            }
        },
    } as unknown as GeospatialCamera;

    attachWorldMatrixState(cam, wm);

    // Default resting pose: looking straight down at (planetRadius,0,0) from radiusMax.
    const restingRadius = limits.radiusMax !== Infinity ? limits.radiusMax : options.planetRadius * 4;
    applyOrientation(0, 0, restingRadius, center);

    return cam;
}

// ── small local vector helpers (no per-frame allocation) ───────────────────

function cross(a: Vec3, b: Vec3, out: Vec3): void {
    const x = a.y * b.z - a.z * b.y;
    const y = a.z * b.x - a.x * b.z;
    const z = a.x * b.y - a.y * b.x;
    out.x = x;
    out.y = y;
    out.z = z;
}

function lengthSq(v: Vec3): number {
    return v.x * v.x + v.y * v.y + v.z * v.z;
}

function normalizeInPlace(v: Vec3): Vec3 {
    const len = Math.hypot(v.x, v.y, v.z);
    if (len > 1e-10) {
        const inv = 1 / len;
        v.x *= inv;
        v.y *= inv;
        v.z *= inv;
    }
    return v;
}
