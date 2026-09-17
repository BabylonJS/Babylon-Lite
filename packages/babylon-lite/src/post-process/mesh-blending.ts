import { getEffectiveAspectRatio, getProjectionMatrix, getViewMatrix } from "../camera/camera.js";
import type { Camera, NormalizedViewport } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import { BU, SS, TU } from "../engine/gpu-flags.js";
import type { RenderTarget, RenderTargetDescriptor } from "../engine/render-target.js";
import { buildRenderTarget, createRenderTarget, disposeRenderTarget } from "../engine/render-target.js";
import { F32 } from "../engine/typed-arrays.js";
import type { PostProcessAlphaMode } from "../frame-graph/post-process-task.js";
import type { Task } from "../frame-graph/task.js";
import { _installGeometryMeshBlendTagResolver } from "../frame-graph/geometry-types.js";
import { packMat4IntoF32 } from "../math/pack-mat4-into-f32.js";
import type { Mat4 } from "../math/types.js";
import { resolveMeshBlendingTag } from "../mesh/mesh-blending-tag.js";
import type { SceneContext } from "../scene/scene-core.js";
import { createMeshBlendingBlueNoiseData } from "./mesh-blending-blue-noise.js";
import { _installMeshBlendingPbrSupport } from "./mesh-blending-pbr-support.js";
import { createMeshBlendingWGSL, getMeshBlendingQualitySettings } from "./mesh-blending-wgsl.js";

export enum MeshBlendQuality {
    Low = 0,
    Medium = 1,
    High = 2,
    Cinematic = 3,
}

export enum MeshBlendDepthType {
    View = 0,
    Screen = 1,
}

export enum MeshBlendDebugMode {
    Off = 0,
    PackedTag = 1,
    CandidateDirectionDistance = 2,
    SeamFade = 3,
    RejectionReason = 4,
    StageWork = 5,
    Continuation = 6,
    TinyObject = 7,
    MultiTarget = 8,
    TargetColor = 9,
    ShadowAttenuation = 10,
    ColorInterpolation = 11,
    WorldPosition = 12,
}

export interface MeshBlendRadiusDefinition {
    worldRadius: number;
    minimumProjectedRadius: number;
}

export type MeshBlendRadiusDefinitions = readonly [MeshBlendRadiusDefinition, MeshBlendRadiusDefinition, MeshBlendRadiusDefinition, MeshBlendRadiusDefinition];

export interface MeshBlendingPostProcessTaskConfig {
    name?: string;
    sourceTexture: RenderTarget;
    meshBlendTagTexture: RenderTarget;
    depthTexture: RenderTarget;
    baseColorTexture?: RenderTarget | null;
    targetTexture?: RenderTarget | null;
    camera: Camera;
    quality?: MeshBlendQuality;
    depthType?: MeshBlendDepthType;
    debugMode?: MeshBlendDebugMode;
    radiusClasses?: readonly MeshBlendRadiusDefinition[];
    slopeFactor?: number;
    enabled?: boolean;
    alphaMode?: PostProcessAlphaMode;
    viewport?: NormalizedViewport | null;
    clear?: boolean;
}

export interface MeshBlendingPostProcessTask extends Task {
    readonly name: string;
    sourceTexture: RenderTarget;
    meshBlendTagTexture: RenderTarget;
    depthTexture: RenderTarget;
    baseColorTexture: RenderTarget | null;
    targetTexture: RenderTarget | null;
    readonly outputTexture: RenderTarget;
    camera: Camera;
    quality: MeshBlendQuality;
    depthType: MeshBlendDepthType;
    debugMode: MeshBlendDebugMode;
    readonly radiusClasses: MeshBlendRadiusDefinitions;
    slopeFactor: number;
    enabled: boolean;
    alphaMode: PostProcessAlphaMode;
    viewport: NormalizedViewport | null;
    clear: boolean;
    updateUniforms(): void;
}

