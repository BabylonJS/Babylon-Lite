import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import type * as SsaoGpu from "../../../packages/babylon-lite/src/post-process/ssao/ssao-gpu.js";
import type * as TemporalGpu from "../../../packages/babylon-lite/src/post-process/ssao/ssao-xegtao-gpu.js";
import type * as TemporalWgsl from "../../../packages/babylon-lite/src/post-process/ssao/ssao-xegtao-wgsl.js";
import type * as MotionMask from "../../../packages/babylon-lite/src/post-process/ssao/ssao-motion-mask-wgsl.js";
import type * as HalfWgsl from "../../../packages/babylon-lite/src/post-process/ssao/ssao-half-wgsl.js";

type TestApi = typeof SsaoGpu & typeof TemporalGpu & typeof TemporalWgsl & typeof MotionMask & typeof HalfWgsl;
let script: string;

test.beforeAll(async () => {
    const bundle = await build({
        stdin: {
            contents: [
                'export * from "./packages/babylon-lite/src/post-process/ssao/ssao-gpu.js";',
                'export * from "./packages/babylon-lite/src/post-process/ssao/ssao-xegtao-gpu.js";',
                'export * from "./packages/babylon-lite/src/post-process/ssao/ssao-xegtao-wgsl.js";',
                'export * from "./packages/babylon-lite/src/post-process/ssao/ssao-motion-mask-wgsl.js";',
                'export * from "./packages/babylon-lite/src/post-process/ssao/ssao-half-wgsl.js";',
            ].join("\n"),
            resolveDir: process.cwd(),
        },
        bundle: true,
        format: "iife",
        globalName: "ssaoDepthTest",
        write: false,
    });
    script = bundle.outputFiles[0]!.text;
});

