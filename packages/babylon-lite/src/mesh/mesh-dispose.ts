import type { Mesh, MeshInternal } from "./mesh.js";

/** Destroy all GPU resources owned by a mesh (vertex buffers, skeleton, morph targets). */
export function disposeMeshGpu(mesh: Mesh): void {
    const g = (mesh as MeshInternal)._gpu;
    g.positionBuffer.destroy();
    g.normalBuffer.destroy();
    g.uvBuffer.destroy();
    g.indexBuffer.destroy();
    g.tangentBuffer?.destroy();
    g.uv2Buffer?.destroy();
    const sk = mesh.skeleton;
    if (sk) {
        sk.boneTexture.destroy();
        sk.jointsBuffer.destroy();
        sk.weightsBuffer.destroy();
        sk.joints1Buffer?.destroy();
        sk.weights1Buffer?.destroy();
    }
    if (mesh.morphTargets) {
        mesh.morphTargets.texture.destroy();
        mesh.morphTargets.weightsBuffer.destroy();
    }
}
