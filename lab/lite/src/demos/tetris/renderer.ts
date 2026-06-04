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
    onBeforeRender,
    setThinInstances,
    type EngineContext,
    type Mesh,
    type SceneContext,
} from "babylon-lite";

import { createChamferedBoxData } from "./chamfered-box.js";
import { BOARD_COLS, BOARD_ROWS, ghostRow, type GameState } from "./game.js";
import { TetrisParticles } from "./particles.js";
import { PIECE_COLORS, PIECE_ROTATIONS } from "./pieces.js";

const BLOCK_SIZE = 0.92;

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
}

export function createTetrisRenderer(engine: EngineContext, scene: SceneContext): TetrisRenderer {
    // Lab demos reach into the engine's GPUDevice to write thin-instance vertex
    // buffers directly each frame. The public `setThinInstances` resets the
    // capacity, and our bundle is recorded once and replayed — so the only way
    // to push per-frame matrix changes is straight to the GPU buffer.
    const device = (engine as unknown as { device: GPUDevice }).device;

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
    // block at the initial camera angle, not just on the chamfered edges.
    addToScene(scene, createHemisphericLight([0, 1, 0.25], 0.18));
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

    // Frame — a real 3-D dark-metal bezel fully enclosing the well (left, right,
    // top and bottom). Polished metallic walls with genuine Z-thickness catch the
    // studio reflections and define the play area as a solid cabinet, replacing
    // the old flat neon strips and the separate floor slab.
    const FRAME_CY = (cellWorldY(0) + cellWorldY(BOARD_ROWS - 1)) / 2;
    const frameBars: { sx: number; sy: number; px: number; py: number }[] = [
        { sx: 0.5, sy: BOARD_ROWS + 1.7, px: -(BOARD_COLS / 2 + 0.35), py: FRAME_CY },
        { sx: 0.5, sy: BOARD_ROWS + 1.7, px: BOARD_COLS / 2 + 0.35, py: FRAME_CY },
        { sx: BOARD_COLS + 1.7, sy: 0.5, px: 0, py: cellWorldY(0) + 0.85 },
        { sx: BOARD_COLS + 1.7, sy: 0.5, px: 0, py: cellWorldY(BOARD_ROWS - 1) - 0.85 },
    ];
    for (const f of frameBars) {
        const bar = createBox(engine, 1);
        bar.material = createPbrMaterial({
            baseColorTexture: whiteTex,
            baseColorFactor: [0.05, 0.055, 0.065, 1],
            // Polished dark metal: low roughness + metallic mirrors the studio HDR.
            ormTexture: orm(0.25, 1.0),
            environmentIntensity: 1.15,
            directIntensity: 0.9,
            enableSpecularAA: true,
        });
        bar.scaling.set(f.sx, f.sy, 1.3);
        bar.position.set(f.px, f.py, -0.1);
        addToScene(scene, bar);
    }

    // ── Thin-instanced piece blocks ──────────────────────────────────────
    // Chamfered cube geometry (shared across all 7 colour meshes via
    // createMeshFromData call) — 45° bevel on every edge + corner so each
    // block reads as a manufactured plastic piece rather than a primitive.
    const blockGeometry = createChamferedBoxData(1, 0.08);

    const MAX_INSTANCES = BOARD_COLS * BOARD_ROWS + 4;
    const GHOST_INSTANCES = 4;
    const colorMeshes: Mesh[] = [];
    const matrixBuffers: Float32Array[] = [];

    for (let c = 0; c < PIECE_COLORS.length; c++) {
        const col = PIECE_COLORS[c]!;
        const mesh = createMeshFromData(
            engine,
            `tetris_block_${c}`,
            blockGeometry.positions,
            blockGeometry.normals,
            blockGeometry.indices,
            blockGeometry.uvs,
        );
        mesh.material = createPbrMaterial({
            baseColorTexture: whiteTex,
            baseColorFactor: [col[0], col[1], col[2], 1],
            // Glossy enamel: low roughness for a crisp specular highlight, no
            // metallic so the dielectric reflection keeps the colour pure.
            ormTexture: orm(0.13, 0.0),
            // Modest self-emission so colours stay vivid in shadowed faces
            // and so each block's silhouette has a faint halo for the bloom
            // post-process to pick up.
            emissiveColor: [col[0] * 0.15, col[1] * 0.15, col[2] * 0.15],
            environmentIntensity: 1.15,
            directIntensity: 1.6,
            // Specular AA widens the BRDF based on normal curvature so the
            // sharp specular spike on cube edges doesn't shimmer.
            enableSpecularAA: true,
        });
        const buf = new Float32Array(16 * MAX_INSTANCES);
        clearToDegenerate(buf, MAX_INSTANCES);
        setThinInstances(mesh, buf, MAX_INSTANCES);
        colorMeshes.push(mesh);
        matrixBuffers.push(buf);
        addToScene(scene, mesh);
    }

    // Ghost piece: cool emissive outline, very low surface contribution.
    const ghost = createMeshFromData(
        engine,
        "tetris_ghost",
        blockGeometry.positions,
        blockGeometry.normals,
        blockGeometry.indices,
        blockGeometry.uvs,
    );
    // Ghost piece: a neutral grey, semi-transparent copy of the landing
    // silhouette. Full block size (not shrunk) so it reads as a faint preview
    // of where the active piece will settle, letting the colored blocks below
    // show through.
    ghost.material = createPbrMaterial({
        baseColorTexture: whiteTex,
        baseColorFactor: [0.55, 0.58, 0.62, 1],
        ormTexture: orm(0.4, 0.0),
        environmentIntensity: 0.6,
        directIntensity: 0.5,
        alpha: 0.28,
        alphaBlend: true,
    });
    const ghostMatrices = new Float32Array(16 * GHOST_INSTANCES);
    clearToDegenerate(ghostMatrices, GHOST_INSTANCES);
    setThinInstances(ghost, ghostMatrices, GHOST_INSTANCES);
    addToScene(scene, ghost);

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

    function sync(game: GameState, dtMs: number): void {
        const dt = dtMs / 1000;

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
                    const col = PIECE_COLORS[v - 1]!;
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
                writeMatrix(matrixBuffers[colorIdx]!, counts[colorIdx]!, cellWorldX(x), cellWorldY(y), 0, BLOCK_SIZE);
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
                writeMatrix(matrixBuffers[colorIdx]!, counts[colorIdx]!, cellWorldX(cx), cellWorldY(cy), 0, BLOCK_SIZE);
                counts[colorIdx]!++;
            }
        }

        for (let c = 0; c < colorMeshes.length; c++) {
            const buf = matrixBuffers[c]!;
            const used = counts[c]!;
            for (let i = used; i < MAX_INSTANCES; i++) {
                writeHidden(buf, i);
            }
            uploadMatrices(colorMeshes[c]!, buf, MAX_INSTANCES);
        }

        let ghostCount = 0;
        if (game.active && !game.over && !game.paused) {
            const gRow = ghostRow(game);
            if (gRow !== game.active.row) {
                const cells = PIECE_ROTATIONS[game.active.type]![game.active.rotation]!;
                for (const [dx, dy] of cells) {
                    const cx = game.active.col + dx;
                    const cy = gRow + dy;
                    if (cy < 0) {
                        continue;
                    }
                    writeMatrix(ghostMatrices, ghostCount, cellWorldX(cx), cellWorldY(cy), 0, BLOCK_SIZE);
                    ghostCount++;
                }
            }
        }
        for (let i = ghostCount; i < GHOST_INSTANCES; i++) {
            writeHidden(ghostMatrices, i);
        }
        uploadMatrices(ghost, ghostMatrices, GHOST_INSTANCES);
    }

    return { sync };
}
