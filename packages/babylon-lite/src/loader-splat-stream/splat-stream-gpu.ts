import { BU, SS, TU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import type { DrawUpdateBatch } from "../render/renderable.js";
import { enableDrawBatchCollection } from "../render/draw-update-batches.js";
import type { SogV2SourceMetadata } from "./splat-stream-types.js";
import { createSplatStreamGpuLedger, type SplatStreamGpuLedger } from "./splat-stream-gpu-ledger.js";
import GATHER_WGSL from "./splat-stream-gather.wgsl?raw";
import PROJECT_WGSL from "./splat-stream-project.wgsl?raw";
import RADIX_WGSL from "./splat-stream-radix.wgsl?raw";

const RECORD_BYTES = 64;
const KEY_BYTES = 8;
const INDIRECT_BYTES = 16;
let _drawBatches: WeakMap<SplatStreamGpuState, WeakMap<RenderTargetSignature, SplatStreamDrawBatch>> | null = null;
const PARAM_SLOT_BYTES = 256;
const WORKGROUP_SIZE = 256;
const RADIX_PASSES = 8;

/** @internal Five byte-exact SOG textures and their two scalar codebooks. */
export interface SplatStreamSourceGpu {
    readonly textures: readonly [GPUTexture, GPUTexture, GPUTexture, GPUTexture, GPUTexture];
    readonly views: readonly [GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView];
    readonly codebooks: GPUBuffer;
    readonly width: number;
    readonly height: number;
    readonly count: number;
    readonly meansMin: Float32Array;
    readonly meansMax: Float32Array;
    /** @internal */
    _destroyed: boolean;
}

/** @internal One source interval copied into the canonical active generation. */
export interface SplatStreamGpuInterval {
    readonly source: SplatStreamSourceGpu;
    readonly sourceOffset: number;
    readonly count: number;
    readonly destinationOffset: number;
}

interface SharedPipelines {
    readonly gather: GPUComputePipeline;
    readonly project: GPUComputePipeline;
    readonly histogram: GPUComputePipeline;
    readonly scan: GPUComputePipeline;
    readonly add: GPUComputePipeline;
    readonly bases: GPUComputePipeline;
    readonly scatter: GPUComputePipeline;
    readonly gatherLayout: GPUBindGroupLayout;
    readonly projectLayout: GPUBindGroupLayout;
    readonly radixLayout: GPUBindGroupLayout;
}

/** @internal Stream-owned canonical records shared by all pass-local bindings. */
export interface SplatStreamGpuState {
    readonly engine: EngineContext;
    readonly capacity: number;
    readonly canonical: GPUBuffer;
    readonly gatherParams: GPUBuffer;
    readonly pipelines: SharedPipelines;
    readonly ledger: SplatStreamGpuLedger;
    readonly gpuBytes: number;
    passHoldBytes: number;
    intervals: readonly SplatStreamGpuInterval[];
    count: number;
    contentGeneration: number;
    gatheredGeneration: number;
    disposed: boolean;
}

interface ScanLevel {
    readonly count: number;
    readonly blocks: number;
    readonly values: GPUBuffer;
    readonly scanned: GPUBuffer;
    readonly sums: GPUBuffer;
}

/** @internal Projection and sorting resources private to one camera/target binding. */
export interface SplatStreamPassGpu {
    readonly projected: GPUBuffer;
    readonly keys: readonly [GPUBuffer, GPUBuffer];
    readonly indirect: GPUBuffer;
    readonly indirectTemplate: GPUBuffer;
    readonly projectParams: GPUBuffer;
    readonly radixParams: GPUBuffer;
    readonly digitBases: GPUBuffer;
    readonly levels: readonly ScanLevel[];
    readonly gpuBytes: number;
    bootstrapReadback: GPUBuffer | null;
    bootstrapSignal: Promise<boolean> | null;
    bootstrapClaimed: boolean;
    sorted: GPUBuffer;
    bindGroup: GPUBindGroup | null;
    lastKey: string;
    destroyed: boolean;
}

interface PendingProjection {
    readonly count: number;
    readonly key: string;
    readonly worldView: Float32Array;
    readonly projection: Float32Array;
    readonly width: number;
    readonly height: number;
    readonly near: number;
}

/** @internal Feature-owned batch; records into, but never submits, the active encoder. */
export interface SplatStreamDrawBatch extends DrawUpdateBatch {
    readonly passGpu: SplatStreamPassGpu;
    queue(projection: PendingProjection): void;
    takeBootstrapSignal(): Promise<boolean> | null;
}

let _pipelineCache: { device: GPUDevice; value: SharedPipelines } | null = null;

function createPipelines(device: GPUDevice): SharedPipelines {
    if (_pipelineCache?.device === device) {
        return _pipelineCache.value;
    }
    const dynamicUniform = { type: "uniform" as const, hasDynamicOffset: true, minBindingSize: 48 };
    const gatherLayout = device.createBindGroupLayout({
        entries: [
            ...Array.from({ length: 5 }, (_, binding) => ({ binding, visibility: SS.COMPUTE, texture: { sampleType: "float" as const } })),
            { binding: 5, visibility: SS.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 6, visibility: SS.COMPUTE, buffer: { type: "storage" } },
            { binding: 7, visibility: SS.COMPUTE, buffer: dynamicUniform },
        ],
    });
    const projectLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: SS.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 1, visibility: SS.COMPUTE, buffer: { type: "storage" } },
            { binding: 2, visibility: SS.COMPUTE, buffer: { type: "storage" } },
            { binding: 3, visibility: SS.COMPUTE, buffer: { type: "storage" } },
            { binding: 4, visibility: SS.COMPUTE, buffer: { ...dynamicUniform, minBindingSize: 192 } },
        ],
    });
    const radixLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: SS.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 1, visibility: SS.COMPUTE, buffer: { type: "storage" } },
            { binding: 2, visibility: SS.COMPUTE, buffer: { type: "storage" } },
            { binding: 3, visibility: SS.COMPUTE, buffer: { type: "storage" } },
            { binding: 4, visibility: SS.COMPUTE, buffer: { type: "storage" } },
            { binding: 5, visibility: SS.COMPUTE, buffer: { type: "storage" } },
            { binding: 6, visibility: SS.COMPUTE, buffer: { ...dynamicUniform, minBindingSize: 32 } },
        ],
    });
    const gatherModule = device.createShaderModule({ label: "splat stream gather", code: GATHER_WGSL });
    const projectModule = device.createShaderModule({ label: "splat stream projection", code: PROJECT_WGSL });
    const radixModule = device.createShaderModule({ label: "splat stream radix", code: RADIX_WGSL });
    const compute = (module: GPUShaderModule, layout: GPUBindGroupLayout, entryPoint: string): GPUComputePipeline =>
        device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint } });
    const value = {
        gather: compute(gatherModule, gatherLayout, "main"),
        project: compute(projectModule, projectLayout, "main"),
        histogram: compute(radixModule, radixLayout, "histogramMain"),
        scan: compute(radixModule, radixLayout, "scanMain"),
        add: compute(radixModule, radixLayout, "addMain"),
        bases: compute(radixModule, radixLayout, "basesMain"),
        scatter: compute(radixModule, radixLayout, "scatterMain"),
        gatherLayout,
        projectLayout,
        radixLayout,
    };
    _pipelineCache = { device, value };
    return value;
}

