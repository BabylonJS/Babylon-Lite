/**
 * Mouse — the single shared picking service. Tracks `target` (part under
 * cursor), `targetSurface` (face),
 * `hit` (world point), refreshed from DOM pointer events via the Workspace
 * raycast. The ONLY owner of tool-related DOM listeners; Parts and tools
 * never touch the DOM.
 *
 * Locked parts are never targeted . A `filter` lets the Dragger
 * exclude the part being dragged. Down-handlers run in registration order
 * and may set `consumed` to stop later handlers (Handles register before
 * tools).
 */

import type { SceneContext } from "babylon-lite";

import type { Part } from "./part.js";
import type { FaceId, Ray } from "./ray-helpers.js";
import { screenRay } from "./ray-helpers.js";
import type { Workspace } from "./workspace.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MouseRayEvent {
    readonly ray: Ray | null;
    readonly cssX: number;
    readonly cssY: number;
    readonly button: number;
    readonly domEvent: MouseEvent;
    /** Set true to stop later handlers (e.g. a Handles grab beats the tool). */
    consumed: boolean;
}

export type MouseEventName = "down" | "up" | "move";

// ── Mouse ────────────────────────────────────────────────────────────────────

export class Mouse {
    /** Unlocked part under the cursor, or null. */
    target: Part | null = null;
    /** Face of `target` under the cursor. */
    targetSurface: FaceId | null = null;
    /** World point under the cursor (on `target`), or null. */
    hit: readonly [number, number, number] | null = null;

    /** Extra per-part filter (return false to make a part untargetable). */
    filter: ((part: Part) => boolean) | null = null;

    private readonly _workspace: Workspace<Part>;
    private readonly _scene: SceneContext;
    private readonly _canvas: HTMLCanvasElement;
    private readonly _handlers = new Map<MouseEventName, Set<(e: MouseRayEvent) => void>>();
    private _lastCssX = 0;
    private _lastCssY = 0;

    private readonly _onMouseDown: (e: MouseEvent) => void;
    private readonly _onMouseUp: (e: MouseEvent) => void;
    private readonly _onMouseMove: (e: MouseEvent) => void;

    constructor(workspace: Workspace<Part>, scene: SceneContext, canvas: HTMLCanvasElement) {
        this._workspace = workspace;
        this._scene = scene;
        this._canvas = canvas;

        this._onMouseDown = (e) => this._dispatch("down", e);
        this._onMouseUp = (e) => this._dispatch("up", e);
        this._onMouseMove = (e) => this._dispatch("move", e);

        canvas.addEventListener("mousedown", this._onMouseDown);
        window.addEventListener("mouseup", this._onMouseUp);
        canvas.addEventListener("mousemove", this._onMouseMove);
    }

    on(event: MouseEventName, handler: (e: MouseRayEvent) => void): void {
        let set = this._handlers.get(event);
        if (!set) {
            set = new Set();
            this._handlers.set(event, set);
        }
        set.add(handler);
    }

    off(event: MouseEventName, handler: (e: MouseRayEvent) => void): void {
        this._handlers.get(event)?.delete(handler);
    }

    /** Re-run the pick at the last known cursor position (e.g. after the
     *  camera moved or a part was created/destroyed under the cursor). */
    refresh(): void {
        this._pick(this._lastCssX, this._lastCssY);
    }

    dispose(): void {
        this._canvas.removeEventListener("mousedown", this._onMouseDown);
        window.removeEventListener("mouseup", this._onMouseUp);
        this._canvas.removeEventListener("mousemove", this._onMouseMove);
        this._handlers.clear();
    }

    // ── Private ──────────────────────────────────────────────────────────

    private _pick(cssX: number, cssY: number): Ray | null {
        this._lastCssX = cssX;
        this._lastCssY = cssY;
        const ray = screenRay(cssX, cssY, this._scene, this._canvas);
        if (!ray) {
            this.target = null;
            this.targetSurface = null;
            this.hit = null;
            return null;
        }
        let hit = this._workspace.raycast(ray);
        if (hit && this.filter && !this.filter(hit.part)) {
            // Re-raycast ignoring filtered parts (rare path; lists stay tiny).
            const ignore = this._workspace.parts.filter((p) => this.filter && !this.filter(p));
            hit = this._workspace.raycast(ray, { ignore });
        }
        this.target = hit?.part ?? null;
        this.targetSurface = hit?.face ?? null;
        this.hit = hit?.point ?? null;
        return ray;
    }

    private _dispatch(event: MouseEventName, e: MouseEvent): void {
        const rect = this._canvas.getBoundingClientRect();
        const cssX = e.clientX - rect.left;
        const cssY = e.clientY - rect.top;
        const ray = this._pick(cssX, cssY);
        const payload: MouseRayEvent = { ray, cssX, cssY, button: e.button, domEvent: e, consumed: false };
        const set = this._handlers.get(event);
        if (set) {
            for (const h of set) {
                h(payload);
                if (payload.consumed) {
                    break;
                }
            }
        }
    }
}
