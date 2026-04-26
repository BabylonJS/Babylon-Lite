/** Per-mesh PBR feature-flag computation.
 *
 *  Pure function shared by pbr-renderable (initial build) and
 *  pbr-single-rebuild (material swap) so the feature detection logic
 *  lives in exactly one place.
 */

import type { Mesh } from "../../mesh/mesh.js";
import type { SceneContext } from "../../scene/scene.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { PBR_HAS_SKELETON_8, PBR_HAS_SPECULAR_AA, PBR_HAS_RECEIVE_SHADOWS, PBR_HAS_GAMMA_ALBEDO, PBR_HAS_THIN_INSTANCES, PBR_HAS_INSTANCE_COLOR } from "./pbr-pipeline.js";
import {
    getLightTypeFeatureBits,
    _getPbrExts,
    PBR_HAS_NORMAL_MAP,
    PBR_HAS_COTANGENT_NORMAL,
    PBR_HAS_EMISSIVE,
    PBR_HAS_EMISSIVE_COLOR,
    PBR_HAS_ENV,
    PBR_HAS_SKELETON,
    PBR_HAS_TONEMAP,
    PBR_HAS_MORPH_TARGETS,
    PBR_HAS_ALPHA_BLEND,
    PBR_HAS_SPEC_GLOSS,
    PBR_HAS_DOUBLE_SIDED,
    PBR_HAS_OCCLUSION,
    PBR_HAS_ANISOTROPY,
    PBR_HAS_SKYBOX,
    PBR2_HAS_UV_TRANSFORM,
    PBR2_HAS_VERTEX_COLOR,
    PBR2_HAS_UV2,
} from "./pbr-flags.js";

/** Scene-level context cached once by the caller (all constant across meshes). */
export interface PbrFeatureCtx {
    hasEnv: boolean;
    hasTonemap: boolean;
    hasSomeShadows: boolean;
}

/** Compute the `(features, features2)` bit pair for a single PBR mesh. */
export function computeMeshPbrFeatures(mesh: Mesh, scene: SceneContext, ctx: PbrFeatureCtx): { features: number; features2: number } {
    const mat = mesh.material as PbrMaterialProps;
    const mi = mesh as import("../../mesh/mesh.js").MeshInternal;
    const hasTangents = !!mi._gpu.tangentBuffer;
    const hasSkeleton = !!mesh.skeleton;
    const hasMorphTargets = !!mesh.morphTargets;
    const hasAlphaBlend = mat.alphaBlend === true || (mat.alpha !== undefined && mat.alpha < 1);
    const hasNormalTex = !!mat.normalTexture;

    // Inlined bitmask build (previously computePbrFeatures with 13 positional args,
    // metallic/reflectance map bits are contributed by reflectance ext's detect()).
    let features =
        (hasNormalTex ? (hasTangents ? PBR_HAS_NORMAL_MAP : PBR_HAS_COTANGENT_NORMAL) : 0) |
        (mat.emissiveTexture ? PBR_HAS_EMISSIVE : 0) |
        (mat.emissiveColor ? PBR_HAS_EMISSIVE_COLOR : 0) |
        (ctx.hasEnv ? PBR_HAS_ENV : 0) |
        (hasSkeleton ? PBR_HAS_SKELETON : 0) |
        (ctx.hasTonemap ? PBR_HAS_TONEMAP : 0) |
        (hasMorphTargets ? PBR_HAS_MORPH_TARGETS : 0) |
        (hasAlphaBlend ? PBR_HAS_ALPHA_BLEND : 0) |
        (mat.specGlossTexture ? PBR_HAS_SPEC_GLOSS : 0) |
        (mat.doubleSided ? PBR_HAS_DOUBLE_SIDED : 0);
    features |= getLightTypeFeatureBits();
    if ((mat.occlusionStrength ?? 1.0) > 0) {
        features |= PBR_HAS_OCCLUSION;
    }
    if (hasSkeleton && mesh.skeleton?.joints1Buffer) {
        features |= PBR_HAS_SKELETON_8;
    }
    if (mat.enableSpecularAA) {
        features |= PBR_HAS_SPECULAR_AA;
    }

    let features2 = 0;

    if (mesh.receiveShadows && ctx.hasSomeShadows) {
        features |= PBR_HAS_RECEIVE_SHADOWS;
    }
    if (mat.gammaAlbedo) {
        features |= PBR_HAS_GAMMA_ALBEDO;
    }
    if (mat.anisotropy?.isEnabled) {
        features |= PBR_HAS_ANISOTROPY;
    }
    if (mat.skyboxMode) {
        features |= PBR_HAS_SKYBOX;
    }
    // Unified PBR extensions contribute their own feature bits.
    for (const ext of _getPbrExts().values()) {
        if (ext.detect) {
            const d = ext.detect(mat);
            features |= d.f;
            features2 |= d.f2;
        }
    }
    if (mesh.thinInstances) {
        features |= PBR_HAS_THIN_INSTANCES;
        if (mesh.thinInstances.colors) {
            features |= PBR_HAS_INSTANCE_COLOR;
        }
    }
    if (mi._gpu.colorBuffer) {
        features2 |= PBR2_HAS_VERTEX_COLOR;
    }
    if (mi._gpu.uv2Buffer && mat.occlusionTexCoord === 1) {
        features2 |= PBR2_HAS_UV2;
    }
    // UV-transform flag: pre-computed by the loader's slow-path assembly,
    // so the renderer never scans 5 textures per mesh here.
    if ((mat as { _hasUvTx?: boolean })._hasUvTx) {
        features2 |= PBR2_HAS_UV_TRANSFORM;
    }
    // `scene` arg kept for future light-extension hooks.
    void scene;
    return { features, features2 };
}
