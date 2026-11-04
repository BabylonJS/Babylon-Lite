/** ExtrasAsMetadata feature.
 *
 * Mirrors Babylon.js' glTF extras metadata shape by promoting source `extras`
 * payloads to `metadata.gltf.extras` on the relevant Lite objects.
 */

import type { LiteMetadata } from "../metadata.js";
import type { GltfFeature } from "./gltf-feature.js";

interface MetadataTarget {
    metadata?: LiteMetadata;
}

const feature: GltfFeature = {
    id: "ExtrasAsMetadata",
    async applyMaterial(mat) {
        const extras = mat._rawMatDef?.extras;
        return hasExtras(extras) ? { metadata: { gltf: { extras } } } : null;
    },
    async applyMesh(meshData, mesh, ctx) {
        const json = ctx._json;
        const node = json.nodes?.[meshData._nodeIndex];
        const gltfMesh = json.meshes?.[node?.mesh];
        assignFirstExtras(mesh, meshData._primitive?.extras, gltfMesh?.extras, node?.extras);
    },
    async applyAsset(_meshes, root, ctx) {
        const json = ctx._json;
        assignExtras(root, json.asset?.extras);
        const nodeMap = ctx._nodeMap;
        if (nodeMap) {
            for (let nodeIndex = 0; nodeIndex < nodeMap.length; nodeIndex++) {
                const node = nodeMap[nodeIndex];
                if (node) {
                    assignExtras(node, json.nodes?.[nodeIndex]?.extras);
                }
            }
        }
        return {};
    },
};

function assignFirstExtras(target: MetadataTarget, ...extrasList: unknown[]): void {
    for (const extras of extrasList) {
        if (hasExtras(extras)) {
            assignExtras(target, extras);
            return;
        }
    }
}

function assignExtras(target: MetadataTarget, extras: unknown): void {
    if (!hasExtras(extras)) {
        return;
    }
    ensureGltfMetadata(target).extras = extras;
}

function ensureGltfMetadata(target: MetadataTarget): NonNullable<LiteMetadata["gltf"]> {
    const metadata = (target.metadata ??= {});
    return (metadata.gltf ??= {});
}

function hasExtras(extras: unknown): boolean {
    return extras !== undefined;
}

export default feature;
