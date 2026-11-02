import { createHalfSsaoGpu, bindHalfSsaoGpu, executeHalfSsaoGpu } from "../../packages/babylon-lite/src/post-process/ssao-half-resolution.js";
import { writeSsaoGpuParameters, disposeSsaoGpu } from "../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import { SSAO_PARAMS_WGSL, ssaoDepthBindingWGSL, ssaoNormalWGSL } from "../../packages/babylon-lite/src/post-process/ssao-wgsl.js";
import { createFreeCamera } from "../../packages/babylon-lite/src/camera/free-camera.js";
import { getViewMatrix, getProjectionMatrix } from "../../packages/babylon-lite/src/camera/camera.js";
import { halfToFloat } from "./diligent-contract.js";

/** Analytic planar creases must not invent normals that punch white holes in sparse AO. */
export async function validateDepthNormals(): Promise<{ case: string }[]> {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error("Depth-normal seam probe requires WebGPU.");
    }
    const device = await adapter.requestDevice();
    const errors: string[] = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    const width = 64,
        height = 48;
    const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    camera.nearPlane = 0.1;
    camera.farPlane = 30;
    const projection = getProjectionMatrix(camera, width / height),
        view = getViewMatrix(camera);
    const input = (format: GPUTextureFormat) => device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
    const depth = input("r32float"),
        normals = input("rgba32float");
    const normalOutput = device.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    const layout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba32float" } },
        ],
    });
    const module = device.createShaderModule({
        code: `${SSAO_PARAMS_WGSL}
${ssaoDepthBindingWGSL("float", 1)}
@group(0) @binding(2) var normalInput:texture_2d<f32>;
@group(0) @binding(3) var output:texture_storage_2d<rgba32float,write>;
fn aoDepth(p:vec2i)->f32{return ao.depthUnpack.x/(ao.depthUnpack.y-aoRawDepth(p));}
${ssaoNormalWGSL()}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=ao.size)){return;}textureStore(output,vec2i(id.xy),vec4f(aoNormal(vec2i(id.xy)),1));
}`,
    });
    const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: "main", constants: { PROVIDED_NORMALS: 0, WORLD_NORMALS: 0 } },
    });
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
            for (let y = 0; y < texture.height; y++) {
                copy.set(mapped.subarray(y * pitch, y * pitch + texture.width * bytes), y * texture.width * bytes);
            }
            return copy;
        } finally {
            buffer.destroy();
        }
    };
    const results: { case: string }[] = [];
    try {
        for (const shape of ["crease", "silhouette", "thin-strip"] as const) {
            for (const shift of [0.25, 0.75]) {
                const raw = new Float32Array(width * height),
                    expected = new Float32Array(width * height * 4);
                const a = 0.6,
                    b = 0.4,
                    c = 1 / 3,
                    split = (2 * shift) / width / projection[0]!;
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const rayX = ((2 * (x + 0.5)) / width - 1) / projection[0]!,
                            rayY = (1 - (2 * (y + 0.5)) / height) / projection[5]!;
                        const tilted = a * (rayX - split) + b * rayY + c;
                        const stripOccluder = shape === "thin-strip" && tilted < c - (4 * a) / width / projection[0]!;
                        const useTilted = tilted > c && !stripOccluder;
                        const reciprocal = stripOccluder ? 0.8 : Math.max(c, tilted),
                            p = y * width + x;
                        const length = useTilted ? Math.hypot(a, b, c - a * split) : 1;
                        expected[p * 4] = useTilted ? -a / length : 0;
                        expected[p * 4 + 1] = useTilted ? -b / length : 0;
                        expected[p * 4 + 2] = useTilted ? -(c - a * split) / length : -1;
                        raw[p] = shape === "silhouette" && x > width / 2 ? 0 : projection[10]! + projection[14]! * reciprocal;
                    }
                }
                device.queue.writeTexture({ texture: depth }, raw, { bytesPerRow: width * 4 }, [width, height]);
                device.queue.writeTexture({ texture: normals }, expected, { bytesPerRow: width * 16 }, [width, height]);
                for (const provided of [true, false]) {
                    const owner = createHalfSsaoGpu(device, width, height, "float", provided, false);
                    try {
                        bindHalfSsaoGpu(owner, depth.createView(), provided ? normals.createView() : null);
                        writeSsaoGpuParameters(owner.gpu, {
                            depthMultiply: -projection[14]!,
                            depthAdd: projection[10]!,
                            tanX: 1 / projection[0]!,
                            tanY: 1 / projection[5]!,
                            far: 30,
                            radius: 0.6,
                            intensity: 1,
                            view,
                        });
                        const group = device.createBindGroup({
                            layout,
                            entries: [
                                { binding: 0, resource: { buffer: owner.gpu.uniform } },
                                { binding: 1, resource: depth.createView() },
                                { binding: 2, resource: normals.createView() },
                                { binding: 3, resource: normalOutput.createView() },
                            ],
                        });
                        const encoder = device.createCommandEncoder(),
                            normalPass = encoder.beginComputePass();
                        normalPass.setPipeline(pipeline);
                        normalPass.setBindGroup(0, group);
                        normalPass.dispatchWorkgroups(width / 8, height / 8);
                        normalPass.end();
                        const clear = encoder.beginRenderPass({
                            colorAttachments: [{ view: owner.gpu.visibility.createView(), loadOp: "clear", storeOp: "store", clearValue: [0.25, 0.25, 0.25, 1] }],
                        });
                        clear.end();
                        executeHalfSsaoGpu(owner, encoder);
                        device.queue.submit([encoder.finish()]);
                        const ao = new DataView((await read(owner.gpu.outputTexture!, 8)).buffer),
                            actual = new Float32Array((await read(normalOutput, 16)).buffer);
                        if (errors.length) {
                            throw new Error(errors.join("\n"));
                        }
                        for (let p = 0; p < width * height; p++) {
                            const length = Math.hypot(actual[p * 4]!, actual[p * 4 + 1]!, actual[p * 4 + 2]!);
                            if (!Number.isFinite(length) || Math.abs(length - 1) > 0.0001) {
                                throw new Error("Depth-normal reconstruction produced a non-unit or non-finite normal.");
                            }
                        }
                        let worstDot = 1,
                            checked = 0;
                        for (let y = 4; y < height - 4; y++) {
                            for (let x = 4; x < width - 4; x++) {
                                const p = y * width + x;
                                if (raw[p] === 0) {
                                    continue;
                                }
                                checked++;
                                const dot = actual[p * 4]! * expected[p * 4]! + actual[p * 4 + 1]! * expected[p * 4 + 1]! + actual[p * 4 + 2]! * expected[p * 4 + 2]!;
                                const value = halfToFloat(ao.getUint16(p * 8, true));
                                worstDot = Math.min(worstDot, dot);
                                const planarStencil = shape === "crease" || (shape === "silhouette" && x <= width / 2 - 2);
                                if (!Number.isFinite(dot) || dot < (planarStencil ? 0.999 : 0.9)) {
                                    throw new Error(`${shape} at ${shift}: reconstructed normal crosses faces at ${x},${y} (dot ${dot}).`);
                                }
                                if (!Number.isFinite(value) || Math.abs(value - 0.25) > 1 / 4096) {
                                    throw new Error(`${shape} at ${shift}, ${provided ? "provided" : "reconstructed"} normals: constant AO became ${value} at ${x},${y}.`);
                                }
                            }
                        }
                        if (checked < 1000) {
                            throw new Error("Depth-normal regression did not exercise enough covered receivers.");
                        }
                        results.push({
                            case: `${shape}/${shift}/${provided ? "provided" : "reconstructed"}: ${checked} constant-AO receivers, normal dot >= ${worstDot.toFixed(6)}`,
                        });
                    } finally {
                        disposeSsaoGpu(owner.gpu);
                    }
                }
            }
        }
        await device.queue.onSubmittedWorkDone();
        if (errors.length) {
            throw new Error(errors.join("\n"));
        }
        return results;
    } finally {
        device.destroy();
    }
}
