/**
 * Opt-in per-material PBR environment overrides and local cubemap reflections.
 *
 * Environment override state, shader code, and GPU binding logic live entirely in
 * this feature chunk. PBR scenes that do not call enablePbrLocalCubemap() retain
 * the ordinary material shape, shader path, and renderable update loop.
 */

import { BU, TU } from "../../engine/gpu-flags.js";
import { createMappedBuffer, createUniformBuffer } from "../../resource/gpu-buffers.js";
import { getTrilinearSampler } from "../../resource/samplers.js";
import type { SceneContext } from "../../scene/scene.js";
import { _registerPbrExt } from "./pbr-flags.js";
import { _installPbrExtensionIblResolver } from "./pbr-compose.js";
import { _installPbrIblFallbackResolver } from "./pbr-pipeline.js";
import { _enableDdsEnvironmentCopySource } from "../../loader-env/load-dds-env.js";
import { _enableHdrEnvironmentCopySource } from "../../loader-hdr/hdr-ibl-pipeline.js";
import {
    _initializePbrLocalCubemapLimits,
    _PBR_LOCAL_ENVIRONMENT_CANDIDATE_CAPACITY,
    _PBR_LOCAL_ENVIRONMENT_DEBUG_COLOR_FLAG,
    _PBR_LOCAL_ENVIRONMENT_HEADER_U32,
    _PBR_LOCAL_ENVIRONMENT_PARALLAX_FLAG,
    _PBR_LOCAL_ENVIRONMENT_PROBE_FLOATS,
    _PBR_LOCAL_ENVIRONMENT_SPHERE_FLAG,
    _PBR_LOCAL_ENVIRONMENT_UNIFORM_FLOATS,
    MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES,
    MAX_PBR_LOCAL_ENVIRONMENT_PROBES,
} from "./pbr-local-cubemap-limits.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { _setPbrLocalEnvironment, type PbrLocalEnvironmentOptions, type PbrLocalEnvironmentProbe, type PbrLocalEnvironmentProbeSet } from "./pbr-local-cubemap-state.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";

export { MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES, MAX_PBR_LOCAL_ENVIRONMENT_PROBES } from "./pbr-local-cubemap-limits.js";
export type { PbrLocalEnvironmentOptions, PbrLocalEnvironmentProbe, PbrLocalEnvironmentProbeSet } from "./pbr-local-cubemap-state.js";

export interface PbrLocalCubemapInitOptions {
    /** Maximum probes evaluated per fragment. Defaults to 4 and cannot change after initialization. */
    readonly maxCandidates?: number;
}

export interface PbrLocalEnvironmentProbeSetOptions {
    readonly probes: readonly PbrLocalEnvironmentProbe[];
    readonly voxelGrid: PbrLocalEnvironmentProbeGridOptions;
    readonly parallaxCorrection?: boolean;
}

export interface PbrLocalEnvironmentProbeGridOptions {
    /** Inclusive world-space minimum corner. */
    readonly minimum: readonly [number, number, number];
    /** World-space maximum corner. Dimensions are rounded up to whole cells. */
    readonly maximum: readonly [number, number, number];
    /** Uniform voxel edge length. */
    readonly cellSize: number;
}

export interface PbrLocalEnvironmentProbeGridCell {
    readonly coordinates: readonly [number, number, number];
    readonly probeIndices: readonly number[];
    /** True when the queried point was clamped to a boundary voxel. */
    readonly outside: boolean;
}

/**
 * Override the environment used by one PBR material without parallax correction.
 *
 * Configure before scene registration. Call `enablePbrLocalCubemap()` before
 * registering the scene so the environment-override shader path is available.
 */
export function setPbrEnvironment(material: PbrMaterialProps, environment: EnvironmentTextures): void {
    _setPbrLocalEnvironment(material, { kind: "environment", environment });
}

/**
 * Assign one bounded local environment to a PBR material.
 *
 * Configure before scene registration. If bindings already exist, call
 * `rebuildMaterial(scene, material)` after changing or clearing the assignment.
 */
