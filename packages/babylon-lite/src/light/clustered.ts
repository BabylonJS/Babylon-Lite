import { F32, U32 } from "../engine/typed-arrays.js";
import { TU } from "../engine/gpu-flags.js";
import { getProjectionMatrix, getViewMatrix, getEffectiveAspectRatio, _cameraChangeKey, type Camera } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene.js";
import { createUniformBuffer } from "../resource/gpu-buffers.js";
import { _enableClusteredSpotSupport } from "./clustered-spot-support.js";
import { _enableClusteredPointSupport } from "./clustered-point-support.js";

const MAX_DATA_TEXTURE_WIDTH = 8192;
const CLUSTER_BATCH_SIZE = 32;
const EMPTY_SLICE_FIRST = 0xffffffff;

/**
 * A single point light stored inside a {@link ClusteredLightContainer}. Plain
 * data — created via {@link createClusteredPointLight} and mutated in place.
 */
export interface ClusteredPointLight {
    /** World-space position `[x, y, z]`. */
    position: [number, number, number];
    /** Diffuse colour `[r, g, b]` in linear space. */
    diffuse: [number, number, number];
    /** Falloff range in world units. */
    range: number;
    /** Light intensity multiplier. */
    intensity: number;
}

/**
 * A single spot light stored inside a {@link ClusteredLightContainer}. Plain
 * data — created via {@link createClusteredSpotLight} and mutated in place.
 *
 * The cone uses Babylon.js' glTF directional falloff, so the whole cone is a
 * smooth ramp and there is no separate inner angle or exponent.
 */
export interface ClusteredSpotLight extends ClusteredPointLight {
    /** World-space direction the cone points along; normalised on upload. */
    direction: [number, number, number];
    /** Full cone angle in radians. */
    angle: number;
}

/**
 * Holds a large set of point and spot lights that are binned into screen-space
 * clusters on the GPU, so PBR materials can shade hundreds of lights efficiently.
 * Add it to a scene with {@link addClusteredLightContainer}.
 */
export interface ClusteredLightContainer {
    /** Discriminant tag identifying this object as a clustered light container. */
    readonly kind: "clusteredLightContainer";
    /** The point lights managed by this container. */
    pointLights: ClusteredPointLight[];
    /** The spot lights managed by this container. */
    spotLights: ClusteredSpotLight[];
    /** Number of cluster tiles across the screen horizontally. */
    horizontalTiles: number;
    /** Number of cluster tiles across the screen vertically. */
    verticalTiles: number;
    /** Number of depth slices used to bin lights along view-space Z. */
    zSlices: number;
    /** @internal */
    _version: number;
    /** @internal Installed by createClusteredSpotLight so point-only bundles retain the narrow path. */
    _spotSupport?: _ClusteredSpotSupport;
}

/** Options for {@link createClusteredPointLight}. */
export interface ClusteredPointLightOptions {
    /** World-space position `[x, y, z]`. */
    position: [number, number, number];
    /** Diffuse colour `[r, g, b]` in linear space. */
    diffuse: [number, number, number];
    /** Falloff range in world units. Default `1`. */
    range?: number;
    /** Light intensity multiplier. Default `1`. */
    intensity?: number;
}

/** Options for {@link createClusteredSpotLight}. */
export interface ClusteredSpotLightOptions extends ClusteredPointLightOptions {
    /** World-space direction the cone points along. */
    direction: [number, number, number];
    /** Full cone angle in radians. Default `Math.PI / 2`. */
    angle?: number;
}

/** Options for {@link createClusteredLightContainer}. */
export interface ClusteredLightContainerOptions {
    /** Number of cluster tiles across the screen horizontally. Default `64`. */
    horizontalTiles?: number;
    /** Number of cluster tiles across the screen vertically. Default `64`. */
    verticalTiles?: number;
    /** Number of depth slices used to bin lights along view-space Z. Default `16`. */
    zSlices?: number;
}

export interface ClusteredLightGpuState {
    paramsBuffer: GPUBuffer;
    lightsView: GPUTextureView;
    cellsView: GPUTextureView;
    indicesView: GPUTextureView;
    /** @internal True when the container held spot lights at build time. */
    _hasSpots?: true;
    refresh(camera: Camera | null | undefined, targetWidth: number, targetHeight: number): void;
    dispose(): void;
}

