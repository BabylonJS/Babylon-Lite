import { BU, SS, TU } from "../../../packages/babylon-lite/src/engine/gpu-flags.js";
import type { SsaoGpu } from "../../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import { ssaoTemporalWGSL } from "./ssao-temporal-wgsl.js";
import { ssaoMotionWGSL, ssaoMotionReduceWGSL } from "./ssao-motion-wgsl.js";
import { ssaoStabilizeWGSL } from "./ssao-stabilize-wgsl.js";

interface MotionPyramid {
    textures: [GPUTexture, GPUTexture];
    layout: GPUBindGroupLayout;
    pipeline: GPUComputePipeline;
    groups: [GPUBindGroup, GPUBindGroup];
    reduce: GPUComputePipeline;
    reductions: { group: GPUBindGroup; width: number; height: number }[][];
}

/** @internal Private history allocation, with a stable public visibility writer. */
export interface SsaoTemporalGpu {
    owner: SsaoGpu;
    scratch: GPUTexture;
    history: [GPUTexture, GPUTexture];
    geometry: [GPUTexture, GPUTexture];
    uniform: GPUBuffer;
    data: Float32Array<ArrayBuffer>;
    layout: GPUBindGroupLayout;
    pipeline: GPUComputePipeline;
    module: GPUShaderModule;
    groups: [GPUBindGroup, GPUBindGroup];
    baseResolve: GPUBindGroup;
    scratchResolve: GPUBindGroup;
    sourceDepth: GPUTextureView;
    sourceNormal: GPUTextureView | null;
    velocity: GPUTextureView | null;
    index: number;
    disposed: boolean;
    motion: MotionPyramid | null;
    stabilizeLayout: GPUBindGroupLayout;
    stabilizePipeline: GPUComputePipeline;
    stabilizeGroups: [GPUBindGroup, GPUBindGroup];
}
/** @internal Cached resource construction, never called during unchanged frames. */
export function createSsaoTemporalGpu(owner: SsaoGpu, velocity: GPUTextureView | null): SsaoTemporalGpu {
    if (!owner.resolveGroup) throw new Error("Legacy temporal SSAO requires bound estimation resources.");
    const device = owner.device;
    const texture = (label: string, format: GPUTextureFormat): GPUTexture =>
        device.createTexture({
            label,
            size: [owner.width, owner.height],
            format,
            usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING | TU.COPY_SRC | TU.COPY_DST,
        });
    const uniform = device.createBuffer({ label: "ssao-temporal-params", size: 208, usage: BU.UNIFORM | BU.COPY_DST });
    const layout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: SS.COMPUTE, buffer: { type: "uniform" } },
            { binding: 1, visibility: SS.COMPUTE, texture: { sampleType: owner.kind === "depth" ? "depth" : "unfilterable-float" } },
            ...[2, 3, 4, 5].map((binding) => ({ binding, visibility: SS.COMPUTE, texture: { sampleType: "unfilterable-float" as const } })),
            { binding: 6, visibility: SS.COMPUTE, texture: { sampleType: "uint" } },
            { binding: 7, visibility: SS.COMPUTE, buffer: { type: "uniform" } },
            { binding: 8, visibility: SS.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
            { binding: 9, visibility: SS.COMPUTE, storageTexture: { access: "write-only", format: "rg32uint" } },
            { binding: 10, visibility: SS.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
            { binding: 11, visibility: SS.COMPUTE, texture: { sampleType: "uint" } },
            { binding: 12, visibility: SS.COMPUTE, texture: { sampleType: "uint" } },
        ],
    });
    const module = device.createShaderModule({ label: "ssao-temporal", code: ssaoTemporalWGSL(owner.kind) });
    const pipeline = device.createComputePipeline({
        label: "ssao-temporal",
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: {
            module,
            entryPoint: "main",
            constants: {
                PROVIDED_NORMALS: owner.providedNormals ? 1 : 0,
                WORLD_NORMALS: owner.worldNormals ? 1 : 0,
                HAS_VELOCITY: velocity ? 1 : 0,
            },
        },
    });
    const stabilizeLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: SS.COMPUTE, buffer: { type: "uniform" } },
            { binding: 1, visibility: SS.COMPUTE, texture: { sampleType: "unfilterable-float" } },
            { binding: 2, visibility: SS.COMPUTE, texture: { sampleType: "uint" } },
            { binding: 3, visibility: SS.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
        ],
    });
    const stabilizePipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [stabilizeLayout] }),
        compute: { module: device.createShaderModule({ code: ssaoStabilizeWGSL() }), entryPoint: "main" },
    });
    const state: SsaoTemporalGpu = {
        owner,
        scratch: texture("ssao-spatial", "rgba16float"),
        history: [texture("ssao-history-0", "rgba16float"), texture("ssao-history-1", "rgba16float")],
        geometry: [texture("ssao-history-geometry-0", "rg32uint"), texture("ssao-history-geometry-1", "rg32uint")],
        uniform,
        data: new Float32Array(52),
        layout,
        pipeline,
        module,
        groups: undefined!,
        baseResolve: owner.resolveGroup,
        scratchResolve: undefined!,
        sourceDepth: owner.sourceDepth!,
        sourceNormal: owner.sourceNormal,
        velocity,
        index: 0,
        disposed: false,
        motion: null,
        stabilizeLayout,
        stabilizePipeline,
        stabilizeGroups: undefined!,
    };
    if (velocity) {
        const width = Math.ceil(owner.width / 8),
            height = Math.ceil(owner.height / 8);
        const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
        const mask = (label: string): GPUTexture =>
            device.createTexture({
                label,
                size: [width, height],
                mipLevelCount,
                format: "rgba32uint",
                usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
            });
        const motionLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: SS.COMPUTE, buffer: { type: "uniform" } },
                { binding: 1, visibility: SS.COMPUTE, texture: { sampleType: owner.kind === "depth" ? "depth" : "unfilterable-float" } },
                { binding: 2, visibility: SS.COMPUTE, texture: { sampleType: "unfilterable-float" } },
                { binding: 3, visibility: SS.COMPUTE, texture: { sampleType: "unfilterable-float" } },
                { binding: 4, visibility: SS.COMPUTE, texture: { sampleType: "uint" } },
                { binding: 5, visibility: SS.COMPUTE, buffer: { type: "uniform" } },
                { binding: 6, visibility: SS.COMPUTE, storageTexture: { access: "write-only", format: "rgba32uint" } },
            ],
        });
        const motionModule = device.createShaderModule({ code: ssaoMotionWGSL(owner.kind) });
        const motionPipeline = device.createComputePipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [motionLayout] }),
            compute: {
                module: motionModule,
                entryPoint: "main",
                constants: {
                    PROVIDED_NORMALS: owner.providedNormals ? 1 : 0,
                    WORLD_NORMALS: owner.worldNormals ? 1 : 0,
                },
            },
        });
        const reduceLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: SS.COMPUTE, texture: { sampleType: "uint" } },
                { binding: 1, visibility: SS.COMPUTE, storageTexture: { access: "write-only", format: "rgba32uint" } },
            ],
        });
        const reduce = device.createComputePipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [reduceLayout] }),
            compute: { module: device.createShaderModule({ code: ssaoMotionReduceWGSL() }), entryPoint: "main" },
        });
        const textures: [GPUTexture, GPUTexture] = [mask("ssao-motion-0"), mask("ssao-motion-1")];
        const reductions = textures.map((texture) => {
            const stages = [];
            for (let mip = 1; mip < mipLevelCount; mip++) {
                stages.push({
                    width: Math.max(1, width >> mip),
                    height: Math.max(1, height >> mip),
                    group: device.createBindGroup({
                        layout: reduceLayout,
                        entries: [
                            { binding: 0, resource: texture.createView({ baseMipLevel: mip - 1, mipLevelCount: 1 }) },
                            { binding: 1, resource: texture.createView({ baseMipLevel: mip, mipLevelCount: 1 }) },
                        ],
                    }),
                });
            }
            return stages;
        });
        state.motion = { textures, layout: motionLayout, pipeline: motionPipeline, groups: undefined!, reduce, reductions };
    }
    bindSsaoTemporalGpu(state, velocity);
    return state;
}

