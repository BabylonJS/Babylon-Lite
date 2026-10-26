/** GLB container framing for the glTF exporter. */

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

/** @internal Frame a JSON string and a BIN payload as the parts of a binary glTF 2.0 container,
 *  in file order, for `new Blob(parts)`; the BIN payload is referenced, not copied.
 *
 *  The BIN chunk is always written, with length 0 when empty, as in Babylon.js: the GLB spec allows
 *  omitting it, but Lite's GLB parser requires it. The JSON chunk is padded to
 *  4 bytes with spaces (0x20) and the BIN chunk with zeros. */
export function frameGlb(json: string, bin: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] {
    const jsonBytes = new TextEncoder().encode(json);
    const jsonLength = align4(jsonBytes.byteLength);
    const binLength = align4(bin.byteLength);

    const head = new Uint8Array(20 + jsonLength);
    const view = new DataView(head.buffer);
    view.setUint32(0, GLB_MAGIC, true);
    view.setUint32(4, GLB_VERSION, true);
    view.setUint32(8, 12 + 8 + jsonLength + 8 + binLength, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, CHUNK_JSON, true);
    head.set(jsonBytes, 20);
    head.fill(0x20, 20 + jsonBytes.byteLength);

    const binHeader = new Uint8Array(8);
    const binView = new DataView(binHeader.buffer);
    binView.setUint32(0, binLength, true);
    binView.setUint32(4, CHUNK_BIN, true);
    return [head, binHeader, bin, new Uint8Array(binLength - bin.byteLength)];
}

function align4(n: number): number {
    return (n + 3) & ~3;
}
