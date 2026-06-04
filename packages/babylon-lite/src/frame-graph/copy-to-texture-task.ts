/**
 * CopyToTextureTask — copies a render target's color texture to another render
 * target's color texture, with optional viewport and source mip level.
 *
 * Modelled on Babylon.js `FrameGraphCopyToTextureTask`.
 *
 * Two execution paths, decided in `record()` and dispatched in `execute()`:
 *
 *   - Fast path: `GPUCommandEncoder.copyTextureToTexture`. Requires:
 *       * No viewport.
 *       * Source and target have the same format and same sampleCount.
 *       * Source mip(`lodLevel`) dimensions match the target's mip-0 dimensions.
 *       * Target is not the swapchain (the swap view is not a copy destination).
 *       * Target owns a color GPU texture (offscreen / MSAA-color).
 *
 *   - Blit path: a full-screen triangle samples the source texture and writes
 *     it into the target. Lod level is applied with `textureSampleLevel`;
 *     multisampled sources resolve through per-sample `textureLoad`. The Y
 *     axis is flipped when source and target have different `flipY`
 *     orientations so the rendered image stays visually correct across
 *     offscreen / swapchain boundaries.
 *
 *   - Resolve path: when `resolveTexture` is set without `targetTexture`, run
 *     a draw-less render pass with the source MSAA color view as the color
 *     attachment and `resolveTexture` (or the swap view when the target is a
 *     swapchain RT) as the end-of-pass `resolveTarget`. The MSAA source is
 *     loaded and the hardware MSAA-resolve fires at end-of-pass.
 *
 *   - When `resolveTexture` is set alongside `targetTexture`, the blit path
 *     attaches `resolveTexture` as the render pass's `resolveTarget` so the
 *     hardware MSAA-resolve fires at end-of-pass on top of the blit draw —
 *     no extra pass is needed. `targetTexture` must be MSAA.
 *
 * All decisions, GPU object creation, and per-attachment / viewport math are
 * performed in `record()`. `execute()` only dispatches the prebuilt path
 * (with one optional swap-view patch for swapchain targets).
 */

import type { NormalizedViewport } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget, RenderTargetDescriptor } from "../engine/render-target.js";
import { buildRenderTarget } from "../engine/render-target.js";
import { getBilinearSampler, getTrilinearSampler } from "../resource/samplers.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Task } from "./task.js";

export interface CopyToTextureTaskConfig {
    name?: string;
    sourceTexture: RenderTarget;
    /** Target attachment that receives the blit. Required UNLESS `resolveTexture`
     *  is set, in which case the task does a resolve-only operation and writes
     *  directly into `resolveTexture`. */
    targetTexture?: RenderTarget;
    /** Viewport applied to the target before the blit. When undefined (default),
     *  the whole target is overwritten and the encoder-copy fast path becomes
     *  available. When set, the blit path is used. */
    viewport?: NormalizedViewport | null;
    /** Source mip level to copy from. Default 0. The fast path uses this as
     *  the source `mipLevel`; the blit path samples with `textureSampleLevel`. */
    lodLevel?: number;
    /** Optional single-sample texture that receives a hardware MSAA-resolve of
     *  the task's MSAA color attachment at end-of-pass. Two modes:
     *
     *  - Blit + resolve: `targetTexture` is MSAA and `resolveTexture` is SS.
     *    The shader blit writes into `targetTexture` and at end-of-pass the
     *    GPU resolves `targetTexture` into `resolveTexture`.
     *
     *  - Resolve-only: `targetTexture` is omitted. The task runs a no-draw
     *    render pass with `sourceTexture` as the color attachment (so the
     *    source itself must be MSAA) and `resolveTexture` as its resolve
     *    target. `viewport` and `lodLevel` are ignored. `sourceTexture` and
     *    `resolveTexture` must have matching dimensions.
     *
     *  In both modes, `resolveTexture.colorFormat` must match the MSAA
     *  attachment's format and `resolveTexture` must be single-sample. */
    resolveTexture?: RenderTarget;
}

