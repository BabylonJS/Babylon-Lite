/**
 * Toolbar — build-tool overlay.
 *
 * Creates a horizontal DOM toolbar at the top of the viewport with four tool
 * buttons (Move, Clone, Delete, Resize). Supports keyboard shortcuts (1–4,
 * Escape to deselect) and mouse click-to-toggle. The toolbar never steals
 * focus from the canvas so WASD input keeps working.
 *
 * All styling is injected via a single <style> element — no external CSS.
 */

// ── Public types ─────────────────────────────────────────────────────────────

export type ToolId = "move" | "clone" | "delete" | "resize" | "paint";

// ── SVG icons (24×24 viewBox, stroke-based) ──────────────────────────────────

/** Four-directional arrow cross — move / drag. */
const ICON_MOVE = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"',
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '<path d="M12 2v20M2 12h20"/>',
    '<path d="M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3"/>',
    "</svg>",
].join("");

/** Two overlapping rounded rectangles — clone / duplicate. */
const ICON_CLONE = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"',
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '<rect x="9" y="9" width="13" height="13" rx="2"/>',
    '<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
    "</svg>",
].join("");

/** Hammer / mallet — delete tool. */
const ICON_DELETE = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"',
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '<rect x="4" y="2" width="16" height="8" rx="2"/>',
    '<path d="M10 10v11a1 1 0 001 1h2a1 1 0 001-1V10"/>',
    "</svg>",
].join("");

/** Paint drop — classic paint bucket. */
const ICON_PAINT = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"',
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '<path d="M12 2.7s6.5 7.6 6.5 12a6.5 6.5 0 01-13 0c0-4.4 6.5-12 6.5-12z"/>',
    "</svg>",
].join("");

/** Diagonal expand arrows — resize / scale. */
const ICON_RESIZE = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"',
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    "</svg>",
].join("");

// ── Tool definitions ─────────────────────────────────────────────────────────

interface ToolDef {
    readonly id: ToolId;
    readonly label: string;
    readonly hotkey: string;
    readonly icon: string;
}

const TOOLS: readonly ToolDef[] = [
    { id: "move", label: "Move", hotkey: "1", icon: ICON_MOVE },
    { id: "clone", label: "Clone", hotkey: "2", icon: ICON_CLONE },
    { id: "resize", label: "Resize", hotkey: "3", icon: ICON_RESIZE },
    { id: "delete", label: "Delete", hotkey: "4", icon: ICON_DELETE },
    { id: "paint", label: "Paint", hotkey: "5", icon: ICON_PAINT },
];

const HOTKEY_TO_TOOL: Readonly<Record<string, ToolId>> = {
    Digit1: "move",
    Digit2: "clone",
    Digit3: "resize",
    Digit4: "delete",
    Digit5: "paint",
};

// ── Injected CSS ─────────────────────────────────────────────────────────────

const CSS = `
.sandblox-toolbar {
    position: fixed;
    bottom: 5px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 5px;
    z-index: 1000;
    user-select: none;
    -webkit-user-select: none;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

.sandblox-tool-btn {
    position: relative;
    width: 60px;
    height: 60px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    border: none;
    border-radius: 0;
    background: rgba(60, 60, 60, 0.6);
    cursor: pointer;
    transition: background 0.1s ease;
    color: rgba(200, 200, 200, 1.0);
    padding: 0;
    outline: none;
}

.sandblox-tool-btn svg {
    width: 36px;
    height: 36px;
    pointer-events: none;
}

.sandblox-tool-btn.sandblox-active {
    box-shadow: inset 0 0 0 5px rgba(0, 140, 220, 1.0);
}

.sandblox-tool-hotkey {
    position: absolute;
    top: 1px;
    left: 1px;
    font-size: 12px;
    font-family: monospace;
    line-height: 1;
    pointer-events: none;
}

@media (max-width: 480px) {
    .sandblox-tool-btn {
        width: 50px;
        height: 50px;
    }
    .sandblox-tool-btn svg {
        width: 30px;
        height: 30px;
    }
}
`;

// ── Toolbar class ────────────────────────────────────────────────────────────

export class Toolbar {
    private _activeTool: ToolId | null = null;
    private readonly _buttons = new Map<ToolId, HTMLButtonElement>();
    private readonly _root: HTMLElement;
    private readonly _style: HTMLStyleElement;
    private readonly _onKeyDown: (e: KeyboardEvent) => void;
    private readonly _onToolChange: ((tool: ToolId | null) => void) | null;

    constructor(options?: { onToolChange?: (tool: ToolId | null) => void }) {
        this._onToolChange = options?.onToolChange ?? null;

        // Inject scoped styles
        this._style = document.createElement("style");
        this._style.textContent = CSS;
        document.head.appendChild(this._style);

        // Build toolbar DOM
        this._root = document.createElement("div");
        this._root.className = "sandblox-toolbar";
        this._root.setAttribute("role", "toolbar");
        this._root.setAttribute("aria-label", "Build tools");

        for (const tool of TOOLS) {
            const btn = document.createElement("button");
            btn.className = "sandblox-tool-btn";
            btn.setAttribute("aria-label", `${tool.label} (${tool.hotkey})`);
            btn.setAttribute("data-tool", tool.id);
            btn.innerHTML = tool.icon + `<span class="sandblox-tool-hotkey">${tool.hotkey}</span>`;

            // Prevent focus theft so canvas keeps receiving WASD input
            btn.addEventListener("mousedown", (e: MouseEvent) => {
                e.preventDefault();
                this._toggle(tool.id);
            });

            this._buttons.set(tool.id, btn);
            this._root.appendChild(btn);
        }

        document.body.appendChild(this._root);

        // Keyboard shortcuts (1–5 toggle, Escape deselect)
        this._onKeyDown = (e: KeyboardEvent): void => {
            if (e.repeat) return;
            const mapped = HOTKEY_TO_TOOL[e.code];
            if (mapped) {
                this._toggle(mapped);
            } else if (e.code === "Escape" && this._activeTool !== null) {
                this.selectTool(null);
            }
        };
        window.addEventListener("keydown", this._onKeyDown);
    }

    /** The currently selected tool, or `null` if no tool is active. */
    get activeTool(): ToolId | null {
        return this._activeTool;
    }

    /** Programmatically select a tool (or pass `null` to deselect). */
    selectTool(id: ToolId | null): void {
        if (id === this._activeTool) return;

        if (this._activeTool !== null) {
            this._buttons.get(this._activeTool)?.classList.remove("sandblox-active");
        }
        if (id !== null) {
            this._buttons.get(id)?.classList.add("sandblox-active");
        }

        this._activeTool = id;
        this._onToolChange?.(id);
    }

    /** Remove all DOM elements and event listeners. */
    dispose(): void {
        window.removeEventListener("keydown", this._onKeyDown);
        this._root.remove();
        this._style.remove();
    }

    private _toggle(id: ToolId): void {
        this.selectTool(this._activeTool === id ? null : id);
    }
}