/**
 * Create an empty {@link ClusteredLightContainer}. Add lights with
 * {@link createClusteredPointLight} / {@link createClusteredSpotLight}, then
 * register it on a scene via {@link addClusteredLightContainer}.
 *
 * @param options - Optional cluster tiling overrides.
 * @returns A new, empty clustered light container.
 */
export function createClusteredLightContainer(options?: ClusteredLightContainerOptions): ClusteredLightContainer {
    return {
        kind: "clusteredLightContainer",
        pointLights: [],
        spotLights: [],
        horizontalTiles: options?.horizontalTiles ?? 64,
        verticalTiles: options?.verticalTiles ?? 64,
        zSlices: options?.zSlices ?? 16,
        _version: 0,
    };
}

/**
 * Add a point light to a clustered light container.
 *
 * @param container - The container to add the light to.
 * @param options - The light's position, colour and (optional) range/intensity.
 * @returns The created light (also pushed onto `container.pointLights`); mutate
 * it in place and call {@link markClusteredLightContainerDirty} to animate it.
 */
export function createClusteredPointLight(container: ClusteredLightContainer, options: ClusteredPointLightOptions): ClusteredPointLight {
    if (container.pointLights.length === 0) {
        _enableClusteredPointSupport();
    }
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

/**
 * Add a spot light to a clustered light container. Spot lights are culled as
 * spheres of radius `range` (matching Babylon.js) and shaded with a glTF-style
 * smooth cone falloff.
 *
 * All lights must be created before {@link addClusteredLightContainer}: the GPU
 * state bakes both the light capacity and the point/spot data layout.
 *
 * @param container - The container to add the light to.
 * @param options - The light's position, direction, colour and optional cone/range/intensity.
 * @returns The created light (also pushed onto `container.spotLights`); mutate
 * it in place and call {@link markClusteredLightContainerDirty} to animate it.
 */
export function createClusteredSpotLight(container: ClusteredLightContainer, options: ClusteredSpotLightOptions): ClusteredSpotLight {
    _enableClusteredSpotSupport(container);
    const light: ClusteredSpotLight = {
        position: options.position,
        direction: options.direction,
        diffuse: options.diffuse,
        range: options.range ?? 1,
        intensity: options.intensity ?? 1,
        angle: options.angle ?? Math.PI / 2,
    };
    container.spotLights.push(light);
    container._version++;
    return light;
}

/** Force the container's GPU light state to re-upload next frame. Call after mutating a light's
 *  position / direction / range / intensity / diffuse / angle in place, since
 *  those edits don't bump the container version on their own. */
export function markClusteredLightContainerDirty(container: ClusteredLightContainer): void {
    container._version++;
}

/**
 * Register a clustered light container on a scene, building its GPU state and
 * wiring it into the PBR materials already present in the scene.
 *
 * @param scene - The scene to attach the container to.
 * @param container - The clustered light container to register.
 */
export function addClusteredLightContainer(scene: SceneContext, container: ClusteredLightContainer): void {
    const ctx = scene as SceneContext;
    if (container.pointLights.length > 0 && !container._spotSupport) {
        _enableClusteredPointSupport();
    }
    ctx._clusteredLightContainer = container;
    const state = buildClusteredLightGpuState(ctx.surface.engine, ctx, container);
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

/** @internal Per-state spot hooks. Kept behind createClusteredSpotLight so point-only
 * bundles do not retain cone snapshot, packing or shader-generation code. */
export interface _ClusteredSpotGpuSupport {
    /** @internal */
    readonly _stride: 3;
    /** @internal */
    _coneChanged(index: number, light: ClusteredSpotLight): boolean;
    /** @internal */
    _collect(activeLights: _ClusteredActiveLight[], lights: ClusteredSpotLight[], view: ArrayLike<number>): void;
    /** @internal */
    _write(data: Float32Array, offset: number, spot: ClusteredSpotLight | undefined): void;
    /** @internal */
    _markState(state: ClusteredLightGpuState): void;
}

/** @internal Container-level factory installed by the spot opt-in. */
export interface _ClusteredSpotSupport {
    /** @internal */
    _create(lightCount: number): _ClusteredSpotGpuSupport;
}

/** @internal Compacted light record used while rebuilding cluster data. */
export interface _ClusteredActiveLight {
    light: ClusteredPointLight;
    depth: number;
    /** @internal */
    _spot?: ClusteredSpotLight;
}

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
    const maxDataTextureWidth = Math.max(1, Math.min(MAX_DATA_TEXTURE_WIDTH, engine._device.limits.maxTextureDimension2D));
    const spotSupport = container._spotSupport?._create(container.spotLights.length);
    const pointCount = container.pointLights.length;
    const spotCount = spotSupport ? container.spotLights.length : 0;
    const totalLights = pointCount + spotCount;
    // Both the light capacity and the data layout are baked here: a point-only container
    // keeps the narrow 2-texel stride so it pays nothing for spot support.
    const lightStride = spotSupport?._stride ?? 2;
    const batchCount = Math.max(1, Math.ceil(totalLights / CLUSTER_BATCH_SIZE));
    const lightTexels = Math.max(1, totalLights * lightStride);
    const maskTexels = Math.max(1, tileCountX * tileCountY * batchCount);
    const dataTextureWidth = Math.min(maxDataTextureWidth, Math.max(lightTexels, zSlices, maskTexels));
    const lightData = new F32(textureElementCount(lightTexels, 4, dataTextureWidth));
    const sliceData = new U32(textureElementCount(zSlices, 4, dataTextureWidth));
    const maskData = new U32(textureElementCount(maskTexels, 1, dataTextureWidth));
    // Points first, then spots — the same order the snapshot / dirty scan walks.
    const lightSnapshot = new F32(totalLights * 8);
    lightSnapshot.fill(Number.NaN);
    const activeLights: _ClusteredActiveLight[] = [];
    const params = new ArrayBuffer(32);
    const paramsU = new U32(params);
    const paramsF = new F32(params);
    paramsU[0] = tileCountX;
    paramsU[1] = tileCountY;
    paramsU[2] = zSlices;
    paramsU[3] = totalLights;
    paramsF[4] = camera.nearPlane;
    paramsF[5] = camera.farPlane;
    paramsU[6] = dataTextureWidth;
    paramsU[7] = batchCount;

    const paramsBuffer = createUniformBuffer(engine, paramsF, "clustered-light-params");
    const lightsTexture = createDataTexture(engine, "rgba32float", lightTexels, "clustered-light-data", dataTextureWidth);
    const cellsTexture = createDataTexture(engine, "rgba32uint", zSlices, "clustered-slice-data", dataTextureWidth);
    const indicesTexture = createDataTexture(engine, "r32uint", maskTexels, "clustered-tile-mask-data", dataTextureWidth);
    let lastCamera: Camera | null | undefined;
    let lastCameraVersion = -1;
    let lastTargetWidth = 0;
    let lastTargetHeight = 0;
    let lastAspect = -1;
    let lastContainerVersion = -1;
    let lastLightCount = -1;
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
            // Effective aspect, not the raw target ratio: a camera with a normalized viewport
            // renders through a different projection than width/height implies, and the forward
            // pass already folds the viewport in (`_writePassSceneUBO`). Binning lights from a
            // projection the frame never uses puts them in the wrong tiles. It is also part of
            // the dirty key below, since a viewport change moves it with everything else equal.
            const aspect = getEffectiveAspectRatio(activeCamera, safeWidth, safeHeight);
            const liveCount = container.pointLights.length + (spotSupport ? container.spotLights.length : 0);
            if (
                activeCamera === lastCamera &&
                _cameraChangeKey(activeCamera) === lastCameraVersion &&
                safeWidth === lastTargetWidth &&
                safeHeight === lastTargetHeight &&
                aspect === lastAspect &&
                container._version === lastContainerVersion &&
                liveCount === lastLightCount
            ) {
                return;
            }
            if (liveCount * lightStride > lightTexels || Math.ceil(liveCount / CLUSTER_BATCH_SIZE) > batchCount || !!container._spotSupport !== !!spotSupport) {
                throw new Error("ClusteredLightContainer: light count cannot grow after GPU state creation.");
            }
            let topologyDirty =
                activeCamera !== lastCamera ||
                _cameraChangeKey(activeCamera) !== lastCameraVersion ||
                safeWidth !== lastTargetWidth ||
                safeHeight !== lastTargetHeight ||
                aspect !== lastAspect ||
                liveCount !== lastLightCount;
            let lightDataDirty = topologyDirty;
            if (container._version !== lastContainerVersion || liveCount !== lastLightCount) {
                let index = 0;
                for (let i = 0; i < container.pointLights.length; i++) {
                    const flags = snapshotLight(lightSnapshot, index++, container.pointLights[i]!);
                    topologyDirty ||= (flags & 1) !== 0;
                    lightDataDirty ||= (flags & 2) !== 0;
                }
                if (spotSupport) {
                    for (let i = 0; i < container.spotLights.length; i++) {
                        const spot = container.spotLights[i]!;
                        const flags = snapshotLight(lightSnapshot, index++, spot);
                        const coneChanged = spotSupport._coneChanged(i, spot);
                        topologyDirty ||= (flags & 1) !== 0;
                        lightDataDirty ||= (flags & 2) !== 0 || coneChanged;
                    }
                }
            }
            if (!topologyDirty && !lightDataDirty) {
                lastContainerVersion = container._version;
                return;
            }

            if (topologyDirty) {
                lightDataDirty = true;
                sliceData.fill(0);
                activeLights.length = 0;
                const view = getViewMatrix(activeCamera);
                const proj = getProjectionMatrix(activeCamera, aspect);
                const nearZ = activeCamera.nearPlane;
                const farZ = activeCamera.farPlane;
                const logFarNear = Math.log(farZ / nearZ);
                const sliceScale = zSlices / logFarNear;
                const sliceBias = -(zSlices * Math.log(nearZ)) / logFarNear;
                for (const light of container.pointLights) {
                    if (light.range > 0 && light.intensity > 0) {
                        activeLights.push({ light, depth: viewZ(light.position, view) });
                    }
                }
                spotSupport?._collect(activeLights, container.spotLights, view);
                activeLights.sort((a, b) => a.depth - b.depth);
                const activeBatchCount = Math.max(1, Math.ceil(activeLights.length / CLUSTER_BATCH_SIZE));
                const activeMaskTexels = tileCountX * tileCountY * activeBatchCount;
                maskData.fill(0, 0, activeMaskTexels);
                for (let i = 0; i < zSlices; i++) {
                    const off = i * 4;
                    sliceData[off] = EMPTY_SLICE_FIRST;
                    sliceData[off + 1] = 0;
                }
                for (let i = 0; i < activeLights.length; i++) {
                    const { light, depth } = activeLights[i]!;
                    addLightToClusters(sliceData, maskData, light, depth, i, view, proj, tileCountX, tileCountY, zSlices, sliceScale, sliceBias, activeBatchCount);
                }
                paramsU[0] = tileCountX;
                paramsU[1] = tileCountY;
                paramsU[2] = zSlices;
                paramsU[3] = activeLights.length;
                paramsF[4] = sliceScale;
                paramsF[5] = sliceBias;
                paramsU[7] = activeBatchCount;
                engine._device.queue.writeBuffer(paramsBuffer, 0, paramsF as Float32Array<ArrayBuffer>);
                writeDataTexture(engine, cellsTexture, sliceData, 4, zSlices, dataTextureWidth);
                if (activeLights.length > 0) {
                    writeDataTexture(engine, indicesTexture, maskData, 1, activeMaskTexels, dataTextureWidth);
                }
            }
            if (lightDataDirty) {
                for (let i = 0; i < activeLights.length; i++) {
                    const { light, _spot } = activeLights[i]!;
                    const off = i * lightStride * 4;
                    lightData[off] = light.position[0];
                    lightData[off + 1] = light.position[1];
                    lightData[off + 2] = light.position[2];
                    lightData[off + 3] = light.range;
                    lightData[off + 4] = light.diffuse[0];
                    lightData[off + 5] = light.diffuse[1];
                    lightData[off + 6] = light.diffuse[2];
                    lightData[off + 7] = light.intensity;
                    spotSupport?._write(lightData, off, _spot);
                }
                if (activeLights.length > 0) {
                    writeDataTexture(engine, lightsTexture, lightData, 4, activeLights.length * lightStride, dataTextureWidth);
                }
            }
            lastCamera = activeCamera;
            lastCameraVersion = _cameraChangeKey(activeCamera);
            lastTargetWidth = safeWidth;
            lastTargetHeight = safeHeight;
            lastAspect = aspect;
            lastContainerVersion = container._version;
            lastLightCount = liveCount;
        },
        dispose() {
            paramsBuffer.destroy();
            lightsTexture.destroy();
            cellsTexture.destroy();
            indicesTexture.destroy();
        },
    };
    spotSupport?._markState(state);
    state.refresh(camera, width, height);
    return state;
}