function checkedBufferSize(device: GPUDevice, size: number, label: string): number {
    if (!Number.isSafeInteger(size) || size <= 0 || size > device.limits.maxBufferSize || size > device.limits.maxStorageBufferBindingSize) {
        throw new Error(`[GaussianSplatStream] GPU ${label} buffer size ${size} exceeds device limits`);
    }
    return size;
}

/** @internal Admits a bounded canonical capacity before allocating any working buffers. */
export function getSplatStreamGpuCapacity(device: GPUDevice, requested: number, maxGpuBytes: number): number {
    if (!Number.isSafeInteger(requested) || requested <= 0 || !Number.isSafeInteger(maxGpuBytes) || maxGpuBytes <= 0) {
        throw new RangeError("[GaussianSplatStream] GPU capacity inputs must be positive safe integers");
    }
    const dispatchCapacity = device.limits.maxComputeWorkgroupsPerDimension * WORKGROUP_SIZE;
    const storageCapacity = Math.floor(Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize) / RECORD_BYTES);
    const workingBudget = Math.floor(maxGpuBytes * 0.75);
    const fits = (capacity: number): boolean => streamStateBytes(capacity) + passStateBytes(capacity) <= workingBudget;
    let low = 0;
    let high = Math.min(requested, dispatchCapacity, storageCapacity);
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(middle)) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    const capacity = low;
    if (capacity < 1) {
        throw new Error("[GaussianSplatStream] GPU budget/device limits cannot admit one canonical splat");
    }
    return capacity;
}

