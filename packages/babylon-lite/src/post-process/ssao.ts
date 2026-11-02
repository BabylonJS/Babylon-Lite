import type { Camera } from "../camera/camera.js";
import { getEffectiveAspectRatio, getProjectionMatrix, getViewMatrix } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTarget } from "../engine/render-target.js";
import { createRenderTarget } from "../engine/render-target.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Task } from "../frame-graph/task.js";
import { bindSsaoGpuSources, clearSsaoGpu, createSsaoGpu, disposeSsaoGpu, executeSsaoGpu, validateSsaoQuality, writeSsaoGpuParameters } from "./ssao-gpu.js";
import type { SsaoGpu, SsaoGpuParameters, SsaoQuality } from "./ssao-gpu.js";

export type { SsaoQuality } from "./ssao-gpu.js";

/** @internal An optional AO-buffer consumer owns all filtering semantics. */
export interface SsaoFilter {
    prepare(gpu: SsaoGpu, params: SsaoGpuParameters): void;
    execute(gpu: SsaoGpu, encoder: GPUCommandEncoder): void;
    reset(): void;
    dispose(): void;
}
/** @internal Optional working-resolution adapter; owns no scene. */
export interface SsaoResolution {
    prepare(gpu: SsaoGpu | null, device: GPUDevice, width: number, height: number, depth: GPUTextureView, normal: GPUTextureView | null, worldNormals: boolean): SsaoGpu;
    before(gpu: SsaoGpu, encoder: GPUCommandEncoder, params: SsaoGpuParameters): boolean;
    after?(gpu: SsaoGpu, encoder: GPUCommandEncoder): void;
    dispose(): void;
}
/** Configuration for an AO-only, full-resolution frame-graph task. */
export interface SsaoTaskConfig {
    name?: string;
    /** Single-sample depth attachment produced before this task. */
    depthTexture: RenderTarget;
    /** Optional signed unit normals, matching the depth target's pixel dimensions. */
    normalTexture?: RenderTarget;
    /** Coordinate space of supplied normals. Default "view". */
    normalSpace?: "view" | "world";
    camera: Camera;
    /** Spatial sampling preset. Default "high" (18 samples per evaluated pixel). */
    quality?: SsaoQuality;
    radius?: number;
    /** Normalized strength, 0..1. */
    intensity?: number;
}

/** Plain state and the standard frame-graph lifecycle; output is AO visibility, not scene color. */
export interface SsaoTask extends Task {
    readonly depthTexture: RenderTarget;
    /** Signed normal input, or null to reconstruct from depth. Changes reset temporal history. */
    normalTexture: RenderTarget | null;
    readonly camera: Camera;
    readonly outputTexture: RenderTarget;
    enabled: boolean;
    /** Spatial sampling preset, independent of temporal history and working resolution. */
    quality: SsaoQuality;
    radius: number;
    /** Normalized strength, 0..1. */
    intensity: number;
    /** @internal */
    _gpu: SsaoGpu | null;
    /** @internal Resource observers are installed only by sampled-output consumers. */
    _onOutputChanged?: (gpu: SsaoGpu, target: RenderTarget) => void;
    /** @internal Restores sampled-output consumers to a neutral fallback. */
    _onDispose?: () => void;
    /** @internal Installed only by an explicit filtering enabler. */
    _filter?: SsaoFilter;
    /** @internal Installed only by an explicit working-resolution enabler. */
    _resolution?: SsaoResolution;
}

/** @internal Validate changed public settings outside GPU sampling loops. */
export function validateSsaoSettings(radius: number, intensity: number, quality: SsaoQuality = "high"): void {
    if (!Number.isFinite(radius) || radius <= 0) {
        throw new Error("SSAO radius must be positive and finite.");
    }
    if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
        throw new Error("SSAO intensity must be finite and in [0, 1].");
    }
    validateSsaoQuality(quality);
}

function validateNormalInput(normal: RenderTarget | null): void {
    if (normal && (!normal._descriptor.format || normal._descriptor.samples !== 1)) {
        throw new Error("SSAO normal input must be a single-sample color attachment.");
    }
}

/**
 * Create a native WebGPU ambient-occlusion task.
 * Add after the depth/normal producer and before an AO-buffer consumer.
 * This does not multiply the final scene color or implicitly enable material shading.
 */
