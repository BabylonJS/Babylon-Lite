import { F32, U32, U16, U8 } from "../engine/typed-arrays.js";

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

/** Copy an over-strided glTF accessor into tight typed-array storage. */
export function copyStridedAttribute(accessor: any, bufferView: any, binChunk: DataView, componentCount: number, componentBytes: number): ArrayBufferView {
    const ct = accessor.componentType;
    const count = accessor.count;
    const Ctor = ct === FLOAT ? F32 : ct === UNSIGNED_INT ? U32 : ct === UNSIGNED_SHORT ? U16 : U8;
    const out = new Ctor(count * componentCount);
    const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const stride = bufferView.byteStride;
    for (let v = 0; v < count; v++) {
        const row = base + v * stride;
        for (let c = 0; c < componentCount; c++) {
            const off = row + c * componentBytes;
            out[v * componentCount + c] =
                ct === FLOAT
                    ? binChunk.getFloat32(off, true)
                    : ct === UNSIGNED_INT
                      ? binChunk.getUint32(off, true)
                      : ct === UNSIGNED_SHORT
                        ? binChunk.getUint16(off, true)
                        : binChunk.getUint8(off);
        }
    }
    return out;
}
