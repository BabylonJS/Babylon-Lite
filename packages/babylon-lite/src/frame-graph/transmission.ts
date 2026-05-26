import type { EngineContextInternal } from "../engine/engine.js";
import { _vis } from "../engine/engine.js";
import { getBilinearSampler } from "../resource/samplers.js";
import { getTrilinearAnisotropicSampler } from "../resource/trilinear-anisotropic-sampler.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { recordMipmaps } from "../texture/generate-mipmaps.js";
import { biasedMipLevelCount } from "../texture/mip-count.js";
import type { DrawBinding } from "../render/renderable.js";
import type { RenderTask } from "./render-task.js";
import type { SceneContextInternal } from "../scene/scene-core.js";
import { createImageProcessingTask } from "./image-processing-task.js";

export interface RenderTaskTransmissionState {
    readonly texture: Texture2D;
    readonly _baseView: GPUTextureView;
    _sourceWidth: number;
    _sourceHeight: number;
    _sourceTexture: GPUTexture | null;
    _blit: TransmissionBlitState | null;
    readonly _copyCount: number;
    readonly _generateMipmaps: boolean;
    _copies: number;
}

interface TransmissionBlitState {
    readonly _pipeline: GPURenderPipeline;
    readonly _bindGroup: GPUBindGroup;
}

const BLIT_SHADER = `@group(0)@binding(0)var t:texture_2d<f32>;@group(0)@binding(1)var s:sampler;struct V{@builtin(position)p:vec4f,@location(0)u:vec2f};@vertex fn vs(@builtin(vertex_index)i:u32)->V{var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var u=array<vec2f,3>(vec2f(0,1),vec2f(2,1),vec2f(0,-1));return V(vec4f(p[i],0,1),u[i]);}@fragment fn fs(v:V)->@location(0)vec4f{return textureSample(t,s,v.u);}`;
const BLIT_MSAA_SHADER = `@group(0)@binding(0)var t:texture_multisampled_2d<f32>;struct V{@builtin(position)p:vec4f,@location(0)u:vec2f};@vertex fn vs(@builtin(vertex_index)i:u32)->V{var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var u=array<vec2f,3>(vec2f(0,1),vec2f(2,1),vec2f(0,-1));return V(vec4f(p[i],0,1),u[i]);}fn l(p:vec2i)->vec4f{let n=textureNumSamples(t);var c=vec4f(0);for(var i=0u;i<n;i++){c+=textureLoad(t,p,i);}return c/f32(n);}@fragment fn fs(v:V)->@location(0)vec4f{let d=vec2i(textureDimensions(t));let q=clamp(v.u*vec2f(d)-.5,vec2f(0),vec2f(d-vec2i(1)));let p=vec2i(floor(q));let f=fract(q);let p1=min(p+vec2i(1),d-vec2i(1));return mix(mix(l(p),l(vec2i(p1.x,p.y)),f.x),mix(l(vec2i(p.x,p1.y)),l(p1),f.x),f.y);}`;
const REFRACTION_LOD_BIAS = 4;
let blitPipelines: Map<string, GPURenderPipeline> | null = null;
let blitShader: GPUShaderModule | null = null;
let blitMsaaShader: GPUShaderModule | null = null;
let blitBgl: GPUBindGroupLayout | null = null;
let blitMsaaBgl: GPUBindGroupLayout | null = null;
let blitDevice: GPUDevice | null = null;

export function enableSceneTransmission(scene: SceneContextInternal, engine: EngineContextInternal): void {
    markPbrMaterialsLinear(scene);
    let lastRenderTask: RenderTask | null = null;
    for (const task of scene._frameGraph._tasks) {
        if ("_renderables" in task) {
            const renderTask = task as RenderTask;
            enableRenderTaskTransmission(renderTask, engine);
            lastRenderTask = renderTask;
        }
    }
    if (lastRenderTask && !scene._frameGraph._tasks.some((task) => task.name === "transmission-image-processing")) {
        scene._frameGraph._tasks.push(createImageProcessingTask({ name: "transmission-image-processing", source: lastRenderTask._config.rt }, engine, scene));
    }
}

