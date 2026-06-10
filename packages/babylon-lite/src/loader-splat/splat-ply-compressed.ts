/** Compressed-PLY + SH parser (separate from `splat-ply-parser.ts` so the
 *  standard PLY path stays small enough to fit scene 120's bundle ceiling).
 *
 *  Compressed PLY layout (BJS / PlayCanvas convention):
 *    • `element chunk K`     — K records of 12 floats:
 *        min_x..z, max_x..z, min_scale_*, max_scale_*, min_r..b, max_r..b
 *    • `element vertex N`    — N rows of `packed_position`/`_rotation`/`_scale`/
 *      `_color` (uint32 each); chunkIndex = `vertexIndex >> 8`.
 *    • `element sh M`        — properties define SH bytes laid out in a
 *      *trailing* block (absolute offset `chunkBytes + vertexBytes`).
 *
 *  Standard PLY with per-vertex `f_rest_*` properties also routes through
 *  this parser so SH evaluation stays paired with the rest of the SH
 *  pipeline.
 *
 *  Returns the same `ParsedSplat` contract as `convertPlyToSplat` (flat SH
 *  byte layout — see `splat-data.ts` for the exact convention). */

import { F32, U8C, U8, DV } from "../engine/typed-arrays.js";
import type { ParsedSplat } from "./splat-data.js";

const SH_C0 = 0.28209479177387814;
const SQRT2 = Math.SQRT2;
const ROW_OUTPUT_LENGTH = 32;

const TYPE_SIZE: Record<string, number> = { double: 8, int: 4, uint: 4, float: 4, short: 2, ushort: 2, uchar: 1 };

const enum Section {
    Vertex = 0,
    Chunk = 1,
    SH = 2,
    Unused = 3,
}

interface PlyProp {
    name: string;
    type: string;
    offset: number;
}

interface PlyHeader {
    vertexCount: number;
    chunkCount: number;
    rowVertexLength: number;
    rowChunkLength: number;
    vertexProps: PlyProp[];
    chunkProps: PlyProp[];
    shProps: PlyProp[];
    shDegree: number;
    shCoefficientCount: number;
    dataStart: number;
}

function shDegreeForIndex(i: number): number {
    if (i >= 71) {
        return 4;
    }
    if (i >= 44) {
        return 3;
    }
    if (i >= 23) {
        return 2;
    }
    if (i >= 8) {
        return 1;
    }
    return 0;
}

function parseHeader(data: ArrayBuffer): PlyHeader | null {
    const headerText = new TextDecoder().decode(new U8(data, 0, Math.min(data.byteLength, 1024 * 10)));
    const headerEnd = "end_header\n";
    const idx = headerText.indexOf(headerEnd);
    if (idx < 0) {
        return null;
    }
    const vmatch = /element vertex (\d+)\n/.exec(headerText);
    if (!vmatch) {
        return null;
    }
    const vertexCount = parseInt(vmatch[1]!, 10);
    const cmatch = /element chunk (\d+)\n/.exec(headerText);
    const chunkCount = cmatch ? parseInt(cmatch[1]!, 10) : 0;
    let section: Section = Section.Chunk;
    let rowVertex = 0;
    let rowChunk = 0;
    const vertexProps: PlyProp[] = [];
    const chunkProps: PlyProp[] = [];
    const shProps: PlyProp[] = [];
    let shDegree = 0;
    for (const line of headerText.slice(0, idx).split("\n")) {
        if (line.startsWith("element ")) {
            const [, kind] = line.split(" ");
            section = kind === "chunk" ? Section.Chunk : kind === "vertex" ? Section.Vertex : kind === "sh" ? Section.SH : Section.Unused;
            continue;
        }
        if (!line.startsWith("property ")) {
            continue;
        }
        const [, type, name] = line.split(" ");
        if (!type || !name || TYPE_SIZE[type] === undefined) {
            return null;
        }
        const sz = TYPE_SIZE[type]!;
        if (section === Section.Chunk) {
            chunkProps.push({ name, type, offset: rowChunk });
            rowChunk += sz;
        } else if (section === Section.Vertex) {
            vertexProps.push({ name, type, offset: rowVertex });
            rowVertex += sz;
            if (name.startsWith("f_rest_")) {
                shDegree = Math.max(shDegree, shDegreeForIndex(parseInt(name.slice(7), 10)));
            }
        } else if (section === Section.SH) {
            shProps.push({ name, type, offset: 0 });
            if (name.startsWith("f_rest_")) {
                shDegree = Math.max(shDegree, shDegreeForIndex(parseInt(name.slice(7), 10)));
            }
        }
    }
    const shCoefficientCount = shDegree ? ((shDegree + 1) * (shDegree + 1) - 1) * 3 : 0;
    return {
        vertexCount,
        chunkCount,
        rowVertexLength: rowVertex,
        rowChunkLength: rowChunk,
        vertexProps,
        chunkProps,
        shProps,
        shDegree,
        shCoefficientCount,
        dataStart: idx + headerEnd.length,
    };
}

