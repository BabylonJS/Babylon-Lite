import type { Mesh } from "../mesh/mesh.js";
import type { PickIgnore, PickOptions } from "./gpu-picker.js";

function forMesh(ignore: PickIgnore | readonly PickIgnore[], mesh: Mesh): PickIgnore | null {
    if (Array.isArray(ignore)) {
        return ignore.find((entry) => entry.mesh === mesh) ?? null;
    }
    return (ignore as PickIgnore).mesh === mesh ? (ignore as PickIgnore) : null;
}

export function prepareIgnoredCandidates(
    meshes: readonly Mesh[],
    ignore: PickIgnore | readonly PickIgnore[],
    filter: PickOptions["filter"] | null,
    advanced: boolean
): {
    readonly candidates: { readonly mesh: Mesh; readonly ignore: PickIgnore | null }[];
    readonly deformed: boolean;
    readonly advanced: boolean;
} {
    const candidates: { mesh: Mesh; ignore: PickIgnore | null }[] = [];
    let deformed = false;
    for (const mesh of meshes) {
        const entry = forMesh(ignore, mesh);
        if (mesh.pickable === false || (entry && entry.thinInstanceIndex === undefined && entry.thinInstanceRange === undefined) || (filter && !filter(mesh))) {
            continue;
        }
        candidates.push({ mesh, ignore: entry });
        deformed ||= !!(mesh.morphTargets || mesh.skeleton) && !!mesh._cpuPositions;
        advanced ||= !!mesh.vat || !!mesh.thinInstances || !!mesh._gpu._vbLayout?._p || entry?.thinInstanceIndex !== undefined || !!entry?.thinInstanceRange;
    }
    return { candidates, deformed, advanced };
}
