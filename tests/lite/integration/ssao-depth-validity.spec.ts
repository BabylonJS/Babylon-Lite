import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import type * as SsaoGpu from "../../../packages/babylon-lite/src/post-process/ssao/ssao-gpu.js";
import type * as TemporalGpu from "../../../packages/babylon-lite/src/post-process/ssao/ssao-xegtao-gpu.js";
import type * as TemporalWgsl from "../../../packages/babylon-lite/src/post-process/ssao/ssao-xegtao-wgsl.js";
import type * as MotionMask from "../../../packages/babylon-lite/src/post-process/ssao/ssao-motion-mask-wgsl.js";
import type * as MotionPruning from "../../../packages/babylon-lite/src/post-process/ssao/ssao-motion-pruning.js";
import type * as HalfWgsl from "../../../packages/babylon-lite/src/post-process/ssao/ssao-half-wgsl.js";
import type * as SsaoWgsl from "../../../packages/babylon-lite/src/post-process/ssao/ssao-wgsl.js";
import type * as Orthographic from "../../../packages/babylon-lite/src/camera/orthographic.js";
import type * as FreeCamera from "../../../packages/babylon-lite/src/camera/free-camera.js";

type TestApi = typeof SsaoGpu &
    typeof TemporalGpu &
    typeof TemporalWgsl &
    typeof MotionMask &
    typeof MotionPruning &
    typeof HalfWgsl &
    typeof SsaoWgsl &
    typeof Orthographic &
    typeof FreeCamera;
let script: string;

