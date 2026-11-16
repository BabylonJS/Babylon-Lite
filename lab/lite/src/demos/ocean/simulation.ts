import {
    addComputeDispatch,
    armComputeOneShot,
    computeStorageBufferBinding,
    computeStorageTextureViewBinding,
    computeTextureBinding,
    computeUniformBufferBinding,
    createComputeDispatch,
    createComputeOneShot,
    createComputeUniformArena,
    createComputeUniformLayout,
    createComputeUniformWriter,
    getComputeUniformSlotOffset,
    readStorageBuffer,
    setComputeDispatchDynamicOffset,
    setComputeUniformF32,
    setComputeUniformI32,
    setComputeUniformU32,
    setComputeUniformVector,
    submitComputeTasks,
    updateStorageBuffer,
    waitForGpuIdle,
    type ComputeDispatch,
    type ComputeOneShot,
    type ComputeStorageTexture,
    type ComputeTask,
    type ComputeShader,
    type ComputeUniformWriter,
    type EngineContext,
    type StorageBuffer,
} from "babylon-lite";
import { appendOceanInverseFft, createOceanFftShaders } from "./fft.js";
import {
    OCEAN_BUOY_PROBE_WGSL,
    OCEAN_CLEAR_RGBA16_WGSL,
    OCEAN_CONJUGATE_SPECTRUM_WGSL,
    OCEAN_INITIAL_SPECTRUM_WGSL,
    OCEAN_MERGE_WGSL,
    OCEAN_TIME_SPECTRUM_WGSL,
    OCEAN_TWIDDLE_WGSL,
} from "./shaders.js";
import { OCEAN_LENGTH_SCALES, OCEAN_WORKGROUP_SIZE, oceanFftStageCount } from "./constants.js";
import { createOceanComputeResources, disposeOceanComputeResources, type OceanCascadeResources, type OceanComputeResources } from "./resources.js";
import {
    assertOceanScopeActive,
    createOceanComputeOwner,
    createOceanResourceScope,
    disposeOceanScope,
    ownOceanResource,
    rollbackOceanScope,
    type OceanComputeOwner,
} from "./ownership.js";
import { createOceanSpectrumBuffer, DEFAULT_OCEAN_SPECTRUM, type OceanSpectrumSettings } from "./spectrum.js";

const OCEAN_NOISE_URL = "https://assets.babylonjs.com/environments/noise.exr";
const OCEAN_NOISE_SIZE = 256;

export interface OceanSimulation {
    readonly initializationTask: ComputeTask;
    readonly spectrumTask: ComputeTask;
    readonly fftTask: ComputeTask;
    readonly mergeTask: ComputeTask;
    readonly initialization: ComputeOneShot;
    readonly resources: OceanComputeResources;
    readonly turbulenceIndex: 0 | 1;
    setExecutionEnabled(enabled: boolean): void;
    update(timeSeconds: number, deltaSeconds: number): void;
    setSpectrum(settings: OceanSpectrumSettings): Promise<void>;
    setChoppiness(value: number): void;
    setBuoyancyFrame(points: Float32Array): void;
    readBuoyancy(): Promise<Float32Array>;
    sampleBuoyancy(points: Float32Array): Promise<Float32Array>;
    warmup(timeSeconds: number, framesPerSecond?: number): Promise<number>;
    dispose(): void;
}

export function oceanTurbulenceOutputIndex(frame: number): 0 | 1 {
    return (frame & 1) === 0 ? 1 : 0;
}

interface MergeDispatchPair {
    readonly aToB: ComputeDispatch;
    readonly bToA: ComputeDispatch;
}

function sampled(resource: ComputeStorageTexture) {
    if (!resource.computeTexture) {
        throw new Error("Ocean compute texture is not sampleable.");
    }
    return resource.computeTexture;
}

function setDynamicSlot(dispatch: ComputeDispatch, arenaOffset: number): ComputeDispatch {
    setComputeDispatchDynamicOffset(dispatch, "params", arenaOffset);
    return dispatch;
}