interface MeshBlendingPostProcessTaskInternal extends MeshBlendingPostProcessTask {
    outputTexture: RenderTarget;
    _internalTarget: RenderTarget | null;
    _internalTargetKey: string;
    _device: GPUDevice | null;
    _variantKey: string;
    _resourceKey: string;
    _uniformBuffer: GPUBuffer | null;
    _uniformData: Float32Array;
    _blueNoiseData: Uint8Array;
    _blueNoiseTexture: GPUTexture | null;
    _blueNoiseView: GPUTextureView | null;
    _shaderModule: GPUShaderModule | null;
    _bindGroupLayout: GPUBindGroupLayout | null;
    _pipelineLayout: GPUPipelineLayout | null;
    _pipeline: GPURenderPipeline | null;
    _bindGroup: GPUBindGroup | null;
    _renderPassDescriptor: GPURenderPassDescriptor;
    _colorAttachment: GPURenderPassColorAttachment;
    _boundSource: GPUTexture | null;
    _boundTag: GPUTexture | null;
    _boundDepth: GPUTexture | null;
    _boundBaseColor: GPUTexture | null;
}

/** Create one independently mutable, validating radius definition. */
export function createMeshBlendRadiusDefinition(worldRadius: number, minimumProjectedRadius: number): MeshBlendRadiusDefinition {
    let world = validateRadius(worldRadius, "world radius");
    let minimum = validateRadius(minimumProjectedRadius, "minimum projected radius");
    const definition = {} as MeshBlendRadiusDefinition;
    Object.defineProperties(definition, {
        worldRadius: {
            enumerable: true,
            get(): number {
                return world;
            },
            set(value: number) {
                world = validateRadius(value, "world radius");
            },
        },
        minimumProjectedRadius: {
            enumerable: true,
            get(): number {
                return minimum;
            },
            set(value: number) {
                minimum = validateRadius(value, "minimum projected radius");
            },
        },
    });
    return definition;
}

/** Create Babylon-compatible defaults for all four packed radius classes. */
export function createDefaultMeshBlendRadiusDefinitions(): MeshBlendRadiusDefinitions {
    return Object.freeze([
        createMeshBlendRadiusDefinition(0.06, 1.5),
        createMeshBlendRadiusDefinition(0.1, 3),
        createMeshBlendRadiusDefinition(0.2, 3),
        createMeshBlendRadiusDefinition(0.3, 5),
    ]) as MeshBlendRadiusDefinitions;
}

