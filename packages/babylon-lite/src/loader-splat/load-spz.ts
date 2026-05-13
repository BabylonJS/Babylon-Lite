/** Public Gaussian-Splatting SPZ loader.
 *
 *  SPZ (Niantic Spatial / Aardvark "Splat Z") is a compact binary container
 *  for trained Gaussian-Splatting scenes — typically gzip-compressed and
 *  ~10x smaller than an equivalent `.ply`. We parse versions 2 and 3 inline
 *  (no WASM module), mirroring BJS `ParseSpz` byte-for-byte so parity with
 *  the reference renderer is exact.
 *
 *  Header (16 bytes):
 *    [0..3]   magic 'NGSP'
 *    [4..7]   version (u32 le, supported: 2 or 3)
 *    [8..11]  splat count (u32 le)
 *    [12]     SH degree
 *    [13]     fractional bits (signed 24-bit position scale = 1/(1<<frac))
 *    [14]     flags (bit 0 = trained with antialiasing)
 *    [15]     reserved (must be 0)
 *
 *  Body laid out as parallel arrays — positions then colors+alpha then
 *  scales then rotations then (optional) SH bytes. SH bytes are already
 *  BJS-quantised (`v * 127.5 + 127.5` clamped) so we copy them directly into
 *  our flat per-splat layout.
 *
 *  All SPZ-specific code lives here so non-SPZ scenes don't pay the bundle
 *  cost. */

import type { SceneContext } from "../scene/scene-core.js";
import type { ParsedSplat } from "./splat-data.js";
import type { GaussianSplattingMesh } from "../mesh/gaussian-splatting-mesh.js";
import { attachParsedSplat } from "./load-splat.js";
import { applyUpAxisCorrection } from "./splat-orientation.js";

const SH_C0 = 0.28209479177387814;
const MAGIC_NGSP = 0x5053474e; // 'NGSP' little-endian

/** Decompress a gzip-wrapped buffer via the browser's DecompressionStream. */
async function decompressGzip(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")));
    return new Uint8Array(await stream.arrayBuffer());
}

