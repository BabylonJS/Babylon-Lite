/** PBR Material — user-facing props + factory.
 *
 *  Same role as StandardMaterialProps for the standard pipeline.
 *  Users can create a PbrMaterialProps manually or let loadGltf() build one.
 *
 *  The material is a discriminated union over the `mode` field:
 *    - omit `mode` (or `"lit"`)  → full PBR shading (default)
 *    - `mode: "unlit"`            → bypass lighting, output baseColor * tint
 *    - `mode: "shadowOnly"`       → invisible except where shadow falls
 *    - `mode: "skybox"`           → render the IBL cubemap using the view direction
 *
 *  Each mode exposes only the properties relevant to it. Cross-cutting flags
 *  (alpha, alphaBlend, doubleSided) are available on all modes via `PbrMaterialPropsCommon`.
 */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { MeshGroupBuilder } from "../../render/renderable.js";
import type { SceneContextInternal } from "../../scene/scene.js";
import type { Material, MaterialInternal } from "../material.js";
import { _getPbrExts } from "./pbr-flags.js";

/** Lazy-imports the PBR renderable builder and builds the pipeline.
 *  Thin instances are handled by the fragment composer automatically. */
export const pbrGroupBuilder: MeshGroupBuilder = async (scene, meshes) => {
    const envTex = (scene as SceneContextInternal)._envTextures;
    const renderableMod = await import("./pbr-renderable.js");
    const result = await renderableMod.buildPbrRenderables(scene, meshes, envTex);
    // Wire the per-mesh rebuild closure used by material swap + per-pass override.
    pbrGroupBuilder._rebuildSingle = result.rebuildSingle;
    return result;
};

/** Cross-cutting flags available on every shading mode. */
export interface PbrMaterialPropsCommon extends Material {
    /** Whether material is double-sided (disables back-face culling). */
    doubleSided?: boolean;
    /** Overall material alpha (0=fully transparent, 1=opaque). Default 1.0. */
    alpha?: number;
    /** Enable alpha blending (glTF alphaMode "BLEND"). Enables radianceOverAlpha + specularOverAlpha. */
    alphaBlend?: boolean;
}

/** Default LIT shading (full PBR). Internal building block — composed into PbrMaterialProps via
 *  `{ mode?: "lit" } & PbrMaterialPropsLit`. */
interface PbrMaterialPropsLit extends PbrMaterialPropsCommon {
    baseColorTexture?: Texture2D;
    normalTexture?: Texture2D;
    /** Normal map scale (glTF normalTexture.scale). Default 1.0. */
    normalTextureScale?: number;
    /** Occlusion-Roughness-Metallic packed: R=occ, G=rough, B=metal. */
    ormTexture?: Texture2D;
    emissiveTexture?: Texture2D;
    /** Emissive color as float uniform (linear RGB). Used when no emissiveTexture.
     *  If both set, emissiveColor multiplies emissiveTexture. */
    emissiveColor?: [number, number, number];
    /** KHR_materials_pbrSpecularGlossiness: RGB=specular, A=glossiness. */
    specGlossTexture?: Texture2D;
    /** Scale factor for environment/IBL contribution. Default 1.0. */
    environmentIntensity?: number;
    /** Scale factor for direct light contribution. Default 1.0. */
    directIntensity?: number;
    /** Whether direct point/spot lights use physical inverse-square falloff.
     *  Default true, matching Babylon.js PBRMaterial. Set false for Standard-style
     *  linear range + spot exponent falloff (`usePhysicalLightFalloff = false`). */
    usePhysicalLightFalloff?: boolean;
    /** Dielectric F0 reflectance (default 0.04, glass ≈ 0.2). */
    reflectance?: number;
    /** glTF metallicFactor multiplier applied over ORM.b metallic channel. Default 1.0. */
    metallicFactor?: number;
    /** glTF roughnessFactor multiplier applied over ORM.g roughness channel. Default 1.0. */
    roughnessFactor?: number;
    /** Strength of ambient occlusion from ORM R channel. Default 1.0; 0.0 ignores R channel. */
    occlusionStrength?: number;
    /** UV set index for the occlusion texture (0 = UV1, 1 = UV2). Default 0. */
    occlusionTexCoord?: number;
    /** Separate occlusion texture sampled with UV2 when occlusionTexCoord=1.
     *  R channel is occlusion. When set, ORM.r is NOT used for occlusion. */
    occlusionTexture?: Texture2D;
    /** Scales dielectric F0 (default 1.0). Maps to BJS metallicF0Factor. */
    metallicF0Factor?: number;
    /** Tints dielectric reflectance (linear RGB, default [1,1,1]). Maps to BJS metallicReflectanceColor. */
    metallicReflectanceColor?: [number, number, number];
    /** Texture whose RGB tints reflectance and A scales F0. Maps to BJS metallicReflectanceTexture. */
    metallicReflectanceTexture?: Texture2D;
    /** Texture whose RGB tints reflectance only. Maps to BJS reflectanceTexture. */
    reflectanceTexture?: Texture2D;
    /** When true + both reflectance textures set, metallicReflectanceTexture only contributes A (F0 scalar). */
    useOnlyMetallicFromMetallicReflectanceTexture?: boolean;
    /** Enable specular anti-aliasing on IBL alphaG (matches BJS SPECULARAA). Default false.
     *  Set automatically by the glTF loader for materials loaded from glTF files. */
    enableSpecularAA?: boolean;
    /** Clearcoat layer configuration. When set with isEnabled=true, adds a glossy transparent
     *  top layer (like car paint or lacquer). Tree-shakable — only bundled when used. */
    clearCoat?: ClearCoatProps;
    /** Sheen layer configuration. When set with isEnabled=true, adds a soft velvet-like
     *  sheen layer (like fabric or cloth). Tree-shakable — only bundled when used. */
    sheen?: SheenProps;
    /** When true, the albedo texture is in sRGB/gamma space (loaded as rgba8unorm)
     *  and the shader applies pow(baseColor, 2.2) for sRGB→linear conversion.
     *  Matches BJS PBRMaterial's Texture.gammaSpace=true behavior.
     *  When false (default), assumes the texture already provides linear values
     *  (e.g. rgba8unorm-srgb format or glTF sRGB textures). */
    gammaAlbedo?: boolean;
    /** Anisotropy layer configuration. When set with isEnabled=true, stretches specular
     *  highlights along a preferred direction. Tree-shakable — only bundled when used. */
    anisotropy?: AnisotropyProps;
    /** Subsurface configuration. Presence of nested sub-features (translucency, scattering)
     *  enables them — no isEnabled booleans needed. Tree-shakable — only bundled when used. */
    subsurface?: SubSurfaceProps;
}