export interface CopyToTextureTask extends Task {
    readonly name: string;
    sourceTexture: RenderTarget;
    targetTexture: RenderTarget | undefined;
    resolveTexture: RenderTarget | undefined;
    viewport: NormalizedViewport | null | undefined;
    lodLevel: number;
    /** `resolveTexture` if set, otherwise `targetTexture`. Kept for API parity
     *  with BJS `FrameGraphCopyToTextureTask.outputTexture`. */
    readonly outputTexture: RenderTarget;
}

interface BlitState {
    readonly _pipeline: GPURenderPipeline;
    readonly _bindGroup: GPUBindGroup;
    /** Pre-computed pixel viewport when a normalized viewport is supplied. */
    readonly _viewport: { x: number; y: number; w: number; h: number } | null;
    /** Whether the color attachment's `view` is patched per frame from the swapchain. */
    readonly _swapAsView: boolean;
    /** Whether the color attachment's `resolveTarget` is patched per frame from the swapchain (MSAA → swap). */
    readonly _swapAsResolve: boolean;
}

interface FastPathState {
    readonly _source: GPUImageCopyTexture;
    readonly _target: GPUImageCopyTexture;
    readonly _size: GPUExtent3DStrict;
}

interface ResolveState {
    /** True when `resolveTexture` is a swapchain RT and its view must be
     *  patched from `engine._swapchainView` per frame. */
    readonly _swapAsResolve: boolean;
}

interface CopyToTextureTaskInternal extends CopyToTextureTask {
    _fast: FastPathState | null;
    _blit: BlitState | null;
    _resolve: ResolveState | null;
    _colorAttachment: GPURenderPassColorAttachment;
    _renderPassDescriptor: GPURenderPassDescriptor;
}

// VERTEX_WGSL_FLIP: sample the source upside-down — used when source and target
// have different `flipY` orientations (e.g. offscreen MRT → swapchain) so the
// visible result stays upright on screen. Maps framebuffer Y=0 (top) to source
// v=1 (bottom row).
const VERTEX_WGSL_FLIP = `struct V{@builtin(position)p:vec4f,@location(0)u:vec2f};
@vertex fn vs(@builtin(vertex_index)i:u32)->V{
var pos=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
var uv=array<vec2f,3>(vec2f(0,0),vec2f(2,0),vec2f(0,2));
return V(vec4f(pos[i],0,1),uv[i]);}`;

// VERTEX_WGSL_NOFLIP: identity sampling — used when source and target share the
// same orientation (offscreen → offscreen, swapchain → swapchain). Maps
// framebuffer Y=0 (top) to source v=0 (top row).
const VERTEX_WGSL_NOFLIP = `struct V{@builtin(position)p:vec4f,@location(0)u:vec2f};
@vertex fn vs(@builtin(vertex_index)i:u32)->V{
var pos=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
var uv=array<vec2f,3>(vec2f(0,1),vec2f(2,1),vec2f(0,-1));
return V(vec4f(pos[i],0,1),uv[i]);}`;

function fragmentForSingle(lod: number): string {
    return `@group(0)@binding(0)var t:texture_2d<f32>;@group(0)@binding(1)var s:sampler;
@fragment fn fs(v:V)->@location(0)vec4f{return textureSampleLevel(t,s,v.u,${lod.toFixed(1)});}`;
}

const FRAGMENT_MSAA_WGSL = `@group(0)@binding(0)var t:texture_multisampled_2d<f32>;
@fragment fn fs(v:V)->@location(0)vec4f{
let d=vec2i(textureDimensions(t));
let q=v.u*vec2f(d)-.5;
let p0=vec2i(floor(q));
let fr=fract(q);
let dmax=d-vec2i(1);
let p00=clamp(p0,vec2i(0),dmax);
let p10=clamp(p0+vec2i(1,0),vec2i(0),dmax);
let p01=clamp(p0+vec2i(0,1),vec2i(0),dmax);
let p11=clamp(p0+vec2i(1,1),vec2i(0),dmax);
let n=textureNumSamples(t);
var c00=vec4f(0);var c10=vec4f(0);var c01=vec4f(0);var c11=vec4f(0);
for(var i=0u;i<n;i++){
c00+=textureLoad(t,p00,i);
c10+=textureLoad(t,p10,i);
c01+=textureLoad(t,p01,i);
c11+=textureLoad(t,p11,i);}
let inv=1./f32(n);
c00*=inv;c10*=inv;c01*=inv;c11*=inv;
return mix(mix(c00,c10,fr.x),mix(c01,c11,fr.x),fr.y);}`;

