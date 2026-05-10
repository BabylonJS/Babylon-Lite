/** StandardMaterial — Blinn-Phong material types and scene uniform helpers.
 *
 *  Pipeline creation is handled by standard-pipeline.ts (dynamic permutation system).
 *  This module owns the shared types and the scene UBO update function.
 *
 *  Scene UBO uses the canonical SCENE_UBO layout (shared with PBR).
 */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { Material, MaterialInternal } from "../material.js";

// ─── Shared Types ────────────────────────────────────────────────────

/** StandardMaterial properties — plain data. */
export interface StandardMaterialProps extends Material {
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
    /** Optional opacity texture. Multiplies alpha (.a channel). */
    opacityTexture: Texture2D | null;
    /** Opacity texture intensity. Default 1.0. */
    opacityLevel: number;
    /** When true, derive opacity from RGB luminance instead of .a channel. Default false. */
    opacityFromRGB: boolean;
    /** Alpha test cutoff. Fragments with alpha < alphaCutOff are discarded. Default 0 (no alpha test). */
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

/** @internal Extended StandardMaterialProps with internal build group. */
export interface StandardMaterialPropsInternal extends StandardMaterialProps, MaterialInternal {}

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