function writeSpectrumUniforms(writer: ComputeUniformWriter, index: number, size: number, settings: OceanSpectrumSettings): void {
    const cutoffLow = index === 0 ? 0.0001 : (2 * Math.PI * 6) / OCEAN_LENGTH_SCALES[index]!;
    const cutoffHigh = index < OCEAN_LENGTH_SCALES.length - 1 ? (2 * Math.PI * 6) / OCEAN_LENGTH_SCALES[index + 1]! : 9999;
    setComputeUniformU32(writer, "size", size);
    setComputeUniformF32(writer, "lengthScale", OCEAN_LENGTH_SCALES[index]!);
    setComputeUniformF32(writer, "cutoffHigh", cutoffHigh);
    setComputeUniformF32(writer, "cutoffLow", cutoffLow);
    setComputeUniformF32(writer, "gravity", settings.gravity);
    setComputeUniformF32(writer, "depth", settings.depth);
}

async function loadOceanGaussianNoise(size: number): Promise<Float32Array> {
    if (size > OCEAN_NOISE_SIZE) {
        throw new Error(`Ocean noise supports resolutions up to ${OCEAN_NOISE_SIZE}, received ${size}.`);
    }
    const response = await fetch(OCEAN_NOISE_URL);
    if (!response.ok) {
        throw new Error(`Unable to load Ocean Gaussian noise: HTTP ${response.status}.`);
    }
    return decodeOceanGaussianNoise(new Uint8Array(await response.arrayBuffer()), size);
}

/** Decode the same linear source-texel prefix used by the Babylon.js reference at every selectable resolution. */
export function decodeOceanGaussianNoise(bytes: Uint8Array, size: number): Float32Array {
    if (!Number.isInteger(size) || size <= 0 || size > OCEAN_NOISE_SIZE) {
        throw new Error(`Ocean noise resolution must be an integer from 1 to ${OCEAN_NOISE_SIZE}, received ${size}.`);
    }
    const noise = new Float32Array(size * size * 2);
    const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pixelCount = size * size;
    let sourceOffset = 0x094b;
    let outputPixel = 0;
    for (let row = 0; row < OCEAN_NOISE_SIZE && outputPixel < pixelCount; row++) {
        sourceOffset += 8 + OCEAN_NOISE_SIZE * 8;
        const greenOffset = sourceOffset;
        const redOffset = greenOffset + OCEAN_NOISE_SIZE * 4;
        const count = Math.min(OCEAN_NOISE_SIZE, pixelCount - outputPixel);
        for (let column = 0; column < count; column++) {
            const target = (outputPixel + column) * 2;
            noise[target] = source.getFloat32(redOffset + column * 4, true);
            noise[target + 1] = source.getFloat32(greenOffset + column * 4, true);
        }
        sourceOffset = redOffset + OCEAN_NOISE_SIZE * 4;
        outputPixel += count;
    }
    if (outputPixel !== pixelCount) {
        throw new Error(`Ocean Gaussian noise contains ${outputPixel} pixels, expected ${pixelCount}.`);
    }
    return noise;
}

