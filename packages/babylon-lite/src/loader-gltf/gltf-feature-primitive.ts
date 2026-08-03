/** Primitive-state feature (non-triangle topology + negative-determinant winding) — dynamically
 *  imported, gated on a non-triangle primitive mode OR a negative-determinant node.
 *
 *  Reversed winding rides in the mesh's feature bits (the shared pipeline reads it directly, so it
 *  is correct whether or not this module ever loads). Non-triangle TOPOLOGY instead becomes a
 *  ready-made `GPUPrimitiveState` partial on the mesh, built by a further dynamically-imported
 *  module: the topology names and branches are ~144 bytes that every PBR scene would otherwise
 *  carry on the shared pipeline path for a case essentially no asset uses, and that even a
 *  mirrored-but-triangle-list asset (the common reason this feature loads) would carry here.
 *
 *  The common triangle-list positive-winding case never loads this module. */
import { mat4Determinant3 } from "../math/mat4-determinant3.js";
import { buildPrimitiveState } from "../material/pbr/pbr-primitive-topology.js";
import type { GltfFeature } from "./gltf-feature.js";

const MSH_REVERSE_WINDING = 1 << 11;
const MSH_TOPOLOGY_SHIFT = 12;
const MSH_INDEX_U32 = 1 << 15;

const feature: GltfFeature = {
    id: "_primitive",
    async applyMesh(meshData, mesh) {
        // Non-triangle topology index from the glTF primitive mode. The unsupported LINE_LOOP(2) /
        // TRIANGLE_FAN(6) modes are left as a triangle list (matching BJS, which can't render them).
        const mode = (meshData as { _primitive?: { mode?: number } })._primitive?.mode;
        const topo = mode === 0 ? 1 : (mode as number) & 1 ? ((mode as number) + 3) >> 1 : undefined;
        let features = topo ? (topo << MSH_TOPOLOGY_SHIFT) | (topo > 2 && mesh._gpu.indexFormat === "uint32" ? MSH_INDEX_U32 : 0) : 0;
        if (topo) {
            // Statically imported: a further dynamic import would keep the topology names out of
            // this chunk, but it drags the bundler's preload plumbing INTO it, and this chunk is
            // fetched by every mirrored-node asset — measured worse for both scenes that load it.
            (mesh as typeof mesh & { _primitive?: GPUPrimitiveState })._primitive = buildPrimitiveState(topo, mesh._gpu.indexFormat === "uint32");
        }
        // A mesh whose net world-matrix determinant is positive (mirrored vs the RH→LH root flip) has
        // reversed triangle winding; flag it so the pipeline culls "front" (matching BJS, which flips
        // sideOrientation on negative determinant). Normal meshes have a negative world determinant.
        const wm = meshData._worldMatrix as unknown as ArrayLike<number>;
        if (mat4Determinant3(wm) > 0) {
            features |= MSH_REVERSE_WINDING;
        }
        if (features) {
            (mesh as typeof mesh & { _primitiveFeatures?: number })._primitiveFeatures = features;
        }
    },
};
export default feature;
