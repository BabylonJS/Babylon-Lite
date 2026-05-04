import { registerRenderingContext, unregisterRenderingContext } from "../engine/engine.js";
import type { EngineContext, EngineContextInternal, RenderingContext } from "../engine/engine.js";
import type { RenderTarget, RenderTargetSignature } from "../engine/render-target.js";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget, targetSignatureKey } from "../engine/render-target.js";
import type { SceneContext, SceneContextInternal } from "../scene/scene-core.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { Task } from "../frame-graph/task.js";

const DEFAULT_VERTEX_WGSL = `struct EffectVertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>};
@vertex fn effectFullscreenVertex(@builtin(vertex_index) vertexIndex:u32)->EffectVertexOutput{var positions=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));let p=positions[vertexIndex];var out:EffectVertexOutput;out.position=vec4<f32>(p,0.0,1.0);out.uv=p*0.5+vec2<f32>(0.5,0.5);return out;}`;

export type EffectBindingKind = "uniform" | "texture" | "sampler";

export interface EffectBindingLayout {
    name?: string;
    binding: number;
    kind: EffectBindingKind;
    visibility?: GPUShaderStageFlags;
    uniformByteLength?: number;
    textureSampleType?: GPUTextureSampleType;
    samplerType?: GPUSamplerBindingType;
    textureBinding?: string | number;
}

export interface EffectWrapperOptions {
    name?: string;
    fragmentWGSL: string;
    vertexWGSL?: string;
    bindings?: EffectBindingLayout[];
    blend?: GPUBlendState;
}

interface EffectUniformSlot {
    readonly layout: EffectBindingLayout;
    buffer: GPUBuffer;
    byteLength: number;
}

interface EffectTextureSlot {
    readonly layout: EffectBindingLayout;
    texture: Texture2D | null;
}

export interface EffectWrapper {
    readonly name: string;
    readonly options: EffectWrapperOptions;
}

interface EffectWrapperInternal extends EffectWrapper {
    _engine: EngineContextInternal;
    _shader: GPUShaderModule | null;
    _bindGroupLayout: GPUBindGroupLayout | null;
    _pipelineLayout: GPUPipelineLayout | null;
    _bindGroup: GPUBindGroup | null;
    _bindGroupDirty: boolean;
    _pipelines: Map<string, GPURenderPipeline> | null;
    _uniforms: EffectUniformSlot[];
    _textures: EffectTextureSlot[];
}

export interface EffectRenderTaskConfig {
    name: string;
    effect: EffectWrapper;
    target: RenderTarget;
    clear?: boolean;
    clearColor?: GPUColorDict;
}

export interface EffectRenderTask extends Task {
    readonly name: string;
    readonly _config: EffectRenderTaskConfig;
    readonly _rt: RenderTarget;
}

interface EffectRenderTaskInternal extends EffectRenderTask {
    _targetSignature: RenderTargetSignature;
    _renderPassDescriptor: GPURenderPassDescriptor;
    _colorAttachment: GPURenderPassColorAttachment;
    _pipeline: GPURenderPipeline | null;
    _bindGroup: GPUBindGroup | null;
}

// ─── Direct swapchain renderer (no scene / frame graph required) ─────────────

/** Options for `createEffectRenderer`. */
export interface EffectRendererOptions {
    /** Label for GPU resources. Defaults to the effect's own name. */
    name?: string;
    /** Whether to clear the swapchain before drawing. Defaults to `true`. */
    clear?: boolean;
    /** Clear colour. Defaults to opaque black. */
    clearColor?: GPUColorDict;
}

/**
 * `EffectRenderer` — a fullscreen-effect `RenderingContext` that draws
 * directly to the swapchain without a `SceneContext` or frame-graph task.
 * Use `registerEffectRenderer` / `unregisterEffectRenderer` to attach it to
 * an engine, then call `startEngine` as usual.
 *
 * For offscreen render-to-texture workflows (effect result consumed by a
 * scene material) continue to use `createEffectRenderTask` inside a scene
 * frame graph.
 */
export interface EffectRenderer extends RenderingContext {
    readonly name: string;
}

