import { BU, SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import { targetSignatureKey } from "../engine/render-target-signature.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { enableDrawBatchCollection } from "../render/draw-update-batches.js";
import type { DrawBinding, DrawUpdateBatch, DrawUpdateContext, Renderable } from "../render/renderable.js";
import type { SceneContext } from "../scene/scene-core.js";
import { getCameraPosition, getEffectiveAspectRatio, getProjectionMatrix, getViewMatrix } from "../camera/camera.js";
import { getSplatStreamDrawBatch } from "../loader-splat-stream/splat-stream-gpu.js";
import {
    gpsAccumulatedSamples,
    gpsHiZLevels,
    gpsHistoryCap,
    gpsOptionsKey,
    gpsPointBudget,
    gpsRenderScale,
    gpsReprojectionSamples,
    gpsSoftReset,
    gpsUpdateGeneration,
    type GaussianPointSplatting,
    type GpsAccumulation,
} from "./gps-state.js";
import { GPS_COMPOSITE, GPS_HIZ, GPS_PARTITION, GPS_RESOLVE, GPS_SCAN_ADD, GPS_SCAN_BLOCKS, GPS_SCAN_SUMS, GPS_SPLAT, gpsPreprocessShader } from "./gps-shaders.js";
import type * as GpsReproject from "./gps-reproject.js";

interface Pipelines {
    preprocess: GPUComputePipeline;
    blocks: GPUComputePipeline;
    sums: GPUComputePipeline;
    add: GPUComputePipeline;
    partition: GPUComputePipeline;
    splat: GPUComputePipeline;
    resolve: GPUComputePipeline;
    hiz: GPUComputePipeline;
}

interface PixelBuffers extends GpsReproject.GpsReprojectionTarget {
    key: string;
    image: GPUBuffer;
    hiz: GPUBuffer;
    levels: ReturnType<typeof gpsHiZLevels>;
    levelParams: GPUBuffer[];
}

interface SplatBuffers {
    count: number;
    weights: GPUBuffer;
    screen: GPUBuffer;
    cdf: GPUBuffer;
    sums: GPUBuffer;
    buffers: GPUBuffer[];
}

interface Readback {
    buffer: GPUBuffer;
    busy: boolean;
}

interface ViewState extends GpsAccumulation {
    device: GPUDevice;
    batch: DrawUpdateBatch | null;
    params: GPUBuffer;
    cpu: Float32Array;
    pixels: PixelBuffers | null;
    splats: SplatBuffers | null;
    total: GPUBuffer;
    indirect: GPUBuffer;
    buckets: GPUBuffer;
    readbacks: Readback[];
    points: number;
    pointsScale: number;
    boundsGeneration: number;
    content: number;
    boundsMin: number[];
    boundsMax: number[];
    seed: number;
    disposed: boolean;
    drawable: boolean;
    composite: { pipeline: GPURenderPipeline; group: GPUBindGroup } | null;
    groups: Map<GPUComputePipeline, Map<GPUBuffer, GPUBindGroup>>;
    buffers: GPUBuffer[];
    context: DrawUpdateContext | null;
    /** World/view/projection matrices whose view the accumulation currently holds. */
    viewKey: string;
    matrices: Float32Array;
    /** Reprojection uniforms written by prepare() for record() when the view moved. */
    reproject: Float32Array | null;
    fillFrames: number;
}

let cache: { device: GPUDevice; compute: Map<string, Pipelines>; composite: Map<string, GPURenderPipeline> } | null = null;

function deviceCache(device: GPUDevice): NonNullable<typeof cache> {
    if (cache?.device !== device) {
        cache = { device, compute: new Map(), composite: new Map() };
    }
    return cache;
}

type ReprojectionModule = typeof GpsReproject;
let reprojection: ReprojectionModule | Promise<unknown> | null = null;

/** Returns the reprojection module once loaded; until then view changes keep restarting the accumulation. */
function reprojectionModule(): ReprojectionModule | null {
    reprojection ??= import("./gps-reproject.js").then((module) => (reprojection = module));
    return reprojection instanceof Promise ? null : reprojection;
}

function pipelines(device: GPUDevice, stream: boolean, degree: number): Pipelines {
    const shared = deviceCache(device);
    const key = `${+stream}/${degree}`;
    let result = shared.compute.get(key);
    if (result) {
        return result;
    }
    const compute = (code: string, label: string, layout: GPUPipelineLayout | "auto" = "auto"): GPUComputePipeline =>
        device.createComputePipeline({ label: `GPS ${label}`, layout, compute: { module: device.createShaderModule({ label: `GPS ${label}`, code }), entryPoint: "main" } });
    const entries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: SS.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: SS.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: SS.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: SS.COMPUTE, buffer: { type: "read-only-storage" } },
    ];
    if (stream) {
        entries.push({ binding: 4, visibility: SS.COMPUTE, buffer: { type: "read-only-storage" } });
    } else {
        for (let i = 4; i < 8 + Math.ceil((((degree + 1) ** 2 - 1) * 3) / 16); i++) {
            entries.push({ binding: i, visibility: SS.COMPUTE, texture: { sampleType: i < 8 ? "unfilterable-float" : "uint" } });
        }
    }
    const layout = device.createPipelineLayout({ bindGroupLayouts: [device.createBindGroupLayout({ entries })] });
    result = {
        preprocess: compute(gpsPreprocessShader(stream, degree), "preprocess", layout),
        blocks: compute(GPS_SCAN_BLOCKS, "scan blocks"),
        sums: compute(GPS_SCAN_SUMS, "scan sums"),
        add: compute(GPS_SCAN_ADD, "scan add"),
        partition: compute(GPS_PARTITION, "partition"),
        splat: compute(GPS_SPLAT, "splat"),
        resolve: compute(GPS_RESOLVE, "resolve"),
        hiz: compute(GPS_HIZ, "Hi-Z"),
    };
    shared.compute.set(key, result);
    return result;
}

