import type { NormalizedViewport } from "../camera/camera.js";
import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { RenderTarget, RenderTargetDescriptor, RenderTargetSignature } from "../engine/render-target.js";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget, targetSignatureKey } from "../engine/render-target.js";
import { getBilinearSampler, getNearestSampler } from "../resource/samplers.js";
import type { SceneContext, SceneContextInternal } from "../scene/scene-core.js";
import type { Task } from "./task.js";

export type PostProcessSamplingMode = "nearest" | "linear";
export type PostProcessAlphaMode = 0 | 1 | 2 | 7;

export interface PostProcessShaderConfig {
    fragmentWGSL: string;
    vertexOutputWGSL?: string;
    vertexMainWGSL?: string;
    fragmentWrapperWGSL?: string;
    uniformWGSL?: string;
    uniformByteLength?: number;
    uniformBinding?: number;
    writeUniforms?: (data: Float32Array) => void;
    extraTextureWGSL?: string;
    extraTextures?: readonly RenderTarget[];
}

export interface PostProcessTaskSettings {
    name?: string;
    sourceTexture: RenderTarget;
    sourceSamplingMode?: PostProcessSamplingMode;
    targetTexture?: RenderTarget | null;
    alphaMode?: PostProcessAlphaMode;
    viewport?: NormalizedViewport | null;
    /** Clear the target before drawing. Set false when several viewport passes share a target. */
    clear?: boolean;
}

export interface PostProcessTaskConfig extends PostProcessTaskSettings {
    _shader: PostProcessShaderConfig;
}

export interface PostProcessTask extends Task, PostProcessTaskSettings {
    readonly name: string;
    sourceSamplingMode: PostProcessSamplingMode;
    targetTexture: RenderTarget | null;
    alphaMode: PostProcessAlphaMode;
    viewport: NormalizedViewport | null;
    clear: boolean;
    outputTexture: RenderTarget;
    updateUniforms(): void;
}

interface PostProcessTaskInternal extends PostProcessTask {
    readonly _shader: PostProcessShaderConfig;
    _internalTarget: RenderTarget | null;
    _internalTargetKey: string;
    _pipeline: GPURenderPipeline | null;
    _bindGroup: GPUBindGroup | null;
    _bindGroupLayout: GPUBindGroupLayout | null;
    _pipelineLayout: GPUPipelineLayout | null;
    _shaderModule: GPUShaderModule | null;
    _shaderModuleCode: string;
    _uniformBuffer: GPUBuffer | null;
    _uniformData: Float32Array | null;
    _renderPassDescriptor: GPURenderPassDescriptor;
    _colorAttachment: GPURenderPassColorAttachment;
}

const fullscreenVertexWGSL = (
    outputFlipY: boolean,
    extraOutput: string,
    extraMain: string
) => `struct PostProcessVertexOutput{@builtin(position) position:vec4f,@location(0) uv:vec2f${extraOutput}}
@vertex fn postProcessVertex(@builtin(vertex_index) vertexIndex:u32)->PostProcessVertexOutput{var positions=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));let p=positions[vertexIndex];var out:PostProcessVertexOutput;out.position=vec4f(p,0,1);out.uv=vec2f(p.x*0.5+0.5,${outputFlipY ? "0.5-p.y*0.5" : "p.y*0.5+0.5"});${extraMain}return out;}`;

const SOURCE_WGSL = `@group(0) @binding(0) var sourceSampler:sampler;
@group(0) @binding(1) var sourceTextureSampler:texture_2d<f32>;
fn samplePostProcessSource(uv:vec2f)->vec4f{return textureSample(sourceTextureSampler,sourceSampler,uv);}
fn readPostProcessSource(uv:vec2f)->vec4f{let dims=vec2f(textureDimensions(sourceTextureSampler));let p=clamp(floor(uv*dims)+vec2f(0.5),vec2f(0.5),dims-vec2f(0.5));return textureSampleLevel(sourceTextureSampler,sourceSampler,p/dims,0);}`;

const FRAGMENT_WRAPPER_WGSL = `@fragment fn postProcessFragment(input:PostProcessVertexOutput)->@location(0) vec4f{return applyPostProcess(samplePostProcessSource(input.uv),input.uv);}`;

