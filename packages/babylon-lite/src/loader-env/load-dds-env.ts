import type { SceneContext, SceneContextInternal } from "../scene/scene.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { EnvironmentTextures } from "./load-env.js";
import { acquireGPUTexture, releaseGPUTexture } from "../resource/gpu-pool.js";
import { assembleEnvironmentTextures } from "./env-helpers.js";

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
    -Math.sqrt(3 / (4 * PI)),
    Math.sqrt(3 / (4 * PI)),
    -Math.sqrt(3 / (4 * PI)),
    Math.sqrt(15 / (4 * PI)),
    -Math.sqrt(15 / (4 * PI)),
    Math.sqrt(5 / (16 * PI)),
    -Math.sqrt(15 / (4 * PI)),
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
                const trig = [t0, t1, t2, t3, t4, t5, t6, t7, t8];

                for (let i = 0; i < 9; i++) {
                    const w = dsa * SH_BASIS[i]! * trig[i]!;
                    const j = i * 3;
                    sh[j] = sh[j]! + r * w;
                    sh[j + 1] = sh[j + 1]! + g * w;
                    sh[j + 2] = sh[j + 2]! + b * w;
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
    for (let i = 0; i < 9; i++) {
        const k = SH_COS_KERNEL[i]!;
        const j = i * 3;
        sh[j] = sh[j]! * k;
        sh[j + 1] = sh[j + 1]! * k;
        sh[j + 2] = sh[j + 2]! * k;
    }

    // Irradiance → Lambertian radiance
    const invPI = 1 / PI;
    for (let i = 0; i < 27; i++) {
        sh[i] = sh[i]! * invPI;
    }

    // Convert SH coefficients → polynomial form (matching BJS SphericalPolynomial.FromHarmonics)
    return shToPolynomial(sh);
}

// ─── SH → Polynomial Conversion ─────────────────────────────────────────────

function shToPolynomial(sh: Float64Array): Float32Array {
    const poly = new Float32Array(27);
    for (let c = 0; c < 3; c++) {
        // x = l11 * -1.02333, y = l1_1 * -1.02333, z = l10 * 1.02333
        poly[c] = sh[3 * 3 + c]! * -1.02333;
        poly[3 + c] = sh[1 * 3 + c]! * -1.02333;
        poly[6 + c] = sh[2 * 3 + c]! * 1.02333;
        // xx = l00*0.886277 - l20*0.247708 + l22*0.429043
        poly[9 + c] = sh[c]! * 0.886277 - sh[6 * 3 + c]! * 0.247708 + sh[8 * 3 + c]! * 0.429043;
        // yy = l00*0.886277 - l20*0.247708 - l22*0.429043
        poly[12 + c] = sh[c]! * 0.886277 - sh[6 * 3 + c]! * 0.247708 - sh[8 * 3 + c]! * 0.429043;
        // zz = l00*0.886277 + l20*0.495417
        poly[15 + c] = sh[c]! * 0.886277 + sh[6 * 3 + c]! * 0.495417;
        // yz = l2_1 * -0.858086
        poly[18 + c] = sh[5 * 3 + c]! * -0.858086;
        // zx = l21 * -0.858086
        poly[21 + c] = sh[7 * 3 + c]! * -0.858086;
        // xy = l2_2 * 0.858086
        poly[24 + c] = sh[4 * 3 + c]! * 0.858086;
    }
    // Final 1/π from BJS SphericalPolynomial.FromHarmonics
    const invPI = 1 / PI;
    for (let i = 0; i < 27; i++) {
        poly[i] = poly[i]! * invPI;
    }
    return poly;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load a DDS cubemap environment for PBR IBL.
 * Uploads ALL mip levels (prefiltered data) and computes spherical harmonics
 * from mip 0 face data for irradiance lighting.
 */
export async function loadDdsEnvironment(scene: SceneContext, url: string, options: { brdfUrl: string; skipSkybox?: boolean; skipGround?: boolean }): Promise<EnvironmentTextures> {
    const device = (scene.engine as EngineContextInternal).device;

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
    const { decodeBrdfPng } = await import("./brdf-rgbd-decode.js");
    const brdfLut = decodeBrdfPng(device, brdfImage);

    // ── Assemble result ──────────────────────────────────────────────────────
    const textures = assembleEnvironmentTextures(specularCube, brdfLut, irradianceSH, 0.8, device);

    (scene as SceneContextInternal)._envTextures = textures;
    (scene as SceneContextInternal)._irradianceSH = irradianceSH;

    acquireGPUTexture(specularCube);
    acquireGPUTexture(brdfLut);
    (scene as SceneContextInternal)._disposables.push(() => {
        releaseGPUTexture(specularCube);
        releaseGPUTexture(brdfLut);
    });

    // NOTE: Unlike loadEnvironment (.env), DDS environment loading does NOT
    // auto-enable tonemapping — BJS CreateFromPrefilteredData doesn't either.
    // The caller controls imageProcessing settings.

    return textures;
}
