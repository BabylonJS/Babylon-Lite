/** PBR single-mesh rebuild — lazy-loaded only when a material swap happens.
 *
 *  Separated from pbr-renderable.ts so that scenes which never swap materials
 *  (the common case) don't pay for this code in their bundle. */

import type { SceneContext, SceneContextInternal } from "../../scene/scene.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshInternal } from "../../mesh/mesh.js";
import type { PbrMaterialProps, SheenProps } from "./pbr-material.js";
import { collectPbrBoundTextures } from "./pbr-material.js";
import type { Renderable } from "../../render/renderable.js";
import type { ShadowGenerator } from "../../shadow/shadow-generator.js";

import { acquireTexture, releaseTexture } from "../../resource/gpu-pool.js";
import {
    computePbrFeatures,
    getOrCreatePbrPipeline,
    createPbrMeshBindGroup,
    releasePbrPipelineVariant,
    PBR_HAS_NORMAL_MAP,
    PBR_HAS_SKELETON_8,
    PBR_HAS_SPECULAR_AA,
    PBR_HAS_SHEEN_TEXTURE,
    PBR_HAS_RECEIVE_SHADOWS,
    PBR_HAS_GAMMA_ALBEDO,
} from "./pbr-pipeline.js";
import {
    getLightTypeFeatureBits,
    PBR_HAS_OCCLUSION,
    PBR_HAS_CLEARCOAT,
    PBR_HAS_SHEEN,
    PBR_HAS_USE_ALPHA_ONLY_MR,
    PBR2_CC_INT_MAP,
    PBR2_CC_ROUGH_MAP,
    PBR2_CC_NORMAL_MAP,
    PBR2_CC_F0_REMAP_OFF,
    _getSubsurfaceExt,
} from "./pbr-flags.js";
import { _createPbrMeshUBO, _createPbrMaterialUBO } from "./pbr-renderable.js";

/** Build a single Renderable for one mesh after a PBR material swap.
 *  Reuses the existing scene bind group and extensions from the initial build. */
