import { bindSsaoGpuSources, createSsaoGpu, disposeSsaoGpu, executeSsaoGpu, writeSsaoGpuParameters } from "../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import {
    bindDiligentTemporalGpu,
    createDiligentTemporalGpu,
    disposeDiligentTemporalGpu,
    executeDiligentTemporalGpu,
} from "../../packages/babylon-lite/src/post-process/ssao-diligent-gpu.js";
import { createSsaoMotionPruningGpu } from "../../packages/babylon-lite/src/post-process/ssao-motion-pruning.js";
import { ssaoMotionMaskCellCount, ssaoMotionMaskMarkWGSL, ssaoMotionMaskQueryWGSL } from "../../packages/babylon-lite/src/post-process/ssao-motion-mask-wgsl.js";
import { SSAO_PARAMS_WGSL } from "../../packages/babylon-lite/src/post-process/ssao-wgsl.js";
import { createFreeCamera } from "../../packages/babylon-lite/src/camera/free-camera.js";
import { getViewMatrix, getProjectionMatrix, getViewProjectionMatrix } from "../../packages/babylon-lite/src/camera/camera.js";
import { createIdentityMat4 } from "../../packages/babylon-lite/src/math/create-identity-mat4.js";
import { invertMat4ToRefOrIdentity } from "../../packages/babylon-lite/src/math/invert-mat4-to-ref-or-identity.js";
import { packMat4IntoF32 } from "../../packages/babylon-lite/src/math/pack-mat4-into-f32.js";
import { geometryNormalBits, halfToFloat } from "./diligent-contract.js";
import { validateTemporalScene } from "./validate-temporal-scene-client.js";
import { validateDepthNormals } from "./validate-depth-normal-client.js";
import type { AoReferenceManifest } from "./generate.js";