export function setPbrLocalEnvironment(material: PbrMaterialProps, environment: EnvironmentTextures, options: PbrLocalEnvironmentOptions): void {
    finiteVec3(options.projectionPosition, "local environment projectionPosition");
    const capturePosition = options.capturePosition ?? options.projectionPosition;
    finiteVec3(capturePosition, "local environment capturePosition");
    const projectionSize: [number, number, number] =
        options.shape === "sphere"
            ? (finitePositive(options.projectionRadius, "local environment projectionRadius"),
              [options.projectionRadius * 2, options.projectionRadius * 2, options.projectionRadius * 2])
            : (finiteVec3(options.projectionSize, "local environment projectionSize", true), [...options.projectionSize]);
    _setPbrLocalEnvironment(material, {
        kind: "single",
        environment,
        shape: options.shape ?? "box",
        capturePosition: [...capturePosition],
        projectionPosition: [...options.projectionPosition],
        projectionSize,
    });
}

/**
 * Assign a fragment-blended probe set to a PBR material.
 *
 * Configure before scene registration. If bindings already exist, call
 * `rebuildMaterial(scene, material)` after changing or clearing the assignment.
 */
export function setPbrLocalEnvironmentProbeSet(material: PbrMaterialProps, set: PbrLocalEnvironmentProbeSet): void {
    _setPbrLocalEnvironment(material, { kind: "probes", set });
}

/** Clear an opt-in local environment assignment from a PBR material. */
export function clearPbrLocalEnvironment(material: PbrMaterialProps): void {
    _setPbrLocalEnvironment(material, null);
}

function finiteVec3(value: readonly number[], name: string, positive = false): void {
    if (value.length !== 3 || value.some((component) => !Number.isFinite(component) || (positive && component <= 0))) {
        throw new Error(`[babylon-lite] ${name} must contain three finite${positive ? " positive" : ""} values`);
    }
}

function finitePositive(value: number, name: string): void {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`[babylon-lite] ${name} must be finite and positive`);
    }
}

function validateProbe(probe: PbrLocalEnvironmentProbe, index: number): void {
    finiteVec3(probe.capturePosition, `local probe ${index} capturePosition`);
    finiteVec3(probe.projectionPosition, `local probe ${index} projectionPosition`);
    finiteVec3(probe.influencePosition, `local probe ${index} influencePosition`);
    if (probe.shape === "sphere") {
        finitePositive(probe.projectionRadius, `local probe ${index} projectionRadius`);
        finitePositive(probe.influenceOuterRadius, `local probe ${index} influenceOuterRadius`);
        if (!Number.isFinite(probe.influenceInnerRadius) || probe.influenceInnerRadius < 0 || probe.influenceInnerRadius > probe.influenceOuterRadius) {
            throw new Error(`[babylon-lite] local probe ${index} influenceInnerRadius must be finite, non-negative, and no larger than influenceOuterRadius`);
        }
    } else {
        finiteVec3(probe.projectionSize, `local probe ${index} projectionSize`, true);
        finiteVec3(probe.influenceInnerSize, `local probe ${index} influenceInnerSize`);
        const outerPosition = probe.influenceOuterPosition ?? probe.influencePosition;
        finiteVec3(outerPosition, `local probe ${index} influenceOuterPosition`);
        finiteVec3(probe.influenceOuterSize, `local probe ${index} influenceOuterSize`, true);
        const angle = probe.angleRadians ?? 0;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const dx = outerPosition[0] - probe.influencePosition[0];
        const dz = outerPosition[2] - probe.influencePosition[2];
        const localOffset = [cosine * dx - sine * dz, outerPosition[1] - probe.influencePosition[1], sine * dx + cosine * dz];
        for (let axis = 0; axis < 3; axis++) {
            const innerHalf = probe.influenceInnerSize[axis]! * 0.5;
            const outerHalf = probe.influenceOuterSize[axis]! * 0.5;
            if (innerHalf < 0 || Math.abs(localOffset[axis]!) + innerHalf > outerHalf) {
                throw new Error(`[babylon-lite] local probe ${index} inner influence box must be non-negative and contained by the outer influence box`);
            }
        }
    }
    if (probe.angleRadians !== undefined && !Number.isFinite(probe.angleRadians)) {
        throw new Error(`[babylon-lite] local probe ${index} angleRadians must be finite`);
    }
    if (probe.debugColor !== undefined && (probe.debugColor.length !== 3 || probe.debugColor.some((component) => !Number.isFinite(component) || component < 0 || component > 1))) {
        throw new Error(`[babylon-lite] local probe ${index} debugColor must contain three finite values from 0 to 1`);
    }
}

