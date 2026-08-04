import type { Mesh } from "./mesh.js";
import { release } from "../resource/ref-count.js";
import { _detachThinInstanceLodMesh } from "./thin-instance.js";

/** Destroy all GPU resources owned by a mesh (vertex buffers, skeleton, morph targets).
 *  `_gpu` may be shared across glTF nodes or mesh clones; skeleton/morph/thin-instance
 *  resources may also be shared by clones. Each resource is destroyed only after its
 *  last owning mesh releases it (see resource/ref-count.ts).
 *
 *  Every claim this mesh held is released here, exactly once, so the mesh is retired for good:
 *  it is marked `_disposed`, repeat calls are no-ops, and `addToScene` rejects it from then on
 *  (see `scene/mesh-scene-registry.ts`). That keeps the failure loud instead of silently drawing
 *  with destroyed handles, and keeps the ref-counts honest — a second release from the same mesh
 *  would free buffers a surviving sibling still renders with. Create a new mesh instead. */
export function disposeMeshGpu(mesh: Mesh): void {
    if (mesh._disposed) {
        return;
    }
    mesh._disposed = true;
    const g = mesh._gpu;
    if (release(g)) {
        g.positionBuffer.destroy();
        g.normalBuffer.destroy();
        g.uvBuffer.destroy();
        g.indexBuffer.destroy();
        g.tangentBuffer?.destroy();
        g.uv2Buffer?.destroy();
        g.colorBuffer?.destroy();
    }
    const ti = mesh.thinInstances;
    if (ti && release(ti)) {
        _detachThinInstanceLodMesh(mesh);
        ti._gpuBuffer?.destroy();
        ti._colorGpuBuffer?.destroy();
        ti._drawArgsBuffer?.destroy();
    }
    const sk = mesh.skeleton;
    if (sk && release(sk)) {
        sk.boneTexture.destroy();
        if (release(sk._skinBuffers)) {
            sk.jointsBuffer.destroy();
            sk.weightsBuffer.destroy();
            sk.joints1Buffer?.destroy();
            sk.weights1Buffer?.destroy();
        }
    }
    const vat = mesh.vat;
    if (vat && release(vat)) {
        vat.settingsBuffer.destroy();
        vat.instanceTexture?.destroy();
        if (release(vat._textureResource)) {
            vat._textureResource.texture.destroy();
        }
        if (release(vat._skinBuffers)) {
            vat.jointsBuffer.destroy();
            vat.weightsBuffer.destroy();
            vat.joints1Buffer?.destroy();
            vat.weights1Buffer?.destroy();
        }
    }
    const mt = mesh.morphTargets;
    if (mt && release(mt)) {
        mt.deltasBuffer.destroy();
        mt.weightsBuffer.destroy();
    }
}