/** Sign-extend the 3 bytes at `offset` into an i32 and scale by `positionScale`. */
function read24bComponent(u8: Uint8Array, offset: number, positionScale: number, int32View: Int32Array, uint8View: Uint8Array): number {
    uint8View[0] = u8[offset + 0]!;
    uint8View[1] = u8[offset + 1]!;
    uint8View[2] = u8[offset + 2]!;
    uint8View[3] = (u8[offset + 2]! & 0x80) !== 0 ? 0xff : 0x00;
    return int32View[0]! * positionScale;
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Parse a decompressed SPZ buffer into the engine's standard ParsedSplat. */
function parseSpz(data: ArrayBuffer): ParsedSplat {
    const ubuf = new Uint8Array(data);
    if (ubuf.byteLength < 16) {
        throw new Error("loadSPZ: file too short to contain header");
    }
    const ubuf32 = new Uint32Array(data.slice(0, 12));
    const splatCount = ubuf32[2]!;
    const shDegree = ubuf[12]!;
    const fractionalBits = ubuf[13]!;
    /* const flags = ubuf[14]; */
    const reserved = ubuf[15]!;
    const version = ubuf32[1]!;
    if (reserved !== 0 || ubuf32[0] !== MAGIC_NGSP || version < 2 || version > 3) {
        throw new Error(`loadSPZ: unsupported SPZ stream (magic=0x${ubuf32[0]!.toString(16)} version=${version})`);
    }

    const ROW = 32;
    const buffer = new ArrayBuffer(ROW * splatCount);
    const position = new Float32Array(buffer);
    const scale = new Float32Array(buffer);
    const rgba = new Uint8ClampedArray(buffer);
    const rot = new Uint8ClampedArray(buffer);

    const positionScale = 1.0 / (1 << fractionalBits);
    const int32View = new Int32Array(1);
    const uint8View = new Uint8Array(int32View.buffer);

    let byteOffset = 16;

    // ── Positions ──────────────────────────────────────────────────────
    for (let i = 0; i < splatCount; i++) {
        position[i * 8 + 0] = read24bComponent(ubuf, byteOffset + 0, positionScale, int32View, uint8View);
        position[i * 8 + 1] = read24bComponent(ubuf, byteOffset + 3, positionScale, int32View, uint8View);
        position[i * 8 + 2] = read24bComponent(ubuf, byteOffset + 6, positionScale, int32View, uint8View);
        byteOffset += 9;
    }

    // ── Colours + Alpha (alpha is laid out before RGB in this block) ───
    //   alpha[i] at byteOffset + i
    //   rgb[i][c] at byteOffset + splatCount + i*3 + c
    for (let i = 0; i < splatCount; i++) {
        for (let c = 0; c < 3; c++) {
            const byteValue = ubuf[byteOffset + splatCount + i * 3 + c]!;
            // SPZ stores DC SH as (v - 127.5) / (0.15 * 255) — the 0.15 lets
            // higher-order bands push out-of-range DC values back into [0,1].
            const value = (byteValue - 127.5) / (0.15 * 255);
            rgba[i * 32 + 24 + c] = clamp255((0.5 + SH_C0 * value) * 255);
        }
        rgba[i * 32 + 24 + 3] = ubuf[byteOffset + i]!;
    }
    byteOffset += splatCount * 4;

    // ── Scales (log space, single byte each) ───────────────────────────
    for (let i = 0; i < splatCount; i++) {
        scale[i * 8 + 3 + 0] = Math.exp(ubuf[byteOffset + 0]! / 16.0 - 10.0);
        scale[i * 8 + 3 + 1] = Math.exp(ubuf[byteOffset + 1]! / 16.0 - 10.0);
        scale[i * 8 + 3 + 2] = Math.exp(ubuf[byteOffset + 2]! / 16.0 - 10.0);
        byteOffset += 3;
    }

    // ── Rotations (v2 = 3×i8 xyz, v3 = 32-bit smallest-three encoding) ─
    if (version >= 3) {
        const sqrt12 = Math.SQRT1_2;
        for (let i = 0; i < splatCount; i++) {
            const comp = ubuf[byteOffset + 0]! + (ubuf[byteOffset + 1]! << 8) + (ubuf[byteOffset + 2]! << 16) + (ubuf[byteOffset + 3]! << 24);
            const cmask = (1 << 9) - 1;
            const rotation: [number, number, number, number] = [0, 0, 0, 0];
            const iLargest = comp >>> 30;
            let remaining = comp;
            let sumSquares = 0;
            for (let j = 3; j >= 0; --j) {
                if (j !== iLargest) {
                    const mag = remaining & cmask;
                    const negbit = (remaining >>> 9) & 0x1;
                    remaining = remaining >>> 10;
                    let v = sqrt12 * (mag / cmask);
                    if (negbit === 1) {
                        v = -v;
                    }
                    rotation[j] = v;
                    sumSquares += v * v;
                }
            }
            rotation[iLargest] = Math.sqrt(Math.max(1 - sumSquares, 0));
            // SPZ rotation order is xyzw; pack into our row layout's wxyz.
            const shuffle: readonly [number, number, number, number] = [3, 0, 1, 2];
            for (let j = 0; j < 4; j++) {
                rot[i * 32 + 28 + j] = Math.round(127.5 + rotation[shuffle[j]!]! * 127.5);
            }
            byteOffset += 4;
        }
    } else {
        // Version 2: 3×u8 (x,y,z), w reconstructed from unit-length constraint.
        for (let i = 0; i < splatCount; i++) {
            const x = ubuf[byteOffset + 0]!;
            const y = ubuf[byteOffset + 1]!;
            const z = ubuf[byteOffset + 2]!;
            const nx = x / 127.5 - 1;
            const ny = y / 127.5 - 1;
            const nz = z / 127.5 - 1;
            rot[i * 32 + 28 + 1] = x;
            rot[i * 32 + 28 + 2] = y;
            rot[i * 32 + 28 + 3] = z;
            const v = 1 - (nx * nx + ny * ny + nz * nz);
            rot[i * 32 + 28 + 0] = 127.5 + Math.sqrt(v < 0 ? 0 : v) * 127.5;
            byteOffset += 3;
        }
    }

    // ── SH (raw BJS-quantised bytes) ───────────────────────────────────
    if (shDegree) {
        const shVectorCount = (shDegree + 1) * (shDegree + 1) - 1;
        const shComponentCount = shVectorCount * 3;
        const shFlat = new Uint8Array(splatCount * shComponentCount);
        for (let i = 0; i < splatCount; i++) {
            for (let k = 0; k < shComponentCount; k++) {
                shFlat[i * shComponentCount + k] = ubuf[byteOffset++]!;
            }
        }
        return { data: buffer, sh: shFlat, shDegree };
    }

    return { data: buffer };
}

/** Fetch + parse a `.spz` asset and attach the splat cloud to `scene`.
 *
 *  The returned mesh is **pre-rotated** so it renders upright with an
 *  identity scene-node rotation. SPZ assets are authored "Y-down" (the
 *  BJS reference compensates with `mesh.rotation.x = Math.PI`); Babylon-Lite
 *  instead bakes that `R_x(π)` correction into the row buffer +
 *  spherical-harmonics coefficients at load time — see
 *  {@link applyUpAxisCorrection} for the derivation. Consumers therefore do
 *  **not** need to set `mesh.rotation.x = Math.PI`, and
 *  {@link GaussianSplattingMesh.splatsData} exposes the post-correction row
 *  buffer rather than the original asset bytes. */
export async function loadSPZ(scene: SceneContext, url: string): Promise<GaussianSplattingMesh> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`loadSPZ: HTTP ${response.status} for ${url}`);
    }
    const raw = new Uint8Array(await response.arrayBuffer());
    // SPZ files are conventionally gzip-wrapped; auto-detect the magic.
    const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
    const data: ArrayBuffer = isGzip ? ((await decompressGzip(raw)).buffer as ArrayBuffer) : (raw.buffer as ArrayBuffer);
    const parsed = parseSpz(data);
    applyUpAxisCorrection(parsed);
    const friendly = url.substring(url.lastIndexOf("/") + 1) || "spz";
    return await attachParsedSplat(scene, friendly, parsed);
}
