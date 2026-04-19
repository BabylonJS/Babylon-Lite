/** PBR Material — user-facing props + factory.
 *
 *  Same role as StandardMaterialProps for the standard pipeline.
 *  Users can create a PbrMaterialProps manually or let loadGltf() build one. */

import type { Texture2D } from "../../texture/texture-2d.js";
import type { MeshGroupBuilder } from "../../render/renderable.js";
import type { SceneContextInternal } from "../../scene/scene.js";
import { _getPbrExts } from "./pbr-flags.js";

/** Lazy-imports the PBR renderable builder and builds the pipeline.
 *  Thin instances are handled by the fragment composer automatically. */
export const pbrGroupBuilder: MeshGroupBuilder & { _loadRebuildSingle?: () => Promise<any> } = async (scene, meshes) => {
    const envTex = (scene as SceneContextInternal)._envTextures;
    const { buildPbrRenderables } = await import("./pbr-renderable.js");
    return buildPbrRenderables(scene, meshes, envTex);
};
// Lazy loader for the single-mesh rebuild function — loaded only when a material swap happens
pbrGroupBuilder._loadRebuildSingle = () => import("./pbr-single-rebuild.js");

export interface PbrMaterialProps {
    baseColorTexture?: Texture2D;
    normalTexture?: Texture2D;
    /** Occlusion-Roughness-Metallic packed: R=occ, G=rough, B=metal. */
    ormTexture?: Texture2D;
    emissiveTexture?: Texture2D;
    /** Emissive color as float uniform (linear RGB). Used when no emissiveTexture.
     *  If both set, emissiveColor multiplies emissiveTexture. */
    emissiveColor?: [number, number, number];
    /** KHR_materials_pbrSpecularGlossiness: RGB=specular, A=glossiness. */
    specGlossTexture?: Texture2D;
    /** Whether material is double-sided (disables back-face culling). */
    doubleSided?: boolean;
    /** Overall material alpha (0=fully transparent, 1=opaque). Default 1.0. */
    alpha?: number;
    /** Enable alpha blending (glTF alphaMode "BLEND"). Enables radianceOverAlpha + specularOverAlpha. */
    alphaBlend?: boolean;
    /** Scale factor for environment/IBL contribution. Default 1.0. */
    environmentIntensity?: number;
    /** Scale factor for direct light contribution. Default 1.0. */
    directIntensity?: number;
    /** Dielectric F0 reflectance (default 0.04, glass ≈ 0.2). */
    reflectance?: number;
    /** glTF metallicFactor multiplier applied over ORM.b metallic channel. Default 1.0. */
    metallicFactor?: number;
    /** glTF roughnessFactor multiplier applied over ORM.g roughness channel. Default 1.0. */
    roughnessFactor?: number;
    /** Strength of ambient occlusion from ORM R channel. Default 1.0; 0.0 ignores R channel. */
    occlusionStrength?: number;
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
    /** When true, the material samples the environment cubemap using the view direction
     *  (camera→fragment) instead of the reflected view direction. Used for PBR skybox boxes
     *  where the mesh surrounds the camera and should display the environment directly.
     *  Also zeroes SH irradiance — skybox is pure cubemap + BRDF only. */
    skyboxMode?: boolean;
    /** Material-wide UV transform (scale + offset), applied in the vertex shader
     *  before emitting `out.uv`. Mirrors BJS `Texture.uScale/vScale/uOffset/vOffset`
     *  when all textures on the material share the same transform (common case).
     *  Format: `[uScale, vScale, uOffset, vOffset]`. Absence = identity.
     *  Set by the glTF loader from `KHR_texture_transform` when every textureInfo
     *  on a material declares the same transform. */
    uvTransformST?: [number, number, number, number];
}

/** @internal Extended PbrMaterialProps with internal build group. */
export interface PbrMaterialPropsInternal extends PbrMaterialProps {
    readonly _buildGroup: MeshGroupBuilder;
    /** Set to true when a UBO-relevant property changes. Cleared by the renderer after upload. */
    _uboDirty?: boolean;
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
export function createPbrMaterial(props?: Partial<PbrMaterialProps>): PbrMaterialProps {
    return {
        ...props,
        _buildGroup: pbrGroupBuilder,
    } as PbrMaterialProps;
}

/** Collect all non-null textures referenced by a PBR material (for acquire/release). */
export function collectPbrBoundTextures(mat: PbrMaterialProps): Texture2D[] {
    const t: Texture2D[] = [];
    if (mat.baseColorTexture) {
        t.push(mat.baseColorTexture);
    }
    if (mat.normalTexture) {
        t.push(mat.normalTexture);
    }
    if (mat.ormTexture) {
        t.push(mat.ormTexture);
    }
    if (mat.emissiveTexture) {
        t.push(mat.emissiveTexture);
    }
    if (mat.specGlossTexture) {
        t.push(mat.specGlossTexture);
    }
    for (const ext of _getPbrExts().values()) {
        ext.textures?.(mat, t);
    }
    return t;
}
