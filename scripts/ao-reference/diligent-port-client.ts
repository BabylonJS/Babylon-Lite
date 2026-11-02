import { createSsaoGpu, bindSsaoGpuSources, writeSsaoGpuParameters, disposeSsaoGpu } from "../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import {
    bindDiligentTemporalGpu,
    createDiligentTemporalGpu,
    executeDiligentTemporalGpu,
    disposeDiligentTemporalGpu,
} from "../../packages/babylon-lite/src/post-process/ssao-diligent-gpu.js";
import { createSsaoMotionPruningGpu } from "../../packages/babylon-lite/src/post-process/ssao-motion-pruning.js";
import { halfToFloat } from "./diligent-contract.js";
import { createIdentityMat4 } from "../../packages/babylon-lite/src/math/create-identity-mat4.js";
import type { Mat4, Mat4Storage } from "../../packages/babylon-lite/src/math/types.js";

export async function replayDiligentPort(config: { width: number; height: number; frames: number; transport: boolean; production: boolean; motionPruning: boolean }) {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("Diligent replay requires WebGPU.");
    const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has("float32-filterable") ? ["float32-filterable"] : [] });
    const errors: string[] = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    const { width, height, frames } = config;
    const pixels = width * height;
    const depth = device.createTexture({ size: [width, height], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const normals = device.createTexture({
        size: [width, height],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING,
    });
    const normalUpload = device.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const velocity = device.createTexture({ size: [width, height], format: "rg32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const gpu = createSsaoGpu(device, width, height, "float", true, true);
    bindSsaoGpuSources(gpu, depth.createView(), normals.createView());
    const temporal = createDiligentTemporalGpu(gpu, velocity.createView(), config.transport);
    if (config.motionPruning) {
        temporal.transportExtension = createSsaoMotionPruningGpu(temporal);
        bindDiligentTemporalGpu(temporal, temporal.velocity);
    }
    const conversion = device.createComputePipeline({
        layout: "auto",
        compute: {
            entryPoint: "main",
            module: device.createShaderModule({
                code: `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var outputNormal:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=textureDimensions(source))){return;}
let n=textureLoad(source,vec2i(id.xy),0).xyz;
let xy=unpack2x16float(pack2x16float(n.xy));let z=unpack2x16float(pack2x16float(vec2f(n.z,1)));
textureStore(outputNormal,vec2i(id.xy),vec4f(xy,z));
}`,
            }),
        },
    });
    const conversionGroup = device.createBindGroup({
        layout: conversion.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: normalUpload.createView() },
            { binding: 1, resource: normals.createView() },
        ],
    });
    const stages = ["temporal", "repaired", "final", "history"] as const;
    const emptyStatistics = () => ({ max: 0, different: 0, outsideOneByte: 0, total: 0, absolute: 0 });
    const statistics = Object.fromEntries(stages.map((stage) => [stage, emptyStatistics()]));
    const frameStatistics = [];
    const read = async (texture: GPUTexture, bytes: number, mipLevel = 0): Promise<Uint8Array<ArrayBuffer>> => {
        const mipWidth = Math.max(1, width >> mipLevel);
        const mipHeight = Math.max(1, height >> mipLevel);
        const pitch = Math.ceil((mipWidth * bytes) / 256) * 256;
        const buffer = device.createBuffer({ size: pitch * mipHeight, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture, mipLevel, aspect: texture.format === "depth32float" ? "depth-only" : "all" }, { buffer, bytesPerRow: pitch }, [
                mipWidth,
                mipHeight,
            ]);
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(buffer.getMappedRange());
            const packed = new Uint8Array(mipWidth * mipHeight * bytes);
            for (let y = 0; y < mipHeight; y++) packed.set(mapped.subarray(y * pitch, y * pitch + mipWidth * bytes), y * mipWidth * bytes);
            return packed;
        } finally {
            buffer.destroy();
        }
    };
    const mipStatistics = [];
    const fetchBytes = async (url: string) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Replay resource failed ${url}: ${response.status} ${await response.text()}`);
        return response.arrayBuffer();
    };
    const matrix = (frame: DataView, offset: number): Mat4 => {
        const out = createIdentityMat4();
        const storage = out as unknown as Mat4Storage;
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) storage[c * 4 + r] = frame.getFloat32(offset + (r * 4 + c) * 4, true);
        return out;
    };
    try {
        for (let frame = 0; frame < frames; frame++) {
            const packet = await fetchBytes(`/port-frame/${frame}`);
            const data = new DataView(packet);
            let offset = 1168;
            device.queue.writeTexture({ texture: depth }, new Uint8Array(packet, offset, pixels * 4), { bytesPerRow: width * 4 }, [width, height]);
            offset += pixels * 4;
            const encoded = new Uint16Array(packet, offset, pixels * 4);
            const decoded = new Float32Array(pixels * 4);
            for (let p = 0; p < pixels; p++) {
                for (let c = 0; c < 3; c++) decoded[p * 4 + c] = 2 * halfToFloat(encoded[p * 4 + c]!) - 1;
                decoded[p * 4 + 3] = 1;
            }
            device.queue.writeTexture({ texture: normalUpload }, decoded, { bytesPerRow: width * 16 }, [width, height]);
            offset += pixels * 8;
            const supplied = new Float32Array(packet, offset, pixels * 2);
            const motion = new Float32Array(pixels * 2);
            for (let i = 0; i < motion.length; i++) motion[i] = -0.5 * supplied[i]!;
            device.queue.writeTexture({ texture: velocity }, motion, { bytesPerRow: width * 8 }, [width, height]);
            offset += pixels * 8;
            const raw = new Uint16Array(packet, offset, pixels);
            const ao = new Uint16Array(pixels * 4);
            for (let i = 0; i < pixels; i++) {
                ao[i * 4] = ao[i * 4 + 1] = ao[i * 4 + 2] = raw[i]!;
                ao[i * 4 + 3] = 0x3c00;
            }
            device.queue.writeTexture({ texture: temporal.scratch }, ao, { bytesPerRow: width * 8 }, [width, height]);
            const view = matrix(data, 16 + 112);
            const projection = matrix(data, 16 + 176);
            writeSsaoGpuParameters(gpu, {
                depthMultiply: -projection[14]!,
                depthAdd: projection[10]!,
                tanX: 1 / projection[0]!,
                tanY: 1 / projection[5]!,
                far: 30,
                radius: 0.6,
                intensity: 1,
                phase: frame % 64,
                view,
            });
            temporal.data.set(matrix(data, 16 + 112 + 3 * 64), 0);
            temporal.data.set(matrix(data, 16 + 576 + 112), 16);
            temporal.data.set(matrix(data, 16 + 576 + 112 + 2 * 64), 32);
            temporal.data.set([frame === 0 ? 1 : 0, 16, config.production ? 1 : 0, 0], 48);
            temporal.data.set(matrix(data, 16 + 112 + 5 * 64), 52);
            temporal.data.set(matrix(data, 16 + 576 + 112 + 5 * 64), 68);
            const encoder = device.createCommandEncoder();
            const normalPass = encoder.beginComputePass();
            normalPass.setPipeline(conversion);
            normalPass.setBindGroup(0, conversionGroup);
            normalPass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            normalPass.end();
            executeDiligentTemporalGpu(temporal, encoder);
            device.queue.submit([encoder.finish()]);
            if (frame === 0) {
                for (let mip = 0; mip < 5; mip++) {
                    const image = await read(temporal.convolution, 1, mip);
                    const depths = new DataView((await read(temporal.convolutionDepth, 4, mip)).buffer);
                    const aoNative = new Uint8Array(await fetchBytes(`/port-native/0/mip${mip}-ao`));
                    const depthNative = new DataView(await fetchBytes(`/port-native/0/mip${mip}-depth`));
                    const stats = { mip, ao: emptyStatistics(), depth: emptyStatistics() };
                    for (let p = 0; p < aoNative.length; p++) {
                        for (const [values, difference] of [
                            [stats.ao, Math.abs(image[p]! - aoNative[p]!)],
                            [stats.depth, Math.abs(depths.getFloat32(p * 4, true) - depthNative.getFloat32(p * 4, true))],
                        ] as const) {
                            values.max = Math.max(values.max, difference);
                            values.absolute += difference;
                            values.total++;
                            if (difference) values.different++;
                            if (difference > 1) values.outsideOneByte++;
                        }
                    }
                    mipStatistics.push(stats);
                }
            }
            const images = {
                temporal: await read(temporal.intermediate, 1),
                repaired: await read(temporal.repaired, 1),
                final: await read(temporal.history[temporal.index]!, 1),
                history: await read(temporal.counts[temporal.index]!, 2),
            };
            const frameStats = Object.fromEntries(stages.map((stage) => [stage, emptyStatistics()]));
            for (const stage of stages) {
                const reference = new Uint8Array(await fetchBytes(`/port-native/${frame}/${stage}`));
                const image = new DataView(images[stage].buffer);
                const stats = statistics[stage]!;
                const currentStats = frameStats[stage]!;
                const packed = new Uint8Array(pixels * (stage === "history" ? 2 : 1));
                const referenceView = new DataView(reference.buffer);
                for (let p = 0; p < pixels; p++) {
                    const value = stage === "history" ? halfToFloat(image.getUint16(p * 2, true)) : images[stage][p]!;
                    const nativeValue = stage === "history" ? halfToFloat(referenceView.getUint16(p * 2, true)) : reference[p]!;
                    const difference = Math.abs(value - nativeValue);
                    for (const values of [stats, currentStats]) {
                        values.max = Math.max(values.max, difference);
                        values.absolute += difference;
                        values.total++;
                        if (difference) values.different++;
                        if (difference > 1) values.outsideOneByte++;
                    }
                    if (stage === "history") {
                        packed[p * 2] = images.history[p * 2]!;
                        packed[p * 2 + 1] = images.history[p * 2 + 1]!;
                    } else packed[p] = value;
                }
                const response = await fetch(`/port-output/${frame}/${stage}`, { method: "POST", body: packed });
                if (!response.ok) throw new Error(`Failed to save WGSL ${stage}: ${response.status}`);
            }
            frameStatistics.push(frameStats);
            if (errors.length) throw new Error(errors.join("\n"));
        }
        return { statistics, frameStatistics, mipStatistics };
    } finally {
        disposeDiligentTemporalGpu(temporal);
        disposeSsaoGpu(gpu);
        for (const texture of [depth, normals, normalUpload, velocity]) texture.destroy();
        device.destroy();
    }
}
