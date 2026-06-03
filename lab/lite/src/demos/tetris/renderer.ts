/**
 * Tetris 3D renderer — Babylon Lite scene + per-color thin-instanced cubes.
 *
 * One thin-instanced box mesh per piece color (7 total) and one for the ghost
 * piece. Each frame, we walk the board + active piece and rebuild the per-color
 * instance matrices. Total instance count is bounded by 200 (board) + 4 (piece)
 * + 4 (ghost), so the rebuild is cheap and avoids any per-cell mesh churn.
 *
 * Each per-color mesh keeps a fixed instance count of MAX_INSTANCES so the
 * frame graph's cached render bundle bakes a single `drawIndexed(_, MAX)` once
 * and never needs to be re-recorded. Unused slots hold degenerate matrices
 * (scale = 0) so they render as invisible. Each frame we rewrite the entire
 * matrix buffer directly via `device.queue.writeBuffer` — the bundle replays
 * `setVertexBuffer(ti._gpuBuffer)` and the GPU just reads the latest contents.
 *
 * The well is a small set of static meshes (back wall + side rails + floor)
 * that frame the playfield in 3D and catch light from the directional source.
 */

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createGround,
    createHemisphericLight,
    createStandardMaterial,
    setThinInstanceColors,
    setThinInstances,
    type EngineContext,
    type Mesh,
    type SceneContext,
} from "babylon-lite";

import { BOARD_COLS, BOARD_ROWS, ghostRow, pieceColor, type GameState } from "./game.js";
import { PIECE_COLORS, PIECE_ROTATIONS } from "./pieces.js";

const BLOCK_SIZE = 0.92; // slight gap between cells

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

/** Build a scale*translation matrix in column-major layout. */
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

/** Reset a matrix buffer back to all-degenerate (scale = 0, w = 1) matrices. */
function clearToDegenerate(buf: Float32Array, instances: number): void {
    buf.fill(0);
    for (let i = 0; i < instances; i++) {
        buf[i * 16 + 15] = 1;
    }
}

export interface TetrisRenderer {
    /** Push the current game state into the per-color instance buffers. */
    sync(game: GameState): void;
}