/** @internal Update only changed input bindings, including an ordinary source-owner rebind. */
export function bindSsaoTemporalGpu(state: SsaoTemporalGpu, velocity: GPUTextureView | null): void {
    const gpu = state.owner;
    const working = gpu.working;
    if (!working || !gpu.resolveGroup) throw new Error("Legacy temporal SSAO requires bound estimation resources.");
    if (state.groups && state.sourceDepth === gpu.sourceDepth && state.sourceNormal === gpu.sourceNormal && state.velocity === velocity) {
        if (gpu.resolveGroup === state.baseResolve || gpu.resolveGroup === state.scratchResolve) {
            return;
        }
    }
    if (gpu.resolveGroup !== state.scratchResolve) {
        state.baseResolve = gpu.resolveGroup;
    }
    state.sourceDepth = gpu.sourceDepth!;
    state.sourceNormal = gpu.sourceNormal;
    state.velocity = velocity;
    state.scratchResolve = gpu.device.createBindGroup({
        layout: gpu.resolveLayout,
        entries: [
            { binding: 0, resource: { buffer: gpu.uniform } },
            { binding: 1, resource: state.sourceDepth },
            { binding: 2, resource: working.createView() },
            { binding: 4, resource: state.scratch.createView() },
        ],
    });
    const group = (index: number): GPUBindGroup =>
        gpu.device.createBindGroup({
            layout: state.layout,
            entries: [
                { binding: 0, resource: { buffer: gpu.uniform } },
                { binding: 1, resource: state.sourceDepth },
                { binding: 2, resource: state.sourceNormal ?? gpu.dummyNormalView },
                { binding: 3, resource: state.scratch.createView() },
                { binding: 4, resource: velocity ?? gpu.dummyNormalView },
                { binding: 5, resource: state.history[index]!.createView() },
                { binding: 6, resource: state.geometry[index]!.createView() },
                { binding: 7, resource: { buffer: state.uniform } },
                { binding: 8, resource: state.history[1 - index]!.createView() },
                { binding: 9, resource: state.geometry[1 - index]!.createView() },
                { binding: 10, resource: gpu.visibility.createView() },
                { binding: 11, resource: (state.motion?.textures[1 - index] ?? working).createView() },
                { binding: 12, resource: (state.motion?.textures[index] ?? working).createView() },
            ],
        });
    state.groups = [group(0), group(1)];
    const stabilize = (index: number): GPUBindGroup =>
        gpu.device.createBindGroup({
            layout: state.stabilizeLayout,
            entries: [
                { binding: 0, resource: { buffer: gpu.uniform } },
                { binding: 1, resource: state.history[1 - index]!.createView() },
                { binding: 2, resource: state.geometry[1 - index]!.createView() },
                { binding: 3, resource: gpu.visibility.createView() },
            ],
        });
    state.stabilizeGroups = [stabilize(0), stabilize(1)];
    if (state.motion) {
        const motion = state.motion;
        const bind = (index: number): GPUBindGroup =>
            gpu.device.createBindGroup({
                layout: motion.layout,
                entries: [
                    { binding: 0, resource: { buffer: gpu.uniform } },
                    { binding: 1, resource: state.sourceDepth },
                    { binding: 2, resource: state.sourceNormal ?? gpu.dummyNormalView },
                    { binding: 3, resource: velocity! },
                    { binding: 4, resource: state.geometry[index]!.createView() },
                    { binding: 5, resource: { buffer: state.uniform } },
                    { binding: 6, resource: motion.textures[1 - index]!.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
                ],
            });
        motion.groups = [bind(0), bind(1)];
    }
}

/** @internal Resolve and advance history without changing the sampled output allocation. */
export function executeSsaoTemporalGpu(state: SsaoTemporalGpu, encoder: GPUCommandEncoder): void {
    const gpu = state.owner;
    gpu.device.queue.writeBuffer(state.uniform, 0, state.data);
    const pass = encoder.beginComputePass({ label: "ssao-temporal" });
    if (state.motion) {
        const motion = state.motion;
        pass.setPipeline(motion.pipeline);
        pass.setBindGroup(0, motion.groups[state.index]!);
        pass.dispatchWorkgroups(Math.ceil(gpu.width / 8), Math.ceil(gpu.height / 8));
        pass.setPipeline(motion.reduce);
        for (const stage of motion.reductions[1 - state.index]!) {
            pass.setBindGroup(0, stage.group);
            pass.dispatchWorkgroups(Math.ceil(stage.width / 8), Math.ceil(stage.height / 8));
        }
    }
    pass.setPipeline(state.pipeline);
    pass.setBindGroup(0, state.groups[state.index]!);
    pass.dispatchWorkgroups(Math.ceil(gpu.width / 8), Math.ceil(gpu.height / 8));
    pass.setPipeline(state.stabilizePipeline);
    pass.setBindGroup(0, state.stabilizeGroups[state.index]!);
    pass.dispatchWorkgroups(Math.ceil(gpu.width / 8), Math.ceil(gpu.height / 8));
    pass.end();
    state.index = 1 - state.index;
}

/** @internal The borrowed AO owner and input textures remain owned by their producers. */
export function disposeSsaoTemporalGpu(state: SsaoTemporalGpu): void {
    if (state.disposed) {
        return;
    }
    state.disposed = true;
    if (state.owner.resolveGroup === state.scratchResolve) {
        state.owner.resolveGroup = state.baseResolve;
    }
    state.uniform.destroy();
    state.scratch.destroy();
    for (const texture of [...state.history, ...state.geometry]) {
        texture.destroy();
    }
    if (state.motion) {
        for (const texture of state.motion.textures) {
            texture.destroy();
        }
    }
}
