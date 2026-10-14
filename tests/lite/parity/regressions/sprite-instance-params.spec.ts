import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import type * as Lite from "../../../../packages/babylon-lite/src/index.js";
import type * as SpritePipeline from "../../../../packages/babylon-lite/src/sprite/sprite-pipeline.js";

const liteUrl = `/@fs/${resolve(__dirname, "../../../../packages/babylon-lite/src/index.ts").replaceAll("\\", "/")}`;
const pipelineUrl = `/@fs/${resolve(__dirname, "../../../../packages/babylon-lite/src/sprite/sprite-pipeline.ts").replaceAll("\\", "/")}`;

for (const depth of ["none", "test", "test-write"] as const) {
    for (const uvOrder of ["none", "before", "after"] as const) {
        test(`Sprite instance parameters: ${depth}, UV ${uvOrder}, GPU transport and mutants`, async ({ page }, testInfo) => {
            await page.route("**/", (route) => route.fulfill({ contentType: "text/html", body: '<canvas id="witness" width="64" height="32"></canvas>' }));
            await page.goto("/");
            const result = await page.evaluate(
                async ({ liteUrl, pipelineUrl, depth, uvOrder }) => {
                    const NativeF32 = globalThis.Float32Array;
                    const nativeSubarray = NativeF32.prototype.subarray;
                    let constructions = 0;
                    let views = 0;
                    globalThis.Float32Array = new Proxy(NativeF32, {
                        construct(target, args) {
                            constructions++;
                            return Reflect.construct(target, args);
                        },
                    });
                    NativeF32.prototype.subarray = function (begin, end) {
                        views++;
                        return nativeSubarray.call(this, begin, end);
                    };
                    const lite: typeof Lite = await import(liteUrl);
                    const helpers: typeof SpritePipeline = await import(pipelineUrl);
                    const canvas = document.querySelector<HTMLCanvasElement>("#witness")!;
                    const engine = await lite.createEngine(canvas, { msaaSamples: 1 });
                    const device = engine._device;
                    const resources: (GPUBuffer | GPUTexture)[] = [];
                    const fxAttachments: ReturnType<Lite.Sprite2DCustomShader["_createLayerFx"]>[] = [];
                    const atlas = lite.createGridSpriteAtlas(lite.createTexture2DFromPixels(engine, new Uint8Array([255, 255, 255, 255]), 1, 1), {
                        cellWidthPx: 1,
                        cellHeightPx: 1,
                    });
                    const originalWrite = device.queue.writeBuffer;
                    const invokeWrite = originalWrite.bind(device.queue);
                    let instanceBuffer: GPUBuffer | null = null;
                    const writes: { offset: number; bytes: number }[] = [];
                    device.queue.writeBuffer = function (buffer, offset, data, dataOffset, size) {
                        if (buffer === instanceBuffer) {
                            writes.push({ offset, bytes: size ?? data.byteLength });
                        }
                        invokeWrite(buffer, offset, data, dataOffset, size);
                    };
                    try {
                        const shader = lite.createSprite2DCustomShader({
                            fragment: "return in.instanceParams * in.tint + vec4f(0, 0, in.uv.x * 0.125 + in.uv.y * 0.25, 0);",
                        });
                        const layer = lite.createSprite2DLayer(atlas, { depth, capacity: 2, customShader: shader, blendMode: lite.spriteBlendOpaque });
                        lite.addSprite2DIndex(layer, { positionPx: [16, 16], sizePx: [32, 32], color: [0.5, 0.75, 0.5, 0.5], z: 0.5 });
                        lite.addSprite2DIndex(layer, { positionPx: [48, 16], sizePx: [32, 32], color: [0.5, 0.75, 0.5, 0.5], z: 0.5 });
                        const oldBuffer = helpers.createSpriteInstanceBuffer(device, layer);
                        resources.push(oldBuffer);
                        if (uvOrder === "before") {
                            lite.setSprite2DUvOffset(layer, 0, [0.25, 0.5]);
                            lite.setSprite2DUvOffset(layer, 1, [0.25, 0.5]);
                        }
                        lite.enableSprite2DInstanceParams(layer);
                        if (uvOrder === "after") {
                            lite.setSprite2DUvOffset(layer, 0, [0.25, 0.5]);
                            lite.setSprite2DUvOffset(layer, 1, [0.25, 0.5]);
                        }
                        lite.setSprite2DInstanceParamsIndex(layer, 0, [0.5, 0.25, 0.5, 0.5]);
                        const values = new NativeF32([1, 0.5, 1, 1]);
                        lite.setSprite2DInstanceParamsIndex(layer, 1, values);
                        const grown = helpers.ensureSpriteInstanceBuffer(device, layer, oldBuffer, 2);
                        instanceBuffer = grown.buffer;
                        resources.push(instanceBuffer);
                        let version = helpers.uploadSpriteInstances(device, layer, instanceBuffer, -1);
                        helpers.uploadSpriteInstances(device, layer, instanceBuffer, version);

                        // Count the constructor captured by the engine's F32 alias, not merely
                        // the global constructor after module import. Time is evidence, not a noisy gate.
                        const staging = layer._instanceData;
                        const beforeConstructions = constructions;
                        const beforeViews = views;
                        const iterations = 50_000;
                        const start = performance.now();
                        for (let index = 0; index < iterations; index++) {
                            lite.setSprite2DInstanceParamsIndex(layer, 1, values);
                        }
                        const durationMs = performance.now() - start;
                        const allocatedArrays = constructions - beforeConstructions;
                        const allocatedViews = views - beforeViews;
                        version = helpers.uploadSpriteInstances(device, layer, instanceBuffer, version);
                        helpers.uploadSpriteInstances(device, layer, instanceBuffer, version);
                        const ubo = new NativeF32(helpers.LAYER_UBO_FLOATS);
                        helpers.buildSpriteLayerUbo(layer, 64, 32, ubo);
                        const uniform = device.createBuffer({ size: helpers.LAYER_UBO_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                        const indices = device.createBuffer({ size: 12, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
                        const readback = device.createBuffer({ size: 64 * 32 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
                        const output = device.createTexture({ size: [64, 32], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
                        const depthTexture =
                            depth === "none" ? null : device.createTexture({ size: [64, 32], format: "depth24plus-stencil8", usage: GPUTextureUsage.RENDER_ATTACHMENT });
                        resources.push(uniform, indices, readback, output);
                        if (depthTexture) {
                            resources.push(depthTexture);
                        }
                        device.queue.writeBuffer(uniform, 0, ubo.buffer);
                        device.queue.writeBuffer(indices, 0, new Uint16Array([0, 1, 2, 0, 2, 3]));
                        const cache = helpers.createSpritePipelineCache();
                        const sceneLayout = device.createBindGroupLayout({ entries: [] });
                        const originalExtension = layer._vertexExtension!;
                        const originalUvAttribute = layer._uvScrollAttr;
                        const pixels: number[][][] = [];
                        const mutations = ["none", "zero-varying", "color-offset", "missing-first-instance"];
                        if (originalUvAttribute) {
                            mutations.push("uv-offset");
                        }
                        for (const mutation of mutations) {
                            layer._vertexExtension = {
                                ...originalExtension,
                                _key: originalExtension._key + mutation,
                                _shaderKey: originalExtension._shaderKey + (mutation === "zero-varying" ? ":zero" : ""),
                                _assignment: mutation === "zero-varying" ? "out.instanceParams = vec4f(0);" : originalExtension._assignment,
                                _attribute: mutation === "color-offset" ? { ...originalExtension._attribute, offset: 36 } : originalExtension._attribute,
                            };
                            layer._uvScrollAttr = mutation === "uv-offset" ? { ...originalUvAttribute!, offset: originalExtension._attribute.offset } : originalUvAttribute;
                            device.pushErrorScope("validation");
                            const pipeline = helpers.getOrCreateSpritePipeline(
                                engine,
                                cache,
                                "rgba8unorm",
                                1,
                                layer.blendMode,
                                depth !== "none",
                                depth === "test-write",
                                depthTexture ? "depth24plus-stencil8" : undefined,
                                depthTexture ? sceneLayout : undefined,
                                layer
                            );
                            const fx = shader._createLayerFx(engine, "instance-param-witness-fx");
                            fxAttachments.push(fx);
                            const bindGroup = helpers.createSpriteLayerBindGroup(engine, pipeline, depth === "none" ? 0 : 1, layer, uniform, fx);
                            const encoder = device.createCommandEncoder();
                            const passDescriptor: GPURenderPassDescriptor = {
                                colorAttachments: [{ view: output.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
                            };
                            if (depthTexture) {
                                passDescriptor.depthStencilAttachment = {
                                    view: depthTexture.createView(),
                                    depthClearValue: 0,
                                    depthLoadOp: "clear",
                                    depthStoreOp: "store",
                                    stencilClearValue: 0,
                                    stencilLoadOp: "clear",
                                    stencilStoreOp: "discard",
                                };
                            }
                            const pass = encoder.beginRenderPass(passDescriptor);
                            pass.setPipeline(pipeline);
                            if (depthTexture) {
                                pass.setBindGroup(0, device.createBindGroup({ layout: sceneLayout, entries: [] }));
                            }
                            pass.setBindGroup(depth === "none" ? 0 : 1, bindGroup);
                            pass.setVertexBuffer(0, instanceBuffer);
                            pass.setIndexBuffer(indices, "uint16");
                            pass.drawIndexed(6, mutation === "missing-first-instance" ? 1 : 2, 0, 0, mutation === "missing-first-instance" ? 1 : 0);
                            pass.end();
                            encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: 256 }, [64, 32]);
                            device.queue.submit([encoder.finish()]);
                            await readback.mapAsync(GPUMapMode.READ);
                            const bytes = new Uint8Array(readback.getMappedRange());
                            pixels.push([8, 24, 40, 56].map((x) => Array.from(bytes.slice((16 * 64 + x) * 4, (16 * 64 + x) * 4 + 4))));
                            readback.unmap();
                            const validation = await device.popErrorScope();
                            if (validation) {
                                throw new Error(`Sprite instance-parameter ${mutation} GPU validation: ${validation.message}`);
                            }
                        }
                        return {
                            pixels,
                            writes,
                            reallocated: grown.reallocated,
                            stagingRetained: staging === layer._instanceData,
                            gpuBytes: instanceBuffer.size,
                            stagingBytes: staging.byteLength,
                            stride: layer._instanceStrideBytes,
                            benchmark: { iterations, durationMs, allocatedArrays, allocatedViews },
                        };
                    } finally {
                        device.queue.writeBuffer = originalWrite;
                        globalThis.Float32Array = NativeF32;
                        NativeF32.prototype.subarray = nativeSubarray;
                        for (const fx of fxAttachments) {
                            fx.destroy();
                        }
                        for (const resource of resources) {
                            resource.destroy();
                        }
                        lite.disposeSpriteAtlas(atlas);
                        lite.disposeEngine(engine);
                    }
                },
                { liteUrl, pipelineUrl, depth, uvOrder }
            );
            // Independent pixel-center UVs: quads occupy x=[0,32] and [32,64], y=[0,32].
            const expected = [8, 24, 40, 56].map((x) => {
                const u = ((x % 32) + 0.5) / 32 + (uvOrder === "none" ? 0 : 0.25);
                const v = 16.5 / 32 + (uvOrder === "none" ? 0 : 0.5);
                const multiplier = x < 32 ? 0.5 : 1;
                return [0.5 * multiplier, 0.375 * multiplier, 0.5 * multiplier + u * 0.125 + v * 0.25, 0.5 * multiplier].map((channel) => Math.round(channel * 255));
            });
            for (let pixel = 0; pixel < expected.length; pixel++) {
                for (let channel = 0; channel < 4; channel++) {
                    expect(Math.abs(result.pixels[0]![pixel]![channel]! - expected[pixel]![channel]!)).toBeLessThanOrEqual(1);
                }
            }
            expect(result.pixels).toHaveLength(uvOrder === "none" ? 4 : 5);
            for (const mutant of result.pixels.slice(1)) {
                expect(mutant).not.toEqual(result.pixels[0]);
            }
            expect(result.reallocated).toBe(true);
            expect(result.stagingRetained).toBe(true);
            const stride = (depth === "none" ? 13 : 14) * 4 + 16 + (uvOrder === "none" ? 0 : 8);
            expect(result.stride).toBe(stride);
            expect(result.gpuBytes).toBe(2 * stride);
            expect(result.stagingBytes).toBe(2 * stride);
            expect(result.writes).toEqual([
                { offset: 0, bytes: 2 * stride },
                { offset: stride, bytes: stride },
            ]);
            expect(result.benchmark.allocatedArrays).toBe(0);
            expect(result.benchmark.allocatedViews).toBe(0);
            await testInfo.attach("instance-params-transport-and-cost", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
        });
    }
}
