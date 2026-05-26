/** DDS cube skybox — lazy-loaded only when skyboxUrl ends with .dds.
 *  Loads backgroundSkybox.dds and renders it with BJS image processing. */

import type { SceneContext } from "../../scene/scene.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { Mat4 } from "../../math/types.js";
import type { Renderable } from "../../render/renderable.js";
import { getOrCreateSampler } from "../../resource/gpu-pool.js";
import { createMappedBuffer, createUniformBuffer } from "../../resource/gpu-buffers.js";
import { WGSL_DITHER, WGSL_NO_DITHER } from "../../shader/wgsl-helpers.js";
import { SCENE_UBO_WGSL } from "../../shader/scene-uniforms.js";
import { createCubemapSkyboxMaterial } from "./cubemap-skybox-material.js";
import ddsSkyboxVertSrc from "../../../shaders/skybox-dds.vertex.wgsl?raw";
import ddsSkyboxFragSrc from "../../../shaders/skybox-dds.fragment.wgsl?raw";

const SKY_DDS_UNIFORM_SIZE = 96;
const DEFAULT_SKY_URL = "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds";

function createSkyboxBuffers(engine: EngineContextInternal, S: number): { posBuffer: GPUBuffer; idxBuffer: GPUBuffer; idxCount: number } {
    // prettier-ignore
    const positions = new Float32Array([
     S,-S, S, -S,-S, S, -S, S, S,  S, S, S,
     S, S,-S, -S, S,-S, -S,-S,-S,  S,-S,-S,
     S, S,-S,  S,-S,-S,  S,-S, S,  S, S, S,
    -S, S, S, -S,-S, S, -S,-S,-S, -S, S,-S,
    -S, S, S, -S, S,-S,  S, S,-S,  S, S, S,
     S,-S, S,  S,-S,-S, -S,-S,-S, -S,-S, S,
  ]);
    // prettier-ignore
    const indices = new Uint16Array([
     2, 1, 0,  3, 2, 0,   6, 5, 4,  7, 6, 4,
    10, 9, 8, 11,10, 8,  14,13,12, 15,14,12,
    18,17,16, 19,18,16,  22,21,20, 23,22,20,
  ]);
    return {
        posBuffer: createMappedBuffer(engine, positions, GPUBufferUsage.VERTEX),
        idxBuffer: createMappedBuffer(engine, indices, GPUBufferUsage.INDEX),
        idxCount: 36,
    };
}

function buildSkyboxWorldMatrix(rootPosition: [number, number, number]): Mat4 {
    const world = new Float32Array(16) as Mat4;
    world[0] = 1;
    world[5] = 1;
    world[10] = 1;
    world[15] = 1;
    world[12] = rootPosition[0];
    world[13] = rootPosition[1];
    world[14] = rootPosition[2];
    return world;
}

/** Build a DDS cube skybox as a complete Renderable (order 0). */
export async function buildDdsSkyboxRenderable(
    scene: SceneContext,
    skyHalfSize: number,
    rootPosition: [number, number, number],
    primaryColor: [number, number, number],
    skyboxTextureUrl?: string,
    enableNoise = true
): Promise<Renderable> {
    const engine = scene.engine as EngineContextInternal;

    const skyboxWorld = buildSkyboxWorldMatrix(rootPosition);

    const skyBufs = createSkyboxBuffers(engine, skyHalfSize);
    const { cubeView, sampler } = await loadDdsCube(engine, skyboxTextureUrl ?? DEFAULT_SKY_URL);

    const fragCode = SCENE_UBO_WGSL + (enableNoise ? WGSL_DITHER : WGSL_NO_DITHER) + ddsSkyboxFragSrc;
    const mat = createCubemapSkyboxMaterial(enableNoise ? "skybox-dds" : "skybox-dds0", SCENE_UBO_WGSL + ddsSkyboxVertSrc, fragCode);
    const ubo = createDdsMeshUBO(engine, skyboxWorld, primaryColor, scene.imageProcessing.exposure, scene.imageProcessing.contrast);
    const bindGroup = mat.createBindGroup(engine, ubo, cubeView, sampler);

    const r: Renderable = {
        order: 0,
        isTransparent: false,
        bind(eng, sig) {
            return {
                renderable: r,
                pipeline: mat.getPipeline(eng as EngineContextInternal, sig),
                draw(pass) {
                    pass.setBindGroup(1, bindGroup);
                    pass.setVertexBuffer(0, skyBufs.posBuffer);
                    pass.setIndexBuffer(skyBufs.idxBuffer, "uint16");
                    pass.drawIndexed(skyBufs.idxCount);
                    return 1;
                },
            };
        },
    };
    return r;
}

// ─── DDS Skybox UBO ──────────────────────────────────────────────────────────

function createDdsMeshUBO(engine: EngineContextInternal, world: Float32Array, primaryColor: [number, number, number], exposureLinear: number, contrast: number): GPUBuffer {
    const data = new Float32Array(SKY_DDS_UNIFORM_SIZE / 4);
    data.set(world, 0);
    data[16] = primaryColor[0];
    data[17] = primaryColor[1];
    data[18] = primaryColor[2];
    data[19] = exposureLinear;
    data[20] = contrast;
    return createUniformBuffer(engine, data);
}

// ─── DDS Cube Texture Loader ─────────────────────────────────────────────────

/** Load a DDS cube texture (rgba16float) and return a cube texture view + sampler.
 *  Uploads only mip 0 from the DDS file and generates remaining mipmaps on the
 *  GPU so that cube face edges blend seamlessly — matching BJS's behaviour. */
async function loadDdsCube(engine: EngineContextInternal, url: string): Promise<{ cubeView: GPUTextureView; sampler: GPUSampler }> {
    const device = engine.device;
    const buf = await (await fetch(url)).arrayBuffer();
    const header = new Int32Array(buf, 0, 32);
    const width = header[3]!;
    const height = header[4]!;
    const mipCount = Math.max(header[7]!, 1);

    // DDS pixel format offset 76..107 — for rgba16float, FourCC = 'DX10'
    // DDS_HEADER_DX10 at byte 128: dxgiFormat, resourceDimension, miscFlag, arraySize, etc.
    // For cube: miscFlag has RESOURCE_MISC_TEXTURECUBE (0x4), arraySize = 1 (6 faces in data)
    const dataOffset = header[21] === 0x30315844 /* 'DX10' */ ? 128 + 20 : 128;
    const raw = new Uint8Array(buf, dataOffset);

    const fmt: GPUTextureFormat = "rgba16float";
    const tex = device.createTexture({
        size: [width, height, 6],
        format: fmt,
        mipLevelCount: mipCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        dimension: "2d",
    });

    // Upload all mip levels for each face from the DDS (face-major layout).
    // Even though the skybox shader samples mip 0 explicitly, uploading all
    // mips avoids the need for GPU-side mipmap generation.
    let offset = 0;
    for (let face = 0; face < 6; face++) {
        for (let m = 0; m < mipCount; m++) {
            const s = Math.max(width >> m, 1);
            device.queue.writeTexture(
                { texture: tex, origin: { x: 0, y: 0, z: face }, mipLevel: m },
                raw.buffer,
                { offset: raw.byteOffset + offset, bytesPerRow: s * 8 },
                { width: s, height: s }
            );
            offset += s * s * 8;
        }
    }

    const cubeView = tex.createView({ dimension: "cube" });
    const sampler = getOrCreateSampler(engine, {
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        addressModeW: "clamp-to-edge",
        maxAnisotropy: 4,
    });

    return { cubeView, sampler };
}