function powerOfTwoRatio(value: number, base: number): number {
    const ratio = value / base;
    const offset = Math.log2(ratio);
    if (!Number.isInteger(offset) || offset < 0) {
        throw new Error(`[babylon-lite] local probe cubemap dimensions must differ only by power-of-two mip levels`);
    }
    return offset;
}

function packDebugColor(color: readonly [number, number, number] | undefined): number {
    const value = color ?? [1, 0, 1];
    return Math.round(value[0] * 255) | (Math.round(value[1] * 255) << 8) | (Math.round(value[2] * 255) << 16);
}

function writeProbe(data: Float32Array, u32: Uint32Array, probe: PbrLocalEnvironmentProbe, index: number, sourceMipOffset: number): void {
    const base = _PBR_LOCAL_ENVIRONMENT_HEADER_U32 + index * _PBR_LOCAL_ENVIRONMENT_PROBE_FLOATS;
    const projectionHalf = probe.shape === "sphere" ? [probe.projectionRadius, probe.projectionRadius, probe.projectionRadius] : probe.projectionSize.map((value) => value * 0.5);
    const influenceInnerHalf =
        probe.shape === "sphere" ? [probe.influenceInnerRadius, probe.influenceInnerRadius, probe.influenceInnerRadius] : probe.influenceInnerSize.map((value) => value * 0.5);
    const influenceOuterHalf =
        probe.shape === "sphere" ? [probe.influenceOuterRadius, probe.influenceOuterRadius, probe.influenceOuterRadius] : probe.influenceOuterSize.map((value) => value * 0.5);
    const influenceOuterPosition = probe.shape === "sphere" ? probe.influencePosition : (probe.influenceOuterPosition ?? probe.influencePosition);
    const angle = probe.angleRadians ?? 0;
    const lodScale = probe.environment.lodGenerationScale ?? 0.8;
    const lodBias = sourceMipOffset * (lodScale - 1);

    data.set(probe.projectionPosition, base);
    data[base + 3] = index;
    data.set(projectionHalf, base + 4);
    data[base + 7] = lodScale;
    data.set(probe.capturePosition, base + 8);
    data[base + 11] = lodBias;
    data.set(probe.influencePosition, base + 12);
    data[base + 15] = Math.cos(angle);
    data.set(influenceInnerHalf, base + 16);
    data[base + 19] = Math.sin(angle);
    data.set(influenceOuterPosition, base + 20);
    data.set(influenceOuterHalf, base + 24);
    u32[base + 27] = packDebugColor(probe.debugColor) | (probe.shape === "sphere" ? _PBR_LOCAL_ENVIRONMENT_SPHERE_FLAG : 0);
}

function probeOuterPosition(probe: PbrLocalEnvironmentProbe): readonly [number, number, number] {
    return probe.shape === "sphere" ? probe.influencePosition : (probe.influenceOuterPosition ?? probe.influencePosition);
}

const GRID_HEADER_U32 = 8;
const GRID_EPSILON = 1e-6;

interface BuiltProbeGrid {
    readonly data: Uint32Array;
    readonly minimum: readonly [number, number, number];
    readonly cellSize: number;
    readonly dimensions: readonly [number, number, number];
    readonly stride: number;
}

interface ProbeGridLayout {
    readonly minimum: readonly [number, number, number];
    readonly dimensions: readonly [number, number, number];
    readonly cellCount: number;
    readonly stride: number;
    readonly dataLength: number;
    readonly byteLength: number;
}