interface CompressedChunk {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
    minSX: number;
    minSY: number;
    minSZ: number;
    maxSX: number;
    maxSY: number;
    maxSZ: number;
    minR: number;
    minG: number;
    minB: number;
    maxR: number;
    maxG: number;
    maxB: number;
}

function readChunks(header: PlyHeader, dv: DataView, offsetRef: { value: number }): CompressedChunk[] {
    const out: CompressedChunk[] = [];
    for (let i = 0; i < header.chunkCount; i++) {
        const c: CompressedChunk = {
            minX: 0,
            minY: 0,
            minZ: 0,
            maxX: 0,
            maxY: 0,
            maxZ: 0,
            minSX: 0,
            minSY: 0,
            minSZ: 0,
            maxSX: 0,
            maxSY: 0,
            maxSZ: 0,
            minR: 0,
            minG: 0,
            minB: 0,
            maxR: 1,
            maxG: 1,
            maxB: 1,
        };
        for (const p of header.chunkProps) {
            if (p.type !== "float") {
                continue;
            }
            const v = dv.getFloat32(offsetRef.value + p.offset, true);
            switch (p.name) {
                case "min_x":
                    c.minX = v;
                    break;
                case "min_y":
                    c.minY = v;
                    break;
                case "min_z":
                    c.minZ = v;
                    break;
                case "max_x":
                    c.maxX = v;
                    break;
                case "max_y":
                    c.maxY = v;
                    break;
                case "max_z":
                    c.maxZ = v;
                    break;
                case "min_scale_x":
                    c.minSX = v;
                    break;
                case "min_scale_y":
                    c.minSY = v;
                    break;
                case "min_scale_z":
                    c.minSZ = v;
                    break;
                case "max_scale_x":
                    c.maxSX = v;
                    break;
                case "max_scale_y":
                    c.maxSY = v;
                    break;
                case "max_scale_z":
                    c.maxSZ = v;
                    break;
                case "min_r":
                    c.minR = v;
                    break;
                case "min_g":
                    c.minG = v;
                    break;
                case "min_b":
                    c.minB = v;
                    break;
                case "max_r":
                    c.maxR = v;
                    break;
                case "max_g":
                    c.maxG = v;
                    break;
                case "max_b":
                    c.maxB = v;
                    break;
            }
        }
        out.push(c);
        offsetRef.value += header.rowChunkLength;
    }
    return out;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Unpack a uint32 as 11-10-11 bits → three normalized floats in [0,1]. */
function unpack111011(value: number, out: [number, number, number]): void {
    out[0] = ((value >>> 21) & 0x7ff) / 0x7ff;
    out[1] = ((value >>> 11) & 0x3ff) / 0x3ff;
    out[2] = (value & 0x7ff) / 0x7ff;
}

/** Unpack a uint32 as 4 bytes (R,G,B,A normalized to [0,1]). */
function unpack8888(value: number, out: [number, number, number, number]): void {
    out[0] = ((value >>> 24) & 0xff) / 0xff;
    out[1] = ((value >>> 16) & 0xff) / 0xff;
    out[2] = ((value >>> 8) & 0xff) / 0xff;
    out[3] = (value & 0xff) / 0xff;
}

/** Unpack a uint32 as (2-bit largest index, 3×10-bit components). Returns
 *  quaternion as [x, y, z, w] matching BJS `Quaternion.set(x, y, z, w)`. */
function unpackRot(value: number, out: [number, number, number, number]): void {
    const norm = 1.0 / (SQRT2 * 0.5);
    const a = (((value >>> 20) & 0x3ff) / 0x3ff - 0.5) * norm;
    const b = (((value >>> 10) & 0x3ff) / 0x3ff - 0.5) * norm;
    const c = ((value & 0x3ff) / 0x3ff - 0.5) * norm;
    const m = Math.sqrt(Math.max(0, 1.0 - (a * a + b * b + c * c)));
    switch (value >>> 30) {
        case 0:
            out[0] = a;
            out[1] = b;
            out[2] = c;
            out[3] = m;
            break;
        case 1:
            out[0] = m;
            out[1] = b;
            out[2] = c;
            out[3] = a;
            break;
        case 2:
            out[0] = b;
            out[1] = m;
            out[2] = c;
            out[3] = a;
            break;
        default:
            out[0] = b;
            out[1] = c;
            out[2] = m;
            out[3] = a;
            break;
    }
}

/** Decode a compressed PLY (or a standard PLY with `f_rest_*` SH properties)
 *  into a `ParsedSplat`. Dynamic-imported from `load-splat.ts` when
 *  `isPlyCompressedOrSH(data)` is true, so the standard-PLY path remains
 *  bundle-lean. */
export function convertCompressedPlyToParsedSplat(data: ArrayBuffer): ParsedSplat {
    const header = parseHeader(data);
    if (!header) {
        return { data };
    }

    const isCompressed = header.chunkCount > 0;
    const dv = new DV(data, header.dataStart);
    const out = new ArrayBuffer(ROW_OUTPUT_LENGTH * header.vertexCount);

    const tmpPos: [number, number, number] = [0, 0, 0];
    const tmpScl: [number, number, number] = [0, 0, 0];
    const tmpRgba: [number, number, number, number] = [0, 0, 0, 0];
    const tmpQuat: [number, number, number, number] = [0, 0, 0, 1];

    const offsetRef = { value: 0 };
    const chunks = isCompressed ? readChunks(header, dv, offsetRef) : null;

    const shFlat = header.shDegree && header.shCoefficientCount ? new U8(header.shCoefficientCount * header.vertexCount) : null;
    const shBlockBase = header.rowChunkLength * header.chunkCount + header.vertexCount * header.rowVertexLength;
    const shDim = header.shCoefficientCount / 3;

    for (let i = 0; i < header.vertexCount; i++) {
        const position = new F32(out, i * ROW_OUTPUT_LENGTH, 3);
        const scale = new F32(out, i * ROW_OUTPUT_LENGTH + 12, 3);
        const rgba = new U8C(out, i * ROW_OUTPUT_LENGTH + 24, 4);
        const rot = new U8C(out, i * ROW_OUTPUT_LENGTH + 28, 4);
        const chunk = chunks ? chunks[i >> 8] : null;

        let r0 = 255,
            r1 = 0,
            r2 = 0,
            r3 = 0;
        const plySH = shFlat ? new Array<number>(header.shCoefficientCount) : null;

        for (const prop of header.vertexProps) {
            let value: number;
            switch (prop.type) {
                case "float":
                    value = dv.getFloat32(offsetRef.value + prop.offset, true);
                    break;
                case "int":
                    value = dv.getInt32(offsetRef.value + prop.offset, true);
                    break;
                case "uint":
                    value = dv.getUint32(offsetRef.value + prop.offset, true);
                    break;
                case "uchar":
                    value = dv.getUint8(offsetRef.value + prop.offset);
                    break;
                case "short":
                    value = dv.getInt16(offsetRef.value + prop.offset, true);
                    break;
                case "ushort":
                    value = dv.getUint16(offsetRef.value + prop.offset, true);
                    break;
                case "double":
                    value = dv.getFloat64(offsetRef.value + prop.offset, true);
                    break;
                default:
                    continue;
            }
            switch (prop.name) {
                case "packed_position":
                    unpack111011(value, tmpPos);
                    position[0] = lerp(chunk!.minX, chunk!.maxX, tmpPos[0]);
                    position[1] = lerp(chunk!.minY, chunk!.maxY, tmpPos[1]);
                    position[2] = lerp(chunk!.minZ, chunk!.maxZ, tmpPos[2]);
                    break;
                case "packed_rotation":
                    unpackRot(value, tmpQuat);
                    r0 = tmpQuat[3];
                    r1 = tmpQuat[0];
                    r2 = tmpQuat[1];
                    r3 = tmpQuat[2];
                    break;
                case "packed_scale":
                    unpack111011(value, tmpScl);
                    scale[0] = Math.exp(lerp(chunk!.minSX, chunk!.maxSX, tmpScl[0]));
                    scale[1] = Math.exp(lerp(chunk!.minSY, chunk!.maxSY, tmpScl[1]));
                    scale[2] = Math.exp(lerp(chunk!.minSZ, chunk!.maxSZ, tmpScl[2]));
                    break;
                case "packed_color":
                    unpack8888(value, tmpRgba);
                    rgba[0] = lerp(chunk!.minR, chunk!.maxR, tmpRgba[0]) * 255;
                    rgba[1] = lerp(chunk!.minG, chunk!.maxG, tmpRgba[1]) * 255;
                    rgba[2] = lerp(chunk!.minB, chunk!.maxB, tmpRgba[2]) * 255;
                    rgba[3] = tmpRgba[3] * 255;
                    break;
                case "x":
                    position[0] = value;
                    break;
                case "y":
                    position[1] = value;
                    break;
                case "z":
                    position[2] = value;
                    break;
                case "scale_0":
                    scale[0] = Math.exp(value);
                    break;
                case "scale_1":
                    scale[1] = Math.exp(value);
                    break;
                case "scale_2":
                    scale[2] = Math.exp(value);
                    break;
                case "red":
                case "diffuse_red":
                    rgba[0] = value;
                    break;
                case "green":
                case "diffuse_green":
                    rgba[1] = value;
                    break;
                case "blue":
                case "diffuse_blue":
                    rgba[2] = value;
                    break;
                case "f_dc_0":
                    rgba[0] = (0.5 + SH_C0 * value) * 255;
                    break;
                case "f_dc_1":
                    rgba[1] = (0.5 + SH_C0 * value) * 255;
                    break;
                case "f_dc_2":
                    rgba[2] = (0.5 + SH_C0 * value) * 255;
                    break;
                case "f_dc_3":
                    rgba[3] = (0.5 + SH_C0 * value) * 255;
                    break;
                case "opacity":
                    rgba[3] = (1 / (1 + Math.exp(-value))) * 255;
                    break;
                case "rot_0":
                    r0 = value;
                    break;
                case "rot_1":
                    r1 = value;
                    break;
                case "rot_2":
                    r2 = value;
                    break;
                case "rot_3":
                    r3 = value;
                    break;
                default:
                    if (plySH && prop.name.startsWith("f_rest_")) {
                        const shIdx = parseInt(prop.name.slice(7), 10);
                        plySH[shIdx] = clamp255(value * 127.5 + 127.5);
                    }
                    break;
            }
        }

        // Compressed PLY: SH bytes live in a trailing block keyed by splat
        // index. Uchar dequant uses BJS's `(v * 8/255 - 4) * 127.5 + 127.5`
        // (different from the standard f_rest float path).
        if (plySH && header.shProps.length > 0) {
            for (let k = 0; k < header.shCoefficientCount; k++) {
                const b = dv.getUint8(shBlockBase + i * header.shCoefficientCount + k);
                plySH[k] = clamp255((b * (8 / 255) - 4) * 127.5 + 127.5);
            }
        }

        // PLY stores SH as [R0..R(d-1), G0..G(d-1), B0..B(d-1)]; transpose to
        // the BJS-coefficient layout `[R0,G0,B0, R1,G1,B1, …]`.
        if (plySH && shFlat) {
            for (let j = 0; j < shDim; j++) {
                shFlat[i * header.shCoefficientCount + j * 3 + 0] = plySH[j]!;
                shFlat[i * header.shCoefficientCount + j * 3 + 1] = plySH[j + shDim]!;
                shFlat[i * header.shCoefficientCount + j * 3 + 2] = plySH[j + shDim * 2]!;
            }
        }

        const len = Math.hypot(r0, r1, r2, r3) || 1;
        const inv = 1 / len;
        rot[0] = r0 * inv * 127.5 + 127.5;
        rot[1] = r1 * inv * 127.5 + 127.5;
        rot[2] = r2 * inv * 127.5 + 127.5;
        rot[3] = r3 * inv * 127.5 + 127.5;

        offsetRef.value += header.rowVertexLength;
    }

    if (shFlat && header.shDegree) {
        return { data: out, sh: shFlat, shDegree: header.shDegree };
    }
    return { data: out };
}
