import type { Mesh } from "./mesh.js";
import { release, retain } from "../resource/ref-count.js";
import { _detachThinInstanceLodMesh } from "./thin-instance.js";

/** The shared, ref-counted GPU resources a mesh can co-own with a clone or a sibling glTF node.
 *  `retainMeshGpu` and `disposeMeshGpu` must walk exactly the same set, and only the OUTER objects:
 *  nested resources (`_skinBuffers`, `_textureResource`) are released only when their owner's own
 *  release reports the last claim, so they must not be retained independently. */
function sharedResources(mesh: Mesh): (object | null | undefined)[] {
    return [mesh._gpu, mesh.skeleton, mesh.vat, mesh.morphTargets, mesh.thinInstances];
}

/** @internal Register one more owner of a mesh's shared GPU resources.
 *  Used when a clone is created, and when a mesh that had already released its claim is added back
 *  to a scene — a mesh that is registered in any scene must always hold a claim, or a sibling's
 *  removal would see itself as the last owner and destroy buffers this mesh still renders with. */
export function retainMeshGpu(mesh: Mesh): void {
    for (const resource of sharedResources(mesh)) {
        if (resource) {
            retain(resource);
        }
    }
}

/** Destroy all GPU resources owned by a mesh (vertex buffers, skeleton, morph targets).
 *  `_gpu` may be shared across glTF nodes or mesh clones; skeleton/morph/thin-instance
 *  resources may also be shared by clones. Each resource is destroyed only after its
 *  last owning mesh releases it (see resource/ref-count.ts). */
export function disposeMeshGpu(mesh: Mesh): void {
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
