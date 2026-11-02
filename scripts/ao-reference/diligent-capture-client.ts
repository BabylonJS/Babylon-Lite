import { createEngine, renderFrame } from "../../packages/babylon-lite/src/engine/engine.js";
import { createRenderTarget, disposeRenderTarget } from "../../packages/babylon-lite/src/engine/render-target.js";
import { createSceneContext, addToScene, registerScene, disposeScene } from "../../packages/babylon-lite/src/scene/scene-core.js";
import { createArcRotateCamera } from "../../packages/babylon-lite/src/camera/arc-rotate.js";
import { getViewMatrix, getProjectionMatrix, getViewProjectionMatrix } from "../../packages/babylon-lite/src/camera/camera.js";
import type { Camera } from "../../packages/babylon-lite/src/camera/camera.js";
import type { ArcRotateCamera } from "../../packages/babylon-lite/src/camera/arc-rotate.js";
import type { Mesh } from "../../packages/babylon-lite/src/mesh/mesh.js";
import { createGround, createSphere, createBox } from "../../packages/babylon-lite/src/mesh/mesh-factories.js";
import { createPbrMaterial } from "../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { createGeometryRendererTask } from "../../packages/babylon-lite/src/frame-graph/geometry-renderer-task.js";
import { enableGeometryVelocity } from "../../packages/babylon-lite/src/frame-graph/enable-geometry-velocity.js";
import { GeometryTextureType } from "../../packages/babylon-lite/src/frame-graph/geometry-types.js";
import { addTask } from "../../packages/babylon-lite/src/frame-graph/frame-graph-actions.js";
import { createSsaoTask } from "../../packages/babylon-lite/src/post-process/ssao.js";
import { enableSsaoTemporal } from "../../packages/babylon-lite/src/post-process/ssao-temporal.js";
import { bindSsaoGpuSources, createSsaoGpu, disposeSsaoGpu, executeSsaoGpu, writeSsaoGpuParameters } from "../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import type { SsaoGpu } from "../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import { createIdentityMat4 } from "../../packages/babylon-lite/src/math/create-identity-mat4.js";
import { invertMat4ToRefOrIdentity } from "../../packages/babylon-lite/src/math/invert-mat4-to-ref-or-identity.js";
import { diligentFrame, diligentFrameBytes, diligentFrameCount, DILIGENT_CAMERA_BYTES, DILIGENT_FRAME_MAGIC, transposeCameraMatrix, unorm8ToHalf } from "./diligent-contract.js";
import type { DiligentCaptureConfig, DiligentCaptureFrame } from "./diligent-contract.js";
import { createKitchenScene, moveKitchenCamera } from "../../lab/lite/src/shared/kitchen-scene.js";
import { createDiligentNormalInput } from "./diligent-normal-input.js";

function cameraBytes(camera: Camera, config: DiligentCaptureConfig, index: number): Uint8Array<ArrayBuffer> {
    const data = new Float32Array(DILIGENT_CAMERA_BYTES / 4);
    const bits = new Uint32Array(data.buffer);
    const view = getViewMatrix(camera);
    const projection = getProjectionMatrix(camera, config.width / config.height);
    const viewProjection = getViewProjectionMatrix(camera, config.width / config.height);
    const inverseProjection = createIdentityMat4();
    const inverseViewProjection = createIdentityMat4();
    invertMat4ToRefOrIdentity(projection, inverseProjection);
    invertMat4ToRefOrIdentity(viewProjection, inverseViewProjection);
    const world = camera.worldMatrix;
    data.set([world[12]!, world[13]!, world[14]!, 1, config.width, config.height, 1 / config.width, 1 / config.height]);
    data.set([camera.nearPlane, camera.farPlane, 1, 0, camera.nearPlane, camera.farPlane, 1, 0, -1], 8);
    bits[17] = index;
    for (const [matrixIndex, matrix] of [view, projection, viewProjection, world, inverseProjection, inverseViewProjection].entries()) {
        transposeCameraMatrix(data, 28 + matrixIndex * 16, matrix);
    }
    return new Uint8Array(data.buffer);
}

