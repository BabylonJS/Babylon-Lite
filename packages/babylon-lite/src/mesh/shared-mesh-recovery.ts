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
