import type { Mesh, MeshGPU } from "./mesh.js";
import { retain } from "../resource/ref-count.js";

/** @internal Preserve one shared geometry allocation across replacement devices. */
export function installSharedMeshRecovery(gpu: MeshGPU): void {
    if (gpu._recoverShared) {
        return;
    }
    let device: GPUDevice | undefined;
    let rebuilt: MeshGPU | undefined;
    let owners: WeakSet<Mesh> | undefined;
    const recover: NonNullable<MeshGPU["_recoverShared"]> = (engine, mesh, upload) => {
        // Reuse only an allocation that is still live and unmodified; in-place edits drop its hook.
        if (device === engine._device && rebuilt!._refCount !== 0 && rebuilt!._recoverShared === recover) {
            if (!owners!.has(mesh)) {
                owners!.add(mesh);
                // A clone of a recovered owner already claimed the replacement when it was cloned.
                if (mesh._gpu !== rebuilt) {
                    retain(rebuilt!);
                }
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
