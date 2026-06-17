/**
 * ToolManager — binds the Toolbar to tool lifecycles .
 *
 * Exactly one active tool; switching deactivates the old tool FIRST (its
 * contract: release drags, clear adornees, unsubscribe). Esc deselection and
 * hotkeys 1–4 are handled by the Toolbar itself; this just follows
 * `onToolChange`.
 */

import type { ToolId } from "../toolbar.js";
import type { Tool } from "./tool.js";

export class ToolManager {
    private readonly _tools: Partial<Record<ToolId, Tool>>;
    private _active: Tool | null = null;

    constructor(tools: Partial<Record<ToolId, Tool>>) {
        this._tools = tools;
    }

    /** Wire this to `new Toolbar({ onToolChange })`. */
    readonly onToolChange = (id: ToolId | null): void => {
        this._active?.deactivate();
        this._active = (id && this._tools[id]) || null;
        this._active?.activate();
    };

    get activeTool(): Tool | null {
        return this._active;
    }
}
