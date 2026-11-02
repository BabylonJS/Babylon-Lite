import { BU, SS, TU } from "../engine/gpu-flags.js";
import { wgsl } from "../shader/wgsl.js";
import type { SsaoTask } from "./ssao.js";
import { bindSsaoGpuSources, createSsaoGpu, executeSsaoGpu, writeSsaoGpuParameters } from "./ssao-gpu.js";
import type { SsaoGpu } from "./ssao-gpu.js";
import type { SsaoHalfResolutionSettings } from "./ssao-half-resolution.js";
import { ssaoHalfPipelineUpsampleWGSL } from "./ssao-half-wgsl.js";
import { getSsaoTemporalEntry } from "./ssao-temporal.js";
import { SSAO_PARAMS_WGSL, ssaoDepthBindingWGSL, ssaoDepthNormalWGSL } from "./ssao-wgsl.js";

interface HalfPipeline {
    gpu: SsaoGpu;
    width: number;
    height: number;
    /** Supplied normal format, or null when normals are reconstructed once from full-size depth. */
    sourceNormalFormat: GPUTextureFormat | null;
    velocityFormat: GPUTextureFormat | null;
    normal: GPUTexture;
    velocity: GPUTexture | null;
    depth: GPUTexture;
    parameters: Pick<SsaoGpu, "device" | "width" | "height" | "uniform" | "data" | "integers">;
    prepare: GPUComputePipeline;
    prepareLayout: GPUBindGroupLayout;
    prepareGroup: GPUBindGroup | null;
    upsample: GPUComputePipeline;
    upsampleLayout: GPUBindGroupLayout;
    upsampleGroup: GPUBindGroup | null;
    sourceDepth: GPUTextureView | null;
    sourceNormal: GPUTextureView | null;
    sourceVelocity: GPUTextureView | null;
}