/** UNLIT shading (KHR_materials_unlit). Outputs baseColor * color directly, no lighting. */
interface PbrMaterialPropsUnlit extends PbrMaterialPropsCommon {
    baseColorTexture?: Texture2D;
    /** Linear-RGB tint applied to the baseColor texture (i.e. glTF `baseColorFactor`).
     *  Default `[1, 1, 1]` (no tint). */
    color?: [number, number, number];
    /** When true, the albedo texture is in sRGB/gamma space and the shader applies
     *  pow(baseColor, 2.2) for sRGB→linear conversion. Default false. */
    gammaAlbedo?: boolean;
}

/** SHADOW-ONLY receiver. Surface is invisible except where a shadow falls on it.
 *  Mirrors BJS `BackgroundMaterial.shadowOnly`. Requires `receiveShadows` on the mesh
 *  and at least one shadow-casting light in the scene.
 *
 *  To produce a lighter (less-than-fully-opaque) shadow at the darkest point, set the
 *  inherited `alpha` field — the PBR template multiplies it through to the final output.
 *  Mode-specific knobs (`color`, `falloff`) cover what `alpha` cannot. */
interface PbrMaterialPropsShadowOnly extends PbrMaterialPropsCommon {
    /** Linear-RGB color shown where shadow falls. Default `[0, 0, 0]` (black). */
    color?: [number, number, number];
    /** Falloff sharpness for the shadow's soft edges. Default 1.0 (the natural ESM/PCF
     *  falloff from the shadow generator). Higher values steepen the falloff (saturating
     *  closer to the model silhouette), giving crisper visible edges.
     *  Math: `alpha = saturate((1 - shadowFactor) * falloff)`, then multiplied by the
     *  inherited `alpha` field by the PBR template. */
    falloff?: number;
}

/** SKYBOX mode. Renders the IBL cubemap using the view direction (camera→fragment)
 *  instead of the reflected view direction. Used for boxes that surround the camera
 *  to display the environment directly. Also zeroes SH irradiance — pure cubemap + BRDF. */
interface PbrMaterialPropsSkybox extends PbrMaterialPropsCommon {
    /** Scale factor for environment/IBL contribution. Default 1.0. */
    environmentIntensity?: number;
}

