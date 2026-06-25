/**
 * Part — the atomic world object. Plain properties define size, position,
 * rotation, color, and lock state. Rendering goes through the shared PartRenderer (thin instances);
 * picking goes through the Workspace raycast; pointer behavior lives in tools.
 *
 * Every mutation funnels through the setters — the single choke point keeps
 * persistence and a future undo command stack trivial. `onChange`
 * lets adornments (SelectionBox, Handles) track their adornee.
 */

import type { AllocOptions, InstanceHandle, PartRenderer } from "./part-renderer.js";
import { allocInstance, freeInstance, writeColor, writeInstance } from "./part-renderer.js";
import type { RigidBodyAABB } from "./rigid-body.js";
import type { Workspace } from "./workspace.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PartOptions {
    /** Full extents in studs [x, y, z], each ≥ 1. Default [2, 1, 1]. */
    size?: readonly [number, number, number];
    /** Center position in studs. Default origin. */
    position?: { readonly x: number; readonly y: number; readonly z: number };
    /** Diffuse color [r, g, b] in 0–1. */
    color?: readonly [number, number, number];
    /** Locked parts are invisible to tools but still collide. Default false. */
    locked?: boolean;
    /** Casts shadows unless explicitly false; false renders on the receiver-only mesh (baseplate). Default true. */
    castShadows?: boolean;
    /** Geometry: block or wedge (sloped, stud-free). Default "block". */
    shape?: "block" | "wedge";
}

export type PartShape = "block" | "wedge";

interface Quat {
    x: number;
    y: number;
    z: number;
    w: number;
}

const MIN_SIZE = 1;

// ── Part ─────────────────────────────────────────────────────────────────────

export class Part {
    readonly locked: boolean;
    readonly shape: PartShape;

    private readonly _renderer: PartRenderer;
    private readonly _workspace: Workspace<Part>;
    private readonly _handle: InstanceHandle;
    private _size: [number, number, number];
    private readonly _position: { x: number; y: number; z: number };
    private readonly _quat: Quat = { x: 0, y: 0, z: 0, w: 1 };
    private _color: [number, number, number];
    private _destroyed = false;
    private readonly _changeHandlers = new Set<() => void>();

    constructor(renderer: PartRenderer, workspace: Workspace<Part>, options: PartOptions = {}) {
        this._renderer = renderer;
        this._workspace = workspace;
        this.locked = options.locked ?? false;
        this.shape = options.shape ?? "block";
        this._size = [...(options.size ?? [2, 1, 1])] as [number, number, number];
        this._position = { x: options.position?.x ?? 0, y: options.position?.y ?? 0, z: options.position?.z ?? 0 };
        this._color = [...(options.color ?? [0.16, 0.5, 0.73])] as [number, number, number];

        const alloc: AllocOptions = { receiverOnly: options.castShadows === false, shape: this.shape };
        this._handle = allocInstance(renderer, alloc);
        this._writeTransform();
        writeColor(renderer, this._handle, this._color);
        workspace.add(this);
    }

    // ── Properties ───────────────────────────────────────────────────────

    get size(): readonly [number, number, number] {
        return this._size;
    }

    get position(): { readonly x: number; readonly y: number; readonly z: number } {
        return this._position;
    }

    get rotation(): { readonly x: number; readonly y: number; readonly z: number; readonly w: number } {
        return this._quat;
    }

    get color(): readonly [number, number, number] {
        return this._color;
    }

    get destroyed(): boolean {
        return this._destroyed;
    }

    // ── Mutations (single choke point — keep all writes in here) ─────────

    setSize(size: readonly [number, number, number]): void {
        this._size = [Math.max(MIN_SIZE, size[0]), Math.max(MIN_SIZE, size[1]), Math.max(MIN_SIZE, size[2])];
        this._writeTransform();
        this._emitChange();
    }

    setPosition(p: { readonly x: number; readonly y: number; readonly z: number }): void {
        this._position.x = p.x;
        this._position.y = p.y;
        this._position.z = p.z;
        this._writeTransform();
        this._emitChange();
    }

    /** Rotate 90° about a world axis ("y" = R key yaw, "x" = T key tilt). */
    rotate90(axis: "y" | "x"): void {
        const h = Math.SQRT1_2;
        const step: Quat = axis === "y" ? { x: 0, y: h, z: 0, w: h } : { x: h, y: 0, z: 0, w: h };
        // World-axis rotation pre-multiplies: q' = step * q
        const q = this._quat;
        const nx = step.w * q.x + step.x * q.w + step.y * q.z - step.z * q.y;
        const ny = step.w * q.y - step.x * q.z + step.y * q.w + step.z * q.x;
        const nz = step.w * q.z + step.x * q.y - step.y * q.x + step.z * q.w;
        const nw = step.w * q.w - step.x * q.x - step.y * q.y - step.z * q.z;
        q.x = nx;
        q.y = ny;
        q.z = nz;
        q.w = nw;
        this._writeTransform();
        this._emitChange();
    }

