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

import type { GltfFeature } from "./gltf-feature.js";
import type { Mesh, MeshInternal } from "../mesh/mesh.js";
import { resolveAccessor } from "./gltf-parser.js";
import { mat4ComposeInto, mat4Multiply } from "../math/mat4.js";
import type { Mat4 } from "../math/types.js";
import { computeAabb } from "../math/aabb.js";
import { setThinInstances } from "../mesh/thin-instance.js";

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
    const matrices = new Float32Array(count * 16);
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
        const { json, binChunk, nodeMap } = ctx;
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
                    count = acc.count;
                } else if (acc.count !== count) {
                    throw new Error(`EXT_mesh_gpu_instancing: accessor count mismatch on node ${nodeIdx}`);
                }
            }
            if (count === 0) {
                continue;
            }

            const matrices = buildInstanceMatrices(
                tAcc ? (tAcc.data as Float32Array) : null,
                rAcc ? (rAcc.data as Float32Array) : null,
                sAcc ? (sAcc.data as Float32Array) : null,
                count
            );
            const nodeWorld = ctx.worldMatrixCache.get(nodeIdx);
            for (const mesh of meshesForNode) {
                setThinInstances(mesh, matrices, count);
                expandMeshAabbForInstances(mesh as MeshInternal, matrices, count, nodeWorld);
            }
        }
        return {};
    },
};
export default ext;

/** Expand a mesh's world-space AABB to enclose all thin instances so that
 *  auto-framing cameras see the full instanced grid, not just the base mesh. */
function expandMeshAabbForInstances(mesh: MeshInternal, matrices: Float32Array, count: number, nodeWorld: Mat4 | undefined): void {
    const positions = mesh._cpuPositions;
    if (!positions || !nodeWorld || count === 0) {
        return;
    }
    // Local AABB of the base mesh (before any per-instance / node transform).
    const [lmin, lmax] = computeAabb(positions);
    if (!isFinite(lmin[0]!)) {
        return;
    }
    // 8 corners of the local AABB, packed as 24 floats for computeAabb.
    const corners = new Float32Array([
        lmin[0]!,
        lmin[1]!,
        lmin[2]!,
        lmax[0]!,
        lmin[1]!,
        lmin[2]!,
        lmin[0]!,
        lmax[1]!,
        lmin[2]!,
        lmax[0]!,
        lmax[1]!,
        lmin[2]!,
        lmin[0]!,
        lmin[1]!,
        lmax[2]!,
        lmax[0]!,
        lmin[1]!,
        lmax[2]!,
        lmin[0]!,
        lmax[1]!,
        lmax[2]!,
        lmax[0]!,
        lmax[1]!,
        lmax[2]!,
    ]);
    let wMinX = Infinity,
        wMinY = Infinity,
        wMinZ = Infinity;
    let wMaxX = -Infinity,
        wMaxY = -Infinity,
        wMaxZ = -Infinity;
    const instWorld = new Float32Array(16) as Mat4;
    for (let i = 0; i < count; i++) {
        for (let k = 0; k < 16; k++) {
            instWorld[k] = matrices[i * 16 + k]!;
        }
        const combined = mat4Multiply(nodeWorld, instWorld);
        const [imin, imax] = computeAabb(corners, combined);
        if (imin[0]! < wMinX) {
            wMinX = imin[0]!;
        }
        if (imin[1]! < wMinY) {
            wMinY = imin[1]!;
        }
        if (imin[2]! < wMinZ) {
            wMinZ = imin[2]!;
        }
        if (imax[0]! > wMaxX) {
            wMaxX = imax[0]!;
        }
        if (imax[1]! > wMaxY) {
            wMaxY = imax[1]!;
        }
        if (imax[2]! > wMaxZ) {
            wMaxZ = imax[2]!;
        }
    }
    mesh.boundMin = [wMinX, wMinY, wMinZ];
    mesh.boundMax = [wMaxX, wMaxY, wMaxZ];
}
