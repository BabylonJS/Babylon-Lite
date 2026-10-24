/** Node-side helpers for the glTF export plumbing specs: GLB framing in both directions, accessor
 *  reading, and a hand-built triangle glTF fixture that tests extend with extra accessors. */

import { expect } from "../parity/parity-fixtures";

/** A glTF document as plain JSON. Tests index into it freely. */
export type GltfJson = Record<string, any>;

/** A parsed GLB. */
export interface ParsedGlb {
    json: GltfJson;
    /** The BIN chunk payload. */
    bin: Buffer;
    /** The whole file. */
    bytes: Buffer;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Frame a glTF document and its binary payload as a GLB. The JSON chunk is padded with spaces and
 *  the BIN chunk with zeros, both to 4 bytes. */
export function buildGlb(json: GltfJson, bin: Uint8Array): Buffer {
    const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
    const jsonLength = (jsonBytes.length + 3) & ~3;
    const binLength = (bin.length + 3) & ~3;
    const out = Buffer.alloc(12 + 8 + jsonLength + 8 + binLength);
    out.writeUInt32LE(GLB_MAGIC, 0);
    out.writeUInt32LE(2, 4);
    out.writeUInt32LE(out.length, 8);
    out.writeUInt32LE(jsonLength, 12);
    out.writeUInt32LE(CHUNK_JSON, 16);
    out.fill(0x20, 20, 20 + jsonLength);
    jsonBytes.copy(out, 20);
    const binHeader = 20 + jsonLength;
    out.writeUInt32LE(binLength, binHeader);
    out.writeUInt32LE(CHUNK_BIN, binHeader + 4);
    Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength).copy(out, binHeader + 8);
    return out;
}

/** Split a GLB (a Buffer, or its base64 text) into JSON and BIN, asserting the framing. */
export function parseGlb(source: string | Buffer): ParsedGlb {
    const bytes = typeof source === "string" ? Buffer.from(source, "base64") : source;
    expect(bytes.readUInt32LE(0)).toBe(GLB_MAGIC);
    expect(bytes.readUInt32LE(4)).toBe(2);
    expect(bytes.readUInt32LE(8)).toBe(bytes.length);
    expect(bytes.readUInt32LE(16)).toBe(CHUNK_JSON);
    const jsonLength = bytes.readUInt32LE(12);
    const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")) as GltfJson;
    const binHeader = 20 + jsonLength;
    expect(bytes.readUInt32LE(binHeader + 4)).toBe(CHUNK_BIN);
    const binLength = bytes.readUInt32LE(binHeader);
    return { json, bin: bytes.subarray(binHeader + 8, binHeader + 8 + binLength), bytes };
}

const COMPONENT_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** Read an accessor's raw components as a flat array, honoring the bufferView offset and stride.
 *  Normalization is not applied. */
export function readAccessor(json: GltfJson, bin: Uint8Array, index: number): number[] {
    const accessor = json.accessors[index];
    const view = json.bufferViews[accessor.bufferView];
    const components = COMPONENT_COUNT[accessor.type]!;
    const size = COMPONENT_BYTES[accessor.componentType];
    if (size === undefined) {
        throw new Error(`Unsupported accessor component type ${accessor.componentType}`);
    }
    const stride = view.byteStride ?? components * size;
    const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const result: number[] = [];
    for (let i = 0; i < accessor.count; i++) {
        for (let c = 0; c < components; c++) {
            const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + i * stride + c * size;
            switch (accessor.componentType) {
                case 5120:
                    result.push(data.getInt8(offset));
                    break;
                case 5121:
                    result.push(data.getUint8(offset));
                    break;
                case 5122:
                    result.push(data.getInt16(offset, true));
                    break;
                case 5123:
                    result.push(data.getUint16(offset, true));
                    break;
                case 5125:
                    result.push(data.getUint32(offset, true));
                    break;
                default:
                    result.push(data.getFloat32(offset, true));
                    break;
            }
        }
    }
    return result;
}

/** A glTF document under construction together with its BIN payload. */
export interface GltfFixture {
    json: GltfJson;
    /** The BIN payload so far. */
    bin: Buffer;
    /** Append `data` to the BIN (4-byte aligned) as a new bufferView and accessor, and return the
     *  accessor index. `view` adds bufferView members such as `byteStride`. */
    addAccessor(data: ArrayBufferView, accessor: Record<string, unknown>, view?: Record<string, unknown>): number;
    /** The finished GLB. */
    toGlb(): Buffer;
}

/** A single triangle in the XY plane: one scene node "triangle" holding mesh 0, with POSITION
 *  (0,0,0) (1,0,0) (0,1,0) (min/max set), NORMAL +Z, UNSIGNED_SHORT indices 0 1 2 and one
 *  metallic-roughness material. Accessors 0, 1 and 2 are POSITION, NORMAL and the indices. */
export function createTriangleFixture(): GltfFixture {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const indices = new Uint16Array([0, 1, 2, 0]);
    const bytes = (view: ArrayBufferView): Buffer => Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    const fixture: GltfFixture = {
        json: {
            asset: { version: "2.0" },
            scene: 0,
            scenes: [{ nodes: [0] }],
            nodes: [{ name: "triangle", mesh: 0 }],
            meshes: [{ name: "triangle", primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
            materials: [{ name: "material", pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 0, roughnessFactor: 1 } }],
            accessors: [
                { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
                { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
                { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
            ],
            bufferViews: [
                { buffer: 0, byteOffset: 0, byteLength: 36 },
                { buffer: 0, byteOffset: 36, byteLength: 36 },
                { buffer: 0, byteOffset: 72, byteLength: 6 },
            ],
            buffers: [{ byteLength: 80 }],
        },
        bin: Buffer.concat([bytes(positions), bytes(normals), bytes(indices)]),
        addAccessor(data, accessor, view = {}) {
            const offset = (fixture.bin.length + 3) & ~3;
            const padded = Buffer.alloc(offset + data.byteLength);
            fixture.bin.copy(padded);
            bytes(data).copy(padded, offset);
            fixture.bin = padded;
            fixture.json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, ...view });
            fixture.json.accessors.push({ bufferView: fixture.json.bufferViews.length - 1, ...accessor });
            fixture.json.buffers[0].byteLength = padded.length;
            return fixture.json.accessors.length - 1;
        },
        toGlb: () => buildGlb(fixture.json, fixture.bin),
    };
    return fixture;
}
