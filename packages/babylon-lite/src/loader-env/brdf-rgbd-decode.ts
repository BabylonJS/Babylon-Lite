/** BRDF RGBD PNG decoder — decodes a pre-baked RGBD-encoded BRDF LUT
 *  (matching BJS's embedded environmentBRDFTexture) into rgba16float via compute. */

import type { EngineContextInternal } from "../engine/engine.js";

// Pre-minified WGSL — TS comments stripped at build time, WGSL inline stays lean
const WGSL = `@group(0) @binding(0) var inputTex:texture_2d<f32>;@group(0) @binding(1) var outputTex:texture_storage_2d<rgba16float,write>;@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) gid:vec3u){let dims=textureDimensions(inputTex);if(gid.x>=dims.x||gid.y>=dims.y){return;}let rgba=textureLoad(inputTex,vec2u(gid.x,gid.y),0);let a=max(rgba.a,1.0/255.0);textureStore(outputTex,vec2u(gid.x,gid.y),vec4f(pow(rgba.rgb,vec3f(2.2))/a,1.0));}`;

let _pipeline: GPUComputePipeline | null = null;
let _pipelineDevice: GPUDevice | null = null;

export function decodeBrdfPng(engine: EngineContextInternal, image: ImageBitmap): GPUTexture {
    const device = engine.device;
    if (device !== _pipelineDevice) {
        _pipeline = null;
        _pipelineDevice = device;
    }
    if (!_pipeline) {
        _pipeline = device.createComputePipeline({
            layout: "auto",
            compute: { module: device.createShaderModule({ code: WGSL }), entryPoint: "main" },
        });
    }
    const p = _pipeline;
    const w = image.width,
        h = image.height;
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
    const bg = device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: inputTex.createView() },
            { binding: 1, resource: texture.createView() },
        ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(p);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    device.queue.submit([enc.finish()]);
    inputTex.destroy();
    return texture;
}
