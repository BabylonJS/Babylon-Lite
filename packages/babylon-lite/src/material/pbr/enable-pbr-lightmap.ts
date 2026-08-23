/**
 * Published opt-in for PBR baked lightmaps. Import from the `babylon-lite` root entry.
 *
 * Lightmaps are an opt-in extension so the always-loaded PBR core carries **zero
 * bytes** for the vast majority of scenes that never bake one: nothing in
 * `pbr-renderable.ts` scans for `lightmapTexture`, so this module (and the fragment
 * it pulls in) tree-shakes away entirely unless `enablePbrLightmap()` is called.
 *
 * Usage:
 * ```ts
 * await enablePbrLightmap();          // once, before `registerScene`
 * setPbrLightmap(material, texture, { coordIndex: 1, level: 3.2, useAsShadowmap: true });
 * ```
 */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { _registerPbrExt } from "./pbr-flags.js";

/** Options for {@link setPbrLightmap}. */
export interface PbrLightmapOptions {
    /** Intensity multiplier applied to the sample (BJS `Texture.level`). Defaults to 1. */
    level?: number;
    /** UV set to sample: 0 = TEXCOORD_0, 1 = TEXCOORD_1. Defaults to 1 (BJS convention). */
    coordIndex?: 0 | 1;
    /** Multiply the shaded colour instead of adding to it (BJS `useLightmapAsShadowmap`). */
    useAsShadowmap?: boolean;
    /** Decode the sample from sRGB to linear (BJS `GAMMALIGHTMAP`, i.e. `Texture.gammaSpace`). */
    gamma?: boolean;
}

/** Bit 64 of `_uv2Mask` — the lightmap's TEXCOORD_1 claim. Bits 1…32 are the glTF
 *  slow-path channel bits (baseColor…occlusion); see `pbr-template-ext.ts`. Setting it
 *  is what makes the always-loaded core plumb the uv2 attribute + varying through, with
 *  no lightmap-specific branch in `pbr-renderable.ts`. */
const UV2_MASK_LIGHTMAP = 64;

let _enabled: Promise<void> | null = null;

/**
 * Enable PBR lightmap support. Idempotent; **await it before `registerScene`** so the
 * extension is registered before the first pipeline is composed.
 */
export function enablePbrLightmap(): Promise<void> {
    return (_enabled ??= import("./fragments/lightmap-fragment.js").then((mod) => {
        _registerPbrExt(mod.pbrExt);
    }));
}

/**
 * Assign a baked lightmap to a PBR material. Requires {@link enablePbrLightmap}.
 *
 * Prefer this over setting `material.lightmapTexture` directly: for `coordIndex: 1` it
 * also records the material's TEXCOORD_1 claim, which is what drives the uv2 vertex
 * attribute and varying.
 * @param material - Target PBR material.
 * @param texture - The baked lightmap. `texture.uAng === Math.PI` flips V, matching BJS.
 * @param options - Blend/decode options.
 */
export function setPbrLightmap(material: PbrMaterialProps, texture: Texture2D, options?: PbrLightmapOptions): void {
    const coordIndex = options?.coordIndex ?? 1;
    material.lightmapTexture = texture;
    material.lightmapLevel = options?.level ?? 1;
    material.lightmapCoordIndex = coordIndex;
    material.useLightmapAsShadowmap = options?.useAsShadowmap;
    material.gammaLightmap = options?.gamma;
    const m = material as { _uv2Mask?: number };
    m._uv2Mask = coordIndex === 1 ? (m._uv2Mask ?? 0) | UV2_MASK_LIGHTMAP : (m._uv2Mask ?? 0) & ~UV2_MASK_LIGHTMAP;
}
