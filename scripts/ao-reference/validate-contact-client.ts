import { renderFrame } from "../../packages/babylon-lite/src/engine/engine.js";
import type { EngineContext } from "../../packages/babylon-lite/src/engine/engine.js";
import type { ArcRotateCamera } from "../../packages/babylon-lite/src/camera/arc-rotate.js";
import { getViewMatrix, getViewProjectionMatrix } from "../../packages/babylon-lite/src/camera/camera.js";
import type { Mesh } from "../../packages/babylon-lite/src/mesh/mesh.js";
import type { SsaoTask } from "../../packages/babylon-lite/src/post-process/ssao.js";
import type { SsaoTemporalSettings } from "../../packages/babylon-lite/src/post-process/ssao-temporal.js";
import type { DiligentTemporalGpu } from "../../packages/babylon-lite/src/post-process/ssao-diligent-gpu.js";
import { resetSsaoTemporal } from "../../packages/babylon-lite/src/post-process/ssao-temporal.js";
import { bindSsaoGpuSources, createSsaoGpu, disposeSsaoGpu, executeSsaoGpu, writeSsaoGpuParameters } from "../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import type { SsaoGpu } from "../../packages/babylon-lite/src/post-process/ssao-gpu.js";
import { bindHalfSsaoGpu, createHalfSsaoGpu, executeHalfSsaoGpu } from "../../packages/babylon-lite/src/post-process/ssao-half-resolution.js";
import type { HalfSsaoGpu } from "../../packages/babylon-lite/src/post-process/ssao-half-resolution.js";
import { geometryNormal, halfToFloat } from "./diligent-contract.js";
import { contactViolations, summarizeContact, summarizeContactTrail } from "./contact-contract.js";
import type { ContactFrame } from "./contact-contract.js";

interface Point {
    x: number;
    z: number;
}
export interface ContactCase {
    resolution: "full" | "half";
    providedNormals: boolean;
}