function validateGrid(options: PbrLocalEnvironmentProbeGridOptions): void {
    finiteVec3(options.minimum, "local probe voxelGrid.minimum");
    finiteVec3(options.maximum, "local probe voxelGrid.maximum");
    if (!Number.isFinite(options.cellSize) || options.cellSize <= 0) {
        throw new Error("[babylon-lite] local probe voxelGrid.cellSize must be finite and positive");
    }
    for (let axis = 0; axis < 3; axis++) {
        if (options.maximum[axis]! <= options.minimum[axis]!) {
            throw new Error("[babylon-lite] local probe voxelGrid.maximum must be greater than minimum on every axis");
        }
    }
}

function probeOuterWorldExtent(probe: PbrLocalEnvironmentProbe): [number, number, number] {
    if (probe.shape === "sphere") {
        return [probe.influenceOuterRadius, probe.influenceOuterRadius, probe.influenceOuterRadius];
    }
    const halfX = probe.influenceOuterSize[0] * 0.5;
    const halfY = probe.influenceOuterSize[1] * 0.5;
    const halfZ = probe.influenceOuterSize[2] * 0.5;
    const angle = probe.angleRadians ?? 0;
    const cosine = Math.abs(Math.cos(angle));
    const sine = Math.abs(Math.sin(angle));
    return [cosine * halfX + sine * halfZ, halfY, sine * halfX + cosine * halfZ];
}

function intersectsProbeOuterBox(probe: PbrLocalEnvironmentProbe, cellCentre: readonly number[], cellHalfSize: number): boolean {
    const outerPosition = probeOuterPosition(probe);
    const dx = cellCentre[0]! - outerPosition[0];
    const dy = cellCentre[1]! - outerPosition[1];
    const dz = cellCentre[2]! - outerPosition[2];
    if (probe.shape === "sphere") {
        const distanceToCellSquared = Math.max(Math.abs(dx) - cellHalfSize, 0) ** 2 + Math.max(Math.abs(dy) - cellHalfSize, 0) ** 2 + Math.max(Math.abs(dz) - cellHalfSize, 0) ** 2;
        return distanceToCellSquared <= probe.influenceOuterRadius ** 2 + GRID_EPSILON;
    }
    const probeHalfX = probe.influenceOuterSize[0] * 0.5;
    const probeHalfY = probe.influenceOuterSize[1] * 0.5;
    const probeHalfZ = probe.influenceOuterSize[2] * 0.5;
    if (Math.abs(dy) > cellHalfSize + probeHalfY + GRID_EPSILON) {
        return false;
    }

    const angle = probe.angleRadians ?? 0;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const absCosine = Math.abs(cosine);
    const absSine = Math.abs(sine);
    if (Math.abs(dx) > cellHalfSize + absCosine * probeHalfX + absSine * probeHalfZ + GRID_EPSILON) {
        return false;
    }
    if (Math.abs(dz) > cellHalfSize + absSine * probeHalfX + absCosine * probeHalfZ + GRID_EPSILON) {
        return false;
    }

    const localX = cosine * dx - sine * dz;
    const localZ = sine * dx + cosine * dz;
    const projectedCellHalfSize = (absCosine + absSine) * cellHalfSize;
    return Math.abs(localX) <= probeHalfX + projectedCellHalfSize + GRID_EPSILON && Math.abs(localZ) <= probeHalfZ + projectedCellHalfSize + GRID_EPSILON;
}

function probeNdfAtPoint(probe: PbrLocalEnvironmentProbe, point: readonly number[]): number {
    const dx = point[0]! - probe.influencePosition[0];
    const dy = point[1]! - probe.influencePosition[1];
    const dz = point[2]! - probe.influencePosition[2];
    if (probe.shape === "sphere") {
        return (Math.hypot(dx, dy, dz) - probe.influenceInnerRadius) / Math.max(probe.influenceOuterRadius - probe.influenceInnerRadius, 0.00001);
    }
    const angle = probe.angleRadians ?? 0;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const local = [cosine * dx - sine * dz, dy, sine * dx + cosine * dz];
    const outerPosition = probe.influenceOuterPosition ?? probe.influencePosition;
    const outerDx = outerPosition[0] - probe.influencePosition[0];
    const outerDz = outerPosition[2] - probe.influencePosition[2];
    const outerOffset = [cosine * outerDx - sine * outerDz, outerPosition[1] - probe.influencePosition[1], sine * outerDx + cosine * outerDz];
    let ndf = Number.NEGATIVE_INFINITY;
    for (let axis = 0; axis < 3; axis++) {
        const inner = probe.influenceInnerSize[axis]! * 0.5;
        const outer = probe.influenceOuterSize[axis]! * 0.5;
        const positive = local[axis]! >= 0;
        const span = positive ? outerOffset[axis]! + outer - inner : -outerOffset[axis]! + outer - inner;
        ndf = Math.max(ndf, (Math.abs(local[axis]!) - inner) / Math.max(span, 0.00001));
    }
    return ndf;
}

