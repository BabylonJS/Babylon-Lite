/**
 * KHR_xmp_json_ld feature.
 *
 * XMP JSON-LD is pure metadata — it has no effect on rendering. This feature
 * simply surfaces the document-level metadata packets (and the asset-referenced
 * packet) on the returned AssetContainer so applications can read provenance,
 * licensing, authorship, etc. It is dynamic-imported only when `extensionsUsed`
 * lists KHR_xmp_json_ld, so non-XMP scenes pay nothing.
 */

import type { GltfFeature } from "./gltf-feature.js";

const feature: GltfFeature = {
    id: "KHR_xmp_json_ld",
    async applyAsset(_meshes, _root, ctx) {
        const json = ctx._json;
        const packets: unknown[] = json.extensions?.KHR_xmp_json_ld?.packets ?? [];
        const assetPacketIndex: number | undefined = json.asset?.extensions?.KHR_xmp_json_ld?.packet;
        const assetPacket = assetPacketIndex !== undefined ? packets[assetPacketIndex] : undefined;
        return { xmpMetadata: { packets, assetPacket } };
    },
};

export default feature;
