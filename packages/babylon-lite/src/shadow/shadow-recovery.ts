import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { DirectionalLight } from "../light/directional-light.js";
import type { ShadowGenerator } from "./shadow-generator.js";

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
        if (generator._shadowType !== "esm") {
            throw new Error(`Device-lost Scene recovery does not support shadow generator type "${generator._shadowType}"`);
        }
        generator._shadowTaskState?._task.dispose();
        generator._shadowTaskState = undefined;
        generator._preloadPending = undefined;

        // Kept lazy so a CSM-only scene (which throws above) never pulls in the ESM generator.
        const esm = await import("./esm-directional-shadow-generator.js");
        const oldResources = esm._getEsmShadowTaskResources(generator);
        if (!oldResources) {
            throw new Error("Device-lost Scene recovery could not find ESM shadow resources");
        }
        const replacement = esm.createEsmDirectionalShadowGenerator(engine, generator._light as DirectionalLight, {
            mapSize: generator._config._mapSize,
            depthScale: generator._shadowsInfo[2],
            bias: generator._config._bias,
            blurKernel: oldResources._blurKernel,
            blurScale: generator._config._mapSize / oldResources._blurTexH.width,
            darkness: generator._shadowsInfo[0],
            frustumEdgeFalloff: generator._shadowsInfo[3],
            orthoMinZ: generator._config._orthoMinZ,
            orthoMaxZ: generator._config._orthoMaxZ,
            forceRefreshEveryFrame: generator._config._forceRefreshEveryFrame,
        });
        const newResources = esm._getEsmShadowTaskResources(replacement);
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
        esm._setEsmShadowTaskResources(generator, newResources);
    }
}
