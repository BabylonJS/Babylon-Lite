/** Public Gaussian-Splatting SOG loader.
 *
 *  SOG ("SuperSplat Optimized Gaussians") is the ZIP container produced by the
 *  PlayCanvas / Babylon SOG exporter:
 *      meta.json + means_l.webp + means_u.webp + scales.webp + quats.webp +
 *      sh0.webp + (optional) sh_centroids.webp + sh_labels.webp
 *
 *  This loader fetches a `.sog` URL, unzips it, decodes the WebPs to
 *  RGBA pixels in main-thread canvases, and rebuilds the 32-byte/splat
 *  row buffer + flat SH bytes — mirroring BJS `ParseSogMeta` / `ParseSogDatas`
 *  byte-for-byte so parity with the reference is exact.
 *
 *  All SOG-specific code lives here so non-SOG scenes don't pay the bundle
 *  cost (the zip-parser, the WebP decode path, and the per-component
 *  dequantisation tables). */

import { F32, U8C, U8 } from "../engine/typed-arrays.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { ParsedSplat } from "./splat-data.js";
import type { GaussianSplattingMesh } from "../mesh/GaussianSplatting/gaussian-splatting-mesh.js";
import { attachParsedSplat } from "./load-splat.js";
import { unzipBuffer } from "./zip-parser.js";

const SH_C0 = 0.28209479177387814;

/** Subset of the BJS SOG metadata we need to consume. */
interface SOGDataFile {
    /** [splatCount, components] (e.g. [N, 3] or [N, 4]). */
    shape: number[];
    /** Per-component min/max for linear dequant (v1) — or single number for SH (v1). */
    mins?: number | number[];
    maxs?: number | number[];
    /** Codebook table for v2 (quantised data — each byte indexes this LUT). */
    codebook?: number[];
    /** WebP filenames inside the archive. */
    files: string[];
    /** SH band count when present. */
    bands?: number;
}

interface SOGRootData {
    /** 1 (linear) or 2 (codebook). */
    version?: number;
    means: SOGDataFile;
    scales: SOGDataFile;
    quats: SOGDataFile;
    sh0: SOGDataFile;
    shN?: SOGDataFile;
    /** Number of splats — optional, can be inferred from means.shape[0]. */
    count?: number;
}

interface WebPImage {
    bits: Uint8Array;
    width: number;
    height: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Decode a WebP blob to RGBA pixels through an offscreen 2D canvas. The
 *  underlying decoder is the browser's built-in (no WASM, no copy needed in
 *  headless Chrome — `createImageBitmap` is GPU-accelerated). */
async function decodeWebP(bytes: Uint8Array): Promise<WebPImage> {
    const blob = new Blob([bytes as BlobPart], { type: "image/webp" });
    const bitmap = await createImageBitmap(blob);
    const width = bitmap.width;
    const height = bitmap.height;
    if (width === 0 || height === 0) {
        throw new Error(`loadSOG: decoded WebP has zero dimensions (input size ${bytes.byteLength})`);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("loadSOG: failed to acquire 2D context for WebP decode");
    }
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    bitmap.close?.();
    return { bits: new U8(imageData.data.buffer), width: imageData.width, height: imageData.height };
}

/** Build a 32-byte/splat row buffer + optional flat SH bytes from decoded
 *  WebPs and SOG metadata. Mirrors BJS `ParseSogDatas`. */
