/** Denormalize / de-stride a non-Float32 interleaved TEXCOORD_0/_1 accessor to a tight float32 VEC2
 *  [0,1] buffer. glTF UVs may be normalized UNSIGNED_BYTE/SHORT and interleaved with a byteStride;
 *  bound raw they misalign every vertex (garbage UVs → wrong texturing). Dynamically imported only
 *  when an interleaved primitive actually has a non-float UV, so float-UV interleaved meshes (the
 *  common case) never bundle this code. Mirrors the tight path's normalizeUvToVec2. */
import { F32 } from "../engine/typed-arrays.js";

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_BYTE = 5121;
const COMP_BYTES: Record<number, number> = { [UNSIGNED_BYTE]: 1, [UNSIGNED_SHORT]: 2, [FLOAT]: 4 };

export function resolveUvVec2(json: any, binChunk: DataView, idx: number): Float32Array {
    const accessor = json.accessors[idx];
    const ct = accessor.componentType;
    const cb = COMP_BYTES[ct] ?? 4;
    const bv = json.bufferViews[accessor.bufferView];
    const stride = bv.byteStride ?? 2 * cb;
    const inv = ct === UNSIGNED_BYTE ? 1 / 255 : ct === UNSIGNED_SHORT ? 1 / 65535 : 1;
    const base = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const out = new F32(accessor.count * 2);
    for (let v = 0; v < accessor.count; v++) {
        const row = base + v * stride;
        for (let c = 0; c < 2; c++) {
            const off = row + c * cb;
            const raw = ct === FLOAT ? binChunk.getFloat32(off, true) : ct === UNSIGNED_SHORT ? binChunk.getUint16(off, true) : binChunk.getUint8(off);
            out[v * 2 + c] = raw * inv;
        }
    }
    return out;
}