interface EffectRendererInternal extends EffectRenderer {
    _engine: EngineContextInternal;
    _effect: EffectWrapperInternal;
    _clear: boolean;
    _rt: RenderTarget;
    _targetSignature: RenderTargetSignature;
    _renderPassDescriptor: GPURenderPassDescriptor;
    _colorAttachment: GPURenderPassColorAttachment;
    _pipeline: GPURenderPipeline | null;
    _bindGroup: GPUBindGroup | null;
    _disposed: boolean;
}

export function createEffectWrapper(engine: EngineContext, options: EffectWrapperOptions): EffectWrapper {
    const eng = engine as EngineContextInternal;
    const wrapper: EffectWrapperInternal = {
        name: options.name ?? "effect-wrapper",
        options,
        _engine: eng,
        _shader: null,
        _bindGroupLayout: null,
        _pipelineLayout: null,
        _bindGroup: null,
        _bindGroupDirty: true,
        _pipelines: null,
        _uniforms: [],
        _textures: [],
    };
    createBindingSlots(wrapper);
    return wrapper;
}

export function setEffectUniforms(wrapper: EffectWrapper, data: ArrayBuffer | ArrayBufferView | Record<string | number, ArrayBuffer | ArrayBufferView>): void {
    const internal = wrapper as EffectWrapperInternal;
    if (isBufferData(data)) {
        const slot = internal._uniforms[0];
        if (!slot) {
            throw new Error("setEffectUniforms: wrapper has no uniform binding.");
        }
        writeUniformSlot(internal, slot, data);
        return;
    }
    for (const key of Object.keys(data)) {
        const slot = findUniformSlot(internal, key);
        if (!slot) {
            throw new Error(`setEffectUniforms: unknown uniform binding "${key}".`);
        }
        writeUniformSlot(internal, slot, data[key]!);
    }
}

export function setEffectTexture(wrapper: EffectWrapper, bindingNameOrIndex: string | number, texture: Texture2D): void {
    const internal = wrapper as EffectWrapperInternal;
    const slot = findTextureSlot(internal, bindingNameOrIndex);
    if (!slot) {
        throw new Error(`setEffectTexture: unknown texture binding "${String(bindingNameOrIndex)}".`);
    }
    slot.texture = texture;
    internal._bindGroupDirty = true;
}

export function createEffectRenderTask(config: EffectRenderTaskConfig, engine: EngineContext, scene: SceneContext): EffectRenderTask {
    const eng = engine as EngineContextInternal;
    const sc = scene as SceneContextInternal;
    const effect = config.effect as EffectWrapperInternal;
    const rt = config.target;
    config.clearColor ??= { r: 0, g: 0, b: 0, a: 1 };
    const sampleCount = rt.descriptor.sampleCount ?? 1;
    const targetSignature: RenderTargetSignature = {
        colorFormat: rt.descriptor.colorFormat,
        sampleCount,
    };
    const colorAttachment: GPURenderPassColorAttachment = {
        view: undefined!,
        loadOp: "clear",
        storeOp: "store",
    };
    const task: EffectRenderTaskInternal = {
        name: config.name,
        _config: config,
        engine: eng,
        scene: sc,
        _rt: rt,
        _targetSignature: targetSignature,
        _renderPassDescriptor: { label: config.name, colorAttachments: [colorAttachment] },
        _colorAttachment: colorAttachment,
        _pipeline: null,
        _bindGroup: null,
        record(): void {
            buildRenderTarget(rt, eng);
            task._pipeline = getEffectPipeline(effect, task._targetSignature);
            task._bindGroup = getEffectBindGroup(effect);
            patchColorAttachment(task, eng);
        },
        execute(): number {
            const encoder = eng._currentEncoder;
            if (!encoder) {
                return 0;
            }
            patchColorAttachment(task, eng);
            const pipeline = task._pipeline;
            if (!pipeline) {
                throw new Error(`EffectRenderTask "${task.name}" executed before record().`);
            }
            const pass = encoder.beginRenderPass(task._renderPassDescriptor);
            pass.setPipeline(pipeline);
            if (task._bindGroup) {
                pass.setBindGroup(0, task._bindGroup);
            }
            pass.draw(3);
            pass.end();
            return 1;
        },
        dispose(): void {
            disposeRenderTarget(task._rt);
            task._pipeline = null;
            task._bindGroup = null;
            task._renderPassDescriptor = { colorAttachments: [] };
        },
    };
    return task;
}