/** @internal Allocates the stream-owned canonical generation. */
function bufferBytes(size: number): number {
    return Math.max(size, 64);
}

function scanLevelSizes(groups: number): Array<{ count: number; blocks: number }> {
    const levels: Array<{ count: number; blocks: number }> = [];
    for (let count = groups; count > 0; count = Math.ceil(count / WORKGROUP_SIZE)) {
        const blocks = Math.ceil(count / WORKGROUP_SIZE);
        levels.push({ count, blocks });
        if (blocks === 1) {
            break;
        }
    }
    return levels;
}

function streamStateBytes(capacity: number): number {
    return capacity * RECORD_BYTES + PARAM_SLOT_BYTES * Math.min(capacity, 4096);
}

function passStateBytes(capacity: number): number {
    const fixed = capacity * RECORD_BYTES + capacity * KEY_BYTES * 2 + INDIRECT_BYTES * 2 + PARAM_SLOT_BYTES + PARAM_SLOT_BYTES * 256 + 64;
    return (
        fixed + scanLevelSizes(Math.ceil(capacity / WORKGROUP_SIZE)).reduce((total, level) => total + bufferBytes(16 * level.count * 4) * 2 + bufferBytes(16 * level.blocks * 4), 0)
    );
}

export function createSplatStreamGpuState(engine: EngineContext, requestedCapacity: number, maxGpuBytes: number, sharedLedger?: SplatStreamGpuLedger): SplatStreamGpuState {
    const device = engine._device;
    const capacity = getSplatStreamGpuCapacity(device, requestedCapacity, maxGpuBytes);
    const ledger = sharedLedger ?? createSplatStreamGpuLedger(maxGpuBytes, (dispose) => retireGpuResources(engine, dispose));
    const gpuBytes = streamStateBytes(capacity);
    const initialPassBytes = passStateBytes(capacity);
    const stateReserved = ledger.tryReserve(gpuBytes);
    if (!stateReserved || !ledger.tryHold(initialPassBytes)) {
        if (stateReserved) {
            ledger.release(gpuBytes);
        }
        throw new Error("[GaussianSplatStream] GPU budget cannot admit canonical stream state");
    }
    let canonical: GPUBuffer | null = null;
    let gatherParams: GPUBuffer | null = null;
    try {
        canonical = device.createBuffer({
            label: "splat stream canonical",
            size: checkedBufferSize(device, capacity * RECORD_BYTES, "canonical"),
            usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST,
        });
        gatherParams = device.createBuffer({
            label: "splat stream gather parameters",
            size: PARAM_SLOT_BYTES * Math.min(capacity, 4096),
            usage: BU.UNIFORM | BU.COPY_DST,
        });
        return {
            engine,
            capacity,
            canonical,
            gatherParams,
            pipelines: createPipelines(device),
            ledger,
            gpuBytes,
            passHoldBytes: initialPassBytes,
            intervals: [],
            count: 0,
            contentGeneration: 0,
            gatheredGeneration: -1,
            disposed: false,
        };
    } catch (reason) {
        canonical?.destroy();
        gatherParams?.destroy();
        ledger.releaseHold(initialPassBytes);
        ledger.release(gpuBytes);
        throw reason;
    }
}

function createSourceTextures(
    device: GPUDevice,
    width: number,
    height: number
): {
    textures: [GPUTexture, GPUTexture, GPUTexture, GPUTexture, GPUTexture];
    views: [GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView];
} {
    const textures = Array.from({ length: 5 }, (_, index) =>
        device.createTexture({
            label: `splat stream SOG source ${index}`,
            size: [width, height],
            format: "rgba8unorm",
            usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT,
        })
    ) as [GPUTexture, GPUTexture, GPUTexture, GPUTexture, GPUTexture];
    return { textures, views: textures.map((texture) => texture.createView()) as [GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView] };
}

function finishSource(
    device: GPUDevice,
    metadata: SogV2SourceMetadata,
    width: number,
    height: number,
    textures: [GPUTexture, GPUTexture, GPUTexture, GPUTexture, GPUTexture]
): SplatStreamSourceGpu {
    const codebookData = new Float32Array(512);
    codebookData.set(metadata.scaleCodebook);
    codebookData.set(metadata.sh0Codebook, 256);
    const codebooks = device.createBuffer({ label: "splat stream SOG codebooks", size: codebookData.byteLength, usage: BU.STORAGE | BU.COPY_DST });
    device.queue.writeBuffer(codebooks, 0, codebookData);
    return {
        textures,
        views: textures.map((texture) => texture.createView()) as [GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView],
        codebooks,
        width,
        height,
        count: metadata.count,
        meansMin: metadata.meansMin,
        meansMax: metadata.meansMax,
        _destroyed: false,
    };
}

