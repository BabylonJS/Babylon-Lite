/**
 * Lazy KHR_draco_mesh_compression decoder.
 *
 * The Draco decoder (JS glue + WASM) is loaded from `/draco_decoder.js` and
 * `/draco_decoder.wasm` on first use via a `<script>` injection. This keeps
 * bundle size at zero bytes for scenes that do not load Draco-compressed
 * glTF assets — the entire module (including this file) is dynamically
 * imported from extractAllMeshes only when a primitive carries
 * `KHR_draco_mesh_compression`.
 *
 * The decoder output is always 32-bit: Float32 for FLOAT accessors,
 * Uint32Array for indices. Vertex attributes match glTF accessor types
 * (POSITION/NORMAL/TANGENT=VEC3, TEXCOORD_0=VEC2, ...).
 */

import type { DecodedPrimitive } from "./gltf-feature.js";

// Public base URL where the decoder JS + WASM are hosted. Defaults to site root.
let dracoBaseUrl = "/";

/** Override the base URL where draco_decoder.js and draco_decoder.wasm are hosted. */
export function setDracoBaseUrl(url: string): void {
    dracoBaseUrl = url.endsWith("/") ? url : url + "/";
}

interface DracoModule {
    Decoder: new () => {
        DecodeBufferToMesh(buffer: unknown, mesh: unknown): { ok(): boolean; error_msg(): string };
        GetTrianglesUInt32Array(mesh: unknown, byteLength: number, outPtr: number): void;
        GetAttributeByUniqueId(mesh: unknown, uniqueId: number): unknown;
        GetAttributeDataArrayForAllPoints(mesh: unknown, attr: unknown, dataType: number, byteLength: number, outPtr: number): boolean;
    };
    DecoderBuffer: new () => { Init(data: Uint8Array, size: number): void };
    Mesh: new () => { num_faces(): number; num_points(): number };
    destroy(obj: unknown): void;
    HEAPF32: Float32Array;
    HEAPU32: Uint32Array;
    HEAP32: Int32Array;
    DT_FLOAT32: number;
    DT_INT32: number;
    _malloc(size: number): number;
    _free(ptr: number): void;
}

type DracoFactory = (cfg: { locateFile?: (file: string) => string }) => Promise<DracoModule>;

let modulePromise: Promise<DracoModule> | null = null;
let scriptLoadPromise: Promise<DracoFactory> | null = null;

function loadDracoScript(): Promise<DracoFactory> {
    if (scriptLoadPromise) {
        return scriptLoadPromise;
    }
    scriptLoadPromise = new Promise<DracoFactory>((resolve, reject) => {
        const existing = (globalThis as { DracoDecoderModule?: DracoFactory }).DracoDecoderModule;
        if (existing) {
            resolve(existing);
            return;
        }
        const script = document.createElement("script");
        script.src = dracoBaseUrl + "draco_decoder.js";
        script.onload = () => {
            const factory = (globalThis as { DracoDecoderModule?: DracoFactory }).DracoDecoderModule;
            if (!factory) {
                reject(new Error("draco_decoder.js loaded but DracoDecoderModule is undefined"));
            } else {
                resolve(factory);
            }
        };
        script.onerror = () => reject(new Error("Failed to load draco_decoder.js from " + script.src));
        document.head.appendChild(script);
    });
    return scriptLoadPromise;
}

async function getDracoModule(): Promise<DracoModule> {
    if (modulePromise) {
        return modulePromise;
    }
    modulePromise = (async () => {
        const factory = await loadDracoScript();
        return factory({ locateFile: (f: string) => dracoBaseUrl + f });
    })();
    return modulePromise;
}

/**
 * Decode a KHR_draco_mesh_compression primitive.
 * @param compressed The raw bytes of the bufferView referenced by the extension.
 * @param attributeMap Map of glTF attribute name (POSITION, NORMAL, ...) to Draco unique id.
 * @param accessorTypes Map of glTF attribute name to component count (3 for VEC3, 2 for VEC2, 4 for VEC4).
 */
export async function decodeDracoPrimitive(compressed: Uint8Array, attributeMap: Record<string, number>, accessorTypes: Record<string, number>): Promise<DecodedPrimitive> {
    const module = await getDracoModule();
    const decoder = new module.Decoder();
    const buffer = new module.DecoderBuffer();
    buffer.Init(compressed, compressed.byteLength);
    const mesh = new module.Mesh();
    const status = decoder.DecodeBufferToMesh(buffer, mesh);
    if (!status.ok()) {
        const err = status.error_msg();
        module.destroy(buffer);
        module.destroy(mesh);
        module.destroy(decoder);
        throw new Error("Draco decode failed: " + err);
    }

    const numPoints = mesh.num_points();
    const numFaces = mesh.num_faces();
    const indexCount = numFaces * 3;

    // Indices: Draco returns Uint32 triangles. Always slice() off the heap
    // view because module._malloc may grow the WASM memory and invalidate
    // the typed-array views we already hold.
    const indexByteLength = indexCount * 4;
    const indexPtr = module._malloc(indexByteLength);
    decoder.GetTrianglesUInt32Array(mesh, indexByteLength, indexPtr);
    const indices = new Uint32Array(module.HEAPU32.buffer, indexPtr, indexCount).slice();
    module._free(indexPtr);

    const attributes = new Map<string, Float32Array | Uint32Array | Int32Array>();
    for (const name of Object.keys(attributeMap)) {
        const uniqueId = attributeMap[name]!;
        const attr = decoder.GetAttributeByUniqueId(mesh, uniqueId);
        const componentCount = accessorTypes[name] ?? 3;
        const totalComponents = numPoints * componentCount;
        const isIntAttr = name === "JOINTS_0" || name === "JOINTS_1";
        const bytesPerElement = 4;
        const byteLength = totalComponents * bytesPerElement;
        const ptr = module._malloc(byteLength);
        const dataType = isIntAttr ? module.DT_INT32 : module.DT_FLOAT32;
        decoder.GetAttributeDataArrayForAllPoints(mesh, attr, dataType, byteLength, ptr);
        // Re-read the HEAP view AFTER malloc/decode — the underlying buffer
        // may have been reallocated during decoding.
        if (isIntAttr) {
            attributes.set(name, new Int32Array(module.HEAP32.buffer, ptr, totalComponents).slice());
        } else {
            attributes.set(name, new Float32Array(module.HEAPF32.buffer, ptr, totalComponents).slice());
        }
        module._free(ptr);
    }

    module.destroy(buffer);
    module.destroy(mesh);
    module.destroy(decoder);

    return { _attributes: attributes, _indices: indices, _vertexCount: numPoints, _indexCount: indexCount };
}

/**
 * Read the bufferView slice referenced by the Draco extension into a Uint8Array.
 */
export function getDracoBufferViewBytes(json: { bufferViews: Array<{ byteOffset?: number; byteLength: number }> }, binChunk: DataView, bufferViewIdx: number): Uint8Array {
    const view = json.bufferViews[bufferViewIdx];
    if (!view) {
        throw new Error(`Draco bufferView ${bufferViewIdx} not found`);
    }
    const offset = binChunk.byteOffset + (view.byteOffset ?? 0);
    return new Uint8Array(binChunk.buffer, offset, view.byteLength);
}
