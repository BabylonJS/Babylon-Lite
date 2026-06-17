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

import { createEngine, createSprite2DLayer, createSpriteRenderer, registerSpriteRenderer, startEngine, type EngineContext } from "babylon-lite";
import { loadFreecivSheet } from "./freeciv/atlas.js";
import { createAtmosphere } from "./freeciv/atmosphere.js";
import { createBackdrop } from "./freeciv/backdrop.js";
import { createWater } from "./freeciv/water.js";
import { createDayNight } from "./freeciv/daynight.js";
import { createVignette } from "./freeciv/vignette.js";
import { generateWorld, type GameMap } from "./freeciv/worldgen.js";
import { buildTilemap, type Bounds, type TileLayers, type TileSheets } from "./freeciv/tilemap.js";
import { createCommandFx, type CommandFx } from "./freeciv/commandfx.js";
import { createDust } from "./freeciv/dust.js";
import { createFog } from "./freeciv/fog.js";
import { createGlints } from "./freeciv/glints.js";
import { createLiveSim } from "./freeciv/live.js";
import { createPicker } from "./freeciv/pick.js";
import { createMinimap } from "./freeciv/minimap.js";
import { createPresent } from "./freeciv/present.js";
import { DIR8, DIR_DELTA, TILE_H, TILE_W, isoCentre, worldToTile } from "./freeciv/iso.js";
import { demoAssetUrl } from "./demo-asset-url.js";
import { installFetchProgress } from "./loading-progress.js";