/** @internal Uploads five decoded WebP images without Y flip, color conversion, or premultiplication. */
export function uploadSplatStreamSourceImages(
    device: GPUDevice,
    metadata: SogV2SourceMetadata,
    width: number,
    height: number,
    images: readonly GPUCopyExternalImageSource[]
): SplatStreamSourceGpu {
    if (images.length !== 5) {
        throw new Error("[GaussianSplatStream] GPU upload requires exactly five source images");
    }
    const { textures } = createSourceTextures(device, width, height);
    try {
        for (let index = 0; index < 5; index++) {
            device.queue.copyExternalImageToTexture({ source: images[index]! }, { texture: textures[index]! }, { width, height });
        }
        return finishSource(device, metadata, width, height, textures);
    } catch (error) {
        textures.forEach((texture) => texture.destroy());
        throw error;
    }
}

/** @internal Byte-array upload path used by focused GPU tests and non-DOM decoders. */
export function uploadSplatStreamSourceBytes(device: GPUDevice, metadata: SogV2SourceMetadata, width: number, height: number, images: readonly Uint8Array[]): SplatStreamSourceGpu {
    if (images.length !== 5 || images.some((image) => image.byteLength !== width * height * 4)) {
        throw new Error("[GaussianSplatStream] GPU byte upload requires five exact RGBA8 images");
    }
    const { textures } = createSourceTextures(device, width, height);
    try {
        for (let index = 0; index < 5; index++) {
            device.queue.writeTexture({ texture: textures[index]! }, images[index]!, { bytesPerRow: width * 4, rowsPerImage: height }, { width, height });
        }
        return finishSource(device, metadata, width, height, textures);
    } catch (error) {
        textures.forEach((texture) => texture.destroy());
        throw error;
    }
}

/** @internal Idempotently destroys an unreferenced source generation. */
export function destroySplatStreamSourceGpu(source: SplatStreamSourceGpu): void {
    if (source._destroyed) {
        return;
    }
    source._destroyed = true;
    source.textures.forEach((texture) => texture.destroy());
    source.codebooks.destroy();
}

/** @internal Publishes a deterministic active generation; gather is deferred to the draw batch. */
export function setSplatStreamGpuIntervals(state: SplatStreamGpuState, intervals: readonly SplatStreamGpuInterval[], generation: number): void {
    if (state.disposed) {
        throw new Error("[GaussianSplatStream] GPU state is disposed");
    }
    let count = 0;
    for (const interval of intervals) {
        if (
            !Number.isSafeInteger(interval.sourceOffset) ||
            !Number.isSafeInteger(interval.count) ||
            !Number.isSafeInteger(interval.destinationOffset) ||
            interval.sourceOffset < 0 ||
            interval.count < 0 ||
            interval.destinationOffset < 0 ||
            interval.sourceOffset + interval.count > interval.source.count ||
            interval.destinationOffset + interval.count > state.capacity
        ) {
            throw new Error("[GaussianSplatStream] GPU interval is outside admitted source/canonical bounds");
        }
        count = Math.max(count, interval.destinationOffset + interval.count);
    }
    state.intervals = intervals.slice();
    state.count = count;
    state.contentGeneration = generation;
}

function makeScanLevels(device: GPUDevice, groups: number, createBuffer = (descriptor: GPUBufferDescriptor): GPUBuffer => device.createBuffer(descriptor)): ScanLevel[] {
    const levels: ScanLevel[] = [];
    for (const { count, blocks } of scanLevelSizes(groups)) {
        const values = createBuffer({ size: checkedBufferSize(device, Math.max(16 * count * 4, 64), "radix values"), usage: BU.STORAGE | BU.COPY_DST });
        const scanned = createBuffer({ size: checkedBufferSize(device, Math.max(16 * count * 4, 64), "radix scan"), usage: BU.STORAGE });
        const sums = createBuffer({ size: checkedBufferSize(device, Math.max(16 * blocks * 4, 64), "radix sums"), usage: BU.STORAGE | BU.COPY_SRC });
        levels.push({ count, blocks, values, scanned, sums });
    }
    return levels;
}

