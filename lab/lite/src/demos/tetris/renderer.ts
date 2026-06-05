/**
 * Tetris 3D renderer — Babylon Lite scene + per-color thin-instanced PBR cubes.
 *
 * One thin-instanced PBR box mesh per piece color (7 total) and one for the
 * ghost piece. Each frame, we walk the board + active piece and rebuild the
 * per-color instance matrices. Total instance count is bounded by 200 (board)
 * + 4 (piece) + 4 (ghost) so the rebuild is cheap and avoids per-cell churn.
 *
 * Each per-color mesh keeps a fixed instance count of MAX_INSTANCES so the
 * frame-graph's cached render bundle bakes a single `drawIndexed(_, MAX)` once
 * and never needs to be re-recorded. Unused slots hold degenerate matrices
 * (scale = 0) so they render as invisible. Each frame we rewrite the entire
 * matrix buffer directly via `device.queue.writeBuffer` — the bundle replays
 * `setVertexBuffer(ti._gpuBuffer)` and the GPU just reads the latest contents.
 *
 * Visual layers:
 *   - PBR + HDR IBL: blocks read as glossy enamel chips, picking up sky/light
 *     reflections instead of flat shaded colours.
 *   - Emissive boost: each block emits a fraction of its own colour so the
 *     bloom post-process (set up in tetris.ts) gives it a soft halo.
 *   - Ghost piece: grey, semi-transparent PBR for a faint landing preview.
 *   - Particle bursts: spawned from `tetris/particles.ts` on each row clear.
 *   - Camera shake: short low-frequency offset applied on every clear, scaled
 *     by the number of lines cleared (4-line tetris is the biggest punch).
 */

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createHemisphericLight,
    createMeshFromData,
    createPbrMaterial,
    createSolidTexture2D,
    loadTexture2D,
    onBeforeRender,
    setThinInstances,
    type EngineContext,
    type Mesh,
    type SceneContext,
} from "babylon-lite";

import { BOARD_COLS, BOARD_ROWS, ghostRow, type GameState } from "./game.js";
import { TetrisParticles } from "./particles.js";
import { PIECE_COLORS, PIECE_ROTATIONS } from "./pieces.js";
import { createChamferedBoxData } from "./chamfered-box.js";
import { createRoundedBoxData } from "./rounded-box.js";

/** Block style: cute Kenney Cube Pets ("pets"), classic chamfered enamel cubes
 *  ("arcade"), or the same blocks with smoothly rounded edges ("smooth").
 *  Cycled at runtime via the renderer's `toggleMode`. */
export type TetrisMode = "pets" | "arcade" | "smooth";

const BLOCK_SIZE = 0.92;
/** Pet instances are normalised to a unit cube, so a scale of ~1 fills a cell. */
const PET_SIZE = 1.0;

/** Baked Cube Pets geometry: one merged static mesh per piece type. */
interface PetGeometry {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    /** Per-vertex linear-RGB colour baked from the palette atlas, so the tiny
     *  face swatches (eyes/nose) survive at cell size instead of being mip-blurred
     *  or dropped sub-pixel by texture minification. */
    colors: Float32Array;
}

/** Fetch the offline-baked Cube Pets geometry (see scripts/bake-tetris-pets.mjs).
 *  Each entry is a single merged mesh normalised to a unit cube, in piece-type
 *  order (I, O, T, S, Z, J, L). */