// Per-engine cache, keyed by GPUDevice identity. Lazy-initialized on first
// blit so scenes that never use the blit path pay nothing.
let _cacheDevice: GPUDevice | null = null;
let _bglFiltering: GPUBindGroupLayout | null = null;
let _bglMsaa: GPUBindGroupLayout | null = null;
let _pipelines: Map<string, GPURenderPipeline> | null = null;
let _shaderModules: Map<string, GPUShaderModule> | null = null;

function resetCache(device: GPUDevice): void {
    if (_cacheDevice === device) {
        return;
    }
    _cacheDevice = device;
    _bglFiltering = null;
    _bglMsaa = null;
    _pipelines = new Map();
    _shaderModules = new Map();
}

export function createCopyToTextureTask(config: CopyToTextureTaskConfig, engine: EngineContext, scene: SceneContext): CopyToTextureTask {
    const eng = engine as EngineContext;
    const sc = scene as SceneContext;
    if (!config.targetTexture && !config.resolveTexture) {
        throw new Error(`CopyToTextureTask "${config.name ?? "copy-to-texture"}": either targetTexture or resolveTexture must be provided.`);
    }
    const colorAttachment: GPURenderPassColorAttachment = {
        view: undefined!,
        // When a viewport is set (explicit or null="use current"), preserve pixels outside
        // the viewport rectangle so multiple copy tasks can composite onto the same target.
        // Without a viewport the blit covers the whole attachment, so clearing is fine.
        // Resolve-only mode also loads (we want to preserve the existing MSAA samples
        // and just trigger the end-of-pass hardware resolve).
        loadOp: config.viewport !== undefined || (config.resolveTexture && !config.targetTexture) ? "load" : "clear",
        storeOp: "store",
    };
    const task: CopyToTextureTaskInternal = {
        name: config.name ?? "copy-to-texture",
        engine: eng,
        scene: sc,
        _passes: [],
        sourceTexture: config.sourceTexture,
        targetTexture: config.targetTexture,
        resolveTexture: config.resolveTexture,
        viewport: config.viewport,
        lodLevel: config.lodLevel ?? 0,
        get outputTexture(): RenderTarget {
            return (this.resolveTexture ?? this.targetTexture)!;
        },
        _fast: null,
        _blit: null,
        _resolve: null,
        _colorAttachment: colorAttachment,
        _renderPassDescriptor: { label: config.name ?? "copy-to-texture", colorAttachments: [colorAttachment] },
        record(): void {
            task._fast = null;
            task._blit = null;
            task._resolve = null;
            const source = task.sourceTexture;
            if (!source._colorTexture) {
                throw new Error(`CopyToTextureTask "${task.name}": sourceTexture has no color texture. The source must be built before this task records.`);
            }
            // Auto-build offscreen target/resolve textures that aren't owned by a
            // RenderTask. SS swap RTs (sampleCount===1) own no GPU texture — their
            // swap view is the attachment directly — so we skip those. MSAA swap RTs
            // still need their MSAA color texture allocated (the swap view is only the
            // resolve target). Already-built RTs are no-ops in `buildRenderTarget`.
            // Keeps copy-only chains (e.g. an SS staging texture between MSAA resolve
            // and final swap blit) from requiring the caller to pre-build them.
            const needsBuild = (rt: RenderTarget) => !rt._colorTexture && (!rt._descriptor.resolveToSwapchain || rt._descriptor.sampleCount > 1);
            if (task.targetTexture && needsBuild(task.targetTexture)) {
                buildRenderTarget(task.targetTexture, eng);
            }
            if (task.resolveTexture && needsBuild(task.resolveTexture)) {
                buildRenderTarget(task.resolveTexture, eng);
            }
            if (task.resolveTexture && !task.targetTexture) {
                buildResolvePath(task, source, task.resolveTexture);
                return;
            }
            const target = task.targetTexture!;
            if (tryBuildFastPath(task, source, target, eng)) {
                return;
            }
            buildBlitPath(task, source, target, eng);
        },
        execute(): number {
            const fast = task._fast;
            if (fast) {
                eng._currentEncoder.copyTextureToTexture(fast._source, fast._target, fast._size);
                return 0;
            }
            const resolve = task._resolve;
            if (resolve) {
                if (resolve._swapAsResolve) {
                    colorAttachment.resolveTarget = eng._swapchainView;
                }
                // No draws — the end-of-pass operation hardware-resolves the
                // (loaded) MSAA color attachment into its resolveTarget.
                const pass = eng._currentEncoder.beginRenderPass(task._renderPassDescriptor);
                pass.end();
                return 0;
            }
            const blit = task._blit!;
            if (blit._swapAsView) {
                colorAttachment.view = eng._swapchainView;
            }
            if (blit._swapAsResolve) {
                colorAttachment.resolveTarget = eng._swapchainView;
            }
            const pass = eng._currentEncoder.beginRenderPass(task._renderPassDescriptor);
            const v = blit._viewport;
            if (v) {
                pass.setViewport(v.x, v.y, v.w, v.h, 0, 1);
                pass.setScissorRect(v.x, v.y, v.w, v.h);
            }
            pass.setPipeline(blit._pipeline);
            pass.setBindGroup(0, blit._bindGroup);
            pass.draw(3);
            pass.end();
            return 1;
        },
        dispose(): void {
            task._passes.length = 0;
            task._fast = null;
            task._blit = null;
            task._resolve = null;
        },
    };
    return task;
}