export function enableRenderTaskTransmission(task: RenderTask, engine: EngineContextInternal): void {
    if (task._executeWithTransmission) {
        return;
    }
    retargetRenderTaskToLinearOffscreen(task, engine);
    let state: RenderTaskTransmissionState | null = null;
    const record = task.record.bind(task);
    const execute = task.execute?.bind(task);
    const dispose = task.dispose?.bind(task);
    task.record = () => {
        disposeRenderTaskTransmission(state);
        state = createRenderTaskTransmission(task, engine);
        (task._targetSignature as { _transmissionTexture?: Texture2D })._transmissionTexture = state.texture;
        record();
        configureTransmissionSource(state, task, engine);
    };
    if (execute) {
        task.execute = () => executeRenderTaskLinear(task.scene, execute);
    }
    task.dispose = () => {
        disposeRenderTaskTransmission(state);
        state = null;
        dispose?.();
    };
    task._executeWithTransmission = (sampleCount) => executePassWithTransmission(task, engine, state!, sampleCount);
}

function retargetRenderTaskToLinearOffscreen(task: RenderTask, engine: EngineContextInternal): void {
    const desc = task._config.rt._descriptor;
    if (desc.resolveToSwapchain) {
        desc.resolveToSwapchain = false;
        desc.colorFormat = "rgba16float";
        desc.flipY = false;
        task._opaqueBundles.length = 0;
        task._lastVersion = -1;
    } else if (!desc.colorFormat) {
        desc.colorFormat = "rgba16float";
    }
    desc.sampleCount = engine.msaaSamples;
    const sig = task._targetSignature as { colorFormat?: GPUTextureFormat; depthStencilFormat?: GPUTextureFormat; sampleCount: number; flipY?: boolean };
    sig.colorFormat = desc.colorFormat;
    sig.depthStencilFormat = desc.depthStencilFormat;
    sig.sampleCount = desc.sampleCount;
    sig.flipY = desc.flipY ?? true;
}

