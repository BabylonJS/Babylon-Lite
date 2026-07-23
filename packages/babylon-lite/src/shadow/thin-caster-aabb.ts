import type { Aabb } from "../math/aabb.js";
import type { Mesh } from "../mesh/mesh.js";
import { _casterAabb } from "./caster-world-aabb.js";

declare module "../mesh/thin-instance.js" {
    interface ThinInstanceData {
        /** @internal Set when this specific instance slab has been enabled for shadow bounds. */
        _shadowBoundsReady?: boolean;
    }
}

const DEFAULT_MIN: [number, number, number] = [-0.5, -0.5, -0.5];
const DEFAULT_MAX: [number, number, number] = [0.5, 0.5, 0.5];

// Cache the final union because animated instance slabs can contain many transforms.
// Object identity is part of the key because a replacement ThinInstanceData starts its
// own version counter and may otherwise collide with the previous object's version.
interface ThinCasterCacheEntry {
    thinInstances: NonNullable<Mesh["thinInstances"]>;
    version: number;
    worldVersion: number;
    positions: Float32Array | undefined;
    boundMin: unknown;
    boundMax: unknown;
    morphTargets: Mesh["morphTargets"];
    morphVersion: number;
    aabb: Aabb | null;
}

let _thinCasterAabbCache: WeakMap<Mesh, ThinCasterCacheEntry> | null = null;

/** World AABB of all active thin instances. Instance transforms compose after the
 *  prototype local geometry and before `mesh.worldMatrix`, matching the shader. */
function thinInstanceWorldAabb(mesh: Mesh, deformedLocal: Aabb | null | undefined): Aabb | null {
    const ti = mesh.thinInstances;
    if (!ti || ti.count <= 0) {
        return null;
    }
    const cache = (_thinCasterAabbCache ??= new WeakMap<Mesh, ThinCasterCacheEntry>());
    const positions = mesh._cpuPositions;
    const morphTargets = mesh.morphTargets;
    const morphVersion = morphTargets?._shadowVersion ?? 0;
    const cached = cache.get(mesh);
    if (
        cached &&
        cached.thinInstances === ti &&
        cached.version === ti._version &&
        cached.worldVersion === mesh.worldMatrixVersion &&
        cached.positions === positions &&
        cached.boundMin === mesh.boundMin &&
        cached.boundMax === mesh.boundMax &&
        cached.morphTargets === morphTargets &&
        cached.morphVersion === morphVersion
    ) {
        return cached.aabb;
    }

    let bmin: readonly number[];
    let bmax: readonly number[];
    // null means a deformable prototype was requested but has no valid bounds;
    // undefined means this is a static prototype and the normal local fallback applies.
    if (deformedLocal === null) {
        return null;
    } else if (deformedLocal) {
        bmin = deformedLocal[0];
        bmax = deformedLocal[1];
    } else {
        const local = mesh._localBounds;
        bmin = local?.[0] ?? mesh.boundMin ?? DEFAULT_MIN;
        bmax = local?.[1] ?? mesh.boundMax ?? DEFAULT_MAX;
    }

    const matrices = ti.matrices;
    // Clamp malformed counts to complete matrices so bounds reads never leave the slab.
    const count = Math.min(ti.count, (matrices.length / 16) | 0);
    const world = mesh.worldMatrix;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let instance = 0; instance < count; instance++) {
        const o = instance * 16;
        const linearMagnitude =
            Math.abs(matrices[o]!) +
            Math.abs(matrices[o + 1]!) +
            Math.abs(matrices[o + 2]!) +
            Math.abs(matrices[o + 4]!) +
            Math.abs(matrices[o + 5]!) +
            Math.abs(matrices[o + 6]!) +
            Math.abs(matrices[o + 8]!) +
            Math.abs(matrices[o + 9]!) +
            Math.abs(matrices[o + 10]!);
        // A zero linear transform produces only zero-area triangles. Pools commonly use
        // these matrices to park inactive slots, so their translations must not widen the box.
        if (linearMagnitude < 1e-9) {
            continue;
        }
        for (let corner = 0; corner < 8; corner++) {
            const x = corner & 1 ? bmax[0]! : bmin[0]!;
            const y = corner & 2 ? bmax[1]! : bmin[1]!;
            const z = corner & 4 ? bmax[2]! : bmin[2]!;
            // Match the vertex shader exactly: mesh.world * instanceMatrix * localCorner.
            const ix = matrices[o]! * x + matrices[o + 4]! * y + matrices[o + 8]! * z + matrices[o + 12]!;
            const iy = matrices[o + 1]! * x + matrices[o + 5]! * y + matrices[o + 9]! * z + matrices[o + 13]!;
            const iz = matrices[o + 2]! * x + matrices[o + 6]! * y + matrices[o + 10]! * z + matrices[o + 14]!;
            const wx = world[0]! * ix + world[4]! * iy + world[8]! * iz + world[12]!;
            const wy = world[1]! * ix + world[5]! * iy + world[9]! * iz + world[13]!;
            const wz = world[2]! * ix + world[6]! * iy + world[10]! * iz + world[14]!;
            min[0] = Math.min(min[0], wx);
            min[1] = Math.min(min[1], wy);
            min[2] = Math.min(min[2], wz);
            max[0] = Math.max(max[0], wx);
            max[1] = Math.max(max[1], wy);
            max[2] = Math.max(max[2], wz);
        }
    }
    const aabb: Aabb | null = Number.isFinite(min[0]) ? [min, max] : null;
    cache.set(mesh, {
        thinInstances: ti,
        version: ti._version,
        worldVersion: mesh.worldMatrixVersion,
        positions,
        boundMin: mesh.boundMin,
        boundMax: mesh.boundMax,
        morphTargets,
        morphVersion,
        aabb,
    });
    return aabb;
}

/** Install thin-instance shadow-caster bounds. */
export function enable(casterMeshes: readonly Mesh[]): void {
    for (const mesh of casterMeshes) {
        if (mesh.thinInstances) {
            mesh.thinInstances._shadowBoundsReady = true;
        }
    }
    _casterAabb[2] = thinInstanceWorldAabb;
}
