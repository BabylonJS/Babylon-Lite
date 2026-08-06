/** glTF EXT_mesh_gpu_instancing extension.
 *
 *  Attaches hardware-instanced thin instances to every mesh that belongs to a
 *  node carrying `extensions.EXT_mesh_gpu_instancing`. The extension provides
 *  per-instance TRANSLATION / ROTATION / SCALE accessors (all optional); each
 *  instance matrix is composed as T·R·S in the node's local frame. The node's
 *  own TRS is applied through the regular parent-chain world matrix at render
 *  time (`finalWorld = mesh.world * instanceWorld` in thin-instance-fragment),
 *  so instance matrices must NOT pre-multiply the node transform.
 *
 *  Dynamically imported by load-gltf only when the asset declares the
 *  extension in `extensionsUsed`, so bundles pay zero bytes otherwise.
 *
 *  Spec: https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_mesh_gpu_instancing/README.md
 */

import { F32 } from "../engine/typed-arrays.js";
import type { GltfFeature } from "./gltf-feature.js";
import type { Mesh } from "../mesh/mesh.js";
import { resolveAccessor } from "./gltf-parser.js";
import { mat4ComposeInto } from "../math/mat4-compose-into.js";
import { setThinInstances } from "../mesh/thin-instance.js";
import { enableThinInstanceWorldBounds } from "../mesh/enable-thin-instance-world-bounds.js";

/** Collect every Mesh child (direct children only — matches buildNodeHierarchy). */
function collectMeshesUnderNode(tn: { children?: unknown[] } | undefined): Mesh[] {
    const out: Mesh[] = [];
    for (const c of tn?.children ?? []) {
        if (c && typeof c === "object" && "material" in (c as object)) {
            out.push(c as Mesh);
        }
    }
    return out;
}

function buildInstanceMatrices(translation: Float32Array | null, rotation: Float32Array | null, scale: Float32Array | null, count: number): Float32Array {
    const matrices = new F32(count * 16);
    for (let i = 0; i < count; i++) {
        const tx = translation ? translation[i * 3]! : 0;
        const ty = translation ? translation[i * 3 + 1]! : 0;
        const tz = translation ? translation[i * 3 + 2]! : 0;
        const qx = rotation ? rotation[i * 4]! : 0;
        const qy = rotation ? rotation[i * 4 + 1]! : 0;
        const qz = rotation ? rotation[i * 4 + 2]! : 0;
        const qw = rotation ? rotation[i * 4 + 3]! : 1;
        const sx = scale ? scale[i * 3]! : 1;
        const sy = scale ? scale[i * 3 + 1]! : 1;
        const sz = scale ? scale[i * 3 + 2]! : 1;
        mat4ComposeInto(matrices, i * 16, tx, ty, tz, qx, qy, qz, qw, sx, sy, sz);
    }
    return matrices;
}

const ext: GltfFeature = {
    id: "EXT_mesh_gpu_instancing",
    async applyAsset(_meshes, _root, ctx) {
        const { _json: json, _binChunk: binChunk, _nodeMap: nodeMap } = ctx;
        if (!nodeMap) {
            return {};
        }
        const nodes = json.nodes ?? [];
        for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
            const attrs = nodes[nodeIdx]?.extensions?.EXT_mesh_gpu_instancing?.attributes;
            if (!attrs) {
                continue;
            }
            const tn = nodeMap[nodeIdx];
            if (!tn) {
                continue;
            }
            const meshesForNode = collectMeshesUnderNode(tn as unknown as { children?: unknown[] });
            if (meshesForNode.length === 0) {
                continue;
            }

            const tAcc = attrs.TRANSLATION !== undefined ? resolveAccessor(json, binChunk, attrs.TRANSLATION) : null;
            const rAcc = attrs.ROTATION !== undefined ? resolveAccessor(json, binChunk, attrs.ROTATION) : null;
            const sAcc = attrs.SCALE !== undefined ? resolveAccessor(json, binChunk, attrs.SCALE) : null;

            let count = 0;
            for (const acc of [tAcc, rAcc, sAcc]) {
                if (!acc) {
                    continue;
                }
                if (count === 0) {
                    count = acc._count;
                } else if (acc._count !== count) {
                    throw new Error(`EXT_mesh_gpu_instancing: accessor count mismatch on node ${nodeIdx}`);
                }
            }
            if (count === 0) {
                continue;
            }

            const matrices = buildInstanceMatrices(
                tAcc ? (tAcc._data as Float32Array) : null,
                rAcc ? (rAcc._data as Float32Array) : null,
                sAcc ? (sAcc._data as Float32Array) : null,
                count
            );
            for (const mesh of meshesForNode) {
                // Bounds are left as the loader's object-local prototype box (see `Mesh.boundMin`). Readers that
                // care about the instanced spread compose `worldMatrix × instanceMatrix × corner` themselves —
                // the same composition thin-instance-fragment draws with — so folding the node world matrix and
                // the instance grid into the box here would be counted a second time by every one of them.
                setThinInstances(mesh, matrices, count);
                enableThinInstanceWorldBounds(mesh);
            }
        }
        return {};
    },
};
export default ext;
