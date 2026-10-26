/** Whether a PBR material rebuild can skip the whole-group rebuild.
 *
 * Kept out of `material-rebuild.ts` and loaded only once a PBR material is rebuilt, so scenes that never rebuild one pay
 * nothing for it. */

import type { Mesh } from "../../mesh/mesh.js";
import type { SceneContext } from "../../scene/scene-core.js";
import type { MaterialRenderFeatures } from "../material.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { _computePbrMaterialFeatures } from "./pbr-material-features.js";
import { _pbrMeshRequest } from "./pbr-geometry-renderable.js";
import { _pbrComposeKey } from "./pbr-compose.js";
import { PBR2_ESM_SHADOW_OUTPUT, PBR2_NO_COLOR_OUTPUT } from "./pbr-flags.js";

/**
 * @internal Whether every one of `meshes` (the PBR meshes of a material being rebuilt) can be rebuilt on its own through
 * its group's closure with a variant that closure's group build composed: the build of the mesh's PBR context (the
 * per-mesh context of a runtime build included) composed the very key `rebuildSingle` will ask its composer for. A group
 * build loads WGSL and helpers only for what its meshes needed (the template extension for UV transforms, UV2 and vertex
 * colours, the lazy normal-map, spec-gloss and gamma paths, the single-light block of each light type, the multi-light
 * path, shadow, skeleton and morph fragments), so every variant it composed has what it needs, and the composer returns
 * that very variant again. A variant composed later through the closure (a runtime material assignment) may lack
 * something the build never loaded, so it does not count, and a rebuild still repairs such a mesh with a group rebuild.
 * Like a material assignment, the rebuild reuses the scene state that closure captured (environment textures, shadow
 * lights, fog and tone mapping) instead of refreshing it as a group rebuild would.
 *
 * Thin-instanced and transmissive meshes always take the group rebuild: their closure also captures culling and
 * refraction state the key does not show. So does a mesh outside its group's member list, which the group rebuild moves
 * into it, and every mesh while a runtime build is in flight.
 */
export function _pbrRebuildsComposed(scene: SceneContext, meshes: readonly Mesh[]): boolean {
    return (
        !scene._runtimeBuilds?.w &&
        meshes.every((mesh) => {
            const mat = mesh.material as PbrMaterialProps | null;
            const group = mat && scene._groups.get(mat._buildGroup);
            if (!group?.r || !group.includes(mesh) || mesh.thinInstances || mesh._runtimeThinBuild || mat!._transmissive) {
                return false;
            }
            // Read without populating the cache, like `_lazyPbrCaps`: the group rebuild this may fall back to recomputes them.
            const features = (mat!._renderFeatures as MaterialRenderFeatures | undefined) ?? _computePbrMaterialFeatures(mat!);
            const features2 = features.features2 ?? 0;
            const [ctx, meshFeatures, lightMode, singleLightType] = _pbrMeshRequest(scene, mesh, features2 & (PBR2_NO_COLOR_OUTPUT | PBR2_ESM_SHADOW_OUTPUT));
            return !!ctx?._b?.has(
                _pbrComposeKey(
                    features.features,
                    features2,
                    meshFeatures,
                    ctx._sceneFeatures,
                    lightMode,
                    singleLightType,
                    mesh._gpu._vbKey ?? "",
                    mat!._uv2Mask ?? 0,
                    mat!._pi ?? 0
                )
            );
        })
    );
}
