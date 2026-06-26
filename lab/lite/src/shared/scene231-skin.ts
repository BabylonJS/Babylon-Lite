// Shared, engine-agnostic data for Scene 231 (StandardMaterial deform features:
// per-vertex color + skeletal skinning + UV offset, with programmatically
// animated bones).
//
// Both the Lite scene (scene231.ts) and the Babylon.js reference (bjs/scene231.ts)
// import this module so the geometry, per-vertex colors, skin weights, checker
// texture, and per-frame bone matrices are byte-for-byte identical. Nothing here
// depends on either engine — only plain typed arrays — so neither bundle pulls in
// the other engine, and parity is guaranteed by construction.

/** Procedural beam mesh: 4 vertically-subdivided side faces + 2 end caps. */
export interface BeamData {
    positions: Float32Array; // xyz per vertex
    normals: Float32Array; // xyz per vertex
    uvs: Float32Array; // uv per vertex
    indices: Uint32Array;
    colors: Float32Array; // rgba per vertex
    joints: Uint16Array; // 4 bone indices per vertex
    weights: Float32Array; // 4 bone weights per vertex
    vertexCount: number;
}

const HALF_W = 0.25; // half width (x)
const HALF_D = 0.25; // half depth (z)
const HALF_H = 1.0; // half height (y) -> beam spans y in [-1, 1]
const SEGMENTS = 16; // height subdivisions per side face (smooth bend)
const BONE_COUNT = 2;

/** Normalized height 0..1 (bottom..top) from a y in [-HALF_H, HALF_H]. */
function heightT(y: number): number {
    return (y + HALF_H) / (2 * HALF_H);
}

/** Smooth bone-1 (upper) influence as a function of normalized height.
 *  Bottom ~20% rides the root bone; top ~20% rides the upper bone; smooth between. */
function upperWeight(t: number): number {
    const k = (t - 0.2) / 0.6;
    const c = k < 0 ? 0 : k > 1 ? 1 : k;
    return c * c * (3 - 2 * c); // smoothstep
}

/** A simple bottom->top rainbow so the bend reads clearly. */
function heightColor(t: number, out: Float32Array, o: number): void {
    // HSV-ish sweep red -> green -> blue across the height.
    const h = t; // 0..1
    const r = Math.max(0, 1 - Math.abs(h - 0.0) * 2);
    const g = Math.max(0, 1 - Math.abs(h - 0.5) * 2);
    const b = Math.max(0, 1 - Math.abs(h - 1.0) * 2);
    out[o] = 0.25 + 0.75 * r;
    out[o + 1] = 0.25 + 0.75 * g;
    out[o + 2] = 0.25 + 0.75 * b;
    out[o + 3] = 1;
}

/** Build the beam geometry + per-vertex color + skin weights. */
export function buildBeamData(): BeamData {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const joints: number[] = [];
    const weights: number[] = [];
    const indices: number[] = [];

    const pushVertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): void => {
        positions.push(x, y, z);
        normals.push(nx, ny, nz);
        uvs.push(u, v);
        const t = heightT(y);
        const c = new Float32Array(4);
        heightColor(t, c, 0);
        colors.push(c[0]!, c[1]!, c[2]!, c[3]!);
        const w1 = upperWeight(t);
        const w0 = 1 - w1;
        joints.push(0, 1, 0, 0);
        weights.push(w0, w1, 0, 0);
    };

    // Four side faces, each a vertical strip subdivided SEGMENTS times.
    // Each face: outward normal, two columns (the face's two vertical edges).
    interface Face {
        // corner a (left edge) and b (right edge) in the XZ plane, plus outward normal
        ax: number;
        az: number;
        bx: number;
        bz: number;
        nx: number;
        nz: number;
    }
    const faces: Face[] = [
        { ax: -HALF_W, az: HALF_D, bx: HALF_W, bz: HALF_D, nx: 0, nz: 1 }, // +Z
        { ax: HALF_W, az: HALF_D, bx: HALF_W, bz: -HALF_D, nx: 1, nz: 0 }, // +X
        { ax: HALF_W, az: -HALF_D, bx: -HALF_W, bz: -HALF_D, nx: 0, nz: -1 }, // -Z
        { ax: -HALF_W, az: -HALF_D, bx: -HALF_W, bz: HALF_D, nx: -1, nz: 0 }, // -X
    ];

    for (const f of faces) {
        const base = positions.length / 3;
        for (let i = 0; i <= SEGMENTS; i++) {
            const v = i / SEGMENTS;
            const y = -HALF_H + v * (2 * HALF_H);
            pushVertex(f.ax, y, f.az, f.nx, 0, f.nz, 0, v);
            pushVertex(f.bx, y, f.bz, f.nx, 0, f.nz, 1, v);
        }
        for (let i = 0; i < SEGMENTS; i++) {
            const a = base + i * 2;
            const b = a + 1;
            const c = a + 2;
            const d = a + 3;
            indices.push(a, c, b, b, c, d);
        }
    }

    // End caps (single quads). Winding chosen so the outward normal faces ±Y.
    const addCap = (y: number, ny: number): void => {
        const base = positions.length / 3;
        const corners: [number, number][] = [
            [-HALF_W, -HALF_D],
            [HALF_W, -HALF_D],
            [HALF_W, HALF_D],
            [-HALF_W, HALF_D],
        ];
        for (const [x, z] of corners) {
            pushVertex(x, y, z, 0, ny, 0, x / (2 * HALF_W) + 0.5, z / (2 * HALF_D) + 0.5);
        }
        if (ny > 0) {
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        } else {
            indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
        }
    };
    addCap(HALF_H, 1);
    addCap(-HALF_H, -1);

    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        uvs: new Float32Array(uvs),
        indices: new Uint32Array(indices),
        colors: new Float32Array(colors),
        joints: new Uint16Array(joints),
        weights: new Float32Array(weights),
        vertexCount: positions.length / 3,
    };
}

