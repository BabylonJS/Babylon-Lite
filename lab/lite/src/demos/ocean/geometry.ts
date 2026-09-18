import {
    addToScene,
    cloneTransformNode,
    createMeshFromData,
    markMeshRenderableDirty,
    resizeMeshGeometry,
    resizeSharedMeshGeometry,
    setMeshVisible,
    type Camera,
    type EngineContext,
    type Mesh,
    type SceneContext,
} from "babylon-lite";
import type { OceanMaterials } from "./material.js";

const SEAM_BOTTOM = 1;
const SEAM_TOP = 2;
const SEAM_LEFT = 4;
const SEAM_RIGHT = 8;
const TRIM_ANGLES: readonly number[] = [Math.PI, Math.PI / 2, (3 * Math.PI) / 2, 0];
const MAX_CLIP_LEVELS = 8;

export interface OceanGeometryData {
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly uvs: Float32Array;
    readonly indices: Uint32Array;
}

interface GeometryPart {
    readonly geometry: OceanGeometryData;
    readonly x?: number;
    readonly z?: number;
    readonly scaleX?: number;
    readonly scaleZ?: number;
}

export interface OceanClipmap {
    readonly meshes: readonly Mesh[];
    readonly center: Mesh;
    readonly rings: readonly Mesh[];
    readonly trims: readonly Mesh[];
    readonly skirt: Mesh;
    setGeometryParameter(name: "lengthScale" | "vertexDensity" | "clipLevels" | "skirtSize", value: number): void;
    setWireframe(enabled: boolean): void;
    setNoMaterialLod(enabled: boolean): void;
    update(camera: Camera): void;
}

export function createOceanPlaneGeometry(width: number, height: number, scale: number, seams = 0, triangleShift = 0): OceanGeometryData {
    const columns = width + 1;
    const positions = new Float32Array(columns * (height + 1) * 3);
    const normals = new Float32Array(positions.length);
    const uvs = new Float32Array(columns * (height + 1) * 2);
    for (let z = 0; z <= height; z++) {
        for (let x = 0; x <= width; x++) {
            let px = x;
            let pz = z;
            if ((z === 0 && (seams & SEAM_BOTTOM) !== 0) || (z === height && (seams & SEAM_TOP) !== 0)) {
                px &= ~1;
            }
            if ((x === 0 && (seams & SEAM_LEFT) !== 0) || (x === width && (seams & SEAM_RIGHT) !== 0)) {
                pz &= ~1;
            }
            const vertex = z * columns + x;
            positions[vertex * 3] = px * scale;
            positions[vertex * 3 + 2] = pz * scale;
            normals[vertex * 3 + 1] = 1;
            uvs[vertex * 2] = x / Math.max(width, 1);
            uvs[vertex * 2 + 1] = z / Math.max(height, 1);
        }
    }
    const indices = new Uint32Array(width * height * 6);
    let out = 0;
    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            const a = z * columns + x;
            const b = a + 1;
            const c = a + columns;
            const d = c + 1;
            if (((x + z + triangleShift) & 1) === 0) {
                indices[out++] = a;
                indices[out++] = d;
                indices[out++] = c;
                indices[out++] = a;
                indices[out++] = b;
                indices[out++] = d;
            } else {
                indices[out++] = a;
                indices[out++] = b;
                indices[out++] = c;
                indices[out++] = b;
                indices[out++] = d;
                indices[out++] = c;
            }
        }
    }
    return { positions, normals, uvs, indices };
}

function merge(parts: readonly GeometryPart[]): OceanGeometryData {
    let vertexCount = 0;
    let indexCount = 0;
    for (const part of parts) {
        vertexCount += part.geometry.positions.length / 3;
        indexCount += part.geometry.indices.length;
    }
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = new Uint32Array(indexCount);
    let vertexOffset = 0;
    let indexOffset = 0;
    for (const part of parts) {
        const source = part.geometry;
        const scaleX = part.scaleX ?? 1;
        const scaleZ = part.scaleZ ?? 1;
        const x = part.x ?? 0;
        const z = part.z ?? 0;
        for (let i = 0; i < source.positions.length / 3; i++) {
            positions[(vertexOffset + i) * 3] = source.positions[i * 3]! * scaleX + x;
            positions[(vertexOffset + i) * 3 + 1] = source.positions[i * 3 + 1]!;
            positions[(vertexOffset + i) * 3 + 2] = source.positions[i * 3 + 2]! * scaleZ + z;
            normals[(vertexOffset + i) * 3] = source.normals[i * 3]!;
            normals[(vertexOffset + i) * 3 + 1] = source.normals[i * 3 + 1]!;
            normals[(vertexOffset + i) * 3 + 2] = source.normals[i * 3 + 2]!;
            uvs[(vertexOffset + i) * 2] = source.uvs[i * 2]!;
            uvs[(vertexOffset + i) * 2 + 1] = source.uvs[i * 2 + 1]!;
        }
        for (let i = 0; i < source.indices.length; i++) {
            indices[indexOffset + i] = source.indices[i]! + vertexOffset;
        }
        vertexOffset += source.positions.length / 3;
        indexOffset += source.indices.length;
    }
    return { positions, normals, uvs, indices };
}

