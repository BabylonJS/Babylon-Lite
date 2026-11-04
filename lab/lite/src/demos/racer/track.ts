/**
 * Racer track — the ground plane plus a closed circuit assembled from the kit's
 * `track-straight` / `track-corner` GLB tiles (each a 10×10 unit cell).
 *
 * The circuit is defined as an ordered loop of grid cells (`TRACK_LOOP`); each
 * tile's kind and rotation are derived from the path direction through that cell,
 * so straights and corners always connect correctly without per-corner tuning.
 */

import type { AssetContainer, EngineContext, Mesh, SceneContext, TransformNode } from "babylon-lite";
import { addToScene, cloneTransformNode, createGround, createStandardMaterial, getContainerMeshes, loadGltf } from "babylon-lite";

import { demoAssetUrl } from "../demo-asset-url.js";

const TILE = 10; // world units per tile (measured from the GLB AABBs)
const WALL_INSET = 4.3; // distance from a tile's center to its barrier wall (road ~= 2×inset wide)
const WALL_THICK = 0.6; // wall collider thickness
const CORNER_ARC_SEGMENTS = 6; // short walls tracing each corner's curved outer edge
const CORNER_ARC_OVERLAP = 0.6; // extra segment length so consecutive arc walls overlap (leave no gap)
const BUMP_HEIGHT = 0.45; // track-bump.glb rises to ~0.45
const BUMP_RADIUS = 1.3; // track-bump.glb footprint half-extent
const GROUND_Y = -0.02; // just below the tiles: enough depth separation without a visible floating ledge

/** An axis-aligned barrier segment (world XZ), used to build the physics colliders. */
export interface Wall {
    /** Center (world x, z). */
    readonly cx: number;
    readonly cz: number;
    /** Full size along world x and z. */
    readonly sx: number;
    readonly sz: number;
    /** Optional yaw (radians) about Y — for diagonal corner-seal walls; omitted = axis-aligned. */
    readonly rot?: number;
}

/** An axis-aligned rectangular zone on the track (start/finish line or a checkpoint), for lap detection. */
export interface TriggerZone {
    readonly cx: number;
    readonly cz: number;
    readonly sx: number;
    readonly sz: number;
}

/** A static sphere collider approximating a bump dome (buried so its cap pokes up ≈ the visible dome). */
export interface BumpCollider {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly radius: number;
}

export interface Track {
    readonly ground: Mesh;
    /** Renderable tile meshes, for shadow registration. */
    readonly meshes: readonly Mesh[];
    /** Barrier segments tracing the road edges, for physics containment. */
    readonly walls: readonly Wall[];
    /** Static sphere colliders for the speed bumps, so the ball physically rides over them. */
    readonly bumpColliders: readonly BumpCollider[];
    /** A good spawn point (x,z) and heading for the car, on the loop. */
    readonly spawn: { x: number; z: number; heading: number };
    /** Start/finish line — crossing it (after all checkpoints) completes a lap. */
    readonly finishLine: TriggerZone;
    /** Checkpoint lines around the loop; all must be crossed for a lap to count. */
    readonly checkpoints: readonly TriggerZone[];
    /** The loop centreline in world XZ (closed), for the minimap. */
    readonly path: readonly { x: number; z: number }[];
}

/** A grid cell on the track loop. */
interface Cell {
    gx: number;
    gz: number;
}

/** One placed tile: grid coordinates, which GLB, and a quarter-turn count. */
interface TilePlacement extends Cell {
    kind: "straight" | "corner";
    /** Quarter turns (×90°) about Y. */
    rot: number;
}

/** Cardinal direction in grid space: N = −z, E = +x, S = +z, W = −x. */
type Card = "N" | "E" | "S" | "W";

/** Heading (radians) to drive toward each cardinal, matching the vehicle's
 *  forward = (sin h, cos h) convention. */
const CARD_HEADING: Record<Card, number> = { N: Math.PI, E: Math.PI / 2, S: 0, W: -Math.PI / 2 };

