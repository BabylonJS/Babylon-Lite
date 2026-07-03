import { TU, SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { getOrCreateSampler } from "../resource/gpu-pool.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { _installDepthGrab, type TransmissionDepthGrabState } from "./transmission.js";
/**
 * Lazy depth-grab implementation for `TransmissionOptions.grabDepth`. This module is dynamic-imported ONLY when a
 * task actually enables `grabDepth` (see `transmission.ts` → task `_preload`), so transmission scenes that do not
 * ask for the opaque-depth snapshot never fetch these shaders or pipelines. It installs itself into `transmission.ts`
 * via a module-level side-effect (`_installDepthGrab`) so the shared transmission chunk holds only a nullable seam.
 */

// Depth grab: copy the depth attachment's NDC depth into an `r32float` texel-for-texel (no filtering — depth must
// never be interpolated across silhouettes). The MSAA variant resolves sample 0, matching `createDepthResolveTask`.
const DEPTH_GRAB_SHADER = `@group(0)@binding(0)var t:texture_depth_2d;struct V{@builtin(position)p:vec4f};@vertex fn vs(@builtin(vertex_index)i:u32)->V{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];return V(vec4f(p,0,1));}@fragment fn fs(@builtin(position)fc:vec4f)->@location(0)f32{return textureLoad(t,vec2<i32>(fc.xy),0);}`;
const DEPTH_GRAB_MSAA_SHADER = `@group(0)@binding(0)var t:texture_depth_multisampled_2d;struct V{@builtin(position)p:vec4f};@vertex fn vs(@builtin(vertex_index)i:u32)->V{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];return V(vec4f(p,0,1));}@fragment fn fs(@builtin(position)fc:vec4f)->@location(0)f32{return textureLoad(t,vec2<i32>(fc.xy),0);}`;

// Depth-grab pipeline cache (single-sample + MSAA variants), reset on device change like the colour blits.
let depthGrabPipelines: Map<string, GPURenderPipeline> | null = null;
let depthGrabShader: GPUShaderModule | null = null;
let depthGrabMsaaShader: GPUShaderModule | null = null;
let depthGrabBgl: GPUBindGroupLayout | null = null;
let depthGrabMsaaBgl: GPUBindGroupLayout | null = null;
let depthGrabDevice: GPUDevice | null = null;

/** Lazily build + cache the depth-grab pipeline (single-sample or MSAA sample-0 resolve), reset on device change. */
function getDepthGrabPipeline(engine: EngineContext, multisampled: boolean): GPURenderPipeline {
    const device = engine._device;
    if (device !== depthGrabDevice) {
        depthGrabPipelines?.clear();
        depthGrabPipelines = null;
        depthGrabShader = null;
        depthGrabMsaaShader = null;
        depthGrabBgl = null;
        depthGrabMsaaBgl = null;
        depthGrabDevice = device;
    }
    if (multisampled) {
        depthGrabMsaaShader ??= device.createShaderModule({ code: DEPTH_GRAB_MSAA_SHADER });
        depthGrabMsaaBgl ??= device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: "depth", multisampled: true } }],
        });
    } else {
        depthGrabShader ??= device.createShaderModule({ code: DEPTH_GRAB_SHADER });
        depthGrabBgl ??= device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: "depth" } }],
        });
    }
    depthGrabPipelines ??= new Map();
    const key = multisampled ? "msaa" : "1x";
    let pipeline = depthGrabPipelines.get(key);
    if (!pipeline) {
        const shader = multisampled ? depthGrabMsaaShader! : depthGrabShader!;
        pipeline = device.createRenderPipeline({
            label: "transmission-depth-grab",
            layout: device.createPipelineLayout({ bindGroupLayouts: [multisampled ? depthGrabMsaaBgl! : depthGrabBgl!] }),
            vertex: { module: shader, entryPoint: "vs" },
            fragment: { module: shader, entryPoint: "fs", targets: [{ format: "r32float" }] },
            primitive: { topology: "triangle-list" },
        });
        depthGrabPipelines.set(key, pipeline);
    }
    return pipeline;
}

/** Build the depth-grab target (`r32float`, source-sized) + the blit that resolves the task's depth attachment into
 *  it. The source view is depth-only so combined depth-stencil formats sample cleanly. */
function createDepthGrab(engine: EngineContext, source: GPUTexture, width: number, height: number, multisampled: boolean): TransmissionDepthGrabState {
    const device = engine._device;
    const texture = device.createTexture({
        label: "transmission-depth-grab",
        size: { width, height },
        format: "r32float",
        usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING,
    });
    const view = texture.createView();
    const tex = {
        texture,
        view,
        sampler: getOrCreateSampler(engine, { magFilter: "nearest", minFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
        width,
        height,
        invertY: false,
        _sampleType: "float", // r32float samples as unfilterable float (read with textureLoad)
    } as unknown as Texture2D;
    const pipeline = getDepthGrabPipeline(engine, multisampled);
    const bindGroup = device.createBindGroup({
        layout: multisampled ? depthGrabMsaaBgl! : depthGrabBgl!,
        entries: [{ binding: 0, resource: source.createView({ aspect: "depth-only" }) }],
    });
    return { texture: tex, _view: view, _blit: { _pipeline: pipeline, _bindGroup: bindGroup } };
}

/** Per-frame: record the depth-grab resolve pass into the frame encoder at the transmission mid-pass break. Kept
 *  here (not in `transmission.ts`) so its render-pass descriptor bytes only load with the rest of the feature. */
function recordDepthGrab(engine: EngineContext, depth: TransmissionDepthGrabState): void {
    const pass = engine._currentEncoder.beginRenderPass({
        label: "transmission-depth-grab",
        colorAttachments: [{ view: depth._view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(depth._blit._pipeline);
    pass.setBindGroup(0, depth._blit._bindGroup);
    pass.draw(3);
    pass.end();
}

// Module-level side-effect install (see the pbr-primitive-resolver pattern): importing this module wires the
// depth-grab builder + per-frame recorder into the shared transmission seam. Keeps `transmission.ts` free of these
// bytes until a task actually enables grabDepth.
_installDepthGrab({ create: createDepthGrab, record: recordDepthGrab });
