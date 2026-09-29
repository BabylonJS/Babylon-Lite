import type { GltfFeature } from "./gltf-feature.js";
import { _registerEnabledGltfFeature } from "./gltf-feature-hooks.js";

const feature: GltfFeature = {
    id: "_cpu_tangents",
    applyMesh(meshData, mesh) {
        mesh._cpuTangents = meshData._tangents;
        return Promise.resolve();
    },
};

let enabled = false;

/** Retain authored glTF tangents on the CPU for subsequent `getMeshGeometry` calls. */
export function enableGltfCpuTangents(): void {
    if (!enabled) {
        enabled = true;
        _registerEnabledGltfFeature((json) => json.meshes?.some((mesh: any) => mesh.primitives?.some((primitive: any) => primitive.attributes?.TANGENT !== undefined)), feature);
    }
}

export default feature;
