import type { Mesh, MeshGPU } from "../mesh/mesh.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { retain } from "../resource/ref-count.js";
import type { GltfFeature, GltfLoadCtx } from "./gltf-feature.js";
import type { GltfMaterialData } from "./gltf-material.js";
import type { GltfMeshData } from "./load-gltf.js";

/** Upload nodes that reference the same glTF primitive with one shared geometry.
 *  This module is imported only for assets that actually repeat a mesh index. */
export async function share(
    meshDatas: GltfMeshData[],
    buildMaterial: (material: GltfMaterialData) => Promise<PbrMaterialProps>,
    buildTightMesh: (engine: GltfLoadCtx["_engine"], meshData: GltfMeshData, material: PbrMaterialProps, name: string, source?: Mesh) => Mesh,
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
        const meshName = json.meshes[json.nodes[m._nodeIndex].mesh].name || `gltf_mesh_${i}`;
        const active = activeNodes.has(m._nodeIndex);
        const source = active ? geometryCache.get(m._primitive) : undefined;
        const mesh = m._vb ? interleave!.buildInterleavedMesh(engine, m, i, material, meshName, source) : buildTightMesh(engine, m, material, meshName, source);

        if (source) {
            _installSharedRecovery(source._gpu);
            retain(mesh._gpu);
        } else if (active) {
            geometryCache.set(m._primitive, mesh);
        }
        return mesh;
    });

    if (meshFeatures.length > 0) {
        await Promise.all(meshes.flatMap((mesh, i) => meshFeatures.map((feature) => feature.applyMesh!(meshDatas[i]!, mesh, ctx))));
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
