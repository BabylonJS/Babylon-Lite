/**
 * HDR / RGBE file parser (CPU-only)
 *
 * Decodes Radiance .hdr files (RGBE format) into Float32 RGB data
 * and computes spherical harmonics from equirectangular panoramas.
 */

import { F32, F64, U8 } from "../engine/typed-arrays.js";
import { shToPolynomial } from "../math/spherical-harmonics.js";

// ─── RGBE Parser ────────────────────────────────────────────────────────────

export interface HdrImage {
    width: number;
    height: number;
    /** Float32 RGB (3 floats per pixel, row-major) */
    data: Float32Array;
}

export function parseRGBE(buffer: ArrayBuffer): HdrImage {
    const bytes = new U8(buffer);
    let pos = 0;

    function readLine(): string {
        let line = "";
        while (pos < bytes.length) {
            const ch = bytes[pos++]!;
            if (ch === 10) {
                break;
            }
            if (ch !== 13) {
                line += String.fromCharCode(ch);
            }
        }
        return line;
    }

    const sig = readLine();
    if (!sig.startsWith("#?")) {
        throw new Error("Invalid HDR: missing #? signature");
    }

    let format = "";
    while (pos < bytes.length) {
        const line = readLine();
        if (line === "") {
            break;
        }
        if (line.startsWith("FORMAT=")) {
            format = line.slice(7);
        }
    }
    if (format && format !== "32-bit_rle_rgbe") {
        throw new Error(`Unsupported HDR format: ${format}`);
    }

    const resLine = readLine();
    const resMatch = resLine.match(/-Y\s+(\d+)\s+\+X\s+(\d+)/);
    if (!resMatch) {
        throw new Error(`Invalid HDR resolution: ${resLine}`);
    }
    const height = parseInt(resMatch[1]!, 10);
    const width = parseInt(resMatch[2]!, 10);

    const data = new F32(width * height * 3);
    const scanlineBuf = new U8(width * 4);
    for (let y = 0; y < height; y++) {
        pos = decodeScanline(bytes, pos, width, data, y * width * 3, scanlineBuf);
    }

    return { width, height, data };
}

function decodeScanline(bytes: Uint8Array, pos: number, width: number, out: Float32Array, outOffset: number, scanline: Uint8Array): number {
    if (width >= 8 && width <= 0x7fff && bytes[pos] === 2 && bytes[pos + 1] === 2 && bytes[pos + 2] === ((width >> 8) & 0xff) && bytes[pos + 3] === (width & 0xff)) {
        pos += 4;
        for (let ch = 0; ch < 4; ch++) {
            let ptr = ch;
            let count = 0;
            while (count < width) {
                const a = bytes[pos++]!;
                if (a > 128) {
                    const runLen = a - 128;
                    const val = bytes[pos++]!;
                    for (let i = 0; i < runLen; i++) {
                        scanline[ptr] = val;
                        ptr += 4;
                    }
                    count += runLen;
                } else {
                    for (let i = 0; i < a; i++) {
                        scanline[ptr] = bytes[pos++]!;
                        ptr += 4;
                    }
                    count += a;
                }
            }
        }
        for (let x = 0; x < width; x++) {
            rgbeToFloat(scanline[x * 4]!, scanline[x * 4 + 1]!, scanline[x * 4 + 2]!, scanline[x * 4 + 3]!, out, outOffset + x * 3);
        }
    } else {
        for (let x = 0; x < width; x++) {
            rgbeToFloat(bytes[pos]!, bytes[pos + 1]!, bytes[pos + 2]!, bytes[pos + 3]!, out, outOffset + x * 3);
            pos += 4;
        }
    }
    return pos;
}

function rgbeToFloat(r: number, g: number, b: number, e: number, out: Float32Array, off: number): void {
    if (e === 0) {
        out[off] = out[off + 1] = out[off + 2] = 0;
    } else {
        const scale = Math.pow(2, e - 136);
        out[off] = r * scale;
        out[off + 1] = g * scale;
        out[off + 2] = b * scale;
    }
}

// ─── Spherical Harmonics from Equirect (CPU) ────────────────────────────────

export function computeSHFromEquirect(data: Float32Array, width: number, height: number): Float32Array {
    const Y00 = 0.282094791773878;
    const Y1 = 0.48860251190292;
    const Y2_2c = 1.092548430592079;
    const Y20c = 0.31539156525252;
    const Y22c = 0.54627421529604;

    const sh = new F64(27); // [R: L00..L22, G: L00..L22, B: L00..L22]
    let totalWeight = 0;

    for (let py = 0; py < height; py++) {
        const phi = ((py + 0.5) / height) * Math.PI;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);
        const dOmega = sinPhi * (Math.PI / height) * ((2 * Math.PI) / width);

        for (let px = 0; px < width; px++) {
            const theta = ((2 * (px + 0.5)) / width - 1) * Math.PI;
            const x = sinPhi * Math.sin(theta);
            const y = cosPhi;
            const z = sinPhi * Math.cos(theta);

            const idx = (py * width + px) * 3;
            let cr = data[idx]!,
                cg = data[idx + 1]!,
                cb = data[idx + 2]!;
            const maxCh = Math.max(cr, cg, cb);
            if (maxCh > 4096) {
                const s = 4096 / maxCh;
                cr *= s;
                cg *= s;
                cb *= s;
            }

            const w = dOmega;
            totalWeight += w;

            const b0 = Y00;
            const b1 = Y1 * y,
                b2 = Y1 * z,
                b3 = Y1 * x;
            const b4 = Y2_2c * x * y,
                b5 = Y2_2c * y * z;
            const b6 = Y20c * (3 * z * z - 1);
            const b7 = Y2_2c * x * z,
                b8 = Y22c * (x * x - y * y);
            const basis = [b0, b1, b2, b3, b4, b5, b6, b7, b8];

            for (let i = 0; i < 9; i++) {
                const bw = basis[i]! * w;
                sh[i] = sh[i]! + cr * bw;
                sh[9 + i] = sh[9 + i]! + cg * bw;
                sh[18 + i] = sh[18 + i]! + cb * bw;
            }
        }
    }

    // Normalize to 4π
    const correction = (4 * Math.PI) / totalWeight;
    for (let i = 0; i < 27; i++) {
        sh[i] = sh[i]! * correction;
    }

    // Irradiance + Lambertian: L0 *= 1, L1 *= 2/3, L2 *= 1/4
    const irradScale = [1, 2 / 3, 2 / 3, 2 / 3, 0.25, 0.25, 0.25, 0.25, 0.25];
    for (let ch = 0; ch < 3; ch++) {
        for (let i = 0; i < 9; i++) {
            sh[ch * 9 + i] = sh[ch * 9 + i]! * irradScale[i]!;
        }
    }

    // SH → BJS SphericalPolynomial (FromHarmonics conversion)
    return shToPolynomial(sh);
}
