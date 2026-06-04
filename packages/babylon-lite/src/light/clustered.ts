import { getProjectionMatrix, getViewMatrix, type Camera } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene.js";
import { createUniformBuffer } from "../resource/gpu-buffers.js";
import type { PbrExt } from "../material/pbr/pbr-flags.js";
import { _registerPbrExt } from "../material/pbr/pbr-flags.js";
import { CLUSTERED_LIGHT_BLOCK, CLUSTERED_LIGHT_STRUCTS } from "../material/pbr/fragments/clustered-light-wgsl.js";

const PBR2_HAS_CLUSTERED_LIGHTS = 1 << 17;
const MAX_DATA_TEXTURE_WIDTH = 8192;
const CLUSTER_BATCH_SIZE = 32;
const EMPTY_SLICE_FIRST = 0xffffffff;

export interface ClusteredPointLight {
    position: [number, number, number];
    diffuse: [number, number, number];
    range: number;
    intensity: number;
}

export interface ClusteredLightContainer {
    readonly kind: "clusteredLightContainer";
    pointLights: ClusteredPointLight[];
    horizontalTiles: number;
    verticalTiles: number;
    zSlices: number;
    /** @internal */
    _version: number;
}

export interface ClusteredPointLightOptions {
    position: [number, number, number];
    diffuse: [number, number, number];
    range?: number;
    intensity?: number;
}

export interface ClusteredLightContainerOptions {
    horizontalTiles?: number;
    verticalTiles?: number;
    zSlices?: number;
}

export interface ClusteredLightGpuState {
    paramsBuffer: GPUBuffer;
    lightsView: GPUTextureView;
    cellsView: GPUTextureView;
    indicesView: GPUTextureView;
    refresh(camera: Camera | null | undefined, targetWidth: number, targetHeight: number): void;
    dispose(): void;
}

export function createClusteredLightContainer(options?: ClusteredLightContainerOptions): ClusteredLightContainer {
    return {
        kind: "clusteredLightContainer",
        pointLights: [],
        horizontalTiles: options?.horizontalTiles ?? 64,
        verticalTiles: options?.verticalTiles ?? 64,
        zSlices: options?.zSlices ?? 16,
        _version: 0,
    };
}

export function createClusteredPointLight(container: ClusteredLightContainer, options: ClusteredPointLightOptions): ClusteredPointLight {
    const light: ClusteredPointLight = {
        position: options.position,
        diffuse: options.diffuse,
        range: options.range ?? 1,
        intensity: options.intensity ?? 1,
    };
    container.pointLights.push(light);
    container._version++;
    return light;
}

export function addClusteredLightContainer(scene: SceneContext, container: ClusteredLightContainer): void {
    const ctx = scene as SceneContext;
    ctx._clusteredLightContainer = container;
    _registerPbrExt(clusteredPbrExt);
    const state = buildClusteredLightGpuState(ctx.engine, ctx, container);
    ctx._clusteredLightUpdater = (camera, targetWidth, targetHeight) => state.refresh(camera, targetWidth, targetHeight);
    ctx._disposables.push(() => state.dispose());
    for (const mesh of ctx.meshes) {
        if (mesh.material) {
            const mat = mesh.material as { _clusteredLightState?: ClusteredLightGpuState; _renderFeatures?: unknown };
            mat._clusteredLightState = state;
            mat._renderFeatures = undefined;
        }
    }
}

