import type { EngineContext } from "../engine/engine.js";
import type { Renderable } from "../render/renderable.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { EnvironmentTextures } from "./load-env.js";
import { acquireGPUTexture, releaseGPUTexture } from "../resource/gpu-pool.js";
import { assembleEnvironmentTextures, loadBrdfImage } from "./env-helpers.js";
import { parseEnvFile } from "./env-parse.js";

/** @internal Loader metadata captured by `_dlr` only while Scene recovery capture is enabled. */
export type EnvironmentRecoverySource = { kind: "env"; url: string; brdfUrl: string } | { kind: "hdr"; url: string; faceSize: number };

/**
 * @internal Kind of loader-owned background renderable, captured by `_dlr.b`.
 *
 * Encoded as a number rather than a string so the capture seam — which sits in the loaders' hot
 * bundled path — folds to a single character per call site.
 */
export const enum EnvironmentBackgroundKind {
    SolidSkybox = 0,
    Ground = 1,
    DdsSkybox = 2,
    HdrSkybox = 3,
}

/**
 * @internal One loader-owned background renderable, recorded as it is built.
 *
 * Captured at build time rather than derived from load options so the seam costs nothing in scenes
 * that build no backgrounds: the `_dlr.b` calls sit inside the same statically-foldable `if` blocks
 * as the builders themselves, so Rollup drops them alongside the background it describes.
 */
export type EnvironmentBackgroundSource = {
    kind: EnvironmentBackgroundKind;
    /** Skybox half-size for skyboxes, ground size for the ground plane. */
    size: number;
    rootPosition: [number, number, number];
    /** Texture URL for the DDS skybox and the ground plane; both refetch it during recovery. */
    url?: string;
};

/** @internal Rebuild scene environment resources while preserving the EnvironmentTextures identity. */
export async function rebuildSceneEnvironment(engine: EngineContext, scene: SceneContext): Promise<EnvironmentRecoverySource | null> {
    const current = scene._envTextures;
    if (!current) {
        return null;
    }
    const source = scene._envRecoverySource;
    if (!source) {
        throw new Error("Device-lost Scene recovery requires environment loading after recovery was enabled");
    }
    // Only detach the textures once the rebuild is known to be possible: an early throw would
    // otherwise leave the scene without its environment while the error propagates.
    const sphericalHarmonics = current.sphericalHarmonics;
    scene._envTextures = undefined;

    let replacement: EnvironmentTextures;
    if (source.kind === "env") {
        replacement = await reloadEnvironmentTextures(engine, source, sphericalHarmonics);
    } else {
        const parser = await import("../loader-hdr/hdr-parser.js");
        const pipeline = await import("../loader-hdr/hdr-ibl-pipeline.js");
        const buffer = await fetchRecoverySource(source.url);
        const hdr = parser.parseRGBE(buffer);
        const irradianceSH = parser.computeSHFromEquirect(hdr.data, hdr.width, hdr.height);
        const sourceCube = pipeline.equirectToCubemapGPU(engine, hdr, source.faceSize);
        const specularCube = pipeline.prefilterCubemapGPU(engine, sourceCube, source.faceSize, Math.floor(Math.log2(source.faceSize)) + 1);
        replacement = assembleEnvironmentTextures(specularCube, pipeline.generateBrdfLut(engine), irradianceSH, 1.0, engine, sphericalHarmonics);
    }

    Object.assign(current, replacement);
    // Capture this generation's textures by value. Reading `current.*` inside the disposable would
    // release only whichever pair happened to be installed last, so every earlier recovery would
    // leave behind an unmatched acquire. One disposable per device loss is negligible, and each
    // releases a distinct pair, so they never collapse into duplicates.
    const { specularCube, brdfLut } = current;
    acquireGPUTexture(specularCube);
    acquireGPUTexture(brdfLut);
    scene._disposables.push(() => {
        releaseGPUTexture(specularCube);
        releaseGPUTexture(brdfLut);
    });
    scene._envTextures = current;
    scene._envRecoverySource = source;
    return source;
}

