import type { SceneContext } from "../scene/scene.js";
import type { EngineContext } from "../engine/engine.js";
import type { EnvironmentTextures } from "./load-env.js";
import { acquireGPUTexture, releaseGPUTexture } from "../resource/gpu-pool.js";
import { assembleEnvironmentTextures } from "./env-helpers.js";
import { shToPolynomial } from "../math/spherical-harmonics.js";
import { registerEnvSceneUniforms } from "../scene/scene-ubo-extras.js";

// ─── Float16 Conversion ─────────────────────────────────────────────────────

function float16ToFloat32(h: number): number {
    const s = (h >> 15) & 0x1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    if (e === 0) {
        return (s ? -1 : 1) * Math.pow(2, -14) * (m / 1024);
    }
    if (e === 31) {
        return m ? NaN : s ? -Infinity : Infinity;
    }
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + m / 1024);
}

// ─── SH Constants ────────────────────────────────────────────────────────────

const PI = Math.PI;

const SH_BASIS = [
    Math.sqrt(1 / (4 * PI)),
    Math.sqrt(3 / (4 * PI)),
    Math.sqrt(3 / (4 * PI)),
    Math.sqrt(3 / (4 * PI)),
    Math.sqrt(15 / (4 * PI)),
    Math.sqrt(15 / (4 * PI)),
    Math.sqrt(5 / (16 * PI)),
    Math.sqrt(15 / (4 * PI)),
    Math.sqrt(15 / (16 * PI)),
];

const SH_COS_KERNEL = [PI, (2 * PI) / 3, (2 * PI) / 3, (2 * PI) / 3, PI / 4, PI / 4, PI / 4, PI / 4, PI / 4];

const MAX_HDRI = 4096;

// Face orientations matching BJS _FileFaces: +X, -X, +Y, -Y, +Z, -Z
// [normalX, normalY, normalZ, fileXx, fileXy, fileXz, fileYx, fileYy, fileYz]
const FACES: readonly (readonly number[])[] = [
    [1, 0, 0, 0, 0, -1, 0, -1, 0],
    [-1, 0, 0, 0, 0, 1, 0, -1, 0],
    [0, 1, 0, 1, 0, 0, 0, 0, 1],
    [0, -1, 0, 1, 0, 0, 0, 0, -1],
    [0, 0, 1, 1, 0, 0, 0, -1, 0],
    [0, 0, -1, -1, 0, 0, 0, -1, 0],
];

// ─── Solid Angle ─────────────────────────────────────────────────────────────

function areaElement(x: number, y: number): number {
    return Math.atan2(x * y, Math.sqrt(x * x + y * y + 1));
}

// ─── SH from Cubemap ────────────────────────────────────────────────────────