export function createTetrisRenderer(engine: EngineContext, scene: SceneContext): TetrisRenderer {
    // The lab demos sit one layer above the public API and reach into the
    // engine's GPUDevice to write thin-instance vertex buffers directly. This
    // is intentional — the public `setThinInstances` API is designed for
    // upload-on-bundle-record, but our scene re-records its bundle only when
    // the renderable list mutates. To get per-frame block movement we push the
    // matrix data straight to the (stable) GPU buffer each frame.
    const device = (engine as unknown as { device: GPUDevice }).device;

    // Camera: orbit the board from the front with a slight downward tilt.
    const target = { x: 0, y: cellWorldY(BOARD_ROWS / 2) - 0.5, z: 0 };
    const camera = createArcRotateCamera(Math.PI / 2 + 0.04, Math.PI / 2 - 0.06, 26, target);
    camera.nearPlane = 0.5;
    camera.farPlane = 200;
    scene.camera = camera;
    attachControl(camera, engine.canvas as HTMLCanvasElement, scene);

    // Lights: soft sky fill + a directional key from the upper-front-left so
    // cubes have crisp shaded faces.
    addToScene(scene, createHemisphericLight([0, 1, 0.2], 0.55));
    const sun = createDirectionalLight([-0.4, -0.9, -0.4], 0.85);
    addToScene(scene, sun);

    // Dark background so the bright tetromino colors pop.
    scene.clearColor = { r: 0.04, g: 0.05, b: 0.09, a: 1 };

    // Well floor — a thin lit plate below the playfield.
    const floor = createGround(engine, { width: BOARD_COLS + 1.4, height: 3 });
    const floorMat = createStandardMaterial();
    floorMat.diffuseColor = [0.08, 0.09, 0.13];
    floorMat.specularColor = [0.05, 0.05, 0.05];
    floor.material = floorMat;
    floor.position.set(0, cellWorldY(BOARD_ROWS - 1) - 0.55, 0);
    addToScene(scene, floor);

    // Back wall — a dim panel behind the playfield to catch shadow gradients.
    const back = createBox(engine, 1);
    const backMat = createStandardMaterial();
    backMat.diffuseColor = [0.07, 0.08, 0.12];
    backMat.specularColor = [0, 0, 0];
    back.material = backMat;
    back.scaling.set(BOARD_COLS + 1.2, BOARD_ROWS + 1.2, 0.4);
    back.position.set(0, (cellWorldY(0) + cellWorldY(BOARD_ROWS - 1)) / 2, -0.7);
    addToScene(scene, back);

    // Side rails — slim vertical bars framing the playfield.
    for (const side of [-1, 1]) {
        const rail = createBox(engine, 1);
        const railMat = createStandardMaterial();
        railMat.diffuseColor = [0.18, 0.22, 0.32];
        railMat.specularColor = [0.3, 0.3, 0.35];
        railMat.emissiveColor = [0.03, 0.05, 0.1];
        rail.material = railMat;
        rail.scaling.set(0.25, BOARD_ROWS + 0.6, 0.7);
        rail.position.set(side * (BOARD_COLS / 2 + 0.15), (cellWorldY(0) + cellWorldY(BOARD_ROWS - 1)) / 2, -0.05);
        addToScene(scene, rail);
    }

    // Top bar — frames the top of the well, like a real arcade cabinet.
    const top = createBox(engine, 1);
    const topMat = createStandardMaterial();
    topMat.diffuseColor = [0.18, 0.22, 0.32];
    topMat.specularColor = [0.3, 0.3, 0.35];
    topMat.emissiveColor = [0.03, 0.05, 0.1];
    top.material = topMat;
    top.scaling.set(BOARD_COLS + 0.7, 0.25, 0.7);
    top.position.set(0, cellWorldY(0) + 0.65, -0.05);
    addToScene(scene, top);

    // One thin-instanced box per piece color, plus one for the ghost preview.
    //
    // Each mesh is seeded with a FIXED count of MAX_INSTANCES degenerate
    // matrices BEFORE registerScene() runs, for two reasons:
    //   (1) The standard renderable snapshots `meshFeatures` (including the
    //       MSH_HAS_THIN_INSTANCES bit) at register time. Without thin instances
    //       at that moment, the pipeline is baked for the non-instanced path
    //       and later `setThinInstances` calls have no visible effect.
    //   (2) The frame-graph caches an opaque render bundle that bakes in
    //       `drawIndexed(_, ti.count)` + `setVertexBuffer(ti._gpuBuffer)`. A
    //       fixed count means the bundle never needs to be re-recorded for
    //       count changes; we just rewrite the buffer in-place each frame.
    const MAX_INSTANCES = BOARD_COLS * BOARD_ROWS + 4;
    const GHOST_INSTANCES = 4;
    const colorMeshes: Mesh[] = [];
    const matrixBuffers: Float32Array[] = [];

    for (let c = 0; c < PIECE_COLORS.length; c++) {
        const mesh = createBox(engine, 1);
        const mat = createStandardMaterial();
        mat.diffuseColor = [...PIECE_COLORS[c]!];
        mat.specularColor = [0.35, 0.35, 0.4];
        mat.specularPower = 48;
        // A touch of emissive so cubes never go pure black in shadow — keeps
        // the playfield readable from any camera angle.
        mat.emissiveColor = [PIECE_COLORS[c]![0] * 0.1, PIECE_COLORS[c]![1] * 0.1, PIECE_COLORS[c]![2] * 0.1];
        mesh.material = mat;
        const buf = new Float32Array(16 * MAX_INSTANCES);
        clearToDegenerate(buf, MAX_INSTANCES);
        setThinInstances(mesh, buf, MAX_INSTANCES);
        colorMeshes.push(mesh);
        matrixBuffers.push(buf);
        addToScene(scene, mesh);
    }

    // Ghost piece — desaturated white box at reduced scale.
    const ghost = createBox(engine, 1);
    const ghostMat = createStandardMaterial();
    ghostMat.diffuseColor = [0.18, 0.2, 0.25];
    ghostMat.specularColor = [0, 0, 0];
    ghostMat.emissiveColor = [0.35, 0.4, 0.55];
    ghost.material = ghostMat;
    const ghostMatrices = new Float32Array(16 * GHOST_INSTANCES);
    clearToDegenerate(ghostMatrices, GHOST_INSTANCES);
    setThinInstances(ghost, ghostMatrices, GHOST_INSTANCES);
    addToScene(scene, ghost);

    /** Push `buf` contents to the mesh's GPU instance buffer, or fall back to
     *  the version-tracking path on the very first frame before the standard
     *  renderable has created the GPU buffer. */
    function uploadMatrices(mesh: Mesh, buf: Float32Array, instances: number): void {
        const ti = mesh.thinInstances!;
        if (ti._gpuBuffer) {
            device.queue.writeBuffer(ti._gpuBuffer, 0, buf.buffer, buf.byteOffset, instances * 64);
            return;
        }
        // First frame only: signal that data is dirty so the standard
        // renderable's syncThinInstanceBuffers creates the buffer + uploads.
        ti._version++;
        ti._dirtyMin = 0;
        ti._dirtyMax = instances;
    }

    function sync(game: GameState): void {
        // Per-color counts used as scratch indices into matrixBuffers.
        const counts = new Uint16Array(PIECE_COLORS.length);

        // Locked blocks.
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

        // Active piece.
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

        // Pad unused slots with degenerate matrices and push to GPU.
        for (let c = 0; c < colorMeshes.length; c++) {
            const buf = matrixBuffers[c]!;
            const used = counts[c]!;
            for (let i = used; i < MAX_INSTANCES; i++) {
                const o = i * 16;
                buf[o] = 0;
                buf[o + 5] = 0;
                buf[o + 10] = 0;
                buf[o + 12] = 0;
                buf[o + 13] = 0;
                buf[o + 14] = 0;
                buf[o + 15] = 1;
            }
            uploadMatrices(colorMeshes[c]!, buf, MAX_INSTANCES);
        }

        // Ghost piece (where the active would land).
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
            const o = i * 16;
            ghostMatrices[o] = 0;
            ghostMatrices[o + 5] = 0;
            ghostMatrices[o + 10] = 0;
            ghostMatrices[o + 12] = 0;
            ghostMatrices[o + 13] = 0;
            ghostMatrices[o + 14] = 0;
            ghostMatrices[o + 15] = 1;
        }
        uploadMatrices(ghost, ghostMatrices, GHOST_INSTANCES);

        // Per-frame color refresh isn't needed — colors are baked into the
        // per-mesh material. (Kept here for the per-instance color hook so
        // adding flash effects later is just a flag.)
        void pieceColor;
        void setThinInstanceColors;
    }

    return { sync };
}