/** Outward unit normal of each tile side in world XZ, and the four sides for iteration. */
const SIDE_NORMAL: Record<Card, { x: number; z: number }> = { N: { x: 0, z: -1 }, E: { x: 1, z: 0 }, S: { x: 0, z: 1 }, W: { x: -1, z: 0 } };
const ALL_CARDS: readonly Card[] = ["N", "E", "S", "W"];

/** Cardinal direction from cell `a` to the adjacent cell `b`. */
function cardFromTo(a: Cell, b: Cell): Card {
    const dx = b.gx - a.gx;
    const dz = b.gz - a.gz;
    if (dx === 1 && dz === 0) {
        return "E";
    }
    if (dx === -1 && dz === 0) {
        return "W";
    }
    if (dx === 0 && dz === 1) {
        return "S";
    }
    if (dx === 0 && dz === -1) {
        return "N";
    }
    throw new Error(`track loop cells are not adjacent: (${a.gx},${a.gz}) -> (${b.gx},${b.gz})`);
}

/**
 * Choose the tile kind + quarter-turn for a cell from the two sides its road
 * connects. Derived from (and validated against) the Kenney tiles' default
 * orientation: a `straight` at rot 0 runs N–S; a `corner` at rot 0 opens to its
 * E and S edges; each +1 is a +90° turn about Y. Computing this from the path
 * (instead of hand-tuning each corner) is what keeps every corner consistent.
 */
function tileForOpenings(a: Card, b: Card): { kind: "straight" | "corner"; rot: number } {
    const s = new Set<Card>([a, b]);
    const has = (x: Card, y: Card): boolean => s.has(x) && s.has(y);
    if (has("E", "W")) {
        return { kind: "straight", rot: 1 };
    }
    if (has("N", "S")) {
        return { kind: "straight", rot: 0 };
    }
    if (has("E", "S")) {
        return { kind: "corner", rot: 0 };
    }
    if (has("E", "N")) {
        return { kind: "corner", rot: 1 };
    }
    if (has("W", "N")) {
        return { kind: "corner", rot: 2 };
    }
    if (has("W", "S")) {
        return { kind: "corner", rot: 3 };
    }
    throw new Error(`invalid track openings: ${a}, ${b}`);
}

/**
 * Expand a closed loop of adjacent grid cells into placed tiles. Each cell's
 * road connects the side facing the previous cell and the side facing the next,
 * so straight-vs-corner and rotation fall out automatically.
 */
function tilesFromLoop(loop: readonly Cell[]): TilePlacement[] {
    const n = loop.length;
    return loop.map((cur, i) => {
        const prev = loop[(i - 1 + n) % n]!;
        const next = loop[(i + 1) % n]!;
        const { kind, rot } = tileForOpenings(cardFromTo(cur, prev), cardFromTo(cur, next));
        return { gx: cur.gx, gz: cur.gz, kind, rot };
    });
}

/**
 * Trace barrier walls around the circuit. A cell's road connects the two sides
 * facing its neighbours; the OTHER two sides border grass, so each gets a wall.
 * Together these enclose both the outfield and the infield.
 */
function wallsFromLoop(loop: readonly Cell[], gridToWorld: (gx: number, gz: number) => { x: number; z: number }): Wall[] {
    const n = loop.length;
    const walls: Wall[] = [];
    loop.forEach((cur, i) => {
        const prev = loop[(i - 1 + n) % n]!;
        const next = loop[(i + 1) % n]!;
        const openCards: Card[] = [cardFromTo(cur, prev), cardFromTo(cur, next)];
        const open = new Set<Card>(openCards);
        const { x: wx, z: wz } = gridToWorld(cur.gx, cur.gz);
        const wallSides = ALL_CARDS.filter((c) => !open.has(c));

        // A corner's two walls are perpendicular and its road is a quarter-arc. Approximating that
        // arc with two axis-aligned boxes leaves a triangular gap along the curved outer edge that
        // the car drifts through — so trace the arc with a chain of short, overlapping segments.
        const isCorner =
            wallSides.length === 2 && SIDE_NORMAL[wallSides[0]!].x + SIDE_NORMAL[wallSides[1]!].x !== 0 && SIDE_NORMAL[wallSides[0]!].z + SIDE_NORMAL[wallSides[1]!].z !== 0;
        if (isCorner) {
            addCornerArcWalls(walls, wx, wz, wallSides, openCards);
            return;
        }
        // Straight: a full-length wall on each grass side.
        for (const side of wallSides) {
            const nrm = SIDE_NORMAL[side];
            walls.push({ cx: wx + nrm.x * WALL_INSET, cz: wz + nrm.z * WALL_INSET, sx: nrm.x !== 0 ? WALL_THICK : TILE, sz: nrm.z !== 0 ? WALL_THICK : TILE });
        }
    });
    return walls;
}