/** Discriminated union over the `mode` field.
 *
 *  - omit `mode` (or `"lit"`)  → full PBR shading (default)
 *  - `mode: "unlit"`            → bypass lighting, output baseColor * color
 *  - `mode: "shadowOnly"`       → invisible except where shadow falls
 *  - `mode: "skybox"`           → render the IBL cubemap using the view direction
 *
 *  Each mode exposes only the properties relevant to it. Cross-cutting flags
 *  (alpha, alphaBlend, doubleSided) are available on every variant. */
export type PbrMaterialProps =
    | ({ mode?: "lit" } & PbrMaterialPropsLit)
    | ({ mode: "unlit" } & PbrMaterialPropsUnlit)
    | ({ mode: "shadowOnly" } & PbrMaterialPropsShadowOnly)
    | ({ mode: "skybox" } & PbrMaterialPropsSkybox);

/** @internal Implementation-side type composed by intersecting every variant's shape, plus the
 *  `mode` discriminator and a few engine-private fields. Pipeline/renderable code uses this so
 *  it can read any variant's fields without narrowing on `mode` for every access. The public
 *  `PbrMaterialProps` discriminated union remains the source of truth for the API surface.
 *
 *  Inherits `_buildGroup` + `_uboDirty` from {@link MaterialInternal} so the renderer can
 *  dispatch group / single-mesh builds polymorphically and skip redundant UBO uploads. */
export interface PbrMaterialPropsInternal extends PbrMaterialPropsLit, PbrMaterialPropsUnlit, PbrMaterialPropsShadowOnly, PbrMaterialPropsSkybox, MaterialInternal {
    mode?: "lit" | "unlit" | "shadowOnly" | "skybox";
    /** @internal True when any of the material's textures carries `_hasTx=true`
     *  (KHR_texture_transform). Stamped once by the glTF loader's slow path
     *  so the renderer doesn't re-scan 5 textures per mesh. */
    _hasUvTx?: boolean;
}

/** Clearcoat layer properties. Maps to BJS PBRMaterial.clearCoat sub-object. */
export interface ClearCoatProps {
    /** Whether clearcoat is active. Default false. */
    isEnabled?: boolean;
    /** Clearcoat layer intensity (0=off, 1=full). Default 1.0. */
    intensity?: number;
    /** Clearcoat layer roughness. Default 0.0 (perfectly smooth). */
    roughness?: number;
    /** Index of refraction of the clearcoat layer. Default 1.5. */
    indexOfRefraction?: number;
    /** Optional clearcoat intensity texture (R channel). Multiplies `intensity`. */
    texture?: Texture2D;
    /** Optional clearcoat roughness texture (G channel). Multiplies `roughness`. */
    roughnessTexture?: Texture2D;
    /** Optional clearcoat normal map (tangent-space). Used to perturb the coat
     *  layer normal independently of the base layer. */
    bumpTexture?: Texture2D;
    /** Clearcoat normal texture scale (glTF normalTexture.scale). Default 1.0. */
    bumpTextureScale?: number;
    /** Whether to remap base F0 across the clearcoat interface (CLEARCOAT_REMAP_F0).
     *  Matches BJS PBRClearCoatConfiguration.remapF0OnInterfaceChange.
     *  Default true. glTF loader sets this to false per KHR_materials_clearcoat. */
    useF0Remap?: boolean;
}

/** Sheen layer properties. Maps to BJS PBRMaterial.sheen sub-object. */
export interface SheenProps {
    /** Whether sheen is active. Default false. */
    isEnabled: boolean;
    /** Sheen color (linear RGB). Default [1, 1, 1]. */
    color?: [number, number, number];
    /** Sheen roughness. Default 0.0. */
    roughness?: number;
    /** Sheen intensity (0=off, 1=full). Default 1.0. */
    intensity?: number;
    /** Optional sheen tint texture (modulates sheen color). Loaded via loadTexture2D(). */
    texture?: Texture2D;
    /** When true (recommended for glTF), applies proper sheen albedo scaling
     *  on the base layer and treats the sheen texture as already-linear (no pow).
     *  When false (default, legacy), applies pow(rgb, 2.2) to the sheen texture
     *  and uses a (1-F0) attenuation on the sheen lobe without base-layer scaling. */
    albedoScaling?: boolean;
}

/** Anisotropy layer properties. Maps to BJS PBRMaterial.anisotropy sub-object.
 *  Stretches specular reflections along the tangent direction. */
export interface AnisotropyProps {
    /** Whether anisotropy is active. Default false. */
    isEnabled: boolean;
    /** Anisotropy strength (0=isotropic, 1=fully anisotropic). Default 1.0. */
    intensity?: number;
    /** Anisotropy direction in tangent space (u, v). Default [1, 0]. */
    direction?: [number, number];
}

