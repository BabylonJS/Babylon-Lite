/** StandardMaterial — Blinn-Phong material types and scene uniform helpers.
 *
 *  Pipeline creation is handled by standard-pipeline.ts (dynamic permutation system).
 *  This module owns the shared types and the scene UBO update function.
 *
 *  Scene UBO uses the canonical SCENE_UBO layout (shared with PBR).
 */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { CubeTexture } from "../../texture/cube-texture.js";
import type { ShaderFragment } from "../../shader/fragment-types.js";
import type { Material, StencilState } from "../material.js";
import type { MaterialPlugin } from "../plugin/material-plugin.js";
import { DIFFUSE_USES_UV2, DISABLE_LIGHTING, DOUBLE_SIDED, HAS_DIFFUSE_TEXTURE, MATERIAL_ALPHA_BLEND, _getStdExts } from "./standard-flags.js";

// ─── Shared Types ────────────────────────────────────────────────────

/** StandardMaterial properties — plain data. */
export interface StandardMaterialProps extends Material {
    /** Optional opt-in material plugins (custom WGSL + uniforms + samplers layered
     *  on top of the built-in Standard pipeline). Attach via `material.plugins = [plugin]`,
     *  then call `enableMaterialPlugins(scene)` before `registerScene`. */
    plugins?: MaterialPlugin[];
    /** Optional stencil-test state baked into the main-pass pipeline (mask write / discard). Default none.
     *  See `StencilState`. */
    stencil?: StencilState;
    diffuseColor: [number, number, number];
    alpha: number;
    specularColor: [number, number, number];
    specularPower: number;
    emissiveColor: [number, number, number];
    ambientColor: [number, number, number];
    /** Optional diffuse texture. Null = solid color only. */
    diffuseTexture: Texture2D | null;
    /** Diffuse texture UV channel. 0=UV1, 1=UV2. Default 0. */
    diffuseCoordIndex: 0 | 1;
    /** @internal Optional emissive texture. Set via {@link setStandardEmissiveTexture},
     *  which registers the extension. Tree-shakable — only bundled when used. */
    _emissiveTexture?: Texture2D | null;
    /** @internal Optional bump/normal-map texture (cotangent-frame, no tangent attribute
     *  needed). Set via {@link setStandardBumpTexture}, which registers the extension. */
    _bumpTexture?: Texture2D | null;
    /** Bump perturbation strength. Default 1.0 (maps to 1/level in BJS). */
    bumpLevel: number;
    /** @internal Optional specular texture (replaces specularColor; alpha modulates
     *  glossiness). Set via {@link setStandardSpecularTexture}. */
    _specularTexture?: Texture2D | null;
    /** Specular texture UV channel. 0=UV1, 1=UV2. Default 0. */
    specularCoordIndex: 0 | 1;
    /** @internal Optional ambient/occlusion texture (multiplies final diffuse
     *  contribution). Set via {@link setStandardAmbientTexture}. */
    _ambientTexture?: Texture2D | null;
    /** Ambient texture intensity. Default 1.0. */
    ambientTexLevel: number;
    /** Ambient texture UV channel. 0=UV1, 1=UV2. Default 0. */
    ambientCoordIndex: 0 | 1;
    /** @internal Optional lightmap texture. Set via {@link setStandardLightmapTexture}. */
    _lightmapTexture?: Texture2D | null;
    /** Lightmap intensity. Default 1.0. */
    lightmapLevel: number;
    /** Lightmap UV channel. 0=UV1, 1=UV2. Default 1 (BJS convention). */
    lightmapCoordIndex: 0 | 1;
    /** When true, the lightmap is a baked shadowmap that multiplies the final color
     *  (`color *= lightmap * level`) instead of being added. Matches BJS
     *  StandardMaterial.useLightmapAsShadowmap. Default false. */
    useLightmapAsShadowmap: boolean;
    /** @internal Optional opacity texture (multiplies alpha). Set via
     *  {@link setStandardOpacityTexture}. */
    _opacityTexture?: Texture2D | null;
    /** Opacity texture intensity. Default 1.0. */
    opacityLevel: number;
    /** When true, derive opacity from RGB luminance instead of .a channel. Default false. */
    opacityFromRGB: boolean;
    /** Alpha test cutoff. Fragments with `alpha < alphaCutOff` are discarded. Default 0 (no alpha test). */
    alphaCutOff: number;
    /** @internal Optional reflection texture (2D spherical map). Set via
     *  {@link setStandardReflectionTexture}. */
    _reflectionTexture?: Texture2D | null;
    /** @internal Optional cube reflection texture. Set via
     *  {@link setStandardReflectionCubeTexture}. */
    _reflectionCubeTexture?: CubeTexture | null;
    /** Reflection intensity. Default 1.0. */
    reflectionLevel: number;
    /** Reflection coordinate mode. 1=spherical, 2=planar. Default 1. */
    reflectionCoordMode: 1 | 2;
    /** UV tiling scale. Default [1, 1]. */
    uvScale: [number, number];
    /** Optional UV translation applied after scale. Missing values behave as [0, 0]. */
    uvOffset?: [number, number];
    /** Back-face culling. Default true (BJS convention). False = double-sided. */
    backFaceCulling: boolean;
    /** When true, skip all lighting and output emissive * diffuse * baseColor. Default false. */
    disableLighting: boolean;
}