/**
 * Trace a corner's curved OUTER barrier with a chain of short, slightly-overlapping wall segments.
 * The arc is centred on the tile's inner corner (toward the two open sides), radius = the outer road
 * edge; its endpoints lie along the two wall-side normals, meeting the neighbouring straights' walls.
 * Consecutive segments share endpoints, so the ball can't slip between them.
 */
function addCornerArcWalls(walls: Wall[], wx: number, wz: number, wallSides: Card[], openCards: Card[]): void {
    const cx = wx + (SIDE_NORMAL[openCards[0]!].x + SIDE_NORMAL[openCards[1]!].x) * (TILE / 2);
    const cz = wz + (SIDE_NORMAL[openCards[0]!].z + SIDE_NORMAL[openCards[1]!].z) * (TILE / 2);
    const radius = TILE / 2 + WALL_INSET;
    const angA = Math.atan2(SIDE_NORMAL[wallSides[0]!].z, SIDE_NORMAL[wallSides[0]!].x);
    const angB = Math.atan2(SIDE_NORMAL[wallSides[1]!].z, SIDE_NORMAL[wallSides[1]!].x);
    let sweep = angB - angA;
    while (sweep > Math.PI) {
        sweep -= 2 * Math.PI;
    }
    while (sweep < -Math.PI) {
        sweep += 2 * Math.PI;
    }
    const at = (a: number): { x: number; z: number } => ({ x: cx + radius * Math.cos(a), z: cz + radius * Math.sin(a) });
    let a0 = at(angA);
    for (let s = 1; s <= CORNER_ARC_SEGMENTS; s++) {
        const a1 = at(angA + (sweep * s) / CORNER_ARC_SEGMENTS);
        const dx = a1.x - a0.x;
        const dz = a1.z - a0.z;
        walls.push({ cx: (a0.x + a1.x) / 2, cz: (a0.z + a1.z) / 2, sx: Math.hypot(dx, dz) + CORNER_ARC_OVERLAP, sz: WALL_THICK, rot: Math.atan2(dz, dx) });
        a0 = a1;
    }
}

/**
 * The circuit: a closed clockwise loop of grid cells — a stretched rectangle
 * with a chicane on the lower straight. Richer than a plain square while still
 * using only straight + corner tiles.
 */
const TRACK_LOOP: readonly Cell[] = [
    // Top straight (west → east)
    { gx: 1, gz: 1 },
    { gx: 2, gz: 1 },
    { gx: 3, gz: 1 },
    { gx: 4, gz: 1 },
    { gx: 5, gz: 1 },
    { gx: 6, gz: 1 },
    { gx: 7, gz: 1 },
    // Right straight (north → south)
    { gx: 7, gz: 2 },
    { gx: 7, gz: 3 },
    { gx: 7, gz: 4 },
    // Lower straight (east → west) with a chicane bump
    { gx: 6, gz: 4 },
    { gx: 5, gz: 4 },
    { gx: 5, gz: 3 },
    { gx: 4, gz: 3 },
    { gx: 3, gz: 3 },
    { gx: 3, gz: 4 },
    { gx: 2, gz: 4 },
    { gx: 1, gz: 4 },
    // Left straight (south → north)
    { gx: 1, gz: 3 },
    { gx: 1, gz: 2 },
];

/** Grid center, so the circuit sits around the world origin. */
function loopCenter(loop: readonly Cell[]): { cx: number; cz: number } {
    const xs = loop.map((c) => c.gx);
    const zs = loop.map((c) => c.gz);
    return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cz: (Math.min(...zs) + Math.max(...zs)) / 2 };
}