async function validateMotionPruningQueries(device: GPUDevice): Promise<void> {
    const width = 1025,
        height = 769,
        tilesX = Math.ceil(width / 8);
    const cells = device.createBuffer({ size: ssaoMotionMaskCellCount(width, height) * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const uniform = device.createBuffer({ size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Uint32Array([width, height]));
    const tiles = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const probes: number[] = [520.5, 520.5, 128, 0, 768.5, 512.5, 0, 0, 639.5, 512.5, 128, 0, 1024.5, 768.5, 0, 0];
    for (let y = 0; y < height; y += 47) {
        for (let x = 0; x < width; x += 53) {
            for (const radius of [0, 1, 7, 31, 64, 128, 256]) probes.push(x + 0.5, y + 0.5, radius, 0);
        }
    }
    const queryCount = probes.length / 4;
    const queries = device.createBuffer({ size: probes.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(queries, 0, new Float32Array(probes));
    const output = device.createBuffer({ size: queryCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: queryCount * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    // Marks tiles with the production atomic pyramid writer, then queries with the production reader.
    const markModule = device.createShaderModule({
        code: `${SSAO_PARAMS_WGSL}
${ssaoMotionMaskMarkWGSL(1)}
@group(0) @binding(2) var<storage,read> tiles:array<vec2u>;
override COUNT:u32=0u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
if(id.x>=COUNT){return;}markMovingTile(tiles[id.x]);
}`,
    });
    const query = device.createComputePipeline({
        layout: "auto",
        compute: {
            entryPoint: "main",
            module: device.createShaderModule({
                code: `${SSAO_PARAMS_WGSL}
${ssaoMotionMaskQueryWGSL()}
@group(0) @binding(1) var<storage,read> queries:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> results:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
if(id.x>=arrayLength(&queries)){return;}
let probe=queries[id.x];results[id.x]=select(0u,1u,movingCaster(probe.xy,probe.z));
}`,
            }),
        },
    });
    const queryGroup = device.createBindGroup({
        layout: query.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: { buffer: queries } },
            { binding: 2, resource: { buffer: output } },
            { binding: 8, resource: { buffer: cells } },
        ],
    });
    try {
        const cases: [number, number][][] = [
            [],
            [[96, 64]],
            [[128, 96]],
            [
                [0, 0],
                [96, 64],
                [128, 96],
            ],
        ];
        for (const active of cases) {
            device.queue.writeBuffer(tiles, 0, new Uint32Array(active.flat()));
            const marker = device.createComputePipeline({ layout: "auto", compute: { entryPoint: "main", module: markModule, constants: { COUNT: active.length } } });
            const markGroup = device.createBindGroup({
                layout: marker.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniform } },
                    { binding: 1, resource: { buffer: cells } },
                    { binding: 2, resource: { buffer: tiles } },
                ],
            });
            const encoder = device.createCommandEncoder();
            encoder.clearBuffer(cells);
            const pass = encoder.beginComputePass();
            pass.setPipeline(marker);
            pass.setBindGroup(0, markGroup);
            pass.dispatchWorkgroups(1);
            pass.setPipeline(query);
            pass.setBindGroup(0, queryGroup);
            pass.dispatchWorkgroups(Math.ceil(queryCount / 64));
            pass.end();
            encoder.copyBufferToBuffer(output, 0, readback, 0, queryCount * 4);
            device.queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            try {
                const actual = new Uint32Array(readback.getMappedRange());
                for (let i = 0; i < queryCount; i++) {
                    const x = probes[i * 4]!,
                        y = probes[i * 4 + 1]!,
                        radius = probes[i * 4 + 2]!;
                    const lowerX = Math.max(0, Math.floor(x - radius - 1)),
                        lowerY = Math.max(0, Math.floor(y - radius - 1));
                    const upperX = Math.min(width - 1, Math.floor(x + radius + 1)),
                        upperY = Math.min(height - 1, Math.floor(y + radius + 1));
                    const expected = active.some(
                        ([tx, ty]) => tx! * 8 <= upperX && ty! * 8 <= upperY && Math.min(tx! * 8 + 7, width - 1) >= lowerX && Math.min(ty! * 8 + 7, height - 1) >= lowerY
                    );
                    if ((expected && actual[i] !== 1) || (active.length <= 1 && actual[i] !== Number(expected))) {
                        throw new Error(`Motion bounds query ${i} lost a caster or retained an unrelated coarse cell for ${JSON.stringify(active)} (${tilesX} tiles).`);
                    }
                }
            } finally {
                readback.unmap();
            }
        }
    } finally {
        for (const buffer of [cells, uniform, tiles, queries, output, readback]) buffer.destroy();
    }
}

export async function validateMixedOccluderTransport(device: GPUDevice): Promise<void> {
    const width = 65,
        center = 32,
        pixels = width * width;
    const depth = device.createTexture({ size: [width, width], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const normals = device.createTexture({ size: [width, width], format: "rgba32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const velocity = device.createTexture({ size: [width, width], format: "rgba32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const gpu = createSsaoGpu(device, width, width, "float", true);
    bindSsaoGpuSources(gpu, depth.createView(), normals.createView());
    const owner = createDiligentTemporalGpu(gpu, velocity.createView(), true, true);
    const readback = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
        const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        camera.nearPlane = 0.1;
        camera.farPlane = 20;
        const view = getViewMatrix(camera),
            projection = getProjectionMatrix(camera, 1),
            vp = getViewProjectionMatrix(camera, 1),
            inverse = createIdentityMat4();
        invertMat4ToRefOrIdentity(vp, inverse);
        writeSsaoGpuParameters(gpu, {
            depthMultiply: -projection[14]!,
            depthAdd: projection[10]!,
            tanX: 1 / projection[0]!,
            tanY: 1 / projection[5]!,
            far: 20,
            radius: 0.6,
            intensity: 1,
            view,
        });
        packMat4IntoF32(owner.data, camera.worldMatrix, 0);
        packMat4IntoF32(owner.data, view, 16);
        packMat4IntoF32(owner.data, vp, 32);
        owner.data.set([0, 16, 1, 1], 48);
        packMat4IntoF32(owner.data, inverse, 52);
        packMat4IntoF32(owner.data, inverse, 68);
        device.queue.writeBuffer(owner.uniform, 0, owner.data);
        const raw = new Float32Array(pixels),
            normal = new Float32Array(pixels * 4),
            motion = new Float32Array(pixels * 4),
            rawBits = new Uint32Array(raw.buffer),
            previousGeometry = new Uint32Array(pixels * 2),
            occluders = new Uint8Array(pixels);
        // Two halves of an elevated ring share support; only their motion changes between cases.
        for (let y = 0; y < width; y++) {
            for (let x = 0; x < width; x++) {
                const p = y * width + x,
                    distance = Math.hypot(x - center, y - center);
                occluders[p] = Number(distance >= 6 && distance <= 12);
                const z = occluders[p] ? 4.8 : 5;
                raw[p] = projection[10]! + projection[14]! / z;
                normal[p * 4 + 2] = -1;
                motion[p * 4 + 2] = z;
                previousGeometry[p * 2] = rawBits[p]!;
                previousGeometry[p * 2 + 1] = geometryNormalBits(0, 0, -1);
            }
        }
        device.queue.writeTexture({ texture: depth }, raw, { bytesPerRow: width * 4 }, [width, width]);
        device.queue.writeTexture({ texture: normals }, normal, { bytesPerRow: width * 16 }, [width, width]);
        device.queue.writeTexture({ texture: owner.scratch }, new Uint16Array(pixels * 4).fill(0x3800), { bytesPerRow: width * 8 }, [width, width]);
        device.queue.writeTexture({ texture: owner.history[0] }, new Uint8Array(pixels).fill(128), { bytesPerRow: width }, [width, width]);
        device.queue.writeTexture({ texture: owner.geometry }, previousGeometry, { bytesPerRow: width * 8 }, [width, width]);
        const stage = owner.stages[0].find((candidate) => candidate.pipeline === owner.transportPipeline)!;
        const readField = async () => {
            device.queue.writeTexture({ texture: velocity }, motion, { bytesPerRow: width * 16 }, [width, width]);
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass(stage.pass);
            pass.setPipeline(stage.pipeline);
            pass.setBindGroup(0, stage.group);
            pass.draw(3);
            pass.end();
            encoder.copyTextureToBuffer({ texture: owner.transport!, origin: [center, center] }, { buffer: readback, bytesPerRow: 256 }, [1, 1]);
            device.queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            const field = new Float32Array(readback.getMappedRange()).slice(0, 4);
            readback.unmap();
            return field;
        };
        const shifts: number[] = [];
        for (const mode of ["stationary", "left", "right", "all"] as const) {
            for (let p = 0; p < pixels; p++) {
                const left = p % width < center;
                motion[p * 4] = occluders[p] && (mode === "all" || (mode === "left" && left) || (mode === "right" && !left)) ? 0.001 : 0;
            }
            const field = await readField();
            if (!field.every(Number.isFinite) || (mode === "stationary" ? field[3] !== 0 : !(field[3]! > 0))) {
                throw new Error(`Mixed-occluder transport ${mode} incorrectly discarded partial motion or warped stationary support.`);
            }
            shifts.push(mode === "stationary" ? 0 : field[0]! - 0.5);
        }
        const full = shifts[3]!;
        if (Math.abs(full - (0.001 * 4.8) / 5) > 0.000002) {
            throw new Error(`All-moving transport displacement ${full} differs from projected physical motion.`);
        }
        for (const shift of shifts.slice(1, 3)) {
            if (!(shift > full * 0.2 && shift < full * 0.8)) {
                throw new Error("Mixed transport did not retain the stationary occluders' zero-motion contribution.");
            }
        }
        if (Math.abs(shifts[1]! + shifts[2]! - full) > 0.000002) {
            throw new Error("Complementary moving supports do not sum to the all-moving transport displacement.");
        }
        for (const previousDepth of [true, false]) {
            owner.data[51] = Number(previousDepth);
            device.queue.writeBuffer(owner.uniform, 0, owner.data);
            for (const receiverPixels of [0, 0.02, 0.049, 0.051, 0.15, -0.15, 1]) {
                for (let p = 0; p < pixels; p++) {
                    motion[p * 4] = occluders[p] ? 0.001 : receiverPixels / width;
                }
                const field = await readField();
                const previousU = field[3]! > 0 ? field[0]! : 0.5 + receiverPixels / width;
                if (!field.every(Number.isFinite) || Math.abs(previousU - (0.5 + full)) > 0.000002) {
                    throw new Error(`AO history jumps across pinned/moving receiver motion at ${receiverPixels} pixels (previous depth ${previousDepth}).`);
                }
            }
            for (let p = 0; p < pixels; p++) {
                motion[p * 4] = occluders[p] ? 0 : 0.15 / width;
            }
            const field = await readField();
            if (!(field[3]! > 0) || Math.abs(field[0]! - 0.5) > 0.000002) {
                throw new Error(`Moving receivers do not retain stationary world-space occlusion (previous depth ${previousDepth}).`);
            }
        }
        owner.data[51] = 1;
        device.queue.writeBuffer(owner.uniform, 0, owner.data);
        for (let p = 0; p < pixels; p++) {
            motion[p * 4] = occluders[p] ? 0.001 : 0;
            motion[p * 4 + 2] = occluders[p] ? 4.8 : 5.1;
        }
        const depthOnly = await readField();
        if (!depthOnly.every(Number.isFinite) || depthOnly[3] !== 0) {
            throw new Error("Depth-only receiver motion incorrectly transported history onto the current instead of the previous receiver plane.");
        }
    } finally {
        readback.destroy();
        disposeDiligentTemporalGpu(owner);
        disposeSsaoGpu(gpu);
        depth.destroy();
        normals.destroy();
        velocity.destroy();
    }
}

export async function validateDiligentAo() {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) {
        throw new Error("Native-format temporal validation requires WebGPU.");
    }
    const results: { case: string; initialError?: number; accumulatedError?: number; ratio?: number }[] = [];
    results.push(...(await validateDepthNormals()));
    for (const filtering of adapter.features.has("float32-filterable") ? [true, false] : [false]) {
        const currentAdapter = await navigator.gpu.requestAdapter();
        if (!currentAdapter) {
            throw new Error("The native-format validation adapter became unavailable.");
        }
        const device = await currentAdapter.requestDevice({ requiredFeatures: filtering ? ["float32-filterable"] : [] });
        const errors: string[] = [];
        device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
        const read = async (texture: GPUTexture, bytes: number): Promise<Uint8Array<ArrayBuffer>> => {
            const width = texture.width,
                height = texture.height,
                pitch = Math.ceil((width * bytes) / 256) * 256;
            const buffer = device.createBuffer({ size: pitch * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            try {
                const encoder = device.createCommandEncoder();
                encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: pitch }, [width, height]);
                device.queue.submit([encoder.finish()]);
                await buffer.mapAsync(GPUMapMode.READ);
                const source = new Uint8Array(buffer.getMappedRange()),
                    result = new Uint8Array(width * height * bytes);
                for (let y = 0; y < height; y++) {
                    result.set(source.subarray(y * pitch, y * pitch + width * bytes), y * width * bytes);
                }
                return result;
            } finally {
                buffer.destroy();
            }
        };
        try {
            await validateMixedOccluderTransport(device);
            results.push({ case: `mixed occluders/moving receivers: continuous relative transport, XY/depth-only motion; float32 filtering ${filtering}` });
            await validateMotionPruningQueries(device);
            results.push({ case: `tight motion bounds: empty/separated/coarse-cell/odd-border/radius queries; float32 filtering ${filtering}` });
            for (const [width, height] of [
                [1, 1],
                [1, 17],
                [17, 1],
                [63, 49],
            ] as const) {
                const depth = device.createTexture({ size: [width, height], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
                const normals = device.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
                const velocity = device.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
                const gpu = createSsaoGpu(device, width, height, "float", true);
                bindSsaoGpuSources(gpu, depth.createView(), normals.createView());
                const owner = createDiligentTemporalGpu(gpu, velocity.createView(), true, true);
                const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
                camera.nearPlane = 0.1;
                camera.farPlane = 20;
                const view = getViewMatrix(camera),
                    projection = getProjectionMatrix(camera, width / height),
                    vp = getViewProjectionMatrix(camera, width / height);
                const inverse = createIdentityMat4();
                invertMat4ToRefOrIdentity(vp, inverse);
                writeSsaoGpuParameters(gpu, {
                    depthMultiply: -projection[14]!,
                    depthAdd: projection[10]!,
                    tanX: 1 / projection[0]!,
                    tanY: 1 / projection[5]!,
                    far: 20,
                    radius: 0.6,
                    intensity: 1,
                    view,
                });
                packMat4IntoF32(owner.data, camera.worldMatrix, 0);
                packMat4IntoF32(owner.data, view, 16);
                packMat4IntoF32(owner.data, vp, 32);
                owner.data.set([1, 16, 1, 1], 48);
                packMat4IntoF32(owner.data, inverse, 52);
                packMat4IntoF32(owner.data, inverse, 68);
                let first = true;
                let phase = 0;
                const frame = async (aoHalf = 0x3400, z = 3, oldZ = z, normalZ = -1, reset = false, movingCorner = false) => {
                    gpu.integers[23] = phase++ % 64;
                    device.queue.writeBuffer(gpu.uniform, 0, gpu.data);
                    const raw = new Float32Array(width * height).fill(z === 0 ? 0 : projection[10]! + projection[14]! / z);
                    const normal = new Float32Array(width * height * 4),
                        motion = new Float32Array(width * height * 4);
                    for (let p = 0; p < width * height; p++) {
                        normal[p * 4 + 2] = normalZ;
                        motion[p * 4 + 2] = oldZ;
                        if (movingCorner && p === width * height - 1) motion[p * 4] = 0.125;
                    }
                    const source = new Uint16Array(width * height * 4).fill(aoHalf);
                    device.queue.writeTexture({ texture: depth }, raw, { bytesPerRow: width * 4 }, [width, height]);
                    device.queue.writeTexture({ texture: normals }, normal, { bytesPerRow: width * 16 }, [width, height]);
                    device.queue.writeTexture({ texture: velocity }, motion, { bytesPerRow: width * 16 }, [width, height]);
                    device.queue.writeTexture({ texture: owner.scratch }, source, { bytesPerRow: width * 8 }, [width, height]);
                    owner.data[48] = first || reset ? 1 : 0;
                    first = false;
                    const encoder = device.createCommandEncoder();
                    executeDiligentTemporalGpu(owner, encoder);
                    device.queue.submit([encoder.finish()]);
                    const ao = await read(owner.history[owner.index]!, 1);
                    const counts = new DataView((await read(owner.counts[owner.index]!, 2)).buffer);
                    const geometry = new Uint32Array((await read(owner.geometry, 8)).buffer),
                        rawBits = new Uint32Array(raw.buffer),
                        normalBits = geometryNormalBits(0, 0, z === 0 ? 0 : normalZ);
                    for (let p = 0; p < width * height; p++) {
                        if (geometry[p * 2] !== rawBits[p] || geometry[p * 2 + 1] !== normalBits) {
                            throw new Error("Final output did not retain exact current depth/world normal in the single geometry history.");
                        }
                    }
                    if (errors.length) {
                        throw new Error(errors.join("\n"));
                    }
                    return { ao, count: halfToFloat(counts.getUint16((Math.floor(height / 2) * width + Math.floor(width / 2)) * 2, true)) };
                };
                try {
                    const initial = await frame();
                    if (initial.ao.some((value) => value !== 64) || initial.count !== 1) {
                        throw new Error("Native-format reset/small target changed constant AO.");
                    }
                    for (let i = 0; i < 20; i++) {
                        await frame();
                    }
                    if ((await frame()).count !== 16) {
                        throw new Error("Native history count did not reach its configured upper bound.");
                    }
                    if ((await frame(0x3400, 3.4, 3)).count !== 16) {
                        throw new Error("Previous-depth motion incorrectly discarded valid history.");
                    }
                    if ((await frame(0x3400, 3.4, 3.4)).count !== 16) {
                        throw new Error("A stopped receiver discarded valid previous-depth history.");
                    }
                    const flipped = await frame(0x3a00, 3.4, 3.4, 1);
                    if (flipped.count !== 1 || flipped.ao.some((value) => value !== 191)) {
                        throw new Error("Normal disocclusion did not select current quantized AO.");
                    }
                    let cleared = flipped;
                    for (let i = 0; i < 80; i++) {
                        cleared = await frame(0x3c00, 3.4, 3.4, 1);
                    }
                    if (cleared.ao.some((value) => value !== 255)) {
                        throw new Error(
                            `Sub-byte R8 accumulation retained a permanently dark shadow at ${width}x${height}: ${Math.min(...cleared.ao)}..${Math.max(...cleared.ao)}, age ${cleared.count}, phase ${gpu.integers[23]}.`
                        );
                    }
                    await frame(0x3a00, 3.4, 3.4, 1, true);
                    const jump = await frame(0x3000, 3.4, 3.4, 1);
                    if (jump.count !== 1 || jump.ao.some((value) => value !== 32)) {
                        throw new Error("A large coherent AO change retained stale history.");
                    }
                    const background = await frame(0x3400, 0, 0);
                    if (background.ao.some((value) => value !== 255)) {
                        throw new Error("Native-format background is not neutral.");
                    }
                    const reveal = await frame();
                    if (reveal.count !== 1 || reveal.ao.some((value) => value !== 64)) {
                        throw new Error("Revealed geometry retained background history.");
                    }
                    await frame(0x3c00, 3, 3, -1, true);
                    for (let i = 0; i < 16; i++) await frame(0x3c00);
                    const histories = owner.history,
                        counts = owner.counts;
                    const pruning = createSsaoMotionPruningGpu(owner);
                    owner.transportExtension = pruning;
                    bindDiligentTemporalGpu(owner, owner.velocity);
                    const pruned = await frame(0x3c00);
                    if (pruned.count !== 16 || pruned.ao.some((value) => value !== 255) || owner.history !== histories || owner.counts !== counts) {
                        throw new Error("Enabling motion pruning replaced or invalidated mature temporal history.");
                    }
                    const vertices = async () => {
                        const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                        try {
                            const encoder = device.createCommandEncoder();
                            encoder.copyBufferToBuffer(pruning.indirect, 0, buffer, 0, 16);
                            device.queue.submit([encoder.finish()]);
                            await buffer.mapAsync(GPUMapMode.READ);
                            return new Uint32Array(buffer.getMappedRange())[0]!;
                        } finally {
                            buffer.destroy();
                        }
                    };
                    if ((await vertices()) !== 0) throw new Error("Static scene did not suppress history transport.");
                    await frame(0x3c00, 3, 3.1);
                    if ((await vertices()) !== 3) throw new Error("Motion mask lost previous-depth-only receiver movement.");
                    await frame(0x3c00, 3, 3, -1, false, true);
                    if ((await vertices()) !== 3) throw new Error("Motion mask lost a moving pixel at an odd/single-pixel boundary.");
                    await frame(0x3c00);
                    if ((await vertices()) !== 0) throw new Error("Stopped motion retained an old indirect transport draw.");
                    for (let i = 0; i < 16; i++) await frame(0x3c00);
                    pruning.dispose();
                    owner.transportExtension = undefined;
                    bindDiligentTemporalGpu(owner, owner.velocity);
                    const unpruned = await frame(0x3c00);
                    if (unpruned.count !== 16 || unpruned.ao.some((value) => value !== 255) || owner.history !== histories || owner.counts !== counts) {
                        throw new Error("Disabling motion pruning replaced or invalidated mature temporal history.");
                    }
                } finally {
                    disposeDiligentTemporalGpu(owner);
                    disposeSsaoGpu(gpu);
                    depth.destroy();
                    normals.destroy();
                    velocity.destroy();
                }
            }
            results.push({ case: `native formats/normal/depth/pause/reset/background/small targets; float32 filtering ${filtering}` });
            if (filtering || !adapter.features.has("float32-filterable")) {
                const response = await fetch("/reference/lite/ao-reference/manifest.json");
                if (!response.ok) {
                    throw new Error("Cannot load immutable AO convergence fixtures.");
                }
                const manifest: AoReferenceManifest = await response.json();
                const settings = manifest.fixtures.find((fixture) => fixture.id === "corner")!.settings;
                const { width, height } = settings,
                    pixels = width * height;
                const depthBytes = await (await fetch("/reference/lite/ao-reference/corner/depth.f32")).arrayBuffer();
                const normalBytes = await (await fetch("/reference/lite/ao-reference/corner/normals.f32")).arrayBuffer();
                {
                    const depth = device.createTexture({ size: [width, height], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
                    const normal = device.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
                    const gpu = createSsaoGpu(device, width, height, "float", true);
                    bindSsaoGpuSources(gpu, depth.createView(), normal.createView());
                    const temporal = createDiligentTemporalGpu(gpu, null);
                    try {
                        device.queue.writeTexture({ texture: depth }, depthBytes, { bytesPerRow: width * 4 }, [width, height]);
                        device.queue.writeTexture({ texture: normal }, normalBytes, { bytesPerRow: width * 16 }, [width, height]);
                        const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
                        camera.nearPlane = settings.near;
                        camera.farPlane = settings.far;
                        camera.fov = 2 * Math.atan(settings.tanHalfFovY);
                        const view = getViewMatrix(camera),
                            vp = getViewProjectionMatrix(camera, width / height),
                            inverse = createIdentityMat4();
                        invertMat4ToRefOrIdentity(vp, inverse);
                        packMat4IntoF32(temporal.data, camera.worldMatrix, 0);
                        packMat4IntoF32(temporal.data, view, 16);
                        packMat4IntoF32(temporal.data, vp, 32);
                        temporal.data.set([1, 16, 1, 0], 48);
                        packMat4IntoF32(temporal.data, inverse, 52);
                        packMat4IntoF32(temporal.data, inverse, 68);
                        const parameters = {
                            depthMultiply: (-settings.near * settings.far) / (settings.far - settings.near),
                            depthAdd: -settings.near / (settings.far - settings.near),
                            tanX: (settings.tanHalfFovY * width) / height,
                            tanY: settings.tanHalfFovY,
                            far: settings.far,
                            radius: settings.radius,
                            intensity: 1,
                            view,
                        };
                        gpu.resolveGroup = temporal.scratchResolve;
                        const scalar = async (texture: GPUTexture) => {
                            const source = new DataView((await read(texture, 8)).buffer),
                                values = new Float32Array(pixels);
                            for (let p = 0; p < pixels; p++) {
                                values[p] = halfToFloat(source.getUint16(p * 8, true));
                            }
                            return values;
                        };
                        const average = new Float64Array(pixels);
                        let initial: Float32Array | undefined;
                        for (let phase = 0; phase < 64; phase++) {
                            writeSsaoGpuParameters(gpu, { ...parameters, phase });
                            const encoder = device.createCommandEncoder();
                            executeSsaoGpu(gpu, encoder);
                            device.queue.submit([encoder.finish()]);
                            const image = await scalar(temporal.scratch);
                            if (phase === 0) {
                                initial = image;
                            }
                            for (let p = 0; p < pixels; p++) {
                                average[p] = average[p]! + image[p]! / 64;
                            }
                        }
                        for (let phase = 0; phase < 32; phase++) {
                            writeSsaoGpuParameters(gpu, { ...parameters, phase });
                            temporal.data[48] = phase === 0 ? 1 : 0;
                            const encoder = device.createCommandEncoder();
                            executeSsaoGpu(gpu, encoder);
                            executeDiligentTemporalGpu(temporal, encoder);
                            device.queue.submit([encoder.finish()]);
                        }
                        const accumulated = await scalar(gpu.visibility);
                        const rms = (image: Float32Array) => Math.sqrt(image.reduce((sum, value, p) => sum + (value - average[p]!) ** 2, 0) / pixels);
                        const initialError = rms(initial!),
                            accumulatedError = rms(accumulated),
                            ratio = accumulatedError / initialError;
                        if (!(ratio < 0.8)) {
                            throw new Error(`Native-format XeGTAO did not converge: ${initialError} -> ${accumulatedError}; ratio ${ratio}`);
                        }
                        if (errors.length) {
                            throw new Error(errors.join("\n"));
                        }
                        results.push({ case: "native-format XeGTAO: 32-frame convergence to the actual 64-phase spatial mean", initialError, accumulatedError, ratio });
                    } finally {
                        disposeDiligentTemporalGpu(temporal);
                        disposeSsaoGpu(gpu);
                        depth.destroy();
                        normal.destroy();
                    }
                }
            }
        } finally {
            device.destroy();
        }
    }
    await validateTemporalScene();
    results.push({ case: "live frame graph/rigid motion/previous depth/public identity/resize/disposal" });
    return results;
}