/** @internal Allocates independent projection/sort state for one pass binding. */
export function createSplatStreamPassGpu(state: SplatStreamGpuState): SplatStreamPassGpu {
    const device = state.engine._device;
    const capacity = state.capacity;
    const groups = Math.ceil(capacity / WORKGROUP_SIZE);
    const gpuBytes = passStateBytes(capacity);
    if (state.passHoldBytes === gpuBytes) {
        state.ledger.commitHold(gpuBytes);
        state.passHoldBytes = 0;
    } else if (!state.ledger.tryReserve(gpuBytes)) {
        throw new Error("[GaussianSplatStream] GPU budget cannot admit pass-local projection and radix state");
    }
    const allocated: GPUBuffer[] = [];
    const create = (descriptor: GPUBufferDescriptor): GPUBuffer => {
        const buffer = device.createBuffer(descriptor);
        allocated.push(buffer);
        return buffer;
    };
    try {
        const projected = create({ size: checkedBufferSize(device, capacity * RECORD_BYTES, "projected"), usage: BU.STORAGE | BU.COPY_SRC });
        const keys = [
            create({ size: checkedBufferSize(device, capacity * KEY_BYTES, "radix key"), usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }),
            create({ size: checkedBufferSize(device, capacity * KEY_BYTES, "radix key"), usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST }),
        ] as const;
        const indirect = create({ size: INDIRECT_BYTES, usage: BU.STORAGE | BU.INDIRECT | BU.COPY_SRC | BU.COPY_DST });
        const indirectTemplate = create({ size: INDIRECT_BYTES, usage: BU.COPY_SRC, mappedAtCreation: true });
        new Uint32Array(indirectTemplate.getMappedRange()).set([6, 0, 0, 0]);
        indirectTemplate.unmap();
        return {
            projected,
            keys,
            indirect,
            indirectTemplate,
            projectParams: create({ size: PARAM_SLOT_BYTES, usage: BU.UNIFORM | BU.COPY_DST }),
            radixParams: create({ size: PARAM_SLOT_BYTES * 256, usage: BU.UNIFORM | BU.COPY_DST }),
            digitBases: create({ size: 64, usage: BU.STORAGE }),
            levels: makeScanLevels(device, groups, create),
            gpuBytes,
            bootstrapReadback: null,
            bootstrapSignal: null,
            bootstrapClaimed: false,
            sorted: keys[0],
            bindGroup: null,
            lastKey: "",
            destroyed: false,
        };
    } catch (reason) {
        allocated.forEach((buffer) => buffer.destroy());
        state.ledger.release(gpuBytes);
        throw reason;
    }
}

function bindGroup(device: GPUDevice, layout: GPUBindGroupLayout, buffers: readonly [GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer]): GPUBindGroup {
    return device.createBindGroup({
        layout,
        entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer, size: binding === 6 ? 32 : undefined } })),
    });
}

function writeRadixParams(data: Uint32Array, slot: number, count: number, groups: number, shift: number, blocks: number, stride: number, parentStride = 0): number {
    const offset = slot * PARAM_SLOT_BYTES;
    const base = offset / 4;
    data.set([count, groups, shift, blocks, stride, parentStride], base);
    return offset;
}

function recordGather(state: SplatStreamGpuState, encoder: GPUCommandEncoder): void {
    if (state.gatheredGeneration === state.contentGeneration) {
        return;
    }
    const device = state.engine._device;
    const maxGroups = device.limits.maxComputeWorkgroupsPerDimension;
    const params = new ArrayBuffer(state.gatherParams.size);
    const u32 = new Uint32Array(params);
    const f32 = new Float32Array(params);
    const dispatches: Array<{ bindGroup: GPUBindGroup; offset: number; groups: number }> = [];
    let slot = 0;
    for (const interval of state.intervals) {
        let consumed = 0;
        while (consumed < interval.count) {
            if (slot * PARAM_SLOT_BYTES >= state.gatherParams.size) {
                throw new Error("[GaussianSplatStream] active intervals exceed bounded gather parameter capacity");
            }
            const count = Math.min(interval.count - consumed, maxGroups * WORKGROUP_SIZE);
            const offset = slot * PARAM_SLOT_BYTES;
            const base = offset / 4;
            u32.set([interval.sourceOffset + consumed, count, interval.destinationOffset + consumed, interval.source.width], base);
            f32.set(interval.source.meansMin, base + 4);
            f32.set(interval.source.meansMax, base + 8);
            const bindGroup = device.createBindGroup({
                layout: state.pipelines.gatherLayout,
                entries: [
                    ...interval.source.views.map((view, binding) => ({ binding, resource: view })),
                    { binding: 5, resource: { buffer: interval.source.codebooks } },
                    { binding: 6, resource: { buffer: state.canonical } },
                    { binding: 7, resource: { buffer: state.gatherParams, size: 48 } },
                ],
            });
            dispatches.push({ bindGroup, offset, groups: Math.ceil(count / WORKGROUP_SIZE) });
            consumed += count;
            slot++;
        }
    }
    if (slot) {
        device.queue.writeBuffer(state.gatherParams, 0, params, 0, slot * PARAM_SLOT_BYTES);
        const pass = encoder.beginComputePass({ label: "splat stream gather" });
        pass.setPipeline(state.pipelines.gather);
        for (const dispatch of dispatches) {
            pass.setBindGroup(0, dispatch.bindGroup, [dispatch.offset]);
            pass.dispatchWorkgroups(dispatch.groups);
        }
        pass.end();
    }
    state.gatheredGeneration = state.contentGeneration;
}

