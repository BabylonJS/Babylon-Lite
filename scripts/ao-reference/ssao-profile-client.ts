import { renderFrame } from "../../packages/babylon-lite/src/engine/engine.js";
import type { EngineContext } from "../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTarget } from "../../packages/babylon-lite/src/engine/render-target.js";
import type { ArcRotateCamera } from "../../packages/babylon-lite/src/camera/arc-rotate.js";
import type { SsaoTask } from "../../packages/babylon-lite/src/post-process/ssao.js";
import type { DiligentTemporalGpu } from "../../packages/babylon-lite/src/post-process/ssao-diligent-gpu.js";
import { resetSsaoTemporal } from "../../packages/babylon-lite/src/post-process/ssao-temporal.js";
import type { SsaoTemporalSettings } from "../../packages/babylon-lite/src/post-process/ssao-temporal.js";
import { decodeSsaoPassTimes, ssaoPruningBlocks, ssaoTextureBytes, summarizeSsaoSamples, verifySsaoPruningFrames } from "./ssao-profile-contract.js";
import type { SsaoFrameDigest, SsaoProfileOptions } from "./ssao-profile-contract.js";

const PASSES_PER_FRAME = 32;
const BATCH_FRAMES = 8;

/** Installed before scene allocation, only in the isolated diagnostic page. */
export function observeSsaoProfile(engine: EngineContext) {
    const device = engine._device;
    if (!device.features.has("timestamp-query")) {
        throw new Error("SSAO pass diagnostics require native GPU timestamp queries; no CPU/software fallback.");
    }
    if (!device.adapterInfo || device.adapterInfo.isFallbackAdapter) {
        throw new Error("SSAO pass diagnostics require an identified non-fallback GPU adapter.");
    }
    const textures = new Map<GPUTexture, GPUTexture["destroy"]>();
    const pipelines = new Map<GPUComputePipeline, string>();
    const createTexture = device.createTexture;
    const createComputePipeline = device.createComputePipeline;
    device.createTexture = (descriptor) => {
        const texture = createTexture.call(device, descriptor);
        const destroy = texture.destroy;
        textures.set(texture, destroy);
        texture.destroy = () => {
            textures.delete(texture);
            destroy.call(texture);
        };
        return texture;
    };
    device.createComputePipeline = (descriptor) => {
        const pipeline = createComputePipeline.call(device, descriptor);
        const constants = descriptor.compute.constants;
        if (constants?.SLICE_COUNT !== undefined) {
            pipelines.set(pipeline, "estimate");
        } else if (constants?.PIXEL_STRIDE !== undefined) {
            pipelines.set(pipeline, "spatial-denoise");
        } else if (descriptor.label?.startsWith("ssao-")) {
            pipelines.set(pipeline, descriptor.label);
        }
        return pipeline;
    };
    return {
        textures,
        pipelines,
        restore() {
            device.createTexture = createTexture;
            device.createComputePipeline = createComputePipeline;
            for (const [texture, destroy] of textures) {
                texture.destroy = destroy;
            }
        },
    };
}

type Observation = ReturnType<typeof observeSsaoProfile>;
export interface SsaoProfileCase extends SsaoProfileOptions {
    resolution: "full" | "half";
    providedNormals: boolean;
    moving: boolean;
    cameraMoving: boolean;
}

