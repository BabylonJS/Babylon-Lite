/**
 * Resize tool — classic per-face-handle resizing .
 *
 * Click an unlocked part to select it (SelectionBox + Handles); drag a handle
 * to grow/shrink along that face's normal in 1-stud increments — the opposite
 * face stays fixed, minimum size 1 stud. Each applied increment plays the
 * snap click. Clicking empty space deselects.
 */

import type { HandleDragEvent } from "../adornments/handles.js";
import type { Handles } from "../adornments/handles.js";
import type { MouseRayEvent } from "../mouse.js";
import type { Part } from "../part.js";
import { FACE_NORMALS } from "../ray-helpers.js";
import type { Tool, ToolContext } from "./tool.js";

const SELECT_COLOR: readonly [number, number, number] = [0.4, 0.75, 1.0];
const MIN_SIZE = 1;

export class ResizeTool implements Tool {
    private readonly _ctx: ToolContext;
    private readonly _handles: Handles;
    private _selected: Part | null = null;

    // Drag-base state (captured at dragStart)
    private _baseSize: [number, number, number] = [1, 1, 1];
    private _basePos: [number, number, number] = [0, 0, 0];
    private _appliedDist = 0;

    private readonly _onMove = (): void => this._hover();
    private readonly _onDown = (e: MouseRayEvent): void => this._down(e);
    private readonly _onDragStart = (): void => this._dragStart();
    private readonly _onDrag = (e: HandleDragEvent): void => this._drag(e);

    constructor(ctx: ToolContext, handles: Handles) {
        this._ctx = ctx;
        this._handles = handles;
    }

    activate(): void {
        this._ctx.selectionBox.setColor(SELECT_COLOR);
        this._ctx.mouse.on("move", this._onMove);
        this._ctx.mouse.on("down", this._onDown);
        this._handles.on("dragStart", this._onDragStart);
        this._handles.on("drag", this._onDrag);
        this._hover();
    }

    deactivate(): void {
        this._ctx.mouse.off("move", this._onMove);
        this._ctx.mouse.off("down", this._onDown);
        this._handles.off("dragStart", this._onDragStart);
        this._handles.off("drag", this._onDrag);
        this._select(null);
    }

    // ── Private ──────────────────────────────────────────────────────────

    private _select(part: Part | null): void {
        this._selected = part;
        this._ctx.selectionBox.adornee = part;
        this._handles.adornee = part;
    }

    /** Hover highlight (consistent with Move/Clone): the outline follows the
     *  hovered part, falling back to the selection. The Handles stay on the
     *  selection, so it keeps visible adornment either way. Handle drags
     *  consume move events before this runs. */
    private _hover(): void {
        this._ctx.selectionBox.adornee = this._ctx.mouse.target ?? this._selected;
    }

    private _down(e: MouseRayEvent): void {
        if (e.button !== 0 || e.consumed) {
            return; // a handle grab consumed this down
        }
        // Click a part → select it; click empty space → deselect.
        this._select(this._ctx.mouse.target);
    }

    private _dragStart(): void {
        const p = this._selected;
        if (!p) {
            return;
        }
        this._baseSize = [...p.size] as [number, number, number];
        this._basePos = [p.position.x, p.position.y, p.position.z];
        this._appliedDist = 0;
    }

    private _drag(e: HandleDragEvent): void {
        const p = this._selected;
        if (!p || p.destroyed) {
            return;
        }
        const n = FACE_NORMALS[e.face];
        const worldAxis = (n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2) as 0 | 1 | 2;
        // Handles live on WORLD AABB faces; `size` is LOCAL. Map through the
        // part's rotation so a rotated part grows along the face you dragged.
        const localAxis = p.localAxisFor(worldAxis);

        // Clamp the requested travel so the size never drops below 1 stud.
        const dist = Math.max(e.distanceStuds, MIN_SIZE - this._baseSize[localAxis]!);
        if (dist === this._appliedDist) {
            return;
        }
        this._appliedDist = dist;

        const size: [number, number, number] = [...this._baseSize] as [number, number, number];
        size[localAxis] = this._baseSize[localAxis]! + dist;
        // The dragged face moves; the opposite face stays fixed.
        const sign = n[0] + n[1] + n[2]; // ±1
        // The dragged WORLD face moves; the opposite face stays fixed.
        const pos = {
            x: this._basePos[0]!,
            y: this._basePos[1]!,
            z: this._basePos[2]!,
        };
        if (worldAxis === 0) {
            pos.x += (sign * dist) / 2;
        } else if (worldAxis === 1) {
            pos.y += (sign * dist) / 2;
        } else {
            pos.z += (sign * dist) / 2;
        }
        p.setSize(size);
        p.setPosition(pos);
        this._ctx.sounds.playResizeClick();
    }
}