const BASE_URL = demoAssetUrl("./freeciv", import.meta.url);

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const progress = installFetchProgress(canvas, { estimatedBytes: 2_400_000 });
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

    const world = generateWorld({ width: 96, height: 96, seed: 7 });
    const cap = world.width * world.height;

    // Back-to-front: ocean → coast → terrain base → raised forest/hills/mountains
    // → river → road → improvements → specials → city → unit → wildlife →
    // selection ring (the ring rides on top so it stays crisp over the scout).
    // Fog of war is a separate fullscreen field layer added to the renderer below.
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
    };
    // Tile-hover highlight: a cyan-tinted selection bracket on its own top layer.
    // We use the `select` sheet's corner-bracket frame (white-filled, so a colour
    // tint actually shows) — the terrain diamonds (`t.unknown1` / `mask.tile`) are
    // black-filled masks, so tinting them only darkens the tile.
    const highlightLayer = createSprite2DLayer(select.grid("grid_main").atlas, { capacity: 1, order: 15 });
    // Animated caustic shimmer over the sea (order 0.5: above ocean, below coast).
    const waterFx = createWater(engine, world);
    const layers = [
        tileLayers.ocean,
        waterFx.layer,
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
        highlightLayer,
    ];

    const bounds = buildTilemap(world, sheets, tileLayers);
    const sim = createLiveSim(world, sheets, tileLayers);
    // The `select` sheet's first bracket frame — a white corner-bracket overlay
    // that tints cleanly (unlike the black-filled terrain diamond masks).
    const diamondFrame = select.grid("grid_main").frameOf("unit.select0") ?? 0;
    const picker = createPicker(world, highlightLayer, diamondFrame);

    // Unit orders: click the scout to select it, then click a tile to send it there
    // along the cheapest road-aware path (movement itself is run by the live sim).
    const hint = document.createElement("div");
    hint.id = "unitHint";
    hint.textContent = "Scout selected — click a tile to move it";
    hint.style.cssText =
        "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:50;padding:5px 12px;" +
        "border-radius:12px;background:rgba(14,33,56,0.85);color:#eaf2fb;" +
        "font:600 12px system-ui,-apple-system,'Segoe UI',sans-serif;pointer-events:none;display:none;";
    document.body.appendChild(hint);
    let unitSelected = false;
    // The tile the scout is currently marching to (for the marching-ants marker), cleared
    // once it arrives. Note the scout is deselected the instant an order is issued, so it
    // marches while unselected — the marker intentionally persists through the whole march
    // (it is NOT tied to selection). The command-FX layer is created after the renderer, so
    // this is held in a forward `let` that the click handler closes over.
    let scoutDest: [number, number] | null = null;
    let commandFx: CommandFx | null = null;
    const setArmed = (on: boolean): void => {
        unitSelected = on;
        hint.style.display = on ? "block" : "none";
        canvas.style.cursor = on ? "crosshair" : "";
        sim.setScoutSelected(on); // selected scout sprite pulses
    };
    const onMapClick = (tx: number, ty: number): void => {
        const [stx, sty] = sim.scoutTile();
        if (!unitSelected) {
            if (tx === stx && ty === sty) setArmed(true); // selected the scout
            return;
        }
        if (tx === stx && ty === sty) {
            setArmed(false); // clicked the scout again → deselect
            return;
        }
        const path = findPath(world, stx, sty, tx, ty);
        if (path && path.length > 0) {
            sim.commandScout(path);
            scoutDest = [tx, ty];
            commandFx?.ping(tx, ty); // acknowledge the order with a ripple
            setArmed(false);
        }
        // Unreachable target (ocean / off-map): stay armed so the player can retry.
    };

    const view: View = { x: 0, y: 0, zoom: 1, userMoved: false };
    // Recomputes the seam-safe RUNG render view + present scale from `view`. Assigned once the
    // render target + present pass exist (just after the world renderer is built, below).
    let syncView: () => void = () => {};
    // Smooth wheel zoom: the wheel only nudges `zoomCtl.target` (+ records the world point under
    // the cursor); the tick eases `view.zoom` toward it over several frames, so a notched mouse
    // glides instead of stepping. Pan / minimap cancel the ease by snapping the target to live
    // zoom. All view→render syncing happens in the tick so tiles and world FX move in lockstep.
    const zoomCtl = { target: 1, wx: 0, wy: 0, sx: 0, sy: 0 };
    // Start pointed at Babylon (the player's capital) rather than the geometric
    // centre of the map bounds, which sits further south.
    const capital = world.cities.find((c) => c.name === "Babylon") ?? world.cities[0];
    const recenter = (): void => {
        if (view.userMoved) return;
        fitView(view, engine, bounds);
        zoomCtl.target = view.zoom;
        if (capital) {
            const [wx, wy] = isoCentre(capital.x, capital.y);
            const w = engine.canvas.width || 1;
            const h = engine.canvas.height || 1;
            view.x = wx - w / 2 / view.zoom;
            view.y = wy - h / 2 / view.zoom;
        }
        syncView();
    };

    // Subdued public-domain Mercator 1569 world map behind the playfield, plus a
    // soft sea halo so the map's coastline edges melt into open water. Both live in
    // world space, so they pan/zoom with the tiles (added to `layers`).
    const backdrop = await createBackdrop(engine, world, `${BASE_URL}/mercator-1569.png`);
    layers.push(...backdrop.layers);

    const sr = createSpriteRenderer(engine, {
        layers,
        clearValue: { r: 0.149, g: 0.29, b: 0.451, a: 1 }, // deep ocean blue
    });
    registerSpriteRenderer(sr);

    // Smooth zoom: redirect the whole world renderer into a supersampled offscreen render
    // target and present it scaled (see present.ts). `render` is the seam-safe RUNG view the
    // tiles actually rasterise at — integer zoom + pixel-snapped origin + the RT size — while
    // the fractional zoom lives in the present scale. World-anchored effects render into the
    // same RT, so they are driven by `render`, not the continuous `view`.
    const present = createPresent(engine, sr);
    present.resize(engine.canvas.width || 1, engine.canvas.height || 1);
    const render: RenderView = { x: 0, y: 0, zoom: 1, w: engine.canvas.width || 1, h: engine.canvas.height || 1, dz: 1 };
    syncView = (): void => {
        const cw = engine.canvas.width || 1;
        const ch = engine.canvas.height || 1;
        const z = view.zoom;
        const R = ceilRung(z); // smallest seam-safe rung ≥ the continuous zoom
        // The engine SpriteRenderer always projects at the CANVAS size even when targeting an
        // offscreen RT (it reads the surface, not the target). So rendering into the SS×-sized RT
        // stretches the canvas projection by SS. We pre-divide the projection zoom by SS so the
        // stretch lands the tiles at exactly effective scale R in the RT (seam-safe), and size the
        // fullscreen-FX quads to the canvas (the SS× stretch then fills the RT).
        const ss = present.width / cw; // supersample factor (RT px per canvas px), exactly 2
        render.zoom = R / ss; //          canvas-projection zoom; ×ss stretch ⇒ effective RT scale R
        render.dz = z; //                 continuous display zoom (for the atmosphere altitude fade)
        render.w = cw; //                 FX quads size to the canvas; the ×ss stretch fills the RT
        render.h = ch;
        // Snap the RT origin to the rung's (effective-scale-R) device-pixel grid so the alpha-baked
        // diamonds tessellate crack-free; the sub-rung remainder is carried in the present offset.
        render.x = Math.round(view.x * R) / R;
        render.y = Math.round(view.y * R) / R;
        for (const layer of layers) {
            layer.view.positionPx[0] = render.x;
            layer.view.positionPx[1] = render.y;
            layer.view.zoom = render.zoom;
        }
        // Present the RT sub-rect matching the viewport. RT pixel of world W = (W − render.x)·R
        // (effective scale R after the ×ss stretch); the viewport spans cw·R/z RT px. This composite
        // exactly reproduces `world = view.x + screenPx/zoom`, so all inverse math uses raw `view`.
        present.sync(cw, ch, (view.x - render.x) * R, (view.y - render.y) * R, (cw * R) / z, (ch * R) / z);
    };

    // Drifting clouds over the parchment backdrop, behind the map (subtle).
    const atmosphere = createAtmosphere(engine, sr);

    // Fog of war: one continuous, world-anchored haze field (a fullscreen quad that
    // samples a per-tile sight texture) instead of per-tile diamonds, so the sight
    // frontier reads as smooth drifting mist with no isometric silhouette.
    const fog = createFog(engine, sr, world);

    // Sun-glints: bright specular sparkles twinkling on the open sea, gated by the
    // day/night `daylight()` so they catch the sun by day and vanish at night.
    const glints = createGlints(engine, sr, world);

    // Dust kicked up under the scout as it walks — a small CPU particle trail that
    // fades behind the moving unit (below the unit/city sprites, above terrain).
    const dust = createDust(engine, sr);

    // Command feedback FX: a marching-ants ring on the scout's destination tile and a
    // click-ping ripple acknowledging each order. (The selected-unit indicator is the
    // scout's own alpha blink, driven from live.ts — not this layer.) Assigned to the
    // forward `commandFx` declared above so the click handler can fire pings.
    commandFx = createCommandFx(engine, sr);

    // Slow day/night cycle: a full-screen alpha grade plus warm additive city lights that
    // bloom after sunset. World-anchored, so it renders into the RT with the map.
    const dayNight = createDayNight(engine, sr, world);

    // Screen-space vignette: darkens the corners so the void around the island fades to
    // shadow. HUD layer — drawn on the present's swapchain pass, on top of the scaled map.
    const vignette = createVignette(engine, present.screen);

    installControls(engine, view, zoomCtl, picker.hover, onMapClick);
    recenter();
    const onResize = (): void => {
        present.resize(engine.canvas.width || 1, engine.canvas.height || 1);
        recenter(); // re-fits only if the user hasn't panned/zoomed
        syncView(); // always re-anchor for the new RT size
    };
    window.addEventListener("resize", onResize);

    const labels = createCityLabels(world.cities);

    // Overview minimap (corner). A HUD layer on the present's swapchain pass; its viewport
    // box inverts the continuous `view` the map is presented at.
    const minimap = createMinimap(engine, present.screen, world, {
        viewportCorners: () => viewportTileCorners(view, engine),
        panToTile: (tx, ty) => {
            centreViewOnTile(view, engine, tx, ty);
            zoomCtl.target = view.zoom; // cancel any in-flight zoom ease
        },
    });

    progress.done();
    await startEngine(engine);
    recenter();

    // Animation loop: advance the live sim and reposition floating city labels.
    let last = performance.now();
    // The GPU map is drawn by the engine's render loop, which runs a frame AFTER `syncView` sets
    // its transform (the engine rAF was registered before this tick rAF). So the map you see this
    // frame reflects the PREVIOUS tick's view. The DOM city labels paint the same frame the tick
    // runs, so to keep them glued to the map we drive them from this one-frame-old snapshot —
    // otherwise they lead the map by a frame and visibly bump when the zoom accelerates/decelerates.
    const presentedView: View = { x: view.x, y: view.y, zoom: view.zoom, userMoved: false };
    const tick = (now: number): void => {
        const dt = Math.min(100, now - last);
        last = now;
        sim.step(dt);
        // Ease the continuous zoom toward the wheel target, holding the cursor's world point
        // fixed, so notched wheels glide. Driving it here (not in the wheel event) keeps the
        // tiles and all world-anchored FX in lockstep — they all read the SAME `view` this frame.
        if (Math.abs(zoomCtl.target - view.zoom) > 1e-4) {
            view.zoom += (zoomCtl.target - view.zoom) * 0.25;
            if (Math.abs(zoomCtl.target - view.zoom) <= 1e-4) view.zoom = zoomCtl.target;
            view.x = zoomCtl.wx - zoomCtl.sx / view.zoom;
            view.y = zoomCtl.wy - zoomCtl.sy / view.zoom;
            view.userMoved = true;
        }
        syncView(); // recompute the seam-safe render view + present scale for this frame
        const [scoutX, scoutY] = sim.scoutTile();
        fog.update(render, scoutX, scoutY);
        dayNight.update(render);
        glints.update(render, dayNight.daylight());
        const [scoutWx, scoutWy] = sim.scoutWorld();
        dust.update(render, scoutWx, scoutWy, sim.scoutMoving(), dt);
        // Clear the marching-ants destination once the scout reaches it (idle again).
        if (scoutDest && !sim.scoutMoving()) {
            const [stx, sty] = sim.scoutTile();
            if (stx === scoutDest[0] && sty === scoutDest[1]) scoutDest = null;
        }
        commandFx?.update(render, { dest: scoutDest }, dt);
        atmosphere.update(render, dayNight.daylight());
        vignette.update();
        waterFx.update();
        labels.update(presentedView, engine);
        // Snapshot the view the engine will composite the map from next frame (see presentedView).
        presentedView.x = view.x;
        presentedView.y = view.y;
        presentedView.zoom = view.zoom;
        minimap.update();
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
            const cv = engine.canvas as HTMLCanvasElement;
            const dpr = (cv.width || 1) / (cv.clientWidth || 1);
            // The present composite reproduces the world exactly at the continuous view
            // (world = view.x + screenPx/zoom), so labels track the raw view — no rung snap.
            const z = view.zoom;
            for (const a of anchors) {
                const sx = ((a.wx - view.x) * z) / dpr;
                const sy = ((a.wy - view.y) * z) / dpr;
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

/** The seam-safe RUNG view the world is rasterised at (integer zoom + pixel-snapped origin)
 *  plus the render-target size in device pixels. World-anchored effects read this, not `view`. */
interface RenderView {
    x: number;
    y: number;
    zoom: number;
    w: number;
    h: number;
    /** Continuous display zoom (the perceived zoom); `zoom` is the seam-safe rung. */
    dz: number;
}

/** Continuous-zoom clamp = the rung ladder's extremes (the minimap owns the whole-map
 *  overview, so the main canvas need not zoom out past ½). */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;

/** Fit the whole map into the viewport and centre it. */
function fitView(view: View, engine: EngineContext, b: Bounds): void {
    const w = engine.canvas.width || 1;
    const h = engine.canvas.height || 1;
    const mapW = b.maxX - b.minX + TILE_W;
    const mapH = b.maxY - b.minY + TILE_H;
    // Seed continuous zoom, clamped to the rung range.
    view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(w / mapW, h / mapH) * 0.95));
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    view.x = cx - w / 2 / view.zoom;
    view.y = cy - h / 2 / view.zoom;
}