function parseSogDatas(data: SOGRootData, images: WebPImage[]): ParsedSplat {
    const splatCount = data.count ?? data.means.shape[0]!;
    const ROW = 32;
    const buffer = new ArrayBuffer(ROW * splatCount);
    const position = new F32(buffer);
    const scale = new F32(buffer);
    const rgba = new U8C(buffer);
    const rot = new U8C(buffer);

    // Undo the symmetric log transform used at encode time:
    const unlog = (n: number): number => Math.sign(n) * (Math.exp(Math.abs(n)) - 1);

    const meansLow = images[0]!.bits;
    const meansHigh = images[1]!.bits;
    if (!Array.isArray(data.means.mins) || !Array.isArray(data.means.maxs)) {
        throw new Error("loadSOG: means.mins/means.maxs must be arrays");
    }

    // ── Positions (16-bit value reconstructed from low + high bytes) ───
    for (let i = 0; i < splatCount; i++) {
        const idx = i * 4;
        for (let j = 0; j < 3; j++) {
            const mn = data.means.mins[j]!;
            const mx = data.means.maxs[j]!;
            const q = (meansHigh[idx + j]! << 8) | meansLow[idx + j]!;
            position[i * 8 + j] = unlog(lerp(mn, mx, q / 65535));
        }
    }

    // ── Scales (codebook v2 / linear v1 in log-space, then expf) ───────
    const scales = images[2]!.bits;
    if (data.version === 2) {
        const cb = data.scales.codebook;
        if (!cb) {
            throw new Error("loadSOG: SOG v2 missing scales codebook");
        }
        for (let i = 0; i < splatCount; i++) {
            const idx = i * 4;
            for (let j = 0; j < 3; j++) {
                scale[i * 8 + 3 + j] = Math.exp(cb[scales[idx + j]!]!);
            }
        }
    } else {
        if (!Array.isArray(data.scales.mins) || !Array.isArray(data.scales.maxs)) {
            throw new Error("loadSOG: scales.mins/maxs must be arrays for SOG v1");
        }
        for (let i = 0; i < splatCount; i++) {
            const idx = i * 4;
            for (let j = 0; j < 3; j++) {
                scale[i * 8 + 3 + j] = Math.exp(lerp(data.scales.mins[j]!, data.scales.maxs[j]!, scales[idx + j]! / 255));
            }
        }
    }

    // ── Colours / SH0 (RGB through SH_C0 + sigmoid alpha) ──────────────
    const colors = images[4]!.bits;
    if (data.version === 2) {
        const cb = data.sh0.codebook;
        if (!cb) {
            throw new Error("loadSOG: SOG v2 missing sh0 codebook");
        }
        for (let i = 0; i < splatCount; i++) {
            const idx = i * 4;
            for (let j = 0; j < 3; j++) {
                const c = 0.5 + cb[colors[idx + j]!]! * SH_C0;
                rgba[i * 32 + 24 + j] = clamp255(Math.round(255 * c));
            }
            rgba[i * 32 + 24 + 3] = colors[idx + 3]!;
        }
    } else {
        if (!Array.isArray(data.sh0.mins) || !Array.isArray(data.sh0.maxs)) {
            throw new Error("loadSOG: sh0.mins/maxs must be arrays for SOG v1");
        }
        for (let i = 0; i < splatCount; i++) {
            const idx = i * 4;
            for (let j = 0; j < 4; j++) {
                const c = lerp(data.sh0.mins[j]!, data.sh0.maxs[j]!, colors[idx + j]! / 255);
                const csh = j < 3 ? 0.5 + c * SH_C0 : 1.0 / (1.0 + Math.exp(-c));
                rgba[i * 32 + 24 + j] = clamp255(Math.round(255 * csh));
            }
        }
    }

    // ── Rotations: dequant the 3 stored components, reconstruct the 4th ─
    const toComp = (c: number): number => ((c / 255 - 0.5) * 2.0) / Math.SQRT2;
    const quatBits = images[3]!.bits;
    for (let i = 0; i < splatCount; i++) {
        const a = toComp(quatBits[i * 4 + 0]!);
        const b = toComp(quatBits[i * 4 + 1]!);
        const c = toComp(quatBits[i * 4 + 2]!);
        const mode = quatBits[i * 4 + 3]! - 252;
        const t = a * a + b * b + c * c;
        const d = Math.sqrt(Math.max(0, 1 - t));
        let q0 = 0,
            q1 = 0,
            q2 = 0,
            q3 = 0;
        switch (mode) {
            case 0:
                q0 = d;
                q1 = a;
                q2 = b;
                q3 = c;
                break;
            case 1:
                q0 = a;
                q1 = d;
                q2 = b;
                q3 = c;
                break;
            case 2:
                q0 = a;
                q1 = b;
                q2 = d;
                q3 = c;
                break;
            case 3:
                q0 = a;
                q1 = b;
                q2 = c;
                q3 = d;
                break;
            default:
                throw new Error(`loadSOG: invalid quaternion mode ${mode}`);
        }
        rot[i * 32 + 28 + 0] = q0 * 127.5 + 127.5;
        rot[i * 32 + 28 + 1] = q1 * 127.5 + 127.5;
        rot[i * 32 + 28 + 2] = q2 * 127.5 + 127.5;
        rot[i * 32 + 28 + 3] = q3 * 127.5 + 127.5;
    }

    // ── SH (optional) ──────────────────────────────────────────────────
    if (data.shN) {
        const coeffs = data.shN.bands != null ? (data.shN.bands + 1) ** 2 - 1 : data.shN.shape[1]! / 3;
        const shDegree = data.shN.bands ?? Math.round(Math.sqrt(coeffs + 1) - 1);
        const shComponentCount = coeffs * 3;
        const centroids = images[5]!.bits;
        const labels = images[6]!.bits;
        const centroidsWidth = images[5]!.width;
        const shFlat = new U8(splatCount * shComponentCount);

        if (data.version === 2) {
            const cb = data.shN.codebook;
            if (!cb) {
                throw new Error("loadSOG: SOG v2 missing shN codebook");
            }
            for (let i = 0; i < splatCount; i++) {
                const n = labels[i * 4]! + (labels[i * 4 + 1]! << 8);
                const u = (n % 64) * coeffs;
                const v = Math.floor(n / 64);
                const splatBase = i * shComponentCount;
                for (let k = 0; k < coeffs; k++) {
                    for (let j = 0; j < 3; j++) {
                        const shIdx = k * 3 + j;
                        const val = cb[centroids[(u + k) * 4 + j + v * centroidsWidth * 4]!]! * 127.5 + 127.5;
                        shFlat[splatBase + shIdx] = clamp255(val);
                    }
                }
            }
        } else {
            const shMin = data.shN.mins as number;
            const shMax = data.shN.maxs as number;
            for (let i = 0; i < splatCount; i++) {
                const n = labels[i * 4]! + (labels[i * 4 + 1]! << 8);
                const u = (n % 64) * coeffs;
                const v = Math.floor(n / 64);
                const splatBase = i * shComponentCount;
                for (let j = 0; j < 3; j++) {
                    for (let k = 0; k < coeffs / 3; k++) {
                        const shIdx = k * 3 + j;
                        const raw = centroids[(u + k) * 4 + j + v * centroidsWidth * 4]!;
                        const val = lerp(shMin, shMax, raw / 255) * 127.5 + 127.5;
                        shFlat[splatBase + shIdx] = clamp255(val);
                    }
                }
            }
        }

        return { data: buffer, sh: shFlat, shDegree };
    }

    return { data: buffer };
}