/** Create the task-owned fullscreen mesh-blending pass. */
export function createMeshBlendingPostProcessTask(config: MeshBlendingPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): MeshBlendingPostProcessTask {
    _installGeometryMeshBlendTagResolver(resolveMeshBlendingTag);
    _installMeshBlendingPbrSupport();
    const name = config.name ?? "mesh-blending";
    const initialQuality = validateQuality(config.quality ?? MeshBlendQuality.Medium);
    const initialDepthType = validateDepthType(config.depthType ?? MeshBlendDepthType.View);
    const initialDebugMode = validateDebugMode(config.debugMode ?? MeshBlendDebugMode.Off);
    const initialSlopeFactor = validateSlopeFactor(config.slopeFactor ?? 2);
    const initialAlphaMode = validateAlphaMode(config.alphaMode ?? 0);
    const radiusClasses = cloneRadiusDefinitions(config.radiusClasses);
    const state = {
        quality: initialQuality,
        depthType: initialDepthType,
        debugMode: initialDebugMode,
        slopeFactor: initialSlopeFactor,
        alphaMode: initialAlphaMode,
    };
    const source = config.sourceTexture;
    const internalTarget = config.targetTexture ? null : createInternalTarget(name, source);
    const colorAttachment: GPURenderPassColorAttachment = {
        view: undefined!,
        loadOp: config.clear === false ? "load" : "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
    };
    const task: MeshBlendingPostProcessTaskInternal = {
        name,
        engine,
        scene,
        _passes: [],
        sourceTexture: source,
        meshBlendTagTexture: config.meshBlendTagTexture,
        depthTexture: config.depthTexture,
        baseColorTexture: config.baseColorTexture ?? null,
        targetTexture: config.targetTexture ?? null,
        outputTexture: config.targetTexture ?? internalTarget!,
        camera: config.camera,
        get quality(): MeshBlendQuality {
            return state.quality;
        },
        set quality(value: MeshBlendQuality) {
            state.quality = validateQuality(value);
        },
        get depthType(): MeshBlendDepthType {
            return state.depthType;
        },
        set depthType(value: MeshBlendDepthType) {
            state.depthType = validateDepthType(value);
        },
        get debugMode(): MeshBlendDebugMode {
            return state.debugMode;
        },
        set debugMode(value: MeshBlendDebugMode) {
            state.debugMode = validateDebugMode(value);
        },
        radiusClasses,
        get slopeFactor(): number {
            return state.slopeFactor;
        },
        set slopeFactor(value: number) {
            state.slopeFactor = validateSlopeFactor(value);
        },
        enabled: config.enabled ?? true,
        get alphaMode(): PostProcessAlphaMode {
            return state.alphaMode;
        },
        set alphaMode(value: PostProcessAlphaMode) {
            state.alphaMode = validateAlphaMode(value);
        },
        viewport: config.viewport ?? null,
        clear: config.clear ?? true,
        _internalTarget: internalTarget,
        _internalTargetKey: internalTarget ? internalTargetKey(source) : "",
        _device: null,
        _variantKey: "",
        _resourceKey: "",
        _uniformBuffer: null,
        _uniformData: new F32(60),
        _blueNoiseData: createMeshBlendingBlueNoiseData(),
        _blueNoiseTexture: null,
        _blueNoiseView: null,
        _shaderModule: null,
        _bindGroupLayout: null,
        _pipelineLayout: null,
        _pipeline: null,
        _bindGroup: null,
        _renderPassDescriptor: { label: name, colorAttachments: [colorAttachment] },
        _colorAttachment: colorAttachment,
        _boundSource: null,
        _boundTag: null,
        _boundDepth: null,
        _boundBaseColor: null,
        record(): void {
            prepareTask(task, true);
        },
        execute(): number {
            prepareTask(task, false);
            task.updateUniforms();
            task._colorAttachment.view = task.outputTexture._colorView!;
            task._colorAttachment.loadOp = task.clear ? "clear" : "load";
            task._colorAttachment.resolveTarget = undefined;
            const pass = engine._currentEncoder.beginRenderPass(task._renderPassDescriptor);
            applyViewport(pass, task.viewport, task.outputTexture);
            pass.setPipeline(task._pipeline!);
            pass.setBindGroup(0, task._bindGroup!);
            pass.draw(3);
            pass.end();
            return 1;
        },
        updateUniforms(): void {
            writeUniforms(task);
        },
        dispose(): void {
            task._passes.length = 0;
            destroyDeviceResources(task);
            disposeRenderTarget(task._internalTarget);
            task._internalTarget = null;
        },
    };
    return task;
}

function validateRadius(value: number, name: string): number {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`Mesh-blending ${name} must be a finite non-negative number.`);
    }
    return value;
}

function validateQuality(value: MeshBlendQuality): MeshBlendQuality {
    getMeshBlendingQualitySettings(value);
    return value;
}

function validateDepthType(value: MeshBlendDepthType): MeshBlendDepthType {
    if (value !== MeshBlendDepthType.View && value !== MeshBlendDepthType.Screen) {
        throw new RangeError("Mesh-blending depthType must be View or Screen.");
    }
    return value;
}

function validateDebugMode(value: MeshBlendDebugMode): MeshBlendDebugMode {
    if (!Number.isInteger(value) || value < MeshBlendDebugMode.Off || value > MeshBlendDebugMode.WorldPosition) {
        throw new RangeError("Mesh-blending debugMode is not a defined MeshBlendDebugMode value.");
    }
    return value;
}

function validateSlopeFactor(value: number): number {
    if (!Number.isFinite(value) || value < 1) {
        throw new RangeError("Mesh-blending slopeFactor must be a finite number greater than or equal to 1.");
    }
    return value;
}

function validateAlphaMode(value: PostProcessAlphaMode): PostProcessAlphaMode {
    if (value !== 0 && value !== 1 && value !== 2 && value !== 7) {
        throw new RangeError("Mesh-blending alphaMode must be 0, 1, 2, or 7.");
    }
    return value;
}

function cloneRadiusDefinitions(source?: readonly MeshBlendRadiusDefinition[]): MeshBlendRadiusDefinitions {
    if (!source) {
        return createDefaultMeshBlendRadiusDefinitions();
    }
    if (source.length !== 4) {
        throw new RangeError("Mesh-blending radiusClasses must contain exactly four radius definitions.");
    }
    return Object.freeze([
        createMeshBlendRadiusDefinition(source[0]!.worldRadius, source[0]!.minimumProjectedRadius),
        createMeshBlendRadiusDefinition(source[1]!.worldRadius, source[1]!.minimumProjectedRadius),
        createMeshBlendRadiusDefinition(source[2]!.worldRadius, source[2]!.minimumProjectedRadius),
        createMeshBlendRadiusDefinition(source[3]!.worldRadius, source[3]!.minimumProjectedRadius),
    ]) as MeshBlendRadiusDefinitions;
}