function ring(k: number): OceanGeometryData {
    return merge([
        { geometry: createOceanPlaneGeometry(2 * k, (k - 1) >> 1, 1, SEAM_BOTTOM | SEAM_RIGHT | SEAM_LEFT) },
        { geometry: createOceanPlaneGeometry(2 * k, (k - 1) >> 1, 1, SEAM_TOP | SEAM_RIGHT | SEAM_LEFT), z: k + 1 + ((k - 1) >> 1) },
        { geometry: createOceanPlaneGeometry((k - 1) >> 1, k + 1, 1, SEAM_LEFT), z: (k - 1) >> 1 },
        { geometry: createOceanPlaneGeometry((k - 1) >> 1, k + 1, 1, SEAM_RIGHT), x: k + 1 + ((k - 1) >> 1), z: (k - 1) >> 1 },
    ]);
}

function trim(k: number): OceanGeometryData {
    return merge([
        { geometry: createOceanPlaneGeometry(k + 1, 1, 1, 0, 1), x: -k - 1, z: -1 },
        { geometry: createOceanPlaneGeometry(1, k, 1, 0, 1), x: -1, z: -k - 1 },
    ]);
}

function skirt(k: number, border: number): OceanGeometryData {
    const quad = createOceanPlaneGeometry(1, 1, 1);
    const horizontal = createOceanPlaneGeometry(k, 1, 1);
    const vertical = createOceanPlaneGeometry(1, k, 1);
    return merge([
        { geometry: quad, scaleX: border, scaleZ: border },
        { geometry: horizontal, x: border, scaleX: 1 / k, scaleZ: border },
        { geometry: quad, x: border + 1, scaleX: border, scaleZ: border },
        { geometry: vertical, z: border, scaleX: border, scaleZ: 1 / k },
        { geometry: vertical, x: border + 1, z: border, scaleX: border, scaleZ: 1 / k },
        { geometry: quad, z: border + 1, scaleX: border, scaleZ: border },
        { geometry: horizontal, x: border, z: border + 1, scaleX: 1 / k, scaleZ: border },
        { geometry: quad, x: border + 1, z: border + 1, scaleX: border, scaleZ: border },
    ]);
}

function createMesh(engine: EngineContext, name: string, geometry: OceanGeometryData): Mesh {
    return createMeshFromData(engine, name, geometry.positions, geometry.normals, geometry.indices, geometry.uvs);
}

function configureMesh(mesh: Mesh, material: Mesh["material"], useWireframe: boolean): void {
    mesh.material = material;
    mesh.receiveShadows = true;
    setWireframeTopology(mesh, useWireframe);
}

function setWireframeTopology(mesh: Mesh, enabled: boolean): void {
    const primitiveMesh = mesh as Mesh & { _primitive?: GPUPrimitiveState; _primitiveFeatures?: number };
    mesh._topology = enabled ? 2 : undefined;
    primitiveMesh._primitive = enabled ? { topology: "line-list", cullMode: "none" } : undefined;
    primitiveMesh._primitiveFeatures = enabled ? 2 << 12 : undefined;
}

function wireframe(geometry: OceanGeometryData): OceanGeometryData {
    const triangles = geometry.indices;
    const indices = new Uint32Array((triangles.length / 3) * 6);
    let output = 0;
    for (let i = 0; i < triangles.length; i += 3) {
        const a = triangles[i]!;
        const b = triangles[i + 1]!;
        const c = triangles[i + 2]!;
        indices[output++] = a;
        indices[output++] = b;
        indices[output++] = b;
        indices[output++] = c;
        indices[output++] = c;
        indices[output++] = a;
    }
    return { ...geometry, indices };
}

function geometricProgressionSum(first: number, ratio: number, from: number, to: number): number {
    return (first / (1 - ratio)) * (Math.pow(ratio, to) - Math.pow(ratio, from));
}

function snap(value: number, scale: number, positiveFloor: boolean): number {
    if (positiveFloor ? value >= 0 : value < 0) {
        return Math.floor(value / scale) * scale;
    }
    return Math.ceil((value - scale + 1) / scale) * scale;
}