function packProjectParams(projection: PendingProjection): ArrayBuffer {
    const bytes = new ArrayBuffer(PARAM_SLOT_BYTES);
    const f32 = new Float32Array(bytes);
    const u32 = new Uint32Array(bytes);
    f32.set(projection.worldView, 0);
    f32.set(projection.projection, 16);
    // mat3 columns have 16-byte strides in uniform address space.
    f32.set([projection.worldView[0]!, projection.worldView[1]!, projection.worldView[2]!], 32);
    f32.set([projection.worldView[4]!, projection.worldView[5]!, projection.worldView[6]!], 36);
    f32.set([projection.worldView[8]!, projection.worldView[9]!, projection.worldView[10]!], 40);
    u32[44] = projection.count;
    f32[45] = projection.width;
    f32[46] = projection.height;
    f32[47] = projection.near;
    return bytes;
}

function recordProjectionAndSort(state: SplatStreamGpuState, passGpu: SplatStreamPassGpu, projection: PendingProjection, encoder: GPUCommandEncoder): void {
    const device = state.engine._device;
    encoder.copyBufferToBuffer(passGpu.indirectTemplate, 0, passGpu.indirect, 0, INDIRECT_BYTES);
    if (projection.count === 0) {
        passGpu.sorted = passGpu.keys[0];
        return;
    }
    device.queue.writeBuffer(passGpu.projectParams, 0, packProjectParams(projection));
    const projectBindGroup = device.createBindGroup({
        layout: state.pipelines.projectLayout,
        entries: [
            { binding: 0, resource: { buffer: state.canonical } },
            { binding: 1, resource: { buffer: passGpu.projected } },
            { binding: 2, resource: { buffer: passGpu.keys[0] } },
            { binding: 3, resource: { buffer: passGpu.indirect } },
            { binding: 4, resource: { buffer: passGpu.projectParams, size: 192 } },
        ],
    });
    const projectPass = encoder.beginComputePass({ label: "splat stream projection" });
    projectPass.setPipeline(state.pipelines.project);
    projectPass.setBindGroup(0, projectBindGroup, [0]);
    projectPass.dispatchWorkgroups(Math.ceil(projection.count / WORKGROUP_SIZE));
    projectPass.end();
    if (projection.count === 1) {
        passGpu.sorted = passGpu.keys[0];
        return;
    }

    const groups = Math.ceil(projection.count / WORKGROUP_SIZE);
    const paramData = new Uint32Array((PARAM_SLOT_BYTES * 256) / 4);
    let slot = 0;
    let input = passGpu.keys[0];
    let output = passGpu.keys[1];
    const runtimeCounts: number[] = [];
    for (let count = groups; ; count = Math.ceil(count / WORKGROUP_SIZE)) {
        runtimeCounts.push(count);
        if (count <= WORKGROUP_SIZE) {
            break;
        }
    }
    const dispatch = (pipeline: GPUComputePipeline, group: GPUBindGroup, offset: number, x: number, y = 1): void => {
        const compute = encoder.beginComputePass({ label: "splat stream radix stage" });
        compute.setPipeline(pipeline);
        compute.setBindGroup(0, group, [offset]);
        compute.dispatchWorkgroups(x, y);
        compute.end();
    };
    for (let radixPass = 0; radixPass < RADIX_PASSES; radixPass++) {
        const shift = radixPass * 4;
        const level0 = passGpu.levels[0]!;
        let offset = writeRadixParams(paramData, slot++, projection.count, groups, shift, Math.ceil(groups / WORKGROUP_SIZE), level0.count);
        device.queue.writeBuffer(passGpu.radixParams, offset, paramData.buffer, offset, PARAM_SLOT_BYTES);
        dispatch(
            state.pipelines.histogram,
            bindGroup(device, state.pipelines.radixLayout, [input, output, level0.values, level0.scanned, level0.sums, passGpu.digitBases, passGpu.radixParams]),
            offset,
            groups
        );
        for (let levelIndex = 0; levelIndex < runtimeCounts.length; levelIndex++) {
            const level = passGpu.levels[levelIndex]!;
            const levelCount = runtimeCounts[levelIndex]!;
            const blocks = Math.ceil(levelCount / WORKGROUP_SIZE);
            if (levelIndex > 0) {
                const previous = passGpu.levels[levelIndex - 1]!;
                for (let digit = 0; digit < 16; digit++) {
                    encoder.copyBufferToBuffer(previous.sums, digit * previous.blocks * 4, level.values, digit * level.count * 4, levelCount * 4);
                }
            }
            offset = writeRadixParams(paramData, slot++, projection.count, levelCount, shift, level.blocks, level.count);
            device.queue.writeBuffer(passGpu.radixParams, offset, paramData.buffer, offset, PARAM_SLOT_BYTES);
            dispatch(
                state.pipelines.scan,
                bindGroup(device, state.pipelines.radixLayout, [input, output, level.values, level.scanned, level.sums, passGpu.digitBases, passGpu.radixParams]),
                offset,
                blocks,
                16
            );
        }
        for (let levelIndex = runtimeCounts.length - 2; levelIndex >= 0; levelIndex--) {
            const child = passGpu.levels[levelIndex]!;
            const parent = passGpu.levels[levelIndex + 1]!;
            const childCount = runtimeCounts[levelIndex]!;
            offset = writeRadixParams(paramData, slot++, projection.count, childCount, shift, Math.ceil(childCount / WORKGROUP_SIZE), child.count, parent.count);
            device.queue.writeBuffer(passGpu.radixParams, offset, paramData.buffer, offset, PARAM_SLOT_BYTES);
            dispatch(
                state.pipelines.add,
                bindGroup(device, state.pipelines.radixLayout, [input, output, parent.scanned, child.scanned, child.sums, passGpu.digitBases, passGpu.radixParams]),
                offset,
                Math.ceil(childCount / WORKGROUP_SIZE),
                16
            );
        }
        const root = passGpu.levels[runtimeCounts.length - 1]!;
        const rootCount = runtimeCounts[runtimeCounts.length - 1]!;
        offset = writeRadixParams(paramData, slot++, projection.count, rootCount, shift, root.blocks, root.count);
        device.queue.writeBuffer(passGpu.radixParams, offset, paramData.buffer, offset, PARAM_SLOT_BYTES);
        dispatch(
            state.pipelines.bases,
            bindGroup(device, state.pipelines.radixLayout, [input, output, root.values, root.scanned, root.sums, passGpu.digitBases, passGpu.radixParams]),
            offset,
            1
        );
        offset = writeRadixParams(paramData, slot++, projection.count, groups, shift, Math.ceil(groups / WORKGROUP_SIZE), level0.count);
        device.queue.writeBuffer(passGpu.radixParams, offset, paramData.buffer, offset, PARAM_SLOT_BYTES);
        dispatch(
            state.pipelines.scatter,
            bindGroup(device, state.pipelines.radixLayout, [input, output, level0.values, level0.scanned, level0.sums, passGpu.digitBases, passGpu.radixParams]),
            offset,
            groups
        );
        [input, output] = [output, input];
    }
    passGpu.sorted = input;
}

