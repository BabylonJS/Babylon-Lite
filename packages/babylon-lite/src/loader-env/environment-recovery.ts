import type { EngineContext } from "../engine/engine.js";
import type { Renderable } from "../render/renderable.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { EnvironmentTextures } from "./load-env.js";
import { acquireGPUTexture, getOrCreateSampler, releaseGPUTexture } from "../resource/gpu-pool.js";

/** @internal Loader metadata captured by `_dlr` only while Scene recovery capture is enabled. */
export type EnvironmentRecoverySource =
    | { kind: "env"; url: string; brdfUrl: string; hasBackgrounds: boolean }
    | { kind: "hdr"; url: string; faceSize: number; useCubemapSkybox: boolean; skipGround: boolean; skyboxSize: number | undefined };

/** @internal Rebuild scene environment resources while preserving the EnvironmentTextures identity. */
export async function rebuildSceneEnvironment(engine: EngineContext, scene: SceneContext): Promise<EnvironmentRecoverySource | null> {
    const current = scene._envTextures;
    if (!current) {
        return null;
    }
    const source = scene._envRecoverySource;
    const sphericalHarmonics = current.sphericalHarmonics;
    scene._envTextures = undefined;
    if (!source) {
        throw new Error("Device-lost Scene recovery requires environment loading after recovery was enabled");
    }
    if (source.kind === "env" && source.hasBackgrounds) {
        throw new Error("Device-lost Scene recovery does not support loadEnvironment backgrounds");
    }

    let replacement: EnvironmentTextures;
    if (source.kind === "env") {
        replacement = await reloadEnvironmentTextures(engine, source, sphericalHarmonics);
    } else {
        const parser = await import("../loader-hdr/hdr-parser.js");
        const pipeline = await import("../loader-hdr/hdr-ibl-pipeline.js");
        const buffer = await fetch(source.url).then((response) => response.arrayBuffer());
        const hdr = parser.parseRGBE(buffer);
        const irradianceSH = parser.computeSHFromEquirect(hdr.data, hdr.width, hdr.height);
        const sourceCube = pipeline.equirectToCubemapGPU(engine, hdr, source.faceSize);
        const specularCube = pipeline.prefilterCubemapGPU(engine, sourceCube, source.faceSize, Math.floor(Math.log2(source.faceSize)) + 1);
        replacement = assembleRecoveredEnvironment(engine, specularCube, pipeline.generateBrdfLut(engine), irradianceSH, sphericalHarmonics, 1.0);
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

/** @internal Rebuild loader-owned skybox and ground renderables after material groups. */
export async function rebuildSceneEnvironmentBackgrounds(scene: SceneContext, source: EnvironmentRecoverySource): Promise<Renderable[]> {
    const textures = scene._envTextures;
    if (!textures) {
        return [];
    }
    if (source.kind === "env") {
        return [];
    }
    const engine = scene.surface.engine;
    const primaryColor = scene.environmentPrimaryColor ?? [0.08697355964132344, 0.08697355964132344, 0.2122208331110881];
    const { computeSceneSize } = await import("../material/pbr/scene-size.js");

    const { groundSize, skyboxSize, rootPosition } = computeSceneSize(scene, source.skyboxSize);
    const renderables: Renderable[] = [];
    if (source.useCubemapSkybox) {
        const { buildHdrSkyboxRenderable } = await import("../material/pbr/background-hdr-skybox.js");
        renderables.push(buildHdrSkyboxRenderable(scene, textures, skyboxSize / 2, rootPosition, primaryColor));
    } else {
        const { buildSolidSkyboxRenderable } = await import("../material/pbr/background-solid-skybox.js");
        renderables.push(buildSolidSkyboxRenderable(scene, textures, skyboxSize / 2, rootPosition, primaryColor));
    }
    if (!source.skipGround) {
        const { buildGroundRenderable } = await import("../material/pbr/background-ground.js");
        renderables.push(await buildGroundRenderable(engine, groundSize, rootPosition, primaryColor));
    }
    return renderables;
}

async function reloadEnvironmentTextures(
    engine: EngineContext,
    source: Extract<EnvironmentRecoverySource, { kind: "env" }>,
    sphericalHarmonics: Float32Array
): Promise<EnvironmentTextures> {
    const brdfPromise = loadBrdfImage(source.brdfUrl);
    const buffer = await fetch(source.url).then((response) => response.arrayBuffer());
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
    return assembleRecoveredEnvironment(engine, specularCube, brdfLut, irradianceSH, sphericalHarmonics, 0.8);
}

function assembleRecoveredEnvironment(
    engine: EngineContext,
    specularCube: GPUTexture,
    brdfLut: GPUTexture,
    irradianceSH: Float32Array,
    sphericalHarmonics: Float32Array,
    lodGenerationScale: number
): EnvironmentTextures {
    return {
        specularCube,
        specularCubeView: specularCube.createView({ dimension: "cube" }),
        brdfLut,
        brdfLutView: brdfLut.createView(),
        cubeSampler: getOrCreateSampler(engine, { magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" }),
        brdfSampler: getOrCreateSampler(engine, { magFilter: "linear", minFilter: "linear" }),
        irradianceSH,
        sphericalHarmonics,
        lodGenerationScale,
    };
}

function parseEnvFile(buffer: ArrayBuffer): { faceBlobs: Blob[]; irradianceSH: Float32Array; width: number; mipCount: number } {
    const bytes = new Uint8Array(buffer);
    const magic = [0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36];
    for (let index = 0; index < magic.length; index++) {
        if (bytes[index] !== magic[index]) {
            throw new Error("Invalid .env file: bad magic");
        }
    }
    let position = magic.length;
    while (position < bytes.length && bytes[position] !== 0) {
        position++;
    }
    const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(magic.length, position)));
    const binaryStart = position + 1;
    const width: number = manifest.width;
    const irradianceSH = new Float32Array(27);
    const shKeys = ["x", "y", "z", "xx", "yy", "zz", "yz", "zx", "xy"];
    for (let index = 0; index < shKeys.length; index++) {
        const coefficient = manifest.irradiance[shKeys[index]!];
        irradianceSH[index * 3] = coefficient[0];
        irradianceSH[index * 3 + 1] = coefficient[1];
        irradianceSH[index * 3 + 2] = coefficient[2];
    }
    const faceBlobs = manifest.specular.mipmaps.map(
        (entry: { position: number; length: number }) =>
            new Blob([buffer.slice(binaryStart + entry.position, binaryStart + entry.position + entry.length)], {
                type: manifest.imageType || "image/png",
            })
    );
    return { faceBlobs, irradianceSH, width, mipCount: Math.floor(Math.log2(width)) + 1 };
}

async function loadBrdfImage(url: string): Promise<ImageBitmap> {
    const response = await fetch(url);
    if (response.ok) {
        try {
            return await createImageBitmap(await response.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        } catch {
            // Fall through to the URL-specific diagnostic.
        }
    }
    throw new Error(`BRDF LUT '${url}' is not an image (${response.status} ${response.headers.get("content-type") ?? ""}).`);
}
