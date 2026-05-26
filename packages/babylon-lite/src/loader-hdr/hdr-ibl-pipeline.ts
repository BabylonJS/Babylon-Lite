/**
 * HDR IBL Pipeline (GPU compute)
 *
 * GPU compute shaders for equirect→cubemap conversion,
 * importance-sampled GGX cubemap prefiltering, and BRDF LUT generation.
 */

import type { HdrImage } from "./hdr-parser.js";
import type { EngineContextInternal } from "../engine/engine.js";
import { getBilinearSampler } from "../resource/samplers.js";
import { createUniformBuffer, createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import equirectToCubeWGSL from "../../shaders/hdr-equirect-to-cube.compute.wgsl?raw";
import prefilterCubeWGSL from "../../shaders/hdr-prefilter-cube.compute.wgsl?raw";
import brdfLutWGSL from "../../shaders/hdr-brdf-lut.compute.wgsl?raw";

export function equirectToCubemapGPU(engine: EngineContextInternal, hdr: HdrImage, faceSize: number): GPUTexture {
    const device = engine.device;
    // Upload equirect as a 2D texture
    const equirectTex = device.createTexture({
        size: [hdr.width, hdr.height],
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    {
        const rgba = new Float32Array(hdr.width * hdr.height * 4);
        for (let i = 0; i < hdr.width * hdr.height; i++) {
            rgba[i * 4] = hdr.data[i * 3]!;
            rgba[i * 4 + 1] = hdr.data[i * 3 + 1]!;
            rgba[i * 4 + 2] = hdr.data[i * 3 + 2]!;
            rgba[i * 4 + 3] = 1;
        }
        device.queue.writeTexture({ texture: equirectTex }, rgba.buffer, { bytesPerRow: hdr.width * 16 }, { width: hdr.width, height: hdr.height });
    }

    // Create the output cubemap
    const cubeTex = device.createTexture({
        size: [faceSize, faceSize, 6],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        dimension: "2d",
    });

    // Run compute shader (uses BJS face corners + CalcProjectionSpherical)
    const module = device.createShaderModule({ code: equirectToCubeWGSL });
    const pipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module, entryPoint: "main" },
    });
    const paramBuf = createUniformBuffer(engine, new Uint32Array([faceSize, hdr.width, hdr.height, 0]));

    const bg = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: equirectTex.createView() },
            { binding: 1, resource: cubeTex.createView({ dimension: "2d-array", arrayLayerCount: 6 }) },
            { binding: 2, resource: { buffer: paramBuf } },
        ],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(faceSize / 8), Math.ceil(faceSize / 8), 6);
    pass.end();
    device.queue.submit([enc.finish()]);

    equirectTex.destroy();
    paramBuf.destroy();
    return cubeTex;
}

// ─── Cubemap Prefiltering (GPU Compute, Importance-Sampled GGX) ─────────────

export function prefilterCubemapGPU(engine: EngineContextInternal, srcCube: GPUTexture, faceSize: number, mipCount: number): GPUTexture {
    const device = engine.device;
    const dstCube = device.createTexture({
        size: { width: faceSize, height: faceSize, depthOrArrayLayers: 6 },
        mipLevelCount: mipCount,
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
    });

    const srcCubeView = srcCube.createView({ dimension: "cube" });
    const srcSampler = getBilinearSampler(engine);

    const pipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module: device.createShaderModule({ code: prefilterCubeWGSL }), entryPoint: "main" },
    });

    const paramsBuffer = createEmptyUniformBuffer(engine, 16);

    // LOD 0: exact texel copy (no bilinear resampling) to match BJS
    {
        const copyEnc = device.createCommandEncoder();
        copyEnc.copyTextureToTexture({ texture: srcCube }, { texture: dstCube, mipLevel: 0 }, { width: faceSize, height: faceSize, depthOrArrayLayers: 6 });
        device.queue.submit([copyEnc.finish()]);
    }

    // LODs 1+: importance-sampled GGX prefilter
    for (let mip = 1; mip < mipCount; mip++) {
        const mipSize = faceSize >> mip;
        if (mipSize < 1) {
            break;
        }

        device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([faceSize, mip, mipCount, faceSize]));

        const dstView = dstCube.createView({
            dimension: "2d-array",
            baseMipLevel: mip,
            mipLevelCount: 1,
            baseArrayLayer: 0,
            arrayLayerCount: 6,
        });

        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: srcCubeView },
                { binding: 1, resource: srcSampler },
                { binding: 2, resource: dstView },
                { binding: 3, resource: { buffer: paramsBuffer } },
            ],
        });

        // One submit per mip ensures params buffer is consumed before next writeBuffer
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(mipSize / 8), Math.ceil(mipSize / 8), 6);
        pass.end();
        device.queue.submit([encoder.finish()]);
    }

    srcCube.destroy();
    paramsBuffer.destroy();
    return dstCube;
}

// ─── BRDF LUT ───────────────────────────────────────────────────────────────

let _brdfPipeline: GPUComputePipeline | null = null;
let _brdfPipelineDevice: GPUDevice | null = null;

export function generateBrdfLut(engine: EngineContextInternal): GPUTexture {
    const device = engine.device;
    if (!_brdfPipeline || _brdfPipelineDevice !== device) {
        _brdfPipeline = device.createComputePipeline({
            layout: "auto",
            compute: { module: device.createShaderModule({ code: brdfLutWGSL }), entryPoint: "main" },
        });
        _brdfPipelineDevice = device;
    }
    const size = 256;
    const texture = device.createTexture({
        size: { width: size, height: size },
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    const bindGroup = device.createBindGroup({
        layout: _brdfPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: texture.createView() }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(_brdfPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
    pass.end();
    device.queue.submit([encoder.finish()]);
    return texture;
}
