import { U32 } from "../engine/typed-arrays.js";
import type { LightBase } from "../light/types.js";
import { MAX_LIGHTS } from "../light/types.js";
import type { Mesh } from "../mesh/mesh.js";

const MSH_LIGHT_INDEX_WORD_OFFSET = 20;

function affectsMesh(light: LightBase, mesh: Mesh): boolean {
    const meshId = mesh.id;
    const included = light.includedOnlyMeshIds;
    if (included?.size) {
        return !!meshId && included.has(meshId);
    }
    return !meshId || !light.excludedMeshIds?.has(meshId);
}

/** @internal Writes mesh light indices when data is provided.
 *  Returns zero for no lights, the one-based index for one light, or negative affected count. */
export function writeMeshLightSelection(mesh: Mesh, lights: readonly LightBase[], data?: Float32Array): number {
    const u32 = data ? new U32(data.buffer, data.byteOffset, data.byteLength / 4) : null;
    let count = 0;
    let single = -1;
    let pi = 0;
    for (const light of lights) {
        if (pi >= MAX_LIGHTS) {
            break;
        }
        if (!light._writeLightUbo) {
            continue;
        }
        if (affectsMesh(light, mesh)) {
            single = pi;
            if (u32) {
                u32[MSH_LIGHT_INDEX_WORD_OFFSET + count] = pi;
            }
            count++;
        }
        pi++;
    }
    if (u32) {
        u32[16] = count;
        for (let i = count; i < MAX_LIGHTS; i++) {
            u32[MSH_LIGHT_INDEX_WORD_OFFSET + i] = 0;
        }
    }
    return count === 1 ? single + 1 : -count;
}