/**
 * Seam-safe zoom rungs for nearest-filtered diamond tiles: the ≥1 rungs are integers (one
 * texel maps to a whole number of device pixels, so shared diamond edges never resample — no
 * 1px cracks), and the ½ rung minifies enough that any sub-pixel seam is invisible. The tiles
 * are always rasterised at one of these (into the offscreen RT); the present pass then scales
 * that crack-free image to the continuous on-screen zoom (see syncView / present.ts).
 */
const ZOOM_RUNGS = [0.5, 1, 2, 4, 8] as const;

/** Smallest rung ≥ `zoom`, clamped to the ladder. Rendering at the CEILING rung and
 *  down-scaling on present keeps the pixel art crisp (a floor rung would up-scale = blur). */
function ceilRung(zoom: number): number {
    for (const r of ZOOM_RUNGS) {
        if (zoom <= r + 1e-6) return r;
    }
    return ZOOM_RUNGS[ZOOM_RUNGS.length - 1]!;
}

/**
 * Device-pixel cursor position → tile `(x, y)`. The present composite reproduces the world
 * exactly at the continuous view (`world = view.x + screenPx/zoom`), so this inverts the raw
 * `view` directly — the tile under the highlight matches the tile under the pointer exactly.
 */
function screenToTile(view: View, sxDevice: number, syDevice: number): [number, number] {
    return worldToTile(view.x + sxDevice / view.zoom, view.y + syDevice / view.zoom);
}

