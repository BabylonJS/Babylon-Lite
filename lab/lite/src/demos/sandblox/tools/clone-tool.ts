/**
 * Clone tool : press on a part and a duplicate
 * spawns perched on top of the column above it (repeat-clicking builds a
 * tower), already grabbed — drag while holding to place
 * it wherever you like, release to drop. Same hold-drag feel as the Move
 * tool. Esc / tool switch mid-hold cancels and destroys the unplaced clone.
 * Plays the ~900 Hz ping on spawn.
 */

import type { MouseRayEvent } from "../mouse.js";
import type { Part } from "../part.js";
import type { Workspace } from "../workspace.js";
import type { Tool, ToolContext } from "./tool.js";

const HOVER_COLOR: readonly [number, number, number] = [0.4, 0.75, 1.0];

/** Build marker (also used by live verification). */
export const CLONE_TOOL_REV = "clone-rev-stacking-1";

/**
 * The highest part top in the column above `base`'s XZ footprint (≥ the
 * base's own top). Repeated clicks therefore stack a tower instead of piling
 * clones into the same spot. Strict inequalities so edge-touching neighbors
 * don't count as overlap.
 */
export function columnTopAbove(workspace: Workspace<Part>, base: Part, exclude: Part | null): number {
    const b = base.getAABB();
    let top = b.maxY;
    for (const p of workspace.parts) {
        if (p === base || p === exclude || p.locked) {
            continue;
        }
        const pb = p.getAABB();
        if (pb.minX < b.maxX && pb.maxX > b.minX && pb.minZ < b.maxZ && pb.maxZ > b.minZ && pb.maxY > top) {
            top = pb.maxY;
        }
    }
    return top;
}

export class CloneTool implements Tool {
    private readonly _ctx: ToolContext;
    private _carrying: Part | null = null;
    private readonly _onMove = (): void => this._hover();
    private readonly _onDown = (e: MouseRayEvent): void => this._down(e);
    private readonly _onUp = (): void => this._up();

    constructor(ctx: ToolContext) {
        this._ctx = ctx;
    }

    activate(): void {
        this._ctx.selectionBox.setColor(HOVER_COLOR);
        this._ctx.mouse.on("move", this._onMove);
        this._ctx.mouse.on("down", this._onDown);
        this._ctx.mouse.on("up", this._onUp);
        this._hover();
    }

    deactivate(): void {
        if (this._carrying) {
            // An unplaced (still-held) clone vanishes on cancel.
            this._ctx.dragger.cancel();
            this._carrying.destroy();
            this._carrying = null;
        }
        this._ctx.mouse.off("move", this._onMove);
        this._ctx.mouse.off("down", this._onDown);
        this._ctx.mouse.off("up", this._onUp);
        this._ctx.selectionBox.adornee = null;
    }

    private _hover(): void {
        this._ctx.selectionBox.adornee = this._carrying ?? this._ctx.mouse.target;
    }

    private _down(e: MouseRayEvent): void {
        if (e.button !== 0 || e.consumed) {
            return;
        }
        const target = this._ctx.mouse.target;
        if (target) {
            this._carrying = target.clone();
            // Spawn perched on top of the COLUMN above the base — repeated
            // clicks build a tower. The Dragger carries it with the held
            // cursor from the first mouse move.
            const b = target.getAABB();
            const height = b.maxY - b.minY;
            const top = columnTopAbove(this._ctx.workspace, target, this._carrying);
            this._carrying.setPosition({ x: target.position.x, y: top + height / 2, z: target.position.z });
            this._ctx.sounds.playClonePing();
            this._ctx.dragger.begin(this._carrying);
            this._hover();
        }
    }

    private _up(): void {
        if (this._carrying) {
            this._ctx.dragger.end();
            this._carrying = null;
            this._ctx.mouse.refresh();
            this._hover();
        }
    }
}