function prepareTask(task: MeshBlendingPostProcessTaskInternal, recording: boolean): void {
    const deviceChanged = task._device !== task.engine._device;
    if (deviceChanged) {
        destroyDeviceResources(task);
        if (task._internalTarget) {
            disposeRenderTarget(task._internalTarget);
            task._internalTarget = null;
            task._internalTargetKey = "";
        }
        task._device = task.engine._device;
    }
    prepareOutputTarget(task);
    if (recording || !task.outputTexture._colorView || (deviceChanged && task.outputTexture === task._internalTarget)) {
        buildRenderTarget(task.outputTexture, task.engine);
    }
    validateTargets(task);
    ensureGpuState(task);
}

function prepareOutputTarget(task: MeshBlendingPostProcessTaskInternal): void {
    if (task.targetTexture) {
        if (task._internalTarget) {
            disposeRenderTarget(task._internalTarget);
            task._internalTarget = null;
            task._internalTargetKey = "";
        }
        task.outputTexture = task.targetTexture;
        return;
    }
    const key = internalTargetKey(task.sourceTexture);
    if (!task._internalTarget || task._internalTargetKey !== key) {
        disposeRenderTarget(task._internalTarget);
        task._internalTarget = createInternalTarget(task.name, task.sourceTexture);
        task._internalTargetKey = key;
    }
    task.outputTexture = task._internalTarget;
}

function createInternalTarget(name: string, source: RenderTarget): RenderTarget {
    const descriptor = source._descriptor;
    if (!descriptor.format) {
        throw new Error(`MeshBlendingPostProcessTask "${name}": sourceTexture must have a color format.`);
    }
    const targetDescriptor: RenderTargetDescriptor = {
        lbl: `${name}-output`,
        format: descriptor.format,
        samples: 1,
        size: descriptor.size,
    };
    return createRenderTarget(targetDescriptor);
}

function internalTargetKey(source: RenderTarget): string {
    const descriptor = source._descriptor;
    const size = descriptor.size;
    const sizeKey = "canvas" in size ? `surface:${size._uniqueId}` : `${size.width}x${size.height}`;
    return `${descriptor.format ?? "-"}|${sizeKey}`;
}

function validateTargets(task: MeshBlendingPostProcessTaskInternal): void {
    validateInputColor(task.name, "sourceTexture", task.sourceTexture, isSceneColorFormat);
    validateInputColor(task.name, "meshBlendTagTexture", task.meshBlendTagTexture, isMeshBlendTagFormat);
    validateDepthInput(task);
    if (task.baseColorTexture) {
        validateInputColor(task.name, "baseColorTexture", task.baseColorTexture, isSceneColorFormat);
    }
    validateInputColor(task.name, "outputTexture", task.outputTexture, isSceneColorFormat);
    if (task.sourceTexture === task.outputTexture || task.sourceTexture._colorTexture === task.outputTexture._colorTexture) {
        throw new Error(`MeshBlendingPostProcessTask "${task.name}": sourceTexture and outputTexture must not alias.`);
    }
    const width = task.outputTexture._width;
    const height = task.outputTexture._height;
    validateDimensions(task.name, "sourceTexture", task.sourceTexture, width, height);
    validateDimensions(task.name, "meshBlendTagTexture", task.meshBlendTagTexture, width, height);
    validateDimensions(task.name, "depthTexture", task.depthTexture, width, height);
    if (task.baseColorTexture) {
        validateDimensions(task.name, "baseColorTexture", task.baseColorTexture, width, height);
    }
}

function validateInputColor(name: string, label: string, target: RenderTarget, accepts: (format: GPUTextureFormat) => boolean): void {
    if ((target._descriptor.samples ?? 1) !== 1) {
        throw new Error(`MeshBlendingPostProcessTask "${name}": ${label} must be single-sample.`);
    }
    const format = target._descriptor.format;
    if (!format || !accepts(format)) {
        throw new Error(`MeshBlendingPostProcessTask "${name}": ${label} has unsupported format "${format ?? "none"}".`);
    }
    if (!target._colorTexture || !target._colorView || target._width < 1 || target._height < 1) {
        throw new Error(`MeshBlendingPostProcessTask "${name}": ${label} must be a built 2D color render target.`);
    }
}