function compositePipeline(engine: EngineContext, target: RenderTargetSignature, depthMode: boolean, colorMode: boolean): GPURenderPipeline {
    const shared = deviceCache(engine._device);
    const key = `${targetSignatureKey(target)}/${+depthMode}/${+colorMode}`;
    let result = shared.composite.get(key);
    if (!result) {
        const device = engine._device;
        const layout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: SS.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: SS.FRAGMENT, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: SS.FRAGMENT, buffer: { type: "read-only-storage" } },
            ],
        });
        const module = device.createShaderModule({ label: "GPS composite", code: GPS_COMPOSITE });
        result = device.createRenderPipeline({
            label: "GPS composite",
            layout: device.createPipelineLayout({ bindGroupLayouts: [getSceneBindGroupLayout(engine), layout] }),
            vertex: { module, entryPoint: "vs" },
            fragment: {
                module,
                entryPoint: "fs",
                targets: target._colorFormat
                    ? [
                          {
                              format: target._colorFormat,
                              writeMask: colorMode ? 15 : 0,
                              blend: {
                                  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                                  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                              },
                          },
                      ]
                    : [],
            },
            primitive: { topology: "triangle-list", cullMode: "none" },
            depthStencil: target._depthStencilFormat
                ? { format: target._depthStencilFormat, depthWriteEnabled: depthMode, depthCompare: target._depthCompare ?? "greater-equal" }
                : undefined,
            multisample: { count: target._sampleCount },
        });
        shared.composite.set(key, result);
    }
    return result;
}

function buffer(device: GPUDevice, size: number, label: string, usage = BU.STORAGE | BU.COPY_DST): GPUBuffer {
    if (size > device.limits.maxBufferSize || ((usage & BU.STORAGE) !== 0 && size > device.limits.maxStorageBufferBindingSize)) {
        throw new RangeError(`Gaussian point splatting ${label} exceeds the device buffer limit`);
    }
    return device.createBuffer({ label: `GPS ${label}`, size: Math.max(4, size), usage });
}

