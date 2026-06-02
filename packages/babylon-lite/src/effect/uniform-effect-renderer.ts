import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { RenderTarget, RenderTargetSignature } from "../engine/render-target.js";
import { buildRenderTarget, disposeRenderTarget, targetSignatureKey } from "../engine/render-target.js";
import type { Task } from "../frame-graph/task.js";
import type { SceneContext } from "../scene/scene-core.js";

const DEFAULT_VERTEX_WGSL = `struct EffectVertexOutput{@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>};
@vertex fn effectFullscreenVertex(@builtin(vertex_index) vertexIndex:u32)->EffectVertexOutput{var positions=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));let p=positions[vertexIndex];var out:EffectVertexOutput;out.position=vec4<f32>(p,0.0,1.0);out.uv=p*0.5+vec2<f32>(0.5,0.5);return out;}`;

/** Configuration for a lightweight fullscreen effect with exactly one uniform buffer at bind group 0 / binding 0. */
export interface UniformEffectWrapperOptions {
    name?: string;
    fragmentWGSL: string;
    vertexWGSL?: string;
    uniformByteLength: number;
}

/** Lightweight reusable fullscreen effect with a single uniform buffer and no texture or sampler bindings. */
export interface UniformEffectWrapper {
    readonly name: string;
    readonly options: UniformEffectWrapperOptions;
}

interface UniformEffectWrapperInternal extends UniformEffectWrapper {
    _engine: EngineContextInternal;
    _shader: GPUShaderModule | null;
    _bindGroupLayout: GPUBindGroupLayout | null;
    _pipelineLayout: GPUPipelineLayout | null;
    _bindGroup: GPUBindGroup | null;
    _uniformBuffer: GPUBuffer;
    _uniformByteLength: number;
}

/** Configuration for `createUniformEffectRenderTask`: the uniform effect to draw, its render target, and optional clear state. */
export interface UniformEffectRenderTaskConfig {
    name: string;
    effect: UniformEffectWrapper;
    target: RenderTarget;
    clear?: boolean;
    clearColor?: GPUColorDict;
}

/** A frame-graph task that draws a `UniformEffectWrapper` as a fullscreen pass into a render target. */
export interface UniformEffectRenderTask extends Task {
    readonly name: string;
    readonly _config: UniformEffectRenderTaskConfig;
    readonly _rt: RenderTarget;
}

interface UniformEffectRenderTaskInternal extends UniformEffectRenderTask {
    _targetSignature: RenderTargetSignature;
    _renderPassDescriptor: GPURenderPassDescriptor;
    _colorAttachment: GPURenderPassColorAttachment;
    _pipeline: GPURenderPipeline | null;
}

/**
 * Create a lightweight fullscreen effect with exactly one uniform buffer at binding 0.
 * @param engine - The engine that owns the GPU resources.
 * @param options - Shader source and uniform-buffer byte length.
 * @returns The new uniform effect wrapper.
 */