const clusteredPbrExt: PbrExt = {
    id: "clustered-lights",
    phase: "fragment",
    detect(mat: unknown) {
        return (mat as { _clusteredLightState?: ClusteredLightGpuState })._clusteredLightState ? { f: 0, f2: PBR2_HAS_CLUSTERED_LIGHTS } : { f: 0, f2: 0 };
    },
    frag(ctx) {
        if ((ctx._features2 & PBR2_HAS_CLUSTERED_LIGHTS) === 0) {
            return null;
        }
        return {
            _id: "clustered-lights",
            _bindings: [
                { _name: "clusteredLightParams", _type: { _kind: "uniform-buffer" }, _visibility: GPUShaderStage.FRAGMENT },
                { _name: "clusteredLights", _type: { _kind: "texture", _textureType: "texture_2d<f32>", _sampleType: "unfilterable-float" }, _visibility: GPUShaderStage.FRAGMENT },
                { _name: "clusteredCells", _type: { _kind: "texture", _textureType: "texture_2d<u32>" }, _visibility: GPUShaderStage.FRAGMENT },
                { _name: "clusteredIndices", _type: { _kind: "texture", _textureType: "texture_2d<u32>" }, _visibility: GPUShaderStage.FRAGMENT },
            ],
            _helperFunctions: CLUSTERED_LIGHT_STRUCTS,
            _fragmentSlots: { AD: CLUSTERED_LIGHT_BLOCK, BL: CLUSTERED_LIGHT_BLOCK },
        };
    },
    bind(ctx, entries, b) {
        const state = (ctx._material as { _clusteredLightState?: ClusteredLightGpuState })._clusteredLightState;
        if (!state) {
            return b;
        }
        entries.push({ binding: b++, resource: { buffer: state.paramsBuffer } });
        entries.push({ binding: b++, resource: state.lightsView });
        entries.push({ binding: b++, resource: state.cellsView });
        entries.push({ binding: b++, resource: state.indicesView });
        return b;
    },
};

export function buildClusteredLightGpuState(engine: EngineContext, scene: SceneContext, container: ClusteredLightContainer): ClusteredLightGpuState {
    const camera = scene.camera;
    if (!camera) {
        throw new Error("buildClusteredLightGpuState: scene.camera is required");
    }
    const width = Math.max(1, engine.canvas.width);
    const height = Math.max(1, engine.canvas.height);
    const tileCountX = Math.max(1, container.horizontalTiles | 0);
    const tileCountY = Math.max(1, container.verticalTiles | 0);
    const zSlices = Math.max(1, container.zSlices | 0);
    const dataTextureWidth = Math.max(1, Math.min(MAX_DATA_TEXTURE_WIDTH, engine._device.limits.maxTextureDimension2D));
    const batchCount = Math.max(1, Math.ceil(container.pointLights.length / CLUSTER_BATCH_SIZE));
    const lightTexels = Math.max(1, container.pointLights.length * 2);
    const lightData = new Float32Array(textureElementCount(lightTexels, 4, dataTextureWidth));
    const sliceData = new Uint32Array(textureElementCount(zSlices, 4, dataTextureWidth));
    const maskTexels = Math.max(1, tileCountX * tileCountY * batchCount);
    const maskData = new Uint32Array(textureElementCount(maskTexels, 1, dataTextureWidth));
    const params = new ArrayBuffer(32);
    const paramsU = new Uint32Array(params);
    const paramsF = new Float32Array(params);
    paramsU[0] = tileCountX;
    paramsU[1] = tileCountY;
    paramsU[2] = zSlices;
    paramsU[3] = container.pointLights.length;
    paramsF[4] = camera.nearPlane;
    paramsF[5] = camera.farPlane;
    paramsU[6] = dataTextureWidth;
    paramsU[7] = batchCount;

    const paramsBuffer = createUniformBuffer(engine, paramsF, "clustered-light-params");
    const lightsTexture = createDataTexture(engine, lightData, "rgba32float", 4, lightTexels, "clustered-light-data", dataTextureWidth);
    const cellsTexture = createDataTexture(engine, sliceData, "rgba32uint", 4, zSlices, "clustered-slice-data", dataTextureWidth);
    const indicesTexture = createDataTexture(engine, maskData, "r32uint", 1, maskTexels, "clustered-tile-mask-data", dataTextureWidth);
    let lastCamera: Camera | null | undefined;
    let lastCameraVersion = -1;
    let lastTargetWidth = 0;
    let lastTargetHeight = 0;
    let lastContainerVersion = -1;
    const state: ClusteredLightGpuState = {
        paramsBuffer,
        lightsView: lightsTexture.createView(),
        cellsView: cellsTexture.createView(),
        indicesView: indicesTexture.createView(),
        refresh(activeCamera, targetWidth, targetHeight) {
            if (!activeCamera) {
                return;
            }
            const safeWidth = Math.max(1, targetWidth);
            const safeHeight = Math.max(1, targetHeight);
            if (
                activeCamera === lastCamera &&
                activeCamera.worldMatrixVersion === lastCameraVersion &&
                safeWidth === lastTargetWidth &&
                safeHeight === lastTargetHeight &&
                container._version === lastContainerVersion
            ) {
                return;
            }
            if (container.pointLights.length * 2 > lightTexels || Math.ceil(container.pointLights.length / CLUSTER_BATCH_SIZE) > batchCount) {
                throw new Error("ClusteredLightContainer: light count cannot grow after GPU state creation.");
            }
            sliceData.fill(0);
            maskData.fill(0);
            const aspect = safeWidth / safeHeight;
            const view = getViewMatrix(activeCamera);
            const proj = getProjectionMatrix(activeCamera, aspect);
            const nearZ = activeCamera.nearPlane;
            const farZ = activeCamera.farPlane;
            const logFarNear = Math.log(farZ / nearZ);
            const sliceScale = zSlices / logFarNear;
            const sliceBias = -(zSlices * Math.log(nearZ)) / logFarNear;
            const sortedLights = container.pointLights.map((light) => ({ light, depth: viewZ(light.position, view) })).sort((a, b) => a.depth - b.depth);
            for (let i = 0; i < zSlices; i++) {
                const off = i * 4;
                sliceData[off] = EMPTY_SLICE_FIRST;
                sliceData[off + 1] = 0;
            }
            for (let i = 0; i < sortedLights.length; i++) {
                const { light, depth } = sortedLights[i]!;
                const off = i * 8;
                lightData[off] = light.position[0];
                lightData[off + 1] = light.position[1];
                lightData[off + 2] = light.position[2];
                lightData[off + 3] = light.range;
                lightData[off + 4] = light.diffuse[0];
                lightData[off + 5] = light.diffuse[1];
                lightData[off + 6] = light.diffuse[2];
                lightData[off + 7] = light.intensity;
                addLightToClusters(sliceData, maskData, light, depth, i, view, proj, tileCountX, tileCountY, zSlices, sliceScale, sliceBias, batchCount);
            }
            paramsU[0] = tileCountX;
            paramsU[1] = tileCountY;
            paramsU[2] = zSlices;
            paramsU[3] = sortedLights.length;
            paramsF[4] = sliceScale;
            paramsF[5] = sliceBias;
            paramsU[7] = batchCount;
            engine._device.queue.writeBuffer(paramsBuffer, 0, paramsF as Float32Array<ArrayBuffer>);
            writeDataTexture(engine, lightsTexture, lightData, 4, lightTexels, dataTextureWidth);
            writeDataTexture(engine, cellsTexture, sliceData, 4, zSlices, dataTextureWidth);
            writeDataTexture(engine, indicesTexture, maskData, 1, maskTexels, dataTextureWidth);
            lastCamera = activeCamera;
            lastCameraVersion = activeCamera.worldMatrixVersion;
            lastTargetWidth = safeWidth;
            lastTargetHeight = safeHeight;
            lastContainerVersion = container._version;
        },
        dispose() {
            paramsBuffer.destroy();
            lightsTexture.destroy();
            cellsTexture.destroy();
            indicesTexture.destroy();
        },
    };
    state.refresh(camera, width, height);
    return state;
}

