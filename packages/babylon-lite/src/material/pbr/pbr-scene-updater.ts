/** PBR scene-UBO updater factory.
 *
 *  Extracted from pbr-renderable.ts to keep the main file focused on
 *  per-mesh wiring. Produces a `SceneUniformUpdater` that:
 *   - writes view-projection, camera position, light fields, env rotation,
 *     spherical harmonics, exposure/contrast, env LOD scale — but only if
 *     at least one input changed (dirty-tracked per field).
 *   - if a multi-light shadow path is active, refreshes the shared lights UBO.
 */

import type { EngineContext, EngineContextInternal } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { LightBaseInternal, LightBase } from "../../light/types.js";
import type { SceneUniformUpdater } from "../../render/renderable.js";
import type { UboSpec } from "../../shader/fragment-types.js";
import type { PbrLightConfig } from "./pbr-template.js";

import { getViewProjectionMatrix, getCameraPosition } from "../../camera/camera.js";
import { _getPbrLightExtension } from "./pbr-flags.js";

interface PbrSceneUpdaterOptions {
    scene: SceneContext;
    device: GPUDevice;
    envTextures: EnvironmentTextures | undefined;
    sceneUboSpec: UboSpec;
    sceneUniformBuffer: GPUBuffer;
    hasLight: boolean;
    lightConfig: PbrLightConfig | null;
    lightsUBOBuffer?: GPUBuffer;
    lightsUBOScratch?: Float32Array;
    refreshLightsUBO?: (engine: EngineContextInternal, buffer: GPUBuffer, lights: readonly LightBase[], scratch: Float32Array) => void;
}

export function createPbrSceneUpdater(opts: PbrSceneUpdaterOptions): SceneUniformUpdater {
    const { scene, device, envTextures, sceneUboSpec, sceneUniformBuffer, hasLight, lightConfig, lightsUBOBuffer, lightsUBOScratch, refreshLightsUBO } = opts;
    const hasEnv = !!envTextures;

    const envRotYOffset = sceneUboSpec.offsets.get("envRotationY")! / 4;
    const shBaseOffset = hasEnv ? sceneUboSpec.offsets.get("vSphericalL00")! / 4 : 0;
    const exposureOffset = sceneUboSpec.offsets.get("exposureLinear")! / 4;
    const lightFieldName = lightConfig?.sceneUboFields[0]?.name ?? "lightDirection";
    const lightBaseOffset = sceneUboSpec.offsets.get(lightFieldName)! / 4;

    const sceneUniformData = new Float32Array(sceneUboSpec.totalBytes / 4);

    let lastCamVersion = -1;
    let lastAspect = -1;
    let lastLightVersion = -1;
    let lastExposure = -1;
    let lastContrast = -1;
    let lastEnvRotY = -Infinity;
    let lastLightsVersion = -1;

    return {
        update(engine: EngineContext) {
            const cam = scene.camera;
            if (!cam) {
                return;
            }
            const aspect = engine.canvas.width / engine.canvas.height;
            const camVer = cam.worldMatrixVersion;
            let lightVer = 0;
            for (const l of scene.lights) {
                lightVer += (l as LightBaseInternal)._lightVersion ?? 0;
            }
            const exposure = scene.imageProcessing.exposure;
            const contrast = scene.imageProcessing.contrast;
            const envRotY = scene.envRotationY ?? 0;

            if (
                camVer !== lastCamVersion ||
                aspect !== lastAspect ||
                lightVer !== lastLightVersion ||
                exposure !== lastExposure ||
                contrast !== lastContrast ||
                envRotY !== lastEnvRotY
            ) {
                lastCamVersion = camVer;
                lastAspect = aspect;
                lastLightVersion = lightVer;
                lastExposure = exposure;
                lastContrast = contrast;
                lastEnvRotY = envRotY;

                const viewProj = getViewProjectionMatrix(cam, aspect);
                const camPos = getCameraPosition(cam);

                const data = sceneUniformData;
                data.fill(0);
                data.set(viewProj, 0);
                data[16] = camPos.x;
                data[17] = camPos.y;
                data[18] = camPos.z;
                if (hasLight) {
                    const light = scene.lights[0];
                    const ext = _getPbrLightExtension();
                    if (light && ext) {
                        ext.writeSceneUbo(data, lightBaseOffset, light);
                    }
                }
                data[envRotYOffset] = envRotY;
                const sh = envTextures?.sphericalHarmonics;
                if (sh) {
                    data.set(sh, shBaseOffset);
                }
                data[exposureOffset] = exposure;
                data[exposureOffset + 1] = contrast;
                data[exposureOffset + 2] = envTextures?.lodGenerationScale ?? 0.8;
                device.queue.writeBuffer(sceneUniformBuffer, 0, data);
            }
            if (lightsUBOBuffer && lightsUBOScratch && refreshLightsUBO) {
                if (lightVer !== lastLightsVersion) {
                    lastLightsVersion = lightVer;
                    refreshLightsUBO(engine as EngineContextInternal, lightsUBOBuffer, scene.lights, lightsUBOScratch);
                }
            }
        },
    };
}
