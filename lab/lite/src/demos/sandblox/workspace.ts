/**
 * Workspace — the single registry of every Part in the world.
 *
 * Owns all world objects in one registry and provides one
 * raycast query surface for tools, one collision source for the character.
 * Entries are anything Part-shaped (`WorkspaceEntry`); the full Part class
 * lands in T-05 and implements it.
 *
 * Locked entries (e.g. the baseplate) are excluded from raycasts by default —
 * tools never see them — but always present in `parts` for collision.
 */

import type { AABB, FaceId, Ray } from "./ray-helpers.js";
import { rayAABBFaceHit } from "./ray-helpers.js";
import type { RigidBody } from "./rigid-body.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Minimal shape the Workspace needs from a world object. */
export interface WorkspaceEntry extends RigidBody {
    readonly locked: boolean;
}

export interface WorkspaceRaycastOptions<P extends WorkspaceEntry> {
    /** Entries to skip (e.g. the part currently being dragged). */
    readonly ignore?: readonly P[];
    /** Include locked entries (baseplate) as hit candidates. Default false. */
    readonly includeLocked?: boolean;
}

export interface WorkspaceRaycastHit<P extends WorkspaceEntry> {
    readonly part: P;
    readonly face: FaceId;
    readonly point: readonly [number, number, number];
    readonly distance: number;
}

export type WorkspaceEvent = "partAdded" | "partRemoved";

// ── Workspace ────────────────────────────────────────────────────────────────

export class Workspace<P extends WorkspaceEntry = WorkspaceEntry> {
    private readonly _parts: P[] = [];
    private readonly _handlers = new Map<WorkspaceEvent, Set<(part: P) => void>>();

    /** Live list of every entry, locked included. Do not mutate. */
    get parts(): readonly P[] {
        return this._parts;
    }

    add(part: P): void {
        if (this._parts.includes(part)) {
            return;
        }
        this._parts.push(part);
        this._emit("partAdded", part);
    }

    remove(part: P): void {
        const i = this._parts.indexOf(part);
        if (i < 0) {
            return;
        }
        this._parts.splice(i, 1);
        this._emit("partRemoved", part);
    }

    on(event: WorkspaceEvent, handler: (part: P) => void): void {
        let set = this._handlers.get(event);
        if (!set) {
            set = new Set();
            this._handlers.set(event, set);
        }
        set.add(handler);
    }

    off(event: WorkspaceEvent, handler: (part: P) => void): void {
        this._handlers.get(event)?.delete(handler);
    }

    /**
     * Nearest ray hit against entry AABBs, with face identification.
     * Locked entries are skipped unless `includeLocked` is set.
     */
    raycast(ray: Ray, opts?: WorkspaceRaycastOptions<P>): WorkspaceRaycastHit<P> | null {
        let best: WorkspaceRaycastHit<P> | null = null;
        for (const part of this._parts) {
            if (part.locked && !opts?.includeLocked) {
                continue;
            }
            if (opts?.ignore && opts.ignore.includes(part)) {
                continue;
            }
            const hit = rayAABBFaceHit(ray, part.getAABB() as AABB);
            if (!hit) {
                continue;
            }
            if (!best || hit.t < best.distance) {
                best = {
                    part,
                    face: hit.face,
                    distance: hit.t,
                    point: [ray.origin[0] + ray.dir[0] * hit.t, ray.origin[1] + ray.dir[1] * hit.t, ray.origin[2] + ray.dir[2] * hit.t],
                };
            }
        }
        return best;
    }

    private _emit(event: WorkspaceEvent, part: P): void {
        const set = this._handlers.get(event);
        if (set) {
            for (const h of set) {
                h(part);
            }
        }
    }
}