function pixelBuffers(device: GPUDevice, width: number, height: number, n: number): PixelBuffers {
    const w = Math.ceil(width / n);
    const h = Math.ceil(height / n);
    const levels = gpsHiZLevels(w, h);
    const buffers: GPUBuffer[] = [];
    const make = (size: number, label: string, usage?: GPUBufferUsageFlags): GPUBuffer => {
        const value = buffer(device, size, label, usage);
        buffers.push(value);
        return value;
    };
    try {
        const image = make(w * h * 4, "image");
        // COPY_SRC lets temporal reprojection snapshot the previous accumulation.
        const accum = make(width * height * 16, "accumulation", BU.STORAGE | BU.COPY_DST | BU.COPY_SRC);
        const depth = make(width * height * 4, "depth", BU.STORAGE | BU.COPY_DST | BU.COPY_SRC);
        const counts = make(width * height * 4, "counts", BU.STORAGE | BU.COPY_DST | BU.COPY_SRC);
        const last = levels[levels.length - 1]!;
        const hiz = make((last.offset + 1) * 4, "Hi-Z");
        device.queue.writeBuffer(image, 0, new Uint32Array(w * h).fill(0xffffffff));
        const levelParams = levels.slice(1).map((level, i) => {
            const source = levels[i]!;
            const params = buffer(device, 32, "Hi-Z parameters", BU.UNIFORM | BU.COPY_DST);
            buffers.push(params);
            device.queue.writeBuffer(params, 0, new Uint32Array([source.offset, source.width, source.height, 0, level.offset, level.width, level.height, 0]));
            return params;
        });
        return { key: `${width}/${height}/${n}`, image, accum, depth, counts, hiz, levels, levelParams, buffers };
    } catch (error) {
        buffers.forEach((value) => value.destroy());
        throw error;
    }
}

function splatBuffers(device: GPUDevice, count: number): SplatBuffers {
    const buffers: GPUBuffer[] = [];
    const make = (size: number, label: string): GPUBuffer => {
        const value = buffer(device, size, label);
        buffers.push(value);
        return value;
    };
    try {
        return {
            count,
            weights: make(count * 4, "weights"),
            screen: make(count * 64, "screen"),
            cdf: make(count * 4, "CDF"),
            sums: make(Math.ceil(count / 256) * 4, "block sums"),
            buffers,
        };
    } catch (error) {
        buffers.forEach((value) => value.destroy());
        throw error;
    }
}

function bindGroup(device: GPUDevice, pipeline: GPUComputePipeline | GPURenderPipeline, resources: readonly (GPUBuffer | GPUTextureView)[], group = 0): GPUBindGroup {
    return device.createBindGroup({
        layout: pipeline.getBindGroupLayout(group),
        entries: resources.map((value, binding) => ({ binding, resource: "mapAsync" in value ? { buffer: value } : value })),
    });
}

function retireBuffers(engine: EngineContext, buffers: readonly GPUBuffer[]): void {
    retireGpuResources(engine, () => buffers.forEach((value) => value.destroy()));
}

function readback(engine: EngineContext, state: ViewState, n: number): void {
    if (state.seed % 16 !== 0) {
        return;
    }
    const slot = state.readbacks.find((value) => !value.busy);
    if (!slot) {
        return;
    }
    slot.busy = true;
    engine._currentEncoder.copyBufferToBuffer(state.total, 0, slot.buffer, 0, 4);
    // The retirement seam fences after submission, not merely after encoding the copy.
    retireGpuResources(engine, () => {
        if (state.disposed) {
            slot.buffer.destroy();
            return;
        }
        void slot.buffer
            .mapAsync(GPUMapMode.READ)
            .then(() => {
                if (!state.disposed) {
                    state.points = new Uint32Array(slot.buffer.getMappedRange())[0]!;
                    state.pointsScale = n;
                }
                slot.buffer.unmap();
            })
            .catch(() => undefined)
            .finally(() => {
                slot.busy = false;
                if (state.disposed) {
                    slot.buffer.destroy();
                }
            });
    });
}