function validateDepthInput(task: MeshBlendingPostProcessTaskInternal): void {
    const target = task.depthTexture;
    validateInputColor(task.name, "depthTexture", target, task.depthType === MeshBlendDepthType.View ? isViewDepthFormat : isScreenDepthFormat);
}

function validateDimensions(name: string, label: string, target: RenderTarget, width: number, height: number): void {
    if (target._width !== width || target._height !== height) {
        throw new Error(`MeshBlendingPostProcessTask "${name}": ${label} must have the same physical dimensions as outputTexture.`);
    }
}

function isMeshBlendTagFormat(format: GPUTextureFormat): boolean {
    return format === "r8uint";
}

function isSceneColorFormat(format: GPUTextureFormat): boolean {
    switch (format) {
        case "rgba8unorm":
        case "rgba8unorm-srgb":
        case "bgra8unorm":
        case "bgra8unorm-srgb":
        case "rgba16float":
        case "rgba32float":
        case "rgb10a2unorm":
        case "rg11b10ufloat":
            return true;
        default:
            return false;
    }
}

function isViewDepthFormat(format: GPUTextureFormat): boolean {
    switch (format) {
        case "r16float":
        case "r32float":
        case "rg16float":
        case "rg32float":
        case "rgba16float":
        case "rgba32float":
            return true;
        default:
            return false;
    }
}

function isScreenDepthFormat(format: GPUTextureFormat): boolean {
    return isViewDepthFormat(format) || format === "r8unorm" || format === "rg8unorm" || format === "rgba8unorm" || format === "bgra8unorm";
}

function ensureGpuState(task: MeshBlendingPostProcessTaskInternal): void {
    ensureBlueNoise(task);
    task._uniformBuffer ??= task.engine._device.createBuffer({
        label: `${task.name}-uniforms`,
        size: 240,
        usage: BU.UNIFORM | BU.COPY_DST,
    });
    const variantKey = `${task.quality}|${task.depthType}|${task.debugMode}|${task.baseColorTexture ? 1 : 0}|${task.outputTexture._descriptor.format}|${
        task.sourceTexture._descriptor.format
    }|${task.depthTexture._descriptor.format}|${task.baseColorTexture?._descriptor.format ?? "-"}|${task.alphaMode}`;
    if (variantKey !== task._variantKey) {
        task._variantKey = variantKey;
        task._bindGroup = null;
        task._bindGroupLayout = null;
        task._pipelineLayout = null;
        const code = createMeshBlendingWGSL({
            quality: task.quality,
            depthType: task.depthType,
            debugMode: task.debugMode,
            hasBaseColor: !!task.baseColorTexture,
        });
        task._shaderModule = task.engine._device.createShaderModule({ label: task.name, code });
        task._bindGroupLayout = createBindGroupLayout(task);
        task._pipelineLayout = task.engine._device.createPipelineLayout({
            label: `${task.name}-pipeline-layout`,
            bindGroupLayouts: [task._bindGroupLayout],
        });
        task._pipeline = task.engine._device.createRenderPipeline({
            label: `${task.name}-pipeline`,
            layout: task._pipelineLayout,
            vertex: { module: task._shaderModule, entryPoint: "meshBlendVertex" },
            fragment: {
                module: task._shaderModule,
                entryPoint: "meshBlendFragment",
                targets: [{ format: task.outputTexture._descriptor.format!, blend: alphaModeToBlend(task.alphaMode) }],
            },
            primitive: { topology: "triangle-list" },
        });
    }
    const resourceChanged =
        task._boundSource !== task.sourceTexture._colorTexture ||
        task._boundTag !== task.meshBlendTagTexture._colorTexture ||
        task._boundDepth !== task.depthTexture._colorTexture ||
        task._boundBaseColor !== (task.baseColorTexture?._colorTexture ?? null);
    if (!task._bindGroup || resourceChanged) {
        task._resourceKey = `${task.sourceTexture._width}x${task.sourceTexture._height}|${task.baseColorTexture ? 1 : 0}`;
        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: task.sourceTexture._colorView! },
            { binding: 1, resource: task.meshBlendTagTexture._colorView! },
            { binding: 2, resource: task.depthTexture._colorView! },
        ];
        let binding = 3;
        if (task.baseColorTexture) {
            entries.push({ binding: binding++, resource: task.baseColorTexture._colorView! });
        }
        entries.push({ binding: binding++, resource: task._blueNoiseView! });
        entries.push({ binding, resource: { buffer: task._uniformBuffer } });
        task._bindGroup = task.engine._device.createBindGroup({
            label: `${task.name}-bind-group`,
            layout: task._bindGroupLayout!,
            entries,
        });
        task._boundSource = task.sourceTexture._colorTexture;
        task._boundTag = task.meshBlendTagTexture._colorTexture;
        task._boundDepth = task.depthTexture._colorTexture;
        task._boundBaseColor = task.baseColorTexture?._colorTexture ?? null;
    }
}

