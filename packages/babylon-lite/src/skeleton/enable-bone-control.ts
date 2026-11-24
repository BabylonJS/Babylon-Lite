import { _installBoneControl } from "./bone-control-hooks.js";
import { applyOverridesToTRS, buildSkeletons } from "./bone-control.js";

/**
 * Enable bone control for skinned glTF models. Call once, before loading the
 * assets you want to control. After loading, read `container.skeletons` and drive
 * bones with {@link getBoneByName} + the `setBone*` functions.
 *
 * ```ts
 * enableBoneControl(); // ← opt-in, before loadGltf
 * const character = await loadGltf(engine, "character.glb");
 * addToScene(scene, character);
 * const skel = character.skeletons![0];
 * const head = getBoneByName(skel, "Head");
 * if (head) setBoneVisible(skel, head, false); // hide the head + everything under it
 * ```
 *
 * Process-global and idempotent. Skinned scenes that never call this are
 * unaffected (near byte-identical to a build without bone control).
 *
 * @public
 */
export function enableBoneControl(): void {
    _installBoneControl(buildSkeletons, applyOverridesToTRS);
}