export function disposeEffectWrapper(wrapper: EffectWrapper): void {
    const internal = wrapper as EffectWrapperInternal;
    for (const slot of internal._uniforms) {
        slot.buffer.destroy();
    }
    internal._uniforms.length = 0;
    internal._textures.length = 0;
    internal._pipelines?.clear();
    internal._pipelines = null;
    internal._shader = null;
    internal._bindGroupLayout = null;
    internal._pipelineLayout = null;
    internal._bindGroup = null;
    internal._bindGroupDirty = true;
}

/**
 * Create an `EffectRenderer` that draws `effect` as a fullscreen pass to the
 * swapchain each frame. The renderer owns a swapchain `RenderTarget` and
 * implements `RenderingContext` directly — no `SceneContext` is needed.
 *
 * Call `registerEffectRenderer` to start rendering, `unregisterEffectRenderer`
 * to pause, and `disposeEffectRenderer` to free GPU resources.
 */
export function createEffectRenderer(engine: EngineContext, effect: EffectWrapper, options?: EffectRendererOptions): EffectRenderer {
    const eng = engine as EngineContextInternal;
    const ew = effect as EffectWrapperInternal;
    const name = options?.name ?? effect.name;
    const clear = options?.clear !== false;
    const clearColor: GPUColorDict = options?.clearColor ?? { r: 0, g: 0, b: 0, a: 1 };

    const rt = createRenderTarget({
        label: `${name}-swapchain`,
        colorFormat: eng.format,
        sampleCount: eng.msaaSamples,
        size: "canvas",
        resolveToSwapchain: true,
    });

    const targetSignature: RenderTargetSignature = {
        colorFormat: rt.descriptor.colorFormat,
        sampleCount: rt.descriptor.sampleCount ?? 1,
    };

    const colorAttachment: GPURenderPassColorAttachment = {
        view: undefined!,
        loadOp: "clear",
        storeOp: "store",
    };
    const renderPassDescriptor: GPURenderPassDescriptor = { label: name, colorAttachments: [colorAttachment] };

    const er: EffectRendererInternal = {
        name,
        clearColor,
        _drawCallsPre: 0,
        _engine: eng,
        _effect: ew,
        _clear: clear,
        _rt: rt,
        _targetSignature: targetSignature,
        _renderPassDescriptor: renderPassDescriptor,
        _colorAttachment: colorAttachment,
        _pipeline: null,
        _bindGroup: null,
        _disposed: false,
        _update(): void {},
        _record(): number {
            if (er._disposed) {
                return 0;
            }
            ensureRtCanvasSize(er._rt, er._engine);
            applyColorAttachmentState(er._colorAttachment, er._rt, er._engine, er._clear, er.clearColor);
            const encoder = er._engine._currentEncoder;
            if (!encoder) {
                return 0;
            }
            const pipeline = er._pipeline;
            if (!pipeline) {
                throw new Error(`EffectRenderer "${er.name}" recorded before registerEffectRenderer().`);
            }
            const pass = encoder.beginRenderPass(er._renderPassDescriptor);
            pass.setPipeline(pipeline);
            if (er._bindGroup) {
                pass.setBindGroup(0, er._bindGroup);
            }
            pass.draw(3);
            pass.end();
            return 1;
        },
        _resize(): void {
            if (er._disposed) {
                return;
            }
            buildRenderTarget(er._rt, er._engine);
        },
    };
    return er;
}

/** Register the effect renderer with its engine. Idempotent — a second call is a no-op. */
export function registerEffectRenderer(er: EffectRenderer): void {
    const internal = er as EffectRendererInternal;
    prepareEffectRenderer(internal);
    registerRenderingContext(internal._engine, er);
}

/** Unregister the effect renderer from its engine. No-op if not registered. */
export function unregisterEffectRenderer(er: EffectRenderer): void {
    unregisterRenderingContext((er as EffectRendererInternal)._engine, er);
}

/** Unregister and free all GPU resources owned by the renderer. */
export function disposeEffectRenderer(er: EffectRenderer): void {
    const internal = er as EffectRendererInternal;
    if (internal._disposed) {
        return;
    }
    unregisterEffectRenderer(er);
    disposeRenderTarget(internal._rt);
    internal._disposed = true;
}

