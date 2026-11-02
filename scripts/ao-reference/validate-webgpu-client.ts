import * as core from "../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import type { AoFixtureRecord } from "./generate.js";

export async function validateFixtures(fixtures: readonly AoFixtureRecord[]) {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable in the validation browser.");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter is available.");
    const device = await adapter.requestDevice();
    const errors: string[] = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    const bytes = async (id: string, name: string): Promise<ArrayBuffer> => {
        const response = await fetch(`/reference/lite/ao-reference/${id}/${name}`);
        if (!response.ok) throw new Error(`Cannot load AO fixture ${id}/${name}: ${response.status}`);
        return response.arrayBuffer();
    };
    const readTexture = async (texture: GPUTexture, width: number, height: number, pixelBytes: number, mipLevel = 0): Promise<Uint8Array<ArrayBuffer>> => {
        const pitch = Math.ceil((width * pixelBytes) / 256) * 256;
        const buffer = device.createBuffer({ size: pitch * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture, mipLevel }, { buffer, bytesPerRow: pitch }, { width, height });
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(buffer.getMappedRange());
            const output = new Uint8Array(width * height * pixelBytes);
            for (let y = 0; y < height; y++) output.set(mapped.subarray(y * pitch, y * pitch + width * pixelBytes), y * width * pixelBytes);
            return output;
        } finally {
            buffer.destroy();
        }
    };
    const half = (value: number): number => {
        const exponent = (value >> 10) & 31,
            mantissa = value & 1023,
            sign = value & 32768 ? -1 : 1;
        if (exponent === 31) return mantissa === 0 ? sign * Infinity : NaN;
        return sign * (exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15));
    };
    const stats = (actual: ArrayLike<number>, expected: ArrayLike<number>) => {
        if (actual.length !== expected.length) throw new Error("GPU/native AO comparison dimensions differ.");
        let maximum = 0,
            relativeMaximum = 0,
            total = 0,
            changed = 0;
        for (let i = 0; i < actual.length; i++) {
            if (!Number.isFinite(actual[i]) || !Number.isFinite(expected[i])) throw new Error(`Non-finite GPU comparison value at ${i}`);
            const error = Math.abs(actual[i]! - expected[i]!);
            maximum = Math.max(maximum, error);
            total += error;
            relativeMaximum = Math.max(relativeMaximum, error / Math.max(Math.abs(expected[i]!), 1e-8));
            if (error > 1e-6) changed++;
        }
        return { maximum, relativeMaximum, mean: total / actual.length, changed };
    };
    try {
        const depthUploadModule = device.createShaderModule({
            code: `@group(0) @binding(0) var input:texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];return vec4f(p,0,1);}
@fragment fn fs(@builtin(position) p:vec4f)->@builtin(frag_depth) f32{return textureLoad(input,vec2i(p.xy),0).r;}`,
        });
        const uploadPipeline = device.createRenderPipeline({
            layout: "auto",
            vertex: { module: depthUploadModule, entryPoint: "vs" },
            fragment: { module: depthUploadModule, entryPoint: "fs", targets: [] },
            depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
        });
        const result = [];
        for (const fixture of fixtures) {
            const s = fixture.settings,
                width = s.width,
                height = s.height;
            const input = device.createTexture({ size: [width, height], format: "r32float", usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
            const source = device.createTexture({ size: [width, height], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
            const normal = device.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
            device.queue.writeTexture({ texture: input }, await bytes(fixture.id, "depth.f32"), { bytesPerRow: width * 4 }, [width, height]);
            device.queue.writeTexture({ texture: normal }, await bytes(fixture.id, "normals.f32"), { bytesPerRow: width * 16 }, [width, height]);
            const upload = device.createCommandEncoder();
            const pass = upload.beginRenderPass({
                colorAttachments: [],
                depthStencilAttachment: { view: source.createView(), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 0 },
            });
            pass.setPipeline(uploadPipeline);
            pass.setBindGroup(0, device.createBindGroup({ layout: uploadPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: input.createView() }] }));
            pass.draw(3);
            pass.end();
            device.queue.submit([upload.finish()]);
            const gpu = core.createSsaoGpu(device, width, height, "depth", true);
            const f = Math.fround;
            const near = f(s.near),
                far = f(s.far),
                tanY = f(s.tanHalfFovY);
            core.writeSsaoGpuParameters(gpu, {
                depthMultiply: f(-f(near * far) / f(far - near)),
                depthAdd: f(-near / f(far - near)),
                tanX: f(f(tanY * width) / height),
                tanY,
                far,
                radius: f(s.radius),
                intensity: 1,
            });
            core.bindSsaoGpuSources(gpu, source.createView(), normal.createView());
            try {
                device.pushErrorScope("validation");
                const encoder = device.createCommandEncoder();
                core.executeSsaoGpu(gpu, encoder);
                device.queue.submit([encoder.finish()]);
                const error = await device.popErrorScope();
                if (error) {
                    const diagnostics = await Promise.all(
                        gpu.modules.map(async (module) =>
                            (await module.getCompilationInfo()).messages.filter((message) => message.type === "error").map((message) => message.message)
                        )
                    );
                    throw new Error([error.message, ...diagnostics.flat(), ...errors].join("\n"));
                }
                const outputBytes = await readTexture(gpu.visibility, width, height, 8);
                const outputView = new DataView(outputBytes.buffer);
                const actual = new Float32Array(width * height);
                for (let i = 0; i < actual.length; i++) actual[i] = half(outputView.getUint16(i * 8, true));
                const expected = new Float32Array(await bytes(fixture.id, "xegtao.f32"));
                const stages: Record<string, ReturnType<typeof stats>> = {};
                for (let mip = 0; mip < 5; mip++) {
                    const actualDepth = new Float32Array((await readTexture(gpu.depth, width >> mip, height >> mip, 4, mip)).buffer);
                    stages[`depth${mip}`] = stats(actualDepth, new Float32Array(await bytes(fixture.id, `depth-mip${mip}.f32`)));
                }
                // The working texture packs the native AO word (bits 0-7) with the native edge byte (bits 8-15).
                const working = new Uint32Array((await readTexture(gpu.working!, width, height, 4)).buffer);
                stages.raw = stats(
                    working.map((word) => word & 255),
                    new Uint32Array(await bytes(fixture.id, "xegtao-raw.u32"))
                );
                stages.edges = stats(
                    working.map((word) => (word >>> 8) & 255),
                    new Uint8Array(await bytes(fixture.id, "xegtao-edges.u8"))
                );
                stages.final = stats(actual, expected);
                for (const [name, measurement] of Object.entries(stages)) {
                    if (name.startsWith("depth") && measurement.relativeMaximum > 1e-6) throw new Error(`${fixture.id}/${name}: depth mip parity exceeded one-ppm relative error`);
                    if (name === "edges" && measurement.maximum !== 0) throw new Error(`${fixture.id}: packed edge bits differ from the native oracle`);
                    if (name === "raw" && (measurement.maximum > 1 || measurement.mean > 0.001))
                        throw new Error(`${fixture.id}: raw XeGTAO parity exceeded one-byte rounding tolerance`);
                }
                const quantum = 1 / 255;
                const meanLimit = 0.0001;
                if (stages.final.maximum > quantum + 1 / 4096 || stages.final.mean > meanLimit) {
                    throw new Error(`${fixture.id}/XeGTAO: final AO parity exceeds the native quantization + half-float budget: ${JSON.stringify(stages.final)}`);
                }
                result.push({ fixture: fixture.id, stages, actual: [...actual] });
                if (fixture.id === "corner") {
                    const seen = new Set<string>();
                    for (const quality of ["low", "medium", "high", "ultra", "high"] as const) {
                        const encoder = device.createCommandEncoder();
                        core.executeSsaoGpu(gpu, encoder, quality);
                        device.queue.submit([encoder.finish()]);
                        const variant = await readTexture(gpu.visibility, width, height, 8);
                        const view = new DataView(variant.buffer);
                        for (let p = 0; p < width * height; p++) {
                            const value = half(view.getUint16(p * 8, true));
                            if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`XeGTAO/${quality} preset has invalid output.`);
                        }
                        if (quality === "high" && variant.some((value, i) => value !== outputBytes[i])) {
                            throw new Error("XeGTAO high preset no longer matches the original default or cached pipeline.");
                        }
                        seen.add(Array.from(variant).join(","));
                    }
                    if (seen.size < 2) throw new Error("XeGTAO spatial quality presets did not change the occluded fixture.");
                }
                for (const module of gpu.modules) {
                    const info = await module.getCompilationInfo();
                    for (const message of info.messages) if (message.type === "error") throw new Error(message.message);
                }
            } finally {
                core.disposeSsaoGpu(gpu);
                input.destroy();
                source.destroy();
                normal.destroy();
            }
        }
        for (const [width, height] of [
            [63, 49],
            [1, 1],
            [1, 17],
            [17, 1],
        ] as const) {
            const source = device.createTexture({ size: [width, height], format: "r32float", usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
            const values = new Float32Array(width * height).fill((0.1 * (20 / 3 - 1)) / 19.9);
            device.queue.writeTexture({ texture: source }, values, { bytesPerRow: width * 4 }, [width, height]);
            const gpu = core.createSsaoGpu(device, width, height, "float", false);
            core.writeSsaoGpuParameters(gpu, {
                depthMultiply: -2 / 19.9,
                depthAdd: -0.1 / 19.9,
                tanX: (Math.tan(Math.PI / 6) * width) / height,
                tanY: Math.tan(Math.PI / 6),
                far: 20,
                radius: 0.5,
                intensity: 1,
            });
            core.bindSsaoGpuSources(gpu, source.createView(), null);
            try {
                device.pushErrorScope("validation");
                const encoder = device.createCommandEncoder();
                core.executeSsaoGpu(gpu, encoder);
                device.queue.submit([encoder.finish()]);
                const validation = await device.popErrorScope();
                if (validation) throw new Error(validation.message);
                const output = new DataView((await readTexture(gpu.visibility, width, height, 8)).buffer);
                for (let i = 0; i < width * height; i++) {
                    const value = half(output.getUint16(i * 8, true));
                    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid XeGTAO output without normals at ${width}x${height}/${i}`);
                }
                const clear = device.createCommandEncoder();
                core.clearSsaoGpu(gpu, clear);
                device.queue.submit([clear.finish()]);
                const identity = new DataView((await readTexture(gpu.visibility, width, height, 8)).buffer);
                for (let i = 0; i < width * height; i++) {
                    if (half(identity.getUint16(i * 8, true)) !== 1) throw new Error("Disabled SSAO did not produce the neutral visibility.");
                }
            } finally {
                core.disposeSsaoGpu(gpu);
                source.destroy();
            }
        }
        if (errors.length) throw new Error(errors.join("\n"));
        return result;
    } finally {
        device.destroy();
    }
}
