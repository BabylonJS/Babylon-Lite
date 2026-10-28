import type { EngineContext } from "../engine/engine.js";
import type { MorphTargetData } from "../animation/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { release, retain } from "../resource/ref-count.js";
import { MORPH_WEIGHTS_HEADER_BYTES } from "./create-morph-targets.js";

function destroyMorphTargets(morphTargets: MorphTargetData): void {
    morphTargets._disposed = true;
    morphTargets.deltasBuffer.destroy();
    morphTargets.weightsBuffer.destroy();
}

function releaseMeshMorphTargets(mesh: Mesh): void {
    const current = mesh.morphTargets;
    if (current && release(current)) {
        destroyMorphTargets(current);
    }
}

/** Replace a mesh's morph targets with a newly-created resource whose initial ownership transfers to the mesh. */
export function adoptMeshMorphTargets(mesh: Mesh, morphTargets: MorphTargetData): void {
    if (mesh.morphTargets === morphTargets) {
        return;
    }
    releaseMeshMorphTargets(mesh);
    mesh.morphTargets = morphTargets;
}

/** Replace a mesh's morph targets with an existing shared resource, retaining and releasing ownership claims. */
export function shareMeshMorphTargets(mesh: Mesh, morphTargets: MorphTargetData | null): void {
    if (mesh.morphTargets === morphTargets) {
        return;
    }
    releaseMeshMorphTargets(mesh);
    if (morphTargets) {
        retain(morphTargets);
    }
    mesh.morphTargets = morphTargets;
}

/** Update one morph weight without allocating or copying the complete weight vector. */
export function setMorphTargetWeight(engine: EngineContext, morphTargets: MorphTargetData, index: number, value: number): void {
    if (morphTargets._disposed) {
        throw new Error("Cannot update disposed morph targets");
    }
    if (index < 0 || index >= morphTargets.count) {
        return;
    }
    morphTargets.weights[index] = value;
    engine._device.queue.writeBuffer(
        morphTargets.weightsBuffer,
        MORPH_WEIGHTS_HEADER_BYTES + index * 4,
        morphTargets.weights.buffer as ArrayBuffer,
        morphTargets.weights.byteOffset + index * 4,
        4
    );
}
