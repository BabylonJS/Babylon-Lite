/**
 * Paint tool. Hover shows the SelectionBox
 * tinted with the active palette color; clicking an unlocked part applies it.
 * Silent, like the classic Move tool — classic paint had no signature sound.
 *
 * The palette is a toolbar-styled swatch grid that exists only while the tool
 * is active. The
 * classic 14: the brights, the grays, and the earth tones every 2008 build
 * was made of.
 */

import type { MouseRayEvent } from "../mouse.js";
import type { Tool, ToolContext } from "./tool.js";

export interface PaletteColor {
    readonly name: string;
    readonly rgb: readonly [number, number, number];
}

/** Default block palette (sRGB 0-255, normalized). */
export const CLASSIC_PALETTE: readonly PaletteColor[] = [
    { name: "Bright red", rgb: [196 / 255, 40 / 255, 28 / 255] },
    { name: "Bright orange", rgb: [218 / 255, 133 / 255, 65 / 255] },
    { name: "Bright yellow", rgb: [245 / 255, 205 / 255, 48 / 255] },
    { name: "Bright green", rgb: [75 / 255, 151 / 255, 75 / 255] },
    { name: "Bright blue", rgb: [13 / 255, 105 / 255, 172 / 255] },
    { name: "Bright violet", rgb: [107 / 255, 50 / 255, 124 / 255] },
    { name: "White", rgb: [242 / 255, 243 / 255, 243 / 255] },
    { name: "Brick yellow", rgb: [215 / 255, 197 / 255, 154 / 255] },
    { name: "Light stone grey", rgb: [229 / 255, 228 / 255, 223 / 255] },
    { name: "Medium stone grey", rgb: [163 / 255, 162 / 255, 165 / 255] },
    { name: "Dark stone grey", rgb: [99 / 255, 95 / 255, 98 / 255] },
    { name: "Black", rgb: [27 / 255, 42 / 255, 53 / 255] },
    { name: "Reddish brown", rgb: [105 / 255, 64 / 255, 40 / 255] },
    { name: "Earth green", rgb: [39 / 255, 70 / 255, 45 / 255] },
];

const CSS = `
.sandblox-palette {
    position: fixed;
    bottom: 70px;
    left: 50%;
    transform: translateX(-50%);
    display: grid;
    grid-template-columns: repeat(7, 24px);
    gap: 3px;
    padding: 5px;
    background: rgba(60, 60, 60, 0.6);
    z-index: 1000;
    user-select: none;
    -webkit-user-select: none;
}

.sandblox-swatch {
    width: 24px;
    height: 24px;
    border: none;
    padding: 0;
    cursor: pointer;
    outline: none;
}

.sandblox-swatch.sandblox-swatch-active {
    box-shadow: inset 0 0 0 3px rgba(0, 140, 220, 1.0);
}
`;

export class PaintTool implements Tool {
    private readonly _ctx: ToolContext;
    private _colorIndex = 0;
    private _root: HTMLElement | null = null;
    private _style: HTMLStyleElement | null = null;
    private readonly _onMove = (): void => this._hover();
    private readonly _onDown = (e: MouseRayEvent): void => this._down(e);

    constructor(ctx: ToolContext) {
        this._ctx = ctx;
    }

    /** The palette color clicks will apply. */
    get color(): PaletteColor {
        return CLASSIC_PALETTE[this._colorIndex]!;
    }

    setColorIndex(i: number): void {
        this._colorIndex = Math.max(0, Math.min(CLASSIC_PALETTE.length - 1, i));
        this._ctx.selectionBox.setColor(this.color.rgb);
        this._root?.querySelectorAll(".sandblox-swatch").forEach((el, k) => {
            el.classList.toggle("sandblox-swatch-active", k === this._colorIndex);
        });
    }

    activate(): void {
        this._ctx.selectionBox.setColor(this.color.rgb);
        this._ctx.mouse.on("move", this._onMove);
        this._ctx.mouse.on("down", this._onDown);
        this._buildPalette();
        this._hover();
    }

    deactivate(): void {
        this._ctx.mouse.off("move", this._onMove);
        this._ctx.mouse.off("down", this._onDown);
        this._ctx.selectionBox.adornee = null;
        this._root?.remove();
        this._style?.remove();
        this._root = null;
        this._style = null;
    }

    private _hover(): void {
        this._ctx.selectionBox.adornee = this._ctx.mouse.target;
    }

    private _down(e: MouseRayEvent): void {
        if (e.button !== 0 || e.consumed) {
            return;
        }
        this._ctx.mouse.target?.setColor(this.color.rgb);
    }

    private _buildPalette(): void {
        this._style = document.createElement("style");
        this._style.textContent = CSS;
        document.head.appendChild(this._style);

        this._root = document.createElement("div");
        this._root.className = "sandblox-palette";
        this._root.setAttribute("aria-label", "Brick colors");
        CLASSIC_PALETTE.forEach((c, i) => {
            const b = document.createElement("button");
            b.className = "sandblox-swatch" + (i === this._colorIndex ? " sandblox-swatch-active" : "");
            b.title = c.name;
            b.style.background = `rgb(${Math.round(c.rgb[0] * 255)}, ${Math.round(c.rgb[1] * 255)}, ${Math.round(c.rgb[2] * 255)})`;
            b.addEventListener("mousedown", (ev: MouseEvent) => {
                ev.preventDefault(); // keep canvas focus
                this.setColorIndex(i);
            });
            this._root!.appendChild(b);
        });
        document.body.appendChild(this._root);
    }
}