/** Translucency sub-feature. Presence enables translucency (no isEnabled boolean). */
export interface TranslucencyProps {
    /** Translucency intensity (0=off, 1=full). Default 1.0. */
    intensity?: number;
    /** Translucency color (linear RGB). Tints the transmitted light. Default [1,1,1]. */
    color?: [number, number, number];
    /** Diffusion distance for the Burley transmittance BRDF. Controls how far
     *  light travels through the material per RGB channel. Default [1,1,1]. */
    diffusionDistance?: [number, number, number];
}

/** Scattering sub-feature. Presence enables screen-space subsurface scattering.
 *  NOTE: PrePass/SSS pipeline is not yet implemented — this type is reserved. */
export interface ScatteringProps {
    /** Per-channel scattering diffusion distance. */
    diffusionDistance?: [number, number, number];
    /** World-space scale factor for the diffusion kernel. Default 1.0. */
    metersPerUnit?: number;
}

/** Thickness sub-feature. Controls how thick the material is at each point. */
export interface ThicknessProps {
    /** Thickness map texture. R channel is sampled by default (matches
     *  existing BJS non-glTF path). Set `useGlTFChannel=true` for G-channel
     *  sampling as specified by KHR_materials_volume. */
    texture?: Texture2D;
    /** When true, sample the thickness texture's G channel (KHR_materials_volume).
     *  Default false — samples R channel (BJS default). Set by the glTF loader. */
    useGlTFChannel?: boolean;
    /** Minimum thickness. Default 0. */
    min?: number;
    /** Maximum thickness. Default 1.0. */
    max?: number;
}

/** Refraction sub-feature (KHR_materials_transmission + _volume + _ior).
 *  Presence enables transmission. Requires an opaque-scene RTT at render time. */
export interface RefractionProps {
    /** Transmission factor (0=off, 1=fully transmissive). Default 0.
     *  Maps to KHR_materials_transmission.transmissionFactor. */
    intensity?: number;
    /** Optional transmission texture (R channel). Multiplies `intensity`. */
    texture?: Texture2D;
    /** Index of refraction (KHR_materials_ior.ior). Default 1.5 (glass). */
    indexOfRefraction?: number;
    /** When true, the thickness value is also used as the refracted
     *  sample offset depth (KHR_materials_volume — matches BJS
     *  `useThicknessAsDepth`). Default true when volume is present. */
    useThicknessAsDepth?: boolean;
}

/** Tint sub-feature. Controls absorption tint color for transmittance. */
export interface TintProps {
    /** Tint color (linear RGB). Default [1,1,1]. */
    color?: [number, number, number];
    /** Distance at which the tint color is reached. Default 1.0. */
    atDistance?: number;
}

/** Subsurface configuration. Nested sub-features — presence = enabled. */
export interface SubSurfaceProps {
    /** Translucency: light passing through thin surfaces. */
    translucency?: TranslucencyProps;
    /** Scattering: screen-space subsurface scattering (PrePass). Reserved — not yet implemented. */
    scattering?: ScatteringProps;
    /** Thickness: per-texel thickness for transmittance. */
    thickness?: ThicknessProps;
    /** Tint: absorption tint color for transmittance. */
    tint?: TintProps;
    /** Refraction: physical light transmission through the surface
     *  (KHR_materials_transmission + _volume + _ior). Presence enables it.
     *  Requires the engine to produce an opaque-scene render target. */
    refraction?: RefractionProps;
}

/** Create a PbrMaterialProps with optional overrides. */
export function createPbrMaterial(props?: PbrMaterialProps): PbrMaterialProps {
    return {
        ...(props as object),
        _buildGroup: pbrGroupBuilder,
    } as unknown as PbrMaterialProps;
}

/** Collect all non-null textures referenced by a PBR material (for acquire/release). */
export function collectPbrBoundTextures(mat: PbrMaterialProps): Texture2D[] {
    const t: Texture2D[] = [];
    const m = mat as PbrMaterialPropsInternal;
    if (m.baseColorTexture) {
        t.push(m.baseColorTexture);
    }
    if (m.normalTexture) {
        t.push(m.normalTexture);
    }
    if (m.ormTexture) {
        t.push(m.ormTexture);
    }
    if (m.occlusionTexture) {
        t.push(m.occlusionTexture);
    }
    if (m.emissiveTexture) {
        t.push(m.emissiveTexture);
    }
    if (m.specGlossTexture) {
        t.push(m.specGlossTexture);
    }
    for (const ext of _getPbrExts().values()) {
        ext.textures?.(mat, t);
    }
    return t;
}