function chooseMaterial(materials: OceanMaterials, lodLevel: number): Mesh["material"] {
    if (lodLevel <= 2) {
        return materials.close;
    }
    if (lodLevel <= 4) {
        return materials.mid;
    }
    return materials.far;
}

function clipmapCenterOffset(k: number, clipLevels: number, activeLevels: number, level: number, lengthScale: number): number {
    return -(((1 << clipLevels) + geometricProgressionSum(2, 2, clipLevels - activeLevels + level + 1, clipLevels - 1)) * lengthScale * (k - 1)) / k / 2;
}

export function createOceanClipmap(
    engine: EngineContext,
    scene: SceneContext,
    materials: OceanMaterials,
    options: {
        readonly lengthScale?: number;
        readonly vertexDensity?: number;
        readonly clipLevels?: number;
        readonly skirtSize?: number;
        readonly wireframe?: boolean;
        readonly noMaterialLod?: boolean;
    } = {}
): OceanClipmap {
    let lengthScale = options.lengthScale ?? 15;
    let vertexDensity = options.vertexDensity ?? 30;
    let clipLevels = options.clipLevels ?? 8;
    let skirtSize = options.skirtSize ?? 10;
    let useWireframe = options.wireframe === true;
    let noMaterialLod = options.noMaterialLod ?? true;
    let k = 4 * vertexDensity + 1;
    let transformRevision = 0;
    let appliedTransformRevision = -1;
    let lastCameraX = Number.NaN;
    let lastCameraY = Number.NaN;
    let lastCameraZ = Number.NaN;
    const topology = (geometry: OceanGeometryData): OceanGeometryData => (useWireframe ? wireframe(geometry) : geometry);
    const center = createMesh(engine, "ocean-center", topology(createOceanPlaneGeometry(2 * k, 2 * k, 1, SEAM_BOTTOM | SEAM_TOP | SEAM_LEFT | SEAM_RIGHT)));
    const ringGeometry = topology(ring(k));
    const trimGeometry = topology(trim(k));
    const rings: Mesh[] = [];
    const trims: Mesh[] = [];
    configureMesh(center, materials.close, useWireframe);
    addToScene(scene, center);
    const ringBase = createMesh(engine, "ocean-ring-0", ringGeometry);
    const trimBase = createMesh(engine, "ocean-trim-0", trimGeometry);
    for (let i = 0; i < MAX_CLIP_LEVELS; i++) {
        const ringMesh = i === 0 ? ringBase : (cloneTransformNode(ringBase) as Mesh);
        const trimMesh = i === 0 ? trimBase : (cloneTransformNode(trimBase) as Mesh);
        ringMesh.name = `ocean-ring-${i}`;
        trimMesh.name = `ocean-trim-${i}`;
        configureMesh(ringMesh, materials.close, useWireframe);
        configureMesh(trimMesh, materials.close, useWireframe);
        rings.push(ringMesh);
        trims.push(trimMesh);
        addToScene(scene, ringMesh);
        addToScene(scene, trimMesh);
    }
    const skirtMesh = createMesh(engine, "ocean-skirt", topology(skirt(k, skirtSize)));
    configureMesh(skirtMesh, materials.far, useWireframe);
    addToScene(scene, skirtMesh);
    const meshes = [center, ...rings, ...trims, skirtMesh];

    const resize = (mesh: Mesh, geometry: OceanGeometryData): void => {
        resizeMeshGeometry(engine, mesh, geometry.positions, geometry.normals, geometry.indices, geometry.uvs);
        setWireframeTopology(mesh, useWireframe);
        markMeshRenderableDirty(mesh);
    };
    const resizeFamily = (family: readonly Mesh[], geometry: OceanGeometryData): void => {
        resizeSharedMeshGeometry(engine, family, geometry.positions, geometry.normals, geometry.indices, geometry.uvs);
        for (const mesh of family) {
            setWireframeTopology(mesh, useWireframe);
            markMeshRenderableDirty(mesh);
        }
    };

    const rebuildGeometry = (): void => {
        k = 4 * vertexDensity + 1;
        resize(center, topology(createOceanPlaneGeometry(2 * k, 2 * k, 1, SEAM_BOTTOM | SEAM_TOP | SEAM_LEFT | SEAM_RIGHT)));
        const nextRing = topology(ring(k));
        const nextTrim = topology(trim(k));
        resizeFamily(rings, nextRing);
        resizeFamily(trims, nextTrim);
        resize(skirtMesh, topology(skirt(k, skirtSize)));
        transformRevision++;
    };

    return {
        meshes,
        center,
        rings,
        trims,
        skirt: skirtMesh,
        setGeometryParameter(name, value): void {
            if (name === "lengthScale") {
                if (lengthScale !== value) {
                    lengthScale = value;
                    transformRevision++;
                }
            } else if (name === "clipLevels") {
                const next = Math.min(MAX_CLIP_LEVELS, Math.max(1, Math.round(value)));
                if (clipLevels !== next) {
                    clipLevels = next;
                    transformRevision++;
                }
            } else if (name === "vertexDensity") {
                const next = Math.min(40, Math.max(1, Math.round(value)));
                if (vertexDensity !== next) {
                    vertexDensity = next;
                    rebuildGeometry();
                }
            } else if (skirtSize !== value) {
                skirtSize = value;
                resize(skirtMesh, topology(skirt(k, skirtSize)));
                transformRevision++;
            }
        },
        setWireframe(enabled): void {
            if (useWireframe !== enabled) {
                useWireframe = enabled;
                rebuildGeometry();
            }
        },
        setNoMaterialLod(enabled): void {
            if (noMaterialLod !== enabled) {
                noMaterialLod = enabled;
                transformRevision++;
            }
        },
        update(camera: Camera): void {
            const cameraWorld = camera.worldMatrix;
            const cameraX = cameraWorld[12]!;
            const cameraY = cameraWorld[13]!;
            const cameraZ = cameraWorld[14]!;
            if (appliedTransformRevision === transformRevision && lastCameraX === cameraX && lastCameraY === cameraY && lastCameraZ === cameraZ) {
                return;
            }
            const activeLevels = clipLevels - Math.min(clipLevels, Math.max(0, Math.floor(Math.log2((1.7 * Math.abs(cameraY) + 1) / lengthScale))));
            const centerLevel = clipLevels - activeLevels - 1;
            center.material = noMaterialLod ? materials.close : chooseMaterial(materials, centerLevel);
            let scale = (lengthScale / k) * Math.pow(2, clipLevels - activeLevels);
            let previousX = snap(cameraX, scale * 2, true);
            let previousZ = snap(cameraZ, scale * 2, false);
            let offset = clipmapCenterOffset(k, clipLevels, activeLevels, -1, lengthScale);
            center.position.set(previousX + offset, 0, previousZ + offset);
            center.scaling.set(scale, 1, scale);

            for (let i = 0; i < rings.length; i++) {
                const visible = i < clipLevels && i < activeLevels;
                setMeshVisible(rings[i]!, visible);
                setMeshVisible(trims[i]!, visible);
                if (!visible) {
                    continue;
                }
                scale = (lengthScale / k) * Math.pow(2, clipLevels - activeLevels + i + 1);
                const snappedX = snap(cameraX, scale * 2, true);
                const snappedZ = snap(cameraZ, scale * 2, false);
                offset = clipmapCenterOffset(k, clipLevels, activeLevels, i, lengthScale);
                const shiftX = previousX - snappedX <= 0 ? 1 : 0;
                const shiftZ = previousZ - snappedZ <= 0 ? 1 : 0;
                trims[i]!.position.set(
                    snappedX + offset + scale * (k - 1) * 0.5 + shiftX * (k + 1) * scale,
                    0,
                    snappedZ + offset + scale * (k - 1) * 0.5 + shiftZ * (k + 1) * scale
                );
                trims[i]!.rotation.set(0, TRIM_ANGLES[shiftX + 2 * shiftZ]!, 0);
                trims[i]!.scaling.set(scale, 1, scale);
                rings[i]!.position.set(snappedX + offset, 0, snappedZ + offset);
                rings[i]!.scaling.set(scale, 1, scale);
                const lod = clipLevels - activeLevels - i;
                rings[i]!.material = noMaterialLod ? materials.close : chooseMaterial(materials, lod);
                trims[i]!.material = noMaterialLod ? materials.close : chooseMaterial(materials, lod);
                previousX = snappedX;
                previousZ = snappedZ;
            }
            scale = lengthScale * 2 * Math.pow(2, clipLevels);
            skirtMesh.material = noMaterialLod ? materials.close : materials.far;
            skirtMesh.position.set(previousX - scale * (skirtSize + 0.5 - 0.5 / k), 0, previousZ - scale * (skirtSize + 0.5 - 0.5 / k));
            skirtMesh.scaling.set(scale, 1, scale);
            appliedTransformRevision = transformRevision;
            lastCameraX = cameraX;
            lastCameraY = cameraY;
            lastCameraZ = cameraZ;
        },
    };
}