/** Fetch + parse a `.sog` archive and attach the resulting splat cloud to `scene`.
 *
 *  The returned mesh has `rotation.x = Math.PI` set on the scene node, matching
 *  the BJS reference convention. SOG / PlayCanvas / SuperSplat assets are
 *  authored "Y-down", and BJS compensates with `mesh.rotation.x = Math.PI`
 *  at scene-graph time. */
export async function loadSOG(scene: SceneContext, url: string): Promise<GaussianSplattingMesh> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`loadSOG: HTTP ${response.status} for ${url}`);
    }
    const buffer = await response.arrayBuffer();
    const entries = await unzipBuffer(buffer);
    const filesByName = new Map<string, Uint8Array>();
    for (const e of entries) {
        filesByName.set(e.name, e.bytes);
    }
    const metaBytes = filesByName.get("meta.json");
    if (!metaBytes) {
        throw new Error("loadSOG: meta.json not found in archive");
    }
    const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as SOGRootData;

    // Same load order as BJS: means → scales → quats → sh0 → (shN: centroids → labels).
    const filenames = [...meta.means.files, ...meta.scales.files, ...meta.quats.files, ...meta.sh0.files];
    if (meta.shN) {
        filenames.push(...meta.shN.files);
    }
    const images = await Promise.all(
        filenames.map(async (name) => {
            const bytes = filesByName.get(name);
            if (!bytes) {
                throw new Error(`loadSOG: missing image '${name}' inside archive`);
            }
            return await decodeWebP(bytes);
        })
    );

    const parsed = parseSogDatas(meta, images);
    const friendly = url.substring(url.lastIndexOf("/") + 1) || "sog";
    const mesh = await attachParsedSplat(scene, friendly, parsed);
    mesh.rotation.x = Math.PI;
    return mesh;
}
