import type { PbrMaterialProps } from "./pbr/pbr-material.js";
import { enableMaterialUvTransform as enablePbrMaterialUvTransform } from "./pbr/enable-material-uv-transform.js";
import { _preloadStdMeshExt } from "./standard/standard-group-builder.js";
import type { StandardMaterialProps } from "./standard/standard-material.js";

/** Opt a PBR or Standard material into per-texture UV transforms ahead of need.
 *
 * Call this before the first build for hand-created materials that use
 * `uScale`/`vScale`/`uAng`/`uOffset`/`vOffset`. Standard transforms are sampled
 * when the renderable is built; later changes require `rebuildMaterial`. PBR
 * transforms can be refreshed with `markMaterialUboDirty`. glTF PBR materials
 * are enabled automatically by the loader.
 *
 * Returns `true` before the material's first build. Returns `false` after its
 * feature set was compiled, when applying the opt-in requires `rebuildMaterial`. */
export function enableMaterialUvTransform(material: Partial<PbrMaterialProps>): boolean;
export function enableMaterialUvTransform(material: StandardMaterialProps): boolean;
export function enableMaterialUvTransform(material: Partial<PbrMaterialProps> | StandardMaterialProps): boolean {
    if (material._buildGroup?._materialFamily !== "standard") {
        return enablePbrMaterialUvTransform(material as Partial<PbrMaterialProps>);
    }
    material = material as StandardMaterialProps;
    if (!material._hasUvTx) {
        material._uvTxExt = _preloadStdMeshExt(() => import("./standard/fragments/std-uv-transform-fragment.js"), "stdUvTransformExt");
    }
    material._hasUvTx = true;
    return material._renderFeatures === undefined;
}