function textureElementCount(texels: number, components: number, dataTextureWidth: number): number {
    return dataTextureWidth * Math.max(1, Math.ceil(texels / dataTextureWidth)) * components;
}

/** Records a light's culling + shading inputs and reports what changed.
 *  Bit 0 = topology (position / range / active flag, which move cluster assignment),
 *  bit 1 = shading only (colour / intensity, which just re-upload the light texture). */
function snapshotLight(snapshot: Float32Array, index: number, light: ClusteredPointLight): number {
    const off = index * 8;
    const wasActive = snapshot[off + 3]! > 0 && snapshot[off + 7]! > 0;
    const isActive = light.range > 0 && light.intensity > 0;
    let flags = 0;
    if (
        snapshot[off] !== light.position[0] ||
        snapshot[off + 1] !== light.position[1] ||
        snapshot[off + 2] !== light.position[2] ||
        snapshot[off + 3] !== light.range ||
        wasActive !== isActive
    ) {
        flags |= 1;
    }
    if (snapshot[off + 4] !== light.diffuse[0] || snapshot[off + 5] !== light.diffuse[1] || snapshot[off + 6] !== light.diffuse[2] || snapshot[off + 7] !== light.intensity) {
        flags |= 2;
    }
    snapshot[off] = light.position[0];
    snapshot[off + 1] = light.position[1];
    snapshot[off + 2] = light.position[2];
    snapshot[off + 3] = light.range;
    snapshot[off + 4] = light.diffuse[0];
    snapshot[off + 5] = light.diffuse[1];
    snapshot[off + 6] = light.diffuse[2];
    snapshot[off + 7] = light.intensity;
    return flags;
}

