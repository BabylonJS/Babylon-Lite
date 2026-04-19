/**
 * KHR_draco_mesh_compression feature.
 *
 * Runs as a `preMesh` hook — before mesh extraction — so the core loader
 * stays unaware of Draco. This module is only dynamic-imported when the
 * asset's `extensionsUsed` lists KHR_draco_mesh_compression, which in turn
 * dynamic-imports the actual Emscripten-based decoder (`draco-decode.ts`).
 */

import type { DecodedPrimitive, GltfFeature } from "./gltf-feature.js";
import { decodeDracoPrimitive, getDracoBufferViewBytes } from "./draco-decode.js";

const TYPE_COMPONENT_COUNTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

const feature: GltfFeature = {
    id: "KHR_draco_mesh_compression",
    async preMesh(jsonIn, binChunk) {
        const json = jsonIn as {
            meshes?: Array<{
                primitives?: Array<{ attributes?: Record<string, number>; extensions?: Record<string, { bufferView: number; attributes: Record<string, number> }> }>;
            }>;
            accessors?: Array<{ type: string }>;
        };
        const out = new Map<unknown, DecodedPrimitive>();
        for (const mesh of json.meshes ?? []) {
            for (const primitive of mesh.primitives ?? []) {
                const ext = primitive.extensions?.KHR_draco_mesh_compression;
                if (!ext) {
                    continue;
                }
                const bytes = getDracoBufferViewBytes(json as { bufferViews: Array<{ byteOffset?: number; byteLength: number }> }, binChunk, ext.bufferView);
                const accessorTypes: Record<string, number> = {};
                for (const name of Object.keys(ext.attributes)) {
                    const accIdx = primitive.attributes?.[name];
                    if (accIdx !== undefined && json.accessors?.[accIdx]) {
                        accessorTypes[name] = TYPE_COMPONENT_COUNTS[json.accessors[accIdx].type] ?? 3;
                    }
                }
                const decoded = await decodeDracoPrimitive(bytes, ext.attributes, accessorTypes);
                out.set(primitive, decoded);
            }
        }
        return out;
    },
};

export default feature;
