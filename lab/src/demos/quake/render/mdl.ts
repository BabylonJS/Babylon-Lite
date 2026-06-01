// Clean-room parser for the Quake MDL ("alias model") format — used for monsters,
// items and weapon view-models. Reimplemented from the publicly documented format
// (Unofficial Quake Specs §5; modelgen.h struct layout); no GPL source copied.
//
// MDL stores vertices as packed bytes (origin + scale * byte) with one keyframe per
// animation pose. We decode the skin (palettized → RGBA), the shared texture
// coordinates / triangles, and every frame's vertex positions. Triangles that are
// back-facing on a seam sample the right half of the skin, so we pre-expand the
// indexed mesh into a flat per-corner vertex list with final UVs baked in.
//
// All positions are in Quake space (X fwd, Y left, Z up); callers convert.

import { indicesToRgba } from "../palette.js";

export interface MdlFrame {
    name: string;
    base: string; // name with trailing digits stripped (animation group key)
    verts: Float32Array; // numVerts * 3, Quake space
}

export interface MdlModel {
    skinWidth: number;
    skinHeight: number;
    skinRgba: Uint8Array; // skinWidth*skinHeight*4
    numVerts: number;
    /** Flat triangle-corner UVs (numTris*3 * 2), constant across frames. */
    uvs: Float32Array;
    /** Sequential indices into the expanded vertex list (numTris*3). */
    indices: Uint32Array;
    /** expanded corner → original vertex index (numTris*3). */
    expandMap: Int32Array;
    frames: MdlFrame[];
    /** animation base-name → [firstFrame, lastFrame] inclusive. */
    groups: Map<string, [number, number]>;
}

const stripDigits = (s: string): string => s.replace(/\d+$/, "");

export function parseMdl(buffer: ArrayBuffer, palette: Uint8Array, skinIndex = 0): MdlModel {
    const dv = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    if (String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== "IDPO") throw new Error("MDL: bad magic (expected IDPO)");

    const scale: [number, number, number] = [dv.getFloat32(8, true), dv.getFloat32(12, true), dv.getFloat32(16, true)];
    const translate: [number, number, number] = [dv.getFloat32(20, true), dv.getFloat32(24, true), dv.getFloat32(28, true)];
    const numSkins = dv.getInt32(48, true);
    const skinWidth = dv.getInt32(52, true);
    const skinHeight = dv.getInt32(56, true);
    const numVerts = dv.getInt32(60, true);
    const numTris = dv.getInt32(64, true);
    const numFrames = dv.getInt32(68, true);

    let off = 84;

    // ─── Skins ───────────────────────────────────────────────────────────────
    const skinSize = skinWidth * skinHeight;
    const wantSkin = Math.max(0, Math.min(skinIndex, numSkins - 1));
    let chosen: Uint8Array | null = null;
    for (let i = 0; i < numSkins; i++) {
        const group = dv.getInt32(off, true);
        off += 4;
        if (group === 0) {
            if (i === wantSkin) chosen = bytes.subarray(off, off + skinSize);
            off += skinSize;
        } else {
            const nb = dv.getInt32(off, true);
            off += 4 + nb * 4; // skip per-frame intervals
            if (i === wantSkin) chosen = bytes.subarray(off, off + skinSize); // first group member
            off += nb * skinSize;
        }
    }
    if (!chosen) throw new Error("MDL: no skin");
    const skinRgba = indicesToRgba(chosen, palette);

    // ─── Texture coordinates (stverts) ─────────────────────────────────────────
    const onseam = new Int32Array(numVerts);
    const sCoord = new Int32Array(numVerts);
    const tCoord = new Int32Array(numVerts);
    for (let i = 0; i < numVerts; i++) {
        onseam[i] = dv.getInt32(off, true);
        sCoord[i] = dv.getInt32(off + 4, true);
        tCoord[i] = dv.getInt32(off + 8, true);
        off += 12;
    }

    // ─── Triangles ──────────────────────────────────────────────────────────────
    const facesFront = new Int32Array(numTris);
    const triVerts = new Int32Array(numTris * 3);
    for (let i = 0; i < numTris; i++) {
        facesFront[i] = dv.getInt32(off, true);
        triVerts[i * 3] = dv.getInt32(off + 4, true);
        triVerts[i * 3 + 1] = dv.getInt32(off + 8, true);
        triVerts[i * 3 + 2] = dv.getInt32(off + 12, true);
        off += 16;
    }

    // Expand to per-corner vertices with final UVs.
    const corners = numTris * 3;
    const uvs = new Float32Array(corners * 2);
    const indices = new Uint32Array(corners);
    const expandMap = new Int32Array(corners);
    for (let t = 0; t < numTris; t++) {
        for (let k = 0; k < 3; k++) {
            const c = t * 3 + k;
            const vi = triVerts[c]!;
            let s = sCoord[vi]!;
            if (facesFront[t] === 0 && onseam[vi] !== 0) s += skinWidth / 2;
            uvs[c * 2] = (s + 0.5) / skinWidth;
            uvs[c * 2 + 1] = (tCoord[vi]! + 0.5) / skinHeight;
            indices[c] = c;
            expandMap[c] = vi;
        }
    }

    // ─── Frames ───────────────────────────────────────────────────────────────
    const frames: MdlFrame[] = [];
    const readSimpleFrame = (): void => {
        off += 4 + 4; // bboxmin + bboxmax trivertx
        const name = readName(bytes, off);
        off += 16;
        const verts = new Float32Array(numVerts * 3);
        for (let v = 0; v < numVerts; v++) {
            verts[v * 3] = translate[0] + scale[0] * bytes[off]!;
            verts[v * 3 + 1] = translate[1] + scale[1] * bytes[off + 1]!;
            verts[v * 3 + 2] = translate[2] + scale[2] * bytes[off + 2]!;
            off += 4; // x,y,z,normalIndex
        }
        frames.push({ name, base: stripDigits(name), verts });
    };

    for (let f = 0; f < numFrames; f++) {
        const type = dv.getInt32(off, true);
        off += 4;
        if (type === 0) {
            readSimpleFrame();
        } else {
            const nb = dv.getInt32(off, true);
            off += 4 + 4 + 4; // nb + group bboxmin + bboxmax
            off += nb * 4; // intervals
            for (let s = 0; s < nb; s++) readSimpleFrame();
        }
    }

    // Build animation groups from frame names.
    const groups = new Map<string, [number, number]>();
    for (let i = 0; i < frames.length; i++) {
        const base = frames[i]!.base;
        const g = groups.get(base);
        if (g) g[1] = i;
        else groups.set(base, [i, i]);
    }

    return { skinWidth, skinHeight, skinRgba, numVerts, uvs, indices, expandMap, frames, groups };
}

function readName(bytes: Uint8Array, off: number): string {
    let s = "";
    for (let i = 0; i < 16; i++) {
        const c = bytes[off + i]!;
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

/** Expand a frame's compact vertex positions into the flat per-corner buffer. */
export function expandFrame(model: MdlModel, frameIndex: number, out: Float32Array): void {
    const verts = model.frames[frameIndex]!.verts;
    const map = model.expandMap;
    // Quake MDL verts are Z-up (x fwd, y left, z up). Convert to engine space
    // (Y-up) with the same [x, z, y] swap used for world geometry so the model
    // stands upright; the mesh's Y rotation then applies the entity yaw.
    for (let c = 0; c < map.length; c++) {
        const vi = map[c]! * 3;
        out[c * 3] = verts[vi]!;
        out[c * 3 + 1] = verts[vi + 2]!;
        out[c * 3 + 2] = verts[vi + 1]!;
    }
}
