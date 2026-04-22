/** PBR scene-wide feature detection.
 *
 *  Single O(N) sweep over meshes that produces the boolean flags used by the
 *  PBR builder to decide which fragment modules to dynamic-import. Kept in its
 *  own file so the detection logic is trivially testable and the orchestrator
 *  in pbr-renderable.ts stays focused on assembly.
 *
 *  Preserves loader-side sentinels (`_hasReflExt`, `_hasUvTx`) set by the glTF
 *  dielectric/UV-transform paths — these do not live on the public material
 *  props interface but are required for correct ext imports. */

import type { Mesh, MeshInternal } from "../../mesh/mesh.js";
import type { PbrMaterialProps } from "./pbr-material.js";

/** Scene-wide feature flags. Each field is true iff *any* mesh/material
 *  in the scene triggers that feature. Drives the dynamic-import ladder. */
export interface PbrSceneFlags {
    hasSkybox: boolean;
    hasMetallicReflectance: boolean;
    hasClearcoat: boolean;
    hasSheen: boolean;
    hasAnyAnisotropy: boolean;
    hasAnySubsurface: boolean;
    hasRefraction: boolean;
    needsEmissiveColor: boolean;
    hasSomeSkeletons: boolean;
    hasSomeMorphs: boolean;
    hasSomeThinInstances: boolean;
    hasAnyUnlit: boolean;
    hasAnyUvTransform: boolean;
    hasAnyUv2: boolean;
    hasAnyVertexColor: boolean;
}

/** Internal sentinels set by the glTF loader on PbrMaterialProps. Not part of
 *  the public material surface; detection reads them to gate ext imports. */
type PbrMatWithSentinels = PbrMaterialProps & { _hasReflExt?: boolean; _hasUvTx?: boolean };

/** Scan meshes once, producing the scene-wide feature flag record. */
export function detectPbrSceneFlags(meshes: readonly Mesh[]): PbrSceneFlags {
    const f: PbrSceneFlags = {
        hasSkybox: false,
        hasMetallicReflectance: false,
        hasClearcoat: false,
        hasSheen: false,
        hasAnyAnisotropy: false,
        hasAnySubsurface: false,
        hasRefraction: false,
        needsEmissiveColor: false,
        hasSomeSkeletons: false,
        hasSomeMorphs: false,
        hasSomeThinInstances: false,
        hasAnyUnlit: false,
        hasAnyUvTransform: false,
        hasAnyUv2: false,
        hasAnyVertexColor: false,
    };
    for (let i = 0; i < meshes.length; i++) {
        const m = meshes[i]!;
        const mat = m.material as PbrMatWithSentinels;
        const mi = m as MeshInternal;
        f.hasSkybox ||= !!mat.skyboxMode;
        f.hasMetallicReflectance ||= !!(mat.metallicReflectanceTexture || mat.reflectanceTexture || mat._hasReflExt);
        f.hasClearcoat ||= !!mat.clearCoat?.isEnabled;
        f.hasSheen ||= !!mat.sheen?.isEnabled;
        f.hasAnyAnisotropy ||= !!mat.anisotropy?.isEnabled;
        f.hasAnySubsurface ||= !!mat.subsurface?.translucency;
        f.hasRefraction ||= (mat.subsurface?.refraction?.intensity ?? 0) > 0;
        f.needsEmissiveColor ||= !!mat.emissiveColor;
        f.hasSomeSkeletons ||= !!m.skeleton;
        f.hasSomeMorphs ||= !!m.morphTargets;
        f.hasSomeThinInstances ||= !!m.thinInstances;
        f.hasAnyUnlit ||= !!mat.unlit;
        f.hasAnyUvTransform ||= !!mat._hasUvTx;
        // UV2 only counts when occlusion samples texcoord 1 (matches pbr-mesh-features.ts).
        f.hasAnyUv2 ||= !!mi._gpu.uv2Buffer && mat.occlusionTexCoord === 1;
        f.hasAnyVertexColor ||= !!mi._gpu.colorBuffer;
    }
    return f;
}