export function createSsaoTask(config: SsaoTaskConfig, engine: EngineContext, scene?: SceneContext): SsaoTask {
    const depth = config.depthTexture;
    const normal = config.normalTexture ?? null;
    if (!depth._descriptor.dFormat || depth._descriptor.samples !== 1) {
        throw new Error("SSAO requires a single-sample depth attachment; resolve MSAA depth first.");
    }
    validateNormalInput(normal);
    if (config.normalSpace !== undefined && config.normalSpace !== "view" && config.normalSpace !== "world") {
        throw new Error("SSAO normalSpace must be 'view' or 'world'.");
    }
    const name = config.name ?? "ssao";
    const output = createRenderTarget({ lbl: `${name}-visibility`, format: "rgba16float", samples: 1, size: depth._descriptor.size });
    let depthIdentity: GPUTexture | null = null;
    let validatedNormal = normal;
    let sourceView: GPUTextureView | null = null;
    let wasEnabled = false;
    let neutral = false;
    let disposed = false;
    const params: SsaoGpuParameters = { depthMultiply: 0, depthAdd: 0, tanX: 0, tanY: 0, far: 0, radius: 0, intensity: 0 };

    function publish(gpu: SsaoGpu): void {
        const texture = gpu.outputTexture ?? gpu.visibility;
        output._colorTexture = texture;
        output._colorView = texture.createView();
        output._width = gpu.outputTexture?.width ?? gpu.width;
        output._height = gpu.outputTexture?.height ?? gpu.height;
        output._eager = true;
        neutral = false;
        task._onOutputChanged?.(gpu, output);
    }

    function prepare(): SsaoGpu {
        if (disposed) {
            throw new Error("SSAO task has been disposed.");
        }
        if (!depth._depthTexture || depth._width < 1 || depth._height < 1) {
            throw new Error("SSAO depth source is not built; record its producer before the AO task.");
        }
        const normal = task.normalTexture;
        if (normal !== validatedNormal) {
            validateNormalInput(normal);
            validatedNormal = normal;
        }
        if (normal && (!normal._colorView || normal._width !== depth._width || normal._height !== depth._height)) {
            throw new Error("SSAO normal/depth attachments must be built with identical dimensions.");
        }
        if (depthIdentity !== depth._depthTexture) {
            sourceView = depth._depthTexture.createView({ aspect: "depth-only" });
            depthIdentity = depth._depthTexture;
        }
        if (task._resolution) {
            const gpu = task._resolution.prepare(task._gpu, engine._device, depth._width, depth._height, sourceView!, normal?._colorView ?? null, config.normalSpace === "world");
            if (gpu !== task._gpu) {
                if (task._gpu) {
                    disposeSsaoGpu(task._gpu);
                }
                task._gpu = gpu;
                publish(gpu);
            }
            return gpu;
        }
        if (!task._gpu || task._gpu.device !== engine._device || task._gpu.width !== depth._width || task._gpu.height !== depth._height) {
            if (task._gpu) {
                disposeSsaoGpu(task._gpu);
            }
            task._gpu = createSsaoGpu(engine._device, depth._width, depth._height, "depth", normal !== null, config.normalSpace === "world");
            publish(task._gpu);
        }
        bindSsaoGpuSources(task._gpu, sourceView!, normal?._colorView ?? null);
        return task._gpu;
    }

    const task: SsaoTask = {
        name,
        engine,
        scene,
        _passes: [],
        depthTexture: depth,
        normalTexture: normal,
        camera: config.camera,
        outputTexture: output,
        enabled: true,
        quality: config.quality ?? "high",
        radius: config.radius ?? 0.5,
        intensity: config.intensity ?? 1,
        _gpu: null,
        record(): void {
            validateSsaoSettings(task.radius, task.intensity, task.quality);
            prepare();
        },
        execute(): number {
            const gpu = prepare();
            if (!task.enabled) {
                if (wasEnabled || !neutral) {
                    task._filter?.reset();
                    clearSsaoGpu(gpu, engine._currentEncoder);
                }
                neutral = true;
                wasEnabled = false;
                return 0;
            }
            validateSsaoSettings(task.radius, task.intensity, task.quality);
            const camera = task.camera;
            const viewport = camera.viewport;
            if (camera.ortho || (viewport && (viewport.x !== 0 || viewport.y !== 0 || viewport.width !== 1 || viewport.height !== 1))) {
                throw new Error("SSAO currently supports perspective cameras with a full-target viewport.");
            }
            if (!Number.isFinite(camera.nearPlane) || !Number.isFinite(camera.farPlane) || camera.nearPlane <= 0 || camera.farPlane <= camera.nearPlane) {
                throw new Error("SSAO camera clip planes must be finite, positive, and ordered.");
            }
            if (!Number.isFinite(camera.fov) || camera.fov <= 0 || camera.fov >= Math.PI) {
                throw new Error("SSAO camera FOV must be finite and in (0, pi).");
            }
            const projection = getProjectionMatrix(camera, getEffectiveAspectRatio(camera, depth._width, depth._height));
            params.depthMultiply = -projection[14]!;
            params.depthAdd = projection[10]!;
            params.tanX = 1 / projection[0]!;
            params.tanY = 1 / projection[5]!;
            params.far = camera.farPlane;
            params.radius = task.radius;
            params.intensity = task.intensity;
            params.view = getViewMatrix(camera);
            params.quality = task.quality;
            task._filter?.prepare(gpu, params);
            writeSsaoGpuParameters(gpu, params);
            if (!task._resolution?.before(gpu, engine._currentEncoder, params)) {
                executeSsaoGpu(gpu, engine._currentEncoder, task.quality);
            }
            task._filter?.execute(gpu, engine._currentEncoder);
            task._resolution?.after?.(gpu, engine._currentEncoder);
            wasEnabled = true;
            neutral = false;
            return 0;
        },
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            task._onDispose?.();
            task._filter?.dispose();
            task._resolution?.dispose();
            if (task._gpu) {
                disposeSsaoGpu(task._gpu);
            }
            task._gpu = null;
            output._colorTexture = output._colorView = null;
            output._width = output._height = 0;
            output._disposed = true;
        },
    };
    validateSsaoSettings(task.radius, task.intensity, task.quality);
    return task;
}
