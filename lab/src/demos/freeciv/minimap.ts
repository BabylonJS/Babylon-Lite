/**
 * Overview minimap for the Freeciv demo — rendered entirely on Lite's own
 * sprite path (no Canvas2D).
 *
 * The whole world is uploaded once as a `width × height` data texture (one texel
 * per tile, in map-space — NOT the isometric projection, because minimaps read
 * best as a straight top-down rectangle). That texture is drawn as a single
 * pure-2D HUD sprite pinned to the bottom-right corner; a second HUD layer paints
 * the chrome from a 1×1 white texture tinted per sprite: a thin border, a dot per
 * city, and the four edges of the current viewport quad (a rotated quad, since the
 * main view is iso). Everything shares the map's `SpriteRenderer` — one engine,
 * one surface.
 *
 * Drawing is Lite; input is the DOM's job (just like the main canvas). A single
 * transparent hit-target `<div>` parked over the corner captures click/drag and
 * recentres the main view — it renders nothing.
 *
 * Pure overlay: it owns no game state. The caller (freeciv.ts) supplies two
 * closures so all the view/zoom/snap math stays in one place — `viewportCorners`
 * (the four screen corners expressed in tile space) and `panToTile` (recentre).
 */

import {
    addSprite2DIndex,
    addSpriteRendererLayer,
    createGridSpriteAtlas,
    createSprite2DLayer,
    createTexture2DFromPixels,
    removeSpriteRendererLayer,
    updateSprite2DIndex,
    type EngineContext,
    type SpriteRenderer,
} from "babylon-lite";
import { Terrain, type GameMap } from "./worldgen.js";

/** Minimap display size in CSS pixels (the longer map axis maps to this). */
const MINIMAP_MAX = 180;
/** Margin from the canvas corner, in CSS pixels. */
const MARGIN_CSS = 12;

/** Per-terrain overview colour (`[r, g, b]`, 0‒255). Indexed by {@link Terrain}. */
const TERRAIN_COLOR: Readonly<Record<Terrain, readonly [number, number, number]>> = {
    [Terrain.Ocean]: [38, 74, 115],
    [Terrain.Grassland]: [96, 152, 64],
    [Terrain.Plains]: [150, 168, 80],
    [Terrain.Desert]: [200, 182, 120],
    [Terrain.Forest]: [56, 104, 56],
    [Terrain.Jungle]: [72, 116, 60],
    [Terrain.Swamp]: [92, 110, 86],
    [Terrain.Hills]: [128, 132, 84],
    [Terrain.Mountains]: [134, 128, 120],
    [Terrain.Tundra]: [150, 156, 140],
    [Terrain.Arctic]: [228, 234, 240],
};

/** Chrome tints (`[r, g, b, a]`, 0‒1) for the white-texel overlay sprites. */
const CITY_COLOR: [number, number, number, number] = [1, 1, 1, 1];
const VIEWPORT_COLOR: [number, number, number, number] = [1, 1, 1, 0.9];
const BORDER_COLOR: [number, number, number, number] = [0.59, 0.74, 0.9, 0.55];

export interface MinimapHooks {
    /** Current main-view rectangle as four tile-space corners (TL, TR, BR, BL). */
    viewportCorners: () => ReadonlyArray<readonly [number, number]>;
    /** Recentre the main view on tile `(tx, ty)` (fractional tile coords allowed). */
    panToTile: (tx: number, ty: number) => void;
}

export interface Minimap {
    /** Redraw the dynamic overlay (viewport box + city dots) over the terrain. */
    update: () => void;
    /** Remove the minimap layers and input target. */
    dispose: () => void;
}

