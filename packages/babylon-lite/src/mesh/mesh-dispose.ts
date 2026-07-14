import type { Mesh } from "./mesh.js";
import { release } from "../resource/ref-count.js";

/** Destroy all GPU resources owned by a mesh (vertex buffers, skeleton, morph targets).
 *  `_gpu`/`skeleton`/`morphTargets`/`thinInstances` may be SHARED with a clone made via
 *  `cloneTransformNode` (see resource/ref-count.ts) — each resource is only actually
 *  destroyed once its last owning mesh releases it, so a clone's still-in-use buffers
 *  are never freed out from under it (and never double-freed once both are disposed). */
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
