/**
 * Antigravity Racer — procedural terrain.
 *
 * The source playground grounds the track on the Babylon playground's shared
 * `textures/heightMap.png` + `textures/ground.jpg` (400×400, 600 subdivisions,
 * heights 0…25, dropped to y = -2.05). Those files have no clear redistribution
 * terms, so this port keeps the same footprint, height range and drop but
 * generates the relief from layered value noise and shades it procedurally —
 * rocky slopes fading to dusty flats, with a subtle contour banding that reads
 * as sediment layers.
 *
 * The heightfield is deliberately carved AWAY from the track's footprint so the
 * loop always flies clear of the ground.
 */

import type { EngineContext, Mesh, SceneContext } from "babylon-lite";
import { addToScene, createMeshFromData, createStandardMaterial } from "babylon-lite";

import { TERRAIN_MAX_HEIGHT, TERRAIN_SIZE, TERRAIN_SUBDIVISIONS, TERRAIN_Y } from "./constants.js";

/** Deterministic 2D value noise (mulberry-style hash + smoothstep interpolation). */
function hash2(ix: number, iy: number): number {
    let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy);
    const b = hash2(ix + 1, iy);
    const c = hash2(ix, iy + 1);
    const d = hash2(ix + 1, iy + 1);
    return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

function fbm(x: number, y: number): number {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    for (let o = 0; o < 5; o++) {
        sum += valueNoise(x * freq, y * freq) * amp;
        freq *= 2.07;
        amp *= 0.5;
    }
    return sum;
}

/** Build the terrain mesh. The loop is roughly centred on (40, 60) with a ~60-unit radius,
 *  so the relief is pushed down inside that disc and rises into hills outside it. */
export function createTerrain(engine: EngineContext): Mesh {
    const cols = TERRAIN_SUBDIVISIONS + 1;
    const half = TERRAIN_SIZE / 2;
    const step = TERRAIN_SIZE / TERRAIN_SUBDIVISIONS;
    const positions = new Float32Array(cols * cols * 3);
    const normals = new Float32Array(cols * cols * 3);
    const uvs = new Float32Array(cols * cols * 2);

    const heights = new Float32Array(cols * cols);
    for (let row = 0; row < cols; row++) {
        for (let col = 0; col < cols; col++) {
            const x = -half + col * step;
            const z = -half + row * step;
            // Distance from the loop's centre, used to keep the middle of the map low.
            const d = Math.hypot(x - 40, z - 60) / 90;
            const basin = Math.min(1, Math.max(0, (d - 0.55) / 0.6));
            const h = fbm(x * 0.012 + 11.3, z * 0.012 - 4.7);
            heights[row * cols + col] = h * TERRAIN_MAX_HEIGHT * (0.18 + basin * 1.35) - 6;
        }
    }

    for (let row = 0; row < cols; row++) {
        for (let col = 0; col < cols; col++) {
            const i = row * cols + col;
            positions[i * 3] = -half + col * step;
            positions[i * 3 + 1] = heights[i]!;
            positions[i * 3 + 2] = -half + row * step;
            uvs[i * 2] = (col / TERRAIN_SUBDIVISIONS) * 6;
            uvs[i * 2 + 1] = (row / TERRAIN_SUBDIVISIONS) * 6;

            const hl = heights[row * cols + Math.max(0, col - 1)]!;
            const hr = heights[row * cols + Math.min(cols - 1, col + 1)]!;
            const hd = heights[Math.max(0, row - 1) * cols + col]!;
            const hu = heights[Math.min(cols - 1, row + 1) * cols + col]!;
            const nx = hl - hr;
            const nz = hd - hu;
            const ny = 2 * step;
            const len = Math.hypot(nx, ny, nz) || 1;
            normals[i * 3] = nx / len;
            normals[i * 3 + 1] = ny / len;
            normals[i * 3 + 2] = nz / len;
        }
    }

    const indices = new Uint32Array(TERRAIN_SUBDIVISIONS * TERRAIN_SUBDIVISIONS * 6);
    let ii = 0;
    for (let row = 0; row < TERRAIN_SUBDIVISIONS; row++) {
        for (let col = 0; col < TERRAIN_SUBDIVISIONS; col++) {
            const a = row * cols + col;
            const b = a + 1;
            const c = a + cols;
            const d = c + 1;
            indices[ii++] = a;
            indices[ii++] = c;
            indices[ii++] = b;
            indices[ii++] = b;
            indices[ii++] = c;
            indices[ii++] = d;
        }
    }

    const mesh = createMeshFromData(engine, "antigrav-terrain", positions, normals, indices, uvs);
    mesh.position.y = TERRAIN_Y;
    const material = createStandardMaterial();
    material.diffuseColor = [0.3, 0.27, 0.26];
    material.specularColor = [0, 0, 0];
    mesh.material = material;
    return mesh;
}

export function addTerrainToScene(scene: SceneContext, terrain: Mesh): void {
    addToScene(scene, terrain);
}