export function exposeSsaoProfile(
    observation: Observation,
    engine: EngineContext,
    ao: SsaoTask,
    temporal: SsaoTemporalSettings,
    normal: RenderTarget,
    velocity: RenderTarget,
    camera: ArcRotateCamera,
    resetMotion: () => void
) {
    const device = engine._device;
    const queryCount = PASSES_PER_FRAME * BATCH_FRAMES * 2;
    const querySet = device.createQuerySet({ type: "timestamp", count: queryCount });
    const resolve = device.createBuffer({ size: queryCount * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: queryCount * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const errors: string[] = [];
    const onError = (event: GPUUncapturedErrorEvent): void => {
        errors.push(event.error.message);
    };
    device.addEventListener("uncapturederror", onError);
    let mode: "task" | "passes" | null = null;
    let names: string[] = [];
    const execute = ao.execute!;
    const prepareGpu = temporal._prepareGpu;
    let temporalOwner: DiligentTemporalGpu | null = null;
    temporal._prepareGpu = (state, source) => {
        prepareGpu?.(state, source);
        temporalOwner = state;
    };
    const initialAlpha = camera.alpha,
        initialBeta = camera.beta;
    let frameIndex = 0,
        cameraMoving = false;
    const frame = () => {
        frameIndex++;
        const time = frameIndex * 0.016;
        camera.alpha = initialAlpha + (cameraMoving ? 0.16 * Math.sin(time * 0.9) : 0);
        camera.beta = initialBeta + (cameraMoving ? 0.025 * Math.sin(time * 0.7) : 0);
        renderFrame(engine, 16);
    };
    const stamp = (name: string): GPUComputePassTimestampWrites => {
        const index = names.length * 2;
        if (index + 1 >= queryCount) {
            throw new Error("SSAO diagnostic query capacity exceeded.");
        }
        names.push(name);
        return { querySet, beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 };
    };
    const classify = (pipeline: GPUComputePipeline): string => {
        if (pipeline === ao._gpu?.copy.pipeline) return "depth-copy";
        if (pipeline === ao._gpu?.reduce.pipeline) return "depth-mips";
        const name = observation.pipelines.get(pipeline);
        if (!name) throw new Error(`Unknown SSAO compute stage: ${pipeline.label}`);
        return name;
    };
    const splitCompute = (encoder: GPUCommandEncoder, descriptor: GPUComputePassDescriptor = {}): GPUComputePassEncoder => {
        if (descriptor.timestampWrites) throw new Error("SSAO diagnostics cannot nest another pass timer.");
        let index = names.length;
        let writes = stamp(descriptor.label ?? "compute");
        let pass = encoder.beginComputePass({ ...descriptor, timestampWrites: writes });
        let previous: GPUComputePipeline | undefined;
        return new Proxy(pass, {
            get(_target, key): unknown {
                if (key === "setPipeline") {
                    return (pipeline: GPUComputePipeline) => {
                        if (previous && previous !== pipeline) {
                            pass.end();
                            index = names.length;
                            writes = stamp(classify(pipeline));
                            pass = encoder.beginComputePass({ ...descriptor, timestampWrites: writes });
                        }
                        names[index] = classify(pipeline);
                        previous = pipeline;
                        pass.setPipeline(pipeline);
                    };
                }
                const value: unknown = Reflect.get(pass, key, pass);
                return typeof value === "function" ? value.bind(pass) : value;
            },
        });
    };
    ao.execute = () => {
        if (!mode) return execute();
        const encoder = engine._currentEncoder;
        if (mode === "task") {
            const writes = stamp("ssao-total");
            encoder.beginComputePass({ timestampWrites: { querySet, beginningOfPassWriteIndex: writes.beginningOfPassWriteIndex } }).end();
            try {
                return execute();
            } finally {
                encoder.beginComputePass({ timestampWrites: { querySet, endOfPassWriteIndex: writes.endOfPassWriteIndex } }).end();
            }
        }
        engine._currentEncoder = new Proxy(encoder, {
            get(target, key): unknown {
                if (key === "beginComputePass") return (descriptor?: GPUComputePassDescriptor) => splitCompute(target, descriptor);
                if (key === "beginRenderPass") {
                    return (descriptor: GPURenderPassDescriptor) => {
                        if (descriptor.timestampWrites || !descriptor.label) throw new Error("SSAO diagnostics require uniquely labeled, untimed render passes.");
                        return target.beginRenderPass({ ...descriptor, timestampWrites: stamp(descriptor.label) });
                    };
                }
                const value: unknown = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        try {
            return execute();
        } finally {
            engine._currentEncoder = encoder;
        }
    };
    const capture = async (selected: "task" | "passes", count: number) => {
        const frames: Record<string, number>[] = [];
        let signature: string | undefined;
        mode = selected;
        try {
            for (let start = 0; start < count; start += BATCH_FRAMES) {
                names = [];
                const ranges: [number, number][] = [];
                for (let sample = start; sample < Math.min(start + BATCH_FRAMES, count); sample++) {
                    const first = names.length;
                    frame();
                    const labels = names.slice(first);
                    if (!labels.length || labels.length > PASSES_PER_FRAME) throw new Error("Unexpected SSAO diagnostic pass count.");
                    const currentSignature = labels.join("|");
                    if (signature && signature !== currentSignature) throw new Error("SSAO diagnostic pass topology changed inside a sample batch.");
                    signature = currentSignature;
                    ranges.push([first, names.length]);
                }
                const encoder = device.createCommandEncoder();
                encoder.resolveQuerySet(querySet, 0, names.length * 2, resolve, 0);
                encoder.copyBufferToBuffer(resolve, 0, readback, 0, names.length * 16);
                device.queue.submit([encoder.finish()]);
                await readback.mapAsync(GPUMapMode.READ);
                try {
                    const times = new BigUint64Array(readback.getMappedRange());
                    for (const [first, end] of ranges) {
                        frames.push(decodeSsaoPassTimes(names.slice(first, end), times.subarray(first * 2, end * 2)));
                    }
                } finally {
                    readback.unmap();
                }
                if (errors.length) throw new Error(errors.join("\n"));
            }
        } finally {
            mode = null;
        }
        return frames;
    };
    const textureBytes = async (texture: GPUTexture, stride: number) => {
        const pitch = Math.ceil((texture.width * stride) / 256) * 256;
        const buffer = device.createBuffer({ size: pitch * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: pitch }, [texture.width, texture.height]);
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const source = new Uint8Array(buffer.getMappedRange());
            const bytes = new Uint8Array(texture.width * texture.height * stride);
            for (let y = 0; y < texture.height; y++) bytes.set(source.subarray(y * pitch, y * pitch + texture.width * stride), y * texture.width * stride);
            return bytes;
        } finally {
            buffer.destroy();
        }
    };
    const toggle = (id: string, value: boolean): void => {
        const input = document.getElementById(id);
        if (!(input instanceof HTMLInputElement)) throw new Error(`Missing SSAO diagnostic control: ${id}`);
        if (input.checked !== value) input.click();
    };
    const select = (id: string, value: string): void => {
        const input = document.getElementById(id);
        if (!(input instanceof HTMLSelectElement)) throw new Error(`Missing SSAO diagnostic select: ${id}`);
        input.value = value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const warm = (count = 64) => {
        resetMotion();
        frameIndex = 0;
        camera.alpha = initialAlpha;
        camera.beta = initialBeta;
        resetSsaoTemporal(temporal);
        for (let i = 0; i < count; i++) frame();
    };
    const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
    };
    const frameDigest = async (index: number): Promise<SsaoFrameDigest> => {
        if (!temporalOwner) throw new Error("Pruning comparison has no temporal owner.");
        const output = ao.outputTexture._colorTexture!,
            count = temporalOwner.counts[temporalOwner.index]!;
        if (output.format !== "rgba16float" || count.format !== "r16float" || output.width !== count.width || output.height !== count.height) {
            throw new Error("Pruning comparison requires matching RGBA16 output and R16 history counts.");
        }
        const aoBytes = await textureBytes(output, 8),
            countBytes = await textureBytes(count, 2);
        let maskDrawVertices: number | undefined;
        if (temporalOwner.transportExtension) {
            const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            try {
                const encoder = device.createCommandEncoder();
                encoder.copyBufferToBuffer(temporalOwner.transportExtension.indirect, 0, buffer, 0, 16);
                device.queue.submit([encoder.finish()]);
                await buffer.mapAsync(GPUMapMode.READ);
                maskDrawVertices = new Uint32Array(buffer.getMappedRange())[0]!;
                if (maskDrawVertices !== 0 && maskDrawVertices !== 3) throw new Error("Pruning produced an invalid indirect draw.");
            } finally {
                buffer.destroy();
            }
        }
        return { frame: index, aoSha256: await sha256(aoBytes), countSha256: await sha256(countBytes), aoBytes: aoBytes.length, countBytes: countBytes.length, maskDrawVertices };
    };
    const configure = (options: SsaoProfileCase) => {
        select("resolution", options.resolution);
        select("quality", options.quality);
        toggle("useNormalTexture", options.providedNormals);
        toggle("aoOnly", true);
        toggle("moving", options.moving);
        toggle("deforming", false);
        cameraMoving = options.cameraMoving;
        ao.radius = 0.35;
    };
    const verifySplit = async (pruning: boolean) => {
        toggle("motionPruning", pruning);
        warm();
        const control = await textureBytes(ao.outputTexture._colorTexture!, 8);
        warm(63);
        await capture("passes", 1);
        const instrumented = await textureBytes(ao.outputTexture._colorTexture!, 8);
        if (control.length !== instrumented.length || control.some((value, i) => value !== instrumented[i])) {
            throw new Error(`SSAO diagnostic pass splitting changed the output bytes (pruning=${pruning}).`);
        }
        return { comparedBytes: control.length, outputSha256: await sha256(control) };
    };
    const memorySnapshot = () => {
        const inventory = [...observation.textures.keys()]
            .filter((texture) => texture.label.startsWith("ssao-"))
            .map((texture) => ({
                label: texture.label,
                width: texture.width,
                height: texture.height,
                format: texture.format,
                mipLevelCount: texture.mipLevelCount,
                bytes: ssaoTextureBytes(texture),
                history: /^ssao-(history|count)-/.test(texture.label),
            }));
        const borrowedTextures = [
            { name: "depth", texture: ao.depthTexture._depthTexture! },
            { name: "normal", texture: normal._colorTexture! },
            { name: "velocity", texture: velocity._colorTexture! },
        ];
        const seen = new Set<GPUTexture>();
        const borrowed = borrowedTextures
            .filter(({ texture }) => {
                if (seen.has(texture)) return false;
                seen.add(texture);
                return true;
            })
            .map(({ name, texture }) => ({ name, width: texture.width, height: texture.height, format: texture.format, bytes: ssaoTextureBytes(texture) }));
        return {
            ownedBytes: inventory.reduce((sum, texture) => sum + texture.bytes, 0),
            historyBytes: inventory.filter((texture) => texture.history).reduce((sum, texture) => sum + texture.bytes, 0),
            workingBytes: inventory.filter((texture) => !texture.history).reduce((sum, texture) => sum + texture.bytes, 0),
            borrowedBytes: borrowed.reduce((sum, texture) => sum + texture.bytes, 0),
            retainedUnusedNormalBytes: ao.normalTexture ? 0 : ssaoTextureBytes(normal._colorTexture!),
            inventory,
            borrowed,
        };
    };
    const adapter = {
        vendor: device.adapterInfo.vendor,
        architecture: device.adapterInfo.architecture,
        device: device.adapterInfo.device,
        description: device.adapterInfo.description,
        isFallbackAdapter: device.adapterInfo.isFallbackAdapter,
    };
    const summarizeCapture = (baseline: Record<string, number>[], detailed: Record<string, number>[]) => {
        const baselineValues = baseline.map((sample) => sample["ssao-total"]!);
        if (!baselineValues.some((value) => value > 0)) throw new Error("GPU timestamp queries returned no usable task durations.");
        return {
            baseline: summarizeSsaoSamples(baselineValues),
            detailedTotal: summarizeSsaoSamples(detailed.map((sample) => Object.values(sample).reduce((sum, value) => sum + value, 0))),
            stages: Object.keys(detailed[0]!).map((name) => ({ name, ...summarizeSsaoSamples(detailed.map((sample) => sample[name]!)) })),
            raw: { baseline, detailed },
        };
    };
    const profile = {
        async run(options: SsaoProfileCase) {
            configure(options);
            const split = await verifySplit(false);
            warm();
            const baseline = await capture("task", options.samples);
            warm();
            const detailed = await capture("passes", options.samples);
            return {
                options,
                width: engine.canvas.width,
                height: engine.canvas.height,
                radius: ao.radius,
                historySamples: temporal.historySamples,
                adapter,
                outputEquivalent: true,
                ...split,
                ...summarizeCapture(baseline, detailed),
                memory: memorySnapshot(),
            };
        },
        async comparePruning(options: SsaoProfileCase) {
            configure(options);
            const split = [await verifySplit(false), await verifySplit(true)];
            const frames: [SsaoFrameDigest[], SsaoFrameDigest[]] = [[], []];
            for (const pruning of [false, true]) {
                toggle("motionPruning", pruning);
                warm();
                for (let i = 0; i < 32; i++) {
                    frame();
                    frames[pruning ? 1 : 0].push(await frameDigest(i));
                }
            }
            const equivalence = verifySsaoPruningFrames(frames[0], frames[1]);
            const activeMaskFrames = frames[1].filter((sample) => sample.maskDrawVertices === 3).length;
            if (options.moving && activeMaskFrames === 0) throw new Error("Pruning comparison did not exercise the moving-object mask.");
            if (errors.length) throw new Error(errors.join("\n"));
            const readings = [false, true].map((pruning) => ({
                pruning,
                baseline: [] as Record<string, number>[],
                detailed: [] as Record<string, number>[],
                blocks: [] as { type: string; round: number; first: boolean; meanMs: number; samples: number }[],
                memory: memorySnapshot(),
            }));
            for (const selected of ["task", "passes"] as const) {
                const blocks = ssaoPruningBlocks(options.samples);
                for (let round = 0; round < blocks.length; round++) {
                    const block = blocks[round]!;
                    for (const pruning of block.order) {
                        toggle("motionPruning", pruning);
                        warm();
                        const samples = await capture(selected, block.samples);
                        const reading = readings[pruning ? 1 : 0]!;
                        reading[selected === "task" ? "baseline" : "detailed"].push(...samples);
                        reading.blocks.push({
                            type: selected,
                            round,
                            first: pruning === block.order[0],
                            meanMs: samples.reduce((sum, sample) => sum + Object.values(sample).reduce((a, b) => a + b, 0), 0) / samples.length,
                            samples: samples.length,
                        });
                        reading.memory = memorySnapshot();
                    }
                }
            }
            const variants = readings.map((reading) => ({
                pruning: reading.pruning,
                ...summarizeCapture(reading.baseline, reading.detailed),
                blocks: reading.blocks,
                memory: reading.memory,
            }));
            const off = variants[0]!,
                on = variants[1]!;
            return {
                options,
                width: engine.canvas.width,
                height: engine.canvas.height,
                adapter,
                equivalence: { ...equivalence, activeMaskFrames, split, digests: { off: frames[0], on: frames[1] } },
                off,
                on,
                savedMs: off.baseline.meanMs - on.baseline.meanMs,
                savedPercent: (1 - on.baseline.meanMs / off.baseline.meanMs) * 100,
                extraTextureBytes: on.memory.ownedBytes - off.memory.ownedBytes,
            };
        },
        async dispose() {
            await device.queue.onSubmittedWorkDone();
            ao.execute = execute;
            temporal._prepareGpu = prepareGpu;
            observation.restore();
            device.removeEventListener("uncapturederror", onError);
            querySet.destroy();
            resolve.destroy();
            readback.destroy();
        },
    };
    Object.assign(globalThis, { ssaoPassProfile: profile });
    return profile;
}

export type SsaoProfileClient = ReturnType<typeof exposeSsaoProfile>;