function createView(device: GPUDevice): ViewState {
    const allocated: GPUBuffer[] = [];
    const make = (size: number, label: string, usage: GPUBufferUsageFlags): GPUBuffer => {
        const result = buffer(device, size, label, usage);
        allocated.push(result);
        return result;
    };
    try {
        const params = make(304, "parameters", BU.UNIFORM | BU.COPY_DST);
        const total = make(4, "point count", BU.STORAGE | BU.COPY_SRC);
        const indirect = make(12, "dispatch", BU.STORAGE | BU.INDIRECT);
        const buckets = make(65537 * 4, "partitions", BU.STORAGE);
        const readbacks = Array.from({ length: 3 }, () => ({ buffer: make(4, "readback", BU.COPY_DST | BU.MAP_READ), busy: false }));
        return {
            device,
            batch: null,
            params,
            total,
            indirect,
            buckets,
            readbacks,
            buffers: [params, total, indirect, buckets],
            cpu: new Float32Array(76),
            pixels: null,
            splats: null,
            points: 0,
            pointsScale: 1,
            boundsGeneration: -1,
            content: -1,
            boundsMin: [],
            boundsMax: [],
            seed: 0,
            generation: 0,
            frames: 0,
            key: "",
            disposed: false,
            drawable: false,
            composite: null,
            groups: new Map(),
            context: null,
            viewKey: "",
            matrices: new Float32Array(48),
            reproject: null,
            fillFrames: 0,
        };
    } catch (error) {
        allocated.forEach((value) => value.destroy());
        throw error;
    }
}