function measureProbeGrid(options: PbrLocalEnvironmentProbeGridOptions): ProbeGridLayout {
    validateGrid(options);
    const minimum: [number, number, number] = [...options.minimum];
    const dimensions: [number, number, number] = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
        dimensions[axis] = Math.ceil((options.maximum[axis]! - minimum[axis]!) / options.cellSize);
    }
    const cellCount = dimensions[0] * dimensions[1] * dimensions[2];
    if (!Number.isSafeInteger(cellCount) || cellCount < 1) {
        throw new Error("[babylon-lite] local probe voxel grid dimensions are too large");
    }
    const stride = 1 + MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES;
    const dataLength = GRID_HEADER_U32 + cellCount * stride;
    const byteLength = dataLength * Uint32Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(dataLength) || !Number.isSafeInteger(byteLength)) {
        throw new Error("[babylon-lite] local probe voxel grid dimensions are too large");
    }
    return { minimum, dimensions, cellCount, stride, dataLength, byteLength };
}

function buildProbeGrid(probes: readonly PbrLocalEnvironmentProbe[], options: PbrLocalEnvironmentProbeGridOptions, layout: ProbeGridLayout): BuiltProbeGrid {
    const { minimum, dimensions, cellCount, stride, dataLength } = layout;
    const cells = Array.from({ length: cellCount }, () => [] as number[]);
    const cellHalfSize = options.cellSize * 0.5;
    const linearIndex = (x: number, y: number, z: number): number => (z * dimensions[1] + y) * dimensions[0] + x;
    for (let probeIndex = 0; probeIndex < probes.length; probeIndex++) {
        const probe = probes[probeIndex]!;
        const extent = probeOuterWorldExtent(probe);
        const outerPosition = probeOuterPosition(probe);
        const starts: [number, number, number] = [0, 0, 0];
        const ends: [number, number, number] = [0, 0, 0];
        for (let axis = 0; axis < 3; axis++) {
            starts[axis] = Math.max(0, Math.floor((outerPosition[axis]! - extent[axis]! - minimum[axis]!) / options.cellSize));
            ends[axis] = Math.min(dimensions[axis]! - 1, Math.floor((outerPosition[axis]! + extent[axis]! - minimum[axis]!) / options.cellSize));
        }
        for (let z = starts[2]; z <= ends[2]; z++) {
            for (let y = starts[1]; y <= ends[1]; y++) {
                for (let x = starts[0]; x <= ends[0]; x++) {
                    const centre = [minimum[0] + (x + 0.5) * options.cellSize, minimum[1] + (y + 0.5) * options.cellSize, minimum[2] + (z + 0.5) * options.cellSize];
                    if (!intersectsProbeOuterBox(probe, centre, cellHalfSize)) {
                        continue;
                    }
                    const cell = cells[linearIndex(x, y, z)]!;
                    cell.push(probeIndex);
                    if (cell.length > MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES) {
                        throw new Error(
                            `[babylon-lite] local probe voxel (${x}, ${y}, ${z}) intersects ${cell.length} probes, exceeding maxCandidates ${MAX_PBR_LOCAL_ENVIRONMENT_CANDIDATES}`
                        );
                    }
                }
            }
        }
    }

    for (let z = 0; z < dimensions[2]; z++) {
        for (let y = 0; y < dimensions[1]; y++) {
            for (let x = 0; x < dimensions[0]; x++) {
                const cell = cells[linearIndex(x, y, z)]!;
                if (cell.length) {
                    continue;
                }
                const centre = [minimum[0] + (x + 0.5) * options.cellSize, minimum[1] + (y + 0.5) * options.cellSize, minimum[2] + (z + 0.5) * options.cellSize];
                let nearestIndex = 0;
                let nearestNdf = Number.POSITIVE_INFINITY;
                for (let probeIndex = 0; probeIndex < probes.length; probeIndex++) {
                    const ndf = probeNdfAtPoint(probes[probeIndex]!, centre);
                    if (ndf < nearestNdf) {
                        nearestNdf = ndf;
                        nearestIndex = probeIndex;
                    }
                }
                cell.push(nearestIndex);
            }
        }
    }

    const data = new Uint32Array(dataLength);
    const floats = new Float32Array(data.buffer);
    floats.set(minimum, 0);
    floats[3] = 1 / options.cellSize;
    data.set([dimensions[0], dimensions[1], dimensions[2], stride], 4);
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
        const cell = cells[cellIndex]!;
        const base = GRID_HEADER_U32 + cellIndex * stride;
        data[base] = cell.length;
        data.set(cell, base + 1);
    }
    return { data, minimum, cellSize: options.cellSize, dimensions, stride };
}