/** @internal Compute Standard material-only feature bits. Mesh/pass bits are added by the renderable.
 *
 *  Only bits for features that are ALWAYS present live here. Every optional texture
 *  feature contributes its own bits through its registered ext's `_detect`, so both the
 *  detection branch and the fragment it gates stay out of the always-loaded core. A
 *  material that never opts in registers no ext, so the loop below is a no-op. */
export function _computeStandardMaterialFeatures(m: StandardMaterialProps): number {
    let f = 0;
    if (m.diffuseTexture) {
        f |= HAS_DIFFUSE_TEXTURE;
        if (m.diffuseCoordIndex === 1) {
            f |= DIFFUSE_USES_UV2;
        }
    }
    if (!m.backFaceCulling) {
        f |= DOUBLE_SIDED;
    }
    if (m.disableLighting) {
        f |= DISABLE_LIGHTING;
    }
    if (m.alpha < 1) {
        f |= MATERIAL_ALPHA_BLEND;
    }
    for (const ext of _getStdExts().values()) {
        if (ext._detect) {
            f |= ext._detect(m);
        }
    }
    return f;
}

/** @internal Key for Standard shader features, including mesh/pass features. */
export function _standardFeatureKey(features: number, meshFeatures: number, sceneFeatures: number, variant = ""): string {
    return variant ? `${features}:${meshFeatures}:${sceneFeatures}:${variant}` : `${features}:${meshFeatures}:${sceneFeatures}`;
}

/** @internal Key for Standard scene-driven shader variants not encoded in feature bits. */
export function _standardShaderVariantKey(shadowLights: readonly { readonly lightIndex: number; readonly shadowType: "esm" | "pcf" | "csm" }[]): string {
    return shadowLights.length === 0 ? "" : shadowLights.map((sl) => `${sl.lightIndex}${sl.shadowType === "pcf" ? "p" : "e"}`).join(",");
}

/** Fog configuration — plain data. */
export interface FogConfig {
    mode: 0 | 1 | 2 | 3; // 0=off, 1=exp, 2=exp2, 3=linear
    density: number;
    start: number;
    end: number;
    color: [number, number, number];
}

/** @internal Per-scene Standard shader inputs whose presence changes emitted WGSL. */
export interface StandardSceneShaderContext {
    /** @internal */
    readonly _features: number;
    /** @internal */
    readonly _fragments: readonly ShaderFragment[];
}

export { collectStdBoundTextures } from "./collect-std-bound-textures.js";
export { createStandardMaterial } from "./create-standard-material.js";
export { getStandardGroupBuilder } from "./standard-group-builder.js";
