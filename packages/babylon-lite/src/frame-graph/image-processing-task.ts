import { F32 } from "../engine/typed-arrays.js";
import { BU, SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { Task } from "./task.js";

/** Source of the color image to post-process: a texture, a render target, or a getter returning one (resolved each record). */
export type ImageProcessingSource = Texture2D | RenderTarget | (() => Texture2D | RenderTarget | null | undefined);

/** Configuration for `createImageProcessingTask`: the color source to apply exposure/contrast/tone-mapping to. */
export interface ImageProcessingTaskConfig {
    name?: string;
    source: ImageProcessingSource;
}

interface ImageProcessingState {
    pipeline: GPURenderPipeline;
    bindGroup: GPUBindGroup;
    params: GPUBuffer;
}

/**
 * Create a frame-graph task that applies the scene's image-processing settings
 * (exposure, contrast, tone mapping) to a color source and draws it to the swapchain.
 * @param config - The color source to process.
 * @param engine - The owning engine.
 * @param scene - The scene whose `imageProcessing` settings drive the effect.
 * @returns The task to add to the frame graph.
 */
export function createImageProcessingTask(config: ImageProcessingTaskConfig, engine: EngineContext, scene: SceneContext): Task {
    let state: ImageProcessingState | null = null;
    const task: Task = {
        name: config.name ?? "image-processing",
        engine,
        scene,
        _passes: [],
        record(): void {
            disposeImageProcessingState(state);
            state = createImageProcessingState(engine, config.source);
        },
        execute(): number {
            if (!state) {
                return 0;
            }
            const img = scene.imageProcessing as { exposure: number; contrast: number; toneMappingEnabled: boolean | number };
            const data = new F32([img.exposure, img.contrast, img.toneMappingEnabled === true ? 1 : 0, 0]);
            engine._device.queue.writeBuffer(state.params, 0, data);
            const pass = engine._currentEncoder.beginRenderPass({
                colorAttachments: [
                    {
                        view: engine.scRT._colorView!,
                        loadOp: "clear",
                        storeOp: "store",
                        clearValue: scene.clearColor,
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

function createImageProcessingState(engine: EngineContext, source: ImageProcessingSource): ImageProcessingState {
    const texture = resolveImageProcessingTexture(source);
    if (!texture) {
        throw new Error("Image processing source has no color texture");
    }
    const device = engine._device;
    const sampleCount = (texture as { sampleCount?: number }).sampleCount ?? 1;
    const multisampled = sampleCount > 1;
    const params = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    const bgl = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: SS.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: SS.FRAGMENT, texture: { sampleType: multisampled ? "unfilterable-float" : "float", multisampled } },
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