function prepare(gps: GaussianPointSplatting, state: ViewState, engine: EngineContext): boolean {
    const context = state.context;
    const camera = context?._camera;
    const target = gps._target;
    const stream = "_gpu" in target;
    if (!context || !camera || gps._disabled || (!gps.colorRenderMode && !gps.depthRenderMode) || (stream && (camera.ortho || target._disposed))) {
        state.drawable = false;
        state.key = "";
        return false;
    }
    const optionKey = gpsOptionsKey(gps);
    const width = Math.floor(context.targetWidth * (camera.viewport?.width ?? 1));
    const height = Math.floor(context.targetHeight * (camera.viewport?.height ?? 1));
    if (width <= 0 || height <= 0) {
        state.drawable = false;
        state.key = "";
        return false;
    }
    const count = stream ? target._gpu.count : target.vertexCount;
    if (stream && target._gpu.gatheredGeneration !== target._gpu.contentGeneration) {
        // The stream deferred its canonical gather; keep compositing the last accumulation rather than reading a half-updated buffer.
        return false;
    }
    const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
    const budget = gpsPointBudget(ua, typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints);
    const n = gps.renderScale === "auto" ? gpsRenderScale(state.points * state.pointsScale ** 2, budget, state.pixels ? state.cpu[58]! : 0) : gps.renderScale;
    const pixelKey = `${width}/${height}/${n}`;
    if (state.pixels?.key !== pixelKey) {
        const pixels = pixelBuffers(engine._device, width, height, n);
        if (state.pixels) {
            retireBuffers(engine, state.pixels.buffers);
        }
        state.pixels = pixels;
        state.composite = null;
        state.groups.clear();
    }
    if (state.splats?.count !== count) {
        const splats = splatBuffers(engine._device, count);
        if (state.splats) {
            retireBuffers(engine, state.splats.buffers);
        }
        state.splats = splats;
        state.groups.clear();
    }
    const view = getViewMatrix(camera);
    const projection = getProjectionMatrix(camera, getEffectiveAspectRatio(camera, context.targetWidth, context.targetHeight));
    const world = target.worldMatrix;
    const viewKey = `${Array.from(world)}/${Array.from(view)}/${Array.from(projection)}`;
    // With reprojection, view changes keep the generation and remap the accumulation instead of restarting it.
    const reprojector = gps.temporalReprojection ? reprojectionModule() : null;
    const key = `${pixelKey}/${optionKey}/${gps._dataVersion}${reprojector ? "" : `/${viewKey}`}`;
    let reset = gpsUpdateGeneration(state, key);
    const cycle = n * n;
    state.reproject = null;
    if (reprojector && !reset && state.viewKey !== viewKey) {
        const matrix = reprojector.gpsReprojectionMatrix(state.matrices, world, view, projection);
        if (matrix) {
            const samples = gpsReprojectionSamples(gps.maxAccumFrames);
            const reproject = (state.reproject = new Float32Array(36));
            state.fillFrames = cycle;
            reproject.set(matrix);
            reproject.set([width, height, state.generation, Math.max(1, samples)], 32);
            gpsSoftReset(state, cycle, samples);
        } else {
            state.key = "";
            reset = gpsUpdateGeneration(state, key);
        }
    }
    if (reset) {
        state.fillFrames = 0;
    }
    state.viewKey = viewKey;
    state.matrices.set(world, 0);
    state.matrices.set(view, 16);
    state.matrices.set(projection, 32);
    const content = stream ? target._gpu.contentGeneration : 0;
    if (!reset && state.content !== content) {
        gpsSoftReset(state, cycle);
    }
    state.content = content;
    state.drawable = true;
    if (!reset && gpsAccumulatedSamples(state.frames, cycle, gps.maxAccumFrames) >= gps.maxAccumFrames) {
        // Converged: the composite keeps presenting the accumulation and the params written by the last dispatch.
        publishProgress(gps, state, cycle);
        return false;
    }
    if (stream && state.boundsGeneration !== target._gpu.contentGeneration) {
        state.boundsGeneration = target._gpu.contentGeneration;
        state.boundsMin = Array.from(target.boundMin);
        state.boundsMax = Array.from(target.boundMax);
        // Environment sources can extend beyond the foreground tree's bounds. SOG stores signed-log means and canonical Z is negated.
        const decode = (value: number): number => Math.sign(value) * Math.expm1(Math.abs(value));
        for (const { source } of target._gpu.intervals) {
            for (let axis = 0; axis < 3; axis++) {
                const low = axis === 2 ? -decode(source.meansMax[axis]!) : decode(source.meansMin[axis]!);
                const high = axis === 2 ? -decode(source.meansMin[axis]!) : decode(source.meansMax[axis]!);
                state.boundsMin[axis] = Math.min(state.boundsMin[axis]!, low);
                state.boundsMax[axis] = Math.max(state.boundsMax[axis]!, high);
            }
        }
    }
    const localMin = stream ? state.boundsMin : target.boundMin;
    const localMax = stream ? state.boundsMax : target.boundMax;
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let corner = 0; corner < 8; corner++) {
        const x = (corner & 1) === 0 ? localMin[0]! : localMax[0]!;
        const y = (corner & 2) === 0 ? localMin[1]! : localMax[1]!;
        const z = (corner & 4) === 0 ? localMin[2]! : localMax[2]!;
        const wx = world[0]! * x + world[4]! * y + world[8]! * z + world[12]!;
        const wy = world[1]! * x + world[5]! * y + world[9]! * z + world[13]!;
        const wz = world[2]! * x + world[6]! * y + world[10]! * z + world[14]!;
        const vz = view[2]! * wx + view[6]! * wy + view[10]! * wz + view[14]!;
        zMin = Math.min(zMin, vz);
        zMax = Math.max(zMax, vz);
    }
    zMin = Math.max(camera.nearPlane, zMin);
    zMax = Math.max(zMin + 1e-6, zMax);
    const eye = getCameraPosition(camera);
    const jitter = state.frames % (n * n);
    const depthVisualization = gps.depthVisualization === "linear" ? 1 : gps.depthVisualization === "alphaBlended" ? 2 : 0;
    const cpu = state.cpu;
    cpu.set(world, 0);
    cpu.set(view, 16);
    cpu.set(projection, 32);
    cpu.set([eye.x, eye.y, eye.z, !stream && target.shDegree > 0 ? 8 : 1], 48);
    cpu.set([Math.ceil(width / n), Math.ceil(height / n), camera.nearPlane, camera.farPlane], 52);
    cpu.set([width, height, n, stream ? 0 : target.textureWidth], 56);
    cpu.set([count, gps.pointScale, state.seed % 65536, (Math.imul(state.seed + 1, 0x9e3779b1) >>> 16) & 65535], 60);
    cpu.set(
        [state.generation, gpsHistoryCap(state.frames, cycle, gps.maxAccumFrames), reset ? 1 : state.fillFrames > 0 ? 2 : 0, +(gps.occlusionCulling && !reset && !state.reproject)],
        64
    );
    cpu.set([zMin, zMax, state.pixels.levels.length, depthVisualization], 68);
    cpu.set([jitter % n, Math.floor(jitter / n), +gps.colorRenderMode, +gps.depthRenderMode], 72);
    engine._device.queue.writeBuffer(state.params, 0, cpu);
    state.drawable = true;
    return true;
}