function createBindGroupLayout(task: MeshBlendingPostProcessTaskInternal): GPUBindGroupLayout {
    const entries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: sampleType(task.sourceTexture._descriptor.format!) } },
        { binding: 1, visibility: SS.FRAGMENT, texture: { sampleType: "uint" } },
        { binding: 2, visibility: SS.FRAGMENT, texture: { sampleType: sampleType(task.depthTexture._descriptor.format!) } },
    ];
    let binding = 3;
    if (task.baseColorTexture) {
        entries.push({ binding: binding++, visibility: SS.FRAGMENT, texture: { sampleType: sampleType(task.baseColorTexture._descriptor.format!) } });
    }
    entries.push({ binding: binding++, visibility: SS.FRAGMENT, texture: { sampleType: "float" } });
    entries.push({ binding, visibility: SS.FRAGMENT, buffer: { type: "uniform" } });
    return task.engine._device.createBindGroupLayout({ label: `${task.name}-bind-group-layout`, entries });
}

function sampleType(format: GPUTextureFormat): GPUTextureSampleType {
    return format === "r32float" || format === "rg32float" || format === "rgba32float" ? "unfilterable-float" : "float";
}

function ensureBlueNoise(task: MeshBlendingPostProcessTaskInternal): void {
    if (task._blueNoiseTexture) {
        return;
    }
    task._blueNoiseTexture = task.engine._device.createTexture({
        label: `${task.name}-blue-noise`,
        size: [128, 128, 1],
        format: "rg8unorm",
        usage: TU.TEXTURE_BINDING | TU.COPY_DST,
        mipLevelCount: 1,
        sampleCount: 1,
    });
    task.engine._device.queue.writeTexture(
        { texture: task._blueNoiseTexture },
        task._blueNoiseData as Uint8Array<ArrayBuffer>,
        { bytesPerRow: 256, rowsPerImage: 128 },
        { width: 128, height: 128, depthOrArrayLayers: 1 }
    );
    task._blueNoiseView = task._blueNoiseTexture.createView();
}

