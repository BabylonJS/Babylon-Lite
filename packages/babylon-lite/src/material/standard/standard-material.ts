/** StandardMaterial — Blinn-Phong material types and compatibility exports.
 *
 *  Runtime consumers import feature detection, material creation, and group building
 *  from their concrete modules rather than introducing cycles through this facade.
 */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { CubeTexture } from "../../texture/cube-texture.js";
import type { ShaderFragment } from "../../shader/fragment-types.js";
import type { Material, StencilState } from "../material.js";
import type { MaterialPlugin } from "../plugin/material-plugin.js";

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
    /** @internal True when per-texture UV transforms are enabled. */
    _hasUvTx?: boolean;
    /** @internal Pending lazy registration started by enableMaterialUvTransform. */
    _uvTxExt?: Promise<void>;
    /** Back-face culling. Default true (BJS convention). False = double-sided. */
    backFaceCulling: boolean;
    /** When true, skip all lighting and output emissive * diffuse * baseColor. Default false. */
    disableLighting: boolean;
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
export { _computeStandardMaterialFeatures } from "./standard-material-features.js";
