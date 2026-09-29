// MeshLoD demo — deterministic camera path.
//
// A 20-second looping fly-around of the statue in two 10-second smooth-stepped
// segments (architecture §15.6). The path is a PURE function of a bounding sphere
// and a path time — it holds no engine reference — so it is trivially unit-tested
// and produces byte-repeatable poses at any timestamp. The stateful controller
// advances a FIXED 60 Hz sample clock (never wall-clock), so a given rendered
// frame count always maps to the same pose; manual interaction pauses it and
// reset returns to t = 0.

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
const FIXED_DELTA_S = 1 / 60;

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

/** Stateful driver over {@link sampleMeshLoDCameraPath}. */
export interface MeshLoDCameraPathController {
    /** Whether path mode is active (the toggle). */
    enabled: boolean;
    /** True while a manual interaction has paused auto-advance, or a frozen pose is held. */
    readonly paused: boolean;
    /** Current path time in seconds. */
    readonly timeSeconds: number;
    /** Enable/disable path mode. Enabling clears the paused/frozen state. */
    setEnabled(enabled: boolean): void;
    /** Return to t = 0 and resume auto-advance (clears paused/frozen). */
    reset(): void;
    /** Pause auto-advance because the user is driving the camera manually. */
    notifyInteraction(): void;
    /** Freeze at a fixed time for deterministic capture (`?pathTime=`), holding the pose. */
    freezeAt(timeSeconds: number): void;
    /** Advance the FIXED 60 Hz clock one frame and return the new pose, or null when
     *  the path should not drive the camera this frame (disabled/paused/frozen). */
    advance(): MeshLoDCameraPose | null;
    /** The pose at the current time, regardless of enabled/paused state. */
    currentPose(): MeshLoDCameraPose;
}

export function createMeshLoDCameraPath(bounds: MeshLoDPathBounds): MeshLoDCameraPathController {
    let enabled = false;
    let paused = false;
    let time = 0;
    return {
        get enabled() {
            return enabled;
        },
        set enabled(value: boolean) {
            this.setEnabled(value);
        },
        get paused() {
            return paused;
        },
        get timeSeconds() {
            return time;
        },
        setEnabled(value: boolean): void {
            enabled = value;
            paused = false;
        },
        reset(): void {
            time = 0;
            paused = false;
        },
        notifyInteraction(): void {
            paused = true;
        },
        freezeAt(timeSeconds: number): void {
            enabled = true;
            paused = true;
            time = timeSeconds;
        },
        advance(): MeshLoDCameraPose | null {
            if (!enabled || paused) {
                return null;
            }
            time = (time + FIXED_DELTA_S) % MESH_LOD_PATH_DURATION_S;
            return sampleMeshLoDCameraPath(bounds, time);
        },
        currentPose(): MeshLoDCameraPose {
            return sampleMeshLoDCameraPath(bounds, time);
        },
    };
}