    /** Restore an exact rotation (persistence). Values must be a 90°-step quat. */
    setRotation(q: { readonly x: number; readonly y: number; readonly z: number; readonly w: number }): void {
        this._quat.x = q.x;
        this._quat.y = q.y;
        this._quat.z = q.z;
        this._quat.w = q.w;
        this._writeTransform();
        this._emitChange();
    }

    setColor(color: readonly [number, number, number]): void {
        this._color = [...color] as [number, number, number];
        writeColor(this._renderer, this._handle, this._color);
        this._emitChange();
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    /** Duplicate this part (same size/rotation/color/position), added to the Workspace. */
    clone(): Part {
        const copy = new Part(this._renderer, this._workspace, {
            size: this._size,
            position: this._position,
            color: this._color,
            shape: this.shape,
        });
        copy._quat.x = this._quat.x;
        copy._quat.y = this._quat.y;
        copy._quat.z = this._quat.z;
        copy._quat.w = this._quat.w;
        copy._writeTransform();
        return copy;
    }

    /** Remove from the world. Safe to call while adorned/dragged — the
     *  Workspace emits `partRemoved` so holders can reset. Idempotent. */
    destroy(): void {
        if (this._destroyed) {
            return;
        }
        this._destroyed = true;
        freeInstance(this._renderer, this._handle);
        this._workspace.remove(this);
        this._emitChange();
        this._changeHandlers.clear();
    }

    /**
     * The local size axis currently aligned with a world axis (0=X 1=Y 2=Z).
     * Exact for 90°-step rotations: |R[world][local]| is 1 for exactly one
     * local axis per world axis. Resize handles live on world AABB faces but
     * `size` is local — this is the bridge (see resize-tool.ts).
     */
    localAxisFor(worldAxis: 0 | 1 | 2): 0 | 1 | 2 {
        const q = this._quat;
        const rows: [number, number, number][] = [
            [Math.abs(1 - 2 * (q.y * q.y + q.z * q.z)), Math.abs(2 * (q.x * q.y - q.w * q.z)), Math.abs(2 * (q.x * q.z + q.w * q.y))],
            [Math.abs(2 * (q.x * q.y + q.w * q.z)), Math.abs(1 - 2 * (q.x * q.x + q.z * q.z)), Math.abs(2 * (q.y * q.z - q.w * q.x))],
            [Math.abs(2 * (q.x * q.z - q.w * q.y)), Math.abs(2 * (q.y * q.z + q.w * q.x)), Math.abs(1 - 2 * (q.x * q.x + q.y * q.y))],
        ];
        const row = rows[worldAxis]!;
        if (row[0] >= row[1] && row[0] >= row[2]) {
            return 0;
        }
        return row[1] >= row[2] ? 1 : 2;
    }

    // ── Collision / picking ──────────────────────────────────────────────

    getAABB(): RigidBodyAABB {
        // 90°-step rotations keep the box axis-aligned: world half-extents are
        // the size components permuted by the rotation. abs(R)·(size/2) covers
        // every step rotation exactly.
        const q = this._quat;
        const r00 = Math.abs(1 - 2 * (q.y * q.y + q.z * q.z));
        const r01 = Math.abs(2 * (q.x * q.y - q.w * q.z));
        const r02 = Math.abs(2 * (q.x * q.z + q.w * q.y));
        const r10 = Math.abs(2 * (q.x * q.y + q.w * q.z));
        const r11 = Math.abs(1 - 2 * (q.x * q.x + q.z * q.z));
        const r12 = Math.abs(2 * (q.y * q.z - q.w * q.x));
        const r20 = Math.abs(2 * (q.x * q.z - q.w * q.y));
        const r21 = Math.abs(2 * (q.y * q.z + q.w * q.x));
        const r22 = Math.abs(1 - 2 * (q.x * q.x + q.y * q.y));
        const hx = (r00 * this._size[0] + r01 * this._size[1] + r02 * this._size[2]) / 2;
        const hy = (r10 * this._size[0] + r11 * this._size[1] + r12 * this._size[2]) / 2;
        const hz = (r20 * this._size[0] + r21 * this._size[1] + r22 * this._size[2]) / 2;
        return {
            minX: this._position.x - hx,
            minY: this._position.y - hy,
            minZ: this._position.z - hz,
            maxX: this._position.x + hx,
            maxY: this._position.y + hy,
            maxZ: this._position.z + hz,
        };
    }

    // ── Change tracking (adornments, persistence) ────────────────────────

    onChange(handler: () => void): void {
        this._changeHandlers.add(handler);
    }

    offChange(handler: () => void): void {
        this._changeHandlers.delete(handler);
    }

    // ── Private ──────────────────────────────────────────────────────────

    private _writeTransform(): void {
        writeInstance(this._renderer, this._handle, this._position, this._quat, this._size);
    }

    private _emitChange(): void {
        for (const h of this._changeHandlers) {
            h();
        }
    }
}