function configureInitialization(
    owner: OceanComputeOwner,
    task: ComputeTask,
    resources: OceanComputeResources,
    size: number,
    stageCount: number,
    settings: OceanSpectrumSettings,
    gaussianNoise: StorageBuffer
): {
    readonly spectrumWriters: readonly ComputeUniformWriter[];
    readonly spectra: StorageBuffer;
    readonly staticDispatches: readonly ComputeDispatch[];
} {
    const groups = Math.ceil(size / OCEAN_WORKGROUP_SIZE);
    const spectrumLayout = createComputeUniformLayout([
        { name: "size", type: "u32" },
        { name: "lengthScale", type: "f32" },
        { name: "cutoffHigh", type: "f32" },
        { name: "cutoffLow", type: "f32" },
        { name: "gravity", type: "f32" },
        { name: "depth", type: "f32" },
    ]);
    const spectrumArena = createComputeUniformArena(task, spectrumLayout.byteLength, resources.cascades.length, { label: "ocean-spectrum-params" });
    const spectrumWriters: ComputeUniformWriter[] = [];
    for (let index = 0; index < resources.cascades.length; index++) {
        const writer = createComputeUniformWriter(spectrumArena, index, spectrumLayout);
        writeSpectrumUniforms(writer, index, size, settings);
        spectrumWriters.push(writer);
    }
    const spectra = owner.buffer(createOceanSpectrumBuffer(settings), { label: "ocean-spectrum-settings", writable: true });
    const initialShader = owner.shader({
        name: "ocean-initial-spectrum",
        computeSource: OCEAN_INITIAL_SPECTRUM_WGSL,
        bindings: [
            computeStorageTextureViewBinding("wavesData", { group: 0, binding: 0, format: "rgba32float", access: "write-only", viewDimension: "2d" }),
            computeStorageTextureViewBinding("h0k", { group: 0, binding: 1, format: "rg32float", access: "write-only", viewDimension: "2d" }),
            computeUniformBufferBinding("params", { group: 0, binding: 2, dynamicOffset: true, minBindingSize: spectrumLayout.byteLength }),
            computeStorageBufferBinding("spectra", { group: 0, binding: 3 }),
            computeStorageBufferBinding("gaussianNoise", { group: 0, binding: 4 }),
        ],
    });
    const conjugateShader = owner.shader({
        name: "ocean-conjugate-spectrum",
        computeSource: OCEAN_CONJUGATE_SPECTRUM_WGSL,
        bindings: [
            computeStorageTextureViewBinding("h0", { group: 0, binding: 0, format: "rgba32float", access: "write-only", viewDimension: "2d" }),
            computeTextureBinding("h0k", { group: 0, binding: 1, sampleType: "unfilterable-float" }),
            computeUniformBufferBinding("params", { group: 0, binding: 2, dynamicOffset: true, minBindingSize: spectrumLayout.byteLength }),
        ],
    });
    for (let index = 0; index < resources.cascades.length; index++) {
        const cascade = resources.cascades[index]!;
        const offset = getComputeUniformSlotOffset(spectrumArena, index);
        const initialBindings = owner.bindings(initialShader, {
            wavesData: cascade.wavesData,
            h0k: cascade.h0k,
            params: { buffer: spectrumArena.buffer, size: spectrumLayout.byteLength },
            spectra,
            gaussianNoise,
        });
        addComputeDispatch(task, setDynamicSlot(createComputeDispatch(initialShader, initialBindings, { size: { x: groups, y: groups } }), offset));
        const conjugateBindings = owner.bindings(conjugateShader, {
            h0: cascade.h0,
            h0k: sampled(cascade.h0k),
            params: { buffer: spectrumArena.buffer, size: spectrumLayout.byteLength },
        });
        addComputeDispatch(task, setDynamicSlot(createComputeDispatch(conjugateShader, conjugateBindings, { size: { x: groups, y: groups } }), offset));
    }

    const twiddleLayout = createComputeUniformLayout([
        { name: "size", type: "i32" },
        { name: "stageCount", type: "i32" },
    ]);
    const twiddleArena = createComputeUniformArena(task, twiddleLayout.byteLength, 1, { label: "ocean-twiddle-params" });
    const twiddleWriter = createComputeUniformWriter(twiddleArena, 0, twiddleLayout);
    setComputeUniformI32(twiddleWriter, "size", size);
    setComputeUniformI32(twiddleWriter, "stageCount", stageCount);
    const twiddleShader = owner.shader({
        name: "ocean-twiddle",
        computeSource: OCEAN_TWIDDLE_WGSL,
        bindings: [
            computeStorageTextureViewBinding("outputTex", { group: 0, binding: 0, format: "rgba32float", access: "write-only", viewDimension: "2d" }),
            computeUniformBufferBinding("params", { group: 0, binding: 1, minBindingSize: twiddleLayout.byteLength }),
        ],
    });
    const staticDispatches: ComputeDispatch[] = [];
    const twiddleDispatch = createComputeDispatch(
        twiddleShader,
        owner.bindings(twiddleShader, {
            outputTex: resources.twiddle,
            params: { buffer: twiddleArena.buffer, size: twiddleLayout.byteLength },
        }),
        { size: { x: stageCount, y: Math.ceil(size / 2 / OCEAN_WORKGROUP_SIZE) } }
    );
    staticDispatches.push(twiddleDispatch);
    addComputeDispatch(task, twiddleDispatch);

    const clearShader = owner.shader({
        name: "ocean-clear-turbulence",
        computeSource: OCEAN_CLEAR_RGBA16_WGSL,
        bindings: [computeStorageTextureViewBinding("outputTex", { group: 0, binding: 0, format: "rgba16float", access: "write-only", viewDimension: "2d" })],
    });
    for (const cascade of resources.cascades) {
        for (const texture of [cascade.turbulenceA, cascade.turbulenceB]) {
            const clearDispatch = createComputeDispatch(clearShader, owner.bindings(clearShader, { outputTex: texture }), { size: { x: groups, y: groups } });
            staticDispatches.push(clearDispatch);
            addComputeDispatch(task, clearDispatch);
        }
    }
    return { spectrumWriters, spectra, staticDispatches };
}