function createDataTexture(engine: EngineContext, format: GPUTextureFormat, texels: number, label: string, dataTextureWidth: number): GPUTexture {
    const height = Math.max(1, Math.ceil(texels / dataTextureWidth));
    const texture = engine._device.createTexture({
        label,
        size: { width: dataTextureWidth, height },
        format,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST,
    });
    return texture;
}

function writeDataTexture(engine: EngineContext, texture: GPUTexture, data: Float32Array | Uint32Array, components: number, texels: number, dataTextureWidth: number): void {
    const height = Math.max(1, Math.ceil(texels / dataTextureWidth));
    const width = height > 1 ? dataTextureWidth : Math.max(1, Math.min(texels, dataTextureWidth));
    engine._device.queue.writeTexture({ texture }, data.buffer, { bytesPerRow: width * components * 4, rowsPerImage: height }, { width, height });
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
    // proj[11] is 1 for a perspective projection and 0 for an orthographic one — a
    // projection-agnostic discriminator that needs no coupling to the camera module.
    // Under orthographic projection the silhouette is depth-independent: the sphere maps
    // to an axis-aligned box of exactly its own radius, offset by the (possibly
    // off-center) projection translation in proj[12]/proj[13], which the perspective
    // path below ignores entirely.
    if (proj[11] === 0) {
        const sx = proj[0]!;
        const sy = proj[5]!;
        const cx = sx * vx + proj[12]!;
        const cy = sy * vy + proj[13]!;
        const rx = Math.abs(sx * range);
        const ry = Math.abs(sy * range);
        minNdcX = Math.max(cx - rx, -1);
        maxNdcX = Math.min(cx + rx, 1);
        minNdcY = Math.max(cy - ry, -1);
        maxNdcY = Math.min(cy + ry, 1);
    } else if (vz > range) {
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