/**
 * The four screen corners (TL, TR, BR, BL) of the main canvas expressed in
 * fractional tile coordinates — the slice of the world currently on screen. Used
 * to draw the viewport box on the minimap. Inverts the SAME snapped view as
 * {@link screenToTile} but WITHOUT rounding (we want the exact sub-tile quad).
 */
function viewportTileCorners(view: View, engine: EngineContext): Array<[number, number]> {
    const z = view.zoom;
    const vx = view.x;
    const vy = view.y;
    const w = engine.canvas.width || 1;
    const h = engine.canvas.height || 1;
    const screen: ReadonlyArray<readonly [number, number]> = [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
    ];
    return screen.map(([px, py]) => {
        const worldX = vx + px / z;
        const worldY = vy + py / z;
        const xMinusY = (2 * worldX) / TILE_W;
        const xPlusY = (2 * worldY) / TILE_H;
        return [(xPlusY + xMinusY) / 2, (xPlusY - xMinusY) / 2];
    });
}

/** Recentre the logical view so tile `(tx, ty)` sits at the canvas centre. */
function centreViewOnTile(view: View, engine: EngineContext, tx: number, ty: number): void {
    const [wx, wy] = isoCentre(tx, ty);
    const w = engine.canvas.width || 1;
    const h = engine.canvas.height || 1;
    view.x = wx - w / 2 / view.zoom;
    view.y = wy - h / 2 / view.zoom;
    view.userMoved = true;
}