/** @internal Creates a target-local batch and enables target collection. */
export function createSplatStreamDrawBatch(state: SplatStreamGpuState, signature: RenderTargetSignature): SplatStreamDrawBatch {
    enableDrawBatchCollection(signature);
    const passGpu = createSplatStreamPassGpu(state);
    let pending: PendingProjection | null = null;
    const batch: SplatStreamDrawBatch = {
        _retired: false,
        passGpu,
        reset(): void {
            pending = null;
        },
        queue(projection): void {
            pending = projection;
        },
        takeBootstrapSignal(): Promise<boolean> | null {
            return null;
        },
        flush(engine): void {
            if (!pending || this._retired || state.disposed) {
                return;
            }
            recordGather(state, engine._currentEncoder);
            if (pending.key !== passGpu.lastKey) {
                recordProjectionAndSort(state, passGpu, pending, engine._currentEncoder);
                if (state.count > 0 && !passGpu.bootstrapClaimed && !passGpu.bootstrapReadback && state.ledger.tryReserve(INDIRECT_BYTES)) {
                    try {
                        const readback = engine._device.createBuffer({ size: INDIRECT_BYTES, usage: BU.COPY_DST | BU.MAP_READ });
                        engine._currentEncoder.copyBufferToBuffer(passGpu.indirect, 0, readback, 0, INDIRECT_BYTES);
                        passGpu.bootstrapReadback = readback;
                        passGpu.bootstrapSignal = new Promise<void>((resolve) => retireGpuResources(engine, resolve)).then(async () => {
                            try {
                                await readback.mapAsync(GPUMapMode.READ);
                                return new Uint32Array(readback.getMappedRange())[1]! > 0;
                            } finally {
                                if (readback.mapState === "mapped") {
                                    readback.unmap();
                                }
                                readback.destroy();
                                passGpu.bootstrapReadback = null;
                                state.ledger.release(INDIRECT_BYTES);
                            }
                        });
                    } catch (reason) {
                        state.ledger.release(INDIRECT_BYTES);
                        throw reason;
                    }
                }
                passGpu.lastKey = pending.key;
                passGpu.bindGroup = null;
            }
        },
        destroy(): void {
            if (passGpu.destroyed) {
                return;
            }
            passGpu.destroyed = true;
            state.ledger.retire(passGpu.gpuBytes, () => {
                passGpu.projected.destroy();
                passGpu.keys.forEach((buffer) => buffer.destroy());
                passGpu.indirect.destroy();
                passGpu.indirectTemplate.destroy();
                passGpu.projectParams.destroy();
                passGpu.radixParams.destroy();
                passGpu.digitBases.destroy();
                passGpu.levels.forEach((level) => {
                    level.values.destroy();
                    level.scanned.destroy();
                    level.sums.destroy();
                });
            });
            if (passGpu.bootstrapReadback && !passGpu.bootstrapSignal) {
                const readback = passGpu.bootstrapReadback;
                passGpu.bootstrapReadback = null;
                state.ledger.retire(INDIRECT_BYTES, () => readback.destroy());
            }
        },
    };
    batch.takeBootstrapSignal = (): Promise<boolean> | null => {
        if (passGpu.bootstrapClaimed || !passGpu.bootstrapSignal) {
            return null;
        }
        passGpu.bootstrapClaimed = true;
        return passGpu.bootstrapSignal;
    };
    return batch;
}

