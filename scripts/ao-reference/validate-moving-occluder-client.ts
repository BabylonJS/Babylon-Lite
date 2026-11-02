import { createEngine, renderFrame } from "../../packages/babylon-lite/src/engine/engine.js";
import { createSceneContext, addToScene, registerScene, disposeScene } from "../../packages/babylon-lite/src/scene/scene-core.js";
import { createArcRotateCamera } from "../../packages/babylon-lite/src/camera/arc-rotate.js";
import { getViewMatrix, getViewProjectionMatrix } from "../../packages/babylon-lite/src/camera/camera.js";
import { invertMat4 } from "../../packages/babylon-lite/src/math/invert-mat4.js";
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
import { enableSsaoHalfResolution, createHalfSsaoGpu, bindHalfSsaoGpu, executeHalfSsaoGpu } from "../../packages/babylon-lite/src/post-process/ssao-half-resolution.js";
import type { HalfSsaoGpu } from "../../packages/babylon-lite/src/post-process/ssao-half-resolution.js";

/** Same receiver geometry, genuinely changing AO: rigid velocity alone cannot track the shadow. */
export async function validateMovingOccluder(profile: "default" | "close-up" | "close-up-reversal" = "default", halfResolution = false) {
    const closeUp = profile !== "default";
    const width = closeUp ? 668 : 160,
        height = closeUp ? 536 : 112,
        frames = closeUp ? 24 : 40,
        step = closeUp ? 0.01 : 0.035,
        pixels = width * height;
    const canvas = document.createElement("canvas");
    canvas.style.cssText = `width:${width}px;height:${height}px`;
    document.body.append(canvas);
    const engine = await createEngine(canvas, { msaaSamples: 1, maxDevicePixelRatio: 1, requiredLimits: { maxColorAttachmentBytesPerSample: 64 } });
    const device = engine._device,
        errors: string[] = [];
    const histories: GPUTexture[] = [];
    const counts: GPUTexture[] = [];
    let spatialInput: GPUTexture | undefined;
    let warpTexture: GPUTexture | undefined;
    let halfDepthTexture: GPUTexture | undefined;
    const allocate = device.createTexture.bind(device);
    device.createTexture = (descriptor: GPUTextureDescriptor): GPUTexture => {
        const texture = allocate(descriptor);
        if (descriptor.label === "ssao-spatial") spatialInput = texture;
        if (descriptor.label === "ssao-occlusion-history-transport") warpTexture = texture;
        if (descriptor.label === "ssao-half-depth") halfDepthTexture = texture;
        if (descriptor.label === "ssao-history-0") {
            histories[0] = texture;
        }
        if (descriptor.label === "ssao-history-1") {
            histories[1] = texture;
        }
        if (descriptor.label === "ssao-count-0") {
            counts[0] = texture;
        }
        if (descriptor.label === "ssao-count-1") {
            counts[1] = texture;
        }
        return texture;
    };
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    let reference: SsaoGpu | undefined;
    let halfReference: HalfSsaoGpu | undefined;
    const half = (value: number): number => {
        const e = (value >> 10) & 31,
            m = value & 1023;
        return (value & 32768 ? -1 : 1) * (e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15));
    };
    const read = async (texture: GPUTexture, fullFloat = false): Promise<Float32Array> => {
        const stride = texture.format === "r8unorm" ? 1 : texture.format === "r16float" ? 2 : texture.format === "r32float" ? 4 : fullFloat ? 16 : 8,
            pitch = Math.ceil((texture.width * stride) / 256) * 256;
        const buffer = device.createBuffer({ size: pitch * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: pitch }, [texture.width, texture.height]);
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const data = new DataView(buffer.getMappedRange()),
                result = new Float32Array(pixels * 4);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    for (let c = 0; c < 4; c++) {
                        const tx = Math.min(texture.width - 1, Math.floor(((x + 0.5) * texture.width) / width));
                        const ty = Math.min(texture.height - 1, Math.floor(((y + 0.5) * texture.height) / height));
                        const offset = ty * pitch + tx * stride;
                        result[(y * width + x) * 4 + c] =
                            stride === 1
                                ? c === 0
                                    ? data.getUint8(offset) / 255
                                    : 0
                                : stride === 4
                                  ? c === 0
                                      ? data.getFloat32(offset, true)
                                      : 0
                                  : stride === 2
                                    ? c === 0
                                        ? half(data.getUint16(offset, true))
                                        : 0
                                    : fullFloat
                                      ? data.getFloat32(offset + c * 4, true)
                                      : half(data.getUint16(offset + c * 2, true));
                    }
                }
            }
            return result;
        } finally {
            buffer.destroy();
        }
    };
    try {
        const camera = createArcRotateCamera(-Math.PI / 2.7, 1.08, closeUp ? 4.5 : 8.5, { x: 0, y: 0.75, z: 0 });
        camera.nearPlane = 0.1;
        camera.farPlane = 30;
        scene.camera = camera;
        const material = createPbrMaterial();
        const floor = createGround(engine, { width: 6, height: 6 });
        floor.material = material;
        addToScene(scene, floor);
        const sphere = createSphere(engine, { diameter: 1.5, segments: 32 });
        sphere.position.y = 0.75;
        sphere.position.x = -0.8;
        sphere.material = material;
        addToScene(scene, sphere);
        const box = createBox(engine, 0.8);
        box.position.x = closeUp ? -1.8 : -2.6;
        box.position.y = 0.4;
        box.position.z = -1.5;
        box.material = material;
        addToScene(scene, box);
        const geometry = createGeometryRendererTask(
            {
                samples: 1,
                textureDescriptions: [
                    { type: GeometryTextureType.VIEW_NORMAL },
                    { type: GeometryTextureType.LINEAR_VELOCITY, format: "rgba32float" },
                    { type: GeometryTextureType.WORLD_POSITION, format: "rgba32float" },
                ],
            },
            engine,
            scene
        );
        enableGeometryVelocity(geometry, { previousDepth: true });
        const ao = createSsaoTask({ depthTexture: geometry.geometryDepthTexture, normalTexture: geometry.geometryViewNormalTexture!, camera, radius: 0.6 }, engine, scene);
        enableSsaoTemporal(ao, { velocityTexture: geometry.geometryLinearVelocityTexture!, velocityHasPreviousDepth: true });
        const resolution = halfResolution ? enableSsaoHalfResolution(ao) : null;
        addTask(scene, geometry);
        addTask(scene, ao);
        await registerScene(scene);
        for (let i = 0; i < 32; i++) {
            renderFrame(engine, 16);
        }
        device.createTexture = allocate;
        const source = ao._gpu!;
        if (resolution?.active) {
            halfReference = createHalfSsaoGpu(device, width, height, "depth", true, false);
            reference = halfReference.gpu;
            bindHalfSsaoGpu(halfReference, geometry.geometryDepthTexture._depthTexture!.createView({ aspect: "depth-only" }), geometry.geometryViewNormalTexture!._colorView);
        } else {
            reference = createSsaoGpu(device, width, height, "depth", true);
            bindSsaoGpuSources(reference, source.sourceDepth!, source.sourceNormal);
        }
        const spatialFrame = async (phase: number): Promise<Float32Array> => {
            writeSsaoGpuParameters(reference!, {
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
            executeSsaoGpu(reference!, encoder);
            if (halfReference) executeHalfSsaoGpu(halfReference, encoder);
            device.queue.submit([encoder.finish()]);
            return read(reference!.outputTexture ?? reference!.visibility);
        };
        const referenceMean = async (): Promise<Float32Array> => {
            const mean = new Float32Array(pixels);
            for (let phase = 0; phase < 64; phase++) {
                const image = await spatialFrame(phase);
                for (let i = 0; i < pixels; i++) {
                    mean[i] = mean[i]! + image[i * 4]! / 64;
                }
            }
            return mean;
        };
        const initial = await referenceMean();
        const initialPositions = await read(geometry.geometryWorldPositionTexture!._colorTexture!, true);
        let maximumMeanTrail = 0,
            maximumTrail = 0,
            maximumMeanSpatialTrail = 0,
            maximumExcessTrail = 0,
            affected = 0;
        let worstTrailFrame = 0,
            worstTrailSamples = 0;
        const staticSum = new Float64Array(pixels),
            staticSquared = new Float64Array(pixels),
            staticSamples = new Uint32Array(pixels);
        const previousTemporal = new Float32Array(pixels),
            previousSpatial = new Float32Array(pixels);
        let previousPositions: Float32Array | undefined;
        let temporalChanges = 0,
            spatialChanges = 0,
            changingSamples = 0,
            floorConfidence = 0,
            floorResidualSquared = 0;
        let warpedFloorSamples = 0,
            scratchDifference = 0,
            warpError = 0,
            maximumWarpError = 0;
        const vp = getViewProjectionMatrix(camera, width / height);
        const invVp = invertMat4(vp)!;
        let sphereConfidence = 0,
            sphereSamples = 0,
            sphereLongHistory = 0;
        let sphereTemporalChanges = 0,
            sphereSpatialChanges = 0,
            sphereMatchedSamples = 0;
        let occludedConfidence = 0,
            occludedSamples = 0,
            occludedLong = 0;
        for (let frame = 1; frame <= frames; frame++) {
            const previousSphereX = sphere.position.x;
            const progress = profile === "close-up-reversal" ? Math.min(frame, 8, frames - frame) : frame;
            sphere.position.x = -0.8 + progress * step;
            const displacement = sphere.position.x - previousSphereX;
            renderFrame(engine, 16);
            const actual = await read(ao.outputTexture._colorTexture!);
            const spatial = await spatialFrame(source.integers[23]!);
            if (halfResolution && spatialInput) {
                const input = await read(spatialInput);
                const baseline = await read(reference!.outputTexture ?? reference!.visibility);
                for (let p = 0; p < pixels; p++) scratchDifference = Math.max(scratchDifference, Math.abs(input[p * 4]! - baseline[p * 4]!));
            }
            const current = await referenceMean();
            const positions = await read(geometry.geometryWorldPositionTexture!._colorTexture!, true);
            const history = await read(histories[frame % 2]!);
            const historyCounts = await read(counts[frame % 2]!);
            for (let p = 0; p < pixels; p++) {
                history[p * 4 + 1] = historyCounts[p * 4]!;
            }
            const velocity = await read(geometry.geometryLinearVelocityTexture!._colorTexture!, true);
            const warp = warpTexture ? await read(warpTexture, true) : null;
            const lowDepth = halfDepthTexture ? await read(halfDepthTexture) : null;
            let total = 0,
                spatialTotal = 0,
                count = 0;
            for (let i = 0; i < pixels; i++) {
                if (positions[i * 4 + 1]! > 0.1 && Math.abs(positions[i * 4]! - sphere.position.x) < 0.8) {
                    const confidence = history[i * 4 + 1]!;
                    sphereConfidence += confidence;
                    sphereSamples++;
                    if (confidence >= 8) {
                        sphereLongHistory++;
                    }
                    if (current[i]! < 0.95) {
                        occludedConfidence += confidence;
                        occludedSamples++;
                        if (confidence >= 8) {
                            occludedLong++;
                        }
                    }
                    if (previousPositions) {
                        const x = i % width,
                            y = Math.floor(i / width);
                        const px = x + velocity[i * 4]! * width,
                            py = y - velocity[i * 4 + 1]! * height;
                        const bx = Math.floor(px),
                            by = Math.floor(py),
                            fx = px - bx,
                            fy = py - by;
                        let oldTemporal = 0,
                            oldSpatial = 0,
                            coverage = 0;
                        for (let oy = 0; oy < 2; oy++) {
                            for (let ox = 0; ox < 2; ox++) {
                                const qx = bx + ox,
                                    qy = by + oy;
                                if (qx < 0 || qy < 0 || qx >= width || qy >= height) {
                                    continue;
                                }
                                const q = qy * width + qx;
                                if (previousPositions[q * 4 + 1]! <= 0.1 || Math.abs(previousPositions[q * 4]! - previousSphereX) >= 0.8) {
                                    continue;
                                }
                                const expectedX = positions[i * 4]! - displacement;
                                const distance =
                                    (previousPositions[q * 4]! - expectedX) ** 2 +
                                    (previousPositions[q * 4 + 1]! - positions[i * 4 + 1]!) ** 2 +
                                    (previousPositions[q * 4 + 2]! - positions[i * 4 + 2]!) ** 2;
                                if (distance > 0.04) {
                                    continue;
                                }
                                const weight = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
                                oldTemporal += previousTemporal[q]! * weight;
                                oldSpatial += previousSpatial[q]! * weight;
                                coverage += weight;
                            }
                        }
                        if (coverage > 0.5) {
                            sphereTemporalChanges += (actual[i * 4]! - current[i]! - oldTemporal / coverage) ** 2;
                            sphereSpatialChanges += (spatial[i * 4]! - current[i]! - oldSpatial / coverage) ** 2;
                            sphereMatchedSamples++;
                        }
                    }
                }
                const temporalResidual = actual[i * 4]! - current[i]!,
                    spatialResidual = spatial[i * 4]! - current[i]!;
                if (
                    previousPositions &&
                    Math.abs(positions[i * 4 + 1]!) < 1e-4 &&
                    Math.abs(previousPositions[i * 4 + 1]!) < 1e-4 &&
                    current[i]! < 0.98 &&
                    (positions[i * 4]! - sphere.position.x) ** 2 + positions[i * 4 + 2]! ** 2 < 2.25
                ) {
                    temporalChanges += (temporalResidual - previousTemporal[i]!) ** 2;
                    spatialChanges += (spatialResidual - previousSpatial[i]!) ** 2;
                    changingSamples++;
                    if (warp && warp[i * 4 + 3]! > 0) {
                        warpedFloorSamples++;
                        if (lowDepth) {
                            const u = (Math.floor((((i % width) + 0.5) * source.width) / width) + 0.5) / source.width;
                            const v = (Math.floor(((Math.floor(i / width) + 0.5) * source.height) / height) + 0.5) / source.height;
                            const d = lowDepth[i * 4]!,
                                nx = u * 2 - 1,
                                ny = 1 - v * 2;
                            const w = invVp[3]! * nx + invVp[7]! * ny + invVp[11]! * d + invVp[15]!;
                            const x = (invVp[0]! * nx + invVp[4]! * ny + invVp[8]! * d + invVp[12]!) / w - displacement;
                            const y = (invVp[1]! * nx + invVp[5]! * ny + invVp[9]! * d + invVp[13]!) / w;
                            const z = (invVp[2]! * nx + invVp[6]! * ny + invVp[10]! * d + invVp[14]!) / w;
                            const cw = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!;
                            const eu = ((vp[0]! * x + vp[4]! * y + vp[8]! * z + vp[12]!) / cw) * 0.5 + 0.5;
                            const ev = 0.5 - ((vp[1]! * x + vp[5]! * y + vp[9]! * z + vp[13]!) / cw) * 0.5;
                            const error = Math.hypot((eu - warp[i * 4]!) * source.width, (ev - warp[i * 4 + 1]!) * source.height);
                            warpError += error;
                            maximumWarpError = Math.max(maximumWarpError, error);
                        }
                    }
                    floorConfidence += history[i * 4 + 1]!;
                    floorResidualSquared += temporalResidual * temporalResidual;
                }
                if (positions[i * 4]! < -1.5 && positions[i * 4 + 1]! > 0.1 && positions[i * 4 + 2]! < -1) {
                    const residual = actual[i * 4]! - current[i]!;
                    staticSum[i] = staticSum[i]! + residual;
                    staticSquared[i] = staticSquared[i]! + residual * residual;
                    staticSamples[i] = staticSamples[i]! + 1;
                }
                if (Math.abs(initialPositions[i * 4 + 1]!) > 1e-4 || Math.abs(positions[i * 4 + 1]!) > 1e-4 || initial[i]! >= 0.94 || current[i]! - initial[i]! < 0.04) {
                    continue;
                }
                const trail = Math.max(0, current[i]! - actual[i * 4]!);
                total += trail;
                spatialTotal += Math.max(0, current[i]! - spatial[i * 4]!);
                count++;
                maximumTrail = Math.max(maximumTrail, trail);
            }
            for (let i = 0; i < pixels; i++) {
                previousTemporal[i] = actual[i * 4]! - current[i]!;
                previousSpatial[i] = spatial[i * 4]! - current[i]!;
            }
            previousPositions = positions;
            affected += count;
            if (count) {
                maximumMeanTrail = Math.max(maximumMeanTrail, total / count);
                maximumMeanSpatialTrail = Math.max(maximumMeanSpatialTrail, spatialTotal / count);
                if ((total - spatialTotal) / count > maximumExcessTrail) {
                    maximumExcessTrail = (total - spatialTotal) / count;
                    worstTrailFrame = frame;
                    worstTrailSamples = count;
                }
            }
        }
        if (errors.length) {
            throw new Error(errors.join("\n"));
        }
        const floorDiagnostics = `floor flicker RMS ${Math.sqrt(temporalChanges / changingSamples)}, residual RMS ${Math.sqrt(floorResidualSquared / changingSamples)}, mean confidence ${floorConfidence / changingSamples}, warped ${warpedFloorSamples}/${changingSamples}, scratch difference ${scratchDifference}, warp error ${warpError / warpedFloorSamples} max ${maximumWarpError}`;
        if (affected < 100) {
            throw new Error("Moving-sphere ghosting check did not exercise enough newly lit stationary receivers.");
        }
        if (maximumExcessTrail > 0.015) {
            throw new Error(
                `Temporal AO added a visible moving-sphere trail beyond current-frame sampling noise: ${maximumExcessTrail}; frame ${worstTrailFrame}, pixels ${worstTrailSamples}; ${floorDiagnostics}`
            );
        }
        if (errors.length) {
            throw new Error(errors.join("\n"));
        }
        let variance = 0,
            staticPixels = 0;
        for (let i = 0; i < pixels; i++) {
            if (staticSamples[i]! >= frames - 2) {
                const mean = staticSum[i]! / staticSamples[i]!;
                variance += Math.max(0, staticSquared[i]! / staticSamples[i]! - mean * mean);
                staticPixels++;
            }
        }
        if (staticPixels < 10) {
            throw new Error("Flicker check did not cover the stationary box.");
        }
        const staticFlickerRms = Math.sqrt(variance / staticPixels);
        const motionFlickerRatio = Math.sqrt(temporalChanges / Math.max(spatialChanges, 1e-12));
        if (staticFlickerRms > 0.003) {
            throw new Error(
                `Stationary-object AO flicker exceeded its budget: ${staticFlickerRms}; pixels ${staticPixels}; floor flicker ${motionFlickerRatio}, RMS ${Math.sqrt(temporalChanges / changingSamples)}, confidence ${floorConfidence / changingSamples}, residual ${Math.sqrt(floorResidualSquared / changingSamples)}`
            );
        }
        if (changingSamples < 100) {
            throw new Error("Moving-area flicker check did not exercise enough receivers.");
        }
        if (motionFlickerRatio > 0.6) {
            throw new Error(
                `Moving-area temporal AO exposed too much sample flicker: ${motionFlickerRatio}, floor RMS ${Math.sqrt(temporalChanges / changingSamples)}, confidence ${floorConfidence / changingSamples}`
            );
        }
        const floorFlickerRms = Math.sqrt(temporalChanges / changingSamples);
        const floorResidualRms = Math.sqrt(floorResidualSquared / changingSamples);
        if (closeUp && floorFlickerRms > 0.01) {
            throw new Error(`Close-up floor AO shimmer exceeded its absolute budget: ${floorFlickerRms}; ${floorDiagnostics}`);
        }
        if (closeUp && floorResidualRms > 0.02) {
            throw new Error(`Close-up floor filtering distorted the current AO signal: ${floorResidualRms}; ${floorDiagnostics}`);
        }
        const sphereFlickerRatio = Math.sqrt(sphereTemporalChanges / Math.max(sphereSpatialChanges, 1e-12));
        const sphereLongHistoryFraction = sphereLongHistory / sphereSamples;
        if (sphereMatchedSamples < 100) {
            throw new Error("Moving-surface flicker check did not cover enough matched sphere points.");
        }
        if (sphereLongHistoryFraction < 0.6) {
            throw new Error(`Moving-sphere valid history was not retained: ${sphereLongHistoryFraction}; mean count ${sphereConfidence / sphereSamples}; ${floorDiagnostics}`);
        }
        if (!closeUp && (occludedSamples < 100 || occludedLong / occludedSamples < 0.6)) {
            throw new Error(
                `Moving-sphere occluded surface did not retain enough valid history: ${occludedLong / occludedSamples}; mean count ${occludedConfidence / occludedSamples}.`
            );
        }
        if (!closeUp && sphereFlickerRatio > 0.5) {
            throw new Error(`Moving-sphere surface flicker exceeded its budget: ${sphereFlickerRatio}`);
        }
        return {
            profile,
            halfResolution,
            halfActive: resolution?.active ?? false,
            affected,
            maximumMeanTrail,
            maximumTrail,
            maximumMeanSpatialTrail,
            maximumExcessTrail,
            staticPixels,
            staticFlickerRms,
            motionFlickerRatio,
            floorFlickerRms,
            floorResidualRms,
            meanFloorConfidence: floorConfidence / changingSamples,
            meanSphereConfidence: sphereConfidence / sphereSamples,
            sphereLongHistoryFraction,
            meanOccludedConfidence: occludedConfidence / occludedSamples,
            occludedLongHistoryFraction: occludedLong / occludedSamples,
            sphereFlickerRatio,
            sphereMatchedSamples,
        };
    } finally {
        if (reference) {
            disposeSsaoGpu(reference);
        }
        disposeScene(scene);
        canvas.remove();
        device.destroy();
    }
}
