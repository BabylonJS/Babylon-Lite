/**
 * DepthResolveTask — resolve a multisampled depth attachment into a single-sample depth texture.
 *
 * A multisampled depth texture can't be bound to a normal shader (no sampler/textureSample path), so any pass
 * that SAMPLES the scene depth (a screen-space shadow stabiliser, screen-space contact shadows, SSAO — all of
 * which reconstruct world position from depth) breaks once the scene renders to an MSAA target. This task
 * bridges that: a full-screen triangle reads sample 0 of the source `texture_depth_multisampled_2d` and writes
 * it to `@builtin(frag_depth)` through a depth-only render pass (no colour attachment) targeting a single-sample
 * destination depth.
 *
 * Sample 0 (not an average) is deliberate — depth is non-linear, so averaging samples is meaningless; sample 0
 * is a real surface depth at each pixel, which is exactly what depth-reconstruction consumers need. Modelled on
 * copy-to-texture-task's raw-pipeline pattern (cached pipeline + bind-group layout per device).
 */

import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { buildRenderTarget } from "../engine/render-target.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Task } from "./task.js";

/** Options for a depth-resolve frame-graph task. */
export interface DepthResolveTaskConfig {
    name?: string;
    /** Multisampled source render target whose DEPTH attachment is resolved (must have sampleCount \> 1). */
    sourceTexture: RenderTarget;
    /** Single-sample destination render target whose DEPTH attachment receives the resolved depth. */
    targetTexture: RenderTarget;
}

const VERTEX_WGSL = `struct V{@builtin(position)p:vec4f};
@vertex fn vs(@builtin(vertex_index)i:u32)->V{
var pos=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
return V(vec4f(pos[i],0,1));}`;
const FRAGMENT_WGSL = `@group(0)@binding(0)var src:texture_depth_multisampled_2d;
@fragment fn fs(v:V)->@builtin(frag_depth)f32{return textureLoad(src,vec2i(v.p.xy),0);}`;

// Per-device cache (keyed by GPUDevice identity), lazily built on first use so scenes that never resolve depth
// pay nothing.
let _cacheDevice: GPUDevice | null = null;
let _bgl: GPUBindGroupLayout | null = null;
let _pipelines: Map<GPUTextureFormat, GPURenderPipeline> | null = null;

function getOrCreatePipeline(engine: EngineContext, depthFormat: GPUTextureFormat): GPURenderPipeline {
    const device = engine._device;
    if (_cacheDevice !== device) {
        _cacheDevice = device;
        _bgl = null;
        _pipelines = new Map();
    }
    const cached = _pipelines!.get(depthFormat);
    if (cached) {
        return cached;
    }
    _bgl ??= device.createBindGroupLayout({
        label: "depth-resolve-bgl",
        entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: "depth", multisampled: true } }],
    });
    const module = device.createShaderModule({ code: `${VERTEX_WGSL}\n${FRAGMENT_WGSL}`, label: "depth-resolve" });
    const pipeline = device.createRenderPipeline({
        label: `depth-resolve-${depthFormat}`,
        layout: device.createPipelineLayout({ label: "depth-resolve-layout", bindGroupLayouts: [_bgl] }),
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [] }, // depth-only: no colour target
        primitive: { topology: "triangle-list" },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: "always" },
    });
    _pipelines!.set(depthFormat, pipeline);
    return pipeline;
}

/** Create a frame-graph task that resolves `sourceTexture`'s multisampled depth into `targetTexture`'s
 *  single-sample depth. Add it AFTER the source render task and BEFORE any depth-sampling consumer. */
