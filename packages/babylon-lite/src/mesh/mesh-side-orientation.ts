/** Public opt-in winding control for mirrored (negative-scale) meshes.
 *
 *  A mesh whose world transform mirrors it (an odd number of negated axes — a negative 3x3
 *  determinant) has its triangle winding reversed on screen, so the default back-face cull removes
 *  the faces that should be visible and the mesh renders inside-out / black. The glTF loader corrects
 *  this automatically; this module exposes the same capability so custom (non-glTF) loaders and
 *  hand-built scenes can opt in.
 *
 *  Importing anything from this module is what pulls in the PBR primitive resolver (via the
 *  side-effect import below) — the exact same lazy-load path the glTF primitive feature uses. Scenes
 *  that never import it keep their renderer + pipeline chunks byte-identical, so there is no bundle
 *  cost for the common case. */
import "../material/pbr/pbr-primitive-resolver.js";
import type { Mesh } from "./mesh.js";

/** Front-face winding orientation of a mesh's triangles, i.e. which side is treated as the front
 *  face for back-face culling and double-sided normal flipping. */
export const MeshSideOrientation = {
    /** Default. Triangles wind counter-clockwise — correct for a non-mirrored (positive-determinant)
     *  world transform. */
    FrontCounterClockwise: 0,
    /** Reversed. Triangles wind clockwise — needed for a mirrored (negative-determinant) world
     *  transform such as a mesh with an odd number of negatively-scaled axes. */
    FrontClockwise: 1,
} as const;
export type MeshSideOrientation = (typeof MeshSideOrientation)[keyof typeof MeshSideOrientation];

/** Explicitly set a mesh's front-face winding orientation. Call before {@link registerScene} so the
 *  render pipeline is built with the correct culling / front-face state. Pass
 *  {@link MeshSideOrientation.FrontClockwise} for a mirrored mesh, or
 *  {@link MeshSideOrientation.FrontCounterClockwise} to reset to the default. */
export function setMeshSideOrientation(mesh: Mesh, orientation: MeshSideOrientation): void {
    (mesh as { _reverseWinding?: boolean })._reverseWinding = orientation === MeshSideOrientation.FrontClockwise;
}

/** Derive and set a mesh's front-face winding orientation from its current world transform: a
 *  mirrored transform (negative 3x3 world-matrix determinant) is flagged
 *  {@link MeshSideOrientation.FrontClockwise}, otherwise {@link MeshSideOrientation.FrontCounterClockwise}.
 *
 *  Call after the mesh's transform (and parent, if any) are final and before {@link registerScene}.
 *  The world matrix is read on demand, so any transform set beforehand is reflected. */
export function updateMeshSideOrientationFromTransform(mesh: Mesh): void {
    const wm = (mesh as unknown as { worldMatrix: ArrayLike<number> }).worldMatrix;
    // Sign of the upper-left 3x3 determinant (transpose-invariant, so row/column-major does not
    // matter). Negative ⇒ the transform mirrors the mesh ⇒ reversed winding.
    const det3 = wm[0]! * (wm[5]! * wm[10]! - wm[6]! * wm[9]!) + wm[1]! * (wm[6]! * wm[8]! - wm[4]! * wm[10]!) + wm[2]! * (wm[4]! * wm[9]! - wm[5]! * wm[8]!);
    setMeshSideOrientation(mesh, det3 < 0 ? MeshSideOrientation.FrontClockwise : MeshSideOrientation.FrontCounterClockwise);
}
