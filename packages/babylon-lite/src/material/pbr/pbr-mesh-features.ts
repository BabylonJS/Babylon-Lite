/** Per-mesh PBR feature-flag computation.
 *
 *  Pure function shared by pbr-renderable (initial build) and
 *  pbr-single-rebuild (material swap) so the feature detection logic
 *  lives in exactly one place.
 */

import type { Mesh } from "../../mesh/mesh.js";
import type { SceneContext } from "../../scene/scene.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import {
    computePbrFeatures,
    PBR_HAS_SKELETON_8,
    PBR_HAS_SPECULAR_AA,
    PBR_HAS_RECEIVE_SHADOWS,
    PBR_HAS_GAMMA_ALBEDO,
    PBR_HAS_THIN_INSTANCES,
    PBR_HAS_INSTANCE_COLOR,
} from "./pbr-pipeline.js";
import { getLightTypeFeatureBits, _getPbrExts, PBR_HAS_OCCLUSION, PBR_HAS_ANISOTROPY, PBR_HAS_SKYBOX, PBR2_HAS_UV_TRANSFORM, PBR2_HAS_VERTEX_COLOR, PBR2_HAS_UV2 } from "./pbr-flags.js";
import type { Texture2D } from "../../texture/texture-2d.js";

function hasTx(t: Texture2D | null | undefined): boolean {
    if (!t) {
        return false;
    }
    return (
        (t.uScale !== undefined && t.uScale !== 1) ||
        (t.vScale !== undefined && t.vScale !== 1) ||
        (t.uOffset !== undefined && t.uOffset !== 0) ||
        (t.vOffset !== undefined && t.vOffset !== 0) ||
        (t.uAng !== undefined && t.uAng !== 0)
    );
}

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

    let features = computePbrFeatures(
        hasTangents,
        !!mat.emissiveTexture,
        ctx.hasEnv,
        hasSkeleton,
        ctx.hasTonemap,
        hasMorphTargets,
        hasAlphaBlend,
        !!mat.specGlossTexture,
        !!mat.doubleSided,
        !!mat.normalTexture,
        false,
        false,
        !!mat.emissiveColor
    );
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
    // UV-transform flag: set when any bound texture carries a non-identity
    // transform. Enables per-texture UV-transform UBO fields in the shader.
    // Checked across all core-PBR base textures; extension fragments
    // (sheen/clearcoat/reflectance texture samples) still use input.uv and
    // will be migrated in a follow-up pass (documented TODO).
    if (
        hasTx(mat.baseColorTexture) ||
        hasTx(mat.normalTexture) ||
        hasTx(mat.ormTexture) ||
        hasTx(mat.emissiveTexture) ||
        hasTx(mat.specGlossTexture)
    ) {
        features2 |= PBR2_HAS_UV_TRANSFORM;
    }
    // `scene` arg kept for future light-extension hooks.
    void scene;
    return { features, features2 };
}