function addTimeDispatch(
    task: ComputeTask,
    shader: ComputeShader,
    paramsWriter: ComputeUniformWriter,
    paramsByteLength: number,
    cascade: OceanCascadeResources,
    groups: number,
    owner: OceanComputeOwner
): void {
    const paramsBuffer = paramsWriter.arena.buffer;
    const bindings = owner.bindings(shader, {
        h0: sampled(cascade.h0),
        wavesData: sampled(cascade.wavesData),
        params: { buffer: paramsBuffer, size: paramsByteLength },
        dxDz: cascade.dxDz.spectrum,
        dyDxz: cascade.dyDxz.spectrum,
        dyxDyz: cascade.dyxDyz.spectrum,
        dxxDzz: cascade.dxxDzz.spectrum,
    });
    addComputeDispatch(task, createComputeDispatch(shader, bindings, { size: { x: groups, y: groups } }));
}

function createMergeDispatch(
    shader: ComputeShader,
    paramsWriter: ComputeUniformWriter,
    paramsByteLength: number,
    cascade: OceanCascadeResources,
    read: ComputeStorageTexture,
    write: ComputeStorageTexture,
    groups: number,
    owner: OceanComputeOwner
): ComputeDispatch {
    return createComputeDispatch(
        shader,
        owner.bindings(shader, {
            params: { buffer: paramsWriter.arena.buffer, size: paramsByteLength },
            displacement: cascade.displacement,
            derivatives: cascade.derivatives,
            turbulenceRead: sampled(read),
            turbulenceWrite: write,
            dxDz: sampled(cascade.dxDz.spatial),
            dyDxz: sampled(cascade.dyDxz.spatial),
            dyxDyz: sampled(cascade.dyxDyz.spatial),
            dxxDzz: sampled(cascade.dxxDzz.spatial),
        }),
        { size: { x: groups, y: groups } }
    );
}

