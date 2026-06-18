/** StandardMaterial — Blinn-Phong material types and scene uniform helpers.
 *
 *  Pipeline creation is handled by standard-pipeline.ts (dynamic permutation system).
 *  This module owns the shared types and the scene UBO update function.
 *
 *  Scene UBO uses the canonical SCENE_UBO layout (shared with PBR).
 */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { Material } from "../material.js";
import type { MaterialPlugin } from "../plugin/material-plugin.js";
import {
    AMBIENT_USES_UV2,
    DIFFUSE_USES_UV2,
    DISABLE_LIGHTING,
    DOUBLE_SIDED,
    HAS_AMBIENT_TEXTURE,
    HAS_BUMP_TEXTURE,
    HAS_CUBE_REFLECTION,
    HAS_DEPTH_EMISSIVE_TEXTURE,
    HAS_DIFFUSE_TEXTURE,
    HAS_EMISSIVE_TEXTURE,
    HAS_LIGHTMAP_TEXTURE,
    HAS_OPACITY_TEXTURE,
    HAS_REFLECTION_TEXTURE,
    HAS_SPECULAR_TEXTURE,
    LIGHTMAP_USES_UV2,
    LIGHTMAP_SHADOWMAP,
    LIGHTMAP_FLIP_V,
    MATERIAL_ALPHA_BLEND,
    OPACITY_FROM_RGB,
    SPECULAR_USES_UV2,
} from "./standard-flags.js";

// ─── Shared Types ────────────────────────────────────────────────────

/** StandardMaterial properties — plain data. */
export interface StandardMaterialProps extends Material {
    /** Optional opt-in material plugins (custom WGSL + uniforms + samplers layered
     *  on top of the built-in Standard pipeline). Attach via `material.plugins = [plugin]`,
     *  then call `enableMaterialPlugins(scene)` before `registerScene`. */
    plugins?: MaterialPlugin[];
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
    /** Optional emissive texture. Null = solid emissive color only. */
    emissiveTexture: Texture2D | null;
    /** Optional bump/normal-map texture. Uses cotangent-frame (no tangent attribute needed). */
    bumpTexture: Texture2D | null;
    /** Bump perturbation strength. Default 1.0 (maps to 1/level in BJS). */
    bumpLevel: number;
    /** Optional specular texture. Replaces specularColor; alpha modulates glossiness. */
    specularTexture: Texture2D | null;
    /** Specular texture UV channel. 0=UV1, 1=UV2. Default 0. */
    specularCoordIndex: 0 | 1;
    /** Optional ambient/occlusion texture. Multiplies final diffuse contribution. */
    ambientTexture: Texture2D | null;
    /** Ambient texture intensity. Default 1.0. */
    ambientTexLevel: number;
    /** Ambient texture UV channel. 0=UV1, 1=UV2. Default 0. */
    ambientCoordIndex: 0 | 1;
    /** Optional lightmap texture. Added to final color (additive mode). */
    lightmapTexture: Texture2D | null;
    /** Lightmap intensity. Default 1.0. */
    lightmapLevel: number;
    /** Lightmap UV channel. 0=UV1, 1=UV2. Default 1 (BJS convention). */
    lightmapCoordIndex: 0 | 1;
    /** When true, the lightmap is a baked shadowmap that multiplies the final color
     *  (`color *= lightmap * level`) instead of being added. Matches BJS
     *  StandardMaterial.useLightmapAsShadowmap. Default false. */
    useLightmapAsShadowmap: boolean;
    /** Optional opacity texture. Multiplies alpha (.a channel). */
    opacityTexture: Texture2D | null;
    /** Opacity texture intensity. Default 1.0. */
    opacityLevel: number;
    /** When true, derive opacity from RGB luminance instead of .a channel. Default false. */
    opacityFromRGB: boolean;
    /** Alpha test cutoff. Fragments with `alpha < alphaCutOff` are discarded. Default 0 (no alpha test). */
    alphaCutOff: number;
    /** Optional reflection texture (2D spherical map). Null = no reflection. */
    reflectionTexture: Texture2D | null;
    /** Optional cube reflection texture. Null = no cube reflection. */
    reflectionCubeTexture: { texture: GPUTexture; view: GPUTextureView; sampler: GPUSampler } | null;
    /** Reflection intensity. Default 1.0. */
    reflectionLevel: number;
    /** Reflection coordinate mode. 1=spherical, 2=planar. Default 1. */
    reflectionCoordMode: 1 | 2;
    /** UV tiling scale. Default [1, 1]. */
    uvScale: [number, number];
    /** Back-face culling. Default true (BJS convention). False = double-sided. */
    backFaceCulling: boolean;
    /** When true, skip all lighting and output emissive * diffuse * baseColor. Default false. */
    disableLighting: boolean;
}

/** @internal Compute Standard material-only feature bits. Mesh/pass bits are added by the renderable. */
export function _computeStandardMaterialFeatures(m: StandardMaterialProps): number {
    let f = 0;
    if (m.diffuseTexture) {
        f |= HAS_DIFFUSE_TEXTURE;
        if (m.diffuseCoordIndex === 1) {
            f |= DIFFUSE_USES_UV2;
        }
    }
    if (m.emissiveTexture) {
        f |= HAS_EMISSIVE_TEXTURE;
        if (m.emissiveTexture._sampleType === "depth") {
            f |= HAS_DEPTH_EMISSIVE_TEXTURE;
        }
    }
    if (m.bumpTexture) {
        f |= HAS_BUMP_TEXTURE;
    }
    if (m.specularTexture) {
        f |= HAS_SPECULAR_TEXTURE;
        if (m.specularCoordIndex === 1) {
            f |= SPECULAR_USES_UV2;
        }
    }
    if (m.ambientTexture) {
        f |= HAS_AMBIENT_TEXTURE;
        if (m.ambientCoordIndex === 1) {
            f |= AMBIENT_USES_UV2;
        }
    }
    if (m.lightmapTexture) {
        f |= HAS_LIGHTMAP_TEXTURE;
        if (m.lightmapCoordIndex === 1) {
            f |= LIGHTMAP_USES_UV2;
        }
        if (m.useLightmapAsShadowmap) {
            f |= LIGHTMAP_SHADOWMAP;
        }
        if (m.lightmapTexture.uAng === Math.PI) {
            f |= LIGHTMAP_FLIP_V;
        }
    }
    if (m.opacityTexture) {
        f |= HAS_OPACITY_TEXTURE;
        if (m.opacityFromRGB) {
            f |= OPACITY_FROM_RGB;
        }
    }
    if (!m.backFaceCulling) {
        f |= DOUBLE_SIDED;
    }
    if (m.reflectionTexture) {
        f |= HAS_REFLECTION_TEXTURE;
    }
    if (m.reflectionCubeTexture) {
        f |= HAS_CUBE_REFLECTION;
    }
    if (m.disableLighting) {
        f |= DISABLE_LIGHTING;
    }
    if (m.alpha < 1) {
        f |= MATERIAL_ALPHA_BLEND;
    }
    return f;
}

/** @internal Key for Standard shader features, including mesh/pass features. */
export function _standardFeatureKey(features: number, meshFeatures: number, variant = ""): string {
    return variant ? `${features}:${meshFeatures}:${variant}` : `${features}:${meshFeatures}`;
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

export { collectStdBoundTextures } from "./collect-std-bound-textures.js";
export { createStandardMaterial } from "./create-standard-material.js";
export { standardGroupBuilder } from "./standard-group-builder.js";
