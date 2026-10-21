import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { resolve } from "node:path";
import type * as GpsShaders from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-shaders.js";
import type * as GpsSceneDepth from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-scene-depth.js";
import type * as GpsPass from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-pass.js";
import type * as GpsRuntime from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-runtime.js";
import type * as NativeTasks from "../../../packages/babylon-lite/src/frame-graph/render-task-base.js";
import type * as NativeTargets from "../../../packages/babylon-lite/src/engine/render-target.js";
import type * as NativeShader from "../../../packages/babylon-lite/src/material/shader/shader-material.js";
import type * as NativeCoverage from "../../../packages/babylon-lite/src/render/alpha-to-coverage.js";
import type * as NativeStencil from "../../../packages/babylon-lite/src/material/enable-material-stencil.js";
import type * as NativeTransmission from "../../../packages/babylon-lite/src/frame-graph/transmission.js";
import type * as NativeSkybox from "../../../packages/babylon-lite/src/material/pbr/background-hdr-skybox.js";
import type { GaussianPointSplatting } from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-state.js";
import type { GaussianSplattingMesh } from "../../../packages/babylon-lite/src/mesh/GaussianSplatting/gaussian-splatting-mesh.js";
import type { DrawUpdateContext } from "../../../packages/babylon-lite/src/render/renderable.js";
import type { RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task-base.js";
import type { EnvironmentTextures } from "../../../packages/babylon-lite/src/loader-env/load-env.js";
import type { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl.js";
import type { setSubtreeVisible } from "../../../packages/babylon-lite/src/scene/visibility.js";
import type { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate.js";
import type { getSceneBindGroupLayout } from "../../../packages/babylon-lite/src/render/scene-helpers.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable.js";
import type { createBox, createPlane } from "../../../packages/babylon-lite/src/mesh/mesh-factories.js";
import type { createLinearDepthMaterial } from "../../../packages/babylon-lite/src/render/linear-depth-material.js";
import type { buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import type { ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance.js";
import type { publishTiLodBucket } from "../../../packages/babylon-lite/src/mesh/thin-instance-gpu-culling.js";
import type { tryBind } from "../../../packages/babylon-lite/src/mesh/thin-instance-cull-binding.js";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target.js";

type GpuTestApi = typeof GpsShaders &
    typeof GpsSceneDepth &
    typeof GpsPass &
    typeof GpsRuntime &
    typeof NativeTasks &
    typeof NativeTargets &
    typeof NativeShader &
    typeof NativeCoverage &
    typeof NativeStencil &
    typeof NativeTransmission &
    typeof NativeSkybox & {
        wgsl: typeof wgsl;
        setMeshVisible: typeof setSubtreeVisible;
        createArcRotateCamera: typeof createArcRotateCamera;
        getSceneBindGroupLayout: typeof getSceneBindGroupLayout;
        createBox: typeof createBox;
        createPlane: typeof createPlane;
        createLinearDepthMaterial: typeof createLinearDepthMaterial;
        buildShaderMaterialRenderables: typeof buildShaderMaterialRenderables;
        publishTiLodBucket: typeof publishTiLodBucket;
        tryBind: typeof tryBind;
    };

test("Gaussian point sampling preserves radiance, conservative visibility and distinct depth modes", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://localhost:${process.env.LAB_TEST_PORT ?? 5179}/`);
    const bundle = await build({
        stdin: {
            contents: `
export * from "./packages/babylon-lite/src/gaussian-point-splatting/gps-shaders.js";
export * from "./packages/babylon-lite/src/gaussian-point-splatting/gps-scene-depth.js";
export * from "./packages/babylon-lite/src/gaussian-point-splatting/gps-pass.js";
export * from "./packages/babylon-lite/src/gaussian-point-splatting/gps-runtime.js";
export * from "./packages/babylon-lite/src/frame-graph/render-task-base.js";
export * from "./packages/babylon-lite/src/engine/render-target.js";
export * from "./packages/babylon-lite/src/material/shader/shader-material.js";
export * from "./packages/babylon-lite/src/render/alpha-to-coverage.js";
export * from "./packages/babylon-lite/src/material/enable-material-stencil.js";
export * from "./packages/babylon-lite/src/frame-graph/transmission.js";
export * from "./packages/babylon-lite/src/material/pbr/background-hdr-skybox.js";
export { wgsl } from "./packages/babylon-lite/src/shader/wgsl.js";
export { setSubtreeVisible as setMeshVisible } from "./packages/babylon-lite/src/scene/visibility.js";
export { createArcRotateCamera } from "./packages/babylon-lite/src/camera/arc-rotate.js";
export { getSceneBindGroupLayout } from "./packages/babylon-lite/src/render/scene-helpers.js";
export { createBox, createPlane } from "./packages/babylon-lite/src/mesh/mesh-factories.js";
export { createLinearDepthMaterial } from "./packages/babylon-lite/src/render/linear-depth-material.js";
export { buildShaderMaterialRenderables } from "./packages/babylon-lite/src/material/shader/shader-renderable.js";
export { publishTiLodBucket } from "./packages/babylon-lite/src/mesh/thin-instance-gpu-culling.js";
export { tryBind } from "./packages/babylon-lite/src/mesh/thin-instance-cull-binding.js";
`,
            resolveDir: resolve("."),
        },
        bundle: true,
        loader: { ".wgsl": "text" },
        format: "iife",
        globalName: "gpsShaderTest",
        write: false,
    });
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const result = await page.evaluate(async () => {
        const shaders = (window as unknown as { gpsShaderTest: GpuTestApi }).gpsShaderTest;
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
        const dispatch = (encoder: GPUCommandEncoder, pipeline: GPUComputePipeline, resources: (GPUBuffer | GPUTextureView)[], groups = 1): void => {
            const group = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: resources.map((resource, binding) => ({ binding, resource: "mapAsync" in resource ? { buffer: resource } : resource })),
            });
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(groups);
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
            const data = new Float32Array(80);
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
            data.set([0, 1, 0, 0], 76);
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
        const discModule = device.createShaderModule({ code: shaders.GPS_LINEAR_DEPTH });
        const discs = device.createRenderPipeline({
            layout: "auto",
            vertex: { module: discModule, entryPoint: "vs" },
            fragment: { module: discModule, entryPoint: "fs", targets: [] },
            primitive: { topology: "triangle-strip" },
            depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "greater-equal" },
        });
        const linearResolve = compute(shaders.gpsResolveShader(false, "greater-equal", true));
        const fixedDiscDepth = device.createTexture({
            size: [1, 1],
            format: "depth32float",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        for (const orthographic of [false, true]) {
            for (const visualization of [1, 2]) {
                for (const viewDepth of [1, 6, 11]) {
                    const cpu = uniforms(orthographic);
                    cpu[71] = visualization;
                    cpu[75] = 1;
                    cpu[68] = cpu[69] = viewDepth;
                    const params = make(cpu, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
                    const accumulation = make(new Float32Array(4));
                    const geometricDepth = make(new Float32Array(1));
                    const image = make(new Uint32Array([0]));
                    const counts = make(new Uint32Array(1));
                    const hiz = make(new Float32Array(1));
                    for (let frame = 0; frame < 4; frame++) {
                        cpu[66] = frame === 0 ? 1 : 0;
                        device.queue.writeBuffer(params, 0, cpu);
                        const encoder = device.createCommandEncoder();
                        if (visualization === 1) {
                            const z = orthographic ? 1.1 - 0.1 * viewDepth : 1.1 / viewDepth - 0.1;
                            const clear = encoder.beginRenderPass({
                                colorAttachments: [],
                                depthStencilAttachment: { view: fixedDiscDepth.createView(), depthClearValue: Math.max(1e-8, z), depthLoadOp: "clear", depthStoreOp: "store" },
                            });
                            clear.end();
                        }
                        dispatch(encoder, visualization === 1 ? linearResolve : resolveSamples, [
                            params,
                            image,
                            accumulation,
                            geometricDepth,
                            counts,
                            hiz,
                            total,
                            ...(visualization === 1 ? [fixedDiscDepth.createView()] : []),
                        ]);
                        device.queue.submit([encoder.finish()]);
                    }
                    const resources = [params, accumulation, geometricDepth];
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
        const mixedCases = [];
        const resolveOccluded = compute(shaders.gpsResolveShader(true));
        const opaqueTexture = device.createTexture({ size: [1, 1], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        for (const visualization of [0, 2]) {
            const cpu = uniforms(true);
            cpu[71] = visualization;
            cpu[75] = 1;
            const params = make(cpu, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
            const image = make(new Uint32Array(1));
            const accumulation = make(new Float32Array(4));
            const geometricDepth = make(new Float32Array(1));
            const counts = make(new Uint32Array(1));
            const hiz = make(new Float32Array(1));
            const previousOpaque = make(new Float32Array(1));
            const frame = (viewDepth: number, opaque: number, index: number): void => {
                cpu[66] = index === 0 ? 1 : 3;
                cpu[68] = cpu[69] = viewDepth;
                device.queue.writeBuffer(params, 0, cpu);
                device.queue.writeBuffer(image, 0, new Uint32Array([viewDepth === 2 ? 0xf800 : 0x001f]));
                const encoder = device.createCommandEncoder();
                const pass = encoder.beginRenderPass({
                    colorAttachments: [],
                    depthStencilAttachment: { view: opaqueTexture.createView(), depthClearValue: opaque, depthLoadOp: "clear", depthStoreOp: "store" },
                });
                pass.end();
                dispatch(encoder, resolveOccluded, [params, image, accumulation, geometricDepth, counts, hiz, total, previousOpaque, opaqueTexture.createView()]);
                device.queue.submit([encoder.finish()]);
            };
            for (let index = 0; index < 4; index++) {
                frame(index % 2 === 0 ? 2 : 8, visualization === 0 ? 0.6 : 0, index);
            }
            const average = Array.from(new Float32Array(await read(accumulation, 16)));
            frame(8, 0, 4);
            const revealed = Array.from(new Float32Array(await read(accumulation, 16)));
            frame(2, 0.99, 5);
            const hidden = Array.from(new Float32Array(await read(accumulation, 16)));
            mixedCases.push({ visualization, average, revealed, hidden });
        }
        const sceneHiZ = compute(shaders.GPS_SCENE_HIZ);
        const scans = [shaders.GPS_SCAN_BLOCKS, shaders.GPS_SCAN_SUMS, shaders.GPS_SCAN_ADD, shaders.GPS_PARTITION].map(compute);
        const distribution = [];
        for (const culling of [false, true]) {
            const cpu = uniforms();
            cpu[60] = 2;
            cpu[61] = 1;
            cpu[65] = 299;
            cpu[68] = 2;
            cpu[69] = 8;
            const params = make(cpu, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
            const canonical = make(new Float32Array([0, 0, 2, 0.4, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 8, 0.8, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0]));
            const weights = make(new Uint32Array(2));
            const screen = make(new Float32Array(32));
            const hiz = make(new Float32Array([1e30]));
            const cdf = make(new Uint32Array(2));
            const sums = make(new Uint32Array(1));
            const indirect = make(new Uint32Array(3));
            const buckets = make(new Uint32Array(65537));
            const image = make(new Uint32Array([0xffffffff]));
            const accumulation = make(new Float32Array(4));
            const depth = make(new Float32Array(1));
            const counts = make(new Uint32Array(1));
            for (let frame = 0; frame < 300; frame++) {
                cpu[62] = frame;
                cpu[66] = frame === 0 ? 1 : 0;
                cpu[67] = +culling;
                device.queue.writeBuffer(params, 0, cpu);
                const encoder = device.createCommandEncoder();
                if (culling) {
                    const clear = encoder.beginRenderPass({
                        colorAttachments: [],
                        depthStencilAttachment: { view: opaqueTexture.createView(), depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "store" },
                    });
                    clear.end();
                    dispatch(encoder, sceneHiZ, [params, hiz, opaqueTexture.createView()]);
                }
                dispatch(encoder, preprocess, [params, weights, screen, hiz, canonical, total]);
                dispatch(encoder, scans[0]!, [params, weights, cdf, sums]);
                dispatch(encoder, scans[1]!, [params, sums, total, indirect]);
                dispatch(encoder, scans[2]!, [params, cdf, sums]);
                dispatch(encoder, scans[3]!, [params, cdf, total, buckets], 257);
                dispatch(encoder, splat, [params, cdf, total, buckets, screen, image]);
                dispatch(encoder, resolveSamples, [params, image, accumulation, depth, counts, hiz, total]);
                device.queue.submit([encoder.finish()]);
            }
            distribution.push(Array.from(new Float32Array(await read(accumulation, 16))));
        }
        const linearCases = [];
        for (const reversed of [false, true]) {
            const cpu = uniforms(true);
            cpu[52] = cpu[56] = 5;
            cpu[60] = 2;
            cpu[61] = 0;
            cpu[68] = 2;
            cpu[69] = 8;
            cpu[71] = cpu[75] = 1;
            const params = make(cpu, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
            const foreground = [0, 0, 2, 0.25, 2.512, 0, 0, 2.8, 0, 1, 0, 0, 1, 0, 0, 0];
            const background = [0, 0, 8, 0.8, 2.512, 0, 0, 2.8, 0, 1, 0, 0, 0, 0, 1, 0];
            const canonical = make(new Float32Array(reversed ? [...background, ...foreground] : [...foreground, ...background]));
            const weights = make(new Uint32Array(2));
            const screen = make(new Float32Array(32));
            const hiz = make(new Float32Array(5));
            const image = make(new Uint32Array(5).fill(0xffffffff));
            const accumulation = make(new Float32Array(20));
            const depth = make(new Float32Array(5));
            const counts = make(new Uint32Array(5));
            const target = device.createTexture({ size: [5, 1], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
            const encoder = device.createCommandEncoder();
            dispatch(encoder, preprocess, [params, weights, screen, hiz, canonical, total]);
            const pass = encoder.beginRenderPass({
                colorAttachments: [],
                depthStencilAttachment: { view: target.createView(), depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "store" },
            });
            pass.setPipeline(discs);
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: discs.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: params } },
                        { binding: 1, resource: { buffer: screen } },
                    ],
                })
            );
            pass.draw(4, 2);
            pass.end();
            dispatch(encoder, linearResolve, [params, image, accumulation, depth, counts, hiz, total, target.createView()]);
            device.queue.submit([encoder.finish()]);
            linearCases.push({ color: Array.from(new Float32Array(await read(accumulation, 80))), weights: Array.from(new Uint32Array(await read(weights, 8))) });
            target.destroy();
        }
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const engine = { _device: device, canvas } as unknown as EngineContext;
        const camera = shaders.createArcRotateCamera(0, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
        camera.nearPlane = 1;
        camera.farPlane = 11;
        const opaqueModule = device.createShaderModule({
            code: `
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0.6,1);
}
@fragment fn fs()->@location(0) vec4f { return vec4f(1,0,0,1); }
`,
        });
        const opaquePipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [shaders.getSceneBindGroupLayout(engine)] }),
            vertex: { module: opaqueModule, entryPoint: "vs" },
            fragment: { module: opaqueModule, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
            depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "greater-equal" },
        });
        const opaqueRenderable: Renderable = {
            order: 100,
            isTransparent: false,
            mesh: { visible: true } as Renderable["mesh"],
            bind: () => ({
                renderable: opaqueRenderable,
                pipeline: opaquePipeline,
                draw: (pass) => {
                    pass.draw(3);
                    return 1;
                },
            }),
        };
        const scene = {
            surface: { engine },
            camera,
            _renderables: [opaqueRenderable],
            _renderableVersion: 1,
            imageProcessing: { exposure: 1, contrast: 1, toneMappingEnabled: false },
            lights: [],
            _disposables: [],
            _beforeRender: [],
            _frameGraph: { _tasks: [] },
            clearColor: { r: 0, g: 0, b: 0, a: 1 },
        } as unknown as SceneContext;
        const nativeTarget = shaders.createRenderTarget({ samples: 1, format: "rgba8unorm", dFormat: "depth32float", size: { width: 1, height: 1 } });
        const nativeTask = shaders._createAutomaticRenderTask({ name: "native-visibility", rt: nativeTarget, autoMirror: false }, engine, scene);
        scene._frameGraph._tasks.push(nativeTask);
        nativeTask._renderables = scene._renderables;
        nativeTask.record();
        const nativeDepth = shaders.gpsCreateSceneDepth();
        const recordNative = (): GPUTextureView => {
            nativeTask.execute!();
            if (!shaders.gpsRecordSceneDepth(nativeDepth, scene, engine, nativeTask._targetSignature, { targetWidth: 1, targetHeight: 1, _camera: camera }) || !nativeDepth.view) {
                throw new Error("Native task depth unavailable");
            }
            return nativeDepth.view;
        };
        const depthReadback = make(new Float32Array(1));
        const readDepth = compute(`
@group(0) @binding(0) var source:texture_depth_2d;
@group(0) @binding(1) var<storage,read_write> result:array<f32>;
@compute @workgroup_size(1) fn main() { result[0]=textureLoad(source,vec2i(0),0); }
`);
        engine._currentEncoder = device.createCommandEncoder();
        dispatch(engine._currentEncoder, readDepth, [recordNative(), depthReadback]);
        device.queue.submit([engine._currentEncoder.finish()]);
        const opaqueDepth = new Float32Array(await read(depthReadback, 4))[0]!;
        scene._meshDisposables = new Map();
        const material = shaders.createLinearDepthMaterial();
        const meshes = [shaders.createBox(engine, 4), shaders.createBox(engine, 4)];
        meshes.forEach((mesh) => (mesh.material = material));
        scene._renderables = shaders.buildShaderMaterialRenderables(scene, meshes).renderables;
        nativeTask._renderables = scene._renderables;
        nativeTask.record();
        const mergedCount = scene._renderables.length;
        const mergedHasMesh = !!scene._renderables[0]?.mesh;
        scene._renderableVersion++;
        engine._currentEncoder = device.createCommandEncoder();
        dispatch(engine._currentEncoder, readDepth, [recordNative(), depthReadback]);
        device.queue.submit([engine._currentEncoder.finish()]);
        const mergedDepth = new Float32Array(await read(depthReadback, 4))[0]!;
        const mergedCpu = uniforms();
        mergedCpu[68] = mergedCpu[69] = 8;
        const mergedParams = make(mergedCpu, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        const mergedImage = make(new Uint32Array([31]));
        const mergedAccumulation = make(new Float32Array(4));
        const mergedGeometricDepth = make(new Float32Array(1));
        const mergedCounts = make(new Uint32Array(1));
        const mergedHiZ = make(new Float32Array(1));
        const mergedPrevious = make(new Float32Array(1));
        const mergedVisibility = [];
        for (const hidden of [false, true]) {
            meshes.forEach((mesh) => shaders.setMeshVisible(mesh, !hidden));
            device.queue.writeBuffer(total, 4, new Float32Array([1]));
            device.queue.writeBuffer(mergedImage, 0, new Uint32Array([31]));
            mergedCpu[66] = hidden ? 3 : 1;
            device.queue.writeBuffer(mergedParams, 0, mergedCpu);
            engine._currentEncoder = device.createCommandEncoder();
            const view = recordNative();
            dispatch(engine._currentEncoder, resolveOccluded, [
                mergedParams,
                mergedImage,
                mergedAccumulation,
                mergedGeometricDepth,
                mergedCounts,
                mergedHiZ,
                total,
                mergedPrevious,
                view,
            ]);
            device.queue.submit([engine._currentEncoder.finish()]);
            mergedVisibility.push(Array.from(new Float32Array(await read(mergedAccumulation, 16))));
        }
        const sourceTi = { _lodBuckets: new WeakMap() } as ThinInstanceData;
        const sourceMesh = { thinInstances: sourceTi } as Mesh;
        const partnerMesh = { thinInstances: { _lodSource: sourceMesh, _lodBuckets: sourceTi._lodBuckets } } as Mesh;
        const indices = make(new Uint32Array([0, 1, 2]), GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST);
        const args = make(new Uint32Array([3, 1, 0, 0, 0]), GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
        const drawBuffers = { matrixBuffer: make(new Float32Array(16)), colorBuffer: null };
        const signatures = new Set<RenderTargetSignature>();
        const source: Renderable = {
            order: 0,
            isTransparent: false,
            mesh: sourceMesh,
            bind(_engine, signature) {
                signatures.add(signature);
                return {
                    renderable: source,
                    pipeline: opaquePipeline,
                    update() {
                        shaders.publishTiLodBucket(sourceTi, signature, { drawBuffers, argsBuffer: args, lodDrawBuffers: drawBuffers, lodArgsBuffer: args });
                    },
                    draw: () => 0,
                };
            },
        };
        const partner: Renderable = {
            order: 1,
            isTransparent: false,
            mesh: partnerMesh,
            bind(_engine, signature) {
                const binding = shaders.tryBind(partner, scene, partnerMesh, engine, false, false, undefined, signature)!;
                return {
                    renderable: partner,
                    pipeline: opaquePipeline,
                    update: binding.update,
                    _updateBatches: [binding._updateBatch],
                    draw(pass) {
                        pass.setIndexBuffer(indices, "uint32");
                        binding.draw(pass, meshes[0]!._gpu, 1);
                        return 1;
                    },
                };
            },
        };
        scene._renderables = [source, partner];
        nativeTask._renderables = scene._renderables;
        nativeTask.record();
        const lodDepth = [];
        for (let frame = 0; frame < 2; frame++) {
            scene._renderableVersion++;
            engine._currentEncoder = device.createCommandEncoder();
            dispatch(engine._currentEncoder, readDepth, [recordNative(), depthReadback]);
            device.queue.submit([engine._currentEncoder.finish()]);
            lodDepth.push(new Float32Array(await read(depthReadback, 4))[0]!);
        }
        const nativeCases = [];
        shaders.enableMaterialStencil();
        const sampleLayout = device.createBindGroupLayout({
            entries: Array.from({ length: 9 }, (_, binding) => ({
                binding,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: binding === 0 ? "uniform" : "read-only-storage" },
            })),
        });
        const sampleModule = device.createShaderModule({ code: shaders.gpsCompositeShader(4) });
        const sampleComposite = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [shaders.getSceneBindGroupLayout(engine), sampleLayout] }),
            vertex: { module: sampleModule, entryPoint: "vs" },
            fragment: {
                module: sampleModule,
                entryPoint: "fs",
                targets: [
                    {
                        format: "rgba8unorm",
                        blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } },
                    },
                ],
            },
            depthStencil: { format: "depth24plus-stencil8", depthWriteEnabled: false, depthCompare: "always" },
            multisample: { count: 4 },
        });
        const resolveMsaa = compute(shaders.gpsResolveShader(true, "greater-equal", false, 4));
        const cardMaterial = (opacity: number, half = false, depthWrite = true, blended = false): NativeShader.ShaderMaterial => {
            const mat = shaders.createShaderMaterial({
                vertexSource: shaders.wgsl`@vertex fn mainVertex(input:VertexInput)->@builtin(position) vec4f {
return vec4f(input.position.x*shaderUniforms.width+shaderUniforms.offset,input.position.y*2.0,0.6,1.0); }`,
                fragmentSource: shaders.wgsl`@fragment fn mainFragment()->@location(0) vec4f { return vec4f(1.0,0.0,0.0,shaderUniforms.opacity); }`,
                attributes: ["position"],
                uniforms: [
                    { name: "opacity", type: "f32" },
                    { name: "width", type: "f32" },
                    { name: "offset", type: "f32" },
                ],
                backFaceCulling: false,
                depthWrite,
                needAlphaBlending: blended,
            });
            shaders.setShaderFloat(mat, "opacity", opacity);
            shaders.setShaderFloat(mat, "width", half ? 1 : 2);
            shaders.setShaderFloat(mat, "offset", half ? -0.5 : 0);
            shaders.setAlphaToCoverage(mat, true);
            return mat;
        };
        for (const kind of ["zero", "partial", "silhouette", "stencil", "shared", "eager", "transmission", "viewport", "transparent"] as const) {
            const width = kind === "stencil" ? 2 : kind === "viewport" ? 101 : 1;
            const outputWidth = kind === "viewport" ? 51 : width;
            const rt = shaders.createRenderTarget({ samples: 4, format: "rgba8unorm", dFormat: kind === "eager" ? undefined : "depth24plus-stencil8", size: { width, height: 1 } });
            const resolved = shaders.createRenderTarget({ samples: 1, format: "rgba8unorm", size: { width, height: 1 } });
            const external = kind === "eager" ? shaders.createRenderTarget({ samples: 4, dFormat: "depth24plus-stencil8", size: { width, height: 1 } }) : undefined;
            if (external) {
                shaders.buildRenderTarget(external, engine);
                external._eager = true;
            }
            const task = shaders._createAutomaticRenderTask({ name: kind, rt, rst: resolved, depth: external, autoMirror: false }, engine, scene);
            scene._frameGraph._tasks.push(task);
            const card = shaders.createPlane(engine);
            const cardMat = cardMaterial(kind === "zero" || kind === "viewport" ? 0 : kind === "partial" ? 0.5 : 1, kind === "silhouette", true, kind === "transparent");
            card.material = cardMat;
            const nativeMeshes = [card];
            if (kind === "stencil") {
                const writer = shaders.createPlane(engine);
                const writerMat = cardMaterial(1, true, false);
                writerMat.stencil = { passOp: "increment-clamp" };
                writer.material = writerMat;
                cardMat.stencil = { compare: "equal" };
                nativeMeshes.unshift(writer);
            }
            const nativeRenderables = shaders.buildShaderMaterialRenderables(scene, nativeMeshes).renderables;
            const cpu = uniforms(true);
            cpu[52] = cpu[56] = outputWidth;
            cpu[68] = cpu[69] = 8;
            cpu.set([0, 4, kind === "viewport" ? 50 : 0, 0], 76);
            const planes = Array.from({ length: 4 }, (_, sample) => {
                cpu[76] = sample;
                return {
                    params: make(cpu, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
                    accumulation: make(new Float32Array(outputWidth * 4)),
                    geometricDepth: make(new Float32Array(outputWidth)),
                    counts: make(new Uint32Array(outputWidth)),
                    previous: make(new Float32Array(outputWidth)),
                };
            });
            const image = make(new Uint32Array(outputWidth).fill(31));
            const hiz = make(new Float32Array(outputWidth));
            const pointDepth = shaders.gpsCreateSceneDepth();
            let pointContext: DrawUpdateContext;
            let consumingTask = task;
            const point: Renderable = {
                order: 200,
                isTransparent: true,
                bind() {
                    return {
                        renderable: point,
                        pipeline: sampleComposite,
                        update(context) {
                            pointContext = context;
                        },
                        draw(pass) {
                            if (
                                !shaders.gpsWithPassDepth(pass, () => {
                                    if (
                                        !shaders.gpsRecordSceneDepth(pointDepth, scene, engine, consumingTask._targetSignature, pointContext, shaders.gpsPassHasDraws(pass)) ||
                                        !pointDepth.view
                                    ) {
                                        throw new Error(`Missing native ${kind} depth`);
                                    }
                                    const view = pointDepth.view;
                                    planes.forEach(({ params, accumulation, geometricDepth, counts, previous }) =>
                                        dispatch(
                                            engine._currentEncoder,
                                            resolveMsaa,
                                            [params, image, accumulation, geometricDepth, counts, hiz, total, previous, view],
                                            Math.ceil(outputWidth / 8)
                                        )
                                    );
                                })
                            ) {
                                throw new Error("Native visibility barrier missing");
                            }
                            pass.setPipeline(sampleComposite);
                            pass.setBindGroup(
                                1,
                                device.createBindGroup({
                                    layout: sampleLayout,
                                    entries: [planes[0]!.params, ...planes.map((plane) => plane.accumulation), ...planes.map((plane) => plane.geometricDepth)].map(
                                        (buffer, binding) => ({ binding, resource: { buffer } })
                                    ),
                                })
                            );
                            pass.draw(3);
                            return 1;
                        },
                    };
                },
            };
            let overlay: NativeTasks.RenderTaskBase | undefined;
            if (kind === "shared" || kind === "eager") {
                task._renderables = nativeRenderables;
                task.record();
                overlay = shaders._createAutomaticRenderTask(
                    { name: `${kind}-overlay`, rt, rst: resolved, depth: external, sharedRt: true, depthClear: false, clr: false, autoMirror: false },
                    engine,
                    scene
                );
                overlay._renderables = [point];
                scene._frameGraph._tasks.push(overlay);
                consumingTask = overlay;
                overlay.record();
            } else {
                task._renderables = [...nativeRenderables, point];
                if (kind === "transmission") {
                    const segment = (order: number): Renderable => {
                        const r: Renderable = { order, isTransparent: true, _transmissive: true, bind: () => ({ renderable: r, pipeline: sampleComposite, draw: () => 0 }) };
                        return r;
                    };
                    task._renderables.push(segment(199), segment(201));
                    shaders.enableRenderTaskTransmission(task as RenderTask, engine, { linear: false, generateMipmaps: false, copyCount: 0 });
                }
                task.record();
            }
            if (kind === "viewport") {
                camera.viewport = { x: 0.5, y: 0, width: 0.5, height: 1 };
            }
            const release = shaders.installGpsPasses(scene);
            engine._currentEncoder = device.createCommandEncoder();
            device.queue.writeBuffer(total, 4, new Float32Array([1]));
            if (external) {
                engine._currentEncoder
                    .beginRenderPass({
                        colorAttachments: [],
                        depthStencilAttachment: {
                            view: external._depthView!,
                            depthLoadOp: "clear",
                            depthStoreOp: "store",
                            depthClearValue: 0,
                            stencilLoadOp: "clear",
                            stencilStoreOp: "store",
                            stencilClearValue: 0,
                        },
                    })
                    .end();
            }
            task.execute!();
            overlay?.execute!();
            const output = make(new Uint32Array((256 * 2) / 4), GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
            engine._currentEncoder.copyTextureToBuffer({ texture: resolved._colorTexture!, origin: [kind === "viewport" ? 100 : 0, 0] }, { buffer: output, bytesPerRow: 256 }, [
                kind === "stencil" ? 2 : 1,
                1,
            ]);
            device.queue.submit([engine._currentEncoder.finish()]);
            await output.mapAsync(GPUMapMode.READ);
            nativeCases.push({ kind, color: Array.from(new Uint8Array(output.getMappedRange().slice(0, kind === "stencil" ? 8 : 4))) });
            output.unmap();
            camera.viewport = undefined;
            release();
            overlay?.dispose?.();
            task.dispose?.();
            shaders.disposeRenderTarget(external);
            scene._frameGraph._tasks = scene._frameGraph._tasks.filter((candidate) => candidate !== task && candidate !== overlay);
        }
        const monitored: Record<string, GPUBuffer[]> = {};
        const createBuffer = device.createBuffer.bind(device);
        device.createBuffer = (descriptor) => {
            const tracked = descriptor.label === "GPS visibility dispatch" || descriptor.label === "GPS accumulation";
            const buffer = createBuffer(tracked ? { ...descriptor, usage: descriptor.usage | GPUBufferUsage.COPY_SRC } : descriptor);
            if (tracked) {
                (monitored[descriptor.label!] ??= []).push(buffer);
            }
            return buffer;
        };
        const staticData = [
            [0, 0, 0, 1],
            [0.01, 0, 0, 0],
            [0.01, 0, 0.01, 0],
            [0, 0, 1, 1],
        ].map((data) => {
            const texture = device.createTexture({ size: [1, 1], format: "rgba32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
            device.queue.writeTexture({ texture }, new Float32Array(data), {}, [1, 1]);
            return texture;
        });
        const worldMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const target = {
            vertexCount: 1,
            textureWidth: 1,
            shDegree: 0,
            worldMatrix,
            boundMin: [-0.1, -0.1, -0.1],
            boundMax: [0.1, 0.1, 0.1],
            _gs: {
                _centersView: staticData[0]!.createView(),
                _covAView: staticData[1]!.createView(),
                _covBView: staticData[2]!.createView(),
                _colorsView: staticData[3]!.createView(),
            },
        } as unknown as GaussianSplattingMesh;
        const gps: GaussianPointSplatting = {
            _target: target,
            _dataVersion: 0,
            _disabled: false,
            _dispose: null,
            _progress: null,
            colorRenderMode: true,
            depthRenderMode: false,
            depthVisualization: "none",
            pointScale: 1000,
            renderScale: 1,
            maxAccumFrames: 4,
            temporalReprojection: true,
            occlusionCulling: true,
            get progress() {
                return this._progress;
            },
        };
        const cube = device.createTexture({ size: [1, 1, 6], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        for (let layer = 0; layer < 6; layer++) {
            device.queue.writeTexture({ texture: cube, origin: [0, 0, layer] }, new Uint8Array([0, 128, 0, 255]), {}, [1, 1]);
        }
        const skybox = await shaders.buildHdrSkyboxRenderable(
            scene,
            { specularCubeView: cube.createView({ dimension: "cube" }), cubeSampler: device.createSampler() } as EnvironmentTextures,
            100,
            [0, 0, 0],
            [1, 1, 1]
        );
        const points = shaders.createGpsRenderable(scene, gps);
        const monitorRt = shaders.createRenderTarget({ samples: 4, format: "rgba8unorm", dFormat: "depth24plus-stencil8", size: { width: 1, height: 1 } });
        const monitorTask = shaders._createAutomaticRenderTask({ name: "skybox-convergence", rt: monitorRt, autoMirror: false }, engine, scene);
        monitorTask._renderables = [skybox, points.renderable];
        scene._frameGraph._tasks.push(monitorTask);
        monitorTask.record();
        let linearRasterCount = 0;
        const monitorFrame = (): number => {
            let nativePasses = 0;
            scene._beforeRender.forEach((hook) => hook(0));
            engine._currentEncoder = device.createCommandEncoder();
            const begin = engine._currentEncoder.beginRenderPass.bind(engine._currentEncoder);
            engine._currentEncoder.beginRenderPass = (descriptor) => {
                if (descriptor.label === "GPS linear discs") {
                    linearRasterCount++;
                }
                if (descriptor.depthStencilAttachment?.view === monitorRt._depthView) {
                    nativePasses++;
                }
                return begin(descriptor);
            };
            monitorTask.execute!();
            device.queue.submit([engine._currentEncoder.finish()]);
            return nativePasses;
        };
        for (let frame = 0; frame < 6; frame++) {
            monitorFrame();
        }
        const readWork = async (): Promise<number[]> => Array.from(new Uint32Array(await read(monitored["GPS visibility dispatch"]!.at(-1)!, 40)));
        const readAccumulation = async (samples = 4): Promise<number[]> => {
            const planes = await Promise.all(monitored["GPS accumulation"]!.slice(-samples).map(async (buffer) => Array.from(new Float32Array(await read(buffer, 16)))));
            return planes.flat();
        };
        const skyboxWork = await readWork();
        const skyboxProgress = gps.progress;
        const monitorCard = shaders.createPlane(engine);
        monitorCard.material = cardMaterial(1);
        monitorTask._renderables.splice(1, 0, ...shaders.buildShaderMaterialRenderables(scene, [monitorCard]).renderables);
        monitorTask.record();
        monitorFrame();
        const changedWork = await readWork();
        for (let frame = 0; frame < 5; frame++) {
            monitorFrame();
        }
        const reconvergedWork = await readWork();
        worldMatrix[12] = 3.5;
        monitorFrame();
        const front = await readAccumulation();
        const version = gps.progress!.accumulationVersion;
        worldMatrix[12] = 0;
        monitorFrame();
        const behind = await readAccumulation();
        const crossedVersion = gps.progress!.accumulationVersion;
        monitorCard.material = cardMaterial(1, false, true, true);
        const transparentWriters = shaders.buildShaderMaterialRenderables(scene, [monitorCard]).renderables;
        monitorTask._renderables = [...transparentWriters, points.renderable];
        monitorTask.record();
        for (let frame = 0; frame < 5; frame++) {
            monitorFrame();
        }
        const transparentHidden = await readAccumulation();
        shaders.setMeshVisible(monitorCard, false);
        monitorFrame();
        const transparentRevealed = await readAccumulation(1);
        shaders.setMeshVisible(monitorCard, true);
        monitorFrame();
        const transparentWake = await readWork();
        for (let frame = 0; frame < 5; frame++) {
            monitorFrame();
        }
        const transparentConverged = await readWork();
        gps.depthRenderMode = true;
        gps.depthVisualization = "linear";
        monitorFrame();
        const hiddenDiscs = await readAccumulation();
        for (let frame = 0; frame < 5; frame++) {
            monitorFrame();
        }
        shaders.setMeshVisible(monitorCard, false);
        monitorFrame();
        const revealedDiscs = await readAccumulation();
        const linearProgress = gps.progress;
        monitorTask._renderables = [points.renderable];
        monitorTask.record();
        monitorFrame();
        const pureConvergedPasses = monitorFrame();
        shaders.setMeshVisible(monitorCard, true);
        monitorTask._renderables = [...transparentWriters, points.renderable];
        monitorTask.record();
        monitorFrame();
        points.dispose();
        monitorTask.dispose?.();
        device.createBuffer = createBuffer;
        staticData.forEach((texture) => texture.destroy());
        cube.destroy();
        await device.queue.onSubmittedWorkDone();
        const validation = await device.popErrorScope();
        buffers.forEach((buffer) => buffer.destroy());
        texture.destroy();
        depthTexture.destroy();
        opaqueTexture.destroy();
        fixedDiscDepth.destroy();
        nativeTask.dispose?.();
        scene._disposables.forEach((dispose) => dispose());
        scene._meshDisposables.forEach((disposers) => disposers.forEach((dispose) => dispose()));
        device.destroy();
        return {
            radianceCases,
            depthCases,
            mixedCases,
            distribution,
            linearCases,
            opaqueDepth,
            mergedCount,
            mergedHasMesh,
            mergedDepth,
            mergedVisibility,
            lodDepth,
            signatureCount: signatures.size,
            nativeCases,
            skyboxWork,
            skyboxProgress,
            changedWork,
            reconvergedWork,
            front,
            behind,
            version,
            crossedVersion,
            hiddenDiscs,
            revealedDiscs,
            linearRasterCount,
            linearProgress,
            transparentHidden,
            transparentRevealed,
            transparentWake,
            transparentConverged,
            pureConvergedPasses,
            gpuErrors,
            validation: validation?.message,
        };
    });
    expect(errors).toEqual([]);
    expect(result.gpuErrors).toEqual([]);
    expect(result.validation).toBeUndefined();
    expect(result.opaqueDepth).toBeCloseTo(0.6, 6);
    expect(result.mergedCount).toBe(1);
    expect(result.mergedHasMesh).toBe(false);
    expect(result.mergedDepth).toBeGreaterThan(0);
    expect(result.mergedVisibility).toEqual([
        [0, 0, 0, 0],
        [0, 0, 1, 1],
    ]);
    result.lodDepth.forEach((depth) => expect(depth).toBeCloseTo(0.6, 6));
    expect(result.signatureCount).toBe(1);
    for (const { kind, color } of result.nativeCases) {
        const expected =
            kind === "stencil"
                ? [0, 0, 255, 255, 255, 0, 0, 255]
                : kind === "zero" || kind === "viewport"
                  ? [0, 0, 255, 255]
                  : kind === "partial"
                    ? [128, 0, 128, 192]
                    : kind === "silhouette"
                      ? [128, 0, 128, 255]
                      : [255, 0, 0, 255];
        color.forEach((value, channel) => expect(Math.abs(value - expected[channel]!)).toBeLessThanOrEqual(1));
    }
    expect(result.skyboxProgress).toMatchObject({ renderedFrameCount: 4, accumulatedSamples: 4 });
    expect([result.skyboxWork[0], result.skyboxWork[1], result.skyboxWork[4], result.skyboxWork[7]]).toEqual([0, 0, 0, 0]);
    expect([result.changedWork[0], result.changedWork[1], result.changedWork[4], result.changedWork[7]]).toEqual([1, 1, 1, 257]);
    expect([result.reconvergedWork[0], result.reconvergedWork[1], result.reconvergedWork[4], result.reconvergedWork[7]]).toEqual([0, 0, 0, 0]);
    for (let sample = 0; sample < 4; sample++) {
        expect(result.front[sample * 4 + 3]).toBe(1);
        expect(result.behind.slice(sample * 4, sample * 4 + 4)).toEqual([0, 0, 0, 0]);
        expect(result.hiddenDiscs.slice(sample * 4, sample * 4 + 4)).toEqual([0, 0, 0, 0]);
        expect(result.revealedDiscs[sample * 4 + 3]).toBe(1);
    }
    expect(result.crossedVersion).toBe(result.version + 1);
    expect(result.linearRasterCount).toBe(1);
    expect(result.linearProgress?.renderedFrameCount).toBe(1);
    expect(result.pureConvergedPasses).toBe(1);
    expect(result.transparentHidden).toEqual(new Array<number>(16).fill(0));
    expect(result.transparentRevealed).toEqual([0, 0, 1, 1]);
    expect(result.transparentWake[0]).toBe(1);
    expect(result.transparentConverged[0]).toBe(0);
    expect(result.distribution[1]).toEqual(result.distribution[0]);
    expect(result.distribution[0]![0]).toBeGreaterThan(0.05);
    expect(result.distribution[0]![2]).toBeGreaterThan(0.05);
    for (const entry of result.linearCases) {
        expect(entry.weights).toEqual([1, 1]);
        for (let pixel = 0; pixel < 5; pixel++) {
            const expected = pixel === 0 || pixel === 4 ? 0.7 : 0.1;
            entry.color.slice(pixel * 4, pixel * 4 + 3).forEach((value) => expect(value).toBeCloseTo(expected, 5));
            expect(entry.color[pixel * 4 + 3]).toBe(1);
        }
    }
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
    for (const entry of result.mixedCases) {
        const expected = entry.visualization === 0 ? [0.5, 0, 0, 0.5] : [0.4, 0.4, 0.4, 1];
        entry.average.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 5));
        if (entry.visualization === 0) {
            expect(entry.revealed).toEqual([0, 0, 1, 1]);
        }
        expect(entry.hidden).toEqual([0, 0, 0, 0]);
    }
});
