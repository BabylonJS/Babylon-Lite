import { BU, SS } from "../engine/gpu-flags.js";
import { wgsl } from "../shader/wgsl.js";
import type { SsaoTask } from "./ssao.js";
import type { DiligentTemporalGpu, DiligentTransportExtension } from "./ssao-diligent-gpu.js";
import { diligentTransportWGSL } from "./ssao-diligent-wgsl.js";
import { ssaoMotionMaskCellCount, ssaoMotionMaskQueryWGSL, ssaoMotionMaskWGSL } from "./ssao-motion-mask-wgsl.js";
import { getSsaoTemporalEntry } from "./ssao-temporal.js";

/** Scene-dependent work pruning; disabling retains the original transport search. */
export interface SsaoMotionPruningSettings {
    enabled: boolean;
}

interface MaskStage {
    pipeline: GPUComputePipeline;
    group: GPUBindGroup;
    width: number;
    height: number;
}

/** @internal Optional resources; temporal history remains owned by the unmodified resolver. */
export interface SsaoMotionPruningGpu extends DiligentTransportExtension {
    /** Every tile-bounds level, cleared and filled by one dispatch per frame. */
    motionCells: GPUBuffer;
    stages: MaskStage[];
    bind(state: DiligentTemporalGpu, velocity: GPUTextureView | null): void;
}

/** @internal Create the masked transport variant without replacing temporal history. */
export function createSsaoMotionPruningGpu(state: DiligentTemporalGpu, velocity = state.velocity): SsaoMotionPruningGpu {
    if (!state.transport || !velocity) {
        throw new Error("SSAO motion pruning requires temporal occlusion-history transport with object velocity.");
    }
    const o = state.owner;
    const device = o.device;
    const width = Math.ceil(o.width / 8),
        height = Math.ceil(o.height / 8);
    const motionCells = device.createBuffer({
        label: "ssao-object-motion-mask",
        size: ssaoMotionMaskCellCount(o.width, o.height) * 16,
        usage: BU.STORAGE | BU.COPY_DST,
    });
    const indirect = device.createBuffer({ label: "ssao-transport-draw", size: 16, usage: BU.STORAGE | BU.INDIRECT | BU.COPY_SRC | BU.COPY_DST });
    const maskPipeline = device.createComputePipeline({
        label: "ssao-object-motion-mask",
        layout: "auto",
        compute: { module: device.createShaderModule({ label: "ssao-object-motion-mask", code: ssaoMotionMaskWGSL(o.kind) }), entryPoint: "main" },
    });
    const module = device.createShaderModule({
        label: "ssao-occlusion-history-transport-pruned",
        code: diligentTransportWGSL(o.kind, ssaoMotionMaskQueryWGSL(), wgsl`if(!movingCaster(pixel.xy,projected)){return vec4f(0);}`),
    });
    const layout = device.createBindGroupLayout({
        entries: Array.from({ length: 9 }, (_, binding): GPUBindGroupLayoutEntry => {
            if (binding === 0 || binding === 7) {
                return { binding, visibility: SS.FRAGMENT, buffer: { type: "uniform" } };
            }
            if (binding === 8) {
                return { binding, visibility: SS.FRAGMENT, buffer: { type: "read-only-storage" } };
            }
            const sampleType = binding === 5 ? "float" : binding === 6 ? "uint" : binding === 1 && o.kind === "depth" ? "depth" : "unfilterable-float";
            return { binding, visibility: SS.FRAGMENT, texture: { sampleType } };
        }),
    });
    const pipeline = device.createRenderPipeline({
        label: "ssao-occlusion-history-transport",
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: "fullscreen" },
        fragment: {
            module,
            entryPoint: "main",
            targets: [{ format: "rgba32float" }],
            constants: { PROVIDED_NORMALS: o.providedNormals ? 1 : 0, WORLD_NORMALS: o.worldNormals ? 1 : 0 },
        },
        primitive: { topology: "triangle-list" },
    });
    let sourceDepth: GPUTextureView | null = null;
    let sourceVelocity: GPUTextureView | null = null;
    let disposed = false;
    const pruning: SsaoMotionPruningGpu = {
        pipeline,
        resources: [{ buffer: motionCells }],
        indirect,
        motionCells,
        stages: [],
        bind(current, currentVelocity) {
            const depth = current.owner.sourceDepth!;
            if (sourceDepth === depth && sourceVelocity === currentVelocity) {
                return;
            }
            sourceDepth = depth;
            sourceVelocity = currentVelocity;
            pruning.stages[0] = {
                pipeline: maskPipeline,
                group: device.createBindGroup({
                    layout: maskPipeline.getBindGroupLayout(0),
                    entries: [{ buffer: o.uniform }, depth, currentVelocity!, { buffer: state.uniform }, { buffer: motionCells }, { buffer: indirect }].map(
                        (resource, binding) => ({ binding, resource })
                    ),
                }),
                width,
                height,
            };
        },
        execute(encoder) {
            // Zero is the empty rectangle and the zero-vertex draw; moving tiles only grow them.
            encoder.clearBuffer(motionCells);
            encoder.clearBuffer(indirect);
            const pass = encoder.beginComputePass({ label: "ssao-object-motion-mask" });
            for (const stage of pruning.stages) {
                pass.setPipeline(stage.pipeline);
                pass.setBindGroup(0, stage.group);
                pass.dispatchWorkgroups(stage.width, stage.height);
            }
            pass.end();
        },
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            motionCells.destroy();
            indirect.destroy();
        },
    };
    pruning.bind(state, velocity);
    return pruning;
}

let _states: WeakMap<SsaoTask, SsaoMotionPruningSettings> | null = null;

/** Opt into motion-mask pruning after temporal AO with object velocity has been enabled. */
export function enableSsaoMotionPruning(task: SsaoTask): SsaoMotionPruningSettings {
    if (task.outputTexture._disposed) {
        throw new Error("Cannot enable motion pruning on a disposed SSAO task.");
    }
    const entry = getSsaoTemporalEntry(task);
    if (!entry?.velocity) {
        throw new Error("SSAO motion pruning requires enableSsaoTemporal with object velocity first.");
    }
    const states = (_states ??= new WeakMap());
    const existing = states.get(task);
    if (existing) {
        return existing;
    }
    if (entry.settings._prepareGpu) {
        throw new Error("An SSAO temporal GPU extension is already installed.");
    }
    const settings: SsaoMotionPruningSettings = { enabled: true };
    let owner: DiligentTemporalGpu | null = null;
    let pruning: SsaoMotionPruningGpu | null = null;
    entry.settings._prepareGpu = (current, velocity) => {
        if (owner !== current) {
            owner = current;
            pruning = null;
        }
        if (!settings.enabled || !entry.settings.enabled) {
            if (pruning) {
                pruning.dispose();
                current.transportExtension = undefined;
                pruning = null;
            }
            return;
        }
        if (!pruning) {
            pruning = createSsaoMotionPruningGpu(current, velocity);
            current.transportExtension = pruning;
        } else {
            pruning.bind(current, velocity);
        }
    };
    states.set(task, settings);
    return settings;
}