function executeRenderTaskLinear(scene: SceneContextInternal, execute: () => number): number {
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

function markPbrMaterialsLinear(scene: SceneContextInternal): void {
    for (const mesh of scene.meshes) {
        const mat = mesh.material as { _linearImageProcessing?: boolean; _renderFeatures?: unknown } | undefined;
        if (mat) {
            mat._linearImageProcessing = true;
            mat._renderFeatures = undefined;
        }
    }
}

function createRenderTaskTransmission(task: RenderTask, engine: EngineContextInternal): RenderTaskTransmissionState {
    const rt = task._config.rt;
    const width = 1024;
    const height = 1024;
    const format: GPUTextureFormat = "rgba16float";
    const generateMipmaps = shouldGenerateMipmaps(task._config.transmission);
    const texture = engine.device.createTexture({
        label: task.name,
        size: { width, height },
        format,
        mipLevelCount: generateMipmaps ? biasedMipLevelCount(width, height, REFRACTION_LOD_BIAS) : 1,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
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
        _sourceWidth: rt._width,
        _sourceHeight: rt._height,
        _sourceTexture: null,
        _blit: null,
        _copyCount: normalizeCopyCount(task._config.transmission),
        _generateMipmaps: generateMipmaps,
        _copies: 0,
    };
}

function configureTransmissionSource(state: RenderTaskTransmissionState, task: RenderTask, engine: EngineContextInternal): void {
    const rt = task._config.rt;
    state._sourceWidth = rt._width;
    state._sourceHeight = rt._height;
    state._sourceTexture = rt._colorTexture;
    const sampleCount = task._targetSignature.sampleCount;
    if (!state._sourceTexture) {
        return;
    }
    state._blit = shouldBlitTransmission(state, sampleCount) ? createTransmissionBlit(state, engine, state._sourceTexture, sampleCount > 1) : null;
}

function disposeRenderTaskTransmission(state: RenderTaskTransmissionState | null | undefined): void {
    state?.texture.texture.destroy();
}

export function executePassWithTransmission(task: RenderTask, engine: EngineContextInternal, state: RenderTaskTransmissionState, sampleCount: number): number {
    state._copies = 0;
    const transparent = task._transparentBindings;
    let pass = beginTaskPass(task, null, sampleCount, false);
    let draws = drawBaseTask(task, pass);
    let lastPipeline: GPURenderPipeline | null = null;
    for (let i = 0; i < transparent.length; i++) {
        const binding = transparent[i]!;
        const transmissive = binding.renderable._transmissive === true;
        if (transmissive && canUpdateTransmission(state)) {
            pass.end();
            updateTransmissionTexture(state, engine);
            pass = beginTaskPass(task, null, sampleCount, true);
            setPassState(task, pass);
            lastPipeline = null;
        }
        const mesh = binding.renderable.mesh;
        if (mesh && mesh.visible === false) {
            continue;
        }
        if (binding.pipeline !== lastPipeline) {
            pass.setPipeline(binding.pipeline);
            lastPipeline = binding.pipeline;
        }
        draws += binding.draw(pass, engine);
    }
    pass.end();
    return draws;
}

function updateTransmissionTexture(state: RenderTaskTransmissionState, engine: EngineContextInternal): void {
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
    state._copies++;
}

function getBlitPipeline(engine: EngineContextInternal, format: GPUTextureFormat, multisampled: boolean): GPURenderPipeline {
    const device = engine.device;
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
        blitMsaaShader ??= device.createShaderModule({ code: BLIT_MSAA_SHADER });
        blitMsaaBgl ??= device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", multisampled: true } }],
        });
    } else {
        blitShader ??= device.createShaderModule({ code: BLIT_SHADER });
        blitBgl ??= device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
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

function shouldBlitTransmission(state: RenderTaskTransmissionState, sampleCount: number): boolean {
    return sampleCount > 1 || state._sourceWidth !== state.texture.width || state._sourceHeight !== state.texture.height;
}

function createTransmissionBlit(state: RenderTaskTransmissionState, engine: EngineContextInternal, source: GPUTexture, multisampled: boolean): TransmissionBlitState {
    const device = engine.device;
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

function blitToTransmission(state: RenderTaskTransmissionState, engine: EngineContextInternal): void {
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

function beginTaskPass(task: RenderTask, resolveTarget: GPUTextureView | null, sampleCount: number, load: boolean): GPURenderPassEncoder {
    const att = task._colorAttachment;
    const depthLoadOp = load || !task._config.clr ? "load" : "clear";
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

function setPassState(task: RenderTask, pass: GPURenderPassEncoder): void {
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
    pass.setBindGroup(0, task._sceneBG);
}

function drawBaseTask(task: RenderTask, pass: GPURenderPassEncoder): number {
    const eng = task.engine;
    const rt = task._config.rt;
    const scene = task.scene;
    const opaqueBindings = task._opaqueBindings;
    const opaqueBundles = task._opaqueBundles;

    setPassState(task, pass);

    if (task._lastVersion !== scene._renderableVersion || task._lastVis !== _vis || opaqueBundles.length === 0) {
        const desc = rt._descriptor;
        const be = eng.device.createRenderBundleEncoder({
            colorFormats: desc.colorFormat ? [desc.colorFormat] : [],
            depthStencilFormat: desc.depthStencilFormat,
            sampleCount: desc.sampleCount ?? 1,
        });
        be.setBindGroup(0, task._sceneBG);
        drawList(be, opaqueBindings, eng);
        opaqueBundles[0] = be.finish();
        task._lastVersion = scene._renderableVersion;
        task._lastVis = _vis;
    }
    let draws = opaqueBindings.length;
    pass.executeBundles(opaqueBundles);
    pass.setBindGroup(0, task._sceneBG);
    draws += drawList(pass, task._directBindings, eng);
    return draws;
}

function drawList(enc: GPURenderPassEncoder | GPURenderBundleEncoder, list: readonly DrawBinding[], engine: EngineContextInternal): number {
    let lp: GPURenderPipeline | null = null;
    let draws = 0;
    for (const b of list) {
        const mesh = b.renderable.mesh;
        if (mesh && mesh.visible === false) {
            continue;
        }
        if (b.pipeline !== lp) {
            enc.setPipeline(b.pipeline);
            lp = b.pipeline;
        }
        draws += b.draw(enc, engine);
    }
    return draws;
}

function normalizeCopyCount(cfg: RenderTask["_config"]["transmission"]): number {
    const count = cfg?.copyCount ?? 1;
    return count === Infinity ? 0 : Math.max(0, count | 0);
}

function shouldGenerateMipmaps(cfg: RenderTask["_config"]["transmission"]): boolean {
    return cfg?.generateMipmaps !== false;
}