function configureSimulation(
    owner: OceanComputeOwner,
    spectrumTask: ComputeTask,
    fftTask: ComputeTask,
    mergeTask: ComputeTask,
    resources: OceanComputeResources,
    size: number,
    stageCount: number,
    settings: OceanSpectrumSettings
): {
    readonly timeWriter: ComputeUniformWriter;
    readonly mergeWriter: ComputeUniformWriter;
    readonly mergePairs: readonly MergeDispatchPair[];
    readonly buoySamples: StorageBuffer;
    readonly buoyWriter: ComputeUniformWriter;
    readonly buoyPoints: Float32Array;
    readonly buoyViews: readonly [Float32Array, Float32Array, Float32Array];
} {
    const groups = Math.ceil(size / OCEAN_WORKGROUP_SIZE);
    const timeLayout = createComputeUniformLayout([{ name: "time", type: "f32" }]);
    const timeArena = createComputeUniformArena(spectrumTask, timeLayout.byteLength, 1, { label: "ocean-time-params" });
    const timeWriter = createComputeUniformWriter(timeArena, 0, timeLayout);
    setComputeUniformF32(timeWriter, "time", 0);
    const timeShader = owner.shader({
        name: "ocean-time-spectrum",
        computeSource: OCEAN_TIME_SPECTRUM_WGSL,
        bindings: [
            computeTextureBinding("h0", { group: 0, binding: 0, sampleType: "unfilterable-float" }),
            computeTextureBinding("wavesData", { group: 0, binding: 1, sampleType: "unfilterable-float" }),
            computeUniformBufferBinding("params", { group: 0, binding: 2, minBindingSize: timeLayout.byteLength }),
            computeStorageTextureViewBinding("dxDz", { group: 0, binding: 3, format: "rg32float", access: "write-only", viewDimension: "2d" }),
            computeStorageTextureViewBinding("dyDxz", { group: 0, binding: 4, format: "rg32float", access: "write-only", viewDimension: "2d" }),
            computeStorageTextureViewBinding("dyxDyz", { group: 0, binding: 5, format: "rg32float", access: "write-only", viewDimension: "2d" }),
            computeStorageTextureViewBinding("dxxDzz", { group: 0, binding: 6, format: "rg32float", access: "write-only", viewDimension: "2d" }),
        ],
    });
    for (const cascade of resources.cascades) {
        addTimeDispatch(spectrumTask, timeShader, timeWriter, timeLayout.byteLength, cascade, groups, owner);
    }

    const fftLayout = createComputeUniformLayout([
        { name: "step", type: "i32" },
        { name: "size", type: "i32" },
    ]);
    const fftArena = createComputeUniformArena(fftTask, fftLayout.byteLength, stageCount, { label: "ocean-fft-params" });
    for (let step = 0; step < stageCount; step++) {
        const writer = createComputeUniformWriter(fftArena, step, fftLayout);
        setComputeUniformI32(writer, "step", step);
        setComputeUniformI32(writer, "size", size);
    }
    const fftShaders = createOceanFftShaders(owner, fftLayout.byteLength);
    for (const cascade of resources.cascades) {
        appendOceanInverseFft(fftTask, fftShaders, fftArena, stageCount, resources.twiddle, cascade.dxDz, groups, owner);
        appendOceanInverseFft(fftTask, fftShaders, fftArena, stageCount, resources.twiddle, cascade.dyDxz, groups, owner);
        appendOceanInverseFft(fftTask, fftShaders, fftArena, stageCount, resources.twiddle, cascade.dyxDyz, groups, owner);
        appendOceanInverseFft(fftTask, fftShaders, fftArena, stageCount, resources.twiddle, cascade.dxxDzz, groups, owner);
    }

    const mergeLayout = createComputeUniformLayout([
        { name: "lambda", type: "f32" },
        { name: "deltaTime", type: "f32" },
    ]);
    const mergeArena = createComputeUniformArena(mergeTask, mergeLayout.byteLength, 1, { label: "ocean-merge-params" });
    const mergeWriter = createComputeUniformWriter(mergeArena, 0, mergeLayout);
    setComputeUniformF32(mergeWriter, "lambda", settings.lambda);
    setComputeUniformF32(mergeWriter, "deltaTime", 0);
    const mergeShader = owner.shader({
        name: "ocean-merge",
        computeSource: OCEAN_MERGE_WGSL,
        bindings: [
            computeUniformBufferBinding("params", { group: 0, binding: 0, minBindingSize: mergeLayout.byteLength }),
            computeStorageTextureViewBinding("displacement", { group: 0, binding: 1, format: "rgba16float", access: "write-only", viewDimension: "2d" }),
            computeStorageTextureViewBinding("derivatives", { group: 0, binding: 2, format: "rgba16float", access: "write-only", viewDimension: "2d" }),
            computeTextureBinding("turbulenceRead", { group: 0, binding: 3 }),
            computeStorageTextureViewBinding("turbulenceWrite", { group: 0, binding: 4, format: "rgba16float", access: "write-only", viewDimension: "2d" }),
            computeTextureBinding("dxDz", { group: 0, binding: 5, sampleType: "unfilterable-float" }),
            computeTextureBinding("dyDxz", { group: 0, binding: 6, sampleType: "unfilterable-float" }),
            computeTextureBinding("dyxDyz", { group: 0, binding: 7, sampleType: "unfilterable-float" }),
            computeTextureBinding("dxxDzz", { group: 0, binding: 8, sampleType: "unfilterable-float" }),
        ],
    });
    const mergePairs = resources.cascades.map((cascade) => {
        const aToB = createMergeDispatch(mergeShader, mergeWriter, mergeLayout.byteLength, cascade, cascade.turbulenceA, cascade.turbulenceB, groups, owner);
        const bToA = createMergeDispatch(mergeShader, mergeWriter, mergeLayout.byteLength, cascade, cascade.turbulenceB, cascade.turbulenceA, groups, owner);
        aToB.enabled = true;
        bToA.enabled = false;
        addComputeDispatch(mergeTask, aToB);
        addComputeDispatch(mergeTask, bToA);
        return { aToB, bToA };
    });
    const buoySamples = owner.buffer(3 * 4 * 4, { label: "ocean-buoy-samples", writable: true });
    const buoyLayout = createComputeUniformLayout([
        { name: "p0", type: "vec4<f32>" },
        { name: "p1", type: "vec4<f32>" },
        { name: "p2", type: "vec4<f32>" },
    ]);
    const buoyArena = createComputeUniformArena(mergeTask, buoyLayout.byteLength, 1, { label: "ocean-buoy-probe-params" });
    const buoyWriter = createComputeUniformWriter(buoyArena, 0, buoyLayout);
    const buoyPoints = new Float32Array(12);
    const buoyViews = [new Float32Array(buoyPoints.buffer, 0, 4), new Float32Array(buoyPoints.buffer, 16, 4), new Float32Array(buoyPoints.buffer, 32, 4)] as const;
    const probeShader = owner.shader({
        name: "ocean-buoy-probe",
        computeSource: OCEAN_BUOY_PROBE_WGSL,
        bindings: [
            computeTextureBinding("displacement", { group: 0, binding: 0 }),
            computeStorageBufferBinding("samples", { group: 0, binding: 1, access: "read-write" }),
            computeUniformBufferBinding("params", { group: 0, binding: 2, minBindingSize: buoyLayout.byteLength }),
        ],
    });
    addComputeDispatch(
        mergeTask,
        createComputeDispatch(
            probeShader,
            owner.bindings(probeShader, {
                displacement: sampled(resources.cascades[0].displacement),
                samples: buoySamples,
                params: { buffer: buoyArena.buffer, size: buoyLayout.byteLength },
            }),
            { size: { x: 1 } }
        )
    );
    return { timeWriter, mergeWriter, mergePairs, buoySamples, buoyWriter, buoyPoints, buoyViews };
}