function record(gps: GaussianPointSplatting, state: ViewState, engine: EngineContext, pipeline: Pipelines): void {
    if (!prepare(gps, state, engine)) {
        return;
    }
    const device = engine._device;
    const encoder = engine._currentEncoder;
    const pixel = state.pixels!;
    const splats = state.splats!;
    const target = gps._target;
    const stream = "_gpu" in target;
    const params = state.params;
    const dispatch = (compute: GPUComputePipeline, resources: readonly (GPUBuffer | GPUTextureView)[], x: number, y = 1, indirect = false): void => {
        let groups = state.groups.get(compute);
        if (!groups) {
            state.groups.set(compute, (groups = new Map()));
        }
        const parameterBuffer = resources[0] as GPUBuffer;
        let group = groups.get(parameterBuffer);
        if (!group) {
            groups.set(parameterBuffer, (group = bindGroup(device, compute, resources)));
        }
        const pass = encoder.beginComputePass({ label: compute.label });
        pass.setPipeline(compute);
        pass.setBindGroup(0, group);
        if (indirect) {
            pass.dispatchWorkgroupsIndirect(state.indirect, 0);
        } else {
            pass.dispatchWorkgroups(x, y);
        }
        pass.end();
    };
    if (state.reproject) {
        (reprojection as ReprojectionModule).gpsRecordReprojection(device, encoder, pixel, state.reproject, (size, label, usage) => buffer(device, size, label, usage), dispatch);
        state.reproject = null;
    }
    const groups = Math.ceil(splats.count / 256);
    if (splats.count > 0) {
        const sources = stream
            ? [target._gpu.canonical]
            : [target._gs._centersView, target._gs._covAView, target._gs._covBView, target._gs._colorsView, ...(target._gs._shViews ?? [])];
        dispatch(pipeline.preprocess, [params, splats.weights, splats.screen, pixel.hiz, ...sources], Math.min(groups, 65535), Math.ceil(groups / 65535));
        dispatch(pipeline.blocks, [params, splats.weights, splats.cdf, splats.sums], Math.min(groups, 65535), Math.ceil(groups / 65535));
    }
    dispatch(pipeline.sums, [params, splats.sums, state.total, state.indirect], 1);
    if (splats.count > 0) {
        dispatch(pipeline.add, [params, splats.cdf, splats.sums], Math.min(groups, 65535), Math.ceil(groups / 65535));
        dispatch(pipeline.partition, [params, splats.cdf, state.total, state.buckets], 257);
        dispatch(pipeline.splat, [params, splats.cdf, state.total, state.buckets, splats.screen, pixel.image], 0, 1, true);
    }
    const level0 = pixel.levels[0]!;
    dispatch(pipeline.resolve, [params, pixel.image, pixel.accum, pixel.depth, pixel.counts, pixel.hiz], Math.ceil(level0.width / 8), Math.ceil(level0.height / 8));
    if (gps.occlusionCulling) {
        for (let i = 1; i < pixel.levels.length; i++) {
            const level = pixel.levels[i]!;
            dispatch(pipeline.hiz, [pixel.levelParams[i - 1]!, pixel.hiz], Math.ceil(level.width / 8), Math.ceil(level.height / 8));
        }
    }
    readback(engine, state, state.cpu[58]!);
    state.frames++;
    if (state.fillFrames > 0) {
        state.fillFrames--;
    }
    state.seed++;
    publishProgress(gps, state, state.cpu[58]! ** 2);
}

