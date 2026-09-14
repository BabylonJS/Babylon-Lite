/**
 * GPU mipmap generation via render-pass blit.
 * WebGPU has no built-in generateMipmaps() — we render a fullscreen triangle
 * from mip N-1 → mip N for each level. For sRGB textures, the GPU automatically
 * converts sRGB→linear on read and linear→sRGB on write, so filtering is correct.
 */

import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { getBilinearSampler } from "../resource/samplers.js";
import { wgsl } from "../shader/wgsl.js";

const BLIT_SHADER = wgsl`@group(0)@binding(0)var t:texture_2d<f32>;@group(0)@binding(1)var s:sampler;
struct V{@builtin(position)p:vec4f,@location(0)u:vec2f};
@vertex fn vs(@builtin(vertex_index)i:u32)->V{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];return V(vec4f(p,0,1),p*vec2f(.5,-.5)+.5);}
@fragment fn fs(v:V)->@location(0)vec4f{return textureSample(t,s,v.u);}`;

let pipelineCache: Map<string, GPURenderPipeline> | null = null;
let shaderModule: GPUShaderModule | null = null;
let linearSampler: GPUSampler | null = null;
let bindGroupLayout: GPUBindGroupLayout | null = null;
let cachedDevice: GPUDevice | null = null;

function clearCache(): void {
    pipelineCache?.clear();
    pipelineCache = null;
    shaderModule = null;
    linearSampler = null;
    bindGroupLayout = null;
    cachedDevice = null;
}

function ensureResources(engine: EngineContext): void {
    const device = engine._device;
    if (device !== cachedDevice) {
        clearCache();
        cachedDevice = device;
    }
    shaderModule ??= device.createShaderModule({ code: BLIT_SHADER });
    linearSampler ??= getBilinearSampler(engine);
    bindGroupLayout ??= device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: "float" } },
            { binding: 1, visibility: SS.FRAGMENT, sampler: {} },
        ],
    });
}

function getPipeline(engine: EngineContext, format: GPUTextureFormat): GPURenderPipeline {
    const device = engine._device;
    ensureResources(engine);
    pipelineCache ??= new Map();
    let pipeline = pipelineCache.get(format);
    if (!pipeline) {
        pipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout!] }),
            vertex: { module: shaderModule!, entryPoint: "vs" },
            fragment: { module: shaderModule!, entryPoint: "fs", targets: [{ format }] },
            primitive: { topology: "triangle-list" },
        });
        pipelineCache.set(format, pipeline);
    }
    return pipeline;
}

/** Generate mip chain for a 2D texture via GPU blit. Works for cube faces via optional `face` layer index. */
export function generateMipmaps(engine: EngineContext, texture: GPUTexture, face?: number): void {
    const device = engine._device;
    const encoder = device.createCommandEncoder();
    recordMipmaps(engine, texture, encoder, face);
    device.queue.submit([encoder.finish()]);
}

export function recordMipmaps(engine: EngineContext, texture: GPUTexture, encoder: GPUCommandEncoder, face?: number): void {
    recordPreparedMipmaps(encoder, prepareMipmaps(engine, texture, face));
}

export interface PreparedMipmapLevel {
    readonly pipeline: GPURenderPipeline;
    readonly bindGroup: GPUBindGroup;
    readonly descriptor: GPURenderPassDescriptor;
}

/** Prebuild views, bind groups, and render-pass descriptors for repeated mip regeneration. */
export function prepareMipmaps(engine: EngineContext, texture: GPUTexture, face?: number): PreparedMipmapLevel[] {
    if (texture.mipLevelCount <= 1) {
        return [];
    }
    const device = engine._device;
    const pipeline = getPipeline(engine, texture.format);
    const vp = face != null ? { dimension: "2d" as const, baseArrayLayer: face, arrayLayerCount: 1 } : {};
    const prepared: PreparedMipmapLevel[] = [];
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
        prepared.push({
            pipeline,
            bindGroup,
            descriptor: { colorAttachments: [{ view: dstView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] },
        });
    }
    return prepared;
}

/** Record a previously prepared mip chain without creating per-frame GPU objects. */
export function recordPreparedMipmaps(encoder: GPUCommandEncoder, prepared: readonly PreparedMipmapLevel[]): void {
    for (const level of prepared) {
        const pass = encoder.beginRenderPass(level.descriptor);
        pass.setPipeline(level.pipeline);
        pass.setBindGroup(0, level.bindGroup);
        pass.draw(3);
        pass.end();
    }
}