function createPipeline(
    device: GPUDevice,
    width: number,
    height: number,
    sourceNormalFormat: GPUTextureFormat | null,
    velocityFormat: GPUTextureFormat | null,
    worldNormals: boolean
): HalfPipeline {
    const smallWidth = Math.ceil(width / 2);
    const smallHeight = Math.ceil(height / 2);
    const normals = sourceNormalFormat !== null;
    const velocity = velocityFormat !== null;
    // Reconstructed normals are always view-space; copied normals keep the source space.
    const gpu = createSsaoGpu(device, smallWidth, smallHeight, "float", true, normals && worldNormals);
    gpu.samplingFootprint = 1;
    gpu.depthPrepared = true;
    const texture = (label: string, format: GPUTextureFormat, w = smallWidth, h = smallHeight) =>
        device.createTexture({ label, size: [w, h], format, usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING | TU.COPY_SRC | (format === "rgba16float" ? TU.RENDER_ATTACHMENT : 0) });
    gpu.outputTexture = texture("ssao-half-pipeline-output", "rgba16float", width, height);
    const depth = texture("ssao-half-pipeline-depth", "r32float");
    // Copying an RGBA16F producer into RGBA16F is exact; wider sources keep their format.
    const normalFormat: GPUTextureFormat = sourceNormalFormat === "rgba32float" ? "rgba32float" : "rgba16float";
    const normal = texture("ssao-half-pipeline-normal", normalFormat);
    // RG/RGBA16F velocity copies exactly into RGBA16F; 32-bit sources keep full precision.
    const motionFormat: GPUTextureFormat = velocityFormat === "rgba16float" || velocityFormat === "rg16float" ? "rgba16float" : "rgba32float";
    const motion = velocity ? texture("ssao-half-pipeline-velocity", motionFormat) : null;
    const uniform = device.createBuffer({ label: "ssao-half-pipeline-full-params", size: 176, usage: BU.UNIFORM | BU.COPY_DST });
    const data = new Float32Array(44);
    const sampled = (binding: number, sampleType: GPUTextureSampleType): GPUBindGroupLayoutEntry => ({ binding, visibility: SS.COMPUTE, texture: { sampleType } });
    const storage = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({
        binding,
        visibility: SS.COMPUTE,
        storageTexture: { access: "write-only", format },
    });
    const entries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: SS.COMPUTE, buffer: { type: "uniform" } },
        sampled(1, "depth"),
        storage(4, "r32float"),
        storage(5, normalFormat),
        storage(7, "r32float"),
    ];
    if (normals) {
        entries.push(sampled(2, "unfilterable-float"));
    }
    if (motion) {
        entries.push(sampled(3, "unfilterable-float"), storage(6, motionFormat));
    }
    const prepareLayout = device.createBindGroupLayout({ entries });
    // One pass samples every reduced input from the same full-size pixel and writes linear
    // depth mip 0, so the reduced owner skips its own linearizing copy.
    const code = wgsl`${SSAO_PARAMS_WGSL}
${ssaoDepthBindingWGSL("depth", 1)}
@group(0) @binding(4) var outDepth:texture_storage_2d<r32float,write>;
@group(0) @binding(5) var outNormal:texture_storage_2d<${normalFormat},write>;
@group(0) @binding(7) var outLinear:texture_storage_2d<r32float,write>;
${normals ? wgsl`@group(0) @binding(2) var normalInput:texture_2d<f32>;` : ssaoDepthNormalWGSL()}
${velocity ? wgsl`@group(0) @binding(3) var velocity:texture_2d<f32>;@group(0) @binding(6) var outVelocity:texture_storage_2d<${motionFormat},write>;` : wgsl``}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=(ao.size+1u)/2u)){return;}
let p=vec2i(min(id.xy*2u+1u,ao.size-1u));let q=vec2i(id.xy);
let d=aoRawDepth(p);
textureStore(outDepth,q,vec4f(d,0,0,0));
textureStore(outLinear,q,vec4f(clamp(ao.depthUnpack.x/(ao.depthUnpack.y-d),0.0,65504.0),0,0,0));
${normals ? wgsl`textureStore(outNormal,q,textureLoad(normalInput,p,0));` : wgsl`var n=vec3f(0,0,-1);if(d!=0.0){n=aoDepthNormal(p);}textureStore(outNormal,q,vec4f(n,0));`}
${velocity ? wgsl`textureStore(outVelocity,q,textureLoad(velocity,p,0));` : wgsl``}
}`;
    const prepare = device.createComputePipeline({
        label: "ssao-half-pipeline-prepare",
        layout: device.createPipelineLayout({ bindGroupLayouts: [prepareLayout] }),
        compute: { module: device.createShaderModule({ label: "ssao-half-pipeline-prepare", code }), entryPoint: "main" },
    });
    const upsampleLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: SS.COMPUTE, buffer: { type: "uniform" } },
            sampled(1, "depth"),
            sampled(2, "unfilterable-float"),
            sampled(3, "unfilterable-float"),
            storage(4, "rgba16float"),
            sampled(5, "unfilterable-float"),
            sampled(6, "unfilterable-float"),
        ],
    });
    const upsample = device.createComputePipeline({
        label: "ssao-half-pipeline-upsample",
        layout: device.createPipelineLayout({ bindGroupLayouts: [upsampleLayout] }),
        compute: {
            module: device.createShaderModule({ label: "ssao-half-pipeline-upsample", code: ssaoHalfPipelineUpsampleWGSL(normals) }),
            entryPoint: "main",
            constants: { SOURCE_WORLD: Number(normals && worldNormals) },
        },
    });
    bindSsaoGpuSources(gpu, depth.createView(), normal.createView());
    gpu.sourceVelocity = motion?.createView();
    return {
        gpu,
        width,
        height,
        sourceNormalFormat,
        velocityFormat,
        normal,
        velocity: motion,
        depth,
        parameters: { device, width, height, uniform, data, integers: new Uint32Array(data.buffer) },
        prepare,
        prepareLayout,
        prepareGroup: null,
        upsample,
        upsampleLayout,
        upsampleGroup: null,
        sourceDepth: null,
        sourceNormal: null,
        sourceVelocity: null,
    };
}