/** Test-only actual-demo stepping; no screenshots, profiler or runtime hooks. */
export function exposeContactValidation(engine: EngineContext, ao: SsaoTask, temporal: SsaoTemporalSettings, camera: ArcRotateCamera, sphere: Mesh) {
    const device = engine._device;
    const errors: string[] = [];
    const onError = (event: GPUUncapturedErrorEvent) => {
        errors.push(event.error.message);
    };
    device.addEventListener("uncapturederror", onError);
    const prepare = temporal._prepareGpu;
    let owner: DiligentTemporalGpu | undefined;
    temporal._prepareGpu = (current, velocity) => {
        prepare?.(current, velocity);
        owner = current;
    };
    const initialAlpha = camera.alpha,
        initialBeta = camera.beta;
    const alpha = initialAlpha;
    let reference: SsaoGpu | undefined, sparse: HalfSsaoGpu | undefined;
    const grid = (x: number): Point[] => {
        const eye = camera.worldMatrix;
        const dx = eye[12]! - x,
            dz = eye[14]! - sphere.position.z,
            distance = Math.hypot(dx, dz);
        const fx = dx / distance,
            fz = dz / distance;
        const points: Point[] = [];
        for (let row = 0; row < 24; row++)
            for (let col = 0; col < 32; col++) {
                const side = -0.4 + (0.8 * col) / 31,
                    front = 0.1 + (0.55 * row) / 23;
                points.push({ x: x + fx * front - fz * side, z: sphere.position.z + fz * front + fx * side });
            }
        return points;
    };
    const sample = async (textures: GPUTexture[], points: readonly Point[], floorMask: boolean) => {
        if (!owner) throw new Error("Contact validation did not prepare temporal history.");
        const width = engine.canvas.width,
            height = engine.canvas.height;
        const vp = getViewProjectionMatrix(camera, width / height);
        const projected = points.map((point) => {
            const { x, z } = point;
            const cx = vp[0]! * x + vp[8]! * z + vp[12]!,
                cy = vp[1]! * x + vp[9]! * z + vp[13]!,
                cw = vp[3]! * x + vp[11]! * z + vp[15]!;
            if (!(cw > 0) || !Number.isFinite(cx + cy + cw)) throw new Error("Contact probe projection is invalid.");
            return { x: ((cx / cw) * 0.5 + 0.5) * width - 0.5, y: (0.5 - (cy / cw) * 0.5) * height - 0.5 };
        });
        const left = Math.max(0, Math.floor(Math.min(...projected.map((p) => p.x))) - 1);
        const top = Math.max(0, Math.floor(Math.min(...projected.map((p) => p.y))) - 1);
        const right = Math.min(width - 1, Math.ceil(Math.max(...projected.map((p) => p.x))) + 1);
        const bottom = Math.min(height - 1, Math.ceil(Math.max(...projected.map((p) => p.y))) + 1);
        if (right < left || bottom < top) throw new Error("Contact probe lies outside the viewport.");
        const size = [right - left + 1, bottom - top + 1];
        const sources = [...textures, ...(floorMask ? [owner.geometry] : [])];
        const pitches = sources.map((texture) => Math.ceil((size[0]! * (texture.format === "rgba32float" ? 16 : 8)) / 256) * 256);
        const buffers = pitches.map((pitch) => device.createBuffer({ size: pitch * size[1]!, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
        try {
            const encoder = device.createCommandEncoder();
            for (let i = 0; i < sources.length; i++) {
                if (sources[i]!.width !== width || sources[i]!.height !== height) throw new Error("Contact texture dimensions do not match projection.");
                encoder.copyTextureToBuffer({ texture: sources[i]!, origin: [left, top] }, { buffer: buffers[i]!, bytesPerRow: pitches[i]! }, size);
            }
            device.queue.submit([encoder.finish()]);
            await Promise.all(buffers.map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
            const views = buffers.map((buffer) => new DataView(buffer.getMappedRange()));
            const result = textures.map(() => [] as (number | null)[]);
            for (const p of projected) {
                const x = Math.floor(p.x),
                    y = Math.floor(p.y),
                    u = p.x - x,
                    v = p.y - y;
                let valid = x >= left && y >= top && x + 1 <= right && y + 1 <= bottom;
                const values = textures.map(() => 0);
                for (let dy = 0; dy < 2 && valid; dy++)
                    for (let dx = 0; dx < 2; dx++) {
                        const qx = x + dx - left,
                            qy = y + dy - top;
                        if (floorMask) {
                            const normalY = geometryNormal(views[textures.length]!.getUint32(qy * pitches[textures.length]! + qx * 8 + 4, true))[1];
                            if (!Number.isFinite(normalY)) throw new Error("Contact geometry contains invalid normals.");
                            if (normalY <= 0.98) {
                                valid = false;
                                break;
                            }
                        }
                        const weight = (dx ? u : 1 - u) * (dy ? v : 1 - v);
                        for (let i = 0; i < textures.length; i++) {
                            if (textures[i]!.format !== "rgba16float") throw new Error("Contact AO probes require RGBA16 float data.");
                            const value = halfToFloat(views[i]!.getUint16(qy * pitches[i]! + qx * 8, true));
                            if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Contact AO contains invalid visibility.");
                            values[i] = values[i]! + weight * value;
                        }
                    }
                for (let i = 0; i < textures.length; i++) result[i]!.push(valid ? values[i]! : null);
            }
            if (errors.length) throw new Error(errors.join("\n"));
            return result;
        } finally {
            for (const buffer of buffers) buffer.destroy();
        }
    };
    const observed = async (points: readonly Point[]): Promise<ContactFrame> => {
        const values = await sample([ao.outputTexture._colorTexture!, owner!.scratch], points, true);
        return { actual: values[0]!, spatial: values[1]! };
    };
    const oracle = async (points: readonly Point[], observedFrame: ContactFrame) => {
        const source = ao._gpu!;
        const render = async (phase: number) => {
            writeSsaoGpuParameters(reference!, {
                depthMultiply: source.data[4]!,
                depthAdd: source.data[5]!,
                tanX: source.data[6]!,
                tanY: source.data[7]!,
                far: camera.farPlane,
                radius: ao.radius,
                intensity: ao.intensity,
                quality: ao.quality,
                view: getViewMatrix(camera),
                phase,
            });
            const encoder = device.createCommandEncoder();
            executeSsaoGpu(reference!, encoder, ao.quality);
            if (sparse) executeHalfSsaoGpu(sparse, encoder);
            device.queue.submit([encoder.finish()]);
            return (await sample([reference!.outputTexture ?? reference!.visibility], points, false))[0]!;
        };
        const current = await render(source.integers[23]!);
        for (let i = 0; i < current.length; i++) {
            if (observedFrame.spatial[i] !== null && current[i] !== observedFrame.spatial[i]) throw new Error(`Contact spatial oracle differs at receiver ${i}.`);
        }
        const sum = new Float64Array(points.length);
        for (let phase = 0; phase < 64; phase++) {
            const values = await render(phase);
            for (let i = 0; i < points.length; i++) {
                if (observedFrame.actual[i] !== null) {
                    if (values[i] === null) throw new Error("Contact oracle lost current receiver coverage.");
                    sum[i] = sum[i]! + values[i]! / 64;
                }
            }
        }
        return observedFrame.actual.map((value, i) => (value === null ? null : sum[i]!));
    };
    const validation = {
        async run(config: ContactCase) {
            for (const [id, value] of Object.entries({ resolution: config.resolution, quality: "ultra" })) {
                const input = document.getElementById(id);
                if (!(input instanceof HTMLSelectElement)) throw new Error(`Missing contact select ${id}.`);
                input.value = value;
                input.dispatchEvent(new Event("change", { bubbles: true }));
            }
            for (const [id, checked] of Object.entries({ useNormalTexture: config.providedNormals, aoOnly: true, moving: false, deforming: false, motionPruning: false })) {
                const input = document.getElementById(id);
                if (!(input instanceof HTMLInputElement)) throw new Error(`Missing contact toggle ${id}.`);
                if (input.checked !== checked) input.click();
            }
            ao.radius = 0.35;
            temporal.historySamples = 16;
            resetSsaoTemporal(temporal);
            for (let i = 0; i < 64; i++) renderFrame(engine, 16);
            const stableOutput = ao.outputTexture._colorTexture;
            if (!owner) throw new Error("Contact history is missing.");
            const source = ao._gpu!,
                width = source.width,
                height = source.height;
            if (config.resolution === "half") {
                sparse = createHalfSsaoGpu(device, width, height, "depth", config.providedNormals, false, undefined, source.depth);
                reference = sparse.gpu;
                bindHalfSsaoGpu(sparse, source.sourceDepth!, source.sourceNormal);
            } else {
                reference = createSsaoGpu(device, width, height, "depth", config.providedNormals, false, 1, source.depth);
                bindSsaoGpuSources(reference, source.sourceDepth!, source.sourceNormal);
            }
            const endX = 1.3 + Math.sin(96 * 0.016) * 0.7;
            const fixed = [...grid(1.3), ...grid(endX)];
            let previousMean = await oracle(fixed, await observed(fixed));
            const checkpoints: { segment: string; frame: number; metrics: ReturnType<typeof summarizeContactTrail> }[] = [];
            const traces: Record<string, ContactFrame[]> = {};
            const metrics: Record<string, ReturnType<typeof summarizeContact>> = {};
            const violations: string[] = [];
            let newlyLit = 0;
            for (const [name, count] of [
                ["stationary", 64],
                ["moving", 96],
                ["paused", 32],
                ["reversal", 64],
                ["camera", 64],
            ] as const) {
                const frames: ContactFrame[] = [],
                    cameraGrid = grid(sphere.position.x);
                for (let i = 0; i < count; i++) {
                    if (name === "moving") sphere.position.x = 1.3 + Math.sin((i + 1) * 0.016) * 0.7;
                    if (name === "reversal") sphere.position.x = 1.3 + Math.sin((96 - i - 1) * 0.016) * 0.7;
                    if (name === "camera") {
                        camera.alpha = alpha + 0.12 * Math.sin((i + 1) * 0.016);
                        camera.beta = initialBeta + 0.02 * Math.sin((i + 1) * 0.011);
                    }
                    renderFrame(engine, 16);
                    if (ao.outputTexture._colorTexture !== stableOutput) throw new Error("Contact rendering replaced the output allocation.");
                    frames.push(await observed(name === "camera" ? cameraGrid : grid(sphere.position.x)));
                    if (
                        (name === "moving" && (i === 23 || i === 47 || i === 95)) ||
                        (name === "paused" && i === 15) ||
                        (name === "reversal" && (i === 15 || i === 63)) ||
                        (name === "camera" && i === 63)
                    ) {
                        const currentFrame = await observed(fixed),
                            mean = await oracle(fixed, currentFrame);
                        const trail = summarizeContactTrail(previousMean, mean, currentFrame);
                        newlyLit += trail.samples;
                        checkpoints.push({ segment: name, frame: i, metrics: trail });
                        if (trail.excessTrail > 0.015) violations.push(`${name}/${i}: excess trailing ${trail.excessTrail} > 0.015`);
                        if (name === "moving")
                            previousMean = mean.map((value, p) => {
                                const old = previousMean[p]!;
                                return value === null ? old : old === null ? value : Math.min(old, value);
                            });
                    }
                }
                traces[name] = frames;
                const summary = summarizeContact(frames);
                metrics[name] = summary;
                violations.push(...contactViolations(summary).map((error) => `${name}: ${error}`));
            }
            if (newlyLit < 64) throw new Error(`Insufficient localized trailing coverage: ${newlyLit}.`);
            return { config, width, height, radius: ao.radius, quality: ao.quality, metrics, checkpoints, newlyLit, violations, traces };
        },
        async dispose() {
            await device.queue.onSubmittedWorkDone();
            if (reference) disposeSsaoGpu(reference);
            temporal._prepareGpu = prepare;
            device.removeEventListener("uncapturederror", onError);
        },
    };
    Object.assign(globalThis, { ssaoContactValidation: validation });
    return validation;
}

export type ContactClient = ReturnType<typeof exposeContactValidation>;
