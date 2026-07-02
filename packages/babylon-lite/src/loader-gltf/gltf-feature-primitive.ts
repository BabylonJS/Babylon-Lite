/** Primitive-state feature (non-triangle topology + negative-determinant winding) — dynamically
 *  imported, gated on a non-triangle primitive mode OR a negative-determinant node.
 *
 *  Records `_topology` (POINTS/LINES/LINE_STRIP/TRIANGLE_STRIP) and/or `_reverseWinding` on each
 *  affected mesh and installs the PBR pipeline's primitive resolver (topology + stripIndexFormat +
 *  culling). The common triangle-list positive-winding case never loads this module, so the core
 *  loader + pipeline chunks stay byte-identical. */
import { installPbrPrimitiveResolver } from "../material/pbr/pbr-primitive-resolver.js";
import type { GltfFeature } from "./gltf-feature.js";

// Install the pipeline's primitive-state resolver. Calling an imported binding (rather than a bare
// `import "...pbr-primitive-resolver"`) keeps this alive through Rollup's tree-shaking under the
// engine's `"sideEffects": false`; a bare side-effect import is dropped from production bundles.
installPbrPrimitiveResolver();

const feature: GltfFeature = {
    id: "_primitive",
    async applyMesh(meshData, mesh) {
        // Non-triangle topology index from the glTF primitive mode. The unsupported LINE_LOOP(2) /
        // TRIANGLE_FAN(6) modes are left as a triangle list (matching BJS, which can't render them).
        const mode = (meshData as { _primitive?: { mode?: number } })._primitive?.mode;
        const topo = mode === 0 ? 1 : mode === 1 ? 2 : mode === 3 ? 3 : mode === 5 ? 4 : undefined;
        if (topo) {
            (mesh as { _topology?: number })._topology = topo;
        }
        // A mesh whose net world-matrix determinant is positive (mirrored vs the RH→LH root flip) has
        // reversed triangle winding; flag it so the pipeline culls "front" (matching BJS, which flips
        // sideOrientation on negative determinant). Normal meshes have a negative world determinant.
        const wm = meshData._worldMatrix as unknown as ArrayLike<number>;
        const det3 = wm[0]! * (wm[5]! * wm[10]! - wm[6]! * wm[9]!) + wm[1]! * (wm[6]! * wm[8]! - wm[4]! * wm[10]!) + wm[2]! * (wm[4]! * wm[9]! - wm[5]! * wm[8]!);
        if (det3 > 0) {
            (mesh as { _reverseWinding?: boolean })._reverseWinding = true;
        }
    },
};
export default feature;
