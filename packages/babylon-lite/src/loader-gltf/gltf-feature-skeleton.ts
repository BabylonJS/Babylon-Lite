/** Skeletal animation feature. Extracts joints/weights/skin on demand so the
 *  core loader doesn't carry any skinning-related code for non-skinned assets. */

import type { GltfFeature } from "./gltf-feature.js";
import { resolveAccessor, TYPE_SIZES } from "./gltf-parser.js";
import { F32, U32, U16, U8 } from "../engine/typed-arrays.js";
import { _boneBuilder } from "../skeleton/bone-control-hooks.js";

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const COMP_BYTES: Record<number, number> = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };

/** Resolve a vertex attribute by name, preferring any pre-decoded
 *  (e.g. Draco) data over the raw accessor. De-strides interleaved sources:
 *  `resolveAccessor` assumes tight packing, so strided JOINTS/WEIGHTS — common
 *  in skinned rigs that pack both into one bufferView with a byteStride — would
 *  otherwise read neighbouring/padding bytes and corrupt the skin (wrong joint
 *  indices → exploded or mis-posed mesh). */
function resolveAttr(name: string, primitive: any, decoded: any, json: any, binChunk: DataView): ArrayBufferView | null {
    if (decoded && decoded._attributes.has(name)) {
        return decoded._attributes.get(name)!;
    }
    const idx = primitive.attributes?.[name];
    if (idx === undefined) {
        return null;
    }
    const accessor = json.accessors[idx];
    const bv = accessor.bufferView !== undefined ? json.bufferViews[accessor.bufferView] : undefined;
    const componentCount = TYPE_SIZES[accessor.type] ?? 1;
    const compBytes = COMP_BYTES[accessor.componentType] ?? 4;
    const stride = bv?.byteStride;
    if (bv === undefined || stride === undefined || stride === componentCount * compBytes) {
        return resolveAccessor(json, binChunk, idx)._data as ArrayBufferView;
    }

    // Interleaved source: copy each element into a tight array, honoring byteStride.
    const ct = accessor.componentType;
    const count = accessor.count;
    const Ctor = ct === FLOAT ? F32 : ct === UNSIGNED_INT ? U32 : ct === UNSIGNED_SHORT ? U16 : U8;
    const out = new Ctor(count * componentCount);
    const base = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    for (let v = 0; v < count; v++) {
        const row = base + v * stride;
        for (let c = 0; c < componentCount; c++) {
            const off = row + c * compBytes;
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
