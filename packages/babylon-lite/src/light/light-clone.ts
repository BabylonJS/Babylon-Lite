/** Shared light-state copy used when cloning lights.
 *
 *  Kept out of `light-base.ts` on purpose: `cloneTransformNode` hands this copier to a light's
 *  `_cloneNode`, so only scenes that clone nodes ship it. A static import of `light-base.ts` from
 *  the scene core would instead pull that whole module into the entry chunk of scenes whose lights
 *  load lazily (glTF `KHR_lights_punctual`). */

import type { Mat4, Mat4Storage } from "../math/types.js";
import type { LightBase } from "./types.js";
import type { _WritableVisibility } from "../scene/scene-node.js";

/** Copy the common SceneNode and light-filter state into a freshly created light clone. */
export function copyLightBase(source: LightBase, clone: LightBase): void {
    clone.name = source.name + "_clone";
    clone.position.copyFrom(source.position);
    clone.rotationQuaternion.copyFrom(source.rotationQuaternion);
    clone.scaling.copyFrom(source.scaling);
    (clone as _WritableVisibility).visible = source.visible;
    clone.metadata = source.metadata;
    clone.excludedMeshIds = source.excludedMeshIds;
    clone.includedOnlyMeshIds = source.includedOnlyMeshIds;
    if (source._localMatrix) {
        clone._localMatrix = (source._localMatrix as unknown as Mat4Storage).slice() as unknown as Mat4;
    }
}