export function createPostProcessTask(config: PostProcessTaskConfig, engine: EngineContext, scene: SceneContext): PostProcessTask {
    const eng = engine as EngineContextInternal;
    const sc = scene as SceneContextInternal;
    const source = config.sourceTexture;
    const internalTarget = config.targetTexture ? null : createInternalTarget(config.name ?? "post-process", source);
    const colorAttachment: GPURenderPassColorAttachment = {
        view: undefined!,
        loadOp: "clear",
        storeOp: "store",
    };
    const task: PostProcessTaskInternal = {
        name: config.name ?? "post-process",
        engine: eng,
        scene: sc,
        _passes: [],
        sourceTexture: source,
        sourceSamplingMode: config.sourceSamplingMode ?? "linear",
        targetTexture: config.targetTexture ?? null,
        alphaMode: config.alphaMode ?? 0,
        viewport: config.viewport ?? null,
        clear: config.clear ?? true,
        outputTexture: config.targetTexture ?? internalTarget!,
        _shader: config._shader,
        _internalTarget: internalTarget,
        _internalTargetKey: internalTarget ? internalTargetKey(source) : "",
        _pipeline: null,
        _bindGroup: null,
        _bindGroupLayout: null,
        _pipelineLayout: null,
        _shaderModule: null,
        _shaderModuleCode: "",
        _uniformBuffer: null,
        _uniformData: null,
        _renderPassDescriptor: { label: config.name ?? "post-process", colorAttachments: [colorAttachment] },
        _colorAttachment: colorAttachment,
        record(): void {
            prepareOutputTarget(task);
            buildRenderTarget(task.outputTexture, eng);
            createPostProcessGpuState(task, eng);
        },
        execute(): number {
            applyColorAttachmentState(task._colorAttachment, task.outputTexture, eng, task.clear);
            const pass = eng._currentEncoder.beginRenderPass(task._renderPassDescriptor);
            applyViewport(pass, task.viewport, task.outputTexture);
            pass.setPipeline(task._pipeline!);
            pass.setBindGroup(0, task._bindGroup!);
            pass.draw(3);
            pass.end();
            return 1;
        },
        updateUniforms(): void {
            writePostProcessUniforms(task, eng);
        },
        dispose(): void {
            task._passes.length = 0;
            task._uniformBuffer?.destroy();
            task._uniformBuffer = null;
            task._uniformData = null;
            task._pipeline = null;
            task._bindGroup = null;
            task._bindGroupLayout = null;
            task._pipelineLayout = null;
            task._shaderModule = null;
            task._shaderModuleCode = "";
            if (task._internalTarget) {
                disposeRenderTarget(task._internalTarget);
            }
        },
    };
    return task;
}

function createPostProcessGpuState(task: PostProcessTaskInternal, engine: EngineContextInternal): void {
    const source = task.sourceTexture;
    if (!source._colorTexture || !source._colorView) {
        throw new Error(`PostProcessTask "${task.name}": sourceTexture has no color texture. Render the source to an offscreen RenderTarget before post-processing.`);
    }
    if ((source._descriptor.sampleCount ?? 1) !== 1) {
        throw new Error(`PostProcessTask "${task.name}": multisampled source textures are not supported. Use a sampleCount: 1 source RenderTarget.`);
    }
    const target = task.outputTexture;
    const colorFormat = target._descriptor.colorFormat;
    if (!colorFormat) {
        throw new Error(`PostProcessTask "${task.name}": outputTexture must have a colorFormat.`);
    }
    task._uniformBuffer ??= createUniformBuffer(task, engine);
    task._uniformData ??= createUniformData(task);
    writePostProcessUniforms(task, engine);

    const bgl = getBindGroupLayout(task, engine);
    task._pipelineLayout ??= engine.device.createPipelineLayout({ label: `${task.name}-pipeline-layout`, bindGroupLayouts: [bgl] });
    const signature: RenderTargetSignature = {
        _colorFormat: colorFormat,
        _sampleCount: target._descriptor.sampleCount ?? 1,
    };
    task._pipeline = engine.device.createRenderPipeline({
        label: `${task.name}-${targetSignatureKey(signature)}-${task.alphaMode}`,
        layout: task._pipelineLayout,
        vertex: { module: getShaderModule(task, engine), entryPoint: "postProcessVertex" },
        fragment: {
            module: getShaderModule(task, engine),
            entryPoint: "postProcessFragment",
            targets: [{ format: colorFormat, blend: alphaModeToBlend(task.alphaMode) }],
        },
        primitive: { topology: "triangle-list" },
        multisample: { count: signature._sampleCount },
    });
    const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: task.sourceSamplingMode === "nearest" ? getNearestSampler(engine) : getBilinearSampler(engine) },
        { binding: 1, resource: source._colorView },
    ];
    const extraTextures = task._shader.extraTextures ?? [];
    if (task._uniformBuffer) {
        entries.push({ binding: getUniformBinding(task), resource: { buffer: task._uniformBuffer } });
    }
    for (let i = 0; i < extraTextures.length; i++) {
        const texture = extraTextures[i]!;
        if (!texture._colorView) {
            throw new Error(`PostProcessTask "${task.name}": extra texture ${i} has no color texture.`);
        }
        entries.push({ binding: 2 + i, resource: texture._colorView });
    }
    task._bindGroup = engine.device.createBindGroup({
        label: `${task.name}-bind-group`,
        layout: bgl,
        entries,
    });
}

function prepareOutputTarget(task: PostProcessTaskInternal): void {
    const target = task.targetTexture;
    if (target) {
        task.outputTexture = target;
        return;
    }
    const key = internalTargetKey(task.sourceTexture);
    if (task._internalTarget && task._internalTargetKey === key) {
        task.outputTexture = task._internalTarget;
        return;
    }
    if (task._internalTarget) {
        disposeRenderTarget(task._internalTarget);
    }
    task._internalTarget = createInternalTarget(task.name, task.sourceTexture);
    task._internalTargetKey = key;
    task.outputTexture = task._internalTarget;
}