/** @internal Reuses a live batch only for the same stream state and render-task signature object. */
export function getSplatStreamDrawBatch(state: SplatStreamGpuState, signature: RenderTargetSignature): SplatStreamDrawBatch {
    _drawBatches ??= new WeakMap();
    let bySignature = _drawBatches.get(state);
    if (!bySignature) {
        bySignature = new WeakMap();
        _drawBatches.set(state, bySignature);
    }
    const cached = bySignature.get(signature);
    if (cached && !cached._retired) {
        return cached;
    }
    const batch = createSplatStreamDrawBatch(state, signature);
    bySignature.set(signature, batch);
    return batch;
}

/** @internal Make-before-break replacement helper for stream-owned canonical generations. */
export function retireSplatStreamGpuState(state: SplatStreamGpuState): void {
    if (state.disposed) {
        return;
    }
    state.disposed = true;
    if (state.passHoldBytes) {
        state.ledger.releaseHold(state.passHoldBytes);
        state.passHoldBytes = 0;
    }
    state.ledger.retire(state.gpuBytes, () => {
        state.canonical.destroy();
        state.gatherParams.destroy();
    });
}

/** @internal Deterministic exact-value key used to skip unchanged projection/sort work. */
export function splatStreamProjectionKey(contentGeneration: number, width: number, height: number, worldView: ArrayLike<number>, projection: ArrayLike<number>): string {
    let key = `${contentGeneration}/${width}/${height}`;
    for (let i = 0; i < 16; i++) {
        key += `/${worldView[i]}/${projection[i]}`;
    }
    return key;
}