/** Build a {@link Minimap}. Adds its HUD layers to `sr` and renders immediately. */
export function createMinimap(engine: EngineContext, sr: SpriteRenderer, world: GameMap, hooks: MinimapHooks): Minimap {
    const tw = world.width;
    const th = world.height;

    // ── 1. Static terrain: one texel per tile, uploaded once as a data texture. ──
    //    Nearest + clamp (the `createTexture2DFromPixels` defaults) give a crisp,
    //    pixelated upscale — the GPU analog of the old `image-rendering: pixelated`.
    const pixels = new Uint8Array(tw * th * 4);
    for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
            const [r, g, b] = TERRAIN_COLOR[world.at(x, y)];
            const o = (y * tw + x) * 4;
            pixels[o] = r;
            pixels[o + 1] = g;
            pixels[o + 2] = b;
            pixels[o + 3] = 255;
        }
    }
    const terrainTex = createTexture2DFromPixels(engine, pixels, tw, th);
    const terrainAtlas = createGridSpriteAtlas(terrainTex, { cellWidthPx: tw, cellHeightPx: th, pivot: [0, 0] });

    // ── 2. A 1×1 white texel — tinted per sprite for dots, viewport box, border. ──
    const whiteTex = createTexture2DFromPixels(engine, new Uint8Array([255, 255, 255, 255]), 1, 1);
    const whiteAtlas = createGridSpriteAtlas(whiteTex, { cellWidthPx: 1, cellHeightPx: 1, pivot: [0, 0] });

    // ── 3. Two HUD layers (pixel space, top-left pivot), ordered above the map. ──
    const terrainLayer = createSprite2DLayer(terrainAtlas, { capacity: 1, order: 100, pivot: [0, 0] });
    const overlayLayer = createSprite2DLayer(whiteAtlas, { capacity: 8 + world.cities.length, order: 101, pivot: [0, 0] });
    addSpriteRendererLayer(sr, terrainLayer);
    addSpriteRendererLayer(sr, overlayLayer);

    // Stable sprite indices — added once, repositioned every frame in `draw`.
    const terrainSprite = addSprite2DIndex(terrainLayer, { positionPx: [0, 0], sizePx: [1, 1], frame: 0, visible: false });
    const borderEdges = [0, 1, 2, 3].map(() => addSprite2DIndex(overlayLayer, { positionPx: [0, 0], sizePx: [1, 1], color: BORDER_COLOR, visible: false }));
    const cityDots = world.cities.map(() => addSprite2DIndex(overlayLayer, { positionPx: [0, 0], sizePx: [1, 1], color: CITY_COLOR, visible: false }));
    const viewportEdges = [0, 1, 2, 3].map(() => addSprite2DIndex(overlayLayer, { positionPx: [0, 0], sizePx: [1, 1], color: VIEWPORT_COLOR, visible: false }));

    /** Current minimap rectangle in DEVICE pixels (bottom-right anchored). */
    function rect(): { x0: number; y0: number; w: number; h: number; dpr: number } {
        const canvas = engine.canvas;
        const dpr = (canvas.width || 1) / (canvas.clientWidth || 1);
        const aspect = tw / th;
        const cssW = aspect >= 1 ? MINIMAP_MAX : Math.round(MINIMAP_MAX * aspect);
        const cssH = aspect >= 1 ? Math.round(MINIMAP_MAX / aspect) : MINIMAP_MAX;
        const w = cssW * dpr;
        const h = cssH * dpr;
        const m = MARGIN_CSS * dpr;
        return { x0: (canvas.width || 1) - m - w, y0: (canvas.height || 1) - m - h, w, h, dpr };
    }

    /**
     * Draw a thin line as a rotated quad from `(ax, ay)` to `(bx, by)` (device px),
     * centred on the segment. The layer pivot is the top-left corner, so the quad
     * grows +length along local-x and +thickness along local-y; we nudge the start
     * perpendicular by half the thickness so the line straddles the segment.
     */
    function setEdge(idx: number, ax: number, ay: number, bx: number, by: number, thickness: number): void {
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        const ang = Math.atan2(dy, dx);
        const ox = (Math.sin(ang) * thickness) / 2;
        const oy = (-Math.cos(ang) * thickness) / 2;
        updateSprite2DIndex(overlayLayer, idx, { positionPx: [ax + ox, ay + oy], sizePx: [len, thickness], rotation: ang, visible: true });
    }

    function draw(): void {
        const { x0, y0, w, h, dpr } = rect();

        // Terrain fill.
        updateSprite2DIndex(terrainLayer, terrainSprite, { positionPx: [x0, y0], sizePx: [w, h], visible: true });

        // Border (top, right, bottom, left).
        const bt = Math.max(1, Math.round(dpr));
        setEdge(borderEdges[0]!, x0, y0, x0 + w, y0, bt);
        setEdge(borderEdges[1]!, x0 + w, y0, x0 + w, y0 + h, bt);
        setEdge(borderEdges[2]!, x0 + w, y0 + h, x0, y0 + h, bt);
        setEdge(borderEdges[3]!, x0, y0 + h, x0, y0, bt);

        // City markers.
        const dot = Math.max(2, Math.round(3 * dpr));
        for (let i = 0; i < world.cities.length; i++) {
            const c = world.cities[i]!;
            const px = x0 + (c.x / tw) * w;
            const py = y0 + (c.y / th) * h;
            updateSprite2DIndex(overlayLayer, cityDots[i]!, { positionPx: [px - dot / 2, py - dot / 2], sizePx: [dot, dot], visible: true });
        }

        // Current viewport outline (a rotated quad, since the main view is iso).
        const corners = hooks.viewportCorners();
        if (corners.length === 4) {
            const lt = Math.max(1, Math.round(1.5 * dpr));
            const pts = corners.map(([tx2, ty2]) => [x0 + (tx2 / tw) * w, y0 + (ty2 / th) * h] as [number, number]);
            for (let i = 0; i < 4; i++) {
                const a = pts[i]!;
                const b = pts[(i + 1) % 4]!;
                setEdge(viewportEdges[i]!, a[0], a[1], b[0], b[1], lt);
            }
        } else {
            for (const idx of viewportEdges) updateSprite2DIndex(overlayLayer, idx, { visible: false });
        }
    }

    // ── Input: a transparent hit-target over the minimap (input ≠ drawing). ───────
    //    Positioned in CSS px so it auto-anchors to the corner across resizes; it
    //    sits above the canvas so its pointer events never reach the map controls.
    const aspect = tw / th;
    const cssW = aspect >= 1 ? MINIMAP_MAX : Math.round(MINIMAP_MAX * aspect);
    const cssH = aspect >= 1 ? Math.round(MINIMAP_MAX / aspect) : MINIMAP_MAX;
    const hit = document.createElement("div");
    hit.id = "minimapHit";
    hit.style.cssText =
        `position:fixed;right:${MARGIN_CSS}px;bottom:${MARGIN_CSS}px;width:${cssW}px;height:${cssH}px;` +
        "z-index:46;cursor:crosshair;touch-action:none";
    document.body.appendChild(hit);

    let dragging = false;
    const panFromEvent = (e: PointerEvent): void => {
        const r = hit.getBoundingClientRect();
        const tx = ((e.clientX - r.left) / r.width) * tw;
        const ty = ((e.clientY - r.top) / r.height) * th;
        hooks.panToTile(tx, ty);
    };
    hit.addEventListener("pointerdown", (e) => {
        dragging = true;
        hit.setPointerCapture(e.pointerId);
        panFromEvent(e);
    });
    hit.addEventListener("pointermove", (e) => {
        if (dragging) panFromEvent(e);
    });
    const end = (e: PointerEvent): void => {
        dragging = false;
        if (hit.hasPointerCapture(e.pointerId)) hit.releasePointerCapture(e.pointerId);
    };
    hit.addEventListener("pointerup", end);
    hit.addEventListener("pointercancel", end);

    draw();

    return {
        update: draw,
        dispose() {
            removeSpriteRendererLayer(sr, terrainLayer);
            removeSpriteRendererLayer(sr, overlayLayer);
            hit.remove();
        },
    };
}