function buildResolvePath(task: CopyToTextureTaskInternal, source: RenderTarget, resolveTexture: RenderTarget): void {
    const srcDesc = source._descriptor;
    const dstDesc = resolveTexture._descriptor;
    const srcSamples = srcDesc.sampleCount ?? 1;
    if (srcSamples < 2) {
        throw new Error(`CopyToTextureTask "${task.name}": resolveTexture requires a multisampled sourceTexture (got sampleCount=${srcSamples}).`);
    }
    if ((dstDesc.sampleCount ?? 1) !== 1) {
        throw new Error(`CopyToTextureTask "${task.name}": resolveTexture must be single-sample (got sampleCount=${dstDesc.sampleCount}).`);
    }
    const swapAsResolve = !!dstDesc.resolveToSwapchain;
    // Swapchain targets aren't built by `buildRenderTarget` (their view is
    // patched per frame from `engine._swapchainView`), so `_width`/`_height`
    // stay 0. The swap is always sized to the engine canvas, which by
    // construction matches a canvas-sized source RT, so skip the dimension
    // check in that case and let WebGPU validate at end-of-pass resolve time.
    if (!swapAsResolve && (source._width !== resolveTexture._width || source._height !== resolveTexture._height)) {
        throw new Error(
            `CopyToTextureTask "${task.name}": sourceTexture (${source._width}x${source._height}) and resolveTexture (${resolveTexture._width}x${resolveTexture._height}) must have matching dimensions.`
        );
    }
    task._colorAttachment.view = source._colorView!;
    if (!swapAsResolve) {
        task._colorAttachment.resolveTarget = resolveTexture._colorView!;
    }
    task._resolve = { _swapAsResolve: swapAsResolve };
}

function tryBuildFastPath(task: CopyToTextureTaskInternal, source: RenderTarget, target: RenderTarget, _engine: EngineContext): boolean {
    if (task.viewport !== undefined) {
        return false;
    }
    if (task.resolveTexture) {
        // resolveTexture requires an end-of-pass hardware resolve, which only
        // happens inside a render pass; the encoder-copy fast path skips it.
        return false;
    }
    const targetTexture = target._colorTexture;
    if (target._descriptor.resolveToSwapchain || !targetTexture) {
        return false;
    }
    const sourceTexture = source._colorTexture;
    if (!sourceTexture) {
        return false;
    }
    const srcDesc = source._descriptor;
    const dstDesc = target._descriptor;
    const srcFormat = srcDesc.colorFormat;
    const dstFormat = dstDesc.colorFormat;
    if (!srcFormat || srcFormat !== dstFormat) {
        return false;
    }
    const srcSamples = srcDesc.sampleCount ?? 1;
    const dstSamples = dstDesc.sampleCount ?? 1;
    if (srcSamples !== dstSamples) {
        return false;
    }
    const lod = task.lodLevel;
    if (lod >= sourceTexture.mipLevelCount) {
        return false;
    }
    const srcMipW = Math.max(1, source._width >> lod);
    const srcMipH = Math.max(1, source._height >> lod);
    if (srcMipW !== target._width || srcMipH !== target._height) {
        return false;
    }
    task._fast = {
        _source: { texture: sourceTexture, mipLevel: lod },
        _target: { texture: targetTexture },
        _size: { width: srcMipW, height: srcMipH },
    };
    return true;
}

