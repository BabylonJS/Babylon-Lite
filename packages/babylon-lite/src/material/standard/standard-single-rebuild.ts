/** Standard single-mesh rebuild — lazy-loaded only when a material swap happens.
 *
 *  Separated from standard-renderable.ts so that scenes which never swap
 *  materials don't pay for this code in their bundle. */

import type { EngineContext } from "../../engine/engine.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { SceneContext, SceneContextInternal } from "../../scene/scene.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshInternal } from "../../mesh/mesh.js";
import type { Renderable } from "../../render/renderable.js";
import { updateSceneUniforms, collectStdBoundTextures } from "./standard-material.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { acquireTexture, releaseTexture } from "../../resource/gpu-pool.js";
import { getViewProjectionMatrix, getViewMatrix, getCameraPosition } from "../../camera/camera.js";
import {
    computeFeatures,
    getOrCreatePipeline,
    createDynamicMeshGPU,
    writeLightsUBO,
    refreshLightsUBO,
    releaseStandardPipelineVariant,
    LIGHTS_UBO_SIZE,
    NEEDS_UV,
    NEEDS_UV2,
    RECEIVE_SHADOWS,
    HAS_OPACITY_TEXTURE,
} from "./standard-pipeline.js";

/** Build a single Renderable for one mesh with a standard material.
 *  Used by the material-swap rebuild path. */
export function buildSingleStandardRenderable(scene: SceneContext, mesh: Mesh): Renderable {
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;
    const mat = mesh.material as StandardMaterialProps;
    const features = computeFeatures(mat, mesh.receiveShadows);
    const variant = getOrCreatePipeline(device, engine.format, engine.msaaSamples, features);

    const allLights = scene.lights;
    let lightMask = 0;
    for (let i = 0; i < allLights.length; i++) {
        const l = allLights[i]!,
            inc = l.includedOnlyMeshIds;
        if (!mesh.id || (inc?.size ? inc.has(mesh.id) : !l.excludedMeshIds?.has(mesh.id))) {
            lightMask |= 1 << i;
        }
    }
    const filteredLights = allLights.filter((_, i) => (lightMask >> i) & 1);
    const lightsBuffer = writeLightsUBO(device, filteredLights);

    const worldMatrix = mesh.worldMatrix;
    const meshShadowGens = mesh.receiveShadows ? scene.lights.filter((l) => l.shadowGenerator).map((l) => l.shadowGenerator!) : [];
    const gpu = createDynamicMeshGPU(device, variant, {
        worldMatrix,
        material: mat,
        lightsBuffer,
        shadowGenerators: meshShadowGens,
    });

    let _lastWorldVersion = mesh.worldMatrixVersion;
    const lightsScratch = new Float32Array(LIGHTS_UBO_SIZE / 4);

    const needsUV = (features & NEEDS_UV) !== 0;
    const needsUV2 = (features & NEEDS_UV2) !== 0;
    const hasShadow = (features & RECEIVE_SHADOWS) !== 0;
    const isTransparent = (features & HAS_OPACITY_TEXTURE) !== 0;

    const boundTextures = collectStdBoundTextures(mat);
    for (const t of boundTextures) {
        acquireTexture(t);
    }
    (scene as SceneContextInternal)._meshDisposables.set(mesh, [
        () => lightsBuffer.destroy(),
        () => {
            for (const t of boundTextures) {
                releaseTexture(t);
            }
        },
        () => releaseStandardPipelineVariant(variant),
    ]);

    if (!(scene as SceneContextInternal)._standardSceneUBO) {
        (scene as SceneContextInternal)._standardSceneUBO = variant.sceneUBO;
        (scene as SceneContextInternal)._uniformUpdaters.push({
            update(engine: EngineContext) {
                if (!scene.camera) {
                    return;
                }
                const aspect = engine.canvas.width / engine.canvas.height;
                const viewProj = getViewProjectionMatrix(scene.camera, aspect);
                const viewMat = getViewMatrix(scene.camera);
                const camPos = getCameraPosition(scene.camera);
                updateSceneUniforms(device, variant.sceneUBO, viewProj as Float32Array, viewMat as Float32Array, [camPos.x, camPos.y, camPos.z], scene.fog ?? undefined);
            },
        });
    }

    return {
        order: mesh.renderOrder ?? (isTransparent ? 200 : 100),
        isTransparent,
        mesh,
        _pipeline: variant.pipeline,
        _sceneBG: variant.sceneBG,
        _lastMaterial: mat,
        updateUBOs() {
            const wm = mesh.worldMatrix;
            if (mesh.worldMatrixVersion !== _lastWorldVersion) {
                device.queue.writeBuffer(gpu.meshUBO, 0, wm as unknown as Float32Array<ArrayBuffer>);
                _lastWorldVersion = mesh.worldMatrixVersion;
            }
            // Refresh light UBO with current light state
            refreshLightsUBO(device, lightsBuffer, filteredLights, lightsScratch);
        },
        draw(pass: GPURenderPassEncoder) {
            if (mesh.material !== mat) {
                return 0;
            }
            const g = (mesh as MeshInternal)._gpu;
            pass.setPipeline(variant.pipeline);
            pass.setBindGroup(0, variant.sceneBG);
            pass.setVertexBuffer(0, g.positionBuffer);
            pass.setVertexBuffer(1, g.normalBuffer);
            if (needsUV) {
                pass.setVertexBuffer(2, g.uvBuffer);
            }
            if (needsUV2 && g.uv2Buffer) {
                pass.setVertexBuffer(3, g.uv2Buffer);
            }
            pass.setIndexBuffer(g.indexBuffer, g.indexFormat);
            pass.setBindGroup(1, gpu.meshBG);
            if (hasShadow && gpu.shadowBG) {
                pass.setBindGroup(2, gpu.shadowBG);
            }
            pass.drawIndexed(g.indexCount);
            return 1;
        },
    } as Renderable;
}