/** The cell carrying the start/finish gate — a straight-road variant (a few cells ahead of spawn). */
const FINISH_CELL: Cell = { gx: 5, gz: 1 };

/** Checkpoints spread around the loop (opposite the finish) — all required for a valid lap. */
const CHECKPOINT_CELLS: readonly Cell[] = [
    { gx: 7, gz: 3 }, // right straight
    { gx: 2, gz: 4 }, // lower straight
    { gx: 1, gz: 3 }, // left straight
];

const ROAD_SPAN = 2 * WALL_INSET; // lap-zone width across the road
const LINE_THICK = 2.5; // lap-zone depth along the direction of travel

/** Which world axis the road runs along at a loop cell (from its outgoing direction). */
function loopTravelAxis(cell: Cell): "x" | "z" {
    const i = TRACK_LOOP.findIndex((c) => c.gx === cell.gx && c.gz === cell.gz);
    if (i < 0) {
        throw new Error(`lap-zone cell is not on the track loop: (${cell.gx},${cell.gz})`);
    }
    const card = cardFromTo(cell, TRACK_LOOP[(i + 1) % TRACK_LOOP.length]!);
    return card === "E" || card === "W" ? "x" : "z";
}

/** A forest / tent prop placed on a grass cell (infield or outfield). */
interface DecoPlacement extends Cell {
    kind: "forest" | "tents";
    /** Quarter turns (×90°) about Y, for variety. */
    rot: number;
}

/** Decorations scattered on grass cells — the car can't reach them (barriers), so they're visual only. */
const DECORATIONS: readonly DecoPlacement[] = [
    // Infield: forest mid-straight, spectator tents by the first corner (kept clear of the tall start gate at 5,1)
    { gx: 3, gz: 2, kind: "forest", rot: 0 },
    { gx: 6, gz: 2, kind: "tents", rot: 1 },
    // Outfield: spectators north of the main straight, forest to the west
    { gx: 2, gz: 0, kind: "tents", rot: 0 },
    { gx: 6, gz: 0, kind: "forest", rot: 2 },
    { gx: 0, gz: 2, kind: "forest", rot: 3 },
];

interface PlacementAsset {
    readonly container: AssetContainer;
    readonly root: TransformNode;
    placed: boolean;
}

async function loadPlacementAsset(engine: EngineContext, url: string): Promise<PlacementAsset> {
    const container = await loadGltf(engine, url);
    return { container, root: container.entities[0] as TransformNode, placed: false };
}

function placeAsset(scene: SceneContext, asset: PlacementAsset, meshes: Mesh[], x: number, z: number, quarterTurns = 0): void {
    const container = asset.placed ? { entities: [cloneTransformNode(asset.root)] } : asset.container;
    asset.placed = true;
    const root = container.entities[0] as TransformNode;
    root.position.set(x, 0, z);
    root.rotation.y = (quarterTurns * Math.PI) / 2;
    addToScene(scene, container);
    meshes.push(...getContainerMeshes(container));
}

