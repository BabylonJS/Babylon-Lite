import type { Mesh } from "../mesh/mesh.js";

interface ThinInstanceBounds {
    min: [number, number, number];
    max: [number, number, number];
}

interface BoundsEntry {
    version: number;
    worldVersion: number;
    matrices: NonNullable<Mesh["thinInstances"]>["matrices"];
    count: number;
    local: number[];
    bounds: ThinInstanceBounds;
}

const DEFAULT_MIN = [-0.5, -0.5, -0.5] as const;
const DEFAULT_MAX = [0.5, 0.5, 0.5] as const;
let cache: WeakMap<Mesh, BoundsEntry> | undefined;

/** Cached world bounds of the active instances, never the uninstanced prototype. */
export function getThinInstanceWorldBounds(mesh: Mesh): ThinInstanceBounds | null {
    const ti = mesh.thinInstances!;
    const worldVersion = mesh.worldMatrixVersion;
    const min = mesh.boundMin ?? DEFAULT_MIN;
    const max = mesh.boundMax ?? DEFAULT_MAX;
    cache ??= new WeakMap();
    let entry = cache.get(mesh);
    if (
        entry &&
        entry.version === ti._version &&
        entry.worldVersion === worldVersion &&
        entry.matrices === ti.matrices &&
        entry.count === ti.count &&
        entry.local[0] === min[0] &&
        entry.local[1] === min[1] &&
        entry.local[2] === min[2] &&
        entry.local[3] === max[0] &&
        entry.local[4] === max[1] &&
        entry.local[5] === max[2]
    ) {
        return Number.isFinite(entry.bounds.min[0]) ? entry.bounds : null;
    }
    if (!entry) {
        entry = {
            version: ti._version,
            worldVersion,
            matrices: ti.matrices,
            count: ti.count,
            local: [0, 0, 0, 0, 0, 0],
            bounds: { min: [0, 0, 0], max: [0, 0, 0] },
        };
        cache.set(mesh, entry);
    }
    const bounds = entry.bounds;
    bounds.min.fill(Infinity);
    bounds.max.fill(-Infinity);
    const world = mesh.worldMatrix;
    const matrices = ti.matrices;
    const count = Math.min(ti.count, Math.floor(matrices.length / 16));
    for (let i = 0; i < count; i++) {
        const offset = i * 16;
        const linearSize =
            Math.abs(matrices[offset]!) +
            Math.abs(matrices[offset + 1]!) +
            Math.abs(matrices[offset + 2]!) +
            Math.abs(matrices[offset + 4]!) +
            Math.abs(matrices[offset + 5]!) +
            Math.abs(matrices[offset + 6]!) +
            Math.abs(matrices[offset + 8]!) +
            Math.abs(matrices[offset + 9]!) +
            Math.abs(matrices[offset + 10]!);
        if (linearSize < 1e-9) {
            continue;
        }
        for (let corner = 0; corner < 8; corner++) {
            const x = corner & 1 ? max[0] : min[0];
            const y = corner & 2 ? max[1] : min[1];
            const z = corner & 4 ? max[2] : min[2];
            const ix = matrices[offset]! * x + matrices[offset + 4]! * y + matrices[offset + 8]! * z + matrices[offset + 12]!;
            const iy = matrices[offset + 1]! * x + matrices[offset + 5]! * y + matrices[offset + 9]! * z + matrices[offset + 13]!;
            const iz = matrices[offset + 2]! * x + matrices[offset + 6]! * y + matrices[offset + 10]! * z + matrices[offset + 14]!;
            for (let axis = 0; axis < 3; axis++) {
                const value = world[axis]! * ix + world[4 + axis]! * iy + world[8 + axis]! * iz + world[12 + axis]!;
                bounds.min[axis] = Math.min(bounds.min[axis]!, value);
                bounds.max[axis] = Math.max(bounds.max[axis]!, value);
            }
        }
    }
    entry.version = ti._version;
    entry.worldVersion = worldVersion;
    entry.matrices = matrices;
    entry.count = ti.count;
    for (let axis = 0; axis < 3; axis++) {
        entry.local[axis] = min[axis]!;
        entry.local[axis + 3] = max[axis]!;
    }
    return Number.isFinite(bounds.min[0]) ? bounds : null;
}
