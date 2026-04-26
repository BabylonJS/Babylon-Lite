/**
 * HDR Environment Loader
 *
 * Loads a Radiance .hdr (RGBE) equirectangular panorama and produces
 * GPU-ready IBL textures identical to BJS HDRCubeTexture.
 *
 * Pipeline:
 *   1. Parse RGBE header + RLE scanlines → Float32 equirect (CPU)
 *   2. Compute spherical harmonics from equirect (CPU)
 *   3. Equirect → cubemap via compute shader (GPU)
 *   4. Prefilter cubemap with importance-sampled GGX (GPU compute)
 *   5. Generate BRDF split-sum LUT (GPU compute)
 *   6. Return EnvironmentTextures (same interface as load-env.ts)
 */

import type { EnvironmentTextures } from "../loader-env/load-env.js";
import type { SceneContext, SceneContextInternal } from "../scene/scene.js";
import type { EngineContextInternal } from "../engine/engine.js";
import { acquireGPUTexture, releaseGPUTexture } from "../resource/gpu-pool.js";
import { assembleEnvironmentTextures } from "../loader-env/env-helpers.js";
import { parseRGBE, computeSHFromEquirect } from "./hdr-parser.js";
import { equirectToCubemapGPU, prefilterCubemapGPU, generateBrdfLut } from "./hdr-ibl-pipeline.js";
import { mipLevelCount } from "../texture/mip-count.js";

// ─── Public API ─────────────────────────────────────────────────────────────

export interface HdrLoadOptions {
    /** Cubemap face size in pixels. Default 256. */
    faceSize?: number;
    /** When true, render the HDR cubemap as the skybox background. */
    useCubemapSkybox?: boolean;
    /** When true, skip the ground plane. */
    skipGround?: boolean;
    /** Skybox size matching BJS createDefaultEnvironment skyboxSize option. */
    skyboxSize?: number;
}

export async function loadHdrEnvironment(scene: SceneContext, url: string, options?: HdrLoadOptions): Promise<EnvironmentTextures> {
    const engine = scene.engine as EngineContextInternal;
    const faceSize = options?.faceSize ?? 256;

    // 1. Fetch and parse RGBE
    const buffer = await fetch(url).then((r) => r.arrayBuffer());
    const hdr = parseRGBE(buffer);

    // 2. Compute spherical harmonics from equirect (CPU)
    const irradianceSH = computeSHFromEquirect(hdr.data, hdr.width, hdr.height);

    // 3. Equirect → cubemap (GPU compute)
    const srcCube = equirectToCubemapGPU(engine, hdr, faceSize);

    // 4. Prefilter cubemap for IBL (GPU compute, importance-sampled GGX)
    const mipCount = mipLevelCount(faceSize, faceSize);
    const specularCube = prefilterCubemapGPU(engine, srcCube, faceSize, mipCount);

    // 5. BRDF LUT
    const brdfLut = generateBrdfLut(engine);

    // 6. Assemble
    const textures = assembleEnvironmentTextures(specularCube, brdfLut, irradianceSH, 1.0, engine);

    (scene as SceneContextInternal)._envTextures = textures;
    (scene as SceneContextInternal)._irradianceSH = irradianceSH;

    acquireGPUTexture(specularCube);
    acquireGPUTexture(brdfLut);
    const s = scene as SceneContextInternal;
    s._disposables.push(() => {
        releaseGPUTexture(specularCube);
        releaseGPUTexture(brdfLut);
    });

    scene.imageProcessing.toneMappingEnabled = false;
    scene.imageProcessing.exposure = 0.8;
    scene.imageProcessing.contrast = 1.2;

    // Register deferred builder for background renderables (skybox + ground)
    // Re-registers itself if PBR scene BGL isn't ready yet (created by mesh builder)
    const useHdr = !!options?.useCubemapSkybox;
    const skipGround = !!options?.skipGround;
    const bgBuilder = async (): Promise<void> => {
        const bgl = (scene as SceneContextInternal)._pbrSceneBGL;
        const bg = (scene as SceneContextInternal)._pbrSceneBG;
        if (bgl && bg) {
            // HDR cubemap skybox — dynamically imported only when requested
            if (useHdr && textures.specularCubeView) {
                const { computeSceneSize } = await import("../material/pbr/scene-size.js");
                const { skyboxSize: autoSkyboxSize, rootPosition } = computeSceneSize(scene, options?.skyboxSize);
                const primaryColor = scene.environmentPrimaryColor ?? [0.08697355964132344, 0.08697355964132344, 0.2122208331110881];
                const { buildHdrSkyboxRenderable } = await import("../material/pbr/background-hdr-skybox.js");
                s._renderables.push(buildHdrSkyboxRenderable(scene, textures, bgl, bg, autoSkyboxSize / 2, rootPosition, primaryColor));
            }
            // Solid skybox fallback + ground
            if (!useHdr || !skipGround) {
                const primaryColor = scene.environmentPrimaryColor ?? [0.08697355964132344, 0.08697355964132344, 0.2122208331110881];
                const { computeSceneSize } = await import("../material/pbr/scene-size.js");
                const { groundSize, skyboxSize: autoSkyboxSize, rootPosition } = computeSceneSize(scene, options?.skyboxSize);
                if (!useHdr) {
                    const { buildSolidSkyboxRenderable } = await import("../material/pbr/background-solid-skybox.js");
                    s._renderables.push(buildSolidSkyboxRenderable(scene, textures, bgl, bg, autoSkyboxSize / 2, rootPosition, primaryColor));
                }
                if (!skipGround) {
                    const { buildGroundRenderable } = await import("../material/pbr/background-ground.js");
                    s._renderables.push(await buildGroundRenderable(engine, bgl, engine.format, engine.msaaSamples, bg, groundSize, rootPosition, primaryColor));
                }
            }
        } else {
            s._deferredBuilders.push(bgBuilder);
        }
    };
    s._deferredBuilders.push(bgBuilder);

    return textures;
}
