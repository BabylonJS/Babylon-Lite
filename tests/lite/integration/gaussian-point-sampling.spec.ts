import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { resolve } from "node:path";
import type * as GpsShaders from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-shaders.js";

test("Gaussian point sampling preserves stream radiance and visualizes perspective/orthographic depth", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://localhost:${process.env.LAB_TEST_PORT ?? 5179}/`);
    const bundle = await build({
        entryPoints: [resolve("packages", "babylon-lite", "src", "gaussian-point-splatting", "gps-shaders.ts")],
        bundle: true,
        format: "iife",
        globalName: "gpsShaderTest",
        write: false,
    });
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const result = await page.evaluate(async () => {
        const shaders = (window as unknown as { gpsShaderTest: typeof GpsShaders }).gpsShaderTest;
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("WebGPU adapter unavailable");
        }
        const device = await adapter.requestDevice();
        const gpuErrors: string[] = [];
        device.addEventListener("uncapturederror", (event) => gpuErrors.push(event.error.message));
        device.pushErrorScope("validation");
        const buffers: GPUBuffer[] = [];
        const make = (data: Float32Array | Uint32Array, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST): GPUBuffer => {
            const buffer = device.createBuffer({ size: data.byteLength, usage });
            buffers.push(buffer);
            if ((usage & GPUBufferUsage.COPY_DST) !== 0) {
                device.queue.writeBuffer(buffer, 0, data);
            }
            return buffer;
        };
        const compute = (code: string): GPUComputePipeline =>
            device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
        const dispatch = (encoder: GPUCommandEncoder, pipeline: GPUComputePipeline, resources: GPUBuffer[]): void => {
            const group = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: resources.map((buffer, binding) => ({ binding, resource: { buffer } })),
            });
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(1);
            pass.end();
        };
        const read = async (source: GPUBuffer, size: number): Promise<ArrayBuffer> => {
            const staging = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            buffers.push(staging);
            const encoder = device.createCommandEncoder();
            encoder.copyBufferToBuffer(source, 0, staging, 0, size);
            device.queue.submit([encoder.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const data = staging.getMappedRange().slice(0);
            staging.unmap();
            return data;
        };
        const uniforms = (orthographic = false): Float32Array => {
            const data = new Float32Array(76);
            const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
            data.set(identity);
            data.set(identity, 16);
            data.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.1, orthographic ? 0 : 1, 0, 0, 1.1, orthographic ? 1 : 0], 32);
            data.set([0, 0, 0, 1], 48);
            data.set([1, 1, 1, 11], 52);
            data.set([1, 1, 1, 0], 56);
            data.set([1, 1000, 0, 0], 60);
            data.set([1, 3, 1, 0], 64);
            data.set([6, 7, 1, 0], 68);
            return data;
        };
        const preprocess = compute(shaders.gpsPreprocessShader(true, 0));
        compute(shaders.gpsPreprocessShader(false, 0));
        compute(shaders.gpsPreprocessShader(false, 3));
        const splat = compute(shaders.GPS_SPLAT);
        const resolveSamples = compute(shaders.GPS_RESOLVE);
        const radianceCases = [];
        const total = make(new Uint32Array(2));
        for (const radiance of [2, 16, 0.75]) {
            const cpu = uniforms();
            const params = make(cpu, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
            const canonical = make(new Float32Array([0, 0, 6, 1, 1, 0, 0, 1, 0, 1, 0, 0, radiance, 0, 0, 0]));
            const weights = make(new Uint32Array(1));
            const screen = make(new Float32Array(16));
            const hiz = make(new Float32Array([1]));
            const project = (occlusion: boolean): GPUCommandEncoder => {
                cpu[67] = +occlusion;
                device.queue.writeBuffer(params, 0, cpu);
                const encoder = device.createCommandEncoder();
                encoder.clearBuffer(total, 4, 4);
                dispatch(encoder, preprocess, [params, weights, screen, hiz, canonical, total]);
                return encoder;
            };
            device.queue.submit([project(true).finish()]);
            const occludedWeight = new Uint32Array(await read(weights, 4))[0]!;
            device.queue.submit([project(false).finish()]);
            const visibleWeight = new Uint32Array(await read(weights, 4))[0]!;
            const scale = new Float32Array(await read(total, 8))[1]!;
            // Pin one sample at the pixel center to exercise RGB565 packing without stochastic coverage variance.
            const record = new Float32Array([0.5, 0.5, 0, 0, 0, 0, 0, 0, radiance, 0, 0, 1, 0, 0, 0, 0]);
            device.queue.writeBuffer(screen, 0, record);
            device.queue.writeBuffer(total, 0, new Uint32Array([1]));
            const cdf = make(new Uint32Array([0]));
            const buckets = make(new Uint32Array(65537));
            const image = make(new Uint32Array([0xffffffff]));
            const accum = make(new Float32Array(4));
            const depth = make(new Float32Array(1));
            const counts = make(new Uint32Array(1));
            for (let frame = 0; frame < 4; frame++) {
                cpu[66] = frame === 0 ? 1 : 0;
                device.queue.writeBuffer(params, 0, cpu);
                const encoder = device.createCommandEncoder();
                if (frame === 0) {
                    dispatch(encoder, splat, [params, cdf, total, buckets, screen, image]);
                }
                dispatch(encoder, resolveSamples, [params, image, accum, depth, counts, hiz, total]);
                device.queue.submit([encoder.finish()]);
            }
            radianceCases.push({ radiance, occludedWeight, visibleWeight, scale, color: Array.from(new Float32Array(await read(accum, 16))) });
        }
        const depthCases = [];
        const module = device.createShaderModule({ code: shaders.GPS_COMPOSITE });
        const composite = device.createRenderPipeline({
            layout: "auto",
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
            depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
        });
        const texture = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
        const depthTexture = device.createTexture({ size: [1, 1], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT });
        for (const orthographic of [false, true]) {
            for (const visualization of [1, 2]) {
                for (const viewDepth of [1, 6, 11]) {
                    const cpu = uniforms(orthographic);
                    cpu[71] = visualization;
                    cpu[75] = 1;
                    const z = (cpu[42]! * viewDepth + cpu[46]!) / (cpu[43]! * viewDepth + cpu[47]!);
                    const resources = [make(cpu, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), make(new Float32Array([0, 0, 0, 0.25])), make(new Float32Array([z]))];
                    const group = device.createBindGroup({
                        layout: composite.getBindGroupLayout(1),
                        entries: resources.map((buffer, binding) => ({ binding, resource: { buffer } })),
                    });
                    const staging = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                    buffers.push(staging);
                    const encoder = device.createCommandEncoder();
                    const pass = encoder.beginRenderPass({
                        colorAttachments: [{ view: texture.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" }],
                        depthStencilAttachment: { view: depthTexture.createView(), depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "store" },
                    });
                    pass.setPipeline(composite);
                    pass.setBindGroup(0, device.createBindGroup({ layout: composite.getBindGroupLayout(0), entries: [] }));
                    pass.setBindGroup(1, group);
                    pass.draw(3);
                    pass.end();
                    encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow: 256 }, [1, 1]);
                    device.queue.submit([encoder.finish()]);
                    await staging.mapAsync(GPUMapMode.READ);
                    depthCases.push({ orthographic, visualization, viewDepth, color: Array.from(new Uint8Array(staging.getMappedRange().slice(0, 4))) });
                    staging.unmap();
                }
            }
        }
        await device.queue.onSubmittedWorkDone();
        const validation = await device.popErrorScope();
        buffers.forEach((buffer) => buffer.destroy());
        texture.destroy();
        depthTexture.destroy();
        device.destroy();
        return { radianceCases, depthCases, gpuErrors, validation: validation?.message };
    });
    expect(errors).toEqual([]);
    expect(result.gpuErrors).toEqual([]);
    expect(result.validation).toBeUndefined();
    for (const entry of result.radianceCases) {
        expect(entry.occludedWeight).toBe(0);
        expect(entry.visibleWeight).toBeGreaterThan(0);
        expect(entry.scale).toBeCloseTo(entry.radiance, 6);
        expect(entry.color[0]).toBeCloseTo(entry.radiance / 4, 2);
        expect(entry.color.slice(1, 3)).toEqual([0, 0]);
        expect(entry.color[3]).toBeCloseTo(0.25, 6);
    }
    for (const entry of result.depthCases) {
        const coverage = entry.visualization === 1 ? 1 : 0.25;
        const expected = ((entry.viewDepth - 1) / 10) * coverage;
        entry.color.slice(0, 3).forEach((channel) => expect(Math.abs(channel / 255 - expected)).toBeLessThanOrEqual(1 / 255));
        expect(Math.abs(entry.color[3]! / 255 - coverage)).toBeLessThanOrEqual(1 / 255);
    }
});