/**
 * @internal Rebuild loader-owned skybox and ground renderables after material groups.
 *
 * Replays the descriptors recorded as each background was originally built, so every loader path
 * recovers through one mechanism and recovery never has to re-derive a loader's background-strategy
 * rules.
 */
export async function rebuildSceneEnvironmentBackgrounds(scene: SceneContext): Promise<Renderable[]> {
    const textures = scene._envTextures;
    const captured = scene._envBackgroundSources;
    if (!textures || !captured) {
        return [];
    }
    const engine = scene.surface.engine;
    const primaryColor = scene.environmentPrimaryColor ?? [0.08697355964132344, 0.08697355964132344, 0.2122208331110881];
    const renderables: Renderable[] = [];

    for (const background of captured) {
        const { size, rootPosition, url } = background;
        switch (background.kind) {
            case EnvironmentBackgroundKind.SolidSkybox: {
                const { buildSolidSkyboxRenderable } = await import("../material/pbr/background-solid-skybox.js");
                renderables.push(buildSolidSkyboxRenderable(scene, textures, size, rootPosition, primaryColor));
                break;
            }
            case EnvironmentBackgroundKind.Ground: {
                const { buildGroundRenderable } = await import("../material/pbr/background-ground.js");
                renderables.push(await buildGroundRenderable(engine, size, rootPosition, primaryColor, url));
                break;
            }
            case EnvironmentBackgroundKind.DdsSkybox: {
                const { buildDdsSkyboxRenderable } = await import("../material/pbr/background-dds-skybox.js");
                renderables.push(await buildDdsSkyboxRenderable(scene, size, rootPosition, primaryColor, url));
                break;
            }
            default: {
                const { buildHdrSkyboxRenderable } = await import("../material/pbr/background-hdr-skybox.js");
                renderables.push(buildHdrSkyboxRenderable(scene, textures, size, rootPosition, primaryColor));
                break;
            }
        }
    }
    return renderables;
}

async function reloadEnvironmentTextures(
    engine: EngineContext,
    source: Extract<EnvironmentRecoverySource, { kind: "env" }>,
    sphericalHarmonics: Float32Array
): Promise<EnvironmentTextures> {
    const brdfPromise = loadBrdfImage(source.brdfUrl);
    // The BRDF fetch runs alongside the .env fetch but is not awaited until later, so a .env
    // failure would otherwise leave it rejecting unobserved. The rejection is still re-thrown by
    // the `await brdfPromise` below, which stays the single place BRDF errors surface.
    brdfPromise.catch(() => {});
    const buffer = await fetchRecoverySource(source.url);
    const { faceBlobs, irradianceSH, width, mipCount } = parseEnvFile(buffer);
    const faceImages = await Promise.all(faceBlobs.map((blob) => createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" })));
    const rgbd = await import("./rgbd-decode.js");
    const specularCube = rgbd.uploadCubemapRGBD(engine, faceImages, width, mipCount);
    for (const image of faceImages) {
        image.close();
    }
    const brdfImage = await brdfPromise;
    const brdfLut = rgbd.decodeBrdfPng(engine, brdfImage);
    brdfImage.close();
    return assembleEnvironmentTextures(specularCube, brdfLut, irradianceSH, 0.8, engine, sphericalHarmonics);
}

/**
 * Refetch a recovery source, rejecting a non-OK status before the body is parsed.
 *
 * Recovery runs long after the initial load, so an asset that has since gone missing would
 * otherwise surface as a decode failure ("Invalid .env file: bad magic" for an SPA HTML fallback)
 * that names neither the URL nor the status.
 */
async function fetchRecoverySource(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Device-lost Scene recovery could not refetch '${url}' (${response.status} ${response.statusText}).`);
    }
    return response.arrayBuffer();
}
