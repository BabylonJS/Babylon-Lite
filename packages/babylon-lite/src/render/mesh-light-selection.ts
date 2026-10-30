import { U32 } from "../engine/typed-arrays.js";
import type { LightBase } from "../light/types.js";
import { MAX_LIGHTS } from "../light/types.js";
import type { Mesh } from "../mesh/mesh.js";

const MSH_LIGHT_INDEX_WORD_OFFSET = 20;

/** @internal Shared inclusion/exclusion predicate for a packed-light receiver.
 *  Object sets are applied first and both apply: an inclusion restricts the light and an exclusion
 *  then subtracts from it, matching Babylon.js `Light.canAffectMesh`. The ID sets keep their own
 *  precedence, where an inclusion wins outright, so `.babylon`-loaded lists are unchanged. */
export function lightAffectsMesh(light: LightBase, mesh: Mesh): boolean {
    const isExcluded = light.excludedMeshes?.has(mesh);
    const includedMeshes = light.includedOnlyMeshes;
    if (includedMeshes?.size) {
        return includedMeshes.has(mesh) && !isExcluded;
    }
    const meshId = mesh.id;
    const includedIds = light.includedOnlyMeshIds;
    return isExcluded ? false : includedIds?.size ? !!meshId && includedIds.has(meshId) : !meshId || !light.excludedMeshIds?.has(meshId);
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
        if (lightAffectsMesh(light, mesh)) {
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