export function buildSinglePbrRenderable(scene: SceneContext, mesh: Mesh): Renderable {
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;
    const mat = mesh.material as PbrMaterialProps;
    const envTextures = (scene as SceneContextInternal)._envTextures;
    const sceneBGL = (scene as SceneContextInternal)._pbrSceneBGL!;
    const sceneBindGroup = (scene as SceneContextInternal)._pbrSceneBG!;
    const composePbr = (scene as SceneContextInternal)._composePbr;

    const hasEnv = !!envTextures;
    const mi = mesh as MeshInternal;
    const hasTangents = !!mi._gpu.tangentBuffer;
    const hasSkeleton = !!mesh.skeleton;
    const hasMorphTargets = !!mesh.morphTargets;
    const hasAlphaBlend = mat.alphaBlend === true || (mat.alpha !== undefined && mat.alpha < 1);
    const hasTonemap = scene.imageProcessing.toneMappingEnabled;

    let features = computePbrFeatures(
        hasTangents,
        !!mat.emissiveTexture,
        hasEnv,
        hasSkeleton,
        hasTonemap,
        hasMorphTargets,
        hasAlphaBlend,
        !!mat.specGlossTexture,
        !!mat.doubleSided,
        !!mat.normalTexture,
        !!mat.metallicReflectanceTexture,
        !!mat.reflectanceTexture,
        !!mat.emissiveColor
    );
    if (mat.useOnlyMetallicFromMetallicReflectanceTexture) {
        features |= PBR_HAS_USE_ALPHA_ONLY_MR;
    }
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
    if ((mat.clearCoat as { isEnabled?: boolean } | undefined)?.isEnabled) {
        features |= PBR_HAS_CLEARCOAT;
    }
    let features2 = 0;
    const ccProps = mat.clearCoat as import("./pbr-material.js").ClearCoatProps | undefined;
    if (ccProps?.isEnabled) {
        if (ccProps.texture) {
            features2 |= PBR2_CC_INT_MAP;
        }
        if (ccProps.roughnessTexture) {
            features2 |= PBR2_CC_ROUGH_MAP;
        }
        if (ccProps.bumpTexture) {
            features2 |= PBR2_CC_NORMAL_MAP;
        }
        if (ccProps.useF0Remap === false) {
            features2 |= PBR2_CC_F0_REMAP_OFF;
        }
    }
    if ((mat.sheen as SheenProps | undefined)?.isEnabled) {
        features |= PBR_HAS_SHEEN;
    }
    if ((mat.sheen as SheenProps | undefined)?.isEnabled && (mat.sheen as SheenProps | undefined)?.texture) {
        features |= PBR_HAS_SHEEN_TEXTURE;
    }
    if (mesh.receiveShadows && scene.lights.some((l) => l.shadowGenerator)) {
        features |= PBR_HAS_RECEIVE_SHADOWS;
    }
    if (mat.gammaAlbedo) {
        features |= PBR_HAS_GAMMA_ALBEDO;
    }
    const ssE = _getSubsurfaceExt();
    if (ssE) {
        features |= ssE.detect(mat);
    }

    const composed = composePbr!(features, features2);
    const variant = getOrCreatePbrPipeline(engine, engine.format, engine.msaaSamples, features, features2, sceneBGL, composed);
    const worldMatrix = mesh.worldMatrix;
    const meshUBO = _createPbrMeshUBO(engine, worldMatrix, composed);
    const materialUBO = _createPbrMaterialUBO(engine, mat, composed);
    const boneView = mesh.skeleton?.boneTexture.createView();
    const morphView = mesh.morphTargets?.texture.createView();
    // Pass shared lights UBO if available (multi-light path)
    const lightsUBO = (scene as SceneContextInternal)._pbrLightsUBO;
    const materialBindGroup = createPbrMeshBindGroup(
        engine,
        variant,
        meshUBO,
        materialUBO,
        mat,
        envTextures ?? null,
        boneView,
        morphView,
        mesh.morphTargets?.weightsBuffer,
        lightsUBO
    );

    // Shadow bind group (group 2) — multi-shadow support
    const shadowLights: { gen: ShadowGenerator }[] = [];
    if (mesh.receiveShadows && variant.shadowBGL) {
        for (const l of scene.lights) {
            if (l.shadowGenerator) {
                shadowLights.push({ gen: l.shadowGenerator });
            }
        }
    }
    let shadowBindGroup: GPUBindGroup | null = null;
    const shadowGens: ShadowGenerator[] = [];
    if (shadowLights.length > 0 && variant.shadowBGL) {
        const entries: GPUBindGroupEntry[] = [];
        let b = 0;
        for (const sl of shadowLights) {
            const sg = sl.gen;
            entries.push({ binding: b++, resource: sg.blurredTexture.createView() });
            entries.push({ binding: b++, resource: sg.blurredSampler });
            shadowGens.push(sg);
            entries.push({ binding: b++, resource: { buffer: sg.shadowUBO } });
        }
        shadowBindGroup = device.createBindGroup({ layout: variant.shadowBGL, entries });
    }

    let _lastWorldVersion = mesh.worldMatrixVersion;

    const gpu = mi._gpu;
    const isTransparent = hasAlphaBlend;

    const boundTextures = collectPbrBoundTextures(mat);
    for (const t of boundTextures) {
        acquireTexture(t);
    }
    const disposables = [
        () => {
            meshUBO.destroy();
            materialUBO.destroy();
        },
        () => {
            for (const t of boundTextures) {
                releaseTexture(t);
            }
        },
        () => releasePbrPipelineVariant(variant),
    ];
    (scene as SceneContextInternal)._meshDisposables.set(mesh, disposables);

    return {
        order: mesh.renderOrder ?? (isTransparent ? 150 : 100),
        isTransparent,
        mesh,
        _pipeline: variant.pipeline,
        _sceneBG: sceneBindGroup,
        updateUBOs() {
            if (mesh.worldMatrixVersion !== _lastWorldVersion) {
                device.queue.writeBuffer(meshUBO, 0, mesh.worldMatrix as unknown as Float32Array<ArrayBuffer>);
                _lastWorldVersion = mesh.worldMatrixVersion;
            }
        },
        draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder) {
            if (mesh.material !== mat) {
                return 0;
            }
            pass.setPipeline(variant.pipeline);
            pass.setBindGroup(0, sceneBindGroup);
            pass.setBindGroup(1, materialBindGroup);
            if (shadowBindGroup) {
                pass.setBindGroup(2, shadowBindGroup);
            }
            let slot = 0;
            pass.setVertexBuffer(slot++, gpu.positionBuffer);
            pass.setVertexBuffer(slot++, gpu.normalBuffer);
            if (features & PBR_HAS_NORMAL_MAP && gpu.tangentBuffer) {
                pass.setVertexBuffer(slot++, gpu.tangentBuffer);
            }
            pass.setVertexBuffer(slot++, gpu.uvBuffer);
            if (mesh.skeleton) {
                pass.setVertexBuffer(slot++, mesh.skeleton.jointsBuffer);
                pass.setVertexBuffer(slot++, mesh.skeleton.weightsBuffer);
                if (mesh.skeleton.joints1Buffer && mesh.skeleton.weights1Buffer) {
                    pass.setVertexBuffer(slot++, mesh.skeleton.joints1Buffer);
                    pass.setVertexBuffer(slot++, mesh.skeleton.weights1Buffer);
                }
            }

            pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
            pass.drawIndexed(gpu.indexCount);
            return 1;
        },
    } as Renderable;
}
