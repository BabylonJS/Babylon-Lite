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
import { createAtmosphere } from "./freeciv/atmosphere.js";
import { createBackdrop } from "./freeciv/backdrop.js";
import { createWater } from "./freeciv/water.js";
import { createVignette } from "./freeciv/vignette.js";
import { generateWorld, type GameMap } from "./freeciv/worldgen.js";
import { buildTilemap, type Bounds, type TileLayers, type TileSheets } from "./freeciv/tilemap.js";
import { createLiveSim } from "./freeciv/live.js";
import { createPicker } from "./freeciv/pick.js";
import { createMinimap } from "./freeciv/minimap.js";
import { DIR8, DIR_DELTA, TILE_H, TILE_W, isoCentre, worldToTile } from "./freeciv/iso.js";

// Relative (no leading slash) so the tileset resolves against the page URL —
// works both on the dev server (root) and when the demo is published under a
// sub-path (e.g. GitHub Pages project page). An absolute "/freeciv" would 404
// on a sub-path deployment. Mirrors the minecraft/doom demos.
const BASE_URL = "freeciv";

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

    const world = generateWorld({ width: 96, height: 96, seed: 7 });
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
        tileLayers.fog,
        tileLayers.selection,
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
    const setArmed = (on: boolean): void => {
        unitSelected = on;
        hint.style.display = on ? "block" : "none";
        canvas.style.cursor = on ? "crosshair" : "";
        sim.setScoutSelected(on);
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
            setArmed(false);
        }
        // Unreachable target (ocean / off-map): stay armed so the player can retry.
    };

    const view: View = { x: 0, y: 0, zoom: 1, userMoved: false };
    // Start pointed at Babylon (the player's capital) rather than the geometric
    // centre of the map bounds, which sits further south.
    const capital = world.cities.find((c) => c.name === "Babylon") ?? world.cities[0];
    const recenter = (): void => {
        if (view.userMoved) return;
        fitView(view, engine, bounds);
        if (capital) {
            const [wx, wy] = isoCentre(capital.x, capital.y);
            const w = engine.canvas.width || 1;
            const h = engine.canvas.height || 1;
            view.x = wx - w / 2 / view.zoom;
            view.y = wy - h / 2 / view.zoom;
        }
        applyView(view, layers);
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

    // Drifting clouds over the parchment backdrop, behind the map (subtle).
    const atmosphere = createAtmosphere(engine, sr);

    // Screen-space vignette: darkens the corners so the void around the island
    // fades to shadow instead of exposing the Mercator backdrop at the edges.
    const vignette = createVignette(engine, sr);

    installControls(engine, view, layers, picker.hover, onMapClick);
    recenter();
    window.addEventListener("resize", recenter);

    const labels = createCityLabels(world.cities);

    // Overview minimap (corner). Its viewport box inverts the SAME snapped view the
    // tiles render with; clicking/dragging recentres the main view on that tile.
    const minimap = createMinimap(engine, sr, world, {
        viewportCorners: () => viewportTileCorners(view, engine),
        panToTile: (tx, ty) => {
            centreViewOnTile(view, engine, tx, ty);
            applyView(view, layers);
        },
    });

    await startEngine(engine);
    recenter();

    // Animation loop: advance the live sim and reposition floating city labels.
    let last = performance.now();
    const tick = (now: number): void => {
        const dt = Math.min(100, now - last);
        last = now;
        sim.step(dt);
        atmosphere.update(view);
        vignette.update();
        waterFx.update();
        labels.update(view, engine);
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
    // Seed the zoom on the ladder so the very first frame is already crack-free and
    // in lock-step with the wheel handler (snapped to ½, the widest rung).
    view.zoom = snapZoom(Math.min(w / mapW, h / mapH) * 0.95);
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
 * Discrete zoom ladder. Every rung is seam-safe for nearest-filtered diamond tiles:
 * the ≥1 rungs are integers (one texel maps to a whole number of device pixels, so
 * shared diamond edges never resample at a fractional offset — no 1px cracks), and
 * the ½ rung minifies the tiles enough that any sub-pixel seam is invisible. The
 * whole-map overview lives on the minimap, so the main canvas need not zoom out
 * past ½. Zoom is quantised to these rungs (see the wheel handler) so it can never
 * land on a crack-producing fractional scale — which is why the old render-time
 * integer snap is gone and `view.zoom` is always exactly one of these values.
 */
const ZOOM_LEVELS = [0.5, 1, 2, 4, 8] as const;

/** Index of the ladder rung nearest `zoom`, compared in log space so the
 *  power-of-two gaps feel perceptually even. */
function nearestZoomLevel(zoom: number): number {
    const target = Math.log(zoom);
    let best = 0;
    let bestErr = Infinity;
    for (let i = 0; i < ZOOM_LEVELS.length; i++) {
        const err = Math.abs(Math.log(ZOOM_LEVELS[i]!) - target);
        if (err < bestErr) {
            bestErr = err;
            best = i;
        }
    }
    return best;
}

/**
 * Snap an arbitrary zoom to its nearest ladder rung. Because the wheel handler keeps
 * `view.zoom` ON a rung at all times, this is effectively identity for the live view;
 * it only does real work for the one-off `fitView` seed. Kept as the single chokepoint
 * so `screenToTile`, the city labels and the minimap all read the same rendered scale.
 */
function snapZoom(zoom: number): number {
    return ZOOM_LEVELS[nearestZoomLevel(zoom)]!;
}

/**
 * Device-pixel cursor position → tile `(x, y)`. Inverts the SNAPPED view that is
 * actually rendered (same `snapZoom` + rounded origin as {@link applyView}), so the
 * tile under the highlight matches the tile under the pointer exactly.
 */
function screenToTile(view: View, sxDevice: number, syDevice: number): [number, number] {
    const z = snapZoom(view.zoom);
    const vx = Math.round(view.x * z) / z;
    const vy = Math.round(view.y * z) / z;
    return worldToTile(vx + sxDevice / z, vy + syDevice / z);
}

/**
 * The four screen corners (TL, TR, BR, BL) of the main canvas expressed in
 * fractional tile coordinates — the slice of the world currently on screen. Used
 * to draw the viewport box on the minimap. Inverts the SAME snapped view as
 * {@link screenToTile} but WITHOUT rounding (we want the exact sub-tile quad).
 */
function viewportTileCorners(view: View, engine: EngineContext): Array<[number, number]> {
    const z = snapZoom(view.zoom);
    const vx = Math.round(view.x * z) / z;
    const vy = Math.round(view.y * z) / z;
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
            if (!done[i] && dist[i] < best) {
                best = dist[i];
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
            const nd = dist[u] + cost;
            if (nd < dist[v]) {
                dist[v] = nd;
                prev[v] = u;
            }
        }
    }
    if (dist[goal] === Infinity) return null;
    const path: Array<[number, number]> = [];
    for (let cur = goal; cur !== start && cur !== -1; cur = prev[cur]) {
        const cx = cur % W;
        path.push([cx, (cur - cx) / W]);
    }
    path.reverse();
    return path;
}

/** Callback fired as the cursor moves over the map; `tileX = null` clears hover. */
type HoverFn = (tileX: number | null, tileY: number | null, cssX: number, cssY: number) => void;

function installControls(
    engine: EngineContext,
    view: View,
    layers: readonly Sprite2DLayer[],
    onHover?: HoverFn,
    onClick?: (tileX: number, tileY: number) => void,
): void {
    const canvas = engine.canvas;
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
            applyView(view, layers);
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

    // Discrete, device-independent zoom: scroll accumulates until it crosses one
    // notch's worth of delta, then steps exactly one ladder rung. This kills the old
    // "dead zone then lurch" feel (continuous zoom rounded to an integer at render
    // time) — every step is the same size and lands on a seam-safe rung. No tween:
    // an animated transit would pass through fractional integer-zooms and flash the
    // 1px tile cracks the ladder exists to avoid.
    const WHEEL_NOTCH = 100; // device-px of scroll per zoom step (one mouse notch)
    let wheelAccum = 0;
    canvas.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();
            wheelAccum += e.deltaY;
            let steps = 0; // +1 per notch = zoom IN (scroll up → negative deltaY)
            while (wheelAccum <= -WHEEL_NOTCH) {
                steps++;
                wheelAccum += WHEEL_NOTCH;
            }
            while (wheelAccum >= WHEEL_NOTCH) {
                steps--;
                wheelAccum -= WHEEL_NOTCH;
            }
            if (steps === 0) return;

            const idx = nearestZoomLevel(view.zoom);
            const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, idx + steps));
            if (next === idx) return; // already at a rail

            const rect = canvas.getBoundingClientRect();
            const sx = (e.clientX - rect.left) * dpr();
            const sy = (e.clientY - rect.top) * dpr();
            // Hold the world point under the cursor fixed across the step. Anchor on the
            // SNAPPED origin that is actually rendered (matching `applyView`), else the
            // target appears to orbit the corner instead of staying under the pointer.
            const zBefore = snapZoom(view.zoom);
            const wx = Math.round(view.x * zBefore) / zBefore + sx / zBefore;
            const wy = Math.round(view.y * zBefore) / zBefore + sy / zBefore;
            const zAfter = ZOOM_LEVELS[next]!;
            view.zoom = zAfter;
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