async function loadPetGeometries(url: string): Promise<PetGeometry[]> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to load pet geometry from ${url}: ${res.status}`);
    }
    const data = (await res.json()) as {
        pets: { positions: number[]; normals: number[]; uvs: number[]; indices: number[]; colors: number[] }[];
    };
    return data.pets.map((p) => ({
        positions: new Float32Array(p.positions),
        normals: new Float32Array(p.normals),
        uvs: new Float32Array(p.uvs),
        indices: new Uint32Array(p.indices),
        colors: new Float32Array(p.colors),
    }));
}

/** Map (col, row) → world-space center. row 0 = top, row 19 = bottom.
 *  Babylon Lite's left-handed projection mirrors world +X to visual left, so
 *  we negate the col-axis here: col 0 sits on visual-left and col 9 on
 *  visual-right, matching player expectations and keeping piece shapes +
 *  rotation directions visually correct (double-flip through cells + camera). */
function cellWorldX(col: number): number {
    return (BOARD_COLS - 1) / 2 - col;
}
function cellWorldY(row: number): number {
    return BOARD_ROWS - 1 - row;
}

function writeMatrix(out: Float32Array, idx: number, x: number, y: number, z: number, s: number): void {
    const o = idx * 16;
    out[o + 0] = s;
    out[o + 1] = 0;
    out[o + 2] = 0;
    out[o + 3] = 0;
    out[o + 4] = 0;
    out[o + 5] = s;
    out[o + 6] = 0;
    out[o + 7] = 0;
    out[o + 8] = 0;
    out[o + 9] = 0;
    out[o + 10] = s;
    out[o + 11] = 0;
    out[o + 12] = x;
    out[o + 13] = y;
    out[o + 14] = z;
    out[o + 15] = 1;
}

/** Like writeMatrix but with a rotation about the Z axis (radians). Used for the
 *  static stone-frame ring, whose side columns are rotated 90°. */
function writeMatrixRotZ(out: Float32Array, idx: number, x: number, y: number, z: number, s: number, a: number): void {
    const o = idx * 16;
    const c = Math.cos(a) * s;
    const sn = Math.sin(a) * s;
    out[o + 0] = c;
    out[o + 1] = sn;
    out[o + 2] = 0;
    out[o + 3] = 0;
    out[o + 4] = -sn;
    out[o + 5] = c;
    out[o + 6] = 0;
    out[o + 7] = 0;
    out[o + 8] = 0;
    out[o + 9] = 0;
    out[o + 10] = s;
    out[o + 11] = 0;
    out[o + 12] = x;
    out[o + 13] = y;
    out[o + 14] = z;
    out[o + 15] = 1;
}

/** Fetch a single baked geometry object keyed under `key` (e.g. "wall"). */
async function loadGeometryFromUrl(url: string, key: string): Promise<PetGeometry> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to load geometry from ${url}: ${res.status}`);
    }
    const data = (await res.json()) as Record<string, { positions: number[]; normals: number[]; uvs: number[]; indices: number[]; colors?: number[] }>;
    const p = data[key]!;
    return {
        positions: new Float32Array(p.positions),
        normals: new Float32Array(p.normals),
        uvs: new Float32Array(p.uvs),
        indices: new Uint32Array(p.indices),
        colors: new Float32Array(p.colors ?? []),
    };
}

/** Far-away (and zero-scale) "hidden" matrix used for unused thin-instance
 *  slots. Translation is parked beyond the far plane so even if a degenerate
 *  triangle accidentally rasterized one pixel, the depth test would discard
 *  it. Scale of 0 collapses the cube anyway. Belt + suspenders. */
const HIDDEN_Y = 1e7;
function writeHidden(out: Float32Array, idx: number): void {
    const o = idx * 16;
    out[o + 0] = 0;
    out[o + 1] = 0;
    out[o + 2] = 0;
    out[o + 3] = 0;
    out[o + 4] = 0;
    out[o + 5] = 0;
    out[o + 6] = 0;
    out[o + 7] = 0;
    out[o + 8] = 0;
    out[o + 9] = 0;
    out[o + 10] = 0;
    out[o + 11] = 0;
    out[o + 12] = 0;
    out[o + 13] = HIDDEN_Y;
    out[o + 14] = 0;
    out[o + 15] = 1;
}

function clearToDegenerate(buf: Float32Array, instances: number): void {
    buf.fill(0);
    for (let i = 0; i < instances; i++) {
        writeHidden(buf, i);
    }
}

export interface TetrisRenderer {
    /** Push current game state into per-color instance buffers, drain line-clear
     *  events into particle bursts + camera shake, and integrate particles.
     *  `dtMs` is the frame delta in milliseconds. */
    sync(game: GameState, dtMs: number): void;
    /** Switch the block style. Returns the (possibly unchanged) active mode. */
    setMode(mode: TetrisMode): TetrisMode;
    /** Flip between "pets" and "arcade". Returns the new active mode. */
    toggleMode(): TetrisMode;
    /** The block style currently being rendered. */
    readonly mode: TetrisMode;
}

