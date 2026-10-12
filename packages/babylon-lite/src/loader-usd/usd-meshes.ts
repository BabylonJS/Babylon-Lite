import { initMeshTransform } from "../mesh/mesh.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { computeAabb } from "../math/compute-aabb.js";
import { retain } from "../resource/ref-count.js";
import type { UsdContext, UsdDraw } from "./usd-context.js";
import type { UsdGeometry } from "./usd-geometry.js";
import { uploadUsdGeometry } from "./usd-geometry.js";
import { usdParent } from "./usd-nodes.js";

/** @internal Create one draw without scene registration; shared sources retain GPU geometry. */
export function createUsdDraw(context: UsdContext, geometry: UsdGeometry, material: PbrMaterialProps, name: string, nodeId: number, skeletonId: number, source?: UsdDraw): UsdDraw {
    const parent = context.nodes.get(nodeId);
    if (!parent) {
        throw new Error(`Missing USD mesh node ${nodeId}`);
    }
    const gpu = source ? source.mesh._gpu : uploadUsdGeometry(context.engine, geometry);
    if (source) {
        retain(gpu);
    }
    const [boundMin, boundMax] = source ? [source.mesh.boundMin, source.mesh.boundMax] : computeAabb(geometry.positions);
    const mesh = initMeshTransform({
        name,
        material,
        _gpu: gpu,
        receiveShadows: false,
        boundMin,
        boundMax,
        _authoredSign: -1,
        _cpuPositions: geometry.positions,
        _cpuNormals: geometry.normals,
        _cpuIndices: geometry.indices,
        _cpuUvs: geometry.uvs,
        _cpuTangents: geometry.tangents,
        _cpuColors: geometry.colors,
    });
    if (source?.mesh.skeleton) {
        retain(source.mesh.skeleton);
        mesh.skeleton = source.mesh.skeleton;
    }
    if (source?.mesh.morphTargets) {
        retain(source.mesh.morphTargets);
        mesh.morphTargets = source.mesh.morphTargets;
    }
    context.container._usdMeshes.push(mesh);
    usdParent(mesh, parent);
    const draw = { mesh, geometry, skeletonId };
    context.draws.push(draw);
    return draw;
}
