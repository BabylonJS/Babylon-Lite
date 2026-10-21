/** GLB container framing for the glTF exporter. */

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

/** @internal Frame a JSON string and a BIN payload as a binary glTF 2.0 container.
 *
 *  The BIN chunk is always written, with length 0 when there is no binary data (Babylon.js does
 *  the same). The GLB specification allows omitting an empty BIN chunk, but Lite's own GLB parser
 *  requires it, so writing it keeps every export reloadable in Lite. The JSON chunk is padded to
 *  4 bytes with spaces (0x20) and the BIN chunk with zeros. */
export function frameGlb(json: string, bin: Uint8Array): Uint8Array<ArrayBuffer> {
    const jsonBytes = new TextEncoder().encode(json);
    const jsonLength = align4(jsonBytes.byteLength);
    const binLength = align4(bin.byteLength);
    const total = 12 + 8 + jsonLength + 8 + binLength;

    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, GLB_MAGIC, true);
    view.setUint32(4, GLB_VERSION, true);
    view.setUint32(8, total, true);

    view.setUint32(12, jsonLength, true);
    view.setUint32(16, CHUNK_JSON, true);
    out.set(jsonBytes, 20);
    out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength);

    const binHeader = 20 + jsonLength;
    view.setUint32(binHeader, binLength, true);
    view.setUint32(binHeader + 4, CHUNK_BIN, true);
    out.set(bin, binHeader + 8);
    // Trailing BIN padding is already zero.
    return out;
}

function align4(n: number): number {
    return (n + 3) & ~3;
}