/** Resolve the voxel and probe indices used by a world-space point. */
export function getPbrLocalEnvironmentProbeGridCell(set: PbrLocalEnvironmentProbeSet, position: readonly [number, number, number]): PbrLocalEnvironmentProbeGridCell {
    finiteVec3(position, "local probe grid query position");
    const coordinates: [number, number, number] = [0, 0, 0];
    let outside = false;
    for (let axis = 0; axis < 3; axis++) {
        const raw = Math.floor((position[axis]! - set._gridMinimum[axis]!) / set._gridCellSize);
        outside ||= raw < 0 || raw >= set._gridDimensions[axis]!;
        coordinates[axis] = Math.max(0, Math.min(set._gridDimensions[axis]! - 1, raw));
    }
    const cellIndex = (coordinates[2] * set._gridDimensions[1] + coordinates[1]) * set._gridDimensions[0] + coordinates[0];
    const base = GRID_HEADER_U32 + cellIndex * set._gridStride;
    const count = set._gridData[base]!;
    return {
        coordinates,
        probeIndices: Array.from(set._gridData.subarray(base + 1, base + 1 + count)),
        outside,
    };
}

interface ProbeTextureLayout {
    readonly targetSize: number;
    readonly format: GPUTextureFormat;
    readonly mipLevelCount: number;
    readonly sourceMipOffsets: readonly number[];
}

function measureProbeTextures(probes: readonly PbrLocalEnvironmentProbe[]): ProbeTextureLayout {
    const textures = probes.map((probe) => probe.environment.specularCube);
    const targetSize = Math.min(...textures.map((texture) => texture.width));
    const format = textures[0]!.format;
    const sourceMipOffsets = textures.map((texture) => {
        if ((texture.usage & TU.COPY_SRC) === 0) {
            throw new Error(
                "[babylon-lite] local probe cubemaps require COPY_SRC usage; call enablePbrLocalCubemap() before loading DDS or HDR probe environments, or create custom probe textures with COPY_SRC"
            );
        }
        if (texture.width !== texture.height || texture.depthOrArrayLayers !== 6 || texture.format !== format) {
            throw new Error("[babylon-lite] local probe cubemaps must be square six-face textures with one shared format");
        }
        return powerOfTwoRatio(texture.width, targetSize);
    });
    const mipLevelCount = Math.min(...textures.map((texture, index) => texture.mipLevelCount - sourceMipOffsets[index]!));
    if (mipLevelCount < 1) {
        throw new Error("[babylon-lite] local probe cubemaps have no common mip range");
    }
    return { targetSize, format, mipLevelCount, sourceMipOffsets };
}