export function createDepthResolveTask(config: DepthResolveTaskConfig, engine: EngineContext, scene: SceneContext): Task {
    const eng = engine;
    const depthAttachment: GPURenderPassDepthStencilAttachment = {
        view: undefined!,
        depthClearValue: 0, // every fragment overwrites it (depthCompare "always"), so the clear value is moot
        depthLoadOp: "clear",
        depthStoreOp: "store",
    };
    const renderPassDescriptor: GPURenderPassDescriptor = {
        label: config.name ?? "depth-resolve",
        colorAttachments: [],
        depthStencilAttachment: depthAttachment,
    };
    let pipeline: GPURenderPipeline | null = null;
    let bindGroup: GPUBindGroup | null = null;
    let boundSrc: GPUTexture | null = null;
    let boundDst: GPUTexture | null = null;

    // (Re)build the pipeline, bind group and depth-attachment view from the live RT textures. Run at record()
    // and again whenever a resize reallocates either texture (checked in execute, mirroring the DoF getters).
    const build = (): void => {
        const source = config.sourceTexture;
        const target = config.targetTexture;
        if (!source._depthTexture) {
            throw new Error(`DepthResolveTask "${config.name}": sourceTexture has no depth attachment.`);
        }
        if ((source._descriptor.samples ?? 1) < 2) {
            throw new Error(`DepthResolveTask "${config.name}": sourceTexture must be multisampled (sampleCount > 1).`);
        }
        if (!target._depthTexture || target._width !== (source._width || 0) || target._height !== (source._height || 0)) {
            // Build (or REBUILD) the offscreen destination so it tracks the source size. No render task owns this
            // target, so the frame graph never resizes it on its own — without this, a window resize leaves the
            // resolved depth stuck at the OLD size, and every depth-reconstruction consumer (SSCS, SSAO, the
            // shadow-TAA stabiliser) then samples a mismatched-size depth → screen-space streaks until reload.
            buildRenderTarget(target, eng);
            // buildRenderTarget sizes the target from its OWN descriptor (resolveSize), not the source. The whole
            // point of this task is a 1:1 depth copy, so the target descriptor MUST resolve to the source size
            // (e.g. both `size: surface`). Fail fast on a mismatch instead of silently thrashing — otherwise this
            // branch's condition would stay true and rebuild/destroy the target on every build() call.
            if (target._width !== source._width || target._height !== source._height) {
                throw new Error(
                    `DepthResolveTask "${config.name}": targetTexture size ${target._width}×${target._height} must match ` +
                        `sourceTexture size ${source._width}×${source._height} (size the target's descriptor like the source, e.g. both \`size: surface\`).`
                );
            }
        }
        const depthFormat = target._descriptor.dFormat;
        if (!depthFormat) {
            throw new Error(`DepthResolveTask "${config.name}": targetTexture has no depth format.`);
        }
        pipeline = getOrCreatePipeline(eng, depthFormat);
        // A DEPTH-aspect view of the MSAA source: a depth-stencil texture must be bound through its depth aspect
        // to read as texture_depth_multisampled_2d.
        const srcView = source._depthTexture.createView({ aspect: "depth-only" });
        bindGroup = eng._device.createBindGroup({ label: `${config.name ?? "depth-resolve"}-bg`, layout: _bgl!, entries: [{ binding: 0, resource: srcView }] });
        depthAttachment.view = target._depthView!;
        boundSrc = source._depthTexture;
        boundDst = target._depthTexture;
    };

    return {
        name: config.name ?? "depth-resolve",
        engine: eng,
        scene,
        _passes: [],
        record(): void {
            build();
        },
        execute(): number {
            if (config.sourceTexture._depthTexture !== boundSrc || config.targetTexture._depthTexture !== boundDst) {
                build(); // a resize reallocated the MSAA depth and/or the resolve target — rebind to the new textures
            }
            const pass = eng._currentEncoder.beginRenderPass(renderPassDescriptor);
            pass.setPipeline(pipeline!);
            pass.setBindGroup(0, bindGroup!);
            pass.draw(3);
            pass.end();
            return 1;
        },
        dispose(): void {
            pipeline = null;
            bindGroup = null;
            boundSrc = null;
            boundDst = null;
        },
    };
}
