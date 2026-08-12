import type { PbrMaterialProps } from "./pbr/pbr-material.js";
import { enableMaterialUvTransform as enablePbrMaterialUvTransform } from "./pbr/enable-material-uv-transform.js";
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
export function enableMaterialUvTransform(material: PbrMaterialProps | StandardMaterialProps): boolean {
    if (material._buildGroup._materialFamily === "pbr") {
        return enablePbrMaterialUvTransform(material as PbrMaterialProps);
    }
    if (!material._hasUvTx) {
        const builder = material._buildGroup;
        const preload = import("./standard/fragments/std-uv-transform-fragment.js").then((module) => module.registerStdUvTransformExt());
        const pending = builder._preload ? Promise.all([builder._preload, preload]).then(() => {}) : preload;
        (material as StandardMaterialProps)._uvTxExt = preload;
        builder._preload = pending;
        const clear = () => {
            if (builder._preload === pending) {
                builder._preload = undefined;
            }
        };
        void pending.then(clear, clear);
    }
    material._hasUvTx = true;
    return material._renderFeatures === undefined;
}