function buildBlitPath(task: CopyToTextureTaskInternal, source: RenderTarget, target: RenderTarget, engine: EngineContext): void {
    resetCache(engine._device);
    const targetFormat = effectiveTargetFormat(target, engine);
    const targetSamples = target._descriptor.sampleCount ?? 1;
    const multisampledSource = (source._descriptor.sampleCount ?? 1) > 1;
    const flipY = shouldFlipY(source._descriptor, target._descriptor);
    const pipeline = getOrCreateCopyPipeline(engine, targetFormat, targetSamples, multisampledSource, task.lodLevel, flipY);
    const bgl = multisampledSource ? _bglMsaa! : _bglFiltering!;
    const entries: GPUBindGroupEntry[] = multisampledSource
        ? [{ binding: 0, resource: source._colorView! }]
        : [
              { binding: 0, resource: source._colorView! },
              { binding: 1, resource: task.lodLevel > 0 ? getTrilinearSampler(engine) : getBilinearSampler(engine) },
          ];
    const bindGroup = engine._device.createBindGroup({ label: `${task.name}-bg`, layout: bgl, entries });

    // Color attachment view setup. Three cases for `view`:
    //   - Offscreen target: view = target._colorView (stable).
    //   - Swapchain target with sampleCount === 1: view = swap view (patched per frame).
    //   - Swapchain target with sampleCount > 1: view = MSAA color view (stable).
    //
    // `resolveTarget` is set when:
    //   - Caller passes a separate `resolveTexture` (target must be MSAA, resolveTexture
    //     must be SS) — resolveTarget = resolveTexture._colorView, or swap view if it's
    //     a swap RT.
    //   - Target itself is a swap RT with MSAA (implicit auto-resolve to swap).
    const isSwap = !!target._descriptor.resolveToSwapchain;
    const swapAsView = isSwap && targetSamples === 1;
    let swapAsResolve = false;
    if (task.resolveTexture) {
        if (targetSamples < 2) {
            throw new Error(`CopyToTextureTask "${task.name}": resolveTexture requires a multisampled targetTexture (got sampleCount=${targetSamples}).`);
        }
        const resolveDesc = task.resolveTexture._descriptor;
        if ((resolveDesc.sampleCount ?? 1) !== 1) {
            throw new Error(`CopyToTextureTask "${task.name}": resolveTexture must be single-sample (got sampleCount=${resolveDesc.sampleCount}).`);
        }
        if (resolveDesc.colorFormat !== target._descriptor.colorFormat) {
            throw new Error(
                `CopyToTextureTask "${task.name}": resolveTexture format (${resolveDesc.colorFormat}) must match targetTexture format (${target._descriptor.colorFormat}).`
            );
        }
        if (resolveDesc.resolveToSwapchain) {
            swapAsResolve = true;
        } else {
            task._colorAttachment.resolveTarget = task.resolveTexture._colorView!;
        }
    } else if (isSwap && targetSamples > 1) {
        // Implicit swap-MSAA auto-resolve: swap view receives the resolve.
        swapAsResolve = true;
    }
    if (!swapAsView) {
        task._colorAttachment.view = target._colorView!;
    }
    if (!swapAsResolve && !task.resolveTexture) {
        task._colorAttachment.resolveTarget = undefined;
    }

    let viewportRect: { x: number; y: number; w: number; h: number } | null = null;
    const v = task.viewport;
    if (v) {
        const w = target._width;
        const h = target._height;
        // BJS-space viewport convention: y=0 means visual bottom of the screen.
        // Match BJS WebGPUEngine._applyViewport rounding: floor each boundary in
        // pre-flip space, then derive width/height as the difference of consecutive
        // floor()s. Equivalent to `floor(end) - floor(start)`, which gives
        // consecutive tiles a shared boundary pixel (no gap) AND gives non-integer
        // rectangles the same pixel size as BJS — important when canvas height
        // isn't a multiple of the impostor's normalized size.
        const x = Math.floor(v.x * w);
        const vw = Math.floor((v.x + v.width) * w) - x;
        const yTop = Math.floor(v.y * h);
        const vh = Math.floor((v.y + v.height) * h) - yTop;
        // Y-flip the viewport only when target.flipY=false (swapchain / GL-y-down
        // pixel orientation) — matches BJS engine behavior which Y-flips for
        // backbuffer but not for RTTs. For flipY=true offscreen targets, the
        // viewport's pre-flip pixel-y is used as-is so that a downstream flip-blit
        // (offscreen→swap) lands the result back at the BJS-space y position.
        const targetFlipY = target._descriptor.flipY ?? target._descriptor.resolveToSwapchain !== true;
        viewportRect = { x, y: targetFlipY ? yTop : h - yTop - vh, w: vw, h: vh };
    }

    task._blit = {
        _pipeline: pipeline,
        _bindGroup: bindGroup,
        _viewport: viewportRect,
        _swapAsView: swapAsView,
        _swapAsResolve: swapAsResolve,
    };
}