function computeSH(raw: Uint8Array, width: number, mipCount: number): Float32Array {
    // Total bytes per face (all mips)
    let faceBytes = 0;
    for (let m = 0; m < mipCount; m++) {
        const s = Math.max(width >> m, 1);
        faceBytes += s * s * 8;
    }

    const du = 2.0 / width;
    const halfTexel = 0.5 * du;
    const minUV = halfTexel - 1.0;

    const sh = new Float64Array(27);
    let totalSolidAngle = 0;
    const trig = new Float64Array(9);

    for (let face = 0; face < 6; face++) {
        const faceStart = face * faceBytes;
        const pixels = new Uint16Array(raw.buffer, raw.byteOffset + faceStart, width * width * 4);
        const f = FACES[face]!;
        const nx = f[0]!,
            ny = f[1]!,
            nz = f[2]!;
        const fxx = f[3]!,
            fxy = f[4]!,
            fxz = f[5]!;
        const fyx = f[6]!,
            fyy = f[7]!,
            fyz = f[8]!;

        let v = minUV;
        for (let row = 0; row < width; row++) {
            let u = minUV;
            for (let col = 0; col < width; col++) {
                const idx = (row * width + col) * 4;
                let r = float16ToFloat32(pixels[idx]!);
                let g = float16ToFloat32(pixels[idx + 1]!);
                let b = float16ToFloat32(pixels[idx + 2]!);

                if (isNaN(r)) {
                    r = 0;
                }
                if (isNaN(g)) {
                    g = 0;
                }
                if (isNaN(b)) {
                    b = 0;
                }
                r = Math.min(Math.max(r, 0), MAX_HDRI);
                g = Math.min(Math.max(g, 0), MAX_HDRI);
                b = Math.min(Math.max(b, 0), MAX_HDRI);

                // World direction = fileX * u + fileY * v + normal, then normalize
                const dx = fxx * u + fyx * v + nx;
                const dy = fxy * u + fyy * v + ny;
                const dz = fxz * u + fyz * v + nz;
                const invLen = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
                const wx = dx * invLen,
                    wy = dy * invLen,
                    wz = dz * invLen;

                const dsa =
                    areaElement(u - halfTexel, v - halfTexel) -
                    areaElement(u - halfTexel, v + halfTexel) -
                    areaElement(u + halfTexel, v - halfTexel) +
                    areaElement(u + halfTexel, v + halfTexel);

                // SH trig terms
                const t0 = 1;
                const t1 = wy;
                const t2 = wz;
                const t3 = wx;
                const t4 = wx * wy;
                const t5 = wy * wz;
                const t6 = 3 * wz * wz - 1;
                const t7 = wx * wz;
                const t8 = wx * wx - wy * wy;
                trig[0] = t0;
                trig[1] = t1;
                trig[2] = t2;
                trig[3] = t3;
                trig[4] = t4;
                trig[5] = t5;
                trig[6] = t6;
                trig[7] = t7;
                trig[8] = t8;

                for (let i = 0; i < 9; i++) {
                    const w = dsa * SH_BASIS[i]! * trig[i]!;
                    sh[i] = sh[i]! + r * w;
                    sh[9 + i] = sh[9 + i]! + g * w;
                    sh[18 + i] = sh[18 + i]! + b * w;
                }

                totalSolidAngle += dsa;
                u += du;
            }
            v += du;
        }
    }

    // Normalize to sphere solid angle
    const correction = (4 * PI) / totalSolidAngle;
    for (let i = 0; i < 27; i++) {
        sh[i] = sh[i]! * correction;
    }

    // Incident radiance → irradiance (cosine kernel convolution)
    for (let ch = 0; ch < 3; ch++) {
        for (let i = 0; i < 9; i++) {
            sh[ch * 9 + i] = sh[ch * 9 + i]! * SH_COS_KERNEL[i]!;
        }
    }

    // Irradiance → Lambertian radiance
    const invPI = 1 / PI;
    for (let i = 0; i < 27; i++) {
        sh[i] = sh[i]! * invPI;
    }

    // Convert SH coefficients → polynomial form (matching BJS SphericalPolynomial.FromHarmonics)
    return shToPolynomial(sh);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load a DDS cubemap environment for PBR IBL.
 * Uploads ALL mip levels (prefiltered data) and computes spherical harmonics
 * from mip 0 face data for irradiance lighting.
 */
export async function loadDdsEnvironment(scene: SceneContext, url: string, options: { brdfUrl: string; skipSkybox?: boolean; skipGround?: boolean }): Promise<EnvironmentTextures> {
    const engine = scene.engine as EngineContext;
    const device = engine._device;

    // Fetch DDS and BRDF PNG in parallel
    const ddsPromise = fetch(url).then((r) => r.arrayBuffer());
    const brdfPromise = fetch(options.brdfUrl)
        .then((r) => r.blob())
        .then((b) => createImageBitmap(b, { premultiplyAlpha: "none", colorSpaceConversion: "none" }));

    const buf = await ddsPromise;

    // ── Parse DDS header ──────────────────────────────────────────────────────
    const header = new Int32Array(buf, 0, 32);
    const width = header[3]!;
    const height = header[4]!;
    const mipCount = Math.max(header[7]!, 1);
    const dataOffset = header[21] === 0x30315844 /* 'DX10' */ ? 128 + 20 : 128;
    const raw = new Uint8Array(buf, dataOffset);

    // ── Create cubemap texture with all mip levels ────────────────────────────
    const specularCube = device.createTexture({
        size: [width, height, 6],
        format: "rgba16float",
        mipLevelCount: mipCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        dimension: "2d",
    });

    // Upload all mip levels for each face (DDS is face-major)
    let offset = 0;
    for (let face = 0; face < 6; face++) {
        for (let m = 0; m < mipCount; m++) {
            const s = Math.max(width >> m, 1);
            device.queue.writeTexture(
                { texture: specularCube, origin: { x: 0, y: 0, z: face }, mipLevel: m },
                raw.buffer,
                { offset: raw.byteOffset + offset, bytesPerRow: s * 8 },
                { width: s, height: s }
            );
            offset += s * s * 8;
        }
    }

    // ── Compute spherical harmonics from mip 0 ───────────────────────────────
    const irradianceSH = computeSH(raw, width, mipCount);

    // ── Load BRDF LUT ────────────────────────────────────────────────────────
    const brdfImage = await brdfPromise;
    const { decodeBrdfPng } = await import("./rgbd-decode.js");
    const brdfLut = decodeBrdfPng(engine, brdfImage);
    brdfImage.close();

    // ── Assemble result──────────────────────────────────────────────────────
    const textures = assembleEnvironmentTextures(specularCube, brdfLut, irradianceSH, 0.8, engine);

    scene._envTextures = textures;
    registerEnvSceneUniforms(scene);

    acquireGPUTexture(specularCube);
    acquireGPUTexture(brdfLut);
    scene._disposables.push(() => {
        releaseGPUTexture(specularCube);
        releaseGPUTexture(brdfLut);
    });

    // NOTE: Unlike loadEnvironment (.env), DDS environment loading does NOT
    // auto-enable tonemapping — BJS CreateFromPrefilteredData doesn't either.
    // The caller controls imageProcessing settings.

    return textures;
}
