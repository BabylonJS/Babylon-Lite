// MeshLoD demo — deterministic camera path.
//
// A pure 20-second looping orbit around the statue in two smooth-stepped
// segments. A ?pathTime= URL samples one reproducible pose without adding
// animation controls to the viewer.

/** Aggregate bounding sphere of the placed statue (world space). */
export interface MeshLoDPathBounds {
    center: { x: number; y: number; z: number };
    radius: number;
}

/** An orbit-camera pose the path evaluates to. */
export interface MeshLoDCameraPose {
    alpha: number;
    beta: number;
    radius: number;
    target: { x: number; y: number; z: number };
}

const DEG = Math.PI / 180;

/** Total loop duration and the boundary between the two segments (seconds). */
export const MESH_LOD_PATH_DURATION_S = 20;
const SEGMENT_S = MESH_LOD_PATH_DURATION_S / 2;

// Keyframes at t = 0, 10, 20 s: azimuth (rad), elevation above horizon (deg),
// radius as a multiple of the bounding-sphere radius.
const AZIMUTH = [-0.8 * Math.PI, 0.2 * Math.PI, 1.2 * Math.PI];
const ELEVATION_DEG = [25, 50, 25];
const RADIUS_MULTIPLE = [2.4, 0.75, 2.4];

function clamp01(x: number): number {
    return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Cubic smoothstep on a unit interval (eases in and out at the ends). */
function smoothstep(x: number): number {
    const t = clamp01(x);
    return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/** Evaluate the deterministic camera pose at an absolute path time (seconds).
 *  Time loops over the 20-second duration; negative times wrap correctly. */
export function sampleMeshLoDCameraPath(bounds: MeshLoDPathBounds, timeSeconds: number): MeshLoDCameraPose {
    let t = timeSeconds % MESH_LOD_PATH_DURATION_S;
    if (t < 0) {
        t += MESH_LOD_PATH_DURATION_S;
    }
    const first = t < SEGMENT_S;
    const u = smoothstep((first ? t : t - SEGMENT_S) / SEGMENT_S);
    const i = first ? 0 : 1;
    const alpha = lerp(AZIMUTH[i]!, AZIMUTH[i + 1]!, u);
    const elevation = lerp(ELEVATION_DEG[i]!, ELEVATION_DEG[i + 1]!, u);
    const radiusMultiple = lerp(RADIUS_MULTIPLE[i]!, RADIUS_MULTIPLE[i + 1]!, u);
    return {
        alpha,
        beta: (90 - elevation) * DEG,
        radius: radiusMultiple * bounds.radius,
        target: { x: bounds.center.x, y: bounds.center.y, z: bounds.center.z },
    };
}