function publishProgress(gps: GaussianPointSplatting, state: ViewState, cycle: number): void {
    gps._progress = {
        renderedFrameCount: state.frames,
        accumulatedSamples: gpsAccumulatedSamples(state.frames, cycle, gps.maxAccumFrames),
        accumulationVersion: state.generation,
        pixelCycleLength: cycle,
    };
}

/** @internal Compute and fullscreen material owned entirely by the opt-in enabler. */
export function createGpsRenderable(scene: SceneContext, gps: GaussianPointSplatting): { renderable: Renderable; dispose: () => void } {
    const views = new Set<ViewState>();
    const bySignature = new WeakMap<RenderTargetSignature, ViewState>();
    const engine = scene.surface.engine;
    const destroy = (state: ViewState): void => {
        if (state.disposed) {
            return;
        }
        state.disposed = true;
        state.drawable = false;
        state.groups.clear();
        state.composite = null;
        views.delete(state);
        retireBuffers(engine, [
            ...state.buffers,
            ...(state.pixels?.buffers ?? []),
            ...(state.splats?.buffers ?? []),
            ...state.readbacks.filter((slot) => !slot.busy).map((slot) => slot.buffer),
        ]);
    };
    const renderable: Renderable = {
        order: 200,
        isTransparent: true,
        bind(boundEngine, signature): DrawBinding {
            enableDrawBatchCollection(signature);
            const target = gps._target;
            const stream = "_gpu" in target;
            const compute = pipelines(boundEngine._device, stream, stream ? 0 : target.shDegree);
            const initialPipeline = compositePipeline(
                boundEngine,
                signature,
                gps.depthRenderMode,
                gps.colorRenderMode || (gps.depthRenderMode && gps.depthVisualization !== "none")
            );
            const cached = bySignature.get(signature);
            const state = cached && !cached.disposed && !cached.batch?._retired && cached.device === boundEngine._device ? cached : createView(boundEngine._device);
            views.add(state);
            bySignature.set(signature, state);
            const batch: DrawUpdateBatch = (state.batch ??= {
                _retired: false,
                reset() {
                    state.context = null;
                },
                flush(currentEngine) {
                    if (!state.disposed && !this._retired) {
                        record(gps, state, currentEngine, compute);
                    }
                },
                destroy() {
                    destroy(state);
                },
            });
            return {
                renderable,
                pipeline: initialPipeline,
                _updateBatches: stream ? [getSplatStreamDrawBatch(target._gpu, signature), batch] : [batch],
                update(context) {
                    state.context = context;
                },
                draw(pass) {
                    if (!state.drawable || gps._disabled || (!gps.colorRenderMode && !gps.depthRenderMode)) {
                        return 0;
                    }
                    const showDepth = gps.depthRenderMode && gps.depthVisualization !== "none";
                    const pipeline = compositePipeline(boundEngine, signature, gps.depthRenderMode, gps.colorRenderMode || showDepth);
                    pass.setPipeline(pipeline);
                    const pixels = state.pixels!;
                    if (state.composite?.pipeline !== pipeline) {
                        state.composite = { pipeline, group: bindGroup(boundEngine._device, pipeline, [state.params, pixels.accum, pixels.depth], 1) };
                    }
                    pass.setBindGroup(1, state.composite.group);
                    pass.draw(3);
                    return 1;
                },
            };
        },
    };
    return { renderable, dispose: () => [...views].forEach(destroy) };
}
