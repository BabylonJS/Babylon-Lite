import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { DirectionalLight } from "../light/directional-light.js";
import type { ShadowGenerator } from "./shadow-generator.js";
import { acquireTexture } from "../resource/texture-acquire.js";
import { createUniformBuffer } from "../resource/uniform-buffer.js";
import { createShadowParamsUBO } from "./shadow-base.js";

/**
 * @internal Rebuild scene shadow generators on the replacement device while preserving each
 * `ShadowGenerator` identity, so lights and materials that already reference them keep working.
 *
 * Reached only through a lazy import from the Scene recovery rebuild, and only when the scene
 * actually owns a shadow generator, so recovery-enabled scenes without shadows carry none of it.
 */
export async function rebuildSceneShadowGenerators(engine: EngineContext, scene: SceneContext): Promise<void> {
    const generators = new Set<ShadowGenerator>(scene.shadowGenerators);
    for (const light of scene.lights) {
        if (light.shadowGenerator) {
            generators.add(light.shadowGenerator);
        }
    }
    for (const generator of generators) {
        if (generator._shadowType !== "esm" && generator._shadowType !== "csm") {
            throw new Error(`Device-lost Scene recovery does not support shadow generator type "${generator._shadowType}"`);
        }
        generator._shadowTaskState?._task.dispose();
        generator._shadowTaskState = undefined;
        generator._preloadPending = undefined;

        if (generator._shadowType === "csm") {
            // Match the CSM factory's eager resources without replacing its generator-bound hooks.
            const device = engine._device;
            const mapSize = generator._config._mapSize;
            generator._depthTexture = device.createTexture({
                size: { width: mapSize, height: mapSize, depthOrArrayLayers: generator._csmCascadeCount! },
                format: "depth32float",
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | (generator._csmCache ? GPUTextureUsage.COPY_DST : 0),
            });
            generator._depthSampler = device.createSampler({ compare: "less", magFilter: "linear", minFilter: "linear" });
            generator._shadowParamsUBO = createShadowParamsUBO(engine, generator._config._bias, 1 / mapSize);
            generator._shadowUBO = createUniformBuffer(engine, new Float32Array(80));
            const receiverTexture = generator._csmReceiverTexture;
            if (receiverTexture) {
                receiverTexture.texture = generator._depthTexture;
                receiverTexture.view = generator._depthTexture.createView({ dimension: "2d-array" });
                receiverTexture.sampler = generator._depthSampler;
                receiverTexture.width = mapSize;
                receiverTexture.height = mapSize;
                acquireTexture(receiverTexture);
            }
            generator._version++;
            continue;
        }

        // Kept lazy so a CSM-only scene never pulls in the ESM generator.
        const esm = await import("./esm-directional-shadow-generator.js");
        const oldResources = esm.getEsmShadowTaskResources(generator);
        if (!oldResources) {
            throw new Error("Device-lost Scene recovery could not find ESM shadow resources");
        }
        const replacement = esm.createEsmDirectionalShadowGenerator(engine, generator._light as DirectionalLight, {
            mapSize: generator._config._mapSize,
            depthScale: generator._shadowsInfo[2],
            bias: generator._config._bias,
            blurKernel: oldResources._blurKernel,
            blurScale: oldResources._blurScale,
            darkness: generator._shadowsInfo[0],
            frustumEdgeFalloff: generator._shadowsInfo[3],
            orthoMinZ: generator._config._orthoMinZ,
            orthoMaxZ: generator._config._orthoMaxZ,
            forceRefreshEveryFrame: generator._config._forceRefreshEveryFrame,
        });
        const newResources = esm.getEsmShadowTaskResources(replacement);
        if (!newResources) {
            throw new Error("Device-lost Scene recovery failed to create ESM shadow resources");
        }
        generator._depthTexture = replacement._depthTexture;
        generator._depthSampler = replacement._depthSampler;
        generator._lightMatrix = replacement._lightMatrix;
        generator._shadowsInfo = replacement._shadowsInfo;
        generator._depthValues = replacement._depthValues;
        generator._shadowParamsUBO = replacement._shadowParamsUBO;
        generator._shadowUBO = replacement._shadowUBO;
        generator._version++;
        esm.setEsmShadowTaskResources(generator, newResources);
    }
}
