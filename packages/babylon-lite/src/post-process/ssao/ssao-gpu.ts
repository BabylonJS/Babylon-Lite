import { BU, SS, TU } from "../../engine/gpu-flags.js";
import { ssaoDepthCopyWGSL, ssaoDepthReduceWGSL, ssaoResolveWGSL, ssaoXeEstimatorWGSL } from "./ssao-wgsl.js";
import type { Mat4 } from "../../math/types.js";

/** Fixed spatial sampling presets, independent of temporal history and resolution. */
export type SsaoQuality = "low" | "medium" | "high" | "ultra";

const QUALITY_SAMPLING = {
    low: { slices: 1, steps: 2 },
    medium: { slices: 2, steps: 2 },
    high: { slices: 3, steps: 3 },
    ultra: { slices: 9, steps: 3 },
} as const;

/** @internal Reject unsupported preset names before pipeline selection. */
export function validateSsaoQuality(quality: SsaoQuality): void {
    if (quality !== "low" && quality !== "medium" && quality !== "high" && quality !== "ultra") {
        throw new Error(`Unsupported SSAO quality: ${quality}`);
    }
}

interface Stage {
    layout: GPUBindGroupLayout;
    pipeline: GPUComputePipeline;
}

/** @internal Private GPU owner, never exposed through the public task API. */
export interface SsaoGpu {
    device: GPUDevice;
    width: number;
    height: number;
    kind: "depth" | "float";
    providedNormals: boolean;
    worldNormals: boolean;
    /** Mip 0 of `depth` is written by an input adapter; skip the linearizing copy. */
    depthPrepared?: boolean;
    /** Source half-span supplied by an optional working-resolution adapter. */
    samplingFootprint?: number;
    depth: GPUTexture;
    /** Packed XeGTAO working AO (bits 0-7) and edges (bits 8-15), allocated while estimation is active. */
    working: GPUTexture | null;
    visibility: GPUTexture;
    /** Public full-size visibility when working resolution differs from output. */
    outputTexture?: GPUTexture;
    /** Resolution-matched velocity prepared by an optional input adapter. */
    sourceVelocity?: GPUTextureView;
    releaseVisibility?: () => void;
    dummyNormal: GPUTexture;
    dummyNormalView: GPUTextureView;
    uniform: GPUBuffer;
    data: Float32Array<ArrayBuffer>;
    integers: Uint32Array<ArrayBuffer>;
    copy: Stage;
    reduce: Stage;
    estimatorLayout: GPUBindGroupLayout;
    resolveLayout: GPUBindGroupLayout;
    /** Nearest/clamp sampler for the prefiltered depth chain; the estimator selects its mip level. */
    depthSampler: GPUSampler;
    estimators: Partial<Record<SsaoQuality, GPUComputePipeline>>;
    resolve: GPUComputePipeline | null;
    reductions: { group: GPUBindGroup; width: number; height: number }[];
    sourceDepth: GPUTextureView | null;
    sourceNormal: GPUTextureView | null;
    copyGroup: GPUBindGroup | null;
    estimatorGroup: GPUBindGroup | null;
    resolveGroup: GPUBindGroup | null;
    disposed: boolean;
}

/** @internal Parameters are explicit data, independent of generated shader text. */
export interface SsaoGpuParameters {
    depthMultiply: number;
    depthAdd: number;
    tanX: number;
    tanY: number;
    radius: number;
    intensity: number;
    view?: Mat4;
    phase?: number;
    quality?: SsaoQuality;
}

const UNIFORM: GPUBindGroupLayoutEntry = { binding: 0, visibility: 4, buffer: { type: "uniform" } };
const FLOAT_TEXTURE = { sampleType: "unfilterable-float" } as const;
const UINT_TEXTURE = { sampleType: "uint" } as const;
const uniformEntry = (buffer: GPUBuffer): GPUBindGroupEntry => ({ binding: 0, resource: { buffer } });

