/** Skeletal animation feature. Extracts joints/weights/skin on demand so the
 *  core loader doesn't carry any skinning-related code for non-skinned assets. */

import type { GltfFeature } from "./gltf-feature.js";
import { resolveAccessor } from "./gltf-parser.js";
import { _boneBuilder } from "../skeleton/bone-control-hooks.js";

/** Resolve a vertex attribute by name, preferring any pre-decoded
 *  (e.g. Draco) data over the raw accessor. De-strides interleaved sources:
 *  `resolveAccessor` assumes tight packing, so strided JOINTS/WEIGHTS — common
 *  in skinned rigs that pack both into one bufferView with a byteStride — would
 *  otherwise read neighbouring/padding bytes and corrupt the skin (wrong joint
 *  indices → exploded or mis-posed mesh). */
function resolveAttr(name: string, primitive: any, decoded: any, json: any, binChunk: DataView): ArrayBufferView | null | Promise<ArrayBufferView> {
    if (decoded && decoded._attributes.has(name)) {
        return decoded._attributes.get(name)!;
    }
    const idx = primitive.attributes?.[name];
    if (idx === undefined) {
        return null;
    }
    const accessor = json.accessors[idx];
    const bv = accessor.bufferView !== undefined ? json.bufferViews[accessor.bufferView] : undefined;
    const compBytes = accessor.componentType === 5126 || accessor.componentType === 5125 ? 4 : accessor.componentType === 5123 || accessor.componentType === 5122 ? 2 : 1;
    const stride = bv?.byteStride;
    // JOINTS_n and WEIGHTS_n are glTF VEC4 attributes.
    if (bv === undefined || stride === undefined || stride === 4 * compBytes) {
        return resolveAccessor(json, binChunk, idx)._data as ArrayBufferView;
    }
    return import("./gltf-strided-attribute.js").then((m) => m.copyStridedAttribute(accessor, bv, binChunk, 4, compBytes));
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
        const joints = (await resolveAttr("JOINTS_0", primitive, decoded, json, binChunk)) as Uint16Array | Uint8Array | null;
        const weights = (await resolveAttr("WEIGHTS_0", primitive, decoded, json, binChunk)) as Float32Array | null;
        if (!joints || !weights) {
            return;
        }
        const joints1 = (await resolveAttr("JOINTS_1", primitive, decoded, json, binChunk)) as Uint16Array | Uint8Array | null;
        const weights1 = (await resolveAttr("WEIGHTS_1", primitive, decoded, json, binChunk)) as Float32Array | null;

        const [{ extractSkin, computeBoneTextureData }, { createSkeleton }] = await Promise.all([import("./gltf-animation.js"), import("../skeleton/create-skeleton.js")]);
        const skin = extractSkin(json, binChunk, node.skin, meshData._worldMatrix, parentMap, worldMatrixCache);
        const boneData = computeBoneTextureData(skin);
        mesh.skeleton = createSkeleton(ctx._engine, joints, weights, skin.jointNodes.length, boneData, joints1, weights1);

        // When bone control is enabled, lazily create the asset-wide override map
        // here (per-mesh hook runs before any per-asset hook) so the animation feature
        // and the bone-control builder share the same map race-free.
        if (_boneBuilder && !ctx._boneOverrides) {
            ctx._boneOverrides = new Map();
        }
    },
    async applyAsset(meshes, _root, ctx) {
        // Bone control is opt-in: with the builder hook absent (default), no public
        // skeleton handles are built and `container.skeletons` stays undefined — the
        // whole bone-control implementation tree-shakes away.
        if (!_boneBuilder || !ctx._boneOverrides) {
            return {};
        }
        return _boneBuilder(ctx, meshes, ctx._boneOverrides);
    },
};
export default feature;
