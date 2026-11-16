import { TU, SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { _vis } from "../engine/engine.js";
import { createRenderTarget } from "../engine/render-target.js";
import { getBilinearSampler } from "../resource/samplers.js";
import { getTrilinearAnisotropicSampler } from "../resource/trilinear-anisotropic-sampler.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { recordMipmaps } from "../texture/generate-mipmaps.js";
import { biasedMipLevelCount } from "../texture/mip-count.js";
import type { DrawBinding } from "../render/renderable.js";
import type { RenderTask } from "./render-task.js";
import { drawList, type RenderTaskBase } from "./render-task-base.js";
import type { SceneContext } from "../scene/scene-core.js";
import { createImageProcessingTask } from "./image-processing-task.js";
import { wgsl } from "../shader/wgsl.js";
import type { TransmissionDepthGrab } from "./transmission-depth-grab.js";

export interface RenderTaskTransmissionState {
    readonly texture: Texture2D;
    /** @internal */
    readonly _baseView: GPUTextureView;
    /** @internal */
    _sourceTexture: GPUTexture | null;
    /** @internal */
    _blit: TransmissionBlitState | null;
    /** @internal Installed only by the lazy depth-grab feature. */
    _depth?: TransmissionDepthGrab;
    /** @internal */
    readonly _copyCount: number;
    /** @internal */
    readonly _generateMipmaps: boolean;
    /** @internal */
    _copies: number;
}

/** @internal */
export interface TransmissionBlitState {
    /** @internal */
    readonly _pipeline: GPURenderPipeline;
    /** @internal */
    readonly _bindGroup: GPUBindGroup;
}

const BLIT_VERTEX_SHADER = wgsl`struct V{@builtin(position)p:vec4f,@location(0)u:vec2f};@vertex fn vs(@builtin(vertex_index)i:u32)->V{var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var u=array<vec2f,3>(vec2f(0,1),vec2f(2,1),vec2f(0,-1));return V(vec4f(p[i],0,1),u[i]);}`;
const BLIT_BINDINGS = wgsl`@group(0)@binding(0)var t:texture_2d<f32>;@group(0)@binding(1)var s:sampler;`;
const BLIT_MSAA_BINDINGS = wgsl`@group(0)@binding(0)var t:texture_multisampled_2d<f32>;`;
const BLIT_FRAGMENT_SHADER = wgsl`@fragment fn fs(v:V)->@location(0)vec4f{return textureSample(t,s,v.u);}`;
const BLIT_MSAA_FRAGMENT_SHADER = wgsl`fn l(p:vec2i)->vec4f{let n=textureNumSamples(t);var c=vec4f(0);for(var i=0u;i<n;i++){c+=textureLoad(t,p,i);}return c/f32(n);}@fragment fn fs(v:V)->@location(0)vec4f{let d=vec2i(textureDimensions(t));let q=clamp(v.u*vec2f(d)-.5,vec2f(0),vec2f(d-vec2i(1)));let p=vec2i(floor(q));let f=fract(q);let p1=min(p+vec2i(1),d-vec2i(1));return mix(mix(l(p),l(vec2i(p1.x,p.y)),f.x),mix(l(vec2i(p.x,p1.y)),l(p1),f.x),f.y);}`;
const REFRACTION_LOD_BIAS = 4;
let blitPipelines: Map<string, GPURenderPipeline> | null = null;
let blitShader: GPUShaderModule | null = null;
let blitMsaaShader: GPUShaderModule | null = null;
let blitBgl: GPUBindGroupLayout | null = null;
let blitMsaaBgl: GPUBindGroupLayout | null = null;
let blitDevice: GPUDevice | null = null;

/** Enable scene-color transmission for every render task currently registered in a scene. PBR materials are marked for linear transmission, and a trailing image-processing task is appended when needed. */
export function enableSceneTransmission(scene: SceneContext, engine: EngineContext): void {
    _t(scene, engine)[0]();
}

/** @internal Prepare linear PBR flags, then commit transmission only after renderable construction succeeds. */
export function _t(scene: SceneContext, engine: EngineContext): readonly [commit: () => void, rollback: () => void] {
    type TransmissionMaterial = { _linearImageProcessing?: boolean; _renderFeatures?: unknown };
    const states: [TransmissionMaterial, boolean | undefined, unknown][] = [];
    for (const mesh of scene.meshes) {
        const mat = mesh.material as TransmissionMaterial | null;
        if (mat) {
            states.push([mat, mat._linearImageProcessing, mat._renderFeatures]);
            mat._linearImageProcessing = true;
            mat._renderFeatures = undefined;
        }
    }
    const rollback = (): void => {
        // Reverse the journal so meshes sharing a material restore its original state.
        for (let i = states.length - 1; i >= 0; i--) {
            const [mat, linear, features] = states[i]!;
            mat._linearImageProcessing = linear;
            mat._renderFeatures = features;
        }
    };
    return [
        () => {
            try {
                enableSceneTransmissionTasks(scene, engine);
            } catch (error) {
                rollback();
                throw error;
            }
        },
        rollback,
    ];
}

function enableSceneTransmissionTasks(scene: SceneContext, engine: EngineContext): void {
    scene._outputPipelineChange?.(false);
    let lastRenderTask: RenderTaskBase | null = null;
    try {
        for (const task of scene._frameGraph._tasks) {
            if ("_renderables" in task) {
                const renderTask = task as RenderTaskBase;
                enableTransmission(renderTask, engine);
                lastRenderTask = renderTask;
            }
        }
        if (lastRenderTask && !scene._frameGraph._tasks.some((task) => task.name === "transmission-image-processing")) {
            scene._frameGraph._tasks.push(
                createImageProcessingTask({ name: "transmission-image-processing", source: () => scene._outputTexture ?? lastRenderTask!._config.rt }, engine, scene)
            );
        }
    } finally {
        scene._outputPipelineChange?.(true);
    }
}

/** Options controlling how a render task exposes opaque scene color to transmissive materials. Use these to opt out of the linear offscreen path, control refresh frequency, and limit mipmap generation cost. */
export interface TransmissionOptions {
    /** When true (the default), retarget the task's color buffer to a linear `rgba16float`
     *  offscreen and tone-map it in a trailing image-processing pass — the model PBR
     *  transmission uses so refractive materials read scene color in *linear* space.
     *
     *  Set false to perform ONLY the mid-pass scene-color grab: the task's render target
     *  format / sample count / clear are left untouched and no tone-map pass is added. Use
     *  this for consumers that own their tone mapping / post (e.g. a custom depth-of-field
     *  stack) and just need the opaque scene color exposed to a custom transmissive
     *  `ShaderMaterial`. */
    linear?: boolean;
    /** Override how many times the scene-colour grab is refreshed per frame. `0` means before every
     *  transmissive draw; the default is once before the first transmissive draw. */
    copyCount?: number;
    /** Set false when the transmissive material never samples the scene-colour grab above mip 0. */
    generateMipmaps?: boolean;
    /** Cap the scene-colour grab mip chain. Use this when the material samples explicit low LODs only, so
     *  unused tiny mips are not regenerated every frame. Ignored when `generateMipmaps` is false. */
    mipLevelCount?: number;
    /** When true, ALSO snapshot the task's DEPTH attachment at the same mid-pass grab, into a single-sample
     *  `r32float` texture exposed as `SceneColorGrab.depthTexture` — the opaque scene depth as of the moment
     *  the first transmissive surface draws. Lets a transmissive material depth-ray-march the opaque scene
     *  (screen-space reflection / refraction) without re-rendering a separate depth prepass: the depth
     *  attachment itself cannot be sampled while the transmissive draw has it bound (a WebGPU feedback loop),
     *  which is exactly why the snapshot is taken at the pass break. MSAA sources resolve sample 0 (matching
     *  `createDepthResolveTask`). No-op when the task's render target carries no depth attachment. */
    grabDepth?: boolean;
}

/** Handle to a render task's scene-color grab, returned by `enableRenderTaskTransmission`. */
export interface SceneColorGrab {
    /** The live opaque-scene-color texture sampled by transmissive surfaces, or null before the
     *  frame graph has built the task at least once. Its identity changes when the task rebuilds
     *  (e.g. on resize), so consumers that bind it to a custom material should re-bind when it
     *  changes. */
    readonly texture: Texture2D | null;
    /** The live opaque-scene DEPTH grab (`grabDepth: true`): the task's depth attachment as of the moment
     *  the first transmissive surface draws, resolved to a single-sample `r32float` (raw NDC depth as
     *  stored; a cleared texel means no geometry). Null before the target builds or when `grabDepth` is
     *  off. Identity changes when the task rebuilds (e.g. on resize) — re-bind on change. */
    readonly depthTexture: Texture2D | null;
}

/** Enable mid-pass scene-color grabs for a single render task and return the live texture handle. The task is wrapped so transmissive draw calls can sample the opaque color rendered earlier in the same pass. */
export function enableRenderTaskTransmission(task: RenderTask, engine: EngineContext, options?: TransmissionOptions): SceneColorGrab {
    return enableTransmission(task, engine, options);
}

function enableTransmission(task: RenderTaskBase, engine: EngineContext, options?: TransmissionOptions): SceneColorGrab {
    const linear = options?.linear !== false;
    applyTransmissionOptions(task, options);
    // Preload the optional controller before record() builds the task's attachments.
    if (task._config.transmission?.grabDepth) {
        const priorPreload = task._preload?.bind(task);
        task._preload = async (): Promise<void> => {
            if (priorPreload) {
                await priorPreload();
            }
            task._createTransmissionDepthGrab = (await import("./transmission-depth-grab.js")).createTransmissionDepthGrab;
        };
    }
    const grab: SceneColorGrab = {
        get texture(): Texture2D | null {
            return (task._targetSignature as { _transmissionTexture?: Texture2D })._transmissionTexture ?? null;
        },
        get depthTexture(): Texture2D | null {
            return (task._targetSignature as { _transmissionDepthTexture?: Texture2D | null })._transmissionDepthTexture ?? null;
        },
    };
    if (task._executeWithTransmission) {
        return grab;
    }
    if (linear) {
        retargetRenderTaskToLinearOffscreen(task);
    }
    let state: RenderTaskTransmissionState | null = null;
    const record = task.record.bind(task);
    const execute = task.execute?.bind(task);
    const dispose = task.dispose?.bind(task);
    task.record = () => {
        disposeRenderTaskTransmission(state);
        state = createRenderTaskTransmission(task, engine);
        const signature = task._targetSignature as { _transmissionTexture?: Texture2D; _transmissionDepthTexture?: Texture2D | null };
        signature._transmissionTexture = state.texture;
        if (task._config.transmission?.grabDepth) {
            state._depth = task._createTransmissionDepthGrab?.(engine, task._config.depth ?? task._config.rt, (texture) => {
                signature._transmissionDepthTexture = texture;
            });
        }
        record();
        configureTransmissionSource(state, task, engine);
        state._depth?.sync();
    };
    if (linear && execute) {
        task.execute = () => executeRenderTaskLinear(task.scene, execute);
    }
    task.dispose = () => {
        disposeRenderTaskTransmission(state);
        state = null;
        dispose?.();
    };
    task._executeWithTransmission = (sampleCount) => executePassWithTransmission(task, engine, state!, sampleCount);
    return grab;
}

function retargetRenderTaskToLinearOffscreen(task: RenderTaskBase): void {
    const cfg = task._config;
    if (cfg.sharedRt) {
        throw new Error("Transmission cannot retarget borrowed color attachments. Use linear: false and supply an explicit linear composition chain.");
    }
    const oldDesc = cfg.rt._descriptor;
    const oldSize = oldDesc.size;
    const surface = task.scene.surface;
    const sampleCount = surface.msaaSamples;
    // The scene render task may target the shared engine scRT (single-sample,
    // colour-only — single-sample default path) or an MSAA colour RT that resolves into it
    // via `rst` (MSAA default path). Never mutate the shared scRT descriptor —
    // instead point the task at a fresh offscreen HDR target and stop resolving to swap.
    // Transmission samples this linear HDR result in its own final image-processing pass
    // that writes the tonemapped result to the swapchain.
    //
    // Depth ownership: when the task already carries an external depth (`cfg.depth`, the
    // single-sample default path), keep it; otherwise the new target owns depth (matching
    // the MSAA colour RT it replaces).
    const ownsDepth = !cfg.depth;
    const newRt = createRenderTarget({
        lbl: "transmission-linear",
        format: "rgba16float",
        dFormat: ownsDepth ? (oldDesc.dFormat ?? "depth24plus-stencil8") : undefined,
        depthClearValue: oldDesc.depthClearValue,
        depthCompare: oldDesc.depthCompare,
        samples: sampleCount,
        size: "canvas" in oldSize || "surface" in oldSize ? oldSize : surface,
    });
    cfg.rt = newRt;
    cfg.rst = undefined;
    const sig = task._targetSignature as {
        _colorFormat?: GPUTextureFormat;
        _depthStencilFormat?: GPUTextureFormat;
        _depthCompare?: GPUCompareFunction;
        _sampleCount: number;
    };
    sig._colorFormat = "rgba16float";
    sig._depthStencilFormat = cfg.depth?._descriptor.dFormat ?? newRt._descriptor.dFormat;
    sig._depthCompare = newRt._descriptor.depthCompare ?? cfg.depth?._descriptor.depthCompare;
    sig._sampleCount = sampleCount;
    task._ob.length = 0;
    task._lastVersion = -1;
}

function executeRenderTaskLinear(scene: SceneContext, execute: () => number): number {
    const imageProcessing = scene.imageProcessing as { exposure: number; contrast: number; toneMappingEnabled: boolean | number };
    const toneMappingEnabled = imageProcessing.toneMappingEnabled;
    const clearColor = scene.clearColor;
    const linearClearColor = inverseImageProcessedColor(clearColor, imageProcessing.exposure, imageProcessing.contrast, toneMappingEnabled === true);
    imageProcessing.toneMappingEnabled = -1;
    scene.clearColor = linearClearColor;
    try {
        return execute();
    } finally {
        scene.clearColor = clearColor;
        imageProcessing.toneMappingEnabled = toneMappingEnabled;
    }
}

function inverseImageProcessedColor(color: GPUColorDict, exposure: number, contrast: number, toneMapping: boolean): GPUColorDict {
    return {
        r: inverseImageProcessedChannel(color.r, exposure, contrast, toneMapping),
        g: inverseImageProcessedChannel(color.g, exposure, contrast, toneMapping),
        b: inverseImageProcessedChannel(color.b, exposure, contrast, toneMapping),
        a: color.a,
    };
}

function inverseImageProcessedChannel(value: number, exposure: number, contrast: number, toneMapping: boolean): number {
    let c = clamp01(value);
    if (contrast < 1) {
        c = contrast > 0 ? clamp01((c - 0.5 * (1 - contrast)) / contrast) : 0.5;
    } else if (contrast > 1) {
        const mixAmount = contrast - 1;
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 16; i++) {
            const mid = (lo + hi) * 0.5;
            const high = mid * mid * (3 - 2 * mid);
            const out = mid + (high - mid) * mixAmount;
            if (out < c) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        c = (lo + hi) * 0.5;
    }
    c = c ** 2.2;
    if (toneMapping) {
        c = -Math.log2(Math.max(1 - c, 1e-6)) / 1.5905790328979492;
    }
    return exposure > 0 ? c / exposure : c;
}

function clamp01(v: number): number {
    return Math.min(Math.max(v, 0), 1);
}

function createRenderTaskTransmission(task: RenderTaskBase, engine: EngineContext): RenderTaskTransmissionState {
    const width = 1024;
    const height = 1024;
    const format: GPUTextureFormat = "rgba16float";
    const mipLevelCount = transmissionMipLevelCount(task._config.transmission, width, height);
    const generateMipmaps = mipLevelCount > 1;
    const texture = engine._device.createTexture({
        label: task.name,
        size: { width, height },
        format,
        mipLevelCount,
        usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING | TU.COPY_DST,
    });
    const tex: Texture2D = {
        texture,
        view: texture.createView(),
        sampler: getTrilinearAnisotropicSampler(engine),
        width,
        height,
        invertY: false,
    };
    return {
        texture: tex,
        _baseView: texture.createView({ baseMipLevel: 0, mipLevelCount: 1 }),
        _sourceTexture: null,
        _blit: null,
        _copyCount: normalizeCopyCount(task._config.transmission),
        _generateMipmaps: generateMipmaps,
        _copies: 0,
    };
}

function configureTransmissionSource(state: RenderTaskTransmissionState, task: RenderTaskBase, engine: EngineContext): void {
    const rt = task._config.rt;
    state._sourceTexture = rt._colorTexture;
    const sampleCount = task._targetSignature._sampleCount;
    state._blit =
        state._sourceTexture && (sampleCount > 1 || rt._width !== state.texture.width || rt._height !== state.texture.height)
            ? createTransmissionBlit(state, engine, state._sourceTexture, sampleCount > 1)
            : null;
}

function disposeRenderTaskTransmission(state: RenderTaskTransmissionState | null | undefined): void {
    state?.texture.texture.destroy();
    state?._depth?.dispose();
}

export function executePassWithTransmission(task: RenderTaskBase, engine: EngineContext, state: RenderTaskTransmissionState, sampleCount: number): number {
    state._copies = 0;
    const transparent = task._transparentBindings;
    // MSAA: resolve the FINAL scene colour into the task's single-sample resolve target (`rst`) so downstream
    // passes that SAMPLE the scene RTT (e.g. a custom DoF/present stack) get a resolved image. The multisampled
    // colour is preserved across the split segments (store/load), so resolving on every segment leaves the LAST
    // (complete) resolve in `rst`. No-op when single-sample (resolveView stays null) — existing scenes unchanged.
    const resolveView = sampleCount > 1 ? (task._config.rst?._colorView ?? null) : null;
    let pass = beginTaskPass(task, resolveView, sampleCount, false);
    let draws = drawBaseTask(task, pass);
    let lastPipeline: GPURenderPipeline | null = null;
    let overlay: DrawBinding[] | null = null;
    for (let i = 0; i < transparent.length; i++) {
        const binding = transparent[i]!;
        // `Mesh.renderOnTop` surfaces draw last — after the scene-colour grab — so they sit on top of the
        // transmissive surface and are excluded from what it refracts (e.g. lily pads on water).
        if (binding.renderable.mesh?.renderOnTop === true) {
            (overlay ??= []).push(binding);
            continue;
        }
        const transmissive = binding.renderable._transmissive === true;
        if (transmissive && canUpdateTransmission(state)) {
            pass.end();
            updateTransmissionTexture(state, task, engine);
            pass = beginTaskPass(task, resolveView, sampleCount, true);
            setPassState(task, pass);
            lastPipeline = null;
        }
        const mesh = binding.renderable.mesh;
        if (mesh && (mesh.visible === false || mesh._skipColorDraw)) {
            continue;
        }
        if (binding.pipeline !== lastPipeline) {
            pass.setPipeline(binding.pipeline);
            lastPipeline = binding.pipeline;
        }
        draws += binding.draw(pass, engine);
    }
    if (overlay) {
        draws += drawList(pass, overlay, engine, true);
    }
    pass.end();
    return draws;
}

function updateTransmissionTexture(state: RenderTaskTransmissionState, task: RenderTaskBase, engine: EngineContext): void {
    if (state._sourceTexture !== task._config.rt._colorTexture) {
        configureTransmissionSource(state, task, engine);
    }
    if (!state._sourceTexture) {
        throw new Error("No transmission source");
    }
    if (state._blit) {
        blitToTransmission(state, engine);
    } else {
        engine._currentEncoder.copyTextureToTexture(
            { texture: state._sourceTexture },
            { texture: state.texture.texture },
            { width: state.texture.width, height: state.texture.height }
        );
    }
    if (state._generateMipmaps) {
        recordMipmaps(engine, state.texture.texture, engine._currentEncoder);
    }
    // Depth grab rides the same mid-pass break: the depth attachment is unbound here (the pass just ended),
    // so it is legal to sample; the resumed segment re-attaches it with loadOp "load". The record body lives in
    // the lazy depth-grab module (installed only when grabDepth is enabled), so it costs zero bytes otherwise.
    state._depth?.sync();
    state._depth?.record();
    state._copies++;
}

function createBlitShader(device: GPUDevice, multisampled: boolean): GPUShaderModule {
    return device.createShaderModule({
        code: wgsl`${multisampled ? BLIT_MSAA_BINDINGS : BLIT_BINDINGS}${BLIT_VERTEX_SHADER}${multisampled ? BLIT_MSAA_FRAGMENT_SHADER : BLIT_FRAGMENT_SHADER}`,
    });
}

function getBlitPipeline(engine: EngineContext, format: GPUTextureFormat, multisampled: boolean): GPURenderPipeline {
    const device = engine._device;
    if (device !== blitDevice) {
        blitPipelines?.clear();
        blitPipelines = null;
        blitShader = null;
        blitMsaaShader = null;
        blitBgl = null;
        blitMsaaBgl = null;
        blitDevice = device;
    }
    if (multisampled) {
        blitMsaaShader ??= createBlitShader(device, true);
        blitMsaaBgl ??= device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: "unfilterable-float", multisampled: true } }],
        });
    } else {
        blitShader ??= createBlitShader(device, false);
        blitBgl ??= device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 1, visibility: SS.FRAGMENT, sampler: {} },
            ],
        });
    }
    blitPipelines ??= new Map();
    const key = `${format}:${multisampled ? "msaa" : ""}`;
    let pipeline = blitPipelines.get(key);
    if (!pipeline) {
        const bgl = multisampled ? blitMsaaBgl! : blitBgl!;
        pipeline = device.createRenderPipeline({
            label: "transmission-copy",
            layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            vertex: { module: multisampled ? blitMsaaShader! : blitShader!, entryPoint: "vs" },
            fragment: { module: multisampled ? blitMsaaShader! : blitShader!, entryPoint: "fs", targets: [{ format }] },
            primitive: { topology: "triangle-list" },
        });
        blitPipelines.set(key, pipeline);
    }
    return pipeline;
}