function createInternalTarget(name: string, source: RenderTarget): RenderTarget {
    const srcDesc = source._descriptor;
    if (!srcDesc.colorFormat) {
        throw new Error(`PostProcessTask "${name}": sourceTexture must have a colorFormat.`);
    }
    const desc: RenderTargetDescriptor = {
        label: `${name}-output`,
        colorFormat: srcDesc.colorFormat,
        sampleCount: 1,
        size: srcDesc.size,
    };
    return createRenderTarget(desc);
}

function internalTargetKey(source: RenderTarget): string {
    const desc = source._descriptor;
    const size = desc.size === "canvas" ? "canvas" : `${desc.size.width}x${desc.size.height}`;
    return `${desc.colorFormat ?? "-"}|${desc.sampleCount ?? 1}|${size}`;
}

function getBindGroupLayout(task: PostProcessTaskInternal, engine: EngineContextInternal): GPUBindGroupLayout {
    const hasUniform = (task._shader.uniformByteLength ?? 0) > 0;
    if (task._bindGroupLayout) {
        return task._bindGroupLayout;
    }
    const entries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    ];
    const extraTextures = task._shader.extraTextures ?? [];
    for (let i = 0; i < extraTextures.length; i++) {
        entries.push({ binding: 2 + i, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } });
    }
    if (hasUniform) {
        entries.push({ binding: getUniformBinding(task), visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } });
    }
    task._bindGroupLayout = engine.device.createBindGroupLayout({ label: `${task.name}-bind-group-layout`, entries });
    return task._bindGroupLayout;
}

function getUniformBinding(task: PostProcessTaskInternal): number {
    return task._shader.uniformBinding ?? 2 + (task._shader.extraTextures?.length ?? 0);
}

function getShaderModule(task: PostProcessTaskInternal, engine: EngineContextInternal): GPUShaderModule {
    const desc = task.outputTexture._descriptor;
    // Offscreen sources rendered without a projection flip match Babylon.js post-process sources;
    // compensate when sampling so derivative-dependent scene shading is not altered.
    const outputFlipY = (desc.flipY ?? desc.resolveToSwapchain !== true) || task.sourceTexture._descriptor.flipY === false;
    const code = `${fullscreenVertexWGSL(outputFlipY, task._shader.vertexOutputWGSL ?? "", task._shader.vertexMainWGSL ?? "")}\n${SOURCE_WGSL}\n${task._shader.extraTextureWGSL ?? ""}\n${task._shader.uniformWGSL ?? ""}\n${task._shader.fragmentWGSL}\n${task._shader.fragmentWrapperWGSL ?? FRAGMENT_WRAPPER_WGSL}`;
    if (!task._shaderModule || task._shaderModuleCode !== code) {
        task._shaderModuleCode = code;
        task._shaderModule = engine.device.createShaderModule({
            label: task.name,
            code,
        });
    }
    return task._shaderModule;
}

function createUniformBuffer(task: PostProcessTaskInternal, engine: EngineContextInternal): GPUBuffer | null {
    const size = align16(task._shader.uniformByteLength ?? 0);
    if (size === 0) {
        return null;
    }
    return engine.device.createBuffer({
        label: `${task.name}-uniforms`,
        size,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
}

function createUniformData(task: PostProcessTaskInternal): Float32Array | null {
    const size = align16(task._shader.uniformByteLength ?? 0);
    return size === 0 ? null : new Float32Array(size / 4);
}

function writePostProcessUniforms(task: PostProcessTaskInternal, engine: EngineContextInternal): void {
    if ((task._shader.uniformByteLength ?? 0) === 0) {
        return;
    }
    task._uniformData!.fill(0);
    task._shader.writeUniforms?.(task._uniformData!);
    engine.device.queue.writeBuffer(task._uniformBuffer!, 0, task._uniformData as Float32Array<ArrayBuffer>);
}

function applyColorAttachmentState(att: GPURenderPassColorAttachment, rt: RenderTarget, eng: EngineContextInternal, clear: boolean): void {
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
    att.loadOp = clear ? "clear" : "load";
}

function applyViewport(pass: GPURenderPassEncoder, viewport: NormalizedViewport | null, rt: RenderTarget): void {
    if (!viewport) {
        return;
    }
    const x = Math.floor(viewport.x * rt._width);
    const y = Math.floor((1 - viewport.y - viewport.height) * rt._height);
    const w = Math.ceil((viewport.x + viewport.width) * rt._width) - x;
    const h = Math.ceil((1 - viewport.y) * rt._height) - y;
    pass.setViewport(x, y, w, h, 0, 1);
    pass.setScissorRect(x, y, w, h);
}

function alphaModeToBlend(mode: PostProcessAlphaMode): GPUBlendState | undefined {
    switch (mode) {
        case 1:
            return {
                color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            };
        case 2:
            return {
                color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            };
        case 7:
            return {
                color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            };
        default:
            return undefined;
    }
}

function align16(value: number): number {
    return Math.ceil(value / 16) * 16;
}