export async function buildTrack(engine: EngineContext, scene: SceneContext): Promise<Track> {
    // ── Ground plane (Kenney grass green) ─────────────────────────────────────
    const ground = createGround(engine, { width: 400, height: 400, subdivisions: 1 });
    const grass = createStandardMaterial();
    grass.diffuseColor = [0.36, 0.55, 0.28];
    grass.specularColor = [0, 0, 0];
    ground.material = grass;
    ground.position.set(0, GROUND_Y, 0);
    addToScene(scene, ground);

    // ── Tiles ─────────────────────────────────────────────────────────────────
    const straightUrl = demoAssetUrl("./racer/models/track-straight.glb", import.meta.url);
    const cornerUrl = demoAssetUrl("./racer/models/track-corner.glb", import.meta.url);
    const finishUrl = demoAssetUrl("./racer/models/track-finish.glb", import.meta.url);
    const bumpUrl = demoAssetUrl("./racer/models/track-bump.glb", import.meta.url);
    const forestUrl = demoAssetUrl("./racer/models/decoration-forest.glb", import.meta.url);
    const tentsUrl = demoAssetUrl("./racer/models/decoration-tents.glb", import.meta.url);

    // Parse each distinct static GLB once, then share its loaded mesh resources
    // through deep hierarchy clones for repeated placements.
    const [straightAsset, cornerAsset, finishAsset, bumpAsset, forestAsset, tentsAsset] = await Promise.all([
        loadPlacementAsset(engine, straightUrl),
        loadPlacementAsset(engine, cornerUrl),
        loadPlacementAsset(engine, finishUrl),
        loadPlacementAsset(engine, bumpUrl),
        loadPlacementAsset(engine, forestUrl),
        loadPlacementAsset(engine, tentsUrl),
    ]);

    const meshes: Mesh[] = [];
    const { cx, cz } = loopCenter(TRACK_LOOP);
    const gridToWorld = (gx: number, gz: number): { x: number; z: number } => ({ x: (gx - cx) * TILE, z: (gz - cz) * TILE });

    for (const t of tilesFromLoop(TRACK_LOOP)) {
        const isFinish = t.kind === "straight" && t.gx === FINISH_CELL.gx && t.gz === FINISH_CELL.gz;
        const { x, z } = gridToWorld(t.gx, t.gz);
        placeAsset(scene, isFinish ? finishAsset : t.kind === "straight" ? straightAsset : cornerAsset, meshes, x, z, t.rot);
    }

    // ── Speed bumps: small dome props along the main straight ──────────────────
    const bumpZ = gridToWorld(3, 1).z; // top-straight centerline
    const bumps = [-4, -1, 2].map((dx) => ({ x: dx, z: bumpZ }));
    for (const b of bumps) {
        placeAsset(scene, bumpAsset, meshes, b.x, b.z);
    }

    // Physics colliders: a buried sphere whose cap ≈ each dome (height BUMP_HEIGHT, footprint BUMP_RADIUS),
    // so the ball physically rides over the bumps and the car's ground-probe ray reads their slope.
    const bumpSphereRadius = (BUMP_RADIUS * BUMP_RADIUS + BUMP_HEIGHT * BUMP_HEIGHT) / (2 * BUMP_HEIGHT);
    const bumpColliders: BumpCollider[] = bumps.map((b) => ({ x: b.x, y: BUMP_HEIGHT - bumpSphereRadius, z: b.z, radius: bumpSphereRadius }));

    // ── Decorations: forest / tent props on grass cells (infield + outfield) ───
    for (const d of DECORATIONS) {
        const { x, z } = gridToWorld(d.gx, d.gz);
        placeAsset(scene, d.kind === "forest" ? forestAsset : tentsAsset, meshes, x, z, d.rot);
    }

    // Spawn a few cells along the top straight, driving east toward the first corner.
    const spawnIdx = 2;
    const spawnCell = TRACK_LOOP[spawnIdx]!;
    const spawnDir = cardFromTo(spawnCell, TRACK_LOOP[(spawnIdx + 1) % TRACK_LOOP.length]!);
    const spawn = { ...gridToWorld(spawnCell.gx, spawnCell.gz), heading: CARD_HEADING[spawnDir] };

    // Lap-detection zones: a thin line across the road at the finish + each checkpoint.
    const zoneForCell = (cell: Cell): TriggerZone => {
        const { x, z } = gridToWorld(cell.gx, cell.gz);
        return loopTravelAxis(cell) === "x" ? { cx: x, cz: z, sx: LINE_THICK, sz: ROAD_SPAN } : { cx: x, cz: z, sx: ROAD_SPAN, sz: LINE_THICK };
    };
    const finishLine = zoneForCell(FINISH_CELL);
    const checkpoints = CHECKPOINT_CELLS.map(zoneForCell);
    const path = TRACK_LOOP.map((c) => gridToWorld(c.gx, c.gz));

    return { ground, meshes, walls: wallsFromLoop(TRACK_LOOP, gridToWorld), bumpColliders, spawn, finishLine, checkpoints, path };
}