export async function captureDiligentSequence(config: DiligentCaptureConfig): Promise<{ frames: DiligentCaptureFrame[]; fov: number; signedNormalSha256?: string }> {
    const canvas = document.createElement("canvas");
    canvas.style.cssText = `width:${config.width}px;height:${config.height}px`;
    document.body.append(canvas);
    const engine = await createEngine(canvas, { msaaSamples: 1, maxDevicePixelRatio: 1, requiredLimits: { maxColorAttachmentBytesPerSample: 64 } });
    const device = engine._device;
    const errors: string[] = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    let spatial: GPUTexture | undefined;
    let accumulated: GPUTexture | undefined;
    const histories: GPUTexture[] = [];
    const allocate = device.createTexture.bind(device);
    device.createTexture = (descriptor: GPUTextureDescriptor): GPUTexture => {
        const readableDepth = descriptor.format === "depth32float" && (descriptor.sampleCount ?? 1) === 1;
        const texture = allocate(readableDepth ? { ...descriptor, usage: descriptor.usage | GPUTextureUsage.COPY_SRC } : descriptor);
        if (descriptor.label === "ssao-spatial") {
            spatial = texture;
        }
        if (descriptor.label === "ssao-history-0") {
            histories[0] = texture;
        }
        if (descriptor.label === "ssao-history-1") {
            histories[1] = texture;
        }
        if (descriptor.label === "ssao-diligent-temporal") {
            accumulated = texture;
        }
        return texture;
    };
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    const color =
        config.scene === "kitchen"
            ? createRenderTarget({ lbl: "diligent-common-color", format: "rgba8unorm", samples: 1, size: { width: config.width, height: config.height } })
            : undefined;
    let reference: SsaoGpu | undefined;
    let meanBuffer: GPUBuffer | undefined;
    let meanReadback: GPUBuffer | undefined;
    let meanPipeline: GPUComputePipeline | undefined;
    let meanGroup: GPUBindGroup | undefined;
    const means = new Map<number, Uint8Array<ArrayBuffer>>();
    let signedNormalSha256: string | undefined;
    const read = async (texture: GPUTexture, bytes: number, aspect: GPUTextureAspect = "all"): Promise<Uint8Array<ArrayBuffer>> => {
        const pitch = Math.ceil((config.width * bytes) / 256) * 256;
        const buffer = device.createBuffer({ size: pitch * config.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture, aspect }, { buffer, bytesPerRow: pitch }, [config.width, config.height]);
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(buffer.getMappedRange());
            const packed = new Uint8Array(config.width * config.height * bytes);
            for (let y = 0; y < config.height; y++) {
                packed.set(mapped.subarray(y * pitch, y * pitch + config.width * bytes), y * config.width * bytes);
            }
            return packed;
        } finally {
            buffer.destroy();
        }
    };
    const scalar = (rgba: Uint8Array): Uint8Array<ArrayBuffer> => {
        const data = new Uint8Array(config.width * config.height * 2);
        for (let i = 0; i < data.length / 2; i++) {
            data[i * 2] = rgba[i * 8]!;
            data[i * 2 + 1] = rgba[i * 8 + 1]!;
        }
        return data;
    };
    try {
        let camera: ArcRotateCamera;
        let sphere: Mesh | null = null;
        if (config.scene === "kitchen") {
            camera = await createKitchenScene(engine, scene, "/lab/public/ssao-comparison/kitchen.glb");
        } else {
            camera = createArcRotateCamera(-Math.PI / 2.7, 1.08, 4.5, { x: 0, y: 0.75, z: 0 });
            camera.nearPlane = 0.1;
            camera.farPlane = 30;
            scene.camera = camera;
            const material = createPbrMaterial();
            const floor = createGround(engine, { width: 6, height: 6 });
            floor.material = material;
            addToScene(scene, floor);
            sphere = createSphere(engine, { diameter: 1.5, segments: 32 });
            sphere.position.y = 0.75;
            sphere.position.x = -0.8;
            sphere.material = material;
            addToScene(scene, sphere);
            const box = createBox(engine, 0.8);
            box.position.x = -1.8;
            box.position.y = 0.4;
            box.position.z = -1.5;
            box.material = material;
            addToScene(scene, box);
        }
        const geometry = createGeometryRendererTask(
            {
                samples: 1,
                targetTexture: color,
                targetTextureClearColor: color ? { r: 0.06, g: 0.075, b: 0.09, a: 1 } : undefined,
                textureDescriptions: [
                    { type: GeometryTextureType.VIEW_NORMAL, format: "rgba16float" },
                    { type: GeometryTextureType.WORLD_NORMAL, format: "rgba16float" },
                    { type: GeometryTextureType.LINEAR_VELOCITY, format: "rgba32float" },
                    { type: GeometryTextureType.WORLD_POSITION, format: "rgba32float" },
                ],
            },
            engine,
            scene
        );
        enableGeometryVelocity(geometry, { previousDepth: true });
        const signed = config.scene === "kitchen" ? createDiligentNormalInput(engine, geometry.geometryWorldNormalTexture!, config.width, config.height) : null;
        const ao = createSsaoTask(
            {
                depthTexture: geometry.geometryDepthTexture,
                normalTexture: signed?.outputTexture ?? geometry.geometryViewNormalTexture!,
                normalSpace: signed ? "world" : "view",
                camera,
                radius: 0.6,
            },
            engine,
            scene
        );
        enableSsaoTemporal(ao, { velocityTexture: geometry.geometryLinearVelocityTexture!, velocityHasPreviousDepth: true });
        addTask(scene, geometry);
        if (signed) {
            addTask(scene, signed);
        }
        addTask(scene, ao);
        await registerScene(scene);
        let previousCamera = cameraBytes(camera, config, 0);
        const frames: DiligentCaptureFrame[] = [];
        for (let index = 0; index < diligentFrameCount(config); index++) {
            const frame = diligentFrame(config, index);
            if (sphere) {
                sphere.position.x = frame.sphereX;
            } else {
                moveKitchenCamera(camera, frame.sphereX + 0.8);
                frame.cameraAngle = camera.alpha;
            }
            renderFrame(engine, 1000 / 60);
            if (!spatial || !histories[0] || !histories[1]) {
                throw new Error("Capture did not find the actual AO input/history allocations.");
            }
            device.createTexture = allocate;
            const currentCamera = cameraBytes(camera, config, index);
            if (color) {
                const rgba = await read(color._colorTexture!, 4);
                const compressedColor = await new Response(new Blob([rgba]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
                const response = await fetch(`/diligent-color/${index}`, { method: "POST", body: compressedColor });
                if (!response.ok) {
                    throw new Error(`Cannot save color frame ${index}: ${await response.text()}`);
                }
            }
            const packet = new Uint8Array(diligentFrameBytes(config, index));
            const header = new Uint32Array(packet.buffer, 0, 4);
            header.set([DILIGENT_FRAME_MAGIC, index, config.width, config.height]);
            packet.set(currentCamera, 16);
            packet.set(previousCamera, 16 + DILIGENT_CAMERA_BYTES);
            let offset = 16 + 2 * DILIGENT_CAMERA_BYTES;
            const append = (bytes: Uint8Array): void => {
                packet.set(bytes, offset);
                offset += bytes.length;
            };
            append(await read(geometry.geometryDepthTexture._depthTexture!, 4, "depth-only"));
            append(await read(geometry.geometryWorldNormalTexture!._colorTexture!, 8));
            if (signed) {
                const bytes = await read(signed.outputTexture._colorTexture!, 8);
                frame.signedNormalSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
                    .map((value) => value.toString(16).padStart(2, "0"))
                    .join("");
                if (index === 0) {
                    signedNormalSha256 = frame.signedNormalSha256;
                }
            }
            const supplied = new Float32Array((await read(geometry.geometryLinearVelocityTexture!._colorTexture!, 16)).buffer);
            const motion = new Float32Array(config.width * config.height * 2);
            for (let i = 0; i < motion.length / 2; i++) {
                motion[i * 2] = -2 * supplied[i * 4]!;
                motion[i * 2 + 1] = -2 * supplied[i * 4 + 1]!;
            }
            append(new Uint8Array(motion.buffer));
            append(scalar(await read(spatial, 8)));
            if (!accumulated) {
                throw new Error("Capture did not find the native-format temporal intermediate.");
            }
            const accumulatedBytes = await read(accumulated, 1);
            const accumulatedHalf = new Uint16Array(config.width * config.height);
            for (let p = 0; p < accumulatedHalf.length; p++) {
                accumulatedHalf[p] = unorm8ToHalf(accumulatedBytes[p]!);
            }
            append(new Uint8Array(accumulatedHalf.buffer));
            append(scalar(await read(ao.outputTexture._colorTexture!, 8)));
            if (index === 0) {
                append(await read(geometry.geometryWorldPositionTexture!._colorTexture!, 16));
            }
            packet[offset++] = 0x7f;
            if (offset !== packet.length || errors.length) {
                throw new Error(`Invalid captured frame: ${offset}/${packet.length}; ${errors.join("\n")}`);
            }
            if (config.withReferenceMean) {
                if (!reference) {
                    reference = createSsaoGpu(device, config.width, config.height, "depth", true);
                    bindSsaoGpuSources(reference, ao._gpu!.sourceDepth!, ao._gpu!.sourceNormal);
                    meanBuffer = device.createBuffer({ size: config.width * config.height * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
                    meanReadback = device.createBuffer({ size: config.width * config.height * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
                    meanPipeline = device.createComputePipeline({
                        layout: "auto",
                        compute: {
                            module: device.createShaderModule({
                                code: `@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> sums:array<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
let size=textureDimensions(source);if(any(id.xy>=size)){return;}
let i=id.y*size.x+id.x;sums[i]+=textureLoad(source,vec2i(id.xy),0).r/64.0;
}`,
                            }),
                            entryPoint: "main",
                        },
                    });
                    meanGroup = device.createBindGroup({
                        layout: meanPipeline.getBindGroupLayout(0),
                        entries: [
                            { binding: 0, resource: reference.visibility.createView() },
                            { binding: 1, resource: { buffer: meanBuffer } },
                        ],
                    });
                }
                let mean = means.get(frame.sphereX);
                if (!mean) {
                    const clear = device.createCommandEncoder();
                    clear.clearBuffer(meanBuffer!);
                    device.queue.submit([clear.finish()]);
                    const source = ao._gpu!;
                    for (let phase = 0; phase < 64; phase++) {
                        writeSsaoGpuParameters(reference, {
                            depthMultiply: source.data[4]!,
                            depthAdd: source.data[5]!,
                            tanX: source.data[6]!,
                            tanY: source.data[7]!,
                            far: 30,
                            radius: 0.6,
                            intensity: 1,
                            phase,
                            view: getViewMatrix(camera),
                        });
                        const encoder = device.createCommandEncoder();
                        executeSsaoGpu(reference, encoder);
                        const pass = encoder.beginComputePass();
                        pass.setPipeline(meanPipeline!);
                        pass.setBindGroup(0, meanGroup!);
                        pass.dispatchWorkgroups(Math.ceil(config.width / 8), Math.ceil(config.height / 8));
                        pass.end();
                        device.queue.submit([encoder.finish()]);
                        if (phase === source.integers[23]) {
                            const repeated = scalar(await read(reference.visibility, 8));
                            const captured = scalar(await read(spatial, 8));
                            if (repeated.some((value, i) => value !== captured[i])) {
                                throw new Error("The fixed-pose sampler did not reproduce the actual noisy AO input.");
                            }
                        }
                    }
                    const encoder = device.createCommandEncoder();
                    encoder.copyBufferToBuffer(meanBuffer!, 0, meanReadback!, 0, config.width * config.height * 4);
                    device.queue.submit([encoder.finish()]);
                    await meanReadback!.mapAsync(GPUMapMode.READ);
                    mean = new Uint8Array(meanReadback!.getMappedRange().slice(0));
                    meanReadback!.unmap();
                    means.set(frame.sphereX, mean);
                }
                const compressedMean = await new Response(new Blob([mean]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
                if (errors.length) {
                    throw new Error(errors.join("\n"));
                }
                const response = await fetch(`/diligent-mean/${index}`, { method: "POST", body: compressedMean });
                if (!response.ok) {
                    throw new Error(`Cannot save fixed-pose mean ${index}: ${await response.text()}`);
                }
            }
            const compressed = await new Response(new Blob([packet]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
            const response = await fetch(`/diligent-frame/${index}`, { method: "POST", body: compressed });
            if (!response.ok) {
                throw new Error(`Cannot save frame ${index}: ${await response.text()}`);
            }
            frames.push({ ...frame, phase: ao._gpu!.integers[23]! });
            previousCamera = currentCamera;
        }
        return { frames, fov: camera.fov, signedNormalSha256 };
    } finally {
        device.createTexture = allocate;
        if (reference) {
            disposeSsaoGpu(reference);
        }
        meanBuffer?.destroy();
        meanReadback?.destroy();
        disposeScene(scene);
        if (color) {
            disposeRenderTarget(color);
        }
        canvas.remove();
        device.destroy();
    }
}
