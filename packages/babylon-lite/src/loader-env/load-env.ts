import type { SceneContext } from "../scene/scene.js";
import type { EngineContext } from "../engine/engine.js";
import { acquireGPUTexture, releaseGPUTexture } from "../resource/gpu-pool.js";
import { assembleEnvironmentTextures } from "./env-helpers.js";
import { mipLevelCount } from "../texture/mip-count.js";
import { computeSceneSize } from "../material/pbr/scene-size.js";
import { registerEnvSceneUniforms } from "../scene/scene-ubo-extras.js";

/** GPU-resident environment textures. */
export interface EnvironmentTextures {
    specularCube: GPUTexture;
    specularCubeView: GPUTextureView;
    brdfLut: GPUTexture;
    brdfLutView: GPUTextureView;
    cubeSampler: GPUSampler;
    brdfSampler: GPUSampler;
    irradianceSH: Float32Array;
    /** Pre-scaled SH coefficients for shader, 36 floats in stride-4 layout:
     *  [L00.rgb, 0, L1_1.rgb, 0, L10.rgb, 0, L11.rgb, 0, L2_2.rgb, 0,
     *   L2_1.rgb, 0, L20.rgb, 0, L21.rgb, 0, L22.rgb, 0] */
    sphericalHarmonics: Float32Array;
    /** LOD generation scale for specular IBL sampling. Default 0.8 (matches BJS BaseTexture). */
    lodGenerationScale: number;
}

const ENV_MAGIC = new Uint8Array([0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36]);

/**
 * Load a Babylon.js .env environment file and upload cubemap + BRDF LUT to GPU.
 * BRDF LUT is decoded from a pre-baked RGBD PNG (matching BJS's embedded
 * environmentBRDFTexture) for pixel-perfect parity.
 */
