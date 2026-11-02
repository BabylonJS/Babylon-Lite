import { bindSsaoGpuSources, createSsaoGpu, disposeSsaoGpu, executeSsaoGpu, writeSsaoGpuParameters } from "../../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import { createSsaoTemporalGpu, disposeSsaoTemporalGpu, executeSsaoTemporalGpu } from "./ssao-temporal-gpu.js";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera.js";
import { getViewMatrix, getViewProjectionMatrix } from "../../../packages/babylon-lite/src/camera/camera.js";
import { packMat4IntoF32 } from "../../../packages/babylon-lite/src/math/pack-mat4-into-f32.js";
import type { AoReferenceManifest } from "../generate.js";
import { validateTemporalScene } from "../validate-temporal-scene-client.js";
import { validateMovingOccluder } from "../validate-moving-occluder-client.js";

export async function validateTemporalAo() {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) {
        throw new Error("Temporal AO validation requires a WebGPU adapter.");
    }
    const device = await adapter.requestDevice();
    const errors: string[] = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    const results: { case: string; initialError?: number; accumulatedError?: number; ratio?: number }[] = [];
    const float = new Float32Array(1),
        bits = new Uint32Array(float.buffer);
    const encodeHalf = (value: number): number => {
        float[0] = value;
        const u = bits[0]!;
        const e = ((u >>> 23) & 255) - 127 + 15;
        return ((u >>> 16) & 32768) | (e << 10) | (((u & 0x7fffff) + 0x1000) >>> 13);
    };
    const decodeHalf = (value: number): number => {
        const e = (value >> 10) & 31,
            m = value & 1023,
            sign = value & 32768 ? -1 : 1;
        return sign * (e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15));
    };
    const read = async (texture: GPUTexture, width: number, height: number): Promise<Float32Array> => {
        const pitch = Math.ceil((width * 8) / 256) * 256;
        const buffer = device.createBuffer({ size: pitch * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: pitch }, [width, height]);
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const view = new DataView(buffer.getMappedRange()),
                values = new Float32Array(width * height * 4);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    for (let c = 0; c < 4; c++) {
                        const value = decodeHalf(view.getUint16(y * pitch + x * 8 + c * 2, true));
                        if (!Number.isFinite(value)) {
                            throw new Error("Temporal AO produced non-finite data.");
                        }
                        values[(y * width + x) * 4 + c] = value;
                    }
                }
            }
            return values;
        } finally {
            buffer.destroy();
        }
    };
    const scalar = (values: Float32Array): Float32Array => {
        const result = new Float32Array(values.length / 4);
        for (let i = 0; i < result.length; i++) {
            result[i] = values[i * 4]!;
        }
        return result;
    };
    const setup = (width: number, height: number, motion: boolean, worldNormals = true, providedNormals = true, previousDepth = false) => {
        const input = device.createTexture({ size: [width, height], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        const normals = device.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        const velocity = device.createTexture({
            size: [width, height],
            format: previousDepth ? "rgba32float" : "rg32float",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        const gpu = createSsaoGpu(device, width, height, "float", providedNormals, worldNormals);
        bindSsaoGpuSources(gpu, input.createView(), normals.createView());
        const temporal = createSsaoTemporalGpu(gpu, motion ? velocity.createView() : null);
        return {
            input,
            normals,
            velocity,
            gpu,
            temporal,
            previousDepth,
            dispose: () => {
                disposeSsaoTemporalGpu(temporal);
                disposeSsaoGpu(gpu);
                input.destroy();
                normals.destroy();
                velocity.destroy();
            },
        };
    };
    try {
        device.pushErrorScope("validation");
        const width = 16,
            height = 16;
        let s = setup(width, height, true);
        let camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        camera.nearPlane = 0.1;
        camera.farPlane = 20;
        const previousView = new Float32Array(16),
            previousProjection = new Float32Array(16);
        const normalData = new Float32Array(width * height * 4),
            depth = new Float32Array(width * height),
            motion = new Float32Array(width * height * 2);
        const worldX = new Float32Array(width * height);
        for (let i = 0; i < width * height; i++) {
            normalData[i * 4 + 2] = -1;
        }
        let previous = false,
            previousSurfaceDepth = 3;
        const frame = async (value: (x: number, y: number, worldX: number) => number, z = 3, reset = false, background = false, cameraMotion = false) => {
            const near = camera.nearPlane,
                far = camera.farPlane,
                tanY = Math.tan(camera.fov / 2);
            const view = getViewMatrix(camera),
                world = camera.worldMatrix;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const rx = (((x + 0.5) / width) * 2 - 1) * tanY,
                        ry = (1 - ((y + 0.5) / height) * 2) * tanY;
                    const rz = world[2]! * rx + world[6]! * ry + world[10]!;
                    const distance = (z - world[14]!) / rz;
                    depth[y * width + x] = (near * (far / distance - 1)) / (far - near);
                    if (background && x === 0 && y === 0) {
                        depth[0] = 0;
                    }
                    worldX[y * width + x] = world[12]! + (world[0]! * rx + world[4]! * ry + world[8]!) * distance;
                    if (cameraMotion) {
                        const wx = worldX[y * width + x]!;
                        const wy = world[13]! + (world[1]! * rx + world[5]! * ry + world[9]!) * distance;
                        const clipX = previousProjection[0]! * wx + previousProjection[4]! * wy + previousProjection[8]! * z + previousProjection[12]!;
                        const clipY = previousProjection[1]! * wx + previousProjection[5]! * wy + previousProjection[9]! * z + previousProjection[13]!;
                        const clipW = previousProjection[3]! * wx + previousProjection[7]! * wy + previousProjection[11]! * z + previousProjection[15]!;
                        motion[(y * width + x) * 2] = (clipX / clipW) * 0.5 + 0.5 - (x + 0.5) / width;
                        motion[(y * width + x) * 2 + 1] = (clipY / clipW) * 0.5 + 0.5 - (1 - (y + 0.5) / height);
                    }
                }
            }
            device.queue.writeTexture({ texture: s.input }, depth, { bytesPerRow: width * 4 }, [width, height]);
            device.queue.writeTexture({ texture: s.normals }, normalData, { bytesPerRow: width * 16 }, [width, height]);
            if (s.previousDepth) {
                const motionWithDepth = new Float32Array(width * height * 4);
                for (let i = 0; i < width * height; i++) {
                    motionWithDepth[i * 4] = motion[i * 2]!;
                    motionWithDepth[i * 4 + 1] = motion[i * 2 + 1]!;
                    motionWithDepth[i * 4 + 2] = previousSurfaceDepth;
                }
                device.queue.writeTexture({ texture: s.velocity }, motionWithDepth, { bytesPerRow: width * 16 }, [width, height]);
            } else {
                device.queue.writeTexture({ texture: s.velocity }, motion, { bytesPerRow: width * 8 }, [width, height]);
            }
            const data = new Uint16Array(width * height * 4);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const h = encodeHalf(value(x, y, worldX[y * width + x]!)),
                        p = (y * width + x) * 4;
                    data[p] = data[p + 1] = data[p + 2] = h;
                    data[p + 3] = encodeHalf(1);
                }
            }
            device.queue.writeTexture({ texture: s.temporal.scratch }, data, { bytesPerRow: width * 8 }, [width, height]);
            writeSsaoGpuParameters(s.gpu, {
                depthMultiply: (-near * far) / (far - near),
                depthAdd: -near / (far - near),
                tanX: tanY,
                tanY,
                far,
                radius: 0.6,
                intensity: 1,
                view,
            });
            packMat4IntoF32(s.temporal.data, world, 0);
            s.temporal.data.set(previousView, 16);
            s.temporal.data.set(previousProjection, 32);
            s.temporal.data[48] = reset || !previous ? 1 : 0;
            s.temporal.data[49] = 32;
            s.temporal.data[50] = 0;
            s.temporal.data[51] = s.previousDepth ? 1 : 0;
            const encoder = device.createCommandEncoder();
            executeSsaoTemporalGpu(s.temporal, encoder);
            device.queue.submit([encoder.finish()]);
            const validation = await device.popErrorScope();
            if (validation) {
                throw new Error(validation.message);
            }
            device.pushErrorScope("validation");
            packMat4IntoF32(previousView, view);
            packMat4IntoF32(previousProjection, getViewProjectionMatrix(camera, 1));
            previous = true;
            previousSurfaceDepth = z;
            return read(s.temporal.history[s.temporal.index]!, width, height);
        };
        const pixel = (values: Float32Array, channel = 0): number => values[(8 * width + 8) * 4 + channel]!;
        try {
            const a = await frame(() => 0.25, 3, true);
            if (pixel(a) !== 0.25 || pixel(a, 1) !== 1) {
                throw new Error("First frame did not replace uninitialized history.");
            }
            const b = await frame(() => 0.25);
            if (pixel(b, 1) < 1.99) {
                throw new Error("Same-surface history was not accumulated.");
            }
            const disoccluded = await frame(() => 0.75, 4);
            if (pixel(disoccluded) !== 0.75 || pixel(disoccluded, 1) !== 1) {
                throw new Error("Depth disocclusion retained stale history.");
            }
            for (let i = 0; i < width * height; i++) {
                normalData[i * 4 + 2] = 1;
            }
            const normalChanged = await frame(() => 0.25, 4);
            if (pixel(normalChanged, 1) !== 1) {
                throw new Error("Opposing normal did not reject history.");
            }
            for (let i = 0; i < width * height; i++) {
                normalData[i * 4 + 2] = -1;
            }
            await frame((x) => 0.125 + x / 32, 3, true);
            for (let i = 0; i < width * height; i++) {
                motion[i * 2] = -2 / width;
            }
            const translated = await frame((x) => 0.125 + Math.max(0, x - 2) / 32);
            if (Math.abs(pixel(translated) - 0.3125) > 0.001 || pixel(translated, 1) < 1.99) {
                throw new Error("Object XY motion did not reproject the correct history texel.");
            }
            motion.fill(0);
            await frame((_x, y) => 0.125 + y / 32, 3, true);
            for (let i = 0; i < width * height; i++) {
                motion[i * 2 + 1] = 2 / height;
            }
            const vertical = await frame((_x, y) => 0.125 + Math.max(0, y - 2) / 32);
            if (Math.abs(pixel(vertical) - 0.3125) > 0.001) {
                throw new Error("Velocity Y-up conversion was inverted.");
            }
            motion.fill(0);
            await frame(() => 0.125, 3, true);
            const clipped = await frame(() => 0.875);
            if (pixel(clipped) < 0.865) {
                throw new Error("Neighborhood clipping allowed a long stale AO trail.");
            }
            const reset = await frame(() => 0.25, 3, true);
            if (pixel(reset, 1) !== 1) {
                throw new Error("Explicit history reset did not restart confidence.");
            }
            const background = await frame(() => 0.25, 3, true, true);
            if (background[0] !== 1 || background[1] !== 0) {
                throw new Error("Background did not remain neutral with invalid history.");
            }
            const revealed = await frame(() => 0.25);
            if (revealed[0] !== 0.25 || revealed[1] !== 1) {
                throw new Error("A newly revealed receiver retained background history.");
            }
            const oldShadow = (x: number): number => (x >= 5 && x <= 9 ? 0.25 : 1);
            await frame(oldShadow, 3, true);
            for (let i = 1; i < 32; i++) {
                await frame(oldShadow);
            }
            const movedShadow = await frame((x) => (x >= 9 && x <= 13 ? 0.25 : 1));
            if (pixel(movedShadow) < 0.98) {
                throw new Error(`A stationary receiver retained a moving occluder's shadow: ${pixel(movedShadow)} instead of 1.`);
            }
            results.push({ case: "moving-occluder AO on a stationary receiver" });
            results.push({ case: "first-frame/depth/normal/motion/Y-sign/clipping/reset" });
            s.dispose();
            s = setup(width, height, false);
            previous = false;
            for (let i = 0; i < width * height; i++) {
                normalData[i * 4 + 2] = -1;
            }
            const gradient = (_x: number, _y: number, x: number): number => 0.5 + x * 0.05;
            await frame(gradient, 3, true);
            camera.position.x = 0.15;
            const panned = await frame(gradient);
            if (pixel(panned, 1) < 1.99 || Math.abs(pixel(panned) - (0.5 + worldX[8 * width + 8]! * 0.05)) > 0.001) {
                throw new Error("Camera-only reprojection did not follow a world-space signal.");
            }
            camera = createFreeCamera({ x: 0.15, y: 0, z: 0 }, { x: 0.35, y: 0, z: 1 });
            camera.nearPlane = 0.1;
            camera.farPlane = 20;
            const rotated = await frame(gradient);
            if (pixel(rotated, 1) < 2.9 || Math.abs(pixel(rotated) - (0.5 + worldX[8 * width + 8]! * 0.05)) > 0.001) {
                throw new Error("Camera rotation rejected world-normal-consistent history or reprojected it incorrectly.");
            }
            results.push({ case: "camera pan/rotation without full-scene TAA" });
            s.dispose();
            s = setup(width, height, true);
            previous = false;
            motion.fill(0);
            await frame(gradient, 3, true);
            for (let i = 0; i < 7; i++) {
                await frame(gradient);
            }
            camera.position.x += 0.02;
            const cameraVectors = await frame(gradient, 3, false, false, true);
            if (pixel(cameraVectors, 1) < 4) {
                throw new Error("Camera-only velocity incorrectly activated the moving-occluder mask.");
            }
            results.push({ case: "camera-motion subtraction preserves static history" });
            s.dispose();
            s = setup(width, height, true, true, true, true);
            previous = false;
            camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
            camera.nearPlane = 0.1;
            camera.farPlane = 20;
            motion.fill(0);
            await frame(() => 0.25, 3, true);
            for (let i = 0; i < 15; i++) {
                await frame(() => 0.25);
            }
            const depthMoving = await frame(() => 0.25, 3.4);
            if (pixel(depthMoving, 1) < 16 || pixel(depthMoving) !== 0.25) {
                throw new Error("Valid previous-surface depth did not preserve depth-changing object history.");
            }
            const paused = await frame(() => 0.25, 3.4);
            if (pixel(paused, 1) < 17) {
                throw new Error("Stopping a depth-moving surface discarded valid history.");
            }
            const changingSurface = await frame(() => 0.875, 3.8);
            if (pixel(changingSurface) < 0.865 || pixel(changingSurface, 1) > 1.01) {
                throw new Error("A tracked moving receiver retained genuinely changed AO.");
            }
            results.push({ case: "previous surface depth/motion pause/genuine moving-surface AO change" });
        } finally {
            s.dispose();
        }
        const error = await device.popErrorScope();
        if (error) {
            throw new Error(error.message);
        }
        for (const [w, h] of [
            [1, 1],
            [1, 17],
            [17, 1],
            [63, 49],
        ]) {
            const small = setup(w!, h!, true, false, false);
            try {
                const cam = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
                cam.nearPlane = 0.1;
                cam.farPlane = 20;
                const depth = new Float32Array(w! * h!).fill((0.1 * (20 / 3 - 1)) / 19.9);
                const values = new Uint16Array(w! * h! * 4).fill(encodeHalf(0.5));
                device.queue.writeTexture({ texture: small.input }, depth, { bytesPerRow: w! * 4 }, [w!, h!]);
                device.queue.writeTexture({ texture: small.temporal.scratch }, values, { bytesPerRow: w! * 8 }, [w!, h!]);
                writeSsaoGpuParameters(small.gpu, {
                    depthMultiply: -2 / 19.9,
                    depthAdd: -0.1 / 19.9,
                    tanX: w! / h!,
                    tanY: 1,
                    far: 20,
                    radius: 0.6,
                    intensity: 1,
                    view: getViewMatrix(cam),
                });
                packMat4IntoF32(small.temporal.data, cam.worldMatrix, 0);
                packMat4IntoF32(small.temporal.data, getViewMatrix(cam), 16);
                small.temporal.data[48] = 1;
                small.temporal.data[49] = 32;
                const encoder = device.createCommandEncoder();
                executeSsaoTemporalGpu(small.temporal, encoder);
                device.queue.submit([encoder.finish()]);
                const actual = await read(small.gpu.visibility, w!, h!);
                if (actual.some((value, i) => value !== (i % 4 === 3 ? 1 : 0.5))) {
                    throw new Error("Small/odd target or reconstructed normals changed constant visibility.");
                }
            } finally {
                small.dispose();
            }
        }
        results.push({ case: "background/reveal/odd sizes/reconstructed normals" });

        const manifest: AoReferenceManifest = await (await fetch("/reference/lite/ao-reference/manifest.json")).json();
        const fixture = manifest.fixtures.find((f) => f.id === "corner")!;
        const f = fixture.settings;
        const source = await (await fetch("/reference/lite/ao-reference/corner/depth.f32")).arrayBuffer();
        const normal = await (await fetch("/reference/lite/ao-reference/corner/normals.f32")).arrayBuffer();
        {
            const s = setup(f.width, f.height, false, false);
            const stable = s.gpu.visibility;
            try {
                device.queue.writeTexture({ texture: s.input }, source, { bytesPerRow: f.width * 4 }, [f.width, f.height]);
                device.queue.writeTexture({ texture: s.normals }, normal, { bytesPerRow: f.width * 16 }, [f.width, f.height]);
                const cam = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
                cam.nearPlane = f.near;
                cam.farPlane = f.far;
                cam.fov = 2 * Math.atan(f.tanHalfFovY);
                packMat4IntoF32(s.temporal.data, cam.worldMatrix, 0);
                packMat4IntoF32(s.temporal.data, getViewMatrix(cam), 16);
                packMat4IntoF32(s.temporal.data, getViewProjectionMatrix(cam, f.width / f.height), 32);
                s.temporal.data[49] = 32;
                s.temporal.data[50] = 0;
                const run = async (phase: number, reset: boolean) => {
                    writeSsaoGpuParameters(s.gpu, {
                        depthMultiply: (-f.near * f.far) / (f.far - f.near),
                        depthAdd: -f.near / (f.far - f.near),
                        tanX: (f.tanHalfFovY * f.width) / f.height,
                        tanY: f.tanHalfFovY,
                        far: f.far,
                        radius: f.radius,
                        intensity: 1,
                        phase,
                        view: getViewMatrix(cam),
                    });
                    s.gpu.resolveGroup = s.temporal.scratchResolve;
                    s.temporal.data[48] = reset ? 1 : 0;
                    const encoder = device.createCommandEncoder();
                    executeSsaoGpu(s.gpu, encoder);
                    executeSsaoTemporalGpu(s.temporal, encoder);
                    device.queue.submit([encoder.finish()]);
                    if (s.gpu.visibility !== stable) {
                        throw new Error("Temporal filtering replaced the public visibility allocation.");
                    }
                    return scalar(await read(reset ? s.temporal.history[s.temporal.index]! : stable, f.width, f.height));
                };
                const average = new Float32Array(f.width * f.height);
                let first: Float32Array | undefined, second: Float32Array | undefined;
                for (let phase = 0; phase < 64; phase++) {
                    const image = await run(phase, true);
                    if (phase === 0) {
                        first = image;
                    }
                    if (phase === 1) {
                        second = image;
                    }
                    for (let i = 0; i < average.length; i++) {
                        average[i] = average[i]! + image[i]! / 64;
                    }
                }
                if (first!.every((v, i) => v === second![i])) {
                    throw new Error("XeGTAO sampling phase did not change.");
                }
                let accumulated: Float32Array = first!;
                for (let phase = 0; phase < 32; phase++) {
                    accumulated = await run(phase, phase === 0);
                }
                const mse = (image: Float32Array): number => {
                    let sum = 0;
                    for (let i = 0; i < image.length; i++) {
                        sum += (image[i]! - average[i]!) ** 2;
                    }
                    return sum / image.length;
                };
                const initialError = Math.sqrt(mse(first!)),
                    accumulatedError = Math.sqrt(mse(accumulated));
                const ratio = accumulatedError / initialError;
                if (ratio >= 0.8) {
                    throw new Error(`XeGTAO failed to reduce noise: ${initialError} -> ${accumulatedError}, ratio ${ratio}`);
                }
                results.push({ case: "XeGTAO: 32-frame convergence vs 64-phase mean", initialError, accumulatedError, ratio });
            } finally {
                s.dispose();
            }
        }
        await validateTemporalScene();
        results.push({ case: "real PBR motion/exclusion/stable output/toggles/resize" });
        const ghosting = await validateMovingOccluder();
        results.push({ case: `moving sphere: ${JSON.stringify(ghosting)}` });
        if (errors.length) {
            throw new Error(errors.join("\n"));
        }
        return results;
    } finally {
        device.destroy();
    }
}
