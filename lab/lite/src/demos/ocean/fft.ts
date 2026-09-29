import {
    addComputeDispatch,
    computeStorageTextureViewBinding,
    computeTextureBinding,
    computeUniformBufferBinding,
    createComputeDispatch,
    getComputeUniformSlotOffset,
    setComputeDispatchDynamicOffset,
    type ComputeShader,
    type ComputeStorageTexture,
    type ComputeTask,
    type ComputeUniformArena,
} from "babylon-lite";
import { OCEAN_FFT_HORIZONTAL_WGSL, OCEAN_FFT_PERMUTE_WGSL, OCEAN_FFT_VERTICAL_WGSL } from "./shaders.js";
import type { OceanFieldPair } from "./resources.js";
import type { OceanComputeOwner } from "./ownership.js";

export interface OceanFftShaders {
    readonly horizontal: ComputeShader;
    readonly vertical: ComputeShader;
    readonly permute: ComputeShader;
}

export interface OceanFftStage {
    readonly axis: "horizontal" | "vertical";
    readonly step: number;
}

export function createOceanFftStageOrder(stageCount: number): OceanFftStage[] {
    if (!Number.isInteger(stageCount) || stageCount < 0) {
        throw new Error(`Ocean FFT stage count must be a non-negative integer, received ${stageCount}.`);
    }
    const stages: OceanFftStage[] = [];
    for (let step = 0; step < stageCount; step++) {
        stages.push({ axis: "horizontal", step });
    }
    for (let step = 0; step < stageCount; step++) {
        stages.push({ axis: "vertical", step });
    }
    return stages;
}

function sampled(resource: ComputeStorageTexture) {
    if (!resource.computeTexture) {
        throw new Error("Ocean FFT texture is not sampleable.");
    }
    return resource.computeTexture;
}

export function createOceanFftShaders(owner: OceanComputeOwner, fftUniformByteLength: number): OceanFftShaders {
    const commonBindings = [
        computeUniformBufferBinding("params", { group: 0, binding: 0, dynamicOffset: true, minBindingSize: fftUniformByteLength }),
        computeTextureBinding("twiddle", { group: 0, binding: 1, sampleType: "unfilterable-float" }),
        computeTextureBinding("inputTex", { group: 0, binding: 2, sampleType: "unfilterable-float" }),
        computeStorageTextureViewBinding("outputTex", { group: 0, binding: 3, format: "rg32float", access: "write-only", viewDimension: "2d" }),
    ];
    return {
        horizontal: owner.shader({ name: "ocean-fft-horizontal", computeSource: OCEAN_FFT_HORIZONTAL_WGSL, bindings: commonBindings }),
        vertical: owner.shader({ name: "ocean-fft-vertical", computeSource: OCEAN_FFT_VERTICAL_WGSL, bindings: commonBindings }),
        permute: owner.shader({
            name: "ocean-fft-permute",
            computeSource: OCEAN_FFT_PERMUTE_WGSL,
            bindings: [
                computeTextureBinding("inputTex", { group: 0, binding: 0, sampleType: "unfilterable-float" }),
                computeStorageTextureViewBinding("outputTex", { group: 0, binding: 1, format: "rg32float", access: "write-only", viewDimension: "2d" }),
            ],
        }),
    };
}

function appendStage(
    task: ComputeTask,
    shader: ComputeShader,
    paramsArena: ComputeUniformArena,
    step: number,
    twiddle: ComputeStorageTexture,
    input: ComputeStorageTexture,
    output: ComputeStorageTexture,
    groups: number,
    owner: OceanComputeOwner
): void {
    const bindings = owner.bindings(shader, {
        params: { buffer: paramsArena.buffer, size: paramsArena.slotByteLength },
        twiddle: sampled(twiddle),
        inputTex: sampled(input),
        outputTex: output,
    });
    const dispatch = createComputeDispatch(shader, bindings, { size: { x: groups, y: groups } });
    setComputeDispatchDynamicOffset(dispatch, "params", getComputeUniformSlotOffset(paramsArena, step));
    addComputeDispatch(task, dispatch);
}

export function appendOceanInverseFft(
    task: ComputeTask,
    shaders: OceanFftShaders,
    paramsArena: ComputeUniformArena,
    stageCount: number,
    twiddle: ComputeStorageTexture,
    field: OceanFieldPair,
    groups: number,
    owner: OceanComputeOwner
): void {
    let input = field.spectrum;
    let output = field.spatial;
    for (const stage of createOceanFftStageOrder(stageCount)) {
        appendStage(task, shaders[stage.axis], paramsArena, stage.step, twiddle, input, output, groups, owner);
        [input, output] = [output, input];
    }
    const permuteBindings = owner.bindings(shaders.permute, {
        inputTex: sampled(input),
        outputTex: field.spatial,
    });
    addComputeDispatch(task, createComputeDispatch(shaders.permute, permuteBindings, { size: { x: groups, y: groups } }));
}