export async function loadEnvironment(
    scene: SceneContext,
    url: string,
    options: {
        groundTextureUrl?: string;
        skipSkybox?: boolean;
        skipGround?: boolean;
        /**
         * URL for the skybox texture. Extension determines loading strategy:
         * - `.dds`: loads a DDS cube skybox (e.g. BJS CDN backgroundSkybox.dds). Tree-shaken when unused.
         * - `.env`: reuses the already-loaded specular cubemap as an HDR skybox (like BJS `createDefaultSkybox`).
         * Omit for the default flat-color background. Use `skipSkybox` to disable skybox entirely.
         */
        skyboxUrl?: string;
        /** Skybox size matching BJS createDefaultEnvironment skyboxSize option (default 20). */
        skyboxSize?: number;
        brdfUrl: string;
    }
): Promise<EnvironmentTextures> {
    const engine = scene.engine as EngineContext;

    // Fetch .env and BRDF PNG in parallel
    const envPromise = fetch(url).then((r) => r.arrayBuffer());
    const brdfPromise = fetch(options.brdfUrl)
        .then((r) => r.blob())
        .then((b) => createImageBitmap(b, { premultiplyAlpha: "none", colorSpaceConversion: "none" }));

    const envBuffer = await envPromise;
    const { faceBlobs, irradianceSH, width, mipCount } = parseEnvFile(envBuffer);

    // Decode all face images in parallel (raw RGBD bytes — no color space conversion)
    const faceImages = await Promise.all(faceBlobs.map((blob) => createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" })));

    const { uploadCubemapRGBD, decodeBrdfPng } = await import("./rgbd-decode.js");
    const specularCube = uploadCubemapRGBD(engine, faceImages, width, mipCount);
    for (const img of faceImages) {
        img.close();
    }

    const brdfImage = await brdfPromise;
    const brdfLut = decodeBrdfPng(engine, brdfImage);
    brdfImage.close();

    const textures = assembleEnvironmentTextures(specularCube, brdfLut, irradianceSH, 0.8, engine);

    scene._envTextures = textures;
    registerEnvSceneUniforms(scene);

    acquireGPUTexture(specularCube);
    acquireGPUTexture(brdfLut);
    scene._disposables.push(() => {
        releaseGPUTexture(specularCube);
        releaseGPUTexture(brdfLut);
    });

    // Enable tonemapping when environment is loaded (matches Babylon.js default behavior)
    scene.imageProcessing.toneMappingEnabled = true;
    scene.imageProcessing.exposure = 0.8;
    scene.imageProcessing.contrast = 1.2;

    // Register deferred builder for background renderables (skybox + ground)
    // Re-registers itself if PBR scene BGL isn't ready yet (created by mesh builder)
    const groundUrl = options?.groundTextureUrl;
    // Start fetching ground texture NOW (in parallel with everything else)
    const groundTexPromise = groundUrl
        ? fetch(groundUrl)
              .then((r) => r.blob())
              .then((b) => createImageBitmap(b, { premultiplyAlpha: "none" }))
        : undefined;
    const skyboxUrl = options?.skyboxUrl;
    const skyboxIsDds = skyboxUrl != null && skyboxUrl.toLowerCase().endsWith(".dds");
    // Skybox is treated as .env when the URL has an .env extension OR when it matches the
    // lighting URL (which we just loaded successfully as .env). The latter handles data URIs
    // and other extensionless URLs where the caller wants to reuse the IBL cubemap as a skybox.
    const skyboxIsEnv = skyboxUrl != null && (skyboxUrl === url || skyboxUrl.toLowerCase().endsWith(".env"));
    const bgOptions = {
        skipSkybox: skyboxIsDds || skyboxIsEnv || options?.skipSkybox,
        skipGround: options?.skipGround,
    };
    // Background renderables (skybox + ground) — deferred so they run AFTER the user
    // has finished tweaking `scene.imageProcessing.*` (skybox/ground/dds materials
    // snapshot exposure/contrast at build time into their per-mesh UBO).
    scene._deferredBuilders.push(async () => {
        const primaryColor = scene.environmentPrimaryColor ?? [0.08697355964132344, 0.08697355964132344, 0.2122208331110881];
        const { groundSize, skyboxSize: autoSkyboxSize, rootPosition } = computeSceneSize(scene, options?.skyboxSize);
        const skyHalfSize = autoSkyboxSize / 2;

        if (!bgOptions.skipSkybox) {
            const { buildSolidSkyboxRenderable } = await import("../material/pbr/background-solid-skybox.js");
            scene._renderables.push(buildSolidSkyboxRenderable(scene, textures, skyHalfSize, rootPosition, primaryColor));
        }
        if (!bgOptions.skipGround) {
            const { buildGroundRenderable } = await import("../material/pbr/background-ground.js");
            scene._renderables.push(await buildGroundRenderable(engine, groundSize, rootPosition, primaryColor, groundUrl, groundTexPromise));
        }
        if (skyboxIsDds) {
            const { buildDdsSkyboxRenderable } = await import("../material/pbr/background-dds-skybox.js");
            scene._renderables.push(await buildDdsSkyboxRenderable(scene, skyHalfSize, rootPosition, primaryColor, skyboxUrl));
        }
        if (skyboxIsEnv) {
            const { buildHdrSkyboxRenderable } = await import("../material/pbr/background-hdr-skybox.js");
            scene._renderables.push(buildHdrSkyboxRenderable(scene, textures, skyHalfSize, rootPosition, primaryColor));
        }
    });

    return textures;
}

// ─── .env Parsing ───────────────────────────────────────────────────────────

interface ParsedEnv {
    faceBlobs: Blob[];
    irradianceSH: Float32Array;
    width: number;
    mipCount: number;
}

function parseEnvFile(buffer: ArrayBuffer): ParsedEnv {
    const bytes = new Uint8Array(buffer);

    for (let i = 0; i < 8; i++) {
        if (bytes[i] !== ENV_MAGIC[i]) {
            throw new Error("Invalid .env file: bad magic");
        }
    }

    // JSON manifest: UTF-8 from byte 8 until null terminator
    let pos = 8;
    while (pos < bytes.length && bytes[pos] !== 0) {
        pos++;
    }
    const jsonStr = new TextDecoder().decode(bytes.subarray(8, pos));
    pos++; // skip null
    const binaryStart = pos;

    const manifest = JSON.parse(jsonStr);
    const width: number = manifest.width;
    const mipCount = mipLevelCount(width, width);

    // Irradiance spherical harmonics (9 vec3 coefficients = 27 floats)
    const irr = manifest.irradiance;
    const irradianceSH = new Float32Array(27);
    const shKeys = ["x", "y", "z", "xx", "yy", "zz", "yz", "zx", "xy"];
    for (let i = 0; i < 9; i++) {
        const coeff = irr[shKeys[i]!];
        irradianceSH[i * 3] = coeff[0];
        irradianceSH[i * 3 + 1] = coeff[1];
        irradianceSH[i * 3 + 2] = coeff[2];
    }

    // Extract face image blobs (flat: mip0_face0..5, mip1_face0..5, ...)
    const mipmaps: { position: number; length: number }[] = manifest.specular.mipmaps;
    const imageType: string = manifest.imageType || "image/png";
    const faceBlobs: Blob[] = [];

    for (const entry of mipmaps) {
        const start = binaryStart + entry.position;
        const slice = buffer.slice(start, start + entry.length);
        faceBlobs.push(new Blob([slice], { type: imageType }));
    }

    return { faceBlobs, irradianceSH, width, mipCount };
}

// ─── SH Polynomial → Pre-scaled Harmonics Conversion ────────────────────────
// Matches Babylon.js: SphericalHarmonics.FromPolynomial() + preScaleForRendering()

/** @internal — exported only for env-helpers.ts; not part of the public API. */
export function polynomialToPreScaledHarmonics(poly: Float32Array): Float32Array {
    // poly layout (3 floats per group): x, y, z, xx, yy, zz, yz, zx, xy
    // Constants = K_fromPoly * PI * B_basis (pre-computed; signs folded in).
    // Matches Babylon.js SphericalHarmonics.FromPolynomial() + preScaleForRendering().
    const C00xy = 0.3333338747897695;
    const C00z = 0.33333298856284405;
    const C1 = 1.4999984284682104;
    const C2 = 3.999982863580422;
    const C20zz = 1.3333326611423701;
    const C20xy = 0.6666653397393608;
    const C22 = 1.999991431790211;

    // Stride-4 layout matching shader UBO (9 vec3s + pad f32 each)
    const out = new Float32Array(36);
    for (let i = 0; i < 3; i++) {
        const x = poly[i]!;
        const y = poly[3 + i]!;
        const z = poly[6 + i]!;
        const xx = poly[9 + i]!;
        const yy = poly[12 + i]!;
        const zz = poly[15 + i]!;
        const yz = poly[18 + i]!;
        const zx = poly[21 + i]!;
        const xy = poly[24 + i]!;
        out[i] = (xx + yy) * C00xy + zz * C00z; // L00
        out[4 + i] = y * C1; // L1_1
        out[8 + i] = z * C1; // L10
        out[12 + i] = x * C1; // L11
        out[16 + i] = xy * C2; // L2_2
        out[20 + i] = yz * C2; // L2_1
        out[24 + i] = zz * C20zz - (xx + yy) * C20xy; // L20
        out[28 + i] = zx * C2; // L21
        out[32 + i] = (xx - yy) * C22; // L22
    }
    return out;
}
