import { createHalfSsaoGpu, bindHalfSsaoGpu, executeHalfSsaoGpu } from "../../packages/babylon-lite/src/post-process/ssao-half-resolution.js";
import { ssaoHalfPipelineUpsampleWGSL, ssaoHalfUpsampleWGSL } from "../../packages/babylon-lite/src/post-process/ssao-half-wgsl.js";
import { disposeSsaoGpu, writeSsaoGpuParameters } from "../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import { SSAO_PARAMS_WGSL, ssaoDepthBindingWGSL, ssaoDepthNormalWGSL } from "../../packages/babylon-lite/src/post-process/ssao-wgsl.js";
import { createFreeCamera } from "../../packages/babylon-lite/src/camera/free-camera.js";
import { getProjectionMatrix, getViewMatrix } from "../../packages/babylon-lite/src/camera/camera.js";
import { halfToFloat } from "./diligent-contract.js";

async function validateContactSupport(device: GPUDevice): Promise<void> {
    const width = 65;
    const depth = device.createTexture({ size: [width, width], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const normal = device.createTexture({ size: [width, width], format: "rgba32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const owner = createHalfSsaoGpu(device, width, width, "float", true, false);
    const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const pitch = Math.ceil((width * 8) / 256) * 256;
    const readback = device.createBuffer({ size: pitch * width, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
        const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        camera.nearPlane = 0.1;
        camera.farPlane = 20;
        const projection = getProjectionMatrix(camera, 1);
        const tanX = 1 / projection[0]!;
        writeSsaoGpuParameters(owner.gpu, {
            depthMultiply: -projection[14]!,
            depthAdd: projection[10]!,
            tanX,
            tanY: 1 / projection[5]!,
            far: 20,
            radius: 0.6,
            intensity: 1,
            view: getViewMatrix(camera),
        });
        bindHalfSsaoGpu(owner, depth.createView(), normal.createView());
        const initialize = device.createComputePipeline({
            layout: "auto",
            compute: {
                entryPoint: "main",
                module: device.createShaderModule({
                    code: `
@group(0) @binding(0) var destination:texture_storage_2d<rgba16float,write>;
@group(0) @binding(1) var<uniform> options:vec4f;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=textureDimensions(destination))){return;}
let x=min(id.x*2u+1u,64u);
let value=select(select(0.8,0.2,f32(x)<=options.x),0.2+0.006*f32(x),options.y>0.5);
textureStore(destination,vec2i(id.xy),vec4f(value,value,value,1));
}`,
                }),
            },
        });
        const group = device.createBindGroup({
            layout: initialize.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: owner.gpu.visibility.createView() },
                { binding: 1, resource: { buffer: uniform } },
            ],
        });
        for (const kind of ["concave", "oblique", "convex", "separated", "opposing"] as const) {
            for (const crease of [30.25, 30.75, 31.25, 31.75, 32.25, 32.75]) {
                const raw = new Float32Array(width * width);
                const normals = new Float32Array(width * width * 4);
                const intersectionX = (((crease + 0.5) / width) * 2 - 1) * tanX * 3;
                const slant = kind === "oblique" ? 0.37 : 0;
                for (let y = 0; y < width; y++) {
                    for (let x = 0; x < width; x++) {
                        const left = x <= crease + slant * (y + 0.5 - width / 2);
                        const nx = kind === "opposing" ? 0 : (((left ? 1 : -1) * Math.SQRT1_2) / Math.hypot(1, slant)) * (kind === "convex" ? -1 : 1);
                        const ny = nx * slant;
                        const nz = kind === "opposing" ? (left ? -1 : 1) : -Math.SQRT1_2;
                        const rayX = (((x + 0.5) / width) * 2 - 1) * tanX;
                        const rayY = (1 - ((y + 0.5) / width) * 2) / projection[5]!;
                        let z = kind === "opposing" ? 3 : (nx * intersectionX + nz * 3) / (nx * rayX + ny * rayY + nz);
                        if (kind === "separated" && !left) z += 1;
                        const p = y * width + x;
                        raw[p] = projection[10]! + projection[14]! / z;
                        normals.set([nx, ny, nz, 0], p * 4);
                    }
                }
                device.queue.writeTexture({ texture: depth }, raw, { bytesPerRow: width * 4 }, [width, width]);
                device.queue.writeTexture({ texture: normal }, normals, { bytesPerRow: width * 16 }, [width, width]);
                device.queue.writeBuffer(uniform, 0, new Float32Array([crease, Number(kind === "concave" || kind === "oblique"), 0, 0]));
                const encoder = device.createCommandEncoder();
                const pass = encoder.beginComputePass();
                pass.setPipeline(initialize);
                pass.setBindGroup(0, group);
                pass.dispatchWorkgroups(5, 5);
                pass.end();
                executeHalfSsaoGpu(owner, encoder);
                encoder.copyTextureToBuffer({ texture: owner.gpu.outputTexture! }, { buffer: readback, bytesPerRow: pitch }, [width, width]);
                device.queue.submit([encoder.finish()]);
                await readback.mapAsync(GPUMapMode.READ);
                try {
                    const values = new DataView(readback.getMappedRange());
                    for (let y = 2; y < width - 2; y++) {
                        const rowCrease = crease + slant * (y + 0.5 - width / 2);
                        for (let x = Math.floor(rowCrease) - 2; x <= Math.ceil(rowCrease) + 2; x++) {
                            const actual = halfToFloat(values.getUint16(y * pitch + x * 8, true));
                            const expected = kind === "concave" || kind === "oblique" ? 0.2 + 0.006 * x : x <= crease ? 0.2 : 0.8;
                            if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.001) {
                                throw new Error(`${kind} contact at phase ${crease}: visibility ${actual} versus ${expected} at ${x},${y}.`);
                            }
                        }
                    }
                } finally {
                    readback.unmap();
                }
            }
        }
    } finally {
        disposeSsaoGpu(owner.gpu);
        depth.destroy();
        normal.destroy();
        uniform.destroy();
        readback.destroy();
    }
}

/** Shared storage must preserve the scalar reconstruction, including partial workgroups and odd edges. */
export async function validateWorkgroupUpsample(): Promise<{ case: string }[]> {
    const stride = 2;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error("Workgroup upsampling validation requires WebGPU.");
    }
    const device = await adapter.requestDevice();
    const errors: string[] = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    try {
        const initialize = device.createShaderModule({
            code: `override SEED:u32=0u;
@group(0) @binding(0) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=textureDimensions(output))){return;}
let v=0.05+f32((id.x*13u+id.y*17u+SEED*7u)&31u)/40.0;
textureStore(output,vec2i(id.xy),vec4f(v,v,v,1));}`,
        });
        const initializers = [0, 1, 2].map((seed) =>
            device.createComputePipeline({ layout: "auto", compute: { module: initialize, entryPoint: "main", constants: { SEED: seed } } })
        );
        const depthModule = device.createShaderModule({
            code: `@group(0) @binding(0) var inputDepth:texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}
@fragment fn fragment(@builtin(position) p:vec4f)->@builtin(frag_depth) f32{
return textureLoad(inputDepth,vec2i(p.xy),0).r;}`,
        });
        const depthPipeline = device.createRenderPipeline({
            layout: "auto",
            vertex: { module: depthModule, entryPoint: "vertex" },
            fragment: { module: depthModule, entryPoint: "fragment", targets: [] },
            depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
            primitive: { topology: "triangle-list" },
        });
        device.pushErrorScope("validation");
        let contactFailure: unknown;
        try {
            await validateContactSupport(device);
        } catch (error) {
            contactFailure = error;
        }
        const contactValidation = await device.popErrorScope();
        if (contactValidation) {
            throw new Error(contactValidation.message);
        }
        if (contactFailure) {
            throw contactFailure;
        }
        const results: { case: string }[] = [{ case: "axis-aligned/oblique concave contact phases: linear support preserved; convex, separated and opposing surfaces rejected" }];
        for (const [width, height] of [
            [1, 1],
            [1, 17],
            [17, 1],
            [9, 7],
            [13, 14],
            [14, 10],
            [15, 13],
            [16, 16],
            [33, 25],
            [67, 49],
        ] as const) {
            const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
            camera.nearPlane = 0.1;
            camera.farPlane = 30;
            const projection = getProjectionMatrix(camera, width / height);
            for (const kind of ["float", "depth"] as const) {
                const input = device.createTexture({ size: [width, height], format: "r32float", usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
                const depth =
                    kind === "float"
                        ? input
                        : device.createTexture({ size: [width, height], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
                const owner = createHalfSsaoGpu(device, width, height, kind, false, false);
                try {
                    bindHalfSsaoGpu(owner, depth.createView(), null);
                    writeSsaoGpuParameters(owner.gpu, {
                        depthMultiply: -projection[14]!,
                        depthAdd: projection[10]!,
                        tanX: 1 / projection[0]!,
                        tanY: 1 / projection[5]!,
                        far: 30,
                        radius: 0.6,
                        intensity: 1,
                        view: getViewMatrix(camera),
                    });
                    const baseline = device.createComputePipeline({
                        layout: device.createPipelineLayout({ bindGroupLayouts: [owner.pipeline.getBindGroupLayout(0)] }),
                        compute: {
                            module: device.createShaderModule({ code: ssaoHalfUpsampleWGSL(kind) }),
                            entryPoint: "main",
                            constants: { SOURCE_NORMALS: 0, SOURCE_WORLD: 0 },
                        },
                    });
                    const depthGroup =
                        kind === "depth" ? device.createBindGroup({ layout: depthPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: input.createView() }] }) : null;
                    for (let pattern = 0; pattern < 3; pattern++) {
                        const raw = new Float32Array(width * height);
                        for (let y = 0; y < height; y++) {
                            for (let x = 0; x < width; x++) {
                                const z = pattern === 2 ? 3 : pattern === 0 ? 2 + 0.01 * x + 0.02 * y + (x >= width / 2 ? 1.5 : 0) : 1 + ((x * 11 + y * 7) % 19) / 7;
                                raw[y * width + x] = pattern === 1 && (x + 3 * y) % 17 === 0 ? 0 : projection[10]! + projection[14]! / z;
                            }
                        }
                        device.queue.writeTexture({ texture: input }, raw, { bytesPerRow: width * 4 }, [width, height]);
                        const pitch = Math.ceil((width * 8) / 256) * 256;
                        const readbacks = [0, 1].map(() => device.createBuffer({ size: pitch * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
                        const sourcePitch = Math.ceil((owner.gpu.visibility.width * 8) / 256) * 256;
                        const sourceReadback =
                            pattern === 2
                                ? device.createBuffer({ size: sourcePitch * owner.gpu.visibility.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
                                : null;
                        try {
                            const encoder = device.createCommandEncoder();
                            if (depthGroup) {
                                const pass = encoder.beginRenderPass({
                                    colorAttachments: [],
                                    depthStencilAttachment: { view: depth.createView(), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 0 },
                                });
                                pass.setPipeline(depthPipeline);
                                pass.setBindGroup(0, depthGroup);
                                pass.draw(3);
                                pass.end();
                            }
                            const initializer = initializers[pattern]!;
                            const fill = encoder.beginComputePass();
                            fill.setPipeline(initializer);
                            fill.setBindGroup(
                                0,
                                device.createBindGroup({ layout: initializer.getBindGroupLayout(0), entries: [{ binding: 0, resource: owner.gpu.visibility.createView() }] })
                            );
                            fill.dispatchWorkgroups(Math.ceil(owner.gpu.visibility.width / 8), Math.ceil(owner.gpu.visibility.height / 8));
                            fill.end();
                            if (sourceReadback) {
                                encoder.copyTextureToBuffer({ texture: owner.gpu.visibility }, { buffer: sourceReadback, bytesPerRow: sourcePitch }, [
                                    owner.gpu.visibility.width,
                                    owner.gpu.visibility.height,
                                ]);
                            }
                            executeHalfSsaoGpu(owner, encoder);
                            encoder.copyTextureToBuffer({ texture: owner.gpu.outputTexture! }, { buffer: readbacks[0]!, bytesPerRow: pitch }, [width, height]);
                            const scalar = encoder.beginComputePass();
                            scalar.setPipeline(baseline);
                            scalar.setBindGroup(0, owner.group!);
                            scalar.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
                            scalar.end();
                            encoder.copyTextureToBuffer({ texture: owner.gpu.outputTexture! }, { buffer: readbacks[1]!, bytesPerRow: pitch }, [width, height]);
                            device.queue.submit([encoder.finish()]);
                            await Promise.all([...readbacks, ...(sourceReadback ? [sourceReadback] : [])].map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
                            if (errors.length) {
                                throw new Error(errors.join("\n"));
                            }
                            const cached = new DataView(readbacks[0]!.getMappedRange()),
                                reference = new DataView(readbacks[1]!.getMappedRange());
                            const source = sourceReadback ? new DataView(sourceReadback.getMappedRange()) : null;
                            const interval = (pixel: number, size: number): [number, number, number] => {
                                const count = Math.ceil(size / stride);
                                const receiver = (index: number): number => Math.min(index * stride + stride / 2, size - 1);
                                if (pixel <= receiver(0)) {
                                    return [0, 0, 0];
                                }
                                let upper = 1;
                                while (upper < count && receiver(upper) < pixel) {
                                    upper++;
                                }
                                if (upper === count) {
                                    return [count - 1, count - 1, 0];
                                }
                                const lower = upper - 1;
                                return [lower, upper, (pixel - receiver(lower)) / (receiver(upper) - receiver(lower))];
                            };
                            for (let y = 0; y < height; y++) {
                                for (let x = 0; x < width; x++) {
                                    const offset = y * pitch + x * 8;
                                    for (let channel = 0; channel < 4; channel++) {
                                        if (cached.getUint16(offset + channel * 2, true) !== reference.getUint16(offset + channel * 2, true)) {
                                            throw new Error(`${width}x${height}/${kind}/${pattern}: cached upsampling changed pixel ${x},${y}, channel ${channel}.`);
                                        }
                                    }
                                    const value = halfToFloat(cached.getUint16(offset, true));
                                    if (!Number.isFinite(value) || value < 0 || value > 1 || (raw[y * width + x] === 0 && value !== 1)) {
                                        throw new Error("Cached upsampling changed normalized visibility or the exact white background.");
                                    }
                                    if (source) {
                                        const [left, right, fx] = interval(x, width);
                                        const [top, bottom, fy] = interval(y, height);
                                        const sample = (sx: number, sy: number): number => halfToFloat(source.getUint16(sy * sourcePitch + sx * 8, true));
                                        const first = sample(left, top) * (1 - fx) + sample(right, top) * fx;
                                        const second = sample(left, bottom) * (1 - fx) + sample(right, bottom) * fx;
                                        const expected = first * (1 - fy) + second * fy;
                                        if (Math.abs(value - expected) > 1 / 2048) {
                                            throw new Error(`${width}x${height}/stride ${stride}: shortened-edge interpolation changed ${x},${y}: ${value} versus ${expected}.`);
                                        }
                                    }
                                }
                            }
                        } finally {
                            for (const buffer of readbacks) {
                                buffer.destroy();
                            }
                            sourceReadback?.destroy();
                        }
                    }
                    results.push({ case: `${width}x${height}/${kind}/stride ${stride}: shared/scalar output bytes identical for planar and discontinuous patterned AO` });
                } finally {
                    disposeSsaoGpu(owner.gpu);
                    input.destroy();
                    if (depth !== input) {
                        depth.destroy();
                    }
                }
            }
        }
        results.push(...(await validateHalfPipelineUpsample(device, depthPipeline, initializers, errors)));
        return results;
    } finally {
        device.destroy();
    }
}

/**
 * The half-pipeline upsampler reads taps from the reduced inputs and caches them per workgroup.
 * With the same full-size depth, normals and sparse visibility it must reproduce the original
 * full-size-tap reconstruction, with and without supplied normals.
 */
async function validateHalfPipelineUpsample(
    device: GPUDevice,
    depthPipeline: GPURenderPipeline,
    initializers: GPUComputePipeline[],
    errors: string[]
): Promise<{ case: string }[]> {
    const results: { case: string }[] = [];
    const normalPipeline = device.createComputePipeline({
        layout: "auto",
        compute: {
            entryPoint: "main",
            module: device.createShaderModule({
                code: `${SSAO_PARAMS_WGSL}
${ssaoDepthBindingWGSL("depth", 1)}
${ssaoDepthNormalWGSL()}
@group(0) @binding(2) var outNormal:texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=ao.size)){return;}let p=vec2i(id.xy);var n=vec3f(0,0,-1);
if(aoRawDepth(p)!=0.0){n=aoDepthNormal(p);}textureStore(outNormal,p,vec4f(n,0));
}`,
            }),
        },
    });
    // Mirrors the production prepare pass: every reduced input comes from min(2q+1,size-1).
    const sparsePipeline = device.createComputePipeline({
        layout: "auto",
        compute: {
            entryPoint: "main",
            module: device.createShaderModule({
                code: `${SSAO_PARAMS_WGSL}
${ssaoDepthBindingWGSL("depth", 1)}
@group(0) @binding(2) var fullNormal:texture_2d<f32>;
@group(0) @binding(3) var outDepth:texture_storage_2d<r32float,write>;
@group(0) @binding(4) var outNormal:texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=textureDimensions(outDepth))){return;}
let p=vec2i(min(id.xy*2u+1u,ao.size-1u));let q=vec2i(id.xy);
textureStore(outDepth,q,vec4f(aoRawDepth(p),0,0,0));textureStore(outNormal,q,textureLoad(fullNormal,p,0));
}`,
            }),
        },
    });
    const pipelines = [false, true].map((sourceNormals) =>
        device.createComputePipeline({
            layout: "auto",
            compute: { entryPoint: "main", module: device.createShaderModule({ code: ssaoHalfPipelineUpsampleWGSL(sourceNormals) }), constants: { SOURCE_WORLD: 0 } },
        })
    );
    for (const [width, height] of [
        [1, 1],
        [1, 17],
        [17, 1],
        [9, 7],
        [13, 14],
        [16, 16],
        [33, 25],
        [67, 49],
    ] as const) {
        const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        camera.nearPlane = 0.1;
        camera.farPlane = 30;
        const projection = getProjectionMatrix(camera, width / height);
        const smallWidth = Math.ceil(width / 2),
            smallHeight = Math.ceil(height / 2);
        const texture = (format: GPUTextureFormat, w: number, h: number, usage: number) => device.createTexture({ size: [w, h], format, usage });
        const sampledStorage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
        const input = texture("r32float", width, height, GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING);
        const depth = texture("depth32float", width, height, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
        const fullNormal = texture("rgba32float", width, height, sampledStorage);
        const sparseDepth = texture("r32float", smallWidth, smallHeight, sampledStorage);
        const sparseNormal = texture("rgba32float", smallWidth, smallHeight, sampledStorage);
        const output = texture("rgba16float", width, height, sampledStorage);
        const owners = [false, true].map((normals) => createHalfSsaoGpu(device, width, height, "depth", normals, false));
        try {
            const params = {
                depthMultiply: -projection[14]!,
                depthAdd: projection[10]!,
                tanX: 1 / projection[0]!,
                tanY: 1 / projection[5]!,
                far: 30,
                radius: 0.6,
                intensity: 1,
                view: getViewMatrix(camera),
            };
            owners.forEach((owner, normals) => {
                bindHalfSsaoGpu(owner, depth.createView(), normals ? fullNormal.createView() : null);
                writeSsaoGpuParameters(owner.gpu, params);
            });
            const uniform = { buffer: owners[0]!.gpu.uniform };
            const group = (pipeline: GPUComputePipeline, entries: [number, GPUBindingResource][]) =>
                device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: entries.map(([binding, resource]) => ({ binding, resource })) });
            const normalGroup = group(normalPipeline, [
                [0, uniform],
                [1, depth.createView()],
                [2, fullNormal.createView()],
            ]);
            const sparseGroup = group(sparsePipeline, [
                [0, uniform],
                [1, depth.createView()],
                [2, fullNormal.createView()],
                [3, sparseDepth.createView()],
                [4, sparseNormal.createView()],
            ]);
            const depthGroup = device.createBindGroup({ layout: depthPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: input.createView() }] });
            for (let pattern = 0; pattern < 3; pattern++) {
                const raw = new Float32Array(width * height);
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        // Planar slope with a depth gap, concave/convex creases, and background holes.
                        const crease = Math.abs(x - width / 2) * 0.08 * (pattern === 2 ? -1 : 1);
                        const z = pattern === 0 ? 2 + 0.01 * x + 0.02 * y + (x >= width / 2 ? 1.5 : 0) : 3 + crease + (y > height * 0.7 ? 0.4 : 0);
                        raw[y * width + x] = pattern === 1 && (x + 3 * y) % 17 === 0 ? 0 : projection[10]! + projection[14]! / z;
                    }
                }
                device.queue.writeTexture({ texture: input }, raw, { bytesPerRow: width * 4 }, [width, height]);
                const pitch = Math.ceil((width * 8) / 256) * 256;
                const readbacks = [0, 1, 2, 3].map(() => device.createBuffer({ size: pitch * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
                try {
                    const encoder = device.createCommandEncoder();
                    const depthPass = encoder.beginRenderPass({
                        colorAttachments: [],
                        depthStencilAttachment: { view: depth.createView(), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 0 },
                    });
                    depthPass.setPipeline(depthPipeline);
                    depthPass.setBindGroup(0, depthGroup);
                    depthPass.draw(3);
                    depthPass.end();
                    const pass = encoder.beginComputePass();
                    pass.setPipeline(normalPipeline);
                    pass.setBindGroup(0, normalGroup);
                    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
                    pass.setPipeline(sparsePipeline);
                    pass.setBindGroup(0, sparseGroup);
                    pass.dispatchWorkgroups(Math.ceil(smallWidth / 8), Math.ceil(smallHeight / 8));
                    const initializer = initializers[pattern]!;
                    pass.setPipeline(initializer);
                    for (const owner of owners) {
                        pass.setBindGroup(0, group(initializer, [[0, owner.gpu.visibility.createView()]]));
                        pass.dispatchWorkgroups(Math.ceil(smallWidth / 8), Math.ceil(smallHeight / 8));
                    }
                    pass.end();
                    owners.forEach((owner, normals) => {
                        executeHalfSsaoGpu(owner, encoder);
                        encoder.copyTextureToBuffer({ texture: owner.gpu.outputTexture! }, { buffer: readbacks[normals * 2]!, bytesPerRow: pitch }, [width, height]);
                        const upsample = encoder.beginComputePass();
                        const pipeline = pipelines[normals]!;
                        upsample.setPipeline(pipeline);
                        upsample.setBindGroup(
                            0,
                            group(pipeline, [
                                [0, uniform],
                                [1, depth.createView()],
                                ...(normals ? ([[2, fullNormal.createView()]] as [number, GPUBindingResource][]) : []),
                                [3, owner.gpu.visibility.createView()],
                                [4, output.createView()],
                                [5, sparseDepth.createView()],
                                [6, sparseNormal.createView()],
                            ])
                        );
                        upsample.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
                        upsample.end();
                        encoder.copyTextureToBuffer({ texture: output }, { buffer: readbacks[normals * 2 + 1]!, bytesPerRow: pitch }, [width, height]);
                    });
                    device.queue.submit([encoder.finish()]);
                    await Promise.all(readbacks.map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
                    if (errors.length) {
                        throw new Error(errors.join("\n"));
                    }
                    for (const normals of [0, 1]) {
                        const reference = new DataView(readbacks[normals * 2]!.getMappedRange()),
                            actual = new DataView(readbacks[normals * 2 + 1]!.getMappedRange());
                        let worst = 0;
                        for (let y = 0; y < height; y++) {
                            for (let x = 0; x < width; x++) {
                                const expected = halfToFloat(reference.getUint16(y * pitch + x * 8, true)),
                                    value = halfToFloat(actual.getUint16(y * pitch + x * 8, true));
                                if (!Number.isFinite(value) || value < 0 || value > 1 || (raw[y * width + x] === 0 && value !== 1)) {
                                    throw new Error(`${width}x${height}/${pattern}: half-pipeline upsampling escaped [0,1] or the exact white background.`);
                                }
                                worst = Math.max(worst, Math.abs(value - expected));
                            }
                        }
                        // Only pow(x,8) versus repeated squaring and an idempotent normalize may differ.
                        if (worst > 1 / 512) {
                            throw new Error(`${width}x${height}/${pattern}/normals=${normals}: half-pipeline upsampling deviates by ${worst} from full-size-tap reconstruction.`);
                        }
                    }
                } finally {
                    for (const buffer of readbacks) {
                        buffer.destroy();
                    }
                }
            }
            results.push({ case: `${width}x${height}: half-pipeline tap cache matches full-size-tap reconstruction with and without supplied normals` });
        } finally {
            for (const owner of owners) {
                disposeSsaoGpu(owner.gpu);
            }
            for (const resource of [input, depth, fullNormal, sparseDepth, sparseNormal, output]) {
                resource.destroy();
            }
        }
    }
    return results;
}