for (const kind of ["depth", "float"] as const) {
    test(`SSAO preserves small positive reverse-Z depths (${kind})`, async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`http://localhost:${process.env.LAB_TEST_PORT ?? 5179}/`);
        await page.addScriptTag({ content: script });
        const result = await page.evaluate(async (kind) => {
            const api = (window as unknown as { ssaoDepthTest: TestApi }).ssaoDepthTest;
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                throw new Error("WebGPU adapter unavailable");
            }
            const device = await adapter.requestDevice();
            const gpuErrors: string[] = [];
            device.addEventListener("uncapturederror", (event) => gpuErrors.push(event.error.message));
            const width = 16;
            const near = 0.01;
            const far = 20000;
            const a = near / (near - far);
            const b = (near * far) / (far - near);
            const project = (z: number): number => Math.fround(a + b / z);
            const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
            const projection = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, a, 1, 0, 0, b, 0]);
            const inverse = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1 / b, 0, 0, 1, -a / b]);
            const readPixel = async (texture: GPUTexture): Promise<ArrayBuffer> => {
                const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
                try {
                    const encoder = device.createCommandEncoder();
                    encoder.copyTextureToBuffer({ texture, origin: [8, 8] }, { buffer, bytesPerRow: 256 }, [1, 1]);
                    device.queue.submit([encoder.finish()]);
                    await buffer.mapAsync(GPUMapMode.READ);
                    return buffer.getMappedRange().slice(0);
                } finally {
                    buffer.destroy();
                }
            };
            const clear = (encoder: GPUCommandEncoder, texture: GPUTexture, value: number, mip = 0): void => {
                encoder
                    .beginRenderPass({
                        colorAttachments: [
                            { view: texture.createView({ baseMipLevel: mip, mipLevelCount: 1 }), loadOp: "clear", storeOp: "store", clearValue: [value, value, value, 1] },
                        ],
                    })
                    .end();
            };
            const cases = [];
            try {
                for (const distance of [null, 100, 10000]) {
                    device.pushErrorScope("validation");
                    const z = distance ?? 10000;
                    const depth = distance === null ? 0 : project(z);
                    const textures: GPUTexture[] = [];
                    const makeTexture = (format: GPUTextureFormat, usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST): GPUTexture => {
                        const texture = device.createTexture({ size: [width, width], format, usage });
                        textures.push(texture);
                        return texture;
                    };
                    const source = makeTexture("r32float");
                    const raw = kind === "float" ? source : makeTexture("depth32float", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);
                    const normal = makeTexture("rgba32float");
                    const velocity = makeTexture("rgba32float");
                    const normals = new Float32Array(width * width * 4);
                    for (let i = 0; i < width * width; i++) normals[i * 4 + 2] = -1;
                    device.queue.writeTexture({ texture: normal }, normals, { bytesPerRow: width * 16 }, [width, width]);
                    const fillModule = device.createShaderModule({
                        code: `${api.XEGTAO_FULLSCREEN_WGSL}
@group(0) @binding(0) var values:texture_2d<f32>;
@fragment fn main(@builtin(position) p:vec4f)->@builtin(frag_depth) f32{return textureLoad(values,vec2i(p.xy),0).r;}`,
                    });
                    const fillLayout = device.createBindGroupLayout({
                        entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } }],
                    });
                    const fillPipeline = device.createRenderPipeline({
                        layout: device.createPipelineLayout({ bindGroupLayouts: [fillLayout] }),
                        vertex: { module: fillModule, entryPoint: "fullscreen" },
                        fragment: { module: fillModule, entryPoint: "main", targets: [] },
                        depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
                    });
                    const fillGroup = device.createBindGroup({ layout: fillPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: source.createView() }] });
                    const fillDepth = (encoder: GPUCommandEncoder, values: Float32Array<ArrayBuffer>): void => {
                        device.queue.writeTexture({ texture: source }, values, { bytesPerRow: width * 4 }, [width, width]);
                        if (kind === "depth") {
                            const pass = encoder.beginRenderPass({
                                colorAttachments: [],
                                depthStencilAttachment: { view: raw.createView(), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 0 },
                            });
                            pass.setPipeline(fillPipeline);
                            pass.setBindGroup(0, fillGroup);
                            pass.draw(3);
                            pass.end();
                        }
                    };
                    const owner = api.createSsaoGpu(device, width, width, kind, true);
                    api.bindSsaoGpuSources(owner, raw.createView(), normal.createView());
                    api.writeSsaoGpuParameters(owner, { depthMultiply: -b, depthAdd: a, tanX: 1, tanY: 1, radius: z * 0.3, intensity: 1 });
                    const states: TemporalGpu.XegtaoTemporalGpu[] = [];
                    const makeState = (withVelocity: boolean, previousDepth: boolean): TemporalGpu.XegtaoTemporalGpu => {
                        const state = api.createXegtaoTemporalGpu(owner, withVelocity ? velocity.createView() : null, withVelocity, previousDepth);
                        states.push(state);
                        state.data.set(identity, 0);
                        state.data.set(identity, 16);
                        state.data.set(projection, 32);
                        state.data[49] = 16;
                        state.data[51] = previousDepth ? 1 : 0;
                        state.data.set(inverse, 52);
                        state.data.set(inverse, 68);
                        state.data[84] = 1e-5;
                        state.data.set([0, 0, 0, 1], 88);
                        state.data.set([0, 0, 1 / b, -a / b], 92);
                        return state;
                    };
                    try {
                        const state = makeState(false, false);
                        let encoder = device.createCommandEncoder();
                        fillDepth(encoder, new Float32Array(width * width).fill(depth));
                        // Seed known spatial AO to isolate reconstruction from estimator sampling noise.
                        clear(encoder, state.scratch, 0.25);
                        state.data[48] = 1;
                        api.executeXegtaoTemporalGpu(state, encoder);
                        device.queue.submit([encoder.finish()]);
                        state.data[48] = 0;
                        encoder = device.createCommandEncoder();
                        api.executeXegtaoTemporalGpu(state, encoder);
                        device.queue.submit([encoder.finish()]);
                        const visibility = new Uint16Array(await readPixel(owner.visibility))[0]!;
                        const history = new Uint8Array(await readPixel(state.history[state.index]!))[0]!;
                        const count = new Uint16Array(await readPixel(state.counts[state.index]!))[0]!;
                        const geometry = new Uint32Array(await readPixel(state.geometry));

                        const normalProbe = makeTexture("rgba32uint", GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
                        const probeModule = device.createShaderModule({
                            code: `${api.xegtaoOutputWGSL(kind)}
@fragment fn normalInputProbe(@builtin(position) pixel:vec4f)->@location(0) vec4u{
let p=vec2i(pixel.xy);let supplied=aoSuppliedNormal(p);
let normal=normalize((inverseView*vec4f(aoNormalOf(p,supplied),0)).xyz);
return vec4u(bitcast<u32>(supplied.z),bitcast<u32>(normal.z),geometryNormalBits(normal),bitcast<u32>(aoRawDepth(p)));
}`,
                        });
                        const probePipeline = device.createRenderPipeline({
                            layout: device.createPipelineLayout({ bindGroupLayouts: [state.outputPipeline.getBindGroupLayout(0)] }),
                            vertex: { module: probeModule, entryPoint: "fullscreen" },
                            fragment: {
                                module: probeModule,
                                entryPoint: "normalInputProbe",
                                targets: [{ format: "rgba32uint" }],
                                constants: { PROVIDED_NORMALS: 1, WORLD_NORMALS: 0 },
                            },
                        });
                        encoder = device.createCommandEncoder();
                        const output = state.stages[0].find((stage) => stage.pipeline === state.outputPipeline)!;
                        const probePass = encoder.beginRenderPass({
                            colorAttachments: [{ view: normalProbe.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
                        });
                        probePass.setPipeline(probePipeline);
                        probePass.setBindGroup(0, output.group);
                        probePass.draw(3);
                        probePass.end();
                        device.queue.submit([encoder.finish()]);
                        const normalInputs = Array.from(new Uint32Array(await readPixel(normalProbe)).subarray(0, 4));

                        encoder = device.createCommandEncoder();
                        clear(encoder, state.counts[1], 1);
                        for (let mip = 0; mip < state.convolution.mipLevelCount; mip++) {
                            clear(encoder, state.convolution, mip === 0 ? 0.75 : 0.25, mip);
                            clear(encoder, state.convolutionDepth, depth, mip);
                        }
                        const repair = state.stages[0].find((stage) => stage.pipeline === state.repairPipeline)!;
                        const pass = encoder.beginRenderPass(repair.pass);
                        pass.setPipeline(repair.pipeline);
                        pass.setBindGroup(0, repair.group);
                        pass.draw(3);
                        pass.end();
                        device.queue.submit([encoder.finish()]);
                        const repaired = new Uint8Array(await readPixel(state.repaired))[0]!;

                        const transport = [];
                        for (const previousDepth of [false, true]) {
                            const moving = makeState(true, previousDepth);
                            const depths = new Float32Array(width * width);
                            const velocities = new Float32Array(width * width * 4);
                            const stored = new Uint32Array(width * width * 2);
                            for (let i = 0; i < depths.length; i++) {
                                const viewZ = i % width >= 10 ? z * 0.9 : z;
                                depths[i] = distance === null ? 0 : project(viewZ);
                                velocities.set([0.01, 0, viewZ, 0], i * 4);
                                stored[i * 2] = new Uint32Array(depths.buffer)[i]!;
                                stored[i * 2 + 1] = 0x7fff7fff;
                            }
                            device.queue.writeTexture({ texture: velocity }, velocities, { bytesPerRow: width * 16 }, [width, width]);
                            device.queue.writeTexture({ texture: moving.geometry }, stored, { bytesPerRow: width * 8 }, [width, width]);
                            encoder = device.createCommandEncoder();
                            fillDepth(encoder, depths);
                            api.executeSsaoGpu(owner, encoder, "ultra");
                            device.queue.submit([encoder.finish()]);
                            const spatial = new Uint16Array(await readPixel(owner.visibility))[0]!;
                            encoder = device.createCommandEncoder();
                            clear(encoder, moving.scratch, 0.25);
                            api.executeXegtaoTemporalGpu(moving, encoder);
                            const buffers = [
                                device.createBuffer({ size: api.ssaoMotionMaskCellCount(width, width) * 16, usage: GPUBufferUsage.STORAGE }),
                                device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
                                device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
                            ];
                            try {
                                const layout = device.createBindGroupLayout({
                                    entries: [
                                        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                                        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: kind === "depth" ? "depth" : "unfilterable-float" } },
                                        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
                                        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                                        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                                        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                                    ],
                                });
                                const pipeline = device.createComputePipeline({
                                    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
                                    compute: { module: device.createShaderModule({ code: api.ssaoMotionMaskWGSL(kind) }), entryPoint: "main" },
                                });
                                const group = device.createBindGroup({
                                    layout: pipeline.getBindGroupLayout(0),
                                    entries: [
                                        { buffer: owner.uniform },
                                        raw.createView(),
                                        velocity.createView(),
                                        { buffer: moving.uniform },
                                        { buffer: buffers[0]! },
                                        { buffer: buffers[1]! },
                                    ].map((resource, binding) => ({ binding, resource })),
                                });
                                const compute = encoder.beginComputePass();
                                compute.setPipeline(pipeline);
                                compute.setBindGroup(0, group);
                                compute.dispatchWorkgroups(width / 8, width / 8);
                                compute.end();
                                encoder.copyBufferToBuffer(buffers[1]!, 0, buffers[2]!, 0, 16);
                                device.queue.submit([encoder.finish()]);
                                await buffers[2]!.mapAsync(GPUMapMode.READ);
                                const draw = new Uint32Array(buffers[2]!.getMappedRange())[0]!;
                                buffers[2]!.unmap();
                                const warp = Array.from(new Float32Array(await readPixel(moving.transport!)).subarray(0, 4));
                                transport.push({ previousDepth, spatial, draw, warp });
                            } finally {
                                buffers.forEach((buffer) => buffer.destroy());
                            }
                        }
                        await device.queue.onSubmittedWorkDone();
                        const error = await device.popErrorScope();
                        cases.push({
                            distance,
                            depth,
                            viewZ: -b / (a - depth),
                            visibility,
                            history,
                            count,
                            geometry: Array.from(geometry.subarray(0, 2)),
                            normalInputs,
                            repaired,
                            transport,
                            error: error?.message,
                        });
                    } finally {
                        states.forEach(api.disposeXegtaoTemporalGpu);
                        api.disposeSsaoGpu(owner);
                        textures.forEach((texture) => texture.destroy());
                    }
                }
                return { cases, gpuErrors };
            } finally {
                device.destroy();
            }
        }, kind);
        expect(pageErrors).toEqual([]);
        expect(result.gpuErrors).toEqual([]);
        for (const entry of result.cases) {
            const label = JSON.stringify(entry);
            expect(entry.error, label).toBeUndefined();
            expect(entry.normalInputs, label).toEqual([0xbf800000, 0xbf800000, 0x7fff7fff, new Uint32Array(new Float32Array([entry.depth]).buffer)[0]]);
            if (entry.distance === null) {
                expect(entry.history, label).toBe(255);
                expect(entry.visibility, label).toBe(0x3c00);
                expect(entry.count, label).toBe(0x3c00);
                expect(entry.repaired, label).toBe(191);
            } else {
                expect(entry.history, label).toBe(64);
                expect(entry.visibility, label).toBe(0x3404);
                expect(entry.count, label).toBe(0x4000);
                expect(entry.geometry, label).toEqual([new Uint32Array(new Float32Array([entry.depth]).buffer)[0], 0x7fff7fff]);
                expect(entry.repaired, label).toBe(64);
                expect(entry.viewZ, label).toBeCloseTo(entry.distance, 1);
                if (entry.distance === 10000) {
                    expect(entry.depth).toBeGreaterThan(0);
                    expect(entry.depth).toBeLessThan(1e-6);
                }
            }
            for (const transported of entry.transport) {
                expect(transported.draw, label).toBe(entry.distance === null ? 0 : 3);
                expect(transported.warp.every(Number.isFinite), label).toBe(true);
                if (entry.distance === null) {
                    expect(transported.spatial, label).toBe(0x3c00);
                    expect(transported.warp, label).toEqual([0, 0, 0, 0]);
                } else {
                    expect(transported.spatial, label).toBeGreaterThan(0);
                    expect(transported.spatial, label).toBeLessThan(0x3c00);
                    expect(transported.warp[3], label).toBeGreaterThan(0);
                }
            }
        }
    });
}