/** Roads are this much cheaper to traverse than open terrain. */
const ROAD_DISCOUNT = 1 / 3;

/**
 * Dijkstra shortest path over land tiles from `(sx, sy)` to `(gx, gy)` using the
 * eight isometric neighbours. Every step costs the same, so the route minimises
 * the number of tiles walked — which favours diagonal grid moves (they cover more
 * ground per step) and keeps journeys short. Stepping between two road tiles is
 * much cheaper than crossing open terrain, so the scout also follows roads where
 * they help. Returns the tiles to walk (excluding the start, including the goal),
 * or `null` if the goal is off-map, ocean, or unreachable.
 */
function findPath(world: GameMap, sx: number, sy: number, gx: number, gy: number): Array<[number, number]> | null {
    const W = world.width;
    const H = world.height;
    if (gx < 0 || gy < 0 || gx >= W || gy >= H || !world.isLand(gx, gy)) return null;
    if (sx === gx && sy === gy) return null;
    const N = W * H;
    const dist = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const done = new Uint8Array(N);
    const start = sy * W + sx;
    const goal = gy * W + gx;
    dist[start] = 0;
    for (;;) {
        // Closest unfinished node (linear scan — the 48×48 map is tiny).
        let u = -1;
        let best = Infinity;
        for (let i = 0; i < N; i++) {
            if (!done[i] && dist[i]! < best) {
                best = dist[i]!;
                u = i;
            }
        }
        if (u === -1 || u === goal) break;
        done[u] = 1;
        const ux = u % W;
        const uy = (u - ux) / W;
        const onRoad = world.hasRoad(ux, uy);
        for (const d of DIR8) {
            const [dx, dy] = DIR_DELTA[d];
            const nx = ux + dx;
            const ny = uy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            if (!world.isLand(nx, ny)) continue;
            const v = ny * W + nx;
            if (done[v]) continue;
            const onRoadStep = onRoad && world.hasRoad(nx, ny);
            const cost = onRoadStep ? ROAD_DISCOUNT : 1;
            const nd = dist[u]! + cost;
            if (nd < dist[v]!) {
                dist[v] = nd;
                prev[v] = u;
            }
        }
    }
    if (dist[goal] === Infinity) return null;
    const path: Array<[number, number]> = [];
    for (let cur = goal; cur !== start && cur !== -1; cur = prev[cur]!) {
        const cx = cur % W;
        path.push([cx, (cur - cx) / W]);
    }
    path.reverse();
    return path;
}

