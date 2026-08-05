/**
 * Racer skid marks — dark tyre streaks stamped onto the road while the car
 * drifts or brakes hard (the kit's `drift_intensity > 0.25`, same gate as the
 * drift smoke). Implemented as a single thin-instanced flat quad (Lite's
 * `createGround`), so hundreds of marks cost one draw call; a ring buffer
 * recycles the oldest marks once the cap is reached.
 *
 * The material is alpha-blended (alpha < 1), which also disables depth-write, so
 * the coplanar stamps layer over the road by draw order without z-fighting.
 */

import type { EngineContext, Mesh, SceneContext } from "babylon-lite";
import { addToScene, createGround, createStandardMaterial, mat4Compose, setThinInstanceColors, setThinInstanceMatrix, setThinInstances } from "babylon-lite";

const CAP = 512; // max simultaneous marks (ring buffer, shared across the rear wheels)
const DRIFT_THRESHOLD = 0.25; // matches the drift-smoke gate (kit `drift_intensity > 0.25`)
const STAMP_SPACING = 0.45; // world units of travel between stamps (< STAMP_LEN so they overlap)
const STAMP_LEN = 0.6; // mark length along the direction of travel
const STAMP_WIDTH = 0.35; // mark width (≈ a tyre)
const MARK_Y = 0.03; // just above the road so marks sit on top without z-fighting
const MARK_COLOR: readonly [number, number, number] = [0.05, 0.05, 0.06];
const MARK_ALPHA = 0.45; // peak opacity; < 1 so the standard material alpha-blends (and skips depth-write)
const SKID_LIFETIME = 5; // seconds a mark lives before it has fully faded away
const SKID_FADE = 2; // seconds spent fading (held solid for SKID_LIFETIME − SKID_FADE, then ramps to 0)

/** Per-wheel last-stamp position, so marks are spaced evenly along the path. */
interface WheelTrail {
    x: number;
    z: number;
    primed: boolean;
}

/** A rear-wheel contact point on the road (only X/Z matter — the marks lie flat). */
interface WheelPoint {
    x: number;
    z: number;
}

/** A pool of dark quad decals stamped under the car's rear wheels while it slides. */
export class SkidMarks {
    private readonly _mesh: Mesh;
    private _head = 0; // next ring slot to overwrite
    private _clock = 0; // seconds elapsed, drives per-mark ageing
    private _lastStamp = -1e9; // clock time of the newest mark (lets us stop fading once all are dead)
    private readonly _colors = new Float32Array(CAP * 4); // per-instance RGBA (A carries the fade)
    private readonly _spawn = new Float32Array(CAP).fill(-1); // per-slot spawn time (−1 = empty)
    private _trails: WheelTrail[] = []; // one per rear wheel (2 for the cars, 1 for the motorcycle); rebuilt when the count changes

    constructor(engine: EngineContext, scene: SceneContext) {
        const mesh = createGround(engine, { width: 1, height: 1, subdivisions: 1 });
        const mat = createStandardMaterial();
        mat.diffuseColor = [MARK_COLOR[0], MARK_COLOR[1], MARK_COLOR[2]];
        mat.specularColor = [0, 0, 0];
        mat.disableLighting = true; // flat dark decal, unaffected by the sun
        mat.alpha = MARK_ALPHA;
        mesh.material = mat;

        // Keep the full fixed-capacity ring active so any recycled slot can be
        // overwritten without changing the draw count or invalidating cached render
        // bundles. Unused slots stay parked as degenerate matrices and emit no fragments.
        const hidden = mat4Compose(0, -1000, 0, 0, 0, 0, 1, 0, 0, 0);
        const matrices = new Float32Array(CAP * 16);
        for (let i = 0; i < CAP; i++) {
            matrices.set(hidden, i * 16);
        }
        setThinInstances(mesh, matrices, CAP);
        // Per-instance alpha drives the time fade; RGB stays white so it never tints the dark diffuse.
        for (let i = 0; i < CAP; i++) {
            this._colors[i * 4] = 1;
            this._colors[i * 4 + 1] = 1;
            this._colors[i * 4 + 2] = 1;
            this._colors[i * 4 + 3] = 0;
        }
        setThinInstanceColors(mesh, this._colors);
        addToScene(scene, mesh);
        this._mesh = mesh;
    }

    /**
     * Stamp a mark under each sliding rear wheel, and age existing marks.
     * @param dt Seconds since the last frame.
     * @param intensity Vehicle drift intensity (marks emit above the 0.25 gate).
     * @param wheels World-space rear-wheel contact points (two for the cars, one for the motorcycle).
     * @param fx Forward x (unit heading the marks align their length to).
     * @param fz Forward z.
     */
    update(dt: number, intensity: number, wheels: readonly WheelPoint[], fx: number, fz: number): void {
        this._clock += dt;
        // Match the trail-state count to the wheel count (it changes when swapping between the cars and the motorcycle).
        if (this._trails.length !== wheels.length) {
            this._trails = wheels.map(() => ({ x: 0, z: 0, primed: false }));
        }
        const drifting = intensity > DRIFT_THRESHOLD;
        const yaw = Math.atan2(fx, fz); // align each mark's length with the heading
        for (let i = 0; i < wheels.length; i++) {
            this._trail(this._trails[i]!, wheels[i]!.x, wheels[i]!.z, yaw, drifting);
        }
        // Age the marks toward nothing; skip the work once the newest one has fully faded.
        if (this._clock <= this._lastStamp + SKID_LIFETIME) {
            this._fade();
        }
    }

    /** Emit a stamp for one wheel if it has slid far enough since its last mark. */
    private _trail(w: WheelTrail, x: number, z: number, yaw: number, drifting: boolean): void {
        if (!drifting) {
            w.primed = false; // reset so a fresh drift doesn't bridge a long gap
            return;
        }
        if (w.primed) {
            const dx = x - w.x;
            const dz = z - w.z;
            if (dx * dx + dz * dz < STAMP_SPACING * STAMP_SPACING) {
                return; // not enough travel since the last stamp
            }
        }
        this._stamp(x, z, yaw);
        w.x = x;
        w.z = z;
        w.primed = true;
    }

    /** Write one mark into the ring buffer: a flat quad rotated to the heading. */
    private _stamp(x: number, z: number, yaw: number): void {
        const qy = Math.sin(yaw / 2);
        const qw = Math.cos(yaw / 2);
        const m = mat4Compose(x, MARK_Y, z, 0, qy, 0, qw, STAMP_WIDTH, 1, STAMP_LEN);
        const idx = this._head;
        setThinInstanceMatrix(this._mesh, idx, m);
        this._spawn[idx] = this._clock;
        this._colors[idx * 4 + 3] = 1; // fresh mark at full opacity
        this._lastStamp = this._clock;
        this._head = (idx + 1) % CAP;
    }

    /** Ramp every live mark's alpha down with age and reclaim fully-faded slots. */
    private _fade(): void {
        const hold = SKID_LIFETIME - SKID_FADE;
        for (let i = 0; i < CAP; i++) {
            const spawn = this._spawn[i]!;
            if (spawn < 0) {
                continue; // empty slot
            }
            const age = this._clock - spawn;
            let a: number;
            if (age >= SKID_LIFETIME) {
                a = 0;
                this._spawn[i] = -1; // dead — free the slot
            } else if (age <= hold) {
                a = 1;
            } else {
                a = 1 - (age - hold) / SKID_FADE;
            }
            this._colors[i * 4 + 3] = a;
        }
        setThinInstanceColors(this._mesh, this._colors);
    }
}
