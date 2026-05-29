/** Skeletal animation feature. Extracts joints/weights/skin on demand so the
 *  core loader doesn't carry any skinning-related code for non-skinned assets. */

import type { GltfFeature } from "./gltf-feature.js";
import { resolveAccessor } from "./gltf-parser.js";

/** Resolve a vertex attribute by name, preferring any pre-decoded
 *  (e.g. Draco) data over the raw accessor. */
function resolveAttr(name: string, primitive: any, decoded: any, json: any, binChunk: DataView): ArrayBufferView | null {
    if (decoded && decoded._attributes.has(name)) {
        return decoded._attributes.get(name)!;
    }
    const idx = primitive.attributes?.[name];
    return idx !== undefined ? (resolveAccessor(json, binChunk, idx)._data as ArrayBufferView) : null;
}

const feature: GltfFeature = {
    id: "_skeleton",
    async applyMesh(meshData, mesh, ctx) {
        const { _json: json, _binChunk: binChunk, _parentMap: parentMap, _worldMatrixCache: worldMatrixCache } = ctx;
        const node = json.nodes[meshData._nodeIndex];
        if (node.skin === undefined || !json.skins) {
            return;
        }
        const primitive = meshData._primitive;
        const decoded = meshData._decoded;
        const joints = resolveAttr("JOINTS_0", primitive, decoded, json, binChunk) as Uint16Array | Uint8Array | null;
        const weights = resolveAttr("WEIGHTS_0", primitive, decoded, json, binChunk) as Float32Array | null;
        if (!joints || !weights) {
            return;
        }
        const joints1 = resolveAttr("JOINTS_1", primitive, decoded, json, binChunk) as Uint16Array | Uint8Array | null;
        const weights1 = resolveAttr("WEIGHTS_1", primitive, decoded, json, binChunk) as Float32Array | null;

        const [{ extractSkin, computeBoneTextureData }, { createSkeleton }] = await Promise.all([import("./gltf-animation.js"), import("../skeleton/create-skeleton.js")]);
        const skin = extractSkin(json, binChunk, node.skin, meshData._worldMatrix, parentMap, worldMatrixCache);
        const boneData = computeBoneTextureData(skin);
        mesh.skeleton = createSkeleton(ctx._engine, joints, weights, skin.jointNodes.length, boneData, joints1, weights1);
    },
};
export default feature;
