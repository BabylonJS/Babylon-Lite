/** Primitive-state feature (non-triangle topology + negative-determinant winding) — dynamically
 *  imported, gated on a non-triangle primitive mode OR a negative-determinant node.
 *
 *  Both concerns become a ready-made `GPUPrimitiveState` partial on the mesh, which the shared PBR
 *  pipeline path merges over its inline triangle-list default. Resolving them there instead would
 *  cost the topology names, the branches and a winding test in every PBR scene, for cases that
 *  essentially no asset uses — ~144 bytes that pushed a dozen scenes past their bundle ceilings.
 *
 *  The winding ALSO stays in the mesh's feature bits, because those key the composed shader variant:
 *  a mirrored and an unmirrored mesh that are otherwise identical must not share one, or they would
 *  share this state too.
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
        // A mesh whose net world-matrix determinant is positive (mirrored vs the RH→LH root flip) has
        // reversed triangle winding, so its faces must be wound "cw" — matching BJS, which flips
        // sideOrientation on negative determinant. Normal meshes have a negative world determinant.
        const mirrored = mat4Determinant3(meshData._worldMatrix as unknown as ArrayLike<number>) > 0;
        let features = topo ? (topo << MSH_TOPOLOGY_SHIFT) | (topo > 2 && mesh._gpu.indexFormat === "uint32" ? MSH_INDEX_U32 : 0) : 0;
        if (mirrored) {
            features |= MSH_REVERSE_WINDING;
        }
        if (topo || mirrored) {
            // The winding is baked in HERE rather than resolved on the shared PBR pipeline path:
            // there it would cost a branch and a mesh-feature test in every PBR scene, including the
            // vast majority that never load this module. As data on the mesh it costs those scenes
            // only the spread that merges it. `buildPrimitiveState` is statically imported: a
            // further dynamic import keeps the topology names out of this chunk for a
            // mirrored-but-triangle-list asset, but it drags the bundler's preload plumbing in for
            // every asset that DOES have an exotic topology — re-measured, and still a net loss
            // (one scene −8 bytes, the other +215).
            const prim: GPUPrimitiveState = topo ? buildPrimitiveState(topo, mesh._gpu.indexFormat === "uint32") : {};
            if (mirrored) {
                prim.frontFace = "cw";
            }
            (mesh as typeof mesh & { _primitive?: GPUPrimitiveState })._primitive = prim;
        }
        if (features) {
            (mesh as typeof mesh & { _primitiveFeatures?: number })._primitiveFeatures = features;
        }
    },
};
export default feature;