function createBindingSlots(wrapper: EffectWrapperInternal): void {
    const layouts = [...(wrapper.options.bindings ?? [])].sort((a, b) => a.binding - b.binding);
    const seen = new Set<number>();
    for (const layout of layouts) {
        if (seen.has(layout.binding)) {
            throw new Error(`createEffectWrapper: duplicate binding ${layout.binding}.`);
        }
        seen.add(layout.binding);
        if (layout.kind === "uniform") {
            const byteLength = align4(layout.uniformByteLength ?? 16);
            const buffer = wrapper._engine.device.createBuffer({
                label: `${wrapper.name}-${layout.name ?? layout.binding}-ubo`,
                size: byteLength,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            wrapper._uniforms.push({ layout, buffer, byteLength });
        } else if (layout.kind === "texture") {
            wrapper._textures.push({ layout, texture: null });
        }
    }
}

function applyColorAttachmentState(att: GPURenderPassColorAttachment, rt: RenderTarget, eng: EngineContextInternal, clear: boolean, clearColor: GPUColorDict): void {
    att.clearValue = clearColor;
    att.loadOp = clear ? "clear" : "load";
    if (rt.descriptor.resolveToSwapchain === true) {
        if ((rt.descriptor.sampleCount ?? 1) > 1) {
            att.view = rt._colorView!;
            att.resolveTarget = eng._swapchainView;
        } else {
            att.view = eng._swapchainView;
            att.resolveTarget = undefined;
        }
    } else {
        att.view = rt._colorView!;
        att.resolveTarget = undefined;
    }
}

function patchColorAttachment(task: EffectRenderTaskInternal, eng: EngineContextInternal): void {
    applyColorAttachmentState(task._colorAttachment, task._rt, eng, task._config.clear !== false, task._config.clearColor!);
}

function ensureRtCanvasSize(rt: RenderTarget, eng: EngineContextInternal): void {
    if (rt.descriptor.size !== "canvas") {
        return;
    }
    if (rt._width === eng.canvas.width && rt._height === eng.canvas.height) {
        return;
    }
    buildRenderTarget(rt, eng);
}

function getEffectPipeline(wrapper: EffectWrapperInternal, targetSignature: RenderTargetSignature): GPURenderPipeline {
    const key = targetSignatureKey(targetSignature);
    if (!wrapper._pipelines) {
        wrapper._pipelines = new Map();
    }
    const hit = wrapper._pipelines.get(key);
    if (hit) {
        return hit;
    }
    const device = wrapper._engine.device;
    const pipeline = device.createRenderPipeline({
        label: `${wrapper.name}-${key}`,
        layout: getPipelineLayout(wrapper),
        vertex: { module: getShaderModule(wrapper), entryPoint: "effectFullscreenVertex" },
        fragment: {
            module: getShaderModule(wrapper),
            entryPoint: "effectFragment",
            targets: [{ format: targetSignature.colorFormat, blend: wrapper.options.blend }],
        },
        primitive: { topology: "triangle-list" },
        multisample: { count: targetSignature.sampleCount },
    });
    wrapper._pipelines.set(key, pipeline);
    return pipeline;
}

function getShaderModule(wrapper: EffectWrapperInternal): GPUShaderModule {
    if (!wrapper._shader) {
        wrapper._shader = wrapper._engine.device.createShaderModule({
            label: wrapper.name,
            code: `${wrapper.options.vertexWGSL ?? DEFAULT_VERTEX_WGSL}\n${wrapper.options.fragmentWGSL}`,
        });
    }
    return wrapper._shader;
}

function getPipelineLayout(wrapper: EffectWrapperInternal): GPUPipelineLayout {
    if (!wrapper._pipelineLayout) {
        wrapper._pipelineLayout = wrapper._engine.device.createPipelineLayout({
            label: `${wrapper.name}-pipeline-layout`,
            bindGroupLayouts: [getBindGroupLayout(wrapper)],
        });
    }
    return wrapper._pipelineLayout;
}

function getBindGroupLayout(wrapper: EffectWrapperInternal): GPUBindGroupLayout {
    if (!wrapper._bindGroupLayout) {
        const entries = (wrapper.options.bindings ?? [])
            .slice()
            .sort((a, b) => a.binding - b.binding)
            .map((layout) => bindingLayoutEntry(layout));
        wrapper._bindGroupLayout = wrapper._engine.device.createBindGroupLayout({
            label: `${wrapper.name}-bgl`,
            entries,
        });
    }
    return wrapper._bindGroupLayout;
}

function bindingLayoutEntry(layout: EffectBindingLayout): GPUBindGroupLayoutEntry {
    const visibility = layout.visibility ?? GPUShaderStage.FRAGMENT;
    if (layout.kind === "uniform") {
        return { binding: layout.binding, visibility, buffer: { type: "uniform" } };
    }
    if (layout.kind === "texture") {
        return { binding: layout.binding, visibility, texture: { sampleType: layout.textureSampleType ?? "float" } };
    }
    return { binding: layout.binding, visibility, sampler: { type: layout.samplerType ?? "filtering" } };
}

function getEffectBindGroup(wrapper: EffectWrapperInternal): GPUBindGroup | null {
    const bindings = wrapper.options.bindings ?? [];
    if (bindings.length === 0) {
        return null;
    }
    if (!wrapper._bindGroupDirty && wrapper._bindGroup) {
        return wrapper._bindGroup;
    }
    const entries = bindings
        .slice()
        .sort((a, b) => a.binding - b.binding)
        .map((layout) => bindGroupEntry(wrapper, layout));
    wrapper._bindGroup = wrapper._engine.device.createBindGroup({
        label: `${wrapper.name}-bg`,
        layout: getBindGroupLayout(wrapper),
        entries,
    });
    wrapper._bindGroupDirty = false;
    return wrapper._bindGroup;
}

function prepareEffectRenderer(er: EffectRendererInternal): void {
    er._pipeline ??= getEffectPipeline(er._effect, er._targetSignature);
    er._bindGroup = getEffectBindGroup(er._effect);
}

function bindGroupEntry(wrapper: EffectWrapperInternal, layout: EffectBindingLayout): GPUBindGroupEntry {
    if (layout.kind === "uniform") {
        const slot = findUniformSlot(wrapper, layout.binding);
        if (!slot) {
            throw new Error(`Effect "${wrapper.name}" missing uniform binding ${layout.binding}.`);
        }
        return { binding: layout.binding, resource: { buffer: slot.buffer, size: slot.byteLength } };
    }
    if (layout.kind === "texture") {
        const slot = findTextureSlot(wrapper, layout.binding);
        if (!slot?.texture) {
            throw new Error(`Effect "${wrapper.name}" missing texture binding ${layout.binding}.`);
        }
        return { binding: layout.binding, resource: slot.texture.view };
    }
    const textureSlot = layout.textureBinding != null ? findTextureSlot(wrapper, layout.textureBinding) : wrapper._textures[0];
    if (!textureSlot?.texture) {
        throw new Error(`Effect "${wrapper.name}" missing texture for sampler binding ${layout.binding}.`);
    }
    return { binding: layout.binding, resource: textureSlot.texture.sampler };
}

function findUniformSlot(wrapper: EffectWrapperInternal, bindingNameOrIndex: string | number): EffectUniformSlot | undefined {
    return wrapper._uniforms.find((slot) => matchesBinding(slot.layout, bindingNameOrIndex));
}

function findTextureSlot(wrapper: EffectWrapperInternal, bindingNameOrIndex: string | number): EffectTextureSlot | undefined {
    return wrapper._textures.find((slot) => matchesBinding(slot.layout, bindingNameOrIndex));
}

function matchesBinding(layout: EffectBindingLayout, bindingNameOrIndex: string | number): boolean {
    if (typeof bindingNameOrIndex === "number") {
        return layout.binding === bindingNameOrIndex;
    }
    return layout.name === bindingNameOrIndex || String(layout.binding) === bindingNameOrIndex;
}

function writeUniformSlot(wrapper: EffectWrapperInternal, slot: EffectUniformSlot, data: ArrayBuffer | ArrayBufferView): void {
    const bytes = toBytes(data);
    if (bytes.byteLength > slot.byteLength) {
        throw new Error(`writeUniformSlot: ${bytes.byteLength} bytes exceeds uniform binding ${slot.layout.binding} size ${slot.byteLength}.`);
    }
    wrapper._engine.device.queue.writeBuffer(slot.buffer, 0, bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function isBufferData(data: ArrayBuffer | ArrayBufferView | Record<string | number, ArrayBuffer | ArrayBufferView>): data is ArrayBuffer | ArrayBufferView {
    return data instanceof ArrayBuffer || ArrayBuffer.isView(data);
}

function align4(value: number): number {
    return (value + 3) & ~3;
}
