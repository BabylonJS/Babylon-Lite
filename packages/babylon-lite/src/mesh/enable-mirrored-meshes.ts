/**
 * Opt-in entry point for mirrored (negative-determinant) mesh support.
 *
 * A mesh whose world transform mirrors it — `mesh.scaling.x = -1`, a negative scale inherited from
 * an ancestor, or a reparent onto a mirroring node — has reversed triangle winding. Without the
 * reversal its front faces are culled and it renders inside-out (Babylon.js flips `sideOrientation`
 * for the same reason).
 *
 * The glTF loader already reverses winding for negative-scale nodes it finds at load time, so this
 * opt-in is what adds the cases it cannot see: Standard-material meshes, procedural meshes, and any
 * mesh whose mirroring changes after load. The support module is reached through a dynamic import
 * and nothing in the engine references it statically, so scenes that never call this keep both
 * their chunk layout and their byte count unchanged.
 */
import type { SceneContext } from "../scene/scene-core.js";

/**
 * Enable triangle-winding reversal for mirrored meshes in `scene`.
 *
 * `await` it once, after your assets are added and before `registerScene`. Applies to both PBR and
 * Standard materials, and keeps working when a mesh's mirroring changes at runtime: each frame the
 * watcher only looks at meshes whose world matrix actually changed (an integer version compare),
 * computes a determinant for those alone, and rebuilds a pipeline only when the sign really flipped.
 *
 * The watcher is appended to the scene's per-frame callbacks so it sees the transforms produced by
 * animations and user code in the same frame. Call it again after adding an asset that registers its
 * own per-frame hooks (e.g. an animated glTF loaded later) to re-anchor it — repeat calls replace
 * the previous watcher rather than stacking another one.
 * @param scene - Scene whose meshes should be watched for mirroring.
 */
export async function enableMirroredMeshes(scene: SceneContext): Promise<void> {
    (await import("../material/standard/std-mirrored-support.js")).installMirroredMeshSupport(scene);
}
