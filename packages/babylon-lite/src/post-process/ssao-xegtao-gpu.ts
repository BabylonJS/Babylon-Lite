/** XeGTAO temporal reconstruction adapted from DiligentFX; provenance is documented in the SSAO architecture specification. */
import { BU, SS, TU } from "../engine/gpu-flags.js";
import type { SsaoGpu } from "./ssao-gpu.js";
import type { WgslSource } from "../shader/wgsl.js";
import { xegtaoClosestMotionWGSL, xegtaoTemporalWGSL, xegtaoTransportWGSL, xegtaoReduceWGSL, xegtaoRepairWGSL, xegtaoOutputWGSL } from "./ssao-xegtao-wgsl.js";

interface ReconstructionStage {
    pipeline: GPURenderPipeline;
    group: GPUBindGroup;
    pass: GPURenderPassDescriptor;
    indirect?: GPUBuffer;
}
/** @internal Optional transport work selection; no reconstruction semantics. */
export interface XegtaoTransportExtension {
    pipeline: GPURenderPipeline;
    resources: GPUBindingResource[];
    indirect: GPUBuffer;
    execute(encoder: GPUCommandEncoder): void;
    dispose(): void;
}

/** @internal Complete native-format reconstruction owner. */
export interface XegtaoTemporalGpu {
    owner: SsaoGpu;
    scratch: GPUTexture;
    history: [GPUTexture, GPUTexture];
    counts: [GPUTexture, GPUTexture];
    geometry: GPUTexture;
    convolution: GPUTexture;
    convolutionDepth: GPUTexture;
    repaired: GPUTexture;
    closestMotion: GPUTexture | null;
    transport: GPUTexture | null;
    uniform: GPUBuffer;
    data: Float32Array<ArrayBuffer>;
    sourceDepth: GPUTextureView;
    sourceNormal: GPUTextureView | null;
    velocity: GPUTextureView | null;
    baseResolve: GPUBindGroup | null;
    scratchResolve: GPUBindGroup | null;
    index: number;
    disposed: boolean;
    temporalPipeline: GPURenderPipeline;
    motionPipeline: GPURenderPipeline | null;
    transportPipeline: GPURenderPipeline | null;
    reducePipeline: GPURenderPipeline;
    repairPipeline: GPURenderPipeline;
    outputPipeline: GPURenderPipeline;
    stages: [ReconstructionStage[], ReconstructionStage[]];
    linearSampler: GPUSampler;
    pointSampler: GPUSampler;
    transportExtension?: XegtaoTransportExtension;
    boundTransportExtension?: XegtaoTransportExtension;
}

