import { BU } from "../engine/gpu-flags.js";
import { U32 } from "../engine/typed-arrays.js";
import { computeAabb } from "../math/compute-aabb.js";
import type { Mesh, MeshGPU } from "../mesh/mesh.js";
import { initMeshTransform } from "../mesh/mesh.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { createMappedBuffer } from "../resource/gpu-buffers.js";
import { retain } from "../resource/ref-count.js";
import type { GltfFeature, GltfLoadCtx } from "./gltf-feature.js";
import type { GltfMaterialData } from "./gltf-material.js";
import type { GltfMeshData } from "./load-gltf.js";

/** Upload nodes that reference the same glTF primitive with one shared geometry.
 *  This module is imported only for assets that actually repeat a mesh index. */
export async function share(
    meshDatas: GltfMeshData[],
    buildMaterial: (material: GltfMaterialData) => Promise<PbrMaterialProps>,
    meshFeatures: GltfFeature[],
    ctx: GltfLoadCtx
): Promise<Mesh[]> {
    const { _engine: engine, _json: json } = ctx;
    const activeNodes = getActiveNodes(json);
    shareCpuGeometry(meshDatas, activeNodes);
    const materials = await Promise.all(meshDatas.map((m) => buildMaterial(m._material)));
    const interleave = meshDatas.some((m) => m._vb) ? await import("./gltf-interleave.js") : undefined;
    const geometryCache = new Map<unknown, Mesh>();

    // Keep lookup + insertion synchronous so two owners can never both upload.
    const meshes = meshDatas.map((m, i): Mesh => {
        const material = materials[i]!;
        const meshName = json.meshes[json.nodes[m._nodeIndex].mesh].name;
        const active = activeNodes.has(m._nodeIndex);
        const source = active ? geometryCache.get(m._primitive) : undefined;
        let mesh: Mesh;

        if (m._vb) {
            if (source) {
                const [boundMin, boundMax] = m._vb._p ? interleave!.computeAabbStrided(m._vb._p, m._worldMatrix) : computeAabb(m._positions!, m._worldMatrix);
                mesh = {
                    name: meshName || `gltf_mesh_${i}`,
                    material,
                    receiveShadows: false,
                    boundMin,
                    boundMax,
                    _gpu: source._gpu,
                    _flatNormal: m._flatNormal,
                } as unknown as Mesh;
                initMeshTransform(mesh);
                interleave!.installLazyCpu(mesh, m);
                mesh._cpuIndices = source._cpuIndices;
                engine._dlr?.m(mesh, m._uv2s, m._tangents, m._colors, m._indices, source._gpu.indexFormat);
            } else {
                mesh = interleave!.buildInterleavedMesh(engine, m, i, material, meshName);
            }
        } else {
            const [boundMin, boundMax] = computeAabb(m._positions!, m._worldMatrix);
            const gpu: MeshGPU =
                source?._gpu ??
                ({
                    positionBuffer: createMappedBuffer(engine, m._positions!, BU.VERTEX),
                    normalBuffer: createMappedBuffer(engine, m._normals!, BU.VERTEX),
                    tangentBuffer: m._tangents ? createMappedBuffer(engine, m._tangents, BU.VERTEX) : null,
                    uvBuffer: createMappedBuffer(engine, m._uvs!, BU.VERTEX),
                    uv2Buffer: m._uv2s ? createMappedBuffer(engine, m._uv2s, BU.VERTEX) : null,
                    colorBuffer: m._colors ? createMappedBuffer(engine, m._colors, BU.VERTEX) : null,
                    indexBuffer: createMappedBuffer(engine, m._indices, BU.INDEX),
                    indexCount: m._indexCount,
                    indexFormat: (m._indices instanceof U32 ? "uint32" : "uint16") as GPUIndexFormat,
                } satisfies MeshGPU);

            mesh = {
                name: meshName || `gltf_mesh_${i}`,
                material,
                receiveShadows: false,
                boundMin,
                boundMax,
                _gpu: gpu,
                _flatNormal: m._flatNormal,
            } as unknown as Mesh;
            initMeshTransform(mesh);
            mesh._cpuPositions = m._positions!;
            mesh._cpuNormals = m._normals!;
            mesh._cpuUvs = m._uvs!;
            mesh._cpuIndices = source?._cpuIndices ?? (m._indices instanceof U32 ? m._indices : new U32(m._indices));
            engine._dlr?.m(mesh, m._uv2s, m._tangents, m._colors, m._indices, gpu.indexFormat);
        }

        if (source) {
            _installSharedRecovery(source._gpu);
            retain(mesh._gpu);
        } else if (active) {
            geometryCache.set(m._primitive, mesh);
        }
        return mesh;
    });

    if (meshFeatures.length > 0) {
        await Promise.all(meshes.flatMap((mesh, i) => meshFeatures.map((f) => f.applyMesh!(meshDatas[i]!, mesh, ctx))));
    }
    return meshes;
}

/** @internal Preserve glTF geometry sharing across replacement GPU devices. */
export function _installSharedRecovery(gpu: MeshGPU): void {
    if (gpu._recoverShared) {
        return;
    }
    let device: GPUDevice | undefined;
    let rebuilt: MeshGPU | undefined;
    let owners: WeakSet<Mesh> | undefined;
    const recover: NonNullable<MeshGPU["_recoverShared"]> = (engine, mesh, upload) => {
        if (device === engine._device) {
            if (!owners!.has(mesh)) {
                owners!.add(mesh);
                retain(rebuilt!);
            }
            return rebuilt!;
        }
        const next = upload(engine, mesh);
        device = engine._device;
        rebuilt = next;
        owners = new WeakSet([mesh]);
        next._recoverShared = recover;
        return next;
    };
    gpu._recoverShared = recover;
}

function shareCpuGeometry(meshDatas: GltfMeshData[], activeNodes: Set<number>): void {
    const cache = new Map<unknown, GltfMeshData>();
    for (const meshData of meshDatas) {
        if (!activeNodes.has(meshData._nodeIndex)) {
            continue;
        }
        const source = cache.get(meshData._primitive);
        if (!source) {
            cache.set(meshData._primitive, meshData);
            continue;
        }
        const worldMatrix = meshData._worldMatrix;
        const nodeIndex = meshData._nodeIndex;
        const material = meshData._material;
        Object.assign(meshData, source);
        meshData._worldMatrix = worldMatrix;
        meshData._nodeIndex = nodeIndex;
        meshData._material = material;
    }
}

function getActiveNodes(json: any): Set<number> {
    const active = new Set<number>();
    const pending: number[] = [...(json.scenes?.[json.scene ?? 0]?.nodes ?? [])];
    while (pending.length > 0) {
        const nodeIndex = pending.pop()!;
        if (!active.has(nodeIndex)) {
            active.add(nodeIndex);
            pending.push(...(json.nodes[nodeIndex]?.children ?? []));
        }
    }
    return active;
}
