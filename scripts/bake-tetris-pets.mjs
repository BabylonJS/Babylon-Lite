/**
 * Bake Kenney "Cube Pets" GLBs into merged static meshes for the tetris demo.
 *
 * Each pet GLB is several un-skinned mesh parts posed by node transforms. We
 * merge all parts (baking each node's world matrix into the vertices), apply
 * the material's KHR_texture_transform to the UVs, normalise the result to a
 * unit cube centred at the origin, and emit one geometry blob per piece type.
 *
 * Output: lab/public/tetris/tetris-pets.json  (7 pets, in piece-type order)
 *         lab/public/tetris/tetris-pets-colormap.png  (shared palette)
 *
 * Source GLBs come from the CC0 Kenney Cube Pets pack, extracted under
 * scratch/kenney/cube-pets/. Re-run after re-downloading that pack.
 *
 * Asset provenance (both CC0 / public domain, no attribution required):
 *   Cube Pets     — https://kenney.nl/assets/cube-pets
 *   Graveyard Kit — https://kenney.nl/assets/graveyard-kit (stone-wall.glb → frame)
 * Download + extract each pack's "GLB format" Models into scratch/kenney/<pack>/
 * then run `node scripts/bake-tetris-pets.mjs`. scratch/ is gitignored; the baked
 * JSON + colormap outputs under lab/public are committed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const GLB_DIR = path.join(ROOT, "scratch/kenney/cube-pets/Models/GLB format");
const GRAVE_DIR = path.join(ROOT, "scratch/kenney/graveyard-kit/Models/GLB format");
const TEX_SRC = path.join(GLB_DIR, "Textures/colormap.png");
const GRAVE_TEX_SRC = path.join(GRAVE_DIR, "Textures/colormap.png");
const OUT_JSON = path.join(ROOT, "lab/public/tetris/tetris-pets.json");
const OUT_TEX = path.join(ROOT, "lab/public/tetris/tetris-pets-colormap.png");
const OUT_FRAME = path.join(ROOT, "lab/public/tetris/tetris-frame.json");
const OUT_FRAME_TEX = path.join(ROOT, "lab/public/tetris/tetris-frame-colormap.png");

// Piece order: I, O, T, S, Z, J, L  →  one cute animal each, chosen for
// maximally distinct colours: pig (pink), panda (black/white), bunny (brown),
// crab (red), chick (yellow), cat (slate-blue), caterpillar (green).
// "duck" isn't in the pack; chick is the closest yellow bird.
const PETS = ["pig", "panda", "bunny", "crab", "chick", "cat", "caterpillar"];

// ── minimal mat4 (column-major, like glTF) ──────────────────────────────────
function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++) {
            o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
    return o;
}
function fromTRS(t, q, s) {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const [sx, sy, sz] = s;
    return [
        (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
        (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
        (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
        t[0], t[1], t[2], 1,
    ];
}
function nodeLocal(n) {
    if (n.matrix) return n.matrix.slice();
    return fromTRS(n.translation ?? [0, 0, 0], n.rotation ?? [0, 0, 0, 1], n.scale ?? [1, 1, 1]);
}
function tfPoint(m, p) {
    return [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ];
}
function tfDir(m, d) {
    // Rotation+scale only (no translation). Good enough for Kenney's
    // rotation/uniform-scale nodes; we renormalise afterwards.
    return [
        m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
        m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
        m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
    ];
}

// ── glTF accessor reading ───────────────────────────────────────────────────
const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUMC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readGlb(file) {
    const b = fs.readFileSync(file);
    const jsonLen = b.readUInt32LE(12);
    const json = JSON.parse(b.slice(20, 20 + jsonLen).toString("utf8"));
    // bin chunk follows: [len][type='BIN\0'][data]
    const binStart = 20 + jsonLen;
    const binLen = b.readUInt32LE(binStart);
    const bin = b.slice(binStart + 8, binStart + 8 + binLen);
    return { json, bin };
}
function accessor(json, bin, idx) {
    const a = json.accessors[idx];
    const bv = json.bufferViews[a.bufferView];
    const comps = NUMC[a.type];
    const Ctor = COMP[a.componentType];
    const bytesPerComp = Ctor.BYTES_PER_ELEMENT;
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const stride = bv.byteStride ?? comps * bytesPerComp;
    const out = new (a.type === "SCALAR" ? Ctor : Float32Array)(a.count * comps);
    for (let i = 0; i < a.count; i++) {
        const off = base + i * stride;
        for (let c = 0; c < comps; c++) {
            const v = new Ctor(bin.buffer, bin.byteOffset + off + c * bytesPerComp, 1)[0];
            out[i * comps + c] = v;
        }
    }
    return out;
}

function worldMatrices(json) {
    const parent = new Array(json.nodes.length).fill(-1);
    json.nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)));
    const cache = new Map();
    const world = (i) => {
        if (cache.has(i)) return cache.get(i);
        const local = nodeLocal(json.nodes[i]);
        const m = parent[i] === -1 ? local : mul(world(parent[i]), local);
        cache.set(i, m);
        return m;
    };
    return world;
}

function uvTransform(json) {
    const mat = json.materials?.[0];
    const tt = mat?.pbrMetallicRoughness?.baseColorTexture?.extensions?.KHR_texture_transform;
    const off = tt?.offset ?? [0, 0];
    const scl = tt?.scale ?? [1, 1];
    const rot = tt?.rotation ?? 0;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    return (u, v) => {
        // glTF spec: scale → rotate → translate
        const su = u * scl[0], sv = v * scl[1];
        const ru = cr * su - sr * sv;
        const rv = sr * su + cr * sv;
        return [ru + off[0], rv + off[1]];
    };
}

function loadColormap(file) {
    return PNG.sync.read(fs.readFileSync(file));
}
// Nearest-texel sample of an sRGB PNG, returning a linear-RGB triple in [0,1].
// v=0 maps to the top row (glTF / WebGPU texture convention, invertY:false).
function sampleSrgbToLinear(png, u, v) {
    const clamp = (n, hi) => Math.max(0, Math.min(hi, n));
    const x = clamp(Math.floor(u * png.width), png.width - 1);
    const y = clamp(Math.floor(v * png.height), png.height - 1);
    const o = (y * png.width + x) * 4;
    const dec = (c) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return [dec(png.data[o]), dec(png.data[o + 1]), dec(png.data[o + 2])];
}

function bakeGlb(file, { normalize, colormap }) {
    const { json, bin } = readGlb(file);
    const world = worldMatrices(json);
    const xform = uvTransform(json);
    const positions = [], normals = [], uvs = [], indices = [], colors = [];
    let base = 0;

    json.nodes.forEach((node, ni) => {
        if (node.mesh === undefined) return;
        const m = world(ni);
        for (const prim of json.meshes[node.mesh].primitives) {
            const pos = accessor(json, bin, prim.attributes.POSITION);
            const nrm = prim.attributes.NORMAL !== undefined ? accessor(json, bin, prim.attributes.NORMAL) : null;
            const uv = prim.attributes.TEXCOORD_0 !== undefined ? accessor(json, bin, prim.attributes.TEXCOORD_0) : null;
            const idx = prim.indices !== undefined ? accessor(json, bin, prim.indices) : null;
            const vcount = pos.length / 3;
            for (let i = 0; i < vcount; i++) {
                const p = tfPoint(m, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
                positions.push(p[0], p[1], p[2]);
                if (nrm) {
                    let d = tfDir(m, [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]]);
                    const len = Math.hypot(d[0], d[1], d[2]) || 1;
                    normals.push(d[0] / len, d[1] / len, d[2] / len);
                } else {
                    normals.push(0, 1, 0);
                }
                let tu = 0, tv = 0;
                if (uv) {
                    [tu, tv] = xform(uv[i * 2], uv[i * 2 + 1]);
                    uvs.push(tu, tv);
                } else {
                    uvs.push(0, 0);
                }
                // Bake the palette swatch at this vertex's UV into a per-vertex
                // linear-RGB colour. The Cube Pets atlas is a grid of flat
                // swatches and the face detail (eyes/nose) lives in tiny swatches;
                // at cell size on screen the texture either mip-blurs those
                // swatches into the body colour or drops them sub-pixel. Sampling
                // once per vertex here turns each region into an interpolated
                // vertex colour that survives at any on-screen size.
                if (colormap) {
                    const [r, g, b] = sampleSrgbToLinear(colormap, tu, tv);
                    colors.push(r, g, b);
                }
            }
            if (idx) for (let i = 0; i < idx.length; i++) indices.push(idx[i] + base);
            else for (let i = 0; i < vcount; i++) indices.push(i + base);
            base += vcount;
        }
    });

    // Centre on the AABB. When `normalize`, also scale so the largest extent == 1
    // (fills a cell); otherwise keep native units (for tiled frame segments).
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3)
        for (let a = 0; a < 3; a++) {
            mn[a] = Math.min(mn[a], positions[i + a]);
            mx[a] = Math.max(mx[a], positions[i + a]);
        }
    const ctr = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    const ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
    const s = normalize ? 1 / ext : 1;
    for (let i = 0; i < positions.length; i += 3) {
        positions[i] = (positions[i] - ctr[0]) * s;
        positions[i + 1] = (positions[i + 1] - ctr[1]) * s;
        positions[i + 2] = (positions[i + 2] - ctr[2]) * s;
    }

    return {
        positions: positions.map((v) => +v.toFixed(4)),
        normals: normals.map((v) => +v.toFixed(4)),
        uvs: uvs.map((v) => +v.toFixed(5)),
        colors: colormap ? colors.map((v) => +v.toFixed(4)) : undefined,
        indices,
        verts: positions.length / 3,
        tris: indices.length / 3,
        extent: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]],
    };
}

function bakePet(name, colormap) {
    return { name, ...bakeGlb(path.join(GLB_DIR, `animal-${name}.glb`), { normalize: true, colormap }) };
}

const petColormap = loadColormap(TEX_SRC);
const pets = PETS.map((n) => bakePet(n, petColormap));
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify({ pets }));
fs.copyFileSync(TEX_SRC, OUT_TEX);

// Stone-wall frame segment (native units, centred): tiled into a border ring.
const wall = bakeGlb(path.join(GRAVE_DIR, "stone-wall.glb"), { normalize: false });
fs.writeFileSync(OUT_FRAME, JSON.stringify({ wall }));
fs.copyFileSync(GRAVE_TEX_SRC, OUT_FRAME_TEX);

const kb = (fs.statSync(OUT_JSON).size / 1024).toFixed(0);
console.log("Baked pets (piece order I,O,T,S,Z,J,L):");
for (const p of pets) console.log(`  ${p.name.padEnd(8)} verts=${p.verts} tris=${p.tris}`);
console.log(`Wrote ${OUT_JSON} (${kb} KB) and ${OUT_TEX}`);
console.log(`Stone wall segment: verts=${wall.verts} tris=${wall.tris} extent=${wall.extent.map((v) => v.toFixed(3)).join(",")}`);
console.log(`Wrote ${OUT_FRAME} and ${OUT_FRAME_TEX}`);