function bindPipeline(state: HalfPipeline, depth: GPUTextureView, normal: GPUTextureView | null, velocity: GPUTextureView | null): boolean {
    if (state.sourceDepth === depth && state.sourceNormal === normal && state.sourceVelocity === velocity) {
        return false;
    }
    const uniform = { buffer: state.parameters.uniform };
    const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: uniform },
        { binding: 1, resource: depth },
        { binding: 4, resource: state.depth.createView() },
        { binding: 5, resource: state.normal.createView() },
        { binding: 7, resource: state.gpu.depth.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
    ];
    if (state.sourceNormalFormat) {
        entries.push({ binding: 2, resource: normal! });
    }
    if (state.velocity) {
        entries.push({ binding: 3, resource: velocity! }, { binding: 6, resource: state.velocity.createView() });
    }
    const device = state.gpu.device;
    state.prepareGroup = device.createBindGroup({ layout: state.prepareLayout, entries });
    state.upsampleGroup = device.createBindGroup({
        layout: state.upsampleLayout,
        entries: [
            { binding: 0, resource: uniform },
            { binding: 1, resource: depth },
            { binding: 2, resource: normal ?? state.gpu.dummyNormalView },
            { binding: 3, resource: state.gpu.visibility.createView() },
            { binding: 4, resource: state.gpu.outputTexture!.createView() },
            { binding: 5, resource: state.depth.createView() },
            { binding: 6, resource: state.normal.createView() },
        ],
    });
    state.sourceDepth = depth;
    state.sourceNormal = normal;
    state.sourceVelocity = velocity;
    return true;
}

let _states: WeakMap<SsaoTask, SsaoHalfResolutionSettings> | null = null;

/** Opt into reduced geometry, estimation and temporal reconstruction, followed by full-size edge-aware output. */
export function enableSsaoHalfPipeline(task: SsaoTask): SsaoHalfResolutionSettings {
    if (task.outputTexture._disposed) {
        throw new Error("Cannot enable a half pipeline on a disposed SSAO task.");
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
    let state: HalfPipeline | null = null;
    let active = false;
    const discard = () => {
        if (!state) {
            return;
        }
        state.depth.destroy();
        state.normal.destroy();
        state.velocity?.destroy();
        state.parameters.uniform.destroy();
        state = null;
    };
    task._resolution = {
        prepare(gpu, device, width, height, depth, normal, worldNormals) {
            settings.active = settings.enabled && width >= 320 && height >= 224;
            if (active !== settings.active) {
                task._filter?.reset();
                active = settings.active;
            }
            if (!active) {
                discard();
                if (!gpu || gpu.kind !== "depth" || gpu.device !== device || gpu.width !== width || gpu.height !== height) {
                    gpu = createSsaoGpu(device, width, height, "depth", normal !== null, worldNormals);
                }
                bindSsaoGpuSources(gpu, depth, normal);
                return gpu;
            }
            const velocity = getSsaoTemporalEntry(task)?.velocity;
            if (velocity && (!velocity._colorView || velocity._width !== width || velocity._height !== height)) {
                throw new Error("Half-pipeline SSAO velocity and source depth must have identical built dimensions.");
            }
            const normalFormat = normal ? (task.normalTexture?._descriptor.format ?? "rgba16float") : null;
            const velocityFormat = velocity ? (velocity._descriptor.format ?? "rgba16float") : null;
            if (
                !state ||
                state.gpu.device !== device ||
                state.width !== width ||
                state.height !== height ||
                state.sourceNormalFormat !== normalFormat ||
                state.velocityFormat !== velocityFormat
            ) {
                discard();
                state = createPipeline(device, width, height, normalFormat, velocityFormat, worldNormals);
                task._filter?.reset();
            }
            if (bindPipeline(state, depth, normal, velocity?._colorView ?? null)) {
                task._filter?.reset();
            }
            return state.gpu;
        },
        before(gpu, encoder, params) {
            if (!state) {
                return false;
            }
            const pass = encoder.beginComputePass({ label: "ssao-half-pipeline-prepare" });
            pass.setPipeline(state.prepare);
            pass.setBindGroup(0, state.prepareGroup!);
            pass.dispatchWorkgroups(Math.ceil(gpu.width / 8), Math.ceil(gpu.height / 8));
            pass.end();
            writeSsaoGpuParameters(state.parameters, params);
            executeSsaoGpu(gpu, encoder, params.quality);
            return true;
        },
        after(_gpu, encoder) {
            if (!state) {
                return;
            }
            const pass = encoder.beginComputePass({ label: "ssao-half-pipeline-upsample" });
            pass.setPipeline(state.upsample);
            pass.setBindGroup(0, state.upsampleGroup!);
            pass.dispatchWorkgroups(Math.ceil(state.width / 8), Math.ceil(state.height / 8));
            pass.end();
        },
        dispose() {
            discard();
            states.delete(task);
        },
    };
    states.set(task, settings);
    return settings;
}
