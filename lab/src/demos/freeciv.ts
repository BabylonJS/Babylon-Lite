/**
 * Freeciv demo — isometric Civilization-style 2D map rendered on Lite's pure-2D
 * sprite path (no scene, camera, mesh, or light — just a `SpriteRenderer`).
 *
 * Loads the GPLv2 Freeciv `amplio2` isometric tileset (fetched as a static asset,
 * never bundled), slices its sprite sheets from the publicly documented plain-text
 * `.spec` grids, procedurally generates a continent, and lays the terrain out as
 * an isometric diamond tilemap with a few cities and units on top.
 *
 * Controls: drag to pan, mouse wheel to zoom.
 *
 * Clean-room reader of the documented `.spec` format — no Freeciv code is used,
 * and no tileset bytes are committed to this repo.
 */

import {
    createEngine,
    createSprite2DLayer,
    createSpriteRenderer,
    registerSpriteRenderer,
    startEngine,
    type EngineContext,
    type Sprite2DLayer,
} from "babylon-lite";
import { loadFreecivSheet } from "./freeciv/atlas.js";
import { generateWorld } from "./freeciv/worldgen.js";
import { buildTilemap, type Bounds, type TileLayers, type TileSheets } from "./freeciv/tilemap.js";
import { createLiveSim } from "./freeciv/live.js";
import { TILE_H, TILE_W, isoCentre } from "./freeciv/iso.js";

const BASE_URL = "/freeciv";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    // Ten sheets → fifteen layers (each Sprite2DLayer binds exactly one atlas).
    const [terrain, terrain2, hills, mountains, ocean, water, cities, units, animals, select] = await Promise.all([
        loadFreecivSheet(engine, BASE_URL, `${BASE_URL}/amplio2/terrain1.spec`),
        loadFreecivSheet(engine, BASE_URL, `${BASE_URL}/amplio2/terrain2.spec`),
        loadFreecivSheet(engine, BASE_URL, `${BASE_URL}/amplio2/hills.spec`),
        loadFreecivSheet(engine, BASE_URL, `${BASE_URL}/amplio2/mountains.spec`),
        loadFreecivSheet(engine, BASE_URL, `${BASE_URL}/amplio2/ocean.spec`),
        loadFreecivSheet(engine, BASE_URL, `${BASE_URL}/amplio2/water.spec`),
        loadFreecivSheet(engine, BASE_URL, `${BASE_URL}/amplio2/cities.spec`),
        loadFreecivSheet(engine, BASE_URL, `${BASE_URL}/amplio2/units.spec`),
        loadFreecivSheet(engine, BASE_URL, `${BASE_URL}/amplio2/animals.spec`),
        loadFreecivSheet(engine, BASE_URL, `${BASE_URL}/amplio2/select.spec`),
    ]);
    const sheets: TileSheets = { terrain, terrain2, hills, mountains, ocean, water, cities, units, animals, select };

    const world = generateWorld({ width: 48, height: 48, seed: 7 });
    const cap = world.width * world.height;

    // Back-to-front: ocean → coast → terrain base → raised forest/hills/mountains
    // → river → road → improvements → specials → city → unit → wildlife → fog →
    // selection ring (the ring rides on top so it stays crisp over the scout).
    const tileLayers: TileLayers = {
        ocean: createSprite2DLayer(ocean.grid("grid_main").atlas, { capacity: cap, order: 0 }),
        coast: createSprite2DLayer(water.grid("grid_coasts").atlas, { capacity: cap * 2, order: 1 }),
        terrain: createSprite2DLayer(terrain.grid("grid_main").atlas, { capacity: cap, order: 2 }),
        forest: createSprite2DLayer(terrain2.grid("grid_main").atlas, { capacity: cap, order: 3 }),
        hills: createSprite2DLayer(hills.grid("grid_main").atlas, { capacity: cap, order: 4 }),
        mountains: createSprite2DLayer(mountains.grid("grid_main").atlas, { capacity: cap, order: 5 }),
        river: createSprite2DLayer(water.grid("grid_main").atlas, { capacity: cap, order: 6 }),
        road: createSprite2DLayer(terrain.grid("grid_main").atlas, { capacity: cap, order: 7 }),
        improvement: createSprite2DLayer(terrain.grid("grid_main").atlas, { capacity: cap, order: 8 }),
        special: createSprite2DLayer(terrain.grid("grid_main").atlas, { capacity: cap, order: 9 }),
        city: createSprite2DLayer(cities.grid("grid_main").atlas, { capacity: 64, order: 10, pivot: [0.5, 1.0] }),
        unit: createSprite2DLayer(units.grid("grid_main").atlas, { capacity: 64, order: 11, pivot: [0.5, 1.0] }),
        animals: createSprite2DLayer(animals.grid("grid_main").atlas, { capacity: 64, order: 12, pivot: [0.5, 1.0] }),
        fog: createSprite2DLayer(terrain.grid("grid_main").atlas, { capacity: cap, order: 13 }),
        selection: createSprite2DLayer(select.grid("grid_main").atlas, { capacity: 4, order: 14 }),
    };
    const layers = [
        tileLayers.ocean,
        tileLayers.coast,
        tileLayers.terrain,
        tileLayers.forest,
        tileLayers.hills,
        tileLayers.mountains,
        tileLayers.river,
        tileLayers.road,
        tileLayers.improvement,
        tileLayers.special,
        tileLayers.city,
        tileLayers.unit,
        tileLayers.animals,
        tileLayers.fog,
        tileLayers.selection,
    ];

    const bounds = buildTilemap(world, sheets, tileLayers);
    const sim = createLiveSim(world, sheets, tileLayers);

    const view: View = { x: 0, y: 0, zoom: 1, userMoved: false };
    const recenter = (): void => {
        if (view.userMoved) return;
        fitView(view, engine, bounds);
        applyView(view, layers);
    };

    const sr = createSpriteRenderer(engine, {
        layers,
        clearValue: { r: 0.149, g: 0.29, b: 0.451, a: 1 }, // deep ocean blue
    });
    registerSpriteRenderer(sr);

    installControls(engine, view, layers);
    recenter();
    window.addEventListener("resize", recenter);

    const labels = createCityLabels(world.cities);

    await startEngine(engine);
    recenter();

    // Animation loop: advance the live sim and reposition floating city labels.
    let last = performance.now();
    const tick = (now: number): void => {
        const dt = Math.min(100, now - last);
        last = now;
        sim.step(dt);
        labels.update(view, engine);
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    canvas.dataset.ready = "true";
}

