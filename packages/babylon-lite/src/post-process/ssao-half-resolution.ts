import { SS, TU } from "../engine/gpu-flags.js";
import type { SsaoTask } from "./ssao.js";
import { bindSsaoGpuSources, createSsaoGpu, disposeSsaoGpu, executeSsaoGpu, recordSsaoDepth, writeSsaoGpuParameters } from "./ssao-gpu.js";
import type { SsaoGpu } from "./ssao-gpu.js";
import { ssaoHalfUpsampleWGSL } from "./ssao-half-wgsl.js";

/** State for a half-resolution adapter; its enabler determines reconstruction resolution. */
export interface SsaoHalfResolutionSettings {
    enabled: boolean;
    readonly active: boolean;
}

/** @internal Sparse receiver estimation; borrowed geometry retains fine occluders. */
export interface HalfSsaoGpu {
    gpu: SsaoGpu;
    pipeline: GPUComputePipeline;
    group: GPUBindGroup | null;
    sourceDepth: GPUTextureView | null;
    sourceNormal: GPUTextureView | null;
    outputTarget: GPUTexture;
}

/** @internal Create sparse working buffers without decimating caster geometry. */
export function createHalfSsaoGpu(
    device: GPUDevice,
    width: number,
    height: number,
    kind: "depth" | "float",
    providedNormals: boolean,
    worldNormals: boolean,
    output?: GPUTexture,
    depthPyramid?: GPUTexture
): HalfSsaoGpu {
    const gpu = createSsaoGpu(device, width, height, kind, providedNormals, worldNormals, 2, depthPyramid);
    gpu.outputTexture =
        output ??
        device.createTexture({
            label: "ssao-half-full-output",
            size: [width, height],
            format: "rgba16float",
            usage: TU.STORAGE_BINDING | TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT | TU.COPY_SRC,
        });
    gpu.borrowedOutput = output !== undefined;
    const layout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: SS.COMPUTE, buffer: { type: "uniform" } },
            { binding: 1, visibility: SS.COMPUTE, texture: { sampleType: kind === "depth" ? "depth" : "unfilterable-float" } },
            { binding: 2, visibility: SS.COMPUTE, texture: { sampleType: "unfilterable-float" } },
            { binding: 3, visibility: SS.COMPUTE, texture: { sampleType: "unfilterable-float" } },
            { binding: 4, visibility: SS.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
        ],
    });
    const module = device.createShaderModule({ label: "ssao-half-upsample", code: ssaoHalfUpsampleWGSL(kind, !providedNormals) });
    const pipeline = device.createComputePipeline({
        label: "ssao-half-upsample",
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: "main", constants: { SOURCE_NORMALS: providedNormals ? 1 : 0, SOURCE_WORLD: worldNormals ? 1 : 0 } },
    });
    return { gpu, pipeline, group: null, sourceDepth: null, sourceNormal: null, outputTarget: gpu.outputTexture };
}

/** @internal Bind original geometry and a stable full-size resolve destination. */
export function bindHalfSsaoGpu(state: HalfSsaoGpu, depth: GPUTextureView, normal: GPUTextureView | null, output = state.outputTarget): boolean {
    if (state.group && state.sourceDepth === depth && state.sourceNormal === normal && state.outputTarget === output) {
        return false;
    }
    bindSsaoGpuSources(state.gpu, depth, normal);
    state.group = state.gpu.device.createBindGroup({
        layout: state.pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: state.gpu.uniform } },
            { binding: 1, resource: depth },
            { binding: 2, resource: normal ?? state.gpu.dummyNormalView },
            { binding: 3, resource: state.gpu.visibility.createView() },
            { binding: 4, resource: output.createView() },
        ],
    });
    state.sourceDepth = depth;
    state.sourceNormal = normal;
    state.outputTarget = output;
    return true;
}

/** @internal Reconstruct the sparse visibility signal without crossing surfaces. */
export function executeHalfSsaoGpu(state: HalfSsaoGpu, encoder: GPUCommandEncoder): void {
    if (!state.group) {
        throw new Error("Half-resolution SSAO has no bound source.");
    }
    const pass = encoder.beginComputePass({ label: "ssao-half-upsample" });
    pass.setPipeline(state.pipeline);
    pass.setBindGroup(0, state.group);
    pass.dispatchWorkgroups(Math.ceil(state.outputTarget.width / 8), Math.ceil(state.outputTarget.height / 8));
    pass.end();
}

let _states: WeakMap<SsaoTask, SsaoHalfResolutionSettings> | null = null;

/** Enable half-resolution estimation while preserving full-resolution temporal geometry. */
export function enableSsaoHalfResolution(task: SsaoTask): SsaoHalfResolutionSettings {
    if (task.outputTexture._disposed) {
        throw new Error("Cannot enable half-resolution rendering on a disposed SSAO task.");
    }
    const states = (_states ??= new WeakMap());
    const existing = states.get(task);
    if (existing) {
        return existing;
    }
    if (task._resolution) {
        throw new Error("An SSAO working-resolution adapter is already installed.");
    }
    const settings = { enabled: true, active: false };
    let owner: HalfSsaoGpu | null = null,
        enabled = false,
        parent: SsaoGpu | null = null;
    const discard = () => {
        if (owner) {
            disposeSsaoGpu(owner.gpu);
            owner = null;
        }
    };
    task._resolution = {
        prepare(gpu, device, width, height, depth, normal, worldNormals) {
            const active = settings.enabled && width >= 320 && height >= 224;
            settings.active = active;
            if (enabled !== active) {
                task._filter?.reset();
                enabled = active;
            }
            if (!gpu || gpu.device !== device || gpu.width !== width || gpu.height !== height) {
                discard();
                gpu = createSsaoGpu(device, width, height, "depth", normal !== null, worldNormals);
            }
            bindSsaoGpuSources(gpu, depth, normal, !enabled);
            gpu.samplingFootprint = enabled ? 1 : 0;
            if (!enabled) {
                discard();
                parent = gpu;
                return gpu;
            }
            if (!owner || parent !== gpu || owner.gpu.providedNormals !== gpu.providedNormals) {
                discard();
                owner = createHalfSsaoGpu(device, width, height, "depth", normal !== null, worldNormals, gpu.visibility, gpu.depth);
            }
            parent = gpu;
            if (bindHalfSsaoGpu(owner, depth, normal, owner.outputTarget)) {
                task._filter?.reset();
            }
            return gpu;
        },
        before(gpu, encoder, params) {
            if (!owner) {
                return false;
            }
            const depthPass = encoder.beginComputePass({ label: "ssao-full-depth" });
            recordSsaoDepth(gpu, depthPass);
            depthPass.end();
            bindHalfSsaoGpu(owner, gpu.sourceDepth!, gpu.sourceNormal, gpu.spatialTarget ?? gpu.visibility);
            writeSsaoGpuParameters(owner.gpu, params);
            executeSsaoGpu(owner.gpu, encoder, params.quality);
            executeHalfSsaoGpu(owner, encoder);
            return true;
        },
        dispose() {
            discard();
            states.delete(task);
        },
    };
    states.set(task, settings);
    return settings;
}