export function createUniformEffectWrapper(engine: EngineContext, options: UniformEffectWrapperOptions): UniformEffectWrapper {
    const eng = engine as EngineContextInternal;
    const byteLength = align4(options.uniformByteLength);
    return {
        name: options.name ?? "uniform-effect-wrapper",
        options,
        _engine: eng,
        _shader: null,
        _bindGroupLayout: null,
        _pipelineLayout: null,
        _bindGroup: null,
        _uniformBuffer: eng.device.createBuffer({
            label: `${options.name ?? "uniform-effect-wrapper"}-ubo`,
            size: byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        _uniformByteLength: byteLength,
    } as UniformEffectWrapperInternal;
}

/**
 * Write bytes into the uniform effect's single uniform buffer.
 * @param wrapper - The uniform effect wrapper to update.
 * @param data - Uniform bytes to upload.
 */
export function setUniformEffectUniforms(wrapper: UniformEffectWrapper, data: ArrayBuffer | ArrayBufferView): void {
    const internal = wrapper as UniformEffectWrapperInternal;
    const bytes = toBytes(data);
    if (bytes.byteLength > internal._uniformByteLength) {
        throw new Error(`setUniformEffectUniforms: ${bytes.byteLength} bytes exceeds uniform size ${internal._uniformByteLength}.`);
    }
    internal._engine.device.queue.writeBuffer(internal._uniformBuffer, 0, bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Create a frame-graph task that draws a uniform-only effect as a fullscreen pass into `config.target`.
 * @param config - The effect, target, and clear settings.
 * @param engine - The owning engine.
 * @param scene - Optional owning scene. Omit for scene-less standalone frame graphs.
 * @returns The render task to add to a frame graph.
 */
export function createUniformEffectRenderTask(config: UniformEffectRenderTaskConfig, engine: EngineContext, scene?: SceneContext): UniformEffectRenderTask {
    const eng = engine as EngineContextInternal;
    const effect = config.effect as UniformEffectWrapperInternal;
    const rt = config.target;
    config.clearColor ??= { r: 0, g: 0, b: 0, a: 1 };
    const sampleCount = rt._descriptor.sampleCount ?? 1;
    const targetSignature: RenderTargetSignature = {
        _colorFormat: rt._descriptor.colorFormat,
        _sampleCount: sampleCount,
    };
    const colorAttachment = { loadOp: "clear", storeOp: "store" } as GPURenderPassColorAttachment;
    const task: UniformEffectRenderTaskInternal = {
        name: config.name,
        _config: config,
        engine: eng,
        scene,
        _passes: [],
        _rt: rt,
        _targetSignature: targetSignature,
        _renderPassDescriptor: { label: config.name, colorAttachments: [colorAttachment] },
        _colorAttachment: colorAttachment,
        _pipeline: null,
        record(): void {
            buildRenderTarget(rt, eng);
            task._pipeline = getUniformEffectPipeline(effect, task._targetSignature);
        },
        execute(): number {
            const pipeline = task._pipeline;
            if (!pipeline) {
                throw new Error(`UniformEffectRenderTask "${task.name}" executed before record().`);
            }
            applyColorAttachmentState(task._colorAttachment, rt, eng, task._config.clear !== false, task._config.clearColor!);
            const pass = eng._currentEncoder.beginRenderPass(task._renderPassDescriptor);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, getUniformEffectBindGroup(effect));
            pass.draw(3);
            pass.end();
            return 1;
        },
        dispose(): void {
            task._passes.length = 0;
            disposeRenderTarget(task._rt);
            task._pipeline = null;
        },
    };
    return task;
}

/** Destroy the uniform buffer and clear cached GPU objects owned by the uniform effect wrapper. */
export function disposeUniformEffectWrapper(wrapper: UniformEffectWrapper): void {
    const internal = wrapper as UniformEffectWrapperInternal;
    internal._uniformBuffer.destroy();
    internal._shader = null;
    internal._bindGroupLayout = null;
    internal._pipelineLayout = null;
    internal._bindGroup = null;
}

function applyColorAttachmentState(att: GPURenderPassColorAttachment, rt: RenderTarget, eng: EngineContextInternal, clear: boolean, clearColor: GPUColorDict): void {
    att.clearValue = clearColor;
    att.loadOp = clear ? "clear" : "load";
    if (rt._descriptor.resolveToSwapchain === true) {
        if ((rt._descriptor.sampleCount ?? 1) > 1) {
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

function getUniformEffectPipeline(wrapper: UniformEffectWrapperInternal, targetSignature: RenderTargetSignature): GPURenderPipeline {
    const device = wrapper._engine.device;
    return device.createRenderPipeline({
        label: `${wrapper.name}-${targetSignatureKey(targetSignature)}`,
        layout: getPipelineLayout(wrapper),
        vertex: { module: getShaderModule(wrapper), entryPoint: "effectFullscreenVertex" },
        fragment: {
            module: getShaderModule(wrapper),
            entryPoint: "effectFragment",
            targets: [{ format: targetSignature._colorFormat! }],
        },
        primitive: { topology: "triangle-list" },
        multisample: { count: targetSignature._sampleCount },
    });
}

function getShaderModule(wrapper: UniformEffectWrapperInternal): GPUShaderModule {
    if (!wrapper._shader) {
        wrapper._shader = wrapper._engine.device.createShaderModule({
            label: wrapper.name,
            code: `${wrapper.options.vertexWGSL ?? DEFAULT_VERTEX_WGSL}\n${wrapper.options.fragmentWGSL}`,
        });
    }
    return wrapper._shader;
}

function getPipelineLayout(wrapper: UniformEffectWrapperInternal): GPUPipelineLayout {
    if (!wrapper._pipelineLayout) {
        wrapper._pipelineLayout = wrapper._engine.device.createPipelineLayout({
            label: `${wrapper.name}-pipeline-layout`,
            bindGroupLayouts: [getBindGroupLayout(wrapper)],
        });
    }
    return wrapper._pipelineLayout;
}

function getBindGroupLayout(wrapper: UniformEffectWrapperInternal): GPUBindGroupLayout {
    if (!wrapper._bindGroupLayout) {
        wrapper._bindGroupLayout = wrapper._engine.device.createBindGroupLayout({
            label: `${wrapper.name}-bgl`,
            entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
        });
    }
    return wrapper._bindGroupLayout;
}

function getUniformEffectBindGroup(wrapper: UniformEffectWrapperInternal): GPUBindGroup {
    if (!wrapper._bindGroup) {
        wrapper._bindGroup = wrapper._engine.device.createBindGroup({
            label: `${wrapper.name}-bg`,
            layout: getBindGroupLayout(wrapper),
            entries: [{ binding: 0, resource: { buffer: wrapper._uniformBuffer, size: wrapper._uniformByteLength } }],
        });
    }
    return wrapper._bindGroup;
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function align4(value: number): number {
    return (value + 3) & ~3;
}
