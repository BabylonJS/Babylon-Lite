/**
 * Tile picking for the Freeciv demo.
 *
 * The engine has no sprite-picking primitive, and for an isometric tilemap it
 * doesn't need one: the cursor's screen position inverts cleanly back to a tile
 * via {@link worldToTile} (see iso.ts). This module turns a hovered `(tileX,
 * tileY)` into two pieces of feedback — a highlight bracket parked on the tile
 * (reusing the `selection` sprite layer) and an HTML tooltip naming the terrain.
 *
 * It is pure tile-space: the caller (freeciv.ts) owns the screen → tile
 * transform because that depends on the snapped view, and hands us the result.
 */

import { addSprite2DIndex, updateSprite2DIndex, type Sprite2DLayer } from "babylon-lite";
import { TILE_W, TILE_H, isoCentre } from "./iso.js";
import { Terrain, Special, Improvement, type GameMap } from "./worldgen.js";

const TERRAIN_NAME: Readonly<Record<Terrain, string>> = {
    [Terrain.Ocean]: "Ocean",
    [Terrain.Grassland]: "Grassland",
    [Terrain.Plains]: "Plains",
    [Terrain.Desert]: "Desert",
    [Terrain.Forest]: "Forest",
    [Terrain.Jungle]: "Jungle",
    [Terrain.Swamp]: "Swamp",
    [Terrain.Hills]: "Hills",
    [Terrain.Mountains]: "Mountains",
    [Terrain.Tundra]: "Tundra",
    [Terrain.Arctic]: "Arctic",
};

const SPECIAL_NAME: Readonly<Record<Special, string>> = {
    [Special.None]: "",
    [Special.Wheat]: "Wheat",
    [Special.Gold]: "Gold",
    [Special.Oasis]: "Oasis",
    [Special.Furs]: "Furs",
    [Special.Gems]: "Gems",
    [Special.Wine]: "Wine",
    [Special.Coal]: "Coal",
    [Special.Fish]: "Fish",
    [Special.Whales]: "Whales",
};

const IMPROVEMENT_NAME: Readonly<Record<Improvement, string>> = {
    [Improvement.None]: "",
    [Improvement.Irrigation]: "Irrigation",
    [Improvement.Farmland]: "Farmland",
    [Improvement.Mine]: "Mine",
};

export interface Picker {
    /**
     * Update the hover feedback. Pass `tileX = null` (cursor off-canvas or
     * outside the map) to clear the highlight and hide the tooltip. `cssX/cssY`
     * are viewport CSS pixels used to park the tooltip near the cursor.
     */
    hover(tileX: number | null, tileY: number | null, cssX: number, cssY: number): void;
    /** Remove the tooltip element. */
    dispose(): void;
}

/** Build a {@link Picker}. Adds one highlight sprite to `highlightLayer`. */
export function createPicker(world: GameMap, highlightLayer: Sprite2DLayer, diamondFrame: number): Picker {
    // A cyan selection bracket parked over the hovered tile. The frame is the
    // `select` sheet's white corner-bracket (passed in as `diamondFrame`), which
    // tints cleanly — the terrain diamond masks are black-filled and only darken.
    // Added at full size but hidden via `visible: false` (NOT `sizePx: [0, 0]` —
    // a sprite added at zero size is treated as hidden and can never be shown
    // again by resizing, only by toggling `visible`). Shown on the first hover.
    const highlight = addSprite2DIndex(highlightLayer, {
        positionPx: [0, 0],
        sizePx: [TILE_W, TILE_H],
        frame: diamondFrame,
        color: [0.3, 0.95, 1, 1],
        visible: false,
    });

    const tip = document.createElement("div");
    tip.id = "tileTooltip";
    tip.style.cssText =
        "position:fixed;left:0;top:0;display:none;pointer-events:none;z-index:50;" +
        "padding:3px 8px;border-radius:4px;font:12px/1.4 system-ui,sans-serif;" +
        "color:#eef;background:rgba(12,18,28,0.85);border:1px solid rgba(120,170,220,0.4);" +
        "white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,0.6)";
    document.body.appendChild(tip);

    function describe(tx: number, ty: number): string {
        const parts: string[] = [TERRAIN_NAME[world.at(tx, ty)]];
        const sp = world.specialAt(tx, ty);
        if (sp !== Special.None) parts.push(SPECIAL_NAME[sp]);
        const imp = world.improvementAt(tx, ty);
        if (imp !== Improvement.None) parts.push(IMPROVEMENT_NAME[imp]);
        if (world.hasRiver(tx, ty)) parts.push("River");
        if (world.hasRoad(tx, ty)) parts.push("Road");
        return `${parts.join(" · ")}  (${tx}, ${ty})`;
    }

    return {
        hover(tileX, tileY, cssX, cssY) {
            const inBounds =
                tileX !== null &&
                tileY !== null &&
                tileX >= 0 &&
                tileY >= 0 &&
                tileX < world.width &&
                tileY < world.height;
            if (!inBounds) {
                updateSprite2DIndex(highlightLayer, highlight, { visible: false });
                tip.style.display = "none";
                return;
            }
            const [cx, cy] = isoCentre(tileX, tileY);
            updateSprite2DIndex(highlightLayer, highlight, {
                positionPx: [cx, cy],
                visible: true,
            });
            tip.textContent = describe(tileX, tileY);
            tip.style.left = `${cssX + 14}px`;
            tip.style.top = `${cssY + 14}px`;
            tip.style.display = "block";
        },
        dispose() {
            tip.remove();
        },
    };
}
