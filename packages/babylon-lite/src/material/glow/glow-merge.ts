import type { EngineContext } from "../../engine/engine.js";
import type { RenderTarget } from "../../engine/render-target.js";
import { createUniformBuffer } from "../../resource/uniform-buffer.js";
import { getBilinearSampler } from "../../resource/samplers.js";
import { F32 } from "../../engine/typed-arrays.js";
import { wgsl } from "../../shader/wgsl.js";

/** @internal Resolve Babylon blend constants without changing ordinary post-process blending. */
export function glowBlend(mode: number): GPUBlendState | undefined {
    switch (mode) {
        case 0:
            return undefined;
        case 1:
            return { color: { srcFactor: "src-alpha", dstFactor: "one" }, alpha: { srcFactor: "zero", dstFactor: "one" } };
        case 2:
            return { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one" } };
        case 6:
            return { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "zero", dstFactor: "one" } };
        case 7:
            return { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one" } };
        case 8:
            return { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } };
        default:
            throw new Error(`GlowPostProcessTask does not support alphaBlendingMode ${mode}.`);
    }
}

/** @internal Fullscreen material over borrowed final targets. */
export function createGlowMerge(engine: EngineContext, source: readonly [RenderTarget, RenderTarget], mode: number, ldr: boolean) {
    const blend = glowBlend(mode);
    const data = new F32([1, 0, 0, 0]);
    let device: GPUDevice | null = null;
    let buffer: GPUBuffer | null = null;
    let layout: GPUBindGroupLayout | null = null;
    let shader: GPUShaderModule | null = null;
    let pipeline: GPURenderPipeline | null = null;
    let group: GPUBindGroup | null = null;
    let lastIntensity = NaN;
    // Destination recorded last: a reassigned destination applies from the next record.
    let target: RenderTarget;
    let resolve: RenderTarget | undefined;
    let format: GPUTextureFormat | undefined;
    let samples = 0;
    const attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: "load", storeOp: "store" };
    const descriptor: GPURenderPassDescriptor = { label: "glow-merge", colorAttachments: [attachment] };
    return {
        record(destination: RenderTarget, resolveDestination: RenderTarget | undefined): void {
            target = destination;
            resolve = resolveDestination;
            if (device !== engine._device) {
                buffer?.destroy();
                device = engine._device;
                buffer = createUniformBuffer(engine, data);
                lastIntensity = NaN;
                layout = device.createBindGroupLayout({
                    label: "glow-merge-layout",
                    entries: [
                        { binding: 0, visibility: 2, sampler: { type: "filtering" } },
                        { binding: 1, visibility: 2, texture: { sampleType: "float" } },
                        { binding: 2, visibility: 2, texture: { sampleType: "float" } },
                        { binding: 3, visibility: 2, buffer: { type: "uniform" } },
                    ],
                });
                shader = device.createShaderModule({
                    label: "glow-merge",
                    code: wgsl`struct V{@builtin(position)p:vec4f,@location(0)uv:vec2f}
@vertex fn vs(@builtin(vertex_index)i:u32)->V{var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return V(vec4f(p[i],0,1),vec2f(p[i].x*0.5+0.5,0.5-p[i].y*0.5));}
@group(0)@binding(0)var s:sampler;
@group(0)@binding(1)var a:texture_2d<f32>;
@group(0)@binding(2)var b:texture_2d<f32>;
@group(0)@binding(3)var<uniform>params:vec4f;
@fragment fn fs(v:V)->@location(0)vec4f{let color=(textureSample(a,s,v.uv)+textureSample(b,s,v.uv))*params.x;return ${ldr ? "clamp(color,vec4f(0),vec4f(1))" : "color"};}`,
                });
                pipeline = null;
            }
            // The pipeline follows the destination's format and sample count; resizes only rebind the sources.
            const desc = destination._descriptor;
            if (!pipeline || desc.format !== format || (desc.samples ?? 1) !== samples) {
                format = desc.format!;
                samples = desc.samples ?? 1;
                pipeline = device.createRenderPipeline({
                    label: "glow-merge",
                    layout: device.createPipelineLayout({ bindGroupLayouts: [layout!] }),
                    vertex: { module: shader!, entryPoint: "vs" },
                    fragment: { module: shader!, entryPoint: "fs", targets: [{ format, blend }] },
                    multisample: { count: samples },
                    primitive: { topology: "triangle-list" },
                });
            }
            group = device.createBindGroup({
                layout: layout!,
                entries: [
                    { binding: 0, resource: getBilinearSampler(engine) },
                    { binding: 1, resource: source[0]._colorView! },
                    { binding: 2, resource: source[1]._colorView! },
                    { binding: 3, resource: { buffer: buffer! } },
                ],
            });
        },
        execute(intensity: number): number {
            if (intensity !== lastIntensity) {
                data[0] = intensity;
                engine._device.queue.writeBuffer(buffer!, 0, data as Float32Array<ArrayBuffer>);
                lastIntensity = intensity;
            }
            attachment.view = target._colorView!;
            attachment.resolveTarget = resolve?._colorView ?? undefined;
            const pass = engine._currentEncoder.beginRenderPass(descriptor);
            pass.setPipeline(pipeline!);
            pass.setBindGroup(0, group!);
            pass.draw(3);
            pass.end();
            return 1;
        },
        dispose(): void {
            buffer?.destroy();
            buffer = null;
            device = null;
            layout = null;
            shader = null;
            group = null;
            pipeline = null;
        },
    };
}