function writeUniforms(task: MeshBlendingPostProcessTaskInternal): void {
    const data = task._uniformData;
    const width = task.outputTexture._width;
    const height = task.outputTexture._height;
    const projection = getProjectionMatrix(task.camera, getEffectiveAspectRatio(task.camera, width, height));
    data.fill(0);
    packMat4IntoF32(data, projection, 0);
    if (!invertMat4IntoF32(data, 16, projection) || !invertMat4IntoF32(data, 32, getViewMatrix(task.camera))) {
        throw new Error(`MeshBlendingPostProcessTask "${task.name}": camera projection and view matrices must be invertible.`);
    }
    for (let index = 0; index < 4; index++) {
        const definition = task.radiusClasses[index]!;
        data[48 + index] = validateRadius(definition.worldRadius, "world radius");
        data[52 + index] = validateRadius(definition.minimumProjectedRadius, "minimum projected radius");
    }

    data[56] = task.camera.ortho ? 1 : 0;
    data[57] = validateSlopeFactor(task.slopeFactor);
    data[58] = task.enabled ? 1 : 0;
    if (task._uniformBuffer) {
        task.engine._device.queue.writeBuffer(task._uniformBuffer, 0, data as Float32Array<ArrayBuffer>);
    }

    function invertMat4IntoF32(out: Float32Array, offset: number, input: Mat4): boolean {
        const a00 = input[0]!,
            a01 = input[1]!,
            a02 = input[2]!,
            a03 = input[3]!;
        const a10 = input[4]!,
            a11 = input[5]!,
            a12 = input[6]!,
            a13 = input[7]!;
        const a20 = input[8]!,
            a21 = input[9]!,
            a22 = input[10]!,
            a23 = input[11]!;
        const a30 = input[12]!,
            a31 = input[13]!,
            a32 = input[14]!,
            a33 = input[15]!;
        const b00 = a00 * a11 - a01 * a10;
        const b01 = a00 * a12 - a02 * a10;
        const b02 = a00 * a13 - a03 * a10;
        const b03 = a01 * a12 - a02 * a11;
        const b04 = a01 * a13 - a03 * a11;
        const b05 = a02 * a13 - a03 * a12;
        const b06 = a20 * a31 - a21 * a30;
        const b07 = a20 * a32 - a22 * a30;
        const b08 = a20 * a33 - a23 * a30;
        const b09 = a21 * a32 - a22 * a31;
        const b10 = a21 * a33 - a23 * a31;
        const b11 = a22 * a33 - a23 * a32;
        let determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        if (Math.abs(determinant) < 1e-10) {
            return false;
        }
        determinant = 1 / determinant;
        out[offset] = (a11 * b11 - a12 * b10 + a13 * b09) * determinant;
        out[offset + 1] = (a02 * b10 - a01 * b11 - a03 * b09) * determinant;
        out[offset + 2] = (a31 * b05 - a32 * b04 + a33 * b03) * determinant;
        out[offset + 3] = (a22 * b04 - a21 * b05 - a23 * b03) * determinant;
        out[offset + 4] = (a12 * b08 - a10 * b11 - a13 * b07) * determinant;
        out[offset + 5] = (a00 * b11 - a02 * b08 + a03 * b07) * determinant;
        out[offset + 6] = (a32 * b02 - a30 * b05 - a33 * b01) * determinant;
        out[offset + 7] = (a20 * b05 - a22 * b02 + a23 * b01) * determinant;
        out[offset + 8] = (a10 * b10 - a11 * b08 + a13 * b06) * determinant;
        out[offset + 9] = (a01 * b08 - a00 * b10 - a03 * b06) * determinant;
        out[offset + 10] = (a30 * b04 - a31 * b02 + a33 * b00) * determinant;
        out[offset + 11] = (a21 * b02 - a20 * b04 - a23 * b00) * determinant;
        out[offset + 12] = (a11 * b07 - a10 * b09 - a12 * b06) * determinant;
        out[offset + 13] = (a00 * b09 - a01 * b07 + a02 * b06) * determinant;
        out[offset + 14] = (a31 * b01 - a30 * b03 - a32 * b00) * determinant;
        out[offset + 15] = (a20 * b03 - a21 * b01 + a22 * b00) * determinant;
        return true;
    }
}

function destroyDeviceResources(task: MeshBlendingPostProcessTaskInternal): void {
    task._uniformBuffer?.destroy();
    task._blueNoiseTexture?.destroy();
    task._uniformBuffer = null;
    task._blueNoiseTexture = null;
    task._blueNoiseView = null;
    task._shaderModule = null;
    task._bindGroupLayout = null;
    task._pipelineLayout = null;
    task._pipeline = null;
    task._bindGroup = null;
    task._variantKey = "";
    task._resourceKey = "";
    task._boundSource = null;
    task._boundTag = null;
    task._boundDepth = null;
    task._boundBaseColor = null;
}

function applyViewport(pass: GPURenderPassEncoder, viewport: NormalizedViewport | null, target: RenderTarget): void {
    if (!viewport) {
        return;
    }
    const x = Math.floor(viewport.x * target._width);
    const y = Math.floor((1 - viewport.y - viewport.height) * target._height);
    const width = Math.ceil((viewport.x + viewport.width) * target._width) - x;
    const height = Math.ceil((1 - viewport.y) * target._height) - y;
    pass.setViewport(x, y, width, height, 0, 1);
    pass.setScissorRect(x, y, width, height);
}

function alphaModeToBlend(mode: PostProcessAlphaMode): GPUBlendState | undefined {
    switch (validateAlphaMode(mode)) {
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