export const SKELETON_BONE_COUNT = BONE_COUNT;

/** Animation period (frames) and swing amplitude (radians) for the upper bone. */
const PERIOD_FRAMES = 120;
const SWING_AMPLITUDE = 0.6;

/** Bend angle (radians) of the upper bone at a given frame — a pure function of
 *  the frame index, so both engines reproduce the identical pose when frozen. */
export function bendAngle(frame: number): number {
    return SWING_AMPLITUDE * Math.sin((frame / PERIOD_FRAMES) * Math.PI * 2);
}

/** Per-frame bone matrices as a packed Float32Array (BONE_COUNT * 16), in
 *  Babylon row-major layout (translation at indices 12,13,14 of each block).
 *  Bone 0 = identity (root). Bone 1 = rotation about Z by bendAngle, pivoting at
 *  the beam origin (y = 0), so the upper part swings side to side. */
export function boneMatrixData(frame: number, out?: Float32Array): Float32Array {
    const m = out ?? new Float32Array(BONE_COUNT * 16);
    // Bone 0: identity
    m[0] = 1;
    m[1] = 0;
    m[2] = 0;
    m[3] = 0;
    m[4] = 0;
    m[5] = 1;
    m[6] = 0;
    m[7] = 0;
    m[8] = 0;
    m[9] = 0;
    m[10] = 1;
    m[11] = 0;
    m[12] = 0;
    m[13] = 0;
    m[14] = 0;
    m[15] = 1;
    // Bone 1: rotation about Z (Babylon RotationZ row-major layout)
    const a = bendAngle(frame);
    const c = Math.cos(a);
    const s = Math.sin(a);
    m[16] = c;
    m[17] = s;
    m[18] = 0;
    m[19] = 0;
    m[20] = -s;
    m[21] = c;
    m[22] = 0;
    m[23] = 0;
    m[24] = 0;
    m[25] = 0;
    m[26] = 1;
    m[27] = 0;
    m[28] = 0;
    m[29] = 0;
    m[30] = 0;
    m[31] = 1;
    return m;
}

// ---- Checker texture (for the UV-offset feature) ---------------------------

export const CHECKER_SIZE = 256;
const CHECKER_CELLS = 8;

/** A grey/orange checker, RGBA8, CHECKER_SIZE square. Identical pixels feed both
 *  engines so the UV-offset shift compares exactly. */
export function buildCheckerPixels(): Uint8Array {
    const n = CHECKER_SIZE;
    const data = new Uint8Array(n * n * 4);
    const cell = n / CHECKER_CELLS;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const odd = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 1;
            const o = (y * n + x) * 4;
            if (odd) {
                data[o] = 235;
                data[o + 1] = 145;
                data[o + 2] = 40;
            } else {
                data[o] = 60;
                data[o + 1] = 64;
                data[o + 2] = 74;
            }
            data[o + 3] = 255;
        }
    }
    return data;
}

/** Static UV offset applied to the diffuse texture (demonstrates the feature). */
export const UV_OFFSET: [number, number] = [0.13, 0.07];
