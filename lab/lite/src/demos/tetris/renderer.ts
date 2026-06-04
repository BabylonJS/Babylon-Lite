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
 *   - Ghost piece: emissive-only PBR for a glowing wireframe-ish silhouette.
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
    createGround,
    createHemisphericLight,
    createMeshFromData,
    createPbrMaterial,
    createSolidTexture2D,
    createSphere,
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

/** Build a 2-D cosmic gradient texture for the inside-out backdrop sphere.
 *  Encodes a vertical band (deep blue-black → indigo → magenta-purple horizon
 *  glow → near-black floor) with a soft horizontal nebula plume across the
 *  middle to give the camera a richly-coloured wash to frame the playfield
 *  against, instead of a flat dark wall. */
function createGradientTexture(engine: EngineContext): ReturnType<typeof createSolidTexture2D> {
    const device = (engine as unknown as { device: GPUDevice }).device;
    const WIDTH = 256;
    const HEIGHT = 256;
    const data = new Uint8Array(WIDTH * HEIGHT * 4);
    const stops: Array<[number, [number, number, number]]> = [
        [0.0, [0.01, 0.02, 0.06]],
        [0.32, [0.06, 0.05, 0.18]],
        [0.55, [0.32, 0.10, 0.42]],
        [0.72, [0.55, 0.18, 0.48]],
        [0.88, [0.10, 0.04, 0.16]],
        [1.0, [0.01, 0.01, 0.04]],
    ];
    function sampleStops(t: number): [number, number, number] {
        for (let i = 0; i < stops.length - 1; i++) {
            const [t0, c0] = stops[i]!;
            const [t1, c1] = stops[i + 1]!;
            if (t >= t0 && t <= t1) {
                const k = (t - t0) / (t1 - t0);
                return [c0[0] * (1 - k) + c1[0] * k, c0[1] * (1 - k) + c1[1] * k, c0[2] * (1 - k) + c1[2] * k];
            }
        }
        return stops[stops.length - 1]![1];
    }
    for (let y = 0; y < HEIGHT; y++) {
        const v = y / (HEIGHT - 1);
        const base = sampleStops(v);
        const plume = Math.exp(-Math.pow((v - 0.6) / 0.18, 2));
        for (let x = 0; x < WIDTH; x++) {
            const u = x / (WIDTH - 1);
            const cloud =
                0.55 +
                0.25 * Math.sin(u * Math.PI * 2 + v * 4.7) +
                0.20 * Math.sin(u * Math.PI * 6 + v * 9.2 + 1.3);
            const k = plume * Math.max(0, cloud);
            const r = base[0] + k * 0.28;
            const g = base[1] + k * 0.08;
            const b = base[2] + k * 0.35;
            const o = (y * WIDTH + x) * 4;
            data[o + 0] = Math.min(255, Math.round(r * 255));
            data[o + 1] = Math.min(255, Math.round(g * 255));
            data[o + 2] = Math.min(255, Math.round(b * 255));
            data[o + 3] = 255;
        }
    }
    const texture = device.createTexture({
        size: { width: WIDTH, height: HEIGHT },
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
        { texture },
        data,
        { bytesPerRow: WIDTH * 4, rowsPerImage: HEIGHT },
        { width: WIDTH, height: HEIGHT },
    );
    return {
        texture,
        view: texture.createView(),
        sampler: device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "repeat",
            addressModeV: "clamp-to-edge",
        }),
        width: WIDTH,
        height: HEIGHT,
    };
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
    const target = { x: 0, y: cellWorldY(BOARD_ROWS / 2) - 0.5, z: 0 };
    const camera = createArcRotateCamera(Math.PI / 2 + 0.04, Math.PI / 2 - 0.06, 26, target);
    camera.nearPlane = 0.5;
    camera.farPlane = 400;
    scene.camera = camera;
    attachControl(camera, engine.canvas as HTMLCanvasElement, scene);

    // Camera limits — the ArcRotateCamera in babylon-lite has no built-in
    // bounds, so we clamp every frame. Radius bounds prevent the player from
    // zooming inside the playfield (where front blocks vanish behind the
    // near plane) or pulling so far back that the well becomes a postage
    // stamp. Beta bounds prevent flipping over the top/bottom poles, which
    // would invert vertical input + leave the playfield upside-down.
    const RADIUS_MIN = 22;
    const RADIUS_MAX = 38;
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
    // strong directional key lights the front faces so each cube gets a tight
    // specular highlight along its chamfered edges.
    addToScene(scene, createHemisphericLight([0, 1, 0.25], 0.18));
    const sun = createDirectionalLight([-0.45, -0.95, -0.35], 1.5);
    addToScene(scene, sun);

    // Dark navy clear colour — used only for any viewport pixels the
    // backdrop sphere doesn't cover (it shouldn't, but cheap safety).
    scene.clearColor = { r: 0.008, g: 0.012, b: 0.028, a: 1 };

    function orm(roughness: number, metallic: number): ReturnType<typeof createSolidTexture2D> {
        return createSolidTexture2D(engine, 1.0, roughness, metallic);
    }

    // The PBR pipeline always binds `material.baseColorTexture` (non-null
    // asserted in pbr-pipeline.ts). We use a shared 1×1 white texture so
    // every material can drive its colour via `baseColorFactor` alone.
    const whiteTex = createSolidTexture2D(engine, 1.0, 1.0, 1.0);

    // ── Cosmic backdrop ─────────────────────────────────────────────────
    // Large inside-out sphere surrounding the camera, painted with an
    // emissive vertical gradient (deep navy zenith → magenta horizon →
    // dark purple floor) plus a soft nebula plume. Gives the playfield a
    // rich coloured wash to sit against rather than a flat dark wall.
    // Rendered far behind everything via a low renderOrder.
    const backdropTex = createGradientTexture(engine);
    const backdrop = createSphere(engine, { segments: 24, diameter: 220 });
    backdrop.material = createPbrMaterial({
        baseColorTexture: whiteTex,
        baseColorFactor: [0, 0, 0, 1],
        ormTexture: orm(1.0, 0.0),
        emissiveTexture: backdropTex,
        emissiveColor: [1.8, 1.8, 1.8],
        environmentIntensity: 0,
        directIntensity: 0,
        doubleSided: true,
    });
    backdrop.renderOrder = -2000;
    addToScene(scene, backdrop);

    // ── Static well frame ────────────────────────────────────────────────
    // Floor: dark glossy slab that catches the colour bleed from blocks above.
    const floor = createGround(engine, { width: BOARD_COLS + 1.4, height: 2.2 });
    floor.material = createPbrMaterial({
        baseColorTexture: whiteTex,
        baseColorFactor: [0.02, 0.025, 0.04, 1],
        ormTexture: orm(0.35, 0.05),
        environmentIntensity: 0.9,
        directIntensity: 0.7,
    });
    floor.position.set(0, cellWorldY(BOARD_ROWS - 1) - 0.55, 0);
    addToScene(scene, floor);

    // Back panel — a dim slab sitting just behind the playfield. Catches
    // shadow gradients from the directional key and gives the camera a
    // consistent dark backdrop so empty cells in the stack don't reveal
    // the scene clear colour as a bright window.
    const back = createBox(engine, 1);
    back.material = createPbrMaterial({
        baseColorTexture: whiteTex,
        baseColorFactor: [0.05, 0.06, 0.1, 1],
        ormTexture: orm(0.7, 0.0),
        environmentIntensity: 0.4,
        directIntensity: 0.6,
    });
    back.scaling.set(BOARD_COLS + 1.2, BOARD_ROWS + 1.2, 0.4);
    back.position.set(0, (cellWorldY(0) + cellWorldY(BOARD_ROWS - 1)) / 2, -0.7);
    addToScene(scene, back);

    // Side rails — thin neon-cyan bars that frame the well like an arcade
    // cabinet edge. The emissive is bright (tone mapping handles the rolloff)
    // so they read as glowing strips without bloom amplification.
    for (const side of [-1, 1]) {
        const rail = createBox(engine, 1);
        rail.material = createPbrMaterial({
            baseColorTexture: whiteTex,
            baseColorFactor: [0.04, 0.08, 0.12, 1],
            ormTexture: orm(0.3, 0.2),
            emissiveColor: [0.3, 1.1, 1.6],
            environmentIntensity: 0.6,
            directIntensity: 0.5,
        });
        rail.scaling.set(0.14, BOARD_ROWS + 0.6, 0.5);
        rail.position.set(side * (BOARD_COLS / 2 + 0.1), (cellWorldY(0) + cellWorldY(BOARD_ROWS - 1)) / 2, -0.05);
        addToScene(scene, rail);
    }

    // Top rail — slim glowing capstone that matches the side rails.
    const top = createBox(engine, 1);
    top.material = createPbrMaterial({
        baseColorTexture: whiteTex,
        baseColorFactor: [0.04, 0.08, 0.12, 1],
        ormTexture: orm(0.3, 0.2),
        emissiveColor: [0.3, 1.1, 1.6],
        environmentIntensity: 0.6,
        directIntensity: 0.5,
    });
    top.scaling.set(BOARD_COLS + 0.5, 0.14, 0.5);
    top.position.set(0, cellWorldY(0) + 0.6, -0.05);
    addToScene(scene, top);

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
            ormTexture: orm(0.18, 0.0),
            // Modest self-emission so colours stay vivid in shadowed faces
            // and so each block's silhouette has a faint halo for the bloom
            // post-process to pick up.
            emissiveColor: [col[0] * 0.15, col[1] * 0.15, col[2] * 0.15],
            environmentIntensity: 0.95,
            directIntensity: 1.4,
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
    // Ghost piece: bright emissive cyan so it reads as a glowing projection
    // of where the active piece will land. Kept saturated so a single visible
    // cell in a busy field still stands out against the colored blocks below.
    ghost.material = createPbrMaterial({
        baseColorTexture: whiteTex,
        baseColorFactor: [0.2, 0.45, 0.7, 1],
        ormTexture: orm(0.35, 0.0),
        emissiveColor: [0.6, 1.4, 2.2],
        environmentIntensity: 0.4,
        directIntensity: 0.3,
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
                    writeMatrix(ghostMatrices, ghostCount, cellWorldX(cx), cellWorldY(cy), 0, BLOCK_SIZE * 0.78);
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
