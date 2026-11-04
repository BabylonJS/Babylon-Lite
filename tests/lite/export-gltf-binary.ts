import { strict as assert } from "node:assert";

export type GltfJson = Record<string, any>;

export interface ParsedGlb {
    json: GltfJson;
    bin: Uint8Array;
    bytes: Uint8Array;
}

export function parseGlb(source: string | Uint8Array): ParsedGlb {
    const bytes = typeof source === "string" ? Buffer.from(source, "base64") : source;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint32(0, true), 0x46546c67);
    assert.equal(view.getUint32(4, true), 2);
    assert.equal(view.getUint32(8, true), bytes.byteLength);
    assert.equal(view.getUint32(16, true), 0x4e4f534a);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GltfJson;
    const binHeader = 20 + jsonLength;
    assert.equal(view.getUint32(binHeader + 4, true), 0x004e4942);
    const binLength = view.getUint32(binHeader, true);
    return { json, bin: bytes.subarray(binHeader + 8, binHeader + 8 + binLength), bytes };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const READERS: Record<number, { size: number; read: (this: DataView, offset: number, littleEndian?: boolean) => number }> = {
    5120: { size: 1, read: DataView.prototype.getInt8 },
    5121: { size: 1, read: DataView.prototype.getUint8 },
    5122: { size: 2, read: DataView.prototype.getInt16 },
    5123: { size: 2, read: DataView.prototype.getUint16 },
    5125: { size: 4, read: DataView.prototype.getUint32 },
    5126: { size: 4, read: DataView.prototype.getFloat32 },
};

/** Read raw components independently of the loader/exporter, including interleaved fixture data. */
export function readAccessor(json: GltfJson, bin: Uint8Array, index: number): number[] {
    const accessor = json.accessors[index];
    const view = json.bufferViews[accessor.bufferView];
    const components = COMPONENTS[accessor.type]!;
    const reader = READERS[accessor.componentType];
    if (!reader) {
        throw new Error(`Unsupported accessor component type ${accessor.componentType}`);
    }
    const stride = view.byteStride ?? components * reader.size;
    const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const result: number[] = [];
    for (let i = 0; i < accessor.count; i++) {
        for (let c = 0; c < components; c++) {
            const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + i * stride + c * reader.size;
            result.push(reader.read.call(data, offset, true));
        }
    }
    return result;
}