/** @internal Create owner resources; no module-level cache or allocation. */
export function createSsaoGpu(device: GPUDevice, width: number, height: number, kind: "depth" | "float", providedNormals: boolean, worldNormals = false): SsaoGpu {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new Error("SSAO requires positive integer dimensions.");
    }
    if (width > device.limits.maxTextureDimension2D || height > device.limits.maxTextureDimension2D) {
        throw new Error("SSAO dimensions exceed the device's texture limit.");
    }
    const sourceLayout: GPUBindGroupLayoutEntry = { binding: 1, visibility: SS.COMPUTE, texture: { sampleType: kind === "depth" ? "depth" : "unfilterable-float" } };
    const storage = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({
        binding,
        visibility: SS.COMPUTE,
        storageTexture: { access: "write-only", format },
    });
    const layout = (entries: GPUBindGroupLayoutEntry[]): GPUBindGroupLayout => device.createBindGroupLayout({ label: "ssao-layout", entries });
    const makePipeline = (code: string, bgl: GPUBindGroupLayout): GPUComputePipeline =>
        device.createComputePipeline({
            label: "ssao-compute",
            layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            compute: { module: device.createShaderModule({ label: "ssao-shader", code }), entryPoint: "main" },
        });
    const copyLayout = layout([UNIFORM, sourceLayout, storage(2, "r32float")]);
    const reduceLayout = layout([UNIFORM, { binding: 1, visibility: SS.COMPUTE, texture: FLOAT_TEXTURE }, storage(2, "r32float")]);
    const estimatorLayout = layout([
        UNIFORM,
        sourceLayout,
        { binding: 2, visibility: SS.COMPUTE, texture: FLOAT_TEXTURE },
        { binding: 3, visibility: SS.COMPUTE, texture: FLOAT_TEXTURE },
        storage(4, "r32uint"),
        { binding: 6, visibility: SS.COMPUTE, sampler: { type: "non-filtering" } },
    ]);
    const resolveLayout = layout([UNIFORM, sourceLayout, { binding: 2, visibility: SS.COMPUTE, texture: UINT_TEXTURE }, storage(4, "rgba16float")]);
    const mips = Math.min(5, Math.floor(Math.log2(Math.max(width, height))) + 1);
    const texture = (label: string, format: GPUTextureFormat, mipLevelCount = 1): GPUTexture =>
        device.createTexture({
            label,
            size: { width, height },
            format,
            mipLevelCount,
            usage: TU.STORAGE_BINDING | TU.TEXTURE_BINDING | TU.COPY_SRC | (format === "rgba16float" ? TU.RENDER_ATTACHMENT : 0),
        });
    const depth = texture("ssao-depth", "r32float", mips);
    const visibility = texture("ssao-visibility", "rgba16float");
    const dummyNormal = device.createTexture({ label: "ssao-unused-normal", size: [1, 1], format: "rgba32float", usage: TU.TEXTURE_BINDING });
    const uniform = device.createBuffer({ label: "ssao-params", size: 176, usage: BU.UNIFORM | BU.COPY_DST });
    const data = new Float32Array(44);
    const gpu: SsaoGpu = {
        device,
        width,
        height,
        kind,
        providedNormals,
        worldNormals,
        depth,
        working: null,
        visibility,
        dummyNormal,
        dummyNormalView: dummyNormal.createView(),
        uniform,
        data,
        integers: new Uint32Array(data.buffer),
        copy: { layout: copyLayout, pipeline: makePipeline(ssaoDepthCopyWGSL(kind), copyLayout) },
        reduce: { layout: reduceLayout, pipeline: makePipeline(ssaoDepthReduceWGSL(), reduceLayout) },
        estimatorLayout,
        resolveLayout,
        depthSampler: device.createSampler({ label: "ssao-depth-point", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
        estimators: {},
        resolve: null,
        reductions: [],
        sourceDepth: null,
        sourceNormal: null,
        copyGroup: null,
        estimatorGroup: null,
        resolveGroup: null,
        disposed: false,
    };
    for (let mip = 1; mip < mips; mip++) {
        gpu.reductions.push({
            width: Math.max(1, width >> mip),
            height: Math.max(1, height >> mip),
            group: device.createBindGroup({
                layout: reduceLayout,
                entries: [
                    uniformEntry(uniform),
                    { binding: 1, resource: depth.createView({ baseMipLevel: mip - 1, mipLevelCount: 1 }) },
                    { binding: 2, resource: depth.createView({ baseMipLevel: mip, mipLevelCount: 1 }) },
                ],
            }),
        });
    }
    // The depth binding is filled when the producer's attachment has been allocated.
    return gpu;
}

/** @internal Upload projection/settings into the preallocated owner scratch buffer. */
export function writeSsaoGpuParameters(gpu: Pick<SsaoGpu, "device" | "width" | "height" | "uniform" | "data" | "integers" | "samplingFootprint">, params: SsaoGpuParameters): void {
    const data = gpu.data;
    data.fill(0);
    gpu.integers[0] = gpu.width;
    gpu.integers[1] = gpu.height;
    data[2] = 1 / gpu.width;
    data[3] = 1 / gpu.height;
    data[4] = params.depthMultiply;
    data[5] = params.depthAdd;
    data[6] = params.tanX;
    data[7] = params.tanY;
    data[8] = params.tanX * 2;
    data[9] = params.tanY * -2;
    data[10] = -params.tanX;
    data[11] = params.tanY;
    data[12] = data[8]! * data[2]!;
    data[13] = data[9]! * data[3]!;
    data[14] = params.radius;
    data[15] = 0.615;
    data[16] = 1.457;
    data[17] = gpu.samplingFootprint ?? 0;
    data[18] = 2.2;
    data[19] = 1.2;
    data[20] = 2;
    data[22] = 3.3;
    gpu.integers[23] = params.phase ?? 0;
    data[25] = params.intensity;
    if (params.view) {
        for (let i = 0; i < 16; i++) {
            data[28 + i] = params.view[i]!;
        }
    } else {
        data[28] = data[33] = data[38] = data[43] = 1;
    }
    gpu.device.queue.writeBuffer(gpu.uniform, 0, data);
}

/** @internal Rebind changed sources and lazily allocate estimation working textures. */
export function bindSsaoGpuSources(gpu: SsaoGpu, depth: GPUTextureView, normal: GPUTextureView | null): void {
    if (gpu.sourceDepth === depth && gpu.sourceNormal === normal && gpu.working) {
        return;
    }
    if (gpu.providedNormals !== (normal !== null)) {
        gpu.providedNormals = normal !== null;
        gpu.estimators = {};
    }
    const device = gpu.device;
    if (!gpu.working) {
        gpu.working = device.createTexture({
            label: "ssao-working-ao-edges",
            size: [gpu.width, gpu.height],
            format: "r32uint",
            usage: TU.STORAGE_BINDING | TU.TEXTURE_BINDING | TU.COPY_SRC,
        });
    }
    gpu.copyGroup = device.createBindGroup({
        layout: gpu.copy.layout,
        entries: [uniformEntry(gpu.uniform), { binding: 1, resource: depth }, { binding: 2, resource: gpu.depth.createView({ baseMipLevel: 0, mipLevelCount: 1 }) }],
    });
    gpu.estimatorGroup = gpu.working
        ? device.createBindGroup({
              layout: gpu.estimatorLayout,
              entries: [
                  uniformEntry(gpu.uniform),
                  { binding: 1, resource: depth },
                  { binding: 2, resource: gpu.depth.createView() },
                  { binding: 3, resource: normal ?? gpu.dummyNormalView },
                  { binding: 4, resource: gpu.working.createView() },
                  { binding: 6, resource: gpu.depthSampler },
              ],
          })
        : null;
    gpu.resolveGroup = gpu.working
        ? device.createBindGroup({
              layout: gpu.resolveLayout,
              entries: [
                  uniformEntry(gpu.uniform),
                  { binding: 1, resource: depth },
                  { binding: 2, resource: gpu.working.createView() },
                  { binding: 4, resource: gpu.visibility.createView() },
              ],
          })
        : null;
    gpu.sourceDepth = depth;
    gpu.sourceNormal = normal;
}

/** @internal Record depth preparation, estimation and resolve in the owning frame encoder. */
export function executeSsaoGpu(gpu: SsaoGpu, encoder: GPUCommandEncoder, quality: SsaoQuality = "high"): void {
    const working = gpu.working;
    if (gpu.disposed || !gpu.copyGroup || !gpu.estimatorGroup || !gpu.resolveGroup || !working) {
        throw new Error("SSAO GPU owner is disposed or has no bound estimation resources.");
    }
    let estimator = gpu.estimators[quality];
    let resolve = gpu.resolve;
    if (!estimator || !resolve) {
        const make = (code: string, layout: GPUBindGroupLayout, constants?: Record<string, number>): GPUComputePipeline =>
            gpu.device.createComputePipeline({
                label: "ssao-xegtao",
                layout: gpu.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
                compute: { module: gpu.device.createShaderModule({ label: "ssao-xegtao", code }), entryPoint: "main", constants },
            });
        if (!estimator) {
            const sampling = QUALITY_SAMPLING[quality];
            estimator = make(ssaoXeEstimatorWGSL(gpu.kind), gpu.estimatorLayout, {
                PROVIDED_NORMALS: gpu.providedNormals ? 1 : 0,
                WORLD_NORMALS: gpu.worldNormals ? 1 : 0,
                SLICE_COUNT: sampling.slices,
                STEP_COUNT: sampling.steps,
            });
            gpu.estimators[quality] = estimator;
        }
        if (!resolve) {
            resolve = make(ssaoResolveWGSL(gpu.kind), gpu.resolveLayout);
            gpu.resolve = resolve;
        }
    }
    const pass = encoder.beginComputePass({ label: "ssao" });
    recordSsaoDepth(gpu, pass);
    pass.setPipeline(estimator);
    pass.setBindGroup(0, gpu.estimatorGroup);
    pass.dispatchWorkgroups(Math.ceil(working.width / 8), Math.ceil(working.height / 8));
    pass.setPipeline(resolve);
    pass.setBindGroup(0, gpu.resolveGroup);
    pass.dispatchWorkgroups(Math.ceil(gpu.visibility.width / 8), Math.ceil(gpu.visibility.height / 8));
    pass.end();
}

function recordSsaoDepth(gpu: SsaoGpu, pass: GPUComputePassEncoder): void {
    if (!gpu.depthPrepared) {
        pass.setPipeline(gpu.copy.pipeline);
        pass.setBindGroup(0, gpu.copyGroup);
        pass.dispatchWorkgroups(Math.ceil(gpu.width / 8), Math.ceil(gpu.height / 8));
    }
    if (!gpu.reductions.length) {
        return;
    }
    pass.setPipeline(gpu.reduce.pipeline);
    for (const level of gpu.reductions) {
        pass.setBindGroup(0, level.group);
        pass.dispatchWorkgroups(Math.ceil(level.width / 8), Math.ceil(level.height / 8));
    }
}
/** @internal Clear to the AO identity without dispatching estimation. */
export function clearSsaoGpu(gpu: SsaoGpu, encoder: GPUCommandEncoder): void {
    const pass = encoder.beginRenderPass({
        label: "ssao-disabled",
        colorAttachments: [{ view: (gpu.outputTexture ?? gpu.visibility).createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 1, g: 1, b: 1, a: 1 } }],
    });
    pass.end();
}

/** @internal Sources are borrowed and deliberately not destroyed. */
export function disposeSsaoGpu(gpu: SsaoGpu): void {
    if (gpu.disposed) {
        return;
    }
    gpu.disposed = true;
    gpu.uniform.destroy();
    gpu.depth.destroy();
    gpu.working?.destroy();
    gpu.dummyNormal.destroy();
    gpu.working = null;
    gpu.estimatorGroup = gpu.resolveGroup = null;
    if (gpu.outputTexture) {
        gpu.visibility.destroy();
    }
    if (gpu.releaseVisibility) {
        gpu.releaseVisibility();
    } else {
        (gpu.outputTexture ?? gpu.visibility).destroy();
    }
    gpu.estimators = {};
    gpu.resolve = null;
}