function textureElementCount(texels: number, components: number, dataTextureWidth: number): number {
    return dataTextureWidth * Math.max(1, Math.ceil(texels / dataTextureWidth)) * components;
}

function createDataTexture(
    engine: EngineContext,
    data: Float32Array | Uint32Array,
    format: GPUTextureFormat,
    components: number,
    texels: number,
    label: string,
    dataTextureWidth: number
): GPUTexture {
    const height = Math.max(1, Math.ceil(texels / dataTextureWidth));
    const texture = engine._device.createTexture({
        label,
        size: { width: dataTextureWidth, height },
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    writeDataTexture(engine, texture, data, components, texels, dataTextureWidth);
    return texture;
}

function writeDataTexture(engine: EngineContext, texture: GPUTexture, data: Float32Array | Uint32Array, components: number, texels: number, dataTextureWidth: number): void {
    const height = Math.max(1, Math.ceil(texels / dataTextureWidth));
    engine._device.queue.writeTexture({ texture }, data.buffer, { bytesPerRow: dataTextureWidth * components * 4, rowsPerImage: height }, { width: dataTextureWidth, height });
}

function addLightToClusters(
    sliceData: Uint32Array,
    maskData: Uint32Array,
    light: ClusteredPointLight,
    viewDepth: number,
    lightIndex: number,
    view: ArrayLike<number>,
    proj: ArrayLike<number>,
    tileCountX: number,
    tileCountY: number,
    zSlices: number,
    sliceScale: number,
    sliceBias: number,
    batchCount: number
): void {
    const vx = view[0]! * light.position[0] + view[4]! * light.position[1] + view[8]! * light.position[2] + view[12]!;
    const vy = view[1]! * light.position[0] + view[5]! * light.position[1] + view[9]! * light.position[2] + view[13]!;
    const vz = viewDepth;
    const range = Math.max(0, light.range);
    const firstSlice = getSliceIndex(vz - range, sliceScale, sliceBias);
    const lastSlice = getSliceIndex(vz + range, sliceScale, sliceBias);
    if (lastSlice < 0 || firstSlice >= zSlices) {
        return;
    }

    const bounds = projectedSphereBounds(vx, vy, vz, range, proj, tileCountX, tileCountY);
    const minX = bounds[0];
    const maxX = bounds[1];
    const minY = bounds[2];
    const maxY = bounds[3];
    const z0 = clampInt(firstSlice, 0, zSlices - 1);
    const z1 = clampInt(lastSlice, 0, zSlices - 1);
    for (let z = z0; z <= z1; z++) {
        const off = z * 4;
        sliceData[off] = Math.min(sliceData[off]!, lightIndex);
        sliceData[off + 1] = Math.max(sliceData[off + 1]!, lightIndex);
    }
    const batch = Math.floor(lightIndex / CLUSTER_BATCH_SIZE);
    const bit = 1 << (lightIndex % CLUSTER_BATCH_SIZE);
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const maskIndex = (x * tileCountY + y) * batchCount + batch;
            maskData[maskIndex] = maskData[maskIndex]! | bit;
        }
    }
}

