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

    const specularCube = uploadCubemapRGBD(engine, faceImages, width, mipCount);
    for (const img of faceImages) {
        img.close();
    }

    const brdfImage = await brdfPromise;
    const { decodeBrdfPng } = await import("./brdf-rgbd-decode.js");
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

// ─── GPU Compute: RGBD → linear HDR float16 ─────────────────────────────────

const RGBD_DECODE_WGSL = /* wgsl */ `
@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let dims = textureDimensions(inputTex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }

    // Y-flip: Babylon uploads cubemap faces with invertY=true
    let srcY = dims.y - 1u - gid.y;
    let rgba = textureLoad(inputTex, vec2u(gid.x, srcY), 0);

    // RGBD decode: pow(sRGB, 2.2) / alpha  (matches Babylon's fromRGBD shader)
    let a = max(rgba.a, 1.0 / 255.0);
    let linear = vec3f(
        pow(rgba.r, 2.2) / a,
        pow(rgba.g, 2.2) / a,
        pow(rgba.b, 2.2) / a
    );

    textureStore(outputTex, vec2u(gid.x, gid.y), vec4f(linear, 1.0));
}
`;

let _rgbdPipeline: GPUComputePipeline | null = null;
let _rgbdPipelineDevice: GPUDevice | null = null;

function uploadCubemapRGBD(engine: EngineContextInternal, images: ImageBitmap[], width: number, mipCount: number): GPUTexture {
    const device = engine.device;
    if (device !== _rgbdPipelineDevice) {
        _rgbdPipeline = null;
        _rgbdPipelineDevice = device;
    }
    if (!_rgbdPipeline) {
        _rgbdPipeline = device.createComputePipeline({
            layout: "auto",
            compute: { module: device.createShaderModule({ code: RGBD_DECODE_WGSL }), entryPoint: "main" },
        });
    }
    const pipeline = _rgbdPipeline;

    const texture = device.createTexture({
        size: { width, height: width, depthOrArrayLayers: 6 },
        format: "rgba16float",
        mipLevelCount: mipCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
        dimension: "2d",
    });

    for (let mip = 0; mip < mipCount; mip++) {
        const mipSize = Math.max(1, width >> mip);

        const inputTex = device.createTexture({
            size: { width: mipSize, height: mipSize },
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        const outputTex = device.createTexture({
            size: { width: mipSize, height: mipSize },
            format: "rgba16float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        });

        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: inputTex.createView() },
                { binding: 1, resource: outputTex.createView() },
            ],
        });

        for (let face = 0; face < 6; face++) {
            const idx = mip * 6 + face;
            if (idx >= images.length) {
                break;
            }

            device.queue.copyExternalImageToTexture({ source: images[idx]!, flipY: false }, { texture: inputTex, premultipliedAlpha: false }, { width: mipSize, height: mipSize });

            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(Math.ceil(mipSize / 8), Math.ceil(mipSize / 8));
            pass.end();

            encoder.copyTextureToTexture({ texture: outputTex }, { texture, origin: { x: 0, y: 0, z: face }, mipLevel: mip }, { width: mipSize, height: mipSize });

            device.queue.submit([encoder.finish()]);
        }

        inputTex.destroy();
        outputTex.destroy();
    }

    return texture;
}

// ─── SH Polynomial → Pre-scaled Harmonics Conversion ────────────────────────
// Matches Babylon.js: SphericalHarmonics.FromPolynomial() + preScaleForRendering()

/** @internal — exported only for env-helpers.ts; not part of the public API. */
export function polynomialToPreScaledHarmonics(poly: Float32Array): EnvironmentTextures["sphericalHarmonics"] {
    // poly layout: [x0,x1,x2, y0,y1,y2, z0,z1,z2, xx0..., yy..., zz..., yz..., zx..., xy...]
    const x = poly.subarray(0, 3);
    const y = poly.subarray(3, 6);
    const z = poly.subarray(6, 9);
    const xx = poly.subarray(9, 12);
    const yy = poly.subarray(12, 15);
    const zz = poly.subarray(15, 18);
    const yz = poly.subarray(18, 21);
    const zx = poly.subarray(21, 24);
    const xy = poly.subarray(24, 27);

    const PI = Math.PI;

    // FromPolynomial constants
    const K00 = 0.376127;
    const K1 = 0.977204;
    const K2 = 1.16538;
    const K20_zz = 1.34567;
    const K20_xy = 0.672834;

    // preScaleForRendering basis constants
    const B00 = Math.sqrt(1 / (4 * PI));
    const B1m = -Math.sqrt(3 / (4 * PI));
    const B1p = Math.sqrt(3 / (4 * PI));
    const B2_2 = Math.sqrt(15 / (4 * PI));
    const B2_1 = -Math.sqrt(15 / (4 * PI));
    const B20 = Math.sqrt(5 / (16 * PI));
    const B21 = -Math.sqrt(15 / (4 * PI));
    const B22 = Math.sqrt(15 / (16 * PI));

    const scale = (a: Float32Array, s: number): Float32Array => {
        return new Float32Array([a[0]! * s, a[1]! * s, a[2]! * s]);
    };
    const add3 = (a: Float32Array, b: Float32Array, c: Float32Array): Float32Array => {
        return new Float32Array([a[0]! + b[0]! + c[0]!, a[1]! + b[1]! + c[1]!, a[2]! + b[2]! + c[2]!]);
    };
    const sub = (a: Float32Array, b: Float32Array): Float32Array => {
        return new Float32Array([a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]);
    };

    // Step 1: FromPolynomial (includes sign corrections and ×π)
    const raw_l00 = scale(add3(scale(xx, K00), scale(yy, K00), scale(zz, 0.376126)), PI);
    const raw_l1_1 = scale(y, -K1 * PI); // sign correction: -1
    const raw_l10 = scale(z, K1 * PI);
    const raw_l11 = scale(x, -K1 * PI); // sign correction: -1
    const raw_l2_2 = scale(xy, K2 * PI);
    const raw_l2_1 = scale(yz, -K2 * PI); // sign correction: -1
    const raw_l20 = scale(sub(scale(zz, K20_zz), add3(scale(xx, K20_xy), scale(yy, K20_xy), new Float32Array(3))), PI);
    const raw_l21 = scale(zx, -K2 * PI); // sign correction: -1
    const raw_l22 = scale(sub(scale(xx, K2), scale(yy, K2)), PI);

    // Step 2: preScaleForRendering
    return {
        l00: scale(raw_l00, B00),
        l1_1: scale(raw_l1_1, B1m),
        l10: scale(raw_l10, B1p),
        l11: scale(raw_l11, B1m),
        l2_2: scale(raw_l2_2, B2_2),
        l2_1: scale(raw_l2_1, B2_1),
        l20: scale(raw_l20, B20),
        l21: scale(raw_l21, B21),
        l22: scale(raw_l22, B22),
    };
}
