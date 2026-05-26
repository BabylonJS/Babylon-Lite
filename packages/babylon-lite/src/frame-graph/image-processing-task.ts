import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import type { SceneContext, SceneContextInternal } from "../scene/scene-core.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { Task } from "./task.js";

export type ImageProcessingSource = Texture2D | RenderTarget | (() => Texture2D | RenderTarget | null | undefined);

export interface ImageProcessingTaskConfig {
    name?: string;
    source: ImageProcessingSource;
}

interface ImageProcessingState {
    pipeline: GPURenderPipeline;
    bindGroup: GPUBindGroup;
    params: GPUBuffer;
}

export function createImageProcessingTask(config: ImageProcessingTaskConfig, engine: EngineContext, scene: SceneContext): Task {
    const eng = engine as EngineContextInternal;
    const sc = scene as SceneContextInternal;
    let state: ImageProcessingState | null = null;
    const task: Task = {
        name: config.name ?? "image-processing",
        engine: eng,
        scene: sc,
        _passes: [],
        record(): void {
            disposeImageProcessingState(state);
            state = createImageProcessingState(eng, config.source);
        },
        execute(): number {
            if (!state) {
                return 0;
            }
            const img = sc.imageProcessing as { exposure: number; contrast: number; toneMappingEnabled: boolean | number };
            const data = new Float32Array([img.exposure, img.contrast, img.toneMappingEnabled === true ? 1 : 0, 0]);
            eng.device.queue.writeBuffer(state.params, 0, data);
            const pass = eng._currentEncoder.beginRenderPass({
                colorAttachments: [
                    {
                        view: eng._swapchainView,
                        loadOp: "clear",
                        storeOp: "store",
                        clearValue: sc.clearColor,
                    },
                ],
            });
            pass.setPipeline(state.pipeline);
            pass.setBindGroup(0, state.bindGroup);
            pass.draw(3);
            pass.end();
            return 1;
        },
        dispose(): void {
            disposeImageProcessingState(state);
            state = null;
            this._passes.length = 0;
        },
    };
    return task;
}

function createImageProcessingState(engine: EngineContextInternal, source: ImageProcessingSource): ImageProcessingState {
    const texture = resolveImageProcessingTexture(source);
    if (!texture) {
        throw new Error("Image processing source has no color texture");
    }
    const device = engine.device;
    const sampleCount = (texture as { sampleCount?: number }).sampleCount ?? 1;
    const multisampled = sampleCount > 1;
    const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bgl = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: multisampled ? "unfilterable-float" : "float", multisampled } },
        ],
    });
    const common = `struct P{e:f32,c:f32,t:f32,p:f32}
@group(0)@binding(0)var<uniform> p:P;
@vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position) vec4f{var a=array<vec2f,3>(vec2f(-1,-3),vec2f(3,1),vec2f(-1,1));return vec4f(a[i],0,1);}
fn ip(r:vec4f)->vec4f{var c=r.rgb*p.e;
if(p.t>0.5){c=1.0-exp2(-1.590579*c);}
c=clamp(pow(max(c,vec3f(0)),vec3f(1/2.2)),vec3f(0),vec3f(1));
let h=c*c*(3.0-2.0*c);
if(p.c<1.0){c=mix(vec3f(0.5),c,p.c);}else{c=mix(c,h,p.c-1.0);}
return vec4f(max(c,vec3f(0)),r.a);}`;
    const textureDecl = multisampled ? `@group(0)@binding(1)var s:texture_multisampled_2d<f32>;` : `@group(0)@binding(1)var s:texture_2d<f32>;`;
    const fragment = multisampled
        ? `@fragment fn fs(@builtin(position) q:vec4f)->@location(0) vec4f{let d=textureDimensions(s);let px=clamp(vec2i(q.xy),vec2i(0),vec2i(d)-1);let n=textureNumSamples(s);var c=vec4f(0);for(var i=0u;i<n;i++){c+=ip(textureLoad(s,px,i));}return c/f32(n);}`
        : `@fragment fn fs(@builtin(position) q:vec4f)->@location(0) vec4f{let d=textureDimensions(s);return ip(textureLoad(s,clamp(vec2i(q.xy),vec2i(0),vec2i(d)-1),0));}`;
    const shader = device.createShaderModule({ code: `${common}${textureDecl}${fragment}` });
    const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        vertex: { module: shader, entryPoint: "vs" },
        fragment: { module: shader, entryPoint: "fs", targets: [{ format: engine.format }] },
        primitive: { topology: "triangle-list" },
    });
    const bindGroup = device.createBindGroup({
        layout: bgl,
        entries: [
            { binding: 0, resource: { buffer: params } },
            { binding: 1, resource: texture.createView() },
        ],
    });
    return { pipeline, bindGroup, params };
}

function resolveImageProcessingTexture(source: ImageProcessingSource): GPUTexture | null {
    const resolved = typeof source === "function" ? source() : source;
    if (!resolved) {
        return null;
    }
    if ("_colorTexture" in resolved) {
        return resolved._colorTexture;
    }
    return resolved.texture;
}

function disposeImageProcessingState(state: ImageProcessingState | null | undefined): void {
    state?.params.destroy();
}