function validateProbeSetDeviceLimits(device: GPUDevice, probeCount: number, gridByteLength: number): void {
    const maxTextureProbes = Math.floor(device.limits.maxTextureArrayLayers / 6);
    if (probeCount > maxTextureProbes) {
        throw new Error(`[babylon-lite] local probe set has ${probeCount} probes, but this device supports at most ${maxTextureProbes} cube-array probes`);
    }
    const uniformBytes = _PBR_LOCAL_ENVIRONMENT_UNIFORM_FLOATS * 4;
    if (device.limits.maxUniformBufferBindingSize < uniformBytes) {
        throw new Error(`[babylon-lite] local probe UBO requires ${uniformBytes} bytes, but this device supports ${device.limits.maxUniformBufferBindingSize}`);
    }
    if (gridByteLength > device.limits.maxStorageBufferBindingSize || gridByteLength > device.limits.maxBufferSize) {
        throw new Error(`[babylon-lite] local probe voxel grid requires ${gridByteLength} bytes, exceeding this device's storage-buffer limits`);
    }
}

function createProbeTexture(device: GPUDevice, probes: readonly PbrLocalEnvironmentProbe[], layout: ProbeTextureLayout): GPUTexture {
    const texture = device.createTexture({
        label: "pbr-local-probes",
        size: [layout.targetSize, layout.targetSize, probes.length * 6],
        format: layout.format,
        dimension: "2d",
        mipLevelCount: layout.mipLevelCount,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST,
    });
    try {
        const encoder = device.createCommandEncoder({ label: "pbr-local-probe-copy" });
        for (let probeIndex = 0; probeIndex < probes.length; probeIndex++) {
            const source = probes[probeIndex]!.environment.specularCube;
            const sourceMipOffset = layout.sourceMipOffsets[probeIndex]!;
            for (let mip = 0; mip < layout.mipLevelCount; mip++) {
                const size = Math.max(1, layout.targetSize >> mip);
                for (let face = 0; face < 6; face++) {
                    encoder.copyTextureToTexture(
                        { texture: source, mipLevel: mip + sourceMipOffset, origin: [0, 0, face] },
                        { texture, mipLevel: mip, origin: [0, 0, probeIndex * 6 + face] },
                        [size, size, 1]
                    );
                }
            }
        }
        device.queue.submit([encoder.finish()]);
        return texture;
    } catch (error) {
        texture.destroy();
        throw error;
    }
}

function ensureProbeSetDevice(set: PbrLocalEnvironmentProbeSet): void {
    const device = set._engine._device;
    if (set._device === device) {
        return;
    }
    const layout = measureProbeTextures(set.probes);
    validateProbeSetDeviceLimits(device, set.probes.length, set._gridData.byteLength);
    for (let index = 0; index < set.probes.length; index++) {
        writeProbe(set._uniformData, set._uniformU32, set.probes[index]!, index, layout.sourceMipOffsets[index]!);
    }

    let texture: GPUTexture | undefined;
    let textureView: GPUTextureView | undefined;
    let uniformBuffer: GPUBuffer | undefined;
    let gridBuffer: GPUBuffer | undefined;
    try {
        texture = createProbeTexture(device, set.probes, layout);
        textureView = texture.createView({ dimension: "cube-array", baseArrayLayer: 0, arrayLayerCount: set.probes.length * 6 });
        uniformBuffer = createUniformBuffer(set._engine, set._uniformData, "pbr-local-probes");
        gridBuffer = createMappedBuffer(set._engine, set._gridData, BU.STORAGE, "pbr-local-probe-grid");
    } catch (error) {
        texture?.destroy();
        uniformBuffer?.destroy();
        gridBuffer?.destroy();
        throw error;
    }

    const previousUniformBuffer = set._uniformBuffer;
    const previousGridBuffer = set._gridBuffer;
    const previousTexture = set._texture;
    set._uniformBuffer = uniformBuffer;
    set._gridBuffer = gridBuffer;
    set._texture = texture;
    set._textureView = textureView;
    set._sampler = getTrilinearSampler(set._engine);
    set._device = device;
    previousUniformBuffer?.destroy();
    previousGridBuffer?.destroy();
    previousTexture?.destroy();
}