export async function createTetrisRenderer(engine: EngineContext, scene: SceneContext): Promise<TetrisRenderer> {
    // Lab demos reach into the engine's GPUDevice to write thin-instance vertex
    // buffers directly each frame. The public `setThinInstances` resets the
    // capacity, and our bundle is recorded once and replayed — so the only way
    // to push per-frame matrix changes is straight to the GPU buffer.
    const device = (engine as unknown as { _device: GPUDevice })._device;

    // ── Camera ────────────────────────────────────────────────────────────
    // Aim at the well's true vertical centre (midpoint of the top and bottom
    // rows) so the framed stage sits centred in view.
    const target = { x: 0, y: (cellWorldY(0) + cellWorldY(BOARD_ROWS - 1)) / 2, z: 0 };
    const camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 30, target);
    camera.nearPlane = 0.5;
    camera.farPlane = 400;
    scene.camera = camera;
    attachControl(camera, engine.canvas as HTMLCanvasElement, scene);

    // ── Blurred environment skybox ───────────────────────────────────────────
    // A camera-centred PBR box in `skyboxMode` samples the IBL cubemap along the
    // view ray, blurred by its surface roughness (≈ BJS createDefaultSkybox with
    // a microSurface < 1). This turns the loaded studio HDR into a soft, out-of-
    // focus photographic backdrop with real depth and colour variation — far more
    // alive than a flat clear colour — while staying unobtrusive behind the well.
    const skybox = createBox(engine, (camera.farPlane - camera.nearPlane) / 2);
    skybox.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
        // occ=1, roughness=0.45 (soft blur), metallic=1 → mirror the env directly.
        ormTexture: createSolidTexture2D(engine, 1.0, 0.45, 1.0),
        environmentIntensity: 1.0,
        directIntensity: 0,
        doubleSided: true,
        skyboxMode: true,
    });
    const syncSkybox = (): void => {
        const w = camera.worldMatrix;
        skybox.position.set(w[12]!, w[13]!, w[14]!);
    };
    syncSkybox();
    onBeforeRender(scene, syncSkybox);
    addToScene(scene, skybox);


    // Camera limits — the ArcRotateCamera in babylon-lite has no built-in
    // bounds, so we clamp every frame. Radius bounds prevent the player from
    // zooming inside the playfield (where front blocks vanish behind the
    // near plane) or pulling so far back that the well becomes a postage
    // stamp. Beta bounds prevent flipping over the top/bottom poles, which
    // would invert vertical input + leave the playfield upside-down.
    const RADIUS_MIN = 24;
    const RADIUS_MAX = 42;
    const BETA_MIN = Math.PI * 0.32;
    const BETA_MAX = Math.PI * 0.62;
    // Center the camera on the playfield middle and only let the player swing
    // a moderate arc left/right so they can't end up looking at the back of
    // the playfield (which would be empty + reveal the back panel edge).
    const ALPHA_BASE = Math.PI / 2 + 0.04;
    const ALPHA_RANGE = 0.45;

    // Track the resting target so camera shake can offset from it each frame.
    const baseTarget = { x: target.x, y: target.y, z: target.z };
    let shakeAmp = 0;
    let shakeT = 0;

    // ── Lighting ──────────────────────────────────────────────────────────
    // IBL drives reflections + ambient; a low hemi adds floor lift and a
    // strong directional key positioned just behind-and-above the resting
    // camera so its specular highlight reflects straight back off the glossy
    // front faces — i.e. the player sees a bright reflective glint on every
    // block at the initial camera angle, not just on the bevelled edges.
    addToScene(scene, createHemisphericLight([0, 1, 0.25], 0.75));
    const sun = createDirectionalLight([0.22, -0.5, -0.84], 2.2);
    addToScene(scene, sun);

    // Dark navy clear colour — used only for any viewport pixels the
    // backdrop sphere doesn't cover (it shouldn't, but cheap safety).
    // Pure black clear colour — only shows on any viewport pixels the HDR
    // skybox doesn't cover (it shouldn't, but cheap safety).
    scene.clearColor = { r: 0, g: 0, b: 0, a: 1 };

    function orm(roughness: number, metallic: number): ReturnType<typeof createSolidTexture2D> {
        return createSolidTexture2D(engine, 1.0, roughness, metallic);
    }

    // The PBR pipeline always binds `material.baseColorTexture` (non-null
    // asserted in pbr-pipeline.ts). We use a shared 1×1 white texture so
    // every material can drive its colour via `baseColorFactor` alone.
    const whiteTex = createSolidTexture2D(engine, 1.0, 1.0, 1.0);

    // The environment backdrop is a blurred PBR skybox box (built near the top of
    // this function), so there's no procedural backdrop sphere here.

    // ── Static well frame ────────────────────────────────────────────────
    // Back panel — a dark, slightly glossy backboard behind the playfield so the
    // colourful blocks read against a deep, even surface rather than the busy
    // skybox. Mid-low roughness keeps the environment reflection diffuse.
    const back = createBox(engine, 1);
    back.material = createPbrMaterial({
        baseColorTexture: whiteTex,
        baseColorFactor: [0.018, 0.02, 0.028, 1],
        ormTexture: orm(0.42, 0.0),
        environmentIntensity: 0.7,
        directIntensity: 0.45,
        reflectance: 0.06,
    });
    back.scaling.set(BOARD_COLS + 1.6, BOARD_ROWS + 1.6, 0.4);
    back.position.set(0, (cellWorldY(0) + cellWorldY(BOARD_ROWS - 1)) / 2, -0.7);
    addToScene(scene, back);

    // Frame — a stone-block border (CC0 Kenney Graveyard Kit "stone-wall") tiled
    // into a ring around the well. The segment is 1×0.725×0.2 with a rounded top;
    // top/bottom rows sit upright while the left/right columns are rotated 90°
    // about Z so the rounded edge faces outward, forming a continuous stone frame.
    // All 66 segments are one thin-instanced mesh (one draw call, built once).
    const frameGeo = await loadGeometryFromUrl("/tetris/tetris-frame.json", "wall");
    const frameColormap = await loadTexture2D(engine, "/tetris/tetris-frame-colormap.png", {
        srgb: true,
        invertY: false,
        mipMaps: false,
        minFilter: "nearest",
        magFilter: "nearest",
    });
    const frame = createMeshFromData(engine, "tetris_frame", frameGeo.positions, frameGeo.normals, frameGeo.indices, frameGeo.uvs);
    frame.material = createPbrMaterial({
        baseColorTexture: frameColormap,
        // Matte stone: rough, non-metallic, lit by the studio IBL.
        ormTexture: orm(0.85, 0.0),
        environmentIntensity: 0.9,
        directIntensity: 1.0,
        enableSpecularAA: true,
    });
    {
        const HALF = 0.3625; // half the segment's 0.725 height
        const xL = -BOARD_COLS / 2 - HALF; // just outside the play columns (±5)
        const xR = BOARD_COLS / 2 + HALF;
        const yTop = cellWorldY(0) + 0.5 + HALF; // above the top row
        const yBot = cellWorldY(BOARD_ROWS - 1) - 0.5 - HALF; // below the bottom row
        const segs: { x: number; y: number; rot: number }[] = [];
        // Top & bottom rows tiled along X (rounded edge up / down).
        for (let x = -BOARD_COLS / 2 - 0.5; x <= BOARD_COLS / 2 + 0.5 + 1e-6; x++) {
            segs.push({ x, y: yTop, rot: 0 });
            segs.push({ x, y: yBot, rot: Math.PI });
        }
        // Left & right columns tiled along Y (rounded edge facing outward).
        for (let y = cellWorldY(BOARD_ROWS - 1) - 0.5; y <= cellWorldY(0) + 0.5 + 1e-6; y++) {
            segs.push({ x: xL, y, rot: Math.PI / 2 });
            segs.push({ x: xR, y, rot: -Math.PI / 2 });
        }
        const frameMatrices = new Float32Array(16 * segs.length);
        segs.forEach((s, i) => writeMatrixRotZ(frameMatrices, i, s.x, s.y, 0, 1, s.rot));
        setThinInstances(frame, frameMatrices, segs.length);
        addToScene(scene, frame);
    }

    // ── Thin-instanced piece blocks (Kenney "Cube Pets") ─────────────────
    // Each of the 7 piece types is rendered as a cute cube animal from the CC0
    // Kenney Cube Pets pack, baked offline into a single merged mesh per type
    // (scripts/bake-tetris-pets.mjs). All pets share one palette texture, so a
    // single PBR material serves every type; per-type geometry is thin-instanced
    // across the board exactly like the box-style arcade/smooth cubes.
    const petGeometries = await loadPetGeometries("/tetris/tetris-pets.json");
    // Pets are coloured by baked per-vertex colours (sampled offline from the
    // palette atlas), not by sampling the atlas at render time. The atlas' tiny
    // eye/nose swatches are smaller than a screen pixel at cell size, so texture
    // sampling either mip-blurs them into the body colour or drops them entirely;
    // vertex colours interpolate in screen space and stay crisp at any size. The
    // shared 1×1 `whiteTex` base lets `baseColor *= vColor` pass the vertex colour
    // through unchanged.
    const petMaterial = createPbrMaterial({
        baseColorTexture: whiteTex,
        // Soft matte-toy surface. The dark/low-albedo pets (cat, panda) sit
        // against a near-black stage, so they need plenty of *diffuse* light to
        // read as bright solid toys — otherwise their lit body nearly matches the
        // backdrop and looks ghostly/see-through. We push direct + hemispheric
        // light and a uniform emissive lift (rather than env reflection, which
        // just mirrors the studio backdrop onto dark bodies and worsens the
        // illusion). Mid-high roughness keeps them matte, not glassy.
        ormTexture: orm(0.62, 0.0),
        emissiveColor: [0.05, 0.05, 0.05],
        // Hold the neutral grey studio env well below the direct lights: a strong
        // env mirror greys-out the bright vertex colours, so keeping it low lets
        // each pet's hue stay saturated and vivid (matching the arcade blocks).
        environmentIntensity: 0.45,
        directIntensity: 3.0,
        reflectance: 0.04,
        enableSpecularAA: true,
        // The Cube Pets meshes are authored double-sided; the face decals (eyes,
        // nose) are wound opposite the body, so back-face culling would drop them.
        doubleSided: true,
    });

    const MAX_INSTANCES = BOARD_COLS * BOARD_ROWS + 4;
    const GHOST_INSTANCES = 4;

    // Ghost piece — a faint, semi-transparent landing preview. In pet mode the
    // pet meshes carry vertex colours so it reads as a ghostly copy of the active
    // animal; in arcade mode the boxes have no vertex colours so it reads as a
    // translucent grey block. Shared by both render sets.
    const ghostMat = createPbrMaterial({
        baseColorTexture: whiteTex,
        ormTexture: orm(0.55, 0.0),
        environmentIntensity: 0.5,
        directIntensity: 0.5,
        alpha: 0.3,
        alphaBlend: true,
        doubleSided: true,
    });

    // ── Classic "arcade" + "smooth" blocks (enamel cubes) ────────────────
    // Two restyled block geometries, both thin-instanced per piece colour and
    // sharing the same glossy, lightly emissive PBR materials (tinted by
    // ARCADE_COLORS so line-clear bursts + the HUD preview still match):
    //   • "arcade" — a chamfered cube; flat 45° bevels catch a crisp specular
    //     glint along every edge, reading as a manufactured plastic chip.
    //   • "smooth" — a rounded cube; generously filleted edges + corners sweep
    //     that glint smoothly around every silhouette line.
    // Both are built alongside the pets and cycled at runtime.
    const chamferData = createChamferedBoxData(1, 0.08);
    const chamferGeo: PetGeometry = {
        positions: chamferData.positions,
        normals: chamferData.normals,
        uvs: chamferData.uvs,
        indices: chamferData.indices,
        colors: new Float32Array(0),
    };
    const roundedData = createRoundedBoxData(1, 0.2, 3);
    const roundedGeo: PetGeometry = {
        positions: roundedData.positions,
        normals: roundedData.normals,
        uvs: roundedData.uvs,
        indices: roundedData.indices,
        colors: new Float32Array(0),
    };
    // Both box styles share a vivid palette that mirrors each Cube Pet's hue
    // (so every mode feels like the same pieces, just restyled) but cranked up
    // in saturation — the raw pet body colours are deliberately pastel, so these
    // are punchy versions in the same I,O,T,S,Z,J,L order:
    // pig, panda, bunny, crab, chick, cat, caterpillar.
    const ARCADE_COLORS: readonly [number, number, number][] = [
        [0.95, 0.24, 0.52], // I — pig (vivid pink)
        [0.90, 0.90, 0.95], // O — panda (bright white)
        [0.98, 0.50, 0.24], // T — bunny (warm tan/orange)
        [0.93, 0.16, 0.14], // S — crab (vivid red)
        [1.0, 0.80, 0.12], // Z — chick (golden yellow)
        [0.22, 0.34, 0.95], // J — cat (vivid blue)
        [0.13, 0.80, 0.38], // L — caterpillar (vivid green)
    ];
    const arcadeMaterials = ARCADE_COLORS.map((rgb) =>
        createPbrMaterial({
            baseColorTexture: whiteTex,
            baseColorFactor: [rgb[0], rgb[1], rgb[2], 1],
            // Glossy plastic chip: low roughness for a crisp specular glint.
            ormTexture: orm(0.22, 0.0),
            // A strong slice of the body colour as emissive lifts each chip off
            // the dark stage and pushes saturated colour through the bloom pass,
            // so the hue reads vividly instead of being greyed by the IBL.
            emissiveColor: [rgb[0] * 0.35, rgb[1] * 0.35, rgb[2] * 0.35],
            // Keep the grey studio env from washing the colour out: lean on the
            // direct lights for brightness, not the neutral environment mirror.
            environmentIntensity: 0.45,
            directIntensity: 2.4,
            reflectance: 0.08,
            enableSpecularAA: true,
        }),
    );

    interface RenderSet {
        colorMeshes: Mesh[];
        matrixBuffers: Float32Array[];
        ghostMeshes: Mesh[];
        ghostBuffers: Float32Array[];
        /** Per-instance uniform scale (pets fill the cell; boxes leave a gap). */
        scale: number;
    }

    // Build one solid thin-instanced mesh per piece colour plus a matching ghost
    // mesh per colour, all wired into the scene. `geoFor`/`matFor` supply the
    // geometry + solid material for colour c; the ghost material is shared.
    function buildRenderSet(prefix: string, geoFor: (c: number) => PetGeometry, matFor: (c: number) => ReturnType<typeof createPbrMaterial>, scale: number): RenderSet {
        const colorMeshes: Mesh[] = [];
        const matrixBuffers: Float32Array[] = [];
        const ghostMeshes: Mesh[] = [];
        const ghostBuffers: Float32Array[] = [];
        for (let c = 0; c < PIECE_COLORS.length; c++) {
            const geo = geoFor(c);
            const mesh = createMeshFromData(engine, `${prefix}_${c}`, geo.positions, geo.normals, geo.indices, geo.uvs, undefined, undefined, geo.colors);
            mesh.material = matFor(c);
            const buf = new Float32Array(16 * MAX_INSTANCES);
            clearToDegenerate(buf, MAX_INSTANCES);
            setThinInstances(mesh, buf, MAX_INSTANCES);
            colorMeshes.push(mesh);
            matrixBuffers.push(buf);
            addToScene(scene, mesh);

            const gm = createMeshFromData(engine, `${prefix}_ghost_${c}`, geo.positions, geo.normals, geo.indices, geo.uvs, undefined, undefined, geo.colors);
            gm.material = ghostMat;
            const gb = new Float32Array(16 * GHOST_INSTANCES);
            clearToDegenerate(gb, GHOST_INSTANCES);
            setThinInstances(gm, gb, GHOST_INSTANCES);
            ghostMeshes.push(gm);
            ghostBuffers.push(gb);
            addToScene(scene, gm);
        }
        return { colorMeshes, matrixBuffers, ghostMeshes, ghostBuffers, scale };
    }

    const sets: Record<TetrisMode, RenderSet> = {
        pets: buildRenderSet("tetris_pet", (c) => petGeometries[c] ?? petGeometries[0]!, () => petMaterial, PET_SIZE),
        arcade: buildRenderSet("tetris_box", () => chamferGeo, (c) => arcadeMaterials[c]!, BLOCK_SIZE),
        smooth: buildRenderSet("tetris_round", () => roundedGeo, (c) => arcadeMaterials[c]!, BLOCK_SIZE),
    };
    // All sets start with degenerate (invisible) instances; sync only ever
    // writes real matrices into the active set, so inactive sets stay hidden.
    let currentMode: TetrisMode = "smooth";

    // ── Particle system ──────────────────────────────────────────────────
    const particles = new TetrisParticles(engine, scene);

    function uploadMatrices(mesh: Mesh, buf: Float32Array, instances: number): void {
        const ti = mesh.thinInstances!;
        if (ti._gpuBuffer) {
            device.queue.writeBuffer(ti._gpuBuffer, 0, buf.buffer, buf.byteOffset, instances * 64);
            return;
        }
        ti._version++;
        ti._dirtyMin = 0;
        ti._dirtyMax = instances;
    }

    // Park every instance of a render set off-screen (scale 0) and upload once,
    // so the set is fully hidden until it becomes active again.
    function hideSet(set: RenderSet): void {
        for (let c = 0; c < set.colorMeshes.length; c++) {
            const buf = set.matrixBuffers[c]!;
            for (let i = 0; i < MAX_INSTANCES; i++) writeHidden(buf, i);
            uploadMatrices(set.colorMeshes[c]!, buf, MAX_INSTANCES);
        }
        for (let c = 0; c < set.ghostMeshes.length; c++) {
            const gb = set.ghostBuffers[c]!;
            for (let i = 0; i < GHOST_INSTANCES; i++) writeHidden(gb, i);
            uploadMatrices(set.ghostMeshes[c]!, gb, GHOST_INSTANCES);
        }
    }

    function setMode(mode: TetrisMode): TetrisMode {
        if (mode !== currentMode) {
            hideSet(sets[currentMode]);
            currentMode = mode;
        }
        return currentMode;
    }

    // Cycle pets → arcade (chamfered) → smooth (rounded) → pets.
    const MODE_CYCLE: readonly TetrisMode[] = ["pets", "arcade", "smooth"];
    function toggleMode(): TetrisMode {
        const next = MODE_CYCLE[(MODE_CYCLE.indexOf(currentMode) + 1) % MODE_CYCLE.length]!;
        return setMode(next);
    }

    function sync(game: GameState, dtMs: number): void {
        const dt = dtMs / 1000;
        const active = sets[currentMode];
        const blockScale = active.scale;

        // Clamp camera every frame. attachControl writes inertial offsets that
        // the camera applies before render; we clamp the resulting values
        // here so the player can move within bounds but can't drift outside.
        if (camera.radius < RADIUS_MIN) camera.radius = RADIUS_MIN;
        if (camera.radius > RADIUS_MAX) camera.radius = RADIUS_MAX;
        if (camera.beta < BETA_MIN) camera.beta = BETA_MIN;
        if (camera.beta > BETA_MAX) camera.beta = BETA_MAX;
        if (camera.alpha < ALPHA_BASE - ALPHA_RANGE) camera.alpha = ALPHA_BASE - ALPHA_RANGE;
        if (camera.alpha > ALPHA_BASE + ALPHA_RANGE) camera.alpha = ALPHA_BASE + ALPHA_RANGE;



        // Drain line-clear events: spawn coloured bursts + trigger camera shake.
        if (game.pendingClears.length > 0) {
            for (const { row, colors } of game.pendingClears) {
                for (let x = 0; x < BOARD_COLS; x++) {
                    const v = colors[x]!;
                    if (v === 0) continue;
                    const col = (currentMode === "pets" ? PIECE_COLORS : ARCADE_COLORS)[v - 1]!;
                    particles.burst(cellWorldX(x), cellWorldY(row), 0, col);
                }
            }
            // Shake scales with line count: 1 line ≈ gentle nudge, 4 = punch.
            const lines = game.pendingClears.length;
            const baseAmp = 0.18 + 0.22 * lines;
            shakeAmp = Math.max(shakeAmp, baseAmp);
            shakeT = 0;
            game.pendingClears.length = 0;
        }

        particles.update(dt);

        // Decay camera shake using two perpendicular sinusoids of different
        // frequencies so the motion feels organic rather than a clean wobble.
        if (shakeAmp > 0.0005) {
            shakeT += dt;
            const decay = Math.exp(-shakeT * 5.5);
            const a = shakeAmp * decay;
            camera.target.x = baseTarget.x + Math.sin(shakeT * 38) * a * 0.7;
            camera.target.y = baseTarget.y + Math.cos(shakeT * 31) * a * 0.9;
            if (decay < 0.01) {
                shakeAmp = 0;
                camera.target.x = baseTarget.x;
                camera.target.y = baseTarget.y;
            }
        }

        // ── Rebuild per-color instance matrices ─────────────────────────
        const counts = new Uint16Array(PIECE_COLORS.length);

        for (let y = 0; y < BOARD_ROWS; y++) {
            for (let x = 0; x < BOARD_COLS; x++) {
                const v = game.board[y * BOARD_COLS + x]!;
                if (v === 0) {
                    continue;
                }
                const colorIdx = v - 1;
                writeMatrix(active.matrixBuffers[colorIdx]!, counts[colorIdx]!, cellWorldX(x), cellWorldY(y), 0, blockScale);
                counts[colorIdx]!++;
            }
        }

        if (game.active) {
            const colorIdx = game.active.type;
            const cells = PIECE_ROTATIONS[game.active.type]![game.active.rotation]!;
            for (const [dx, dy] of cells) {
                const cx = game.active.col + dx;
                const cy = game.active.row + dy;
                if (cy < 0) {
                    continue;
                }
                writeMatrix(active.matrixBuffers[colorIdx]!, counts[colorIdx]!, cellWorldX(cx), cellWorldY(cy), 0, blockScale);
                counts[colorIdx]!++;
            }
        }

        for (let c = 0; c < active.colorMeshes.length; c++) {
            const buf = active.matrixBuffers[c]!;
            const used = counts[c]!;
            for (let i = used; i < MAX_INSTANCES; i++) {
                writeHidden(buf, i);
            }
            uploadMatrices(active.colorMeshes[c]!, buf, MAX_INSTANCES);
        }

        const activeType = game.active && !game.over && !game.paused ? game.active.type : -1;
        for (let c = 0; c < active.ghostMeshes.length; c++) {
            let ghostCount = 0;
            if (c === activeType && game.active) {
                const gRow = ghostRow(game);
                if (gRow !== game.active.row) {
                    const cells = PIECE_ROTATIONS[game.active.type]![game.active.rotation]!;
                    for (const [dx, dy] of cells) {
                        const cx = game.active.col + dx;
                        const cy = gRow + dy;
                        if (cy < 0) {
                            continue;
                        }
                        writeMatrix(active.ghostBuffers[c]!, ghostCount, cellWorldX(cx), cellWorldY(cy), 0, blockScale);
                        ghostCount++;
                    }
                }
            }
            for (let i = ghostCount; i < GHOST_INSTANCES; i++) {
                writeHidden(active.ghostBuffers[c]!, i);
            }
            uploadMatrices(active.ghostMeshes[c]!, active.ghostBuffers[c]!, GHOST_INSTANCES);
        }
    }

    return {
        sync,
        setMode,
        toggleMode,
        get mode() {
            return currentMode;
        },
    };
}
