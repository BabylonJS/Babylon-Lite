/**
 * Dragger — grid-snapped grab-and-move logic shared by the
 * Move tool (hold-drag) and Clone tool (click-carry).
 *
 * Faithful behaviors:
 *   - The part follows whatever surface is under the cursor (Workspace
 *     raycast ignoring the dragged part, locked parts INCLUDED — you drag
 *     onto the baseplate), resting against the hit face.
 *   - 1-stud grid snap on the face-tangent axes: even extents snap centers to
 *     integers, odd extents to half-integers (n + 0.5).
 *   - R rotates 90° (yaw), T tilts 90° (pitch) mid-drag; the part re-seats
 *     using its new extents.
 *
 * The tool decides when the drag ends (`end()` on mouse-up for Move, on the
 * placing click for Clone). `cancel()` releases without any extra placement.
 */

import type { Mouse, MouseRayEvent } from "./mouse.js";
import type { Part } from "./part.js";
import type { FaceId } from "./ray-helpers.js";
import { FACE_NORMALS } from "./ray-helpers.js";
import type { Workspace } from "./workspace.js";

// ── Pure placement math (unit-tested) ────────────────────────────────────────

/** Baseplate half-extent in studs (XZ clamp). */
export const BASEPLATE_HALF = 256;

/** Snap a center coordinate to the 1-stud grid for a given full extent:
 *  even extents → integer centers, odd → half-integer centers. */
export function snapAxis(value: number, extent: number): number {
    if (Math.round(extent) % 2 === 0) {
        return Math.round(value);
    }
    return Math.floor(value) + 0.5;
}

/**
 * Compute the snapped center position for a part resting against `face` of
 * whatever surface was hit at `point`. `extents` are the part's full
 * post-rotation world extents (AABB max − min).
 */
export function computeDragPlacement(extents: readonly [number, number, number], face: FaceId, point: readonly [number, number, number]): { x: number; y: number; z: number } {
    const n = FACE_NORMALS[face];
    const out = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
        const sign = axis === 0 ? n[0] : axis === 1 ? n[1] : n[2];
        if (sign !== 0) {
            // Rest against the surface along the face normal. Hit faces lie on
            // stud boundaries; round off ray float dust so saves stay clean.
            out[axis] = Math.round((point[axis]! + sign * (extents[axis]! / 2)) * 1e4) / 1e4;
        } else {
            out[axis] = snapAxis(point[axis]!, extents[axis]!);
        }
    }
    // Keep the part on the baseplate (XZ only).
    out[0] = Math.max(-BASEPLATE_HALF + extents[0]! / 2, Math.min(BASEPLATE_HALF - extents[0]! / 2, out[0]!));
    out[2] = Math.max(-BASEPLATE_HALF + extents[2]! / 2, Math.min(BASEPLATE_HALF - extents[2]! / 2, out[2]!));
    return { x: out[0]!, y: out[1]!, z: out[2]! };
}

/** Full extents from a part's current AABB. */
export function partExtents(part: Part): [number, number, number] {
    const b = part.getAABB();
    return [b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ];
}

// ── Dragger ──────────────────────────────────────────────────────────────────

export class Dragger {
    private readonly _workspace: Workspace<Part>;
    private readonly _mouse: Mouse;
    private _part: Part | null = null;
    private _lastFace: FaceId | null = null;
    private _lastPoint: readonly [number, number, number] | null = null;

    private readonly _onMove = (e: MouseRayEvent): void => this._handleMove(e);
    private readonly _onKeyDown = (e: KeyboardEvent): void => this._handleKey(e);

    constructor(workspace: Workspace<Part>, mouse: Mouse) {
        this._workspace = workspace;
        this._mouse = mouse;
    }

    get active(): boolean {
        return this._part !== null;
    }

    get part(): Part | null {
        return this._part;
    }

    /** Grab a part. It follows the cursor until `end()` or `cancel()`. */
    begin(part: Part): void {
        if (this._part) {
            this.end();
        }
        this._part = part;
        this._mouse.on("move", this._onMove);
        window.addEventListener("keydown", this._onKeyDown);
    }

    /** Release the part where it is. Returns it (null if no drag active). */
    end(): Part | null {
        const part = this._part;
        this._release();
        return part;
    }

    /** Release without keeping a reference (caller may destroy the part). */
    cancel(): void {
        this._release();
    }

    // ── Private ──────────────────────────────────────────────────────────

    private _release(): void {
        if (!this._part) {
            return;
        }
        this._part = null;
        this._lastFace = null;
        this._lastPoint = null;
        this._mouse.off("move", this._onMove);
        window.removeEventListener("keydown", this._onKeyDown);
    }

    private _handleMove(e: MouseRayEvent): void {
        if (!this._part || this._part.destroyed || !e.ray) {
            return;
        }
        const hit = this._workspace.raycast(e.ray, { ignore: [this._part], includeLocked: true });
        if (!hit) {
            return; // cursor in the sky — part keeps its last position
        }
        this._lastFace = hit.face;
        this._lastPoint = hit.point;
        this._reseat();
    }

    private _handleKey(e: KeyboardEvent): void {
        if (!this._part || this._part.destroyed) {
            return;
        }
        if (e.code === "KeyR" || e.code === "KeyT") {
            e.preventDefault();
            this._part.rotate90(e.code === "KeyR" ? "y" : "x");
            this._reseat(); // new extents → re-snap against the same surface
        }
    }

    private _reseat(): void {
        if (!this._part || !this._lastFace || !this._lastPoint) {
            return;
        }
        this._part.setPosition(computeDragPlacement(partExtents(this._part), this._lastFace, this._lastPoint));
    }
}