interface CityAnchor {
    wx: number;
    wy: number;
    el: HTMLDivElement;
}

/** Build floating HTML labels for each city (name + population pill). */
function createCityLabels(cities: readonly { x: number; y: number; name: string; size: number }[]): {
    update: (view: View, engine: EngineContext) => void;
} {
    const style = document.createElement("style");
    style.textContent = `
        #cityLabels { position: fixed; inset: 0; pointer-events: none; z-index: 40; overflow: hidden; }
        #cityLabels .city-label {
            position: absolute; transform: translate(-50%, -100%);
            display: flex; align-items: center; gap: 5px; white-space: nowrap;
            padding: 2px 7px; border-radius: 10px;
            background: rgba(14, 33, 56, 0.78); color: #eaf2fb;
            font: 600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6); will-change: transform;
        }
        #cityLabels .city-pop {
            min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px;
            background: #6fb0ff; color: #08203a; font-weight: 700; font-size: 10px;
            display: inline-flex; align-items: center; justify-content: center;
        }
    `;
    document.head.appendChild(style);

    const container = document.createElement("div");
    container.id = "cityLabels";
    document.body.appendChild(container);

    const anchors: CityAnchor[] = cities.map((c) => {
        const el = document.createElement("div");
        el.className = "city-label";
        const pop = document.createElement("span");
        pop.className = "city-pop";
        pop.textContent = String(c.size);
        const name = document.createElement("span");
        name.textContent = c.name;
        el.append(pop, name);
        container.appendChild(el);
        // Anchor a little above the tile centre so the pill clears the rooftops.
        const [wx, wy] = isoCentre(c.x, c.y);
        return { wx, wy: wy - TILE_H * 0.6, el };
    });

    return {
        update(view: View, engine: EngineContext): void {
            const dpr = (engine.canvas.width || 1) / (engine.canvas.clientWidth || 1);
            // Match the snapped transform the tiles render with so labels don't
            // drift off their tiles by a fraction of a pixel.
            const z = snapZoom(view.zoom);
            const vx = Math.round(view.x * z) / z;
            const vy = Math.round(view.y * z) / z;
            for (const a of anchors) {
                const sx = (a.wx - vx) * z / dpr;
                const sy = (a.wy - vy) * z / dpr;
                a.el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
            }
        },
    };
}