test.beforeAll(async () => {
    const bundle = await build({
        stdin: {
            contents: [
                'export * from "./packages/babylon-lite/src/post-process/ssao/ssao-gpu.js";',
                'export * from "./packages/babylon-lite/src/post-process/ssao/ssao-xegtao-gpu.js";',
                'export * from "./packages/babylon-lite/src/post-process/ssao/ssao-xegtao-wgsl.js";',
                'export * from "./packages/babylon-lite/src/post-process/ssao/ssao-motion-mask-wgsl.js";',
                'export * from "./packages/babylon-lite/src/post-process/ssao/ssao-motion-pruning.js";',
                'export * from "./packages/babylon-lite/src/post-process/ssao/ssao-half-wgsl.js";',
                'export * from "./packages/babylon-lite/src/post-process/ssao/ssao-wgsl.js";',
                'export * from "./packages/babylon-lite/src/camera/orthographic.js";',
                'export * from "./packages/babylon-lite/src/camera/free-camera.js";',
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

test.beforeEach(async ({ page }) => {
    // Keep the numerical GPU fixture independent of the lab's HMR and gallery navigation.
    await page.route(`http://localhost:${process.env.LAB_TEST_PORT ?? 5179}/`, (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><title>SSAO numerical GPU tests</title>" })
    );
});

test("SSAO orthographic reconstruction, estimator and temporal history use view depth", async ({ page }) => {
    await page.goto(`http://localhost:${process.env.LAB_TEST_PORT ?? 5179}/`);
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(async () => {
        const api = (window as unknown as { ssaoDepthTest: TestApi }).ssaoDepthTest;
        api.enableOrthographicCamera(api.createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), { halfHeight: 2 });
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("WebGPU adapter unavailable");
        }
        const device = await adapter.requestDevice();
        const errors: string[] = [];
        device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
        device.pushErrorScope("validation");
        const width = 16;
        const near = 0.1;
        const far = 200;
        const depthScale = -1 / (far - near);
        const depthOffset = far / (far - near);
        const raw = device.createTexture({ size: [width, width], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        const depths = new Float32Array(width * width);
        const expected = new Float32Array(width * width * 3);
        for (let y = 0; y < width; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                const px = ((x + 0.5) / width) * 8 - 2;
                const py = 1 - ((y + 0.5) / width) * 4;
                const z = 3 + px * 0.1 + py * 0.2;
                expected.set([px, py, z], i * 3);
                depths[i] = depthScale * z + depthOffset;
            }
        }
        device.queue.writeTexture({ texture: raw }, depths, { bytesPerRow: width * 4 }, [width, width]);
        const owner = api.createSsaoGpu(device, width, width, "float", false);
        api.bindSsaoGpuSources(owner, raw.createView(), null);
        api.writeSsaoGpuParameters(owner, {
            depthMultiply: -depthOffset,
            depthAdd: depthScale,
            tanX: 4,
            tanY: 2,
            orthographic: true,
            offsetX: 2,
            offsetY: -1,
            radius: 0.5,
            intensity: 1,
        });
        const size = width * width * 3 * 16;
        const probe = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const readback = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const module = device.createShaderModule({
            code: `${api.ssaoParamsWGSL()}
${api.ssaoDepthBindingWGSL("float", 1)}
@group(0) @binding(2) var normalInput:texture_2d<f32>;
@group(0) @binding(3) var<storage,read_write> result:array<vec4f>;
${api.ssaoNormalWGSL()}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
let p=vec2i(id.xy);let d=aoRawDepth(p);let z=dZ(d);let i=(id.y*ao.size.x+id.x)*3u;
result[i]=vec4f(aoPosition((vec2f(p)+0.5)*ao.invSize,z),1);
result[i+1u]=vec4f(aoNormal(p),1);
result[i+2u]=vec4f(deviceDepth(z),aoViewScale(z),aoClipDepth(vec4f(0,0,d,1)),1);
}`,
        });
        const pipeline = device.createComputePipeline({
            layout: "auto",
            compute: { module, entryPoint: "main", constants: { PROVIDED_NORMALS: 0, WORLD_NORMALS: 0 } },
        });
        const layout = pipeline.getBindGroupLayout(0);
        const group = device.createBindGroup({
            layout,
            entries: [
                { binding: 0, resource: { buffer: owner.uniform } },
                { binding: 1, resource: raw.createView() },
                { binding: 2, resource: owner.dummyNormalView },
                { binding: 3, resource: { buffer: probe } },
            ],
        });
        let encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(2, 2);
        pass.end();
        encoder.copyBufferToBuffer(probe, 0, readback, 0, size);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(readback.getMappedRange().slice(0));
        readback.unmap();
        let positionError = 0;
        let normalError = 0;
        let depthError = 0;
        let scaleError = 0;
        const normalLength = Math.hypot(0.1, 0.2, 1);
        const normal = [0.1 / normalLength, 0.2 / normalLength, -1 / normalLength];
        for (let i = 0; i < width * width; i++) {
            for (let c = 0; c < 3; c++) {
                positionError = Math.max(positionError, Math.abs(values[i * 12 + c]! - expected[i * 3 + c]!));
                normalError = Math.max(normalError, Math.abs(values[i * 12 + 4 + c]! - normal[c]!));
            }
            depthError = Math.max(depthError, Math.abs(values[i * 12 + 8]! - depths[i]!), Math.abs(values[i * 12 + 10]! - expected[i * 3 + 2]!));
            scaleError = Math.max(scaleError, Math.abs(values[i * 12 + 9]! - 1));
        }

        const state = api.createXegtaoTemporalGpu(owner, null);
        owner.resolveGroup = state.scratchResolve;
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const projection = new Float32Array([0.25, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, depthScale, 0, -0.5, 0.5, depthOffset, 1]);
        const inverse = new Float32Array([4, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1 / depthScale, 0, 2, -1, far, 1]);
        state.data.set(identity, 0);
        state.data.set(identity, 16);
        state.data.set(projection, 32);
        state.data[49] = 2;
        state.data.set(inverse, 52);
        state.data.set(inverse, 68);
        state.data.set([0, 0, 1 / depthScale, far], 88);
        state.data.set([0, 0, 0, 1], 92);
        for (let frame = 0; frame < 2; frame++) {
            state.data[48] = frame === 0 ? 1 : 0;
            encoder = device.createCommandEncoder();
            api.executeSsaoGpu(owner, encoder);
            api.executeXegtaoTemporalGpu(state, encoder);
            device.queue.submit([encoder.finish()]);
        }
        encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: state.counts[state.index]!, origin: [8, 8] }, { buffer: readback, bytesPerRow: 256 }, [1, 1]);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const countBits = new Uint16Array(readback.getMappedRange().slice(0))[0]!;
        readback.unmap();
        await device.queue.onSubmittedWorkDone();
        const validation = await device.popErrorScope();
        if (validation) {
            errors.push(validation.message);
        }
        api.disposeXegtaoTemporalGpu(state);
        api.disposeSsaoGpu(owner);
        probe.destroy();
        readback.destroy();
        raw.destroy();
        device.destroy();
        return { positionError, normalError, depthError, scaleError, countBits, errors };
    });
    expect(result.errors).toEqual([]);
    expect(result.positionError).toBeLessThan(3e-5);
    expect(result.normalError).toBeLessThan(1e-4);
    expect(result.depthError).toBeLessThan(3e-5);
    expect(result.scaleError).toBe(0);
    expect(result.countBits).toBe(0x4000); // Two accumulated samples, encoded as f16.
});

for (const axis of [0, 1] as const) {
    test(`SSAO searches unequal orthographic pixel scales along axis ${axis}`, async ({ page }) => {
        await page.goto(`http://localhost:${process.env.LAB_TEST_PORT ?? 5179}/`);
        await page.addScriptTag({ content: script });
        const result = await page.evaluate(async (axis) => {
            const api = (window as unknown as { ssaoDepthTest: TestApi }).ssaoDepthTest;
            api.enableOrthographicCamera(api.createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), { halfHeight: 2 });
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                throw new Error("WebGPU adapter unavailable");
            }
            const device = await adapter.requestDevice();
            const errors: string[] = [];
            device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
            device.pushErrorScope("validation");
            const width = 64;
            const pixel = 24;
            const tanX = axis === 0 ? 8 : 16;
            const tanY = axis === 0 ? 16 : 8;
            const texture = (format: GPUTextureFormat): GPUTexture =>
                device.createTexture({ size: [width, width], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
            const raw = texture("r32float");
            const normals = texture("rgba32float");
            const velocity = texture("rgba32float");
            const depths = new Float32Array(width * width);
            const normalData = new Float32Array(width * width * 4);
            const velocityData = new Float32Array(width * width * 4);
            for (let i = 0; i < width * width; i++) {
                normalData[i * 4 + 2] = -1;
            }
            device.queue.writeTexture({ texture: normals }, normalData, { bytesPerRow: width * 16 }, [width, width]);
            const owner = api.createSsaoGpu(device, width, width, "float", true);
            api.bindSsaoGpuSources(owner, raw.createView(), normals.createView());
            const parameters = { depthMultiply: -1, depthAdd: -0.1, tanX, tanY, orthographic: true, offsetX: 2, offsetY: -1, radius: 4 / 1.457, intensity: 1 };
            const readback = device.createBuffer({ size: 8 * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            // The narrow strip is inside the world-space radius, but beyond an X-only vertical search.
            for (let y = 0; y < width; y++) {
                for (let x = 0; x < width; x++) {
                    depths[y * width + x] = (axis === 0 ? x : y) === pixel + 11 ? 0.6 : 0.5;
                }
            }
            device.queue.writeTexture({ texture: raw }, depths, { bytesPerRow: width * 4 }, [width, width]);
            for (let phase = 0; phase < 8; phase++) {
                api.writeSsaoGpuParameters(owner, { ...parameters, phase });
                owner.data[22] = 32; // Isolate actual search reach from depth-mip footprint expansion.
                device.queue.writeBuffer(owner.uniform, 0, owner.data);
                const encoder = device.createCommandEncoder();
                api.executeSsaoGpu(owner, encoder);
                encoder.copyTextureToBuffer({ texture: owner.working!, origin: [pixel, pixel] }, { buffer: readback, offset: phase * 256, bytesPerRow: 256 }, [1, 1]);
                device.queue.submit([encoder.finish()]);
            }
            await readback.mapAsync(GPUMapMode.READ);
            const packed = new Uint32Array(readback.getMappedRange().slice(0));
            const visibility = Math.min(...Array.from({ length: 8 }, (_, phase) => ((packed[phase * 64]! & 255) / 255) * 1.5));
            readback.unmap();

            // A vacated receiver needs a moving caster outside the smaller axis's search/pruning bound.
            for (let y = 0; y < width; y++) {
                for (let x = 0; x < width; x++) {
                    const i = y * width + x;
                    const caster = (axis === 0 ? x : y) === pixel + 16;
                    depths[i] = caster ? 0.55 : 0.5;
                    velocityData[i * 4 + 2] = caster ? 4.5 : 5;
                    if (caster) {
                        velocityData[i * 4 + axis] = 0.25 / width;
                    }
                }
            }
            device.queue.writeTexture({ texture: raw }, depths, { bytesPerRow: width * 4 }, [width, width]);
            device.queue.writeTexture({ texture: velocity }, velocityData, { bytesPerRow: width * 16 }, [width, width]);
            api.writeSsaoGpuParameters(owner, { ...parameters, radius: 3 / 1.457 });
            const velocityView = velocity.createView();
            const state = api.createXegtaoTemporalGpu(owner, velocityView, true, true);
            const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
            const projection = new Float32Array([1 / tanX, 0, 0, 0, 0, 1 / tanY, 0, 0, 0, 0, -0.1, 0, -2 / tanX, 1 / tanY, 1, 1]);
            const inverse = new Float32Array([tanX, 0, 0, 0, 0, tanY, 0, 0, 0, 0, -10, 0, 2, -1, 10, 1]);
            state.data.set(identity, 0);
            state.data.set(identity, 16);
            state.data.set(projection, 32);
            state.data.set([0, 2, 0, 1], 48);
            state.data.set(inverse, 52);
            state.data.set(inverse, 68);
            state.data.set([0, 0, -10, 10], 88);
            state.data.set([0, 0, 0, 1], 92);
            for (const pruned of [false, true]) {
                if (pruned) {
                    state.transportExtension = api.createSsaoMotionPruningGpu(state);
                    api.bindXegtaoTemporalGpu(state, velocityView);
                }
                state.index = 0;
                const encoder = device.createCommandEncoder();
                for (const [target, value] of [
                    [state.scratch, 1],
                    [state.history[0], 0.5],
                ] as const) {
                    const pass = encoder.beginRenderPass({
                        colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [value, 0, 0, 0] }],
                    });
                    pass.end();
                }
                api.executeXegtaoTemporalGpu(state, encoder);
                encoder.copyTextureToBuffer({ texture: state.transport!, origin: [pixel, pixel] }, { buffer: readback, offset: pruned ? 256 : 0, bytesPerRow: 256 }, [1, 1]);
                device.queue.submit([encoder.finish()]);
            }
            await readback.mapAsync(GPUMapMode.READ);
            const transport = new Float32Array(readback.getMappedRange().slice(0));
            const unpruned = Array.from(transport.slice(0, 4));
            const pruned = Array.from(transport.slice(64, 68));
            readback.unmap();
            await device.queue.onSubmittedWorkDone();
            const validation = await device.popErrorScope();
            if (validation) {
                errors.push(validation.message);
            }
            api.disposeXegtaoTemporalGpu(state);
            api.disposeSsaoGpu(owner);
            readback.destroy();
            raw.destroy();
            normals.destroy();
            velocity.destroy();
            device.destroy();
            return { visibility, unpruned, pruned, errors };
        }, axis);
        expect(result.errors).toEqual([]);
        expect(result.visibility).toBeLessThan(0.999);
        const uv = 24.5 / 64;
        for (const transport of [result.unpruned, result.pruned]) {
            expect(transport[0]).toBeCloseTo(uv + (axis === 0 ? 0.25 / 64 : 0), 5);
            expect(transport[1]).toBeCloseTo(uv - (axis === 1 ? 0.25 / 64 : 0), 5);
            expect(transport[2]).toBeCloseTo(0.5, 5);
            expect(transport[3]).toBeCloseTo(12, 4);
        }
    });
}

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
