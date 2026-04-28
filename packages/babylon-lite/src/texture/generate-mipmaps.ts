/**
 * GPU mipmap generation via render-pass blit.
 * WebGPU has no built-in generateMipmaps() — we render a fullscreen triangle
 * from mip N-1 → mip N for each level. For sRGB textures, the GPU automatically
 * converts sRGB→linear on read and linear→sRGB on write, so filtering is correct.
 */

import type { EngineContextInternal } from "../engine/engine.js";
import { getBilinearSampler } from "../resource/gpu-pool.js";

// Compact fullscreen-triangle blit shader (inline WGSL — minimal whitespace per GUIDANCE.md)
const BLIT_SHADER = `@group(0)@binding(0) var t:texture_2d<f32>;@group(0)@binding(1) var s:sampler;
struct V{@builtin(position) p:vec4<f32>,@location(0) u:vec2<f32>};
@vertex fn vs(@builtin(vertex_index) i:u32)->V{var a=array<vec2<f32>,3>(vec2<f32>(-1,-1),vec2<f32>(3,-1),vec2<f32>(-1,3));var b=array<vec2<f32>,3>(vec2<f32>(0,1),vec2<f32>(2,1),vec2<f32>(0,-1));return V(vec4<f32>(a[i],0,1),b[i]);}
@fragment fn fs(v:V)->@location(0) vec4<f32>{return textureSample(t,s,v.u);}`;

// Cached resources (created once per device, reused across all textures)
let pipelineCache: Map<string, GPURenderPipeline> | null = null;
let shaderModule: GPUShaderModule | null = null;
let linearSampler: GPUSampler | null = null;
let bindGroupLayout: GPUBindGroupLayout | null = null;
let _cachedDevice: GPUDevice | null = null;

/** Clear cached mipmap generation resources. Must be called when a GPU device is destroyed. */
function clearMipmapCache(): void {
    pipelineCache?.clear();
    pipelineCache = null;
    shaderModule = null;
    linearSampler = null;
    bindGroupLayout = null;
    _cachedDevice = null;
}

function ensureResources(engine: EngineContextInternal): void {
    const device = engine.device;
    if (device !== _cachedDevice) {
        clearMipmapCache();
        _cachedDevice = device;
    }
    if (!shaderModule) {
        shaderModule = device.createShaderModule({ code: BLIT_SHADER });
    }
    if (!linearSampler) {
        linearSampler = getBilinearSampler(engine);
    }
    if (!bindGroupLayout) {
        bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            ],
        });
    }
}

function getPipeline(engine: EngineContextInternal, format: GPUTextureFormat): GPURenderPipeline {
    const device = engine.device;
    ensureResources(engine);
    if (!pipelineCache) {
        pipelineCache = new Map();
    }
    let pipeline = pipelineCache.get(format);
    if (!pipeline) {
        pipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout!] }),
            vertex: { module: shaderModule!, entryPoint: "vs" },
            fragment: {
                module: shaderModule!,
                entryPoint: "fs",
                targets: [{ format }],
            },
            primitive: { topology: "triangle-list" },
        });
        pipelineCache.set(format, pipeline);
    }
    return pipeline;
}

/** Generate mip chain for a 2D texture via GPU blit. Works for cube faces via optional `face` layer index. */
export function generateMipmaps(engine: EngineContextInternal, texture: GPUTexture, face?: number): void {
    const device = engine.device;
    if (texture.mipLevelCount <= 1) {
        return;
    }

    const pipeline = getPipeline(engine, texture.format);
    const encoder = device.createCommandEncoder();
    const vp = face != null ? { dimension: "2d" as const, baseArrayLayer: face, arrayLayerCount: 1 } : {};

    for (let mip = 1; mip < texture.mipLevelCount; mip++) {
        const srcView = texture.createView({ baseMipLevel: mip - 1, mipLevelCount: 1, ...vp });
        const dstView = texture.createView({ baseMipLevel: mip, mipLevelCount: 1, ...vp });

        const bindGroup = device.createBindGroup({
            layout: bindGroupLayout!,
            entries: [
                { binding: 0, resource: srcView },
                { binding: 1, resource: linearSampler! },
            ],
        });

        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: dstView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
        });

        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
    }

    device.queue.submit([encoder.finish()]);
}