function createTransmissionBlit(state: RenderTaskTransmissionState, engine: EngineContext, source: GPUTexture, multisampled: boolean): TransmissionBlitState {
    const device = engine._device;
    const pipeline = getBlitPipeline(engine, state.texture.texture.format, multisampled);
    const bindGroup = device.createBindGroup({
        layout: multisampled ? blitMsaaBgl! : blitBgl!,
        entries: multisampled
            ? [{ binding: 0, resource: source.createView() }]
            : [
                  { binding: 0, resource: source.createView() },
                  { binding: 1, resource: getBilinearSampler(engine) },
              ],
    });
    return { _pipeline: pipeline, _bindGroup: bindGroup };
}

function blitToTransmission(state: RenderTaskTransmissionState, engine: EngineContext): void {
    const blit = state._blit!;
    const pass = engine._currentEncoder.beginRenderPass({
        colorAttachments: [{ view: state._baseView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(blit._pipeline);
    pass.setBindGroup(0, blit._bindGroup);
    pass.draw(3);
    pass.end();
}

function canUpdateTransmission(state: RenderTaskTransmissionState): boolean {
    return state._copyCount === 0 || state._copies < state._copyCount;
}

function beginTaskPass(task: RenderTaskBase, resolveTarget: GPUTextureView | null, sampleCount: number, load: boolean): GPURenderPassEncoder {
    const att = task._colorAttachment;
    const config = task._config;
    const depthLoadOp = load || (config.depth ? config.depth._eager : config.depthClear === false) ? "load" : "clear";
    if (load) {
        att.loadOp = "load";
    }
    const depthAttachment = task._renderPassDescriptor.depthStencilAttachment;
    if (depthAttachment) {
        depthAttachment.depthLoadOp = depthLoadOp;
        if (depthAttachment.stencilLoadOp) {
            depthAttachment.stencilLoadOp = depthLoadOp;
        }
    }
    if (sampleCount > 1) {
        att.resolveTarget = resolveTarget ?? undefined;
    } else {
        att.resolveTarget = undefined;
    }
    return task.engine._currentEncoder.beginRenderPass(task._renderPassDescriptor);
}

function setPassState(task: RenderTaskBase, pass: GPURenderPassEncoder): void {
    const cfg = task._config;
    const rt = cfg.rt;
    const scene = task.scene;
    const camera = cfg.cam ?? scene.camera;
    const v = camera?.viewport;
    if (v) {
        const rw = rt._width;
        const rh = rt._height;
        const x = Math.floor(v.x * rw);
        const y = Math.floor((1 - v.y - v.height) * rh);
        const w = Math.ceil((v.x + v.width) * rw) - x;
        const h = Math.ceil((1 - v.y) * rh) - y;
        pass.setViewport(x, y, w, h, 0, 1);
        pass.setScissorRect(x, y, w, h);
    }
    pass.setBindGroup(0, task._sceneBG!);
}

function drawBaseTask(task: RenderTaskBase, pass: GPURenderPassEncoder): number {
    const eng = task.engine;
    const rt = task._config.rt;
    const opaqueBindings = task._opaqueBindings;
    const opaqueBundles = task._ob;

    setPassState(task, pass);

    if (task._lastVis !== _vis || opaqueBundles.length === 0) {
        const desc = rt._descriptor;
        const be = eng._device.createRenderBundleEncoder({
            colorFormats: desc.format ? [desc.format] : [],
            depthStencilFormat: task._targetSignature._depthStencilFormat,
            sampleCount: desc.samples ?? 1,
        });
        be.setBindGroup(0, task._sceneBG!);
        drawList(be, opaqueBindings, eng);
        opaqueBundles[0] = be.finish();
        task._lastVis = _vis;
    }
    let draws = opaqueBindings.length;
    pass.executeBundles(opaqueBundles);
    pass.setBindGroup(0, task._sceneBG!);
    draws += drawList(pass, task._directBindings, eng);
    return draws;
}

function normalizeCopyCount(cfg: RenderTask["_config"]["transmission"]): number {
    const count = cfg?.copyCount ?? 1;
    return count === Infinity ? 0 : Math.max(0, count | 0);
}

function applyTransmissionOptions(task: RenderTaskBase, options: TransmissionOptions | undefined): void {
    if (!options) {
        return;
    }
    let next = task._config.transmission;
    let changed = false;
    const set = <K extends keyof NonNullable<RenderTask["_config"]["transmission"]>>(key: K, value: NonNullable<RenderTask["_config"]["transmission"]>[K] | undefined): void => {
        if (value === undefined) {
            return;
        }
        next = { ...next, [key]: value };
        changed = true;
    };
    set("copyCount", options.copyCount);
    set("generateMipmaps", options.generateMipmaps);
    set("mipLevelCount", options.mipLevelCount);
    set("grabDepth", options.grabDepth);
    if (changed) {
        task._config.transmission = next;
    }
}

function transmissionMipLevelCount(cfg: RenderTask["_config"]["transmission"], width: number, height: number): number {
    if (cfg?.generateMipmaps === false) {
        return 1;
    }
    const full = Math.floor(Math.log2(Math.max(width, height))) + 1;
    const defaultCount = biasedMipLevelCount(width, height, REFRACTION_LOD_BIAS);
    const requested = cfg?.mipLevelCount;
    if (requested === undefined) {
        return Math.min(full, defaultCount);
    }
    return Math.min(full, Math.max(1, requested | 0));
}