function getOrCreateCopyPipeline(
    engine: EngineContext,
    targetFormat: GPUTextureFormat,
    targetSamples: number,
    multisampledSource: boolean,
    lodLevel: number,
    flipY: boolean
): GPURenderPipeline {
    const device = engine._device;
    const pipelineKey = `${targetFormat}|t${targetSamples}|${multisampledSource ? "m" : "s"}|l${lodLevel}|${flipY ? "f" : "n"}`;
    let pipeline = _pipelines!.get(pipelineKey);
    if (pipeline) {
        return pipeline;
    }
    const moduleKey = `${multisampledSource ? "msaa" : `s|l${lodLevel}`}|${flipY ? "f" : "n"}`;
    let shaderModule = _shaderModules!.get(moduleKey);
    if (!shaderModule) {
        const vertex = flipY ? VERTEX_WGSL_FLIP : VERTEX_WGSL_NOFLIP;
        const fragment = multisampledSource ? FRAGMENT_MSAA_WGSL : fragmentForSingle(lodLevel);
        shaderModule = device.createShaderModule({ code: `${vertex}\n${fragment}`, label: `copy-to-texture-${moduleKey}` });
        _shaderModules!.set(moduleKey, shaderModule);
    }
    let bgl: GPUBindGroupLayout;
    if (multisampledSource) {
        _bglMsaa ??= device.createBindGroupLayout({
            label: "copy-to-texture-msaa-bgl",
            entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", multisampled: true } }],
        });
        bgl = _bglMsaa;
    } else {
        _bglFiltering ??= device.createBindGroupLayout({
            label: "copy-to-texture-bgl",
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            ],
        });
        bgl = _bglFiltering;
    }
    pipeline = device.createRenderPipeline({
        label: `copy-to-texture-${pipelineKey}`,
        layout: device.createPipelineLayout({ label: `copy-to-texture-layout-${pipelineKey}`, bindGroupLayouts: [bgl] }),
        vertex: { module: shaderModule, entryPoint: "vs" },
        fragment: { module: shaderModule, entryPoint: "fs", targets: [{ format: targetFormat }] },
        primitive: { topology: "triangle-list" },
        multisample: { count: targetSamples },
    });
    _pipelines!.set(pipelineKey, pipeline);
    return pipeline;
}

function effectiveTargetFormat(target: RenderTarget, engine: EngineContext): GPUTextureFormat {
    if (target._descriptor.resolveToSwapchain) {
        return engine.format;
    }
    const fmt = target._descriptor.colorFormat;
    if (!fmt) {
        throw new Error("CopyToTextureTask: targetTexture has no color format.");
    }
    return fmt;
}

function shouldFlipY(sourceDesc: RenderTargetDescriptor, targetDesc: RenderTargetDescriptor): boolean {
    // Default: offscreen RTTs render with a Y-flipped projection (`flipY = true`),
    // swapchain targets render upright (`flipY = false`). When the two orientations
    // differ, the blit must flip Y so visual orientation matches.
    const sf = sourceDesc.flipY ?? sourceDesc.resolveToSwapchain !== true;
    const tf = targetDesc.flipY ?? targetDesc.resolveToSwapchain !== true;
    return sf !== tf;
}
