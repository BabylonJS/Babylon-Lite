import type { SceneContext, SceneContextInternal } from "../scene/scene.js";
import type { EngineContextInternal } from "../engine/engine.js";
import { acquireGPUTexture, releaseGPUTexture } from "../resource/gpu-pool.js";
import { assembleEnvironmentTextures } from "./env-helpers.js";

/** GPU-resident environment textures. */
export interface EnvironmentTextures {
    specularCube: GPUTexture;
    specularCubeView: GPUTextureView;
    brdfLut: GPUTexture;
    brdfLutView: GPUTextureView;
    cubeSampler: GPUSampler;
    brdfSampler: GPUSampler;
    irradianceSH: Float32Array;
    /** Pre-scaled SH (9 vec3s in L00,L1_1,L10,L11,L2_2,L2_1,L20,L21,L22 order, for shader) */
    sphericalHarmonics: {
        l00: Float32Array;
        l1_1: Float32Array;
        l10: Float32Array;
        l11: Float32Array;
        l2_2: Float32Array;
        l2_1: Float32Array;
        l20: Float32Array;
        l21: Float32Array;
        l22: Float32Array;
    };
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
    const engine = scene.engine as EngineContextInternal;

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

    (scene as SceneContextInternal)._envTextures = textures;
    (scene as SceneContextInternal)._irradianceSH = irradianceSH;

    acquireGPUTexture(specularCube);
    acquireGPUTexture(brdfLut);
    (scene as SceneContextInternal)._disposables.push(() => {
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
    const skyboxIsEnv = skyboxUrl != null && skyboxUrl.toLowerCase().endsWith(".env");
    const bgOptions = {
        skipSkybox: skyboxIsDds || skyboxIsEnv || options?.skipSkybox,
        skipGround: options?.skipGround,
    };
    // Only pull in the background-renderable chunk if solid skybox or ground is
    // actually required. Scenes passing skipSkybox+skipGround (with no DDS/HDR
    // skybox) skip the import and chunk fetch entirely.
    const needsBgRenderables = !bgOptions.skipSkybox || !bgOptions.skipGround;
    const envBgBuilder = async (): Promise<void> => {
        const bgl = (scene as SceneContextInternal)._pbrSceneBGL;
        const bg = (scene as SceneContextInternal)._pbrSceneBG;
        if (bgl && bg) {
            if (needsBgRenderables) {
                const { buildBackgroundRenderables } = await import("../material/pbr/background-renderable.js");
                const bgRenderables = await buildBackgroundRenderables(scene, textures, bgl, bg, groundUrl, bgOptions, groundTexPromise);
                (scene as SceneContextInternal)._renderables.push(...bgRenderables);
            }

            if (skyboxIsDds) {
                const { buildDdsSkyboxRenderable } = await import("../material/pbr/background-dds-skybox.js");
                (scene as SceneContextInternal)._renderables.push(await buildDdsSkyboxRenderable(scene, bgl, bg, skyboxUrl, options?.skyboxSize));
            }
            if (skyboxIsEnv) {
                const { buildHdrSkyboxRenderable } = await import("../material/pbr/background-hdr-skybox.js");
                (scene as SceneContextInternal)._renderables.push(buildHdrSkyboxRenderable(scene, textures, bgl, bg, options?.skyboxSize));
            }
        } else {
            (scene as SceneContextInternal)._deferredBuilders.push(envBgBuilder);
        }
    };
    (scene as SceneContextInternal)._deferredBuilders.push(envBgBuilder);

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
    const mipCount = Math.floor(Math.log2(width)) + 1;

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
export function polynomialToPreScaledHarmonics(poly: Float32Array): EnvironmentTextures["sphericalHarmonics"] {
    // poly layout (3 floats per group): x, y, z, xx, yy, zz, yz, zx, xy
    // Constants = K_fromPoly * PI * B_basis (pre-computed; signs folded in).
    // Matches Babylon.js SphericalHarmonics.FromPolynomial() + preScaleForRendering().
    const C00xy = 0.3333338747897695; // 0.376127 * PI * sqrt(1/(4PI))
    const C00z = 0.33333298856284405; // 0.376126 * PI * sqrt(1/(4PI))
    const C1 = 1.4999984284682104; // 0.977204 * PI * sqrt(3/(4PI))
    const C2 = 3.999982863580422; // 1.16538 * PI * sqrt(15/(4PI))
    const C20zz = 1.3333326611423701; // 1.34567 * PI * sqrt(5/(16PI))
    const C20xy = 0.6666653397393608; // 0.672834 * PI * sqrt(5/(16PI))
    const C22 = 1.999991431790211; // 1.16538 * PI * sqrt(15/(16PI))

    const out = Array.from({ length: 9 }, () => new Float32Array(3));
    const [l00, l1_1, l10, l11, l2_2, l2_1, l20, l21, l22] = out;
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
        l00![i] = (xx + yy) * C00xy + zz * C00z;
        l1_1![i] = y * C1;
        l10![i] = z * C1;
        l11![i] = x * C1;
        l2_2![i] = xy * C2;
        l2_1![i] = yz * C2;
        l20![i] = zz * C20zz - (xx + yy) * C20xy;
        l21![i] = zx * C2;
        l22![i] = (xx - yy) * C22;
    }
    return { l00: l00!, l1_1: l1_1!, l10: l10!, l11: l11!, l2_2: l2_2!, l2_1: l2_1!, l20: l20!, l21: l21!, l22: l22! };
}