/** Callback fired as the cursor moves over the map; `tileX = null` clears hover. */
type HoverFn = (tileX: number | null, tileY: number | null, cssX: number, cssY: number) => void;

/** Smooth-zoom controller: the wheel writes a `target` + cursor anchor here; the tick eases
 *  `view.zoom` toward it (see the tick loop). Pan / minimap cancel the ease by matching target. */
interface ZoomCtl {
    target: number;
    wx: number;
    wy: number;
    sx: number;
    sy: number;
}

function installControls(engine: EngineContext, view: View, zoomCtl: ZoomCtl, onHover?: HoverFn, onClick?: (tileX: number, tileY: number) => void): void {
    const canvas = engine.canvas as HTMLCanvasElement;
    const dpr = (): number => (canvas.width || 1) / (canvas.clientWidth || 1);
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let downX = 0;
    let downY = 0;

    canvas.addEventListener("pointerdown", (e) => {
        dragging = true;
        lastX = downX = e.clientX;
        lastY = downY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
        if (dragging) {
            const k = dpr() / view.zoom;
            view.x -= (e.clientX - lastX) * k;
            view.y -= (e.clientY - lastY) * k;
            lastX = e.clientX;
            lastY = e.clientY;
            view.userMoved = true;
            zoomCtl.target = view.zoom; // a pan cancels any in-flight zoom ease
            // No syncView() here: the tick re-syncs every frame, keeping tiles + FX in lockstep.
        } else if (onHover) {
            const rect = canvas.getBoundingClientRect();
            const [tx, ty] = screenToTile(view, (e.clientX - rect.left) * dpr(), (e.clientY - rect.top) * dpr());
            onHover(tx, ty, e.clientX, e.clientY);
        }
    });
    canvas.addEventListener("pointerleave", () => onHover?.(null, null, 0, 0));
    const endDrag = (e: PointerEvent): void => {
        dragging = false;
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener("pointerup", (e) => {
        const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
        endDrag(e);
        // A press that didn't pan is a click → resolve the tile and dispatch it.
        if (moved < 5 && onClick) {
            const rect = canvas.getBoundingClientRect();
            const [tx, ty] = screenToTile(view, (e.clientX - rect.left) * dpr(), (e.clientY - rect.top) * dpr());
            onClick(tx, ty);
        }
    });
    canvas.addEventListener("pointercancel", endDrag);

    // Continuous, cursor-anchored wheel zoom. The wheel only nudges the eased TARGET (and records
    // the world point under the cursor); the tick glides `view.zoom` toward it and re-anchors each
    // frame, so a notched mouse zooms smoothly instead of jumping a step per notch. The seam-safe
    // rung rasterisation + scaled present (syncView / present.ts) keep every fractional zoom
    // crack-free along the way.
    canvas.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const sx = (e.clientX - rect.left) * dpr();
            const sy = (e.clientY - rect.top) * dpr();
            // Anchor on the world point currently under the cursor (live zoom), so the ease holds
            // it fixed even if more notches arrive mid-glide.
            zoomCtl.wx = view.x + sx / view.zoom;
            zoomCtl.wy = view.y + sy / view.zoom;
            zoomCtl.sx = sx;
            zoomCtl.sy = sy;
            zoomCtl.target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomCtl.target * Math.pow(2, -e.deltaY / 500)));
        },
        { passive: false }
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
