/**
 * Move tool — the classic grab tool . Hover shows the SelectionBox;
 * press-and-hold drags via the Dragger (surface-aware, 1-stud snap, R/T
 * rotate); release places. No sounds — faithful to the original.
 */

import type { MouseRayEvent } from "../mouse.js";
import type { Tool, ToolContext } from "./tool.js";

const HOVER_COLOR: readonly [number, number, number] = [0.4, 0.75, 1.0];

export class MoveTool implements Tool {
    private readonly _ctx: ToolContext;
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
        this._ctx.dragger.end(); // mid-drag tool switch drops the part in place
        this._ctx.mouse.off("move", this._onMove);
        this._ctx.mouse.off("down", this._onDown);
        this._ctx.mouse.off("up", this._onUp);
        this._ctx.selectionBox.adornee = null;
    }

    private _hover(): void {
        // While dragging, the outline stays on the dragged part.
        this._ctx.selectionBox.adornee = this._ctx.dragger.active ? this._ctx.dragger.part : this._ctx.mouse.target;
    }

    private _down(e: MouseRayEvent): void {
        if (e.button !== 0 || e.consumed) {
            return;
        }
        const target = this._ctx.mouse.target;
        if (target) {
            this._ctx.dragger.begin(target);
            this._hover();
        }
    }

    private _up(): void {
        if (this._ctx.dragger.active) {
            this._ctx.dragger.end();
            this._hover();
        }
    }
}
