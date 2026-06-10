import { U8, DV } from "../engine/typed-arrays.js";
/** GLB binary container parsing. Kept separate so .gltf-only scenes do not ship it. */

export function parseGlbContainer(buffer: ArrayBuffer): { json: any; binChunk: DataView } {
    const view = new DV(buffer);

    // Header (12 bytes)
    const magic = view.getUint32(0, true);
    if (magic !== 0x46546c67) {
        throw new Error("Not a valid GLB file");
    }
    // const version = view.getUint32(4, true);
    // const totalLength = view.getUint32(8, true);

    // JSON chunk
    let offset = 12;
    const jsonLength = view.getUint32(offset, true);
    const jsonType = view.getUint32(offset + 4, true);
    if (jsonType !== 0x4e4f534a) {
        throw new Error("First GLB chunk is not JSON");
    }
    const jsonStr = new TextDecoder().decode(new U8(buffer, offset + 8, jsonLength));
    const json = JSON.parse(jsonStr);
    offset += 8 + jsonLength;

    // BIN chunk
    const binLength = view.getUint32(offset, true);
    const binType = view.getUint32(offset + 4, true);
    if (binType !== 0x004e4942) {
        throw new Error("Second GLB chunk is not BIN");
    }
    const binChunk = new DV(buffer, offset + 8, binLength);

    return { json, binChunk };
}