interface View {
    x: number;
    y: number;
    zoom: number;
    userMoved: boolean;
}

/** Fit the whole map into the viewport and centre it. */
function fitView(view: View, engine: EngineContext, b: Bounds): void {
    const w = engine.canvas.width || 1;
    const h = engine.canvas.height || 1;
    const mapW = b.maxX - b.minX + TILE_W;
    const mapH = b.maxY - b.minY + TILE_H;
    view.zoom = Math.min(w / mapW, h / mapH) * 0.95;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    view.x = cx - w / 2 / view.zoom;
    view.y = cy - h / 2 / view.zoom;
}

function applyView(view: View, layers: readonly Sprite2DLayer[]): void {
    // The iso tiles are alpha-baked diamonds that tessellate by sharing edges.
    // With nearest filtering this is only seamless when one texel maps to a whole
    // number of device pixels — i.e. at INTEGER zoom — and when the grid origin
    // lands on the device-pixel grid (otherwise every diamond edge resamples at a
    // fractional offset and a 1px crack appears between tiles). So we render with a
    // snapped view: zoom rounded to an integer (when zoomed in) and the origin
    // rounded to the nearest 1/zoom. The logical `view` stays unsnapped so panning
    // and wheel-zoom still accumulate smoothly; only the per-layer view is snapped.
    const z = snapZoom(view.zoom);
    const snapX = Math.round(view.x * z) / z;
    const snapY = Math.round(view.y * z) / z;
    for (const layer of layers) {
        layer.view.positionPx[0] = snapX;
        layer.view.positionPx[1] = snapY;
        layer.view.zoom = z;
    }
}

/**
 * Snap a zoom factor so nearest-filtered diamond tiles tessellate without seams.
 * Zoom ≥ 1 snaps to the nearest integer (one texel → an integer number of device
 * pixels, perfectly crisp). Zoom < 1 (whole-map overview) snaps to `1/n`, where
 * inter-tile cracks are sub-pixel and effectively invisible. Clamped to the same
 * range the wheel handler uses.
 */
function snapZoom(zoom: number): number {
    const z = zoom >= 1 ? Math.round(zoom) : 1 / Math.round(1 / zoom);
    return Math.min(6, Math.max(0.15, z));
}

function installControls(engine: EngineContext, view: View, layers: readonly Sprite2DLayer[]): void {
    const canvas = engine.canvas;
    const dpr = (): number => (canvas.width || 1) / (canvas.clientWidth || 1);
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener("pointerdown", (e) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const k = dpr() / view.zoom;
        view.x -= (e.clientX - lastX) * k;
        view.y -= (e.clientY - lastY) * k;
        lastX = e.clientX;
        lastY = e.clientY;
        view.userMoved = true;
        applyView(view, layers);
    });
    const endDrag = (e: PointerEvent): void => {
        dragging = false;
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    canvas.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const sx = (e.clientX - rect.left) * dpr();
            const sy = (e.clientY - rect.top) * dpr();
            // Anchor the zoom on the cursor using the SNAPPED view that is actually
            // rendered (not the continuous `view.zoom`). Otherwise the cursor's world
            // point is held fixed in the logical view while the snapped origin keeps
            // re-rounding, so the target appears to orbit the corner instead of
            // staying under the pointer.
            const zBefore = snapZoom(view.zoom);
            const wx = Math.round(view.x * zBefore) / zBefore + sx / zBefore;
            const wy = Math.round(view.y * zBefore) / zBefore + sy / zBefore;
            const factor = Math.exp(-e.deltaY * 0.001);
            view.zoom = Math.min(6, Math.max(0.15, view.zoom * factor));
            const zAfter = snapZoom(view.zoom);
            view.x = wx - sx / zAfter;
            view.y = wy - sy / zAfter;
            view.userMoved = true;
            applyView(view, layers);
        },
        { passive: false },
    );
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) canvas.dataset.error = String(err);
    const pre = document.createElement("pre");
    pre.style.cssText = "position:fixed;inset:0;margin:0;padding:16px;color:#0f0;background:#000;font:14px monospace;white-space:pre-wrap;z-index:9999;";
    pre.textContent = `${String(err)}\n\n${err && err.stack ? err.stack : ""}`;
    document.body.appendChild(pre);
});
