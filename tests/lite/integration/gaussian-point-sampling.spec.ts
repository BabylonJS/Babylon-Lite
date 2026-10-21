import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { resolve } from "node:path";
import type * as GpsShaders from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-shaders.js";
import type * as GpsSceneDepth from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-scene-depth.js";
import type { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate.js";
import type { getSceneBindGroupLayout } from "../../../packages/babylon-lite/src/render/scene-helpers.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable.js";
import type { createBox } from "../../../packages/babylon-lite/src/mesh/mesh-factories.js";
import type { createLinearDepthMaterial } from "../../../packages/babylon-lite/src/render/linear-depth-material.js";
import type { buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import type { ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance.js";
import type { publishTiLodBucket } from "../../../packages/babylon-lite/src/mesh/thin-instance-gpu-culling.js";
import type { tryBind } from "../../../packages/babylon-lite/src/mesh/thin-instance-cull-binding.js";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target.js";

type GpuTestApi = typeof GpsShaders &
    typeof GpsSceneDepth & {
        createArcRotateCamera: typeof createArcRotateCamera;
        getSceneBindGroupLayout: typeof getSceneBindGroupLayout;
        createBox: typeof createBox;
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
export { createArcRotateCamera } from "./packages/babylon-lite/src/camera/arc-rotate.js";
export { getSceneBindGroupLayout } from "./packages/babylon-lite/src/render/scene-helpers.js";
export { createBox } from "./packages/babylon-lite/src/mesh/mesh-factories.js";
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
        } as unknown as SceneContext;
        const prepass = shaders.gpsCreateSceneDepth(device);
        buffers.push(prepass.uniforms);
        engine._currentEncoder = device.createCommandEncoder();
        shaders.gpsRecordSceneDepth(
            prepass,
            scene,
            engine,
            { _sampleCount: 1, _colorFormat: "rgba8unorm", _depthStencilFormat: "depth32float" },
            { targetWidth: 1, targetHeight: 1, _camera: camera },
            (textures) => textures.forEach((texture) => texture.destroy())
        );
        const depthReadback = make(new Float32Array(1));
        const readDepth = compute(`
@group(0) @binding(0) var source:texture_depth_2d;
@group(0) @binding(1) var<storage,read_write> result:array<f32>;
@compute @workgroup_size(1) fn main() { result[0]=textureLoad(source,vec2i(0),0); }
`);
        dispatch(engine._currentEncoder, readDepth, [prepass.view, depthReadback]);
        device.queue.submit([engine._currentEncoder.finish()]);
        const opaqueDepth = new Float32Array(await read(depthReadback, 4))[0]!;
        scene._meshDisposables = new Map();
        const material = shaders.createLinearDepthMaterial();
        const meshes = [shaders.createBox(engine, 4), shaders.createBox(engine, 4)];
        meshes.forEach((mesh) => (mesh.material = material));
        scene._renderables = shaders.buildShaderMaterialRenderables(scene, meshes).renderables;
        const mergedCount = scene._renderables.length;
        const mergedHasMesh = !!scene._renderables[0]?.mesh;
        scene._renderableVersion++;
        engine._currentEncoder = device.createCommandEncoder();
        shaders.gpsRecordSceneDepth(
            prepass,
            scene,
            engine,
            { _sampleCount: 1, _colorFormat: "rgba8unorm", _depthStencilFormat: "depth32float" },
            { targetWidth: 1, targetHeight: 1, _camera: camera },
            (textures) => textures.forEach((texture) => texture.destroy())
        );
        dispatch(engine._currentEncoder, readDepth, [prepass.view, depthReadback]);
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
            meshes.forEach((mesh) => (mesh.visible = !hidden));
            device.queue.writeBuffer(total, 4, new Float32Array([1]));
            device.queue.writeBuffer(mergedImage, 0, new Uint32Array([31]));
            mergedCpu[66] = hidden ? 3 : 1;
            device.queue.writeBuffer(mergedParams, 0, mergedCpu);
            engine._currentEncoder = device.createCommandEncoder();
            shaders.gpsRecordSceneDepth(
                prepass,
                scene,
                engine,
                { _sampleCount: 1, _colorFormat: "rgba8unorm", _depthStencilFormat: "depth32float" },
                { targetWidth: 1, targetHeight: 1, _camera: camera },
                (textures) => textures.forEach((texture) => texture.destroy())
            );
            dispatch(engine._currentEncoder, resolveOccluded, [
                mergedParams,
                mergedImage,
                mergedAccumulation,
                mergedGeometricDepth,
                mergedCounts,
                mergedHiZ,
                total,
                mergedPrevious,
                prepass.view,
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
        const lodDepth = [];
        for (let frame = 0; frame < 2; frame++) {
            scene._renderableVersion++;
            engine._currentEncoder = device.createCommandEncoder();
            shaders.gpsRecordSceneDepth(
                prepass,
                scene,
                engine,
                { _sampleCount: 1, _colorFormat: "rgba8unorm", _depthStencilFormat: "depth32float" },
                { targetWidth: 1, targetHeight: 1, _camera: camera },
                (textures) => textures.forEach((texture) => texture.destroy())
            );
            dispatch(engine._currentEncoder, readDepth, [prepass.view, depthReadback]);
            device.queue.submit([engine._currentEncoder.finish()]);
            lodDepth.push(new Float32Array(await read(depthReadback, 4))[0]!);
        }
        await device.queue.onSubmittedWorkDone();
        const validation = await device.popErrorScope();
        buffers.forEach((buffer) => buffer.destroy());
        texture.destroy();
        depthTexture.destroy();
        opaqueTexture.destroy();
        fixedDiscDepth.destroy();
        prepass.texture.destroy();
        prepass.color?.destroy();
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
