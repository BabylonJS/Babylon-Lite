/** Standard .ply Gaussian-Splatting parser (no chunks, no SH).
 *
 *  Pure function: ArrayBuffer (.ply asset) → `ParsedSplat` containing
 *  a 32-byte/splat row buffer (position + scale + colour + quat). Mirrors the
 *  algorithm BJS uses in `GaussianSplattingMesh.ConvertPLYToSplat`.
 *
 *  Compressed PLY (`element chunk`) and SH coefficients (`element sh` or
 *  per-vertex `f_rest_*`) are handled by a separate, dynamic-imported parser
 *  (`splat-ply-compressed.ts`) so plain `.ply` scenes (e.g. scene 120) don't
 *  bundle the additional decoder code. `isPlyCompressedOrSH` lets callers
 *  decide which path to take. */

import { F32, U8C, U8, DV } from "../engine/typed-arrays.js";
import type { ParsedSplat } from "./splat-data.js";

const SH_C0 = 0.28209479177387814;

/** True when the buffer starts with a PLY ASCII header that contains `end_header\n`. */
export function isPly(data: ArrayBuffer): boolean {
    const ubuf = new U8(data, 0, Math.min(data.byteLength, 1024 * 10));
    const header = new TextDecoder().decode(ubuf);
    return header.startsWith("ply") && header.indexOf("end_header\n") >= 0;
}

/** True when the PLY header declares either an `element chunk` block
 *  (compressed PLY) or any spherical-harmonics data (`element sh` block or
 *  per-vertex `f_rest_*` properties). Callers route these assets through the
 *  separately-imported compressed parser. */
export function isPlyCompressedOrSH(data: ArrayBuffer): boolean {
    const ubuf = new U8(data, 0, Math.min(data.byteLength, 1024 * 10));
    const header = new TextDecoder().decode(ubuf);
    const end = header.indexOf("end_header\n");
    if (end < 0) {
        return false;
    }
    const slice = header.slice(0, end);
    return slice.indexOf("element chunk ") >= 0 || slice.indexOf("element sh ") >= 0 || slice.indexOf("f_rest_") >= 0;
}

/** Decode a standard PLY ArrayBuffer into the engine's internal splat row
 *  layout. Returns `{ data: ArrayBuffer(0) }` when the property layout is
 *  unsupported; returns `{ data }` echoing the input untouched when the buffer
 *  isn't a PLY at all (so callers can chain a `.splat` fast-path). */
export function convertPlyToSplat(data: ArrayBuffer): ParsedSplat {
    const ubuf = new U8(data);
    const header = new TextDecoder().decode(ubuf.slice(0, 1024 * 10));
    const headerEnd = "end_header\n";
    const headerEndIndex = header.indexOf(headerEnd);
    if (headerEndIndex < 0) {
        return { data };
    }

    const vmatch = /element vertex (\d+)\n/.exec(header);
    if (!vmatch) {
        return { data };
    }
    const vertexCount = parseInt(vmatch[1]!, 10);

    const offsets: Record<string, number> = { double: 8, int: 4, uint: 4, float: 4, short: 2, ushort: 2, uchar: 1 };
    const properties: { name: string; type: string; offset: number }[] = [];
    let rowOffset = 0;
    for (const line of header.slice(0, headerEndIndex).split("\n")) {
        if (!line.startsWith("property ")) {
            continue;
        }
        const [, type, name] = line.split(" ");
        if (!type || !name || offsets[type] === undefined) {
            return { data: new ArrayBuffer(0) };
        }
        properties.push({ name, type, offset: rowOffset });
        rowOffset += offsets[type]!;
    }

    const dv = new DV(data, headerEndIndex + headerEnd.length);
    const ROW_OUTPUT_LENGTH = 32;
    const out = new ArrayBuffer(ROW_OUTPUT_LENGTH * vertexCount);

    let off = 0;
    for (let i = 0; i < vertexCount; i++) {
        const position = new F32(out, i * ROW_OUTPUT_LENGTH, 3);
        const scale = new F32(out, i * ROW_OUTPUT_LENGTH + 12, 3);
        const rgba = new U8C(out, i * ROW_OUTPUT_LENGTH + 24, 4);
        const rot = new U8C(out, i * ROW_OUTPUT_LENGTH + 28, 4);

        let r0 = 255,
            r1 = 0,
            r2 = 0,
            r3 = 0;

        for (const prop of properties) {
            let value: number;
            switch (prop.type) {
                case "float":
                    value = dv.getFloat32(off + prop.offset, true);
                    break;
                case "int":
                    value = dv.getInt32(off + prop.offset, true);
                    break;
                case "uint":
                    value = dv.getUint32(off + prop.offset, true);
                    break;
                case "uchar":
                    value = dv.getUint8(off + prop.offset);
                    break;
                case "short":
                    value = dv.getInt16(off + prop.offset, true);
                    break;
                case "ushort":
                    value = dv.getUint16(off + prop.offset, true);
                    break;
                case "double":
                    value = dv.getFloat64(off + prop.offset, true);
                    break;
                default:
                    continue;
            }
            switch (prop.name) {
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
            }
        }

        const len = Math.hypot(r0, r1, r2, r3) || 1;
        const inv = 1 / len;
        rot[0] = r0 * inv * 127.5 + 127.5;
        rot[1] = r1 * inv * 127.5 + 127.5;
        rot[2] = r2 * inv * 127.5 + 127.5;
        rot[3] = r3 * inv * 127.5 + 127.5;

        off += rowOffset;
    }

    return { data: out };
}