export async function createOceanSimulation(engine: EngineContext, size: number, settings: OceanSpectrumSettings = DEFAULT_OCEAN_SPECTRUM): Promise<OceanSimulation> {
    const stageCount = oceanFftStageCount(size);
    const noise = await loadOceanGaussianNoise(size);
    const scope = createOceanResourceScope();
    const owner = createOceanComputeOwner(engine, scope);
    try {
        const resources = ownOceanResource(scope, await createOceanComputeResources(engine, size, stageCount), disposeOceanComputeResources);
        const gaussianNoise = owner.buffer(noise, { label: "ocean-gaussian-noise" });
        const initializationTask = owner.task("ocean-initialize");
        const { spectrumWriters, spectra, staticDispatches } = configureInitialization(owner, initializationTask, resources, size, stageCount, settings, gaussianNoise);
        const initialization = createComputeOneShot(initializationTask);
        const spectrumTask = owner.task("ocean-spectrum");
        const fftTask = owner.task("ocean-fft");
        const mergeTask = owner.task("ocean-merge");
        const { timeWriter, mergeWriter, mergePairs, buoySamples, buoyWriter, buoyPoints, buoyViews } = configureSimulation(
            owner,
            spectrumTask,
            fftTask,
            mergeTask,
            resources,
            size,
            stageCount,
            settings
        );
        await owner.prepare();
        for (const task of [initializationTask, spectrumTask, fftTask, mergeTask]) {
            task.record();
        }
        let frame = 0;
        const simulation = {
            initializationTask,
            spectrumTask,
            fftTask,
            mergeTask,
            initialization,
            resources,
            turbulenceIndex: 1 as 0 | 1,
            setExecutionEnabled(enabled: boolean): void {
                assertOceanScopeActive(scope);
                spectrumTask.executionEnabled = enabled;
                fftTask.executionEnabled = enabled;
                mergeTask.executionEnabled = enabled;
            },
            update(timeSeconds: number, deltaSeconds: number): void {
                assertOceanScopeActive(scope);
                setComputeUniformF32(timeWriter, "time", timeSeconds);
                setComputeUniformF32(mergeWriter, "deltaTime", Math.min(Math.max(deltaSeconds, 0), 0.5));
                if (mergeTask.executionEnabled === false) {
                    return;
                }
                const outputIndex = oceanTurbulenceOutputIndex(frame++);
                const aToB = outputIndex === 1;
                for (const pair of mergePairs) {
                    pair.aToB.enabled = aToB;
                    pair.bToA.enabled = !aToB;
                }
                simulation.turbulenceIndex = outputIndex;
            },
            async setSpectrum(nextSettings: OceanSpectrumSettings): Promise<void> {
                assertOceanScopeActive(scope);
                updateStorageBuffer(engine, spectra, createOceanSpectrumBuffer(nextSettings));
                for (let index = 0; index < spectrumWriters.length; index++) {
                    writeSpectrumUniforms(spectrumWriters[index]!, index, size, nextSettings);
                }
                setComputeUniformF32(mergeWriter, "lambda", nextSettings.lambda);
                await armComputeOneShot(initialization);
                assertOceanScopeActive(scope);
            },
            setChoppiness(value: number): void {
                assertOceanScopeActive(scope);
                setComputeUniformF32(mergeWriter, "lambda", value);
            },
            setBuoyancyFrame(points: Float32Array): void {
                assertOceanScopeActive(scope);
                if (points.length !== buoyPoints.length) {
                    throw new Error(`Ocean buoyancy frame requires ${buoyPoints.length} floats.`);
                }
                buoyPoints.set(points);
                setComputeUniformVector(buoyWriter, "p0", buoyViews[0]);
                setComputeUniformVector(buoyWriter, "p1", buoyViews[1]);
                setComputeUniformVector(buoyWriter, "p2", buoyViews[2]);
            },
            async readBuoyancy(): Promise<Float32Array> {
                assertOceanScopeActive(scope);
                // The caller runs in onBeforeRender; let the synchronous frame submit first.
                await Promise.resolve();
                assertOceanScopeActive(scope);
                const samples = await readStorageBuffer(buoySamples);
                assertOceanScopeActive(scope);
                return new Float32Array(samples);
            },
            async sampleBuoyancy(points: Float32Array): Promise<Float32Array> {
                simulation.setBuoyancyFrame(points);
                const taskEnabled = mergeTask.executionEnabled;
                const enabledStates = mergePairs.map((pair) => [pair.aToB.enabled, pair.bToA.enabled] as const);
                mergeTask.executionEnabled = true;
                for (const pair of mergePairs) {
                    pair.aToB.enabled = false;
                    pair.bToA.enabled = false;
                }
                try {
                    submitComputeTasks([mergeTask]);
                    const samples = await readStorageBuffer(buoySamples);
                    assertOceanScopeActive(scope);
                    return new Float32Array(samples);
                } finally {
                    if (!scope.disposed) {
                        mergeTask.executionEnabled = taskEnabled;
                        for (let index = 0; index < mergePairs.length; index++) {
                            mergePairs[index]!.aToB.enabled = enabledStates[index]![0];
                            mergePairs[index]!.bToA.enabled = enabledStates[index]![1];
                        }
                    }
                }
            },
            async warmup(timeSeconds: number, framesPerSecond = 60): Promise<number> {
                assertOceanScopeActive(scope);
                if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || !Number.isFinite(framesPerSecond) || framesPerSecond <= 0) {
                    throw new Error(`Ocean warmup requires non-negative time and positive frame rate, received ${timeSeconds} at ${framesPerSecond} Hz.`);
                }
                submitComputeTasks([initializationTask]);
                await initialization.completion;
                assertOceanScopeActive(scope);
                const exactFrameCount = Math.ceil(timeSeconds * framesPerSecond);
                const minimumCappedFrameCount = Math.ceil(timeSeconds / 0.5);
                const frameCount = Math.max(2, Math.min(exactFrameCount, Math.max(Math.ceil(framesPerSecond * 12), minimumCappedFrameCount)));
                const deltaSeconds = timeSeconds / frameCount;
                simulation.setExecutionEnabled(true);
                for (let frameIndex = 1; frameIndex <= frameCount; frameIndex++) {
                    simulation.update(frameIndex * deltaSeconds, deltaSeconds);
                    submitComputeTasks([spectrumTask, fftTask, mergeTask]);
                    if ((frameIndex & 15) === 0) {
                        await waitForGpuIdle(engine);
                        assertOceanScopeActive(scope);
                    }
                }
                await waitForGpuIdle(engine);
                assertOceanScopeActive(scope);
                simulation.setExecutionEnabled(false);
                return frameCount;
            },
            dispose(): void {
                disposeOceanScope(scope);
            },
        } satisfies OceanSimulation;
        void initialization.completion.then(
            () => {
                if (!scope.disposed) {
                    for (const dispatch of staticDispatches) {
                        dispatch.enabled = false;
                    }
                }
            },
            (error: unknown) => {
                if (!scope.disposed) {
                    console.error("Ocean compute initialization failed.", error);
                }
            }
        );
        return simulation;
    } catch (error) {
        rollbackOceanScope(scope, error);
    }
}