export function createXegtaoTemporalGpu(owner: SsaoGpu, velocity: GPUTextureView | null, transport = false, previousDepth = false): XegtaoTemporalGpu {
    if (transport && !velocity) {
        throw new Error("Occlusion-history transport requires object velocity.");
    }
    const device = owner.device;
    const texture = (label: string, format: GPUTextureFormat, mipLevelCount = 1): GPUTexture =>
        device.createTexture({
            label,
            size: [owner.width, owner.height],
            format,
            mipLevelCount,
            usage: TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT | TU.COPY_SRC | TU.COPY_DST | (format === "rgba16float" ? TU.STORAGE_BINDING : 0),
        });
    const uniformEntry = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: SS.FRAGMENT, buffer: { type: "uniform" } });
    const sampled = (binding: number, type: GPUTextureSampleType = "unfilterable-float"): GPUBindGroupLayoutEntry => ({
        binding,
        visibility: SS.FRAGMENT,
        texture: { sampleType: type },
    });
    const sourceType = owner.kind === "depth" ? "depth" : "unfilterable-float";
    const filterableDepth = device.features.has("float32-filterable");
    const constants = { PROVIDED_NORMALS: owner.providedNormals ? 1 : 0, WORLD_NORMALS: owner.worldNormals ? 1 : 0 };
    const pipeline = (label: string, code: WgslSource, entries: GPUBindGroupLayoutEntry[], formats: GPUTextureFormat[], overrides?: Record<string, number>): GPURenderPipeline => {
        const module = device.createShaderModule({ label, code });
        const layout = device.createBindGroupLayout({ entries });
        return device.createRenderPipeline({
            label,
            layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
            vertex: { module, entryPoint: "fullscreen" },
            fragment: { module, entryPoint: "main", targets: formats.map((format) => ({ format })), constants: overrides },
            primitive: { topology: "triangle-list" },
        });
    };
    const temporalPipeline = pipeline(
        "ssao-xegtao-temporal",
        xegtaoTemporalWGSL(owner.kind),
        [
            uniformEntry(0),
            sampled(1, sourceType),
            sampled(2),
            sampled(3),
            sampled(4, "float"),
            sampled(5, "uint"),
            sampled(6),
            uniformEntry(7),
            sampled(8),
            sampled(9),
            sampled(10),
        ],
        ["r8unorm", "r16float", "r32float"],
        { ...constants, HAS_VELOCITY: velocity ? 1 : 0, HAS_TRANSPORT: transport ? 1 : 0 }
    );
    const motionPipeline =
        velocity && !previousDepth
            ? pipeline("ssao-xegtao-closest-motion", xegtaoClosestMotionWGSL(owner.kind), [uniformEntry(0), sampled(1, sourceType), sampled(2)], ["rg16float"])
            : null;
    const transportPipeline = transport
        ? pipeline(
              "ssao-occlusion-history-transport",
              xegtaoTransportWGSL(owner.kind),
              [uniformEntry(0), sampled(1, sourceType), sampled(2), sampled(3), sampled(4), sampled(5, "float"), sampled(6, "uint"), uniformEntry(7)],
              ["rgba32float"],
              constants
          )
        : null;
    const reducePipeline = pipeline("ssao-xegtao-convolution", xegtaoReduceWGSL(), [sampled(0, "float"), sampled(1)], ["r8unorm", "r32float"]);
    const repairPipeline = pipeline(
        "ssao-xegtao-history-repair",
        xegtaoRepairWGSL(owner.kind, filterableDepth),
        [
            uniformEntry(0),
            sampled(1, sourceType),
            sampled(2),
            sampled(3),
            sampled(4, "float"),
            sampled(5, filterableDepth ? "float" : "unfilterable-float"),
            { binding: 6, visibility: SS.FRAGMENT, sampler: { type: "filtering" } },
            { binding: 7, visibility: SS.FRAGMENT, sampler: { type: "non-filtering" } },
        ],
        ["r8unorm"],
        constants
    );
    const outputPipeline = pipeline(
        "ssao-xegtao-output",
        xegtaoOutputWGSL(owner.kind),
        [uniformEntry(0), sampled(1, sourceType), sampled(2), sampled(3), sampled(4, "float"), uniformEntry(5)],
        ["r8unorm", "rgba16float", "rg32uint"],
        constants
    );
    const mips = Math.min(5, Math.floor(Math.log2(Math.max(owner.width, owner.height))) + 1);
    const convolution = texture("ssao-xegtao-temporal", "r8unorm", mips);
    const state: XegtaoTemporalGpu = {
        owner,
        scratch: texture("ssao-spatial", "rgba16float"),
        history: [texture("ssao-history-0", "r8unorm"), texture("ssao-history-1", "r8unorm")],
        counts: [texture("ssao-count-0", "r16float"), texture("ssao-count-1", "r16float")],
        geometry: texture("ssao-history-geometry-0", "rg32uint"),
        convolution,
        convolutionDepth: texture("ssao-xegtao-convolution-depth", "r32float", mips),
        repaired: texture("ssao-xegtao-repaired", "r8unorm"),
        closestMotion: motionPipeline ? texture("ssao-xegtao-closest-motion", "rg16float") : null,
        transport: transport ? texture("ssao-occlusion-history-transport", "rgba32float") : null,
        uniform: device.createBuffer({ label: "ssao-temporal-params", size: 384, usage: BU.UNIFORM | BU.COPY_DST }),
        // Filled by the temporal controller before every execution, including the velocity tolerances.
        data: new Float32Array(96),
        sourceDepth: owner.sourceDepth!,
        sourceNormal: owner.sourceNormal,
        velocity,
        baseResolve: owner.resolveGroup,
        scratchResolve: null,
        index: 0,
        disposed: false,
        temporalPipeline,
        motionPipeline,
        transportPipeline,
        reducePipeline,
        repairPipeline,
        outputPipeline,
        stages: undefined!,
        linearSampler: device.createSampler({ minFilter: "linear", magFilter: "linear", mipmapFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
        pointSampler: device.createSampler({ addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }),
    };
    bindXegtaoTemporalGpu(state, velocity);
    return state;
}

export function bindXegtaoTemporalGpu(state: XegtaoTemporalGpu, velocity: GPUTextureView | null): void {
    const o = state.owner;
    if (
        state.stages &&
        state.sourceDepth === o.sourceDepth &&
        state.sourceNormal === o.sourceNormal &&
        state.velocity === velocity &&
        state.boundTransportExtension === state.transportExtension &&
        (o.resolveGroup === state.baseResolve || o.resolveGroup === state.scratchResolve)
    ) {
        return;
    }
    if (o.resolveGroup !== state.scratchResolve) {
        state.baseResolve = o.resolveGroup;
    }
    state.sourceDepth = o.sourceDepth!;
    state.sourceNormal = o.sourceNormal;
    state.velocity = velocity;
    state.boundTransportExtension = state.transportExtension;
    state.scratchResolve = o.working
        ? o.device.createBindGroup({
              layout: o.resolveLayout,
              entries: [
                  { binding: 0, resource: { buffer: o.uniform } },
                  { binding: 1, resource: state.sourceDepth },
                  { binding: 2, resource: o.working.createView() },
                  { binding: 4, resource: state.scratch.createView() },
              ],
          })
        : null;
    const uniform = { buffer: o.uniform };
    const stage = (pipeline: GPURenderPipeline, resources: GPUBindingResource[], targets: GPUTextureView[]): ReconstructionStage => ({
        pipeline,
        group: o.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({ binding, resource })) }),
        pass: {
            label: pipeline.label,
            colorAttachments: targets.map((view) => ({ view, loadOp: "clear", storeOp: "store", clearValue: [1, 0, 0, 0] })),
        },
    });
    const motion = state.motionPipeline ? stage(state.motionPipeline, [uniform, state.sourceDepth, velocity!], [state.closestMotion!.createView()]) : null;
    const reductions: ReconstructionStage[] = [];
    for (let mip = 1; mip < state.convolution.mipLevelCount; mip++) {
        reductions.push(
            stage(
                state.reducePipeline,
                [state.convolution.createView({ baseMipLevel: mip - 1, mipLevelCount: 1 }), state.convolutionDepth.createView({ baseMipLevel: mip - 1, mipLevelCount: 1 })],
                [state.convolution.createView({ baseMipLevel: mip, mipLevelCount: 1 }), state.convolutionDepth.createView({ baseMipLevel: mip, mipLevelCount: 1 })]
            )
        );
    }
    const stages = (index: number): ReconstructionStage[] => {
        const next = 1 - index;
        const count = state.counts[next]!.createView();
        const shared = [uniform, state.sourceDepth, state.sourceNormal ?? o.dummyNormalView, count];
        const transportStage = state.transportPipeline
            ? stage(
                  state.transportExtension?.pipeline ?? state.transportPipeline,
                  [
                      uniform,
                      state.sourceDepth,
                      state.sourceNormal ?? o.dummyNormalView,
                      velocity!,
                      state.scratch.createView(),
                      state.history[index]!.createView(),
                      state.geometry.createView(),
                      { buffer: state.uniform },
                      ...(state.transportExtension?.resources ?? []),
                  ],
                  [state.transport!.createView()]
              )
            : null;
        if (transportStage) {
            transportStage.indirect = state.transportExtension?.indirect;
            for (const attachment of transportStage.pass.colorAttachments) {
                if (attachment) {
                    attachment.clearValue = [0, 0, 0, 0];
                }
            }
        }
        return [
            ...(motion ? [motion] : []),
            ...(transportStage ? [transportStage] : []),
            stage(
                state.temporalPipeline,
                [
                    uniform,
                    state.sourceDepth,
                    state.scratch.createView(),
                    state.closestMotion?.createView() ?? o.dummyNormalView,
                    state.history[index]!.createView(),
                    state.geometry.createView(),
                    state.counts[index]!.createView(),
                    { buffer: state.uniform },
                    state.transport?.createView() ?? o.dummyNormalView,
                    state.sourceNormal ?? o.dummyNormalView,
                    velocity ?? o.dummyNormalView,
                ],
                [state.convolution.createView({ baseMipLevel: 0, mipLevelCount: 1 }), count, state.convolutionDepth.createView({ baseMipLevel: 0, mipLevelCount: 1 })]
            ),
            ...reductions,
            stage(
                state.repairPipeline,
                [...shared, state.convolution.createView(), state.convolutionDepth.createView(), state.linearSampler, state.pointSampler],
                [state.repaired.createView()]
            ),
            stage(
                state.outputPipeline,
                [...shared, state.repaired.createView(), { buffer: state.uniform }],
                [state.history[next]!.createView(), o.visibility.createView(), state.geometry.createView()]
            ),
        ];
    };
    state.stages = [stages(0), stages(1)];
}

export function executeXegtaoTemporalGpu(state: XegtaoTemporalGpu, encoder: GPUCommandEncoder): void {
    state.owner.device.queue.writeBuffer(state.uniform, 0, state.data);
    state.transportExtension?.execute(encoder);
    for (const stage of state.stages[state.index]!) {
        const pass = encoder.beginRenderPass(stage.pass);
        pass.setPipeline(stage.pipeline);
        pass.setBindGroup(0, stage.group);
        if (stage.indirect) {
            pass.drawIndirect(stage.indirect, 0);
        } else {
            pass.draw(3);
        }
        pass.end();
    }
    state.index = 1 - state.index;
}

export function disposeXegtaoTemporalGpu(state: XegtaoTemporalGpu): void {
    if (state.disposed) {
        return;
    }
    state.disposed = true;
    if (state.owner.resolveGroup === state.scratchResolve) {
        state.owner.resolveGroup = state.baseResolve;
    }
    state.uniform.destroy();
    state.closestMotion?.destroy();
    state.transport?.destroy();
    state.transportExtension?.dispose();
    for (const texture of [state.scratch, state.convolution, state.convolutionDepth, state.repaired, ...state.history, ...state.counts, state.geometry]) {
        texture.destroy();
    }
}
