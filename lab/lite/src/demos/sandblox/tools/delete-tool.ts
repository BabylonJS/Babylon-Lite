/**
 * Delete tool — the classic hammer . Hover shows a red SelectionBox;
 * clicking an unlocked part destroys it with the explosion sound. The
 * baseplate is immune (locked parts are never Mouse targets).
 */

import type { MouseRayEvent } from "../mouse.js";
import type { Tool, ToolContext } from "./tool.js";

const HOVER_COLOR: readonly [number, number, number] = [1.0, 0.35, 0.3];

export class DeleteTool implements Tool {
    private readonly _ctx: ToolContext;
    private readonly _onMove = (): void => this._hover();
    private readonly _onDown = (e: MouseRayEvent): void => this._down(e);

    constructor(ctx: ToolContext) {
        this._ctx = ctx;
    }

    activate(): void {
        this._ctx.selectionBox.setColor(HOVER_COLOR);
        this._ctx.mouse.on("move", this._onMove);
        this._ctx.mouse.on("down", this._onDown);
        this._hover();
    }

    deactivate(): void {
        this._ctx.mouse.off("move", this._onMove);
        this._ctx.mouse.off("down", this._onDown);
        this._ctx.selectionBox.adornee = null;
    }

    private _hover(): void {
        this._ctx.selectionBox.adornee = this._ctx.mouse.target;
    }

    private _down(e: MouseRayEvent): void {
        if (e.button !== 0 || e.consumed) {
            return;
        }
        const target = this._ctx.mouse.target;
        if (target) {
            target.destroy();
            this._ctx.sounds.playDeleteExplosion();
            this._ctx.mouse.refresh();
            this._hover();
        }
    }
}