function viewZ(position: readonly [number, number, number], view: ArrayLike<number>): number {
    return view[2]! * position[0] + view[6]! * position[1] + view[10]! * position[2] + view[14]!;
}

function getSliceIndex(depth: number, sliceScale: number, sliceBias: number): number {
    return depth > 0 ? Math.floor(Math.log(depth) * sliceScale + sliceBias) : -1;
}

function clampInt(v: number, min: number, max: number): number {
    return v < min ? min : v > max ? max : v;
}

function projectedSphereBounds(
    vx: number,
    vy: number,
    vz: number,
    range: number,
    proj: ArrayLike<number>,
    tileCountX: number,
    tileCountY: number
): [number, number, number, number] {
    const rangeSq = range * range;
    let minNdcX = -1;
    let maxNdcX = 1;
    let minNdcY = -1;
    let maxNdcY = 1;
    if (vz > range) {
        const x0 = projectedSphereEdge(vx, vz, rangeSq, proj[0]!, -1);
        const x1 = projectedSphereEdge(vx, vz, rangeSq, proj[0]!, 1);
        minNdcX = Math.min(x0, x1);
        maxNdcX = Math.max(x0, x1);
        const y0 = projectedSphereEdge(vy, vz, rangeSq, proj[5]!, -1);
        const y1 = projectedSphereEdge(vy, vz, rangeSq, proj[5]!, 1);
        minNdcY = Math.min(y0, y1);
        maxNdcY = Math.max(y0, y1);
    }
    return [
        clampInt(Math.floor((minNdcX * 0.5 + 0.5) * tileCountX) - 1, 0, tileCountX - 1),
        clampInt(Math.floor((maxNdcX * 0.5 + 0.5) * tileCountX) + 1, 0, tileCountX - 1),
        clampInt(Math.floor((0.5 - maxNdcY * 0.5) * tileCountY) - 1, 0, tileCountY - 1),
        clampInt(Math.floor((0.5 - minNdcY * 0.5) * tileCountY) + 1, 0, tileCountY - 1),
    ];
}

function projectedSphereEdge(axis: number, depth: number, rangeSq: number, projectionScale: number, side: -1 | 1): number {
    const distSq = axis * axis + depth * depth;
    if (distSq <= rangeSq) {
        return side;
    }
    const sinSq = rangeSq / distSq;
    const cosSq = Math.max(1 - sinSq, 0.01);
    const sinCos = side * Math.sqrt(sinSq * cosSq);
    const rotatedAxis = cosSq * axis + sinCos * depth;
    const rotatedDepth = -sinCos * axis + cosSq * depth;
    return (projectionScale * rotatedAxis) / Math.max(rotatedDepth, 0.01);
}