/** Create a scene-owned local-probe texture array and shared uniform buffer. */
export function createPbrLocalEnvironmentProbeSet(scene: SceneContext, options: PbrLocalEnvironmentProbeSetOptions): PbrLocalEnvironmentProbeSet {
    const probes = options.probes.slice();
    if (!probes.length || probes.length > MAX_PBR_LOCAL_ENVIRONMENT_PROBES) {
        throw new Error(`[babylon-lite] local probe sets require 1..${MAX_PBR_LOCAL_ENVIRONMENT_PROBES} probes`);
    }
    probes.forEach(validateProbe);

    const engine = scene.surface.engine;
    const device = engine._device;
    const textureLayout = measureProbeTextures(probes);
    _initializePbrLocalCubemapLimits(undefined);
    const gridLayout = measureProbeGrid(options.voxelGrid);
    validateProbeSetDeviceLimits(device, probes.length, gridLayout.byteLength);
    const grid = buildProbeGrid(probes, options.voxelGrid, gridLayout);

    const uniformData = new Float32Array(_PBR_LOCAL_ENVIRONMENT_UNIFORM_FLOATS);
    const uniformU32 = new Uint32Array(uniformData.buffer);
    uniformU32[0] = probes.length;
    uniformU32[3] = options.parallaxCorrection === false ? 0 : _PBR_LOCAL_ENVIRONMENT_PARALLAX_FLAG;
    for (let index = 0; index < probes.length; index++) {
        writeProbe(uniformData, uniformU32, probes[index]!, index, textureLayout.sourceMipOffsets[index]!);
    }

    const set: PbrLocalEnvironmentProbeSet = {
        probes,
        _uniformBuffer: null as unknown as GPUBuffer,
        _uniformData: uniformData,
        _uniformU32: uniformU32,
        _texture: null as unknown as GPUTexture,
        _textureView: null as unknown as GPUTextureView,
        _sampler: null as unknown as GPUSampler,
        _gridBuffer: null as unknown as GPUBuffer,
        _gridData: grid.data,
        _gridMinimum: grid.minimum,
        _gridCellSize: grid.cellSize,
        _gridDimensions: grid.dimensions,
        _gridStride: grid.stride,
        _engine: engine,
        _device: null as unknown as GPUDevice,
        _ensureDevice: () => ensureProbeSetDevice(set),
    };
    set._ensureDevice();
    scene._disposables.push(() => {
        set._uniformBuffer.destroy();
        set._gridBuffer.destroy();
        set._texture.destroy();
    });
    return set;
}

/** Replace local-probe PBR output with the probes' per-fragment blended debug colors. */
export function setPbrLocalEnvironmentProbeDebug(set: PbrLocalEnvironmentProbeSet, enabled: boolean): void {
    const previous = set._uniformU32[3]!;
    const next = enabled ? previous | _PBR_LOCAL_ENVIRONMENT_DEBUG_COLOR_FLAG : previous & ~_PBR_LOCAL_ENVIRONMENT_DEBUG_COLOR_FLAG;
    if (next === previous) {
        return;
    }
    set._uniformU32[3] = next;
    set._ensureDevice();
    const byteOffset = 3 * Uint32Array.BYTES_PER_ELEMENT;
    set._device.queue.writeBuffer(set._uniformBuffer, byteOffset, set._uniformData.buffer, set._uniformData.byteOffset + byteOffset, Uint32Array.BYTES_PER_ELEMENT);
}

let _enabled: Promise<void> | null = null;

/** Enable bounded single-probe projection and initialize fragment-weighted probe arrays.
 * Call before loading any DDS or HDR environment that will be used as a probe. */
export function enablePbrLocalCubemap(options: PbrLocalCubemapInitOptions = {}): Promise<void> {
    _initializePbrLocalCubemapLimits(options.maxCandidates);
    _enableDdsEnvironmentCopySource();
    _enableHdrEnvironmentCopySource();
    return (_enabled ??= Promise.all([import("./fragments/local-cubemap-fragment.js"), import("./fragments/ibl-fragment.js")]).then(([local, ibl]) => {
        _installPbrExtensionIblResolver(local._isPbrLocalCubemapIblVariant);
        _installPbrIblFallbackResolver(local._getPbrLocalCubemapIblFallback);
        local.registerPbrLocalCubemapExt(_registerPbrExt);
        _registerPbrExt(ibl.pbrExt);
    }));
}
