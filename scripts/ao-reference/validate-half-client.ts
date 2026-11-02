import { createHalfSsaoGpu, bindHalfSsaoGpu, executeHalfSsaoGpu } from "../../packages/babylon-lite/src/post-process/ssao-half-resolution.js";
import { createSsaoGpu, bindSsaoGpuSources, disposeSsaoGpu, executeSsaoGpu, writeSsaoGpuParameters } from "../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import { createFreeCamera } from "../../packages/babylon-lite/src/camera/free-camera.js";
import { getViewMatrix, getProjectionMatrix } from "../../packages/babylon-lite/src/camera/camera.js";
import { halfToFloat } from "./diligent-contract.js";
import { validateTemporalScene } from "./validate-temporal-scene-client.js";
import { validateDepthNormals } from "./validate-depth-normal-client.js";
import { validateWorkgroupUpsample } from "./validate-workgroup-upsample-client.js";

export async function validateHalfSsao(): Promise<{ case: string }[]> {
    const stride = 2;
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("Half-resolution validation requires WebGPU.");
    const device = await adapter.requestDevice();
    const errors: string[] = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    const results: { case: string }[] = [];
    const read = async (texture: GPUTexture, bytes: number) => {
        const pitch = Math.ceil((texture.width * bytes) / 256) * 256;
        const buffer = device.createBuffer({ size: pitch * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: pitch }, [texture.width, texture.height]);
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(buffer.getMappedRange()),
                copy = new Uint8Array(texture.width * texture.height * bytes);
            for (let y = 0; y < texture.height; y++) copy.set(mapped.subarray(y * pitch, y * pitch + texture.width * bytes), y * texture.width * bytes);
            return copy;
        } finally {
            buffer.destroy();
        }
    };
    try {
        results.push(...(await validateWorkgroupUpsample()));
        results.push(...(await validateDepthNormals()));
        for (const [width, height] of [
            [9, 7],
            [1, 17],
            [17, 1],
            [1, 1],
        ] as const) {
            const tex = (format: GPUTextureFormat) => device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
            const depth = tex("r32float"),
                normal = tex("rgba32float");
            const full = createSsaoGpu(device, width, height, "float", true);
            const sparse = createHalfSsaoGpu(device, width, height, "float", true, false, undefined, full.depth);
            const depthView = depth.createView(),
                normalView = normal.createView();
            bindSsaoGpuSources(full, depthView, normalView);
            bindHalfSsaoGpu(sparse, depthView, normalView);
            const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
            camera.nearPlane = 0.1;
            camera.farPlane = 20;
            const p = getProjectionMatrix(camera, width / height);
            const params = {
                depthMultiply: -p[14]!,
                depthAdd: p[10]!,
                tanX: 1 / p[0]!,
                tanY: 1 / p[5]!,
                far: 20,
                radius: 0.6,
                intensity: 1,
                view: getViewMatrix(camera),
                phase: 0,
            };
            const depths = new Float32Array(width * height),
                normals = new Float32Array(width * height * 4);
            for (let i = 0; i < width * height; i++) {
                const x = i % width,
                    z = width === 9 && x >= 5 ? 6 : 3;
                depths[i] = width === 9 && x === 8 ? 0 : p[10]! + p[14]! / z;
                normals[i * 4 + 2] = -1;
            }
            device.queue.writeTexture({ texture: depth }, depths, { bytesPerRow: width * 4 }, [width, height]);
            device.queue.writeTexture({ texture: normal }, normals, { bytesPerRow: width * 16 }, [width, height]);
            try {
                for (const quality of ["low", "medium", "high", "ultra"] as const) {
                    for (let phase = 0; phase < 4; phase++) {
                        params.phase = phase;
                        writeSsaoGpuParameters(full, params);
                        writeSsaoGpuParameters(sparse.gpu, params);
                        const encoder = device.createCommandEncoder();
                        executeSsaoGpu(full, encoder, quality);
                        executeSsaoGpu(sparse.gpu, encoder, quality);
                        executeHalfSsaoGpu(sparse, encoder);
                        device.queue.submit([encoder.finish()]);
                        const fullRaw = full.working!,
                            sparseRaw = sparse.gpu.working!;
                        const reference = new Uint32Array((await read(fullRaw, 4)).buffer),
                            working = new Uint32Array((await read(sparseRaw, 4)).buffer);
                        for (let y = 0; y < sparseRaw.height; y++)
                            for (let x = 0; x < sparseRaw.width; x++) {
                                const source = Math.min(y * stride + stride / 2, height - 1) * width + Math.min(x * stride + stride / 2, width - 1);
                                // Compare the AO byte; sparse edges use the sparse receiver spacing by design.
                                if ((working[y * sparseRaw.width + x]! & 255) !== (reference[source]! & 255))
                                    throw new Error(`Sparse XeGTAO/${quality} estimation changed the full-resolution receiver calculation.`);
                            }
                        const output = new DataView((await read(sparse.gpu.outputTexture!, 8)).buffer);
                        for (let i = 0; i < width * height; i++) {
                            const v = halfToFloat(output.getUint16(i * 8, true));
                            if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error("Sparse AO output escaped normalized bounds.");
                            if (depths[i] === 0 && v !== 1) throw new Error("Sparse AO background is not exactly white.");
                        }
                    }
                }
                if (width === 9) {
                    const shader = device.createShaderModule({
                        code: `
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
var v=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(v[i],0,1);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{return vec4f(select(0.25,0.75,p.x>=2.0));}`,
                    });
                    const pipeline = device.createRenderPipeline({
                        layout: "auto",
                        vertex: { module: shader, entryPoint: "vertex" },
                        fragment: { module: shader, entryPoint: "fragment", targets: [{ format: "rgba16float" }] },
                        primitive: { topology: "triangle-list" },
                    });
                    const encoder = device.createCommandEncoder(),
                        pass = encoder.beginRenderPass({
                            colorAttachments: [{ view: sparse.gpu.visibility.createView(), loadOp: "clear", storeOp: "store", clearValue: [1, 1, 1, 1] }],
                        });
                    pass.setPipeline(pipeline);
                    pass.draw(3);
                    pass.end();
                    executeHalfSsaoGpu(sparse, encoder);
                    device.queue.submit([encoder.finish()]);
                    const output = new DataView((await read(sparse.gpu.outputTexture!, 8)).buffer);
                    for (let i = 0; i < width * height; i++) {
                        const x = i % width,
                            expected = x === 8 ? 1 : x >= 5 ? 0.75 : 0.25;
                        if (halfToFloat(output.getUint16(i * 8, true)) !== expected) throw new Error("Sparse bilateral reconstruction leaked across a depth edge.");
                    }
                }
                results.push({ case: `${width}x${height}/stride ${stride}: exact sparse receivers, all XeGTAO quality presets, odd bounds and bilateral output` });
            } finally {
                disposeSsaoGpu(sparse.gpu);
                disposeSsaoGpu(full);
                depth.destroy();
                normal.destroy();
            }
        }
        await device.queue.onSubmittedWorkDone();
        if (errors.length) throw new Error(errors.join("\n"));
    } finally {
        device.destroy();
    }
    await validateTemporalScene(true);
    results.push({ case: "real frame graph: original motion/depth history, stable public output, toggles and resize" });
    return results;
}
