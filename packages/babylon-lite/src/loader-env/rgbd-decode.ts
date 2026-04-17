/** RGBD PNG decoder — decodes Babylon's pre-baked RGBD-encoded textures
 *  (BRDF LUT + cubemap faces) into rgba16float via a shared compute pipeline.
 *
 *  Both callers live in the .env loader path; sharing the shader module and
 *  pipeline cache avoids duplicating ~700 bytes of WGSL + boilerplate.
 */

import type { EngineContextInternal } from "../engine/engine.js";

// Single WGSL; `flipY` override lets cubemap face upload flip Y (BJS uses
// invertY=true) while the BRDF LUT path uses a direct copy.
const WGSL =
    `override flipY:bool=false;` +
    `@group(0) @binding(0) var inputTex:texture_2d<f32>;` +
    `@group(0) @binding(1) var outputTex:texture_storage_2d<rgba16float,write>;` +
    `@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) gid:vec3u){` +
    `let dims=textureDimensions(inputTex);` +
    `if(gid.x>=dims.x||gid.y>=dims.y){return;}` +
    `let srcY=select(gid.y,dims.y-1u-gid.y,flipY);` +
    `let rgba=textureLoad(inputTex,vec2u(gid.x,srcY),0);` +
    `let a=max(rgba.a,1.0/255.0);` +
    `textureStore(outputTex,vec2u(gid.x,gid.y),vec4f(pow(rgba.rgb,vec3f(2.2))/a,1.0));` +
    `}`;

let _device: GPUDevice | null = null;
let _module: GPUShaderModule | null = null;
let _noFlip: GPUComputePipeline | null = null;
let _flip: GPUComputePipeline | null = null;

function getPipeline(device: GPUDevice, flipY: boolean): GPUComputePipeline {
    if (device !== _device) {
        _device = device;
        _module = device.createShaderModule({ code: WGSL });
        _noFlip = null;
        _flip = null;
    }
    const slot = flipY ? _flip : _noFlip;
    if (slot) {
        return slot;
    }
    const p = device.createComputePipeline({
        layout: "auto",
        compute: { module: _module!, entryPoint: "main", constants: { flipY: flipY ? 1 : 0 } },
    });
    if (flipY) {
        _flip = p;
    } else {
        _noFlip = p;
    }
    return p;
}

function makeBindGroup(device: GPUDevice, pipeline: GPUComputePipeline, inView: GPUTextureView, outView: GPUTextureView): GPUBindGroup {
    return device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: inView },
            { binding: 1, resource: outView },
        ],
    });
}

function encodeDispatch(encoder: GPUCommandEncoder, pipeline: GPUComputePipeline, bg: GPUBindGroup, w: number, h: number): void {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
}

/** Decode a single RGBD PNG (e.g. BRDF LUT) → rgba16float 2D texture. No Y-flip. */
export function decodeBrdfPng(engine: EngineContextInternal, image: ImageBitmap): GPUTexture {
    const device = engine.device;
    const pipeline = getPipeline(device, false);
    const w = image.width;
    const h = image.height;
    const inputTex = device.createTexture({
        size: { width: w, height: h },
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: image, flipY: false }, { texture: inputTex, premultipliedAlpha: false }, { width: w, height: h });
    const texture = device.createTexture({
        size: { width: w, height: h },
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    const bg = makeBindGroup(device, pipeline, inputTex.createView(), texture.createView());
    const enc = device.createCommandEncoder();
    encodeDispatch(enc, pipeline, bg, w, h);
    device.queue.submit([enc.finish()]);
    inputTex.destroy();
    return texture;
}

/** Decode and upload a RGBD cubemap (6 faces × N mips) → rgba16float cube texture.
 *  Y-flipped on read (BJS uploads cubemap faces with invertY=true). */
export function uploadCubemapRGBD(engine: EngineContextInternal, images: ImageBitmap[], width: number, mipCount: number): GPUTexture {
    const device = engine.device;
    const pipeline = getPipeline(device, true);

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

        const bindGroup = makeBindGroup(device, pipeline, inputTex.createView(), outputTex.createView());

        for (let face = 0; face < 6; face++) {
            const idx = mip * 6 + face;
            if (idx >= images.length) {
                break;
            }

            device.queue.copyExternalImageToTexture({ source: images[idx]!, flipY: false }, { texture: inputTex, premultipliedAlpha: false }, { width: mipSize, height: mipSize });

            const encoder = device.createCommandEncoder();
            encodeDispatch(encoder, pipeline, bindGroup, mipSize, mipSize);
            encoder.copyTextureToTexture({ texture: outputTex }, { texture, origin: { x: 0, y: 0, z: face }, mipLevel: mip }, { width: mipSize, height: mipSize });

            // One submit per face ensures sequential hazards on the reused input/output.
            device.queue.submit([encoder.finish()]);
        }

        inputTex.destroy();
        outputTex.destroy();
    }

    return texture;
}