test("SSAO Half upsampling compiles shared depth conversion with supplied and reconstructed normals", async ({ page }) => {
    await page.goto(`http://localhost:${process.env.LAB_TEST_PORT ?? 5179}/`);
    await page.addScriptTag({ content: script });
    const errors = await page.evaluate(async () => {
        const api = (window as unknown as { ssaoDepthTest: TestApi }).ssaoDepthTest;
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("WebGPU adapter unavailable");
        }
        const device = await adapter.requestDevice();
        device.pushErrorScope("validation");
        try {
            const errors: string[] = [];
            for (const supplied of [false, true]) {
                const module = device.createShaderModule({ code: api.ssaoHalfUpsampleWGSL(supplied) });
                const info = await module.getCompilationInfo();
                errors.push(...info.messages.filter((message) => message.type === "error").map((message) => message.message));
                await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
            }
            const validation = await device.popErrorScope();
            if (validation) {
                errors.push(validation.message);
            }
            return errors;
        } finally {
            device.destroy();
        }
    });
    expect(errors).toEqual([]);
});

test("SSAO normal history preserves snorm16 endpoints and both hemispheres on the GPU", async ({ page }) => {
    await page.goto(`http://localhost:${process.env.LAB_TEST_PORT ?? 5179}/`);
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(async () => {
        const api = (window as unknown as { ssaoDepthTest: TestApi }).ssaoDepthTest;
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("WebGPU adapter unavailable");
        }
        const device = await adapter.requestDevice();
        const normals = [
            [0, 0, -1],
            [0, 0, 1],
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [1, 2, -4],
            [-1, 2, -4],
            [1, -2, -4],
            [-1, -2, -4],
            [1, 2, 4],
            [-1, -2, 4],
        ];
        const inputData = new Float32Array(normals.length * 4);
        normals.forEach((normal, index) => {
            const length = Math.hypot(...normal);
            inputData.set(
                normal.map((value) => value / length),
                index * 4
            );
        });
        const input = device.createBuffer({ size: inputData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        const output = device.createBuffer({ size: inputData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const readback = device.createBuffer({ size: inputData.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const errors: string[] = [];
        device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
        device.pushErrorScope("validation");
        try {
            const module = device.createShaderModule({
                code: `${api.xegtaoOutputWGSL("float")}
@group(0) @binding(6) var<storage,read> inputNormals:array<vec4f>;
@group(0) @binding(7) var<storage,read_write> outputNormals:array<vec4u>;
@compute @workgroup_size(1) fn codecProbe(@builtin(global_invocation_id) id:vec3u){
let bits=geometryNormalBits(inputNormals[id.x].xyz);
outputNormals[id.x]=vec4u(bits,bitcast<vec3u>(geometryNormal(bits)));
}`,
            });
            const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "codecProbe" } });
            const group = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 6, resource: { buffer: input } },
                    { binding: 7, resource: { buffer: output } },
                ],
            });
            device.queue.writeBuffer(input, 0, inputData);
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(normals.length);
            pass.end();
            encoder.copyBufferToBuffer(output, 0, readback, 0, inputData.byteLength);
            device.queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            const bytes = readback.getMappedRange().slice(0);
            readback.unmap();
            const words = new Uint32Array(bytes);
            const decoded = new Float32Array(bytes);
            const cases = normals.map((_, index) => {
                const normal = Array.from(inputData.subarray(index * 4, index * 4 + 3));
                const sum = normal.reduce((total, value) => total + Math.abs(value), 0);
                let x = normal[0]! / sum,
                    y = normal[1]! / sum;
                if (normal[2]! < 0) {
                    [x, y] = [(1 - Math.abs(y)) * (x >= 0 ? 1 : -1), (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)];
                }
                const expected = ((Math.round(x * 32767) & 65535) | ((Math.round(y * 32767) & 65535) << 16)) >>> 0;
                const dot = normal.reduce((total, value, axis) => total + value * decoded[index * 4 + axis + 1]!, 0);
                return { normal, expected, actual: words[index * 4]!, dot };
            });
            const validation = await device.popErrorScope();
            return { cases, errors, validation: validation?.message };
        } finally {
            input.destroy();
            output.destroy();
            readback.destroy();
            device.destroy();
        }
    });
    expect(result.errors).toEqual([]);
    expect(result.validation).toBeUndefined();
    for (const entry of result.cases) {
        expect(entry.actual, JSON.stringify(entry)).toBe(entry.expected);
        expect(entry.dot, JSON.stringify(entry)).toBeGreaterThan(0.99999);
    }
});
