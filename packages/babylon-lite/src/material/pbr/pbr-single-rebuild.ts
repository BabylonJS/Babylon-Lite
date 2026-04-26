/** PBR single-mesh rebuild — lazy-loaded only when a material swap happens.
 *
 *  Separated from pbr-renderable.ts so that scenes which never swap materials
 *  (the common case) don't pay for this code in their bundle. */

import type { SceneContext, SceneContextInternal } from "../../scene/scene.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshInternal } from "../../mesh/mesh.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { collectPbrBoundTextures } from "./pbr-material.js";
import type { Renderable } from "../../render/renderable.js";
import type { ShadowGenerator } from "../../shadow/shadow-generator.js";

import { acquireTexture, releaseTexture } from "../../resource/gpu-pool.js";
import { getOrCreatePbrPipeline, createPbrMeshBindGroup, releasePbrPipelineVariant, PBR_HAS_NORMAL_MAP, PBR2_HAS_VERTEX_COLOR, PBR2_HAS_UV2 } from "./pbr-pipeline.js";
import { _createPbrMeshUBO, _createPbrMaterialUBO } from "./pbr-renderable.js";
import { computeMeshPbrFeatures } from "./pbr-mesh-features.js";

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
    const hasAlphaBlend = mat.alphaBlend === true || (mat.alpha !== undefined && mat.alpha < 1);
    const hasTonemap = scene.imageProcessing.toneMappingEnabled;
    const hasSomeShadows = scene.lights.some((l) => !!l.shadowGenerator);

    const { features, features2 } = computeMeshPbrFeatures(mesh, scene, { hasEnv, hasTonemap, hasSomeShadows });

    const composed = composePbr!(features, features2);
    const variant = getOrCreatePbrPipeline(engine, engine.format, engine.msaaSamples, features, features2, sceneBGL, composed);
    const worldMatrix = mesh.worldMatrix;
    const meshUBO = _createPbrMeshUBO(engine, worldMatrix, composed, mat);
    const materialUBO = _createPbrMaterialUBO(engine, mat, composed);
    // Pass shared lights UBO if available (multi-light path)
    const lightsUBO = (scene as SceneContextInternal)._pbrLightsUBO;
    const materialBindGroup = createPbrMeshBindGroup(engine, variant, composed, meshUBO, materialUBO, mat, envTextures ?? null, mesh, lightsUBO);

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
            // Pipeline + sceneBG are set by engine.drawList via _pipeline/_sceneBG.
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
            if ((features2 & PBR2_HAS_UV2) !== 0 && gpu.uv2Buffer) {
                pass.setVertexBuffer(slot++, gpu.uv2Buffer);
            }
            if ((features2 & PBR2_HAS_VERTEX_COLOR) !== 0 && gpu.colorBuffer) {
                pass.setVertexBuffer(slot++, gpu.colorBuffer);
            }
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
