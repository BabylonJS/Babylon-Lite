import type { Mesh } from "../mesh/mesh.js";

interface ThinInstanceBounds {
    min: [number, number, number];
    max: [number, number, number];
    _fitCaster?: DirectionalShadowCaster;
}

interface DirectionalShadowCaster {
    readonly worldMatrix: ArrayLike<number>;
    readonly boundMin?: Mesh["boundMin"];
    readonly boundMax?: Mesh["boundMax"];
}

interface BoundsEntry {
    _version: number;
    _worldVersion: number;
    _matrices: NonNullable<Mesh["thinInstances"]>["matrices"] | undefined;
    _count: number;
    _localBounds: number[];
    _bounds: ThinInstanceBounds;
}

const DEFAULT_MIN = [-0.5, -0.5, -0.5] as const;
const DEFAULT_MAX = [0.5, 0.5, 0.5] as const;
const IDENTITY_WORLD = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
let cache: WeakMap<Mesh, BoundsEntry> | undefined;

/** Present world bounds to the ordinary directional fitter without changing the source mesh. */
export function getDirectionalShadowCaster(mesh: Mesh): DirectionalShadowCaster | null {
    if (!mesh.thinInstances) {
        return mesh;
    }
    const bounds = getShadowCasterWorldBounds(mesh);
    return bounds ? (bounds._fitCaster ??= { worldMatrix: IDENTITY_WORLD, boundMin: bounds.min, boundMax: bounds.max }) : null;
}

/** Cached world bounds of the active instances, never the uninstanced prototype. */
export function getThinInstanceWorldBounds(mesh: Mesh): ThinInstanceBounds | null | undefined {
    return mesh.thinInstances ? getShadowCasterWorldBounds(mesh) : undefined;
}

/** Cached world bounds for either an ordinary caster or its active instances. */
export function getShadowCasterWorldBounds(mesh: Mesh): ThinInstanceBounds | null {
    const ti = mesh.thinInstances;
    const matrices = ti?.matrices;
    const version = ti?._version ?? 0;
    const count = ti ? Math.min(ti.count, Math.floor(matrices!.length / 16)) : 1;
    const worldVersion = mesh.worldMatrixVersion;
    const min = mesh.boundMin ?? DEFAULT_MIN;
    const max = mesh.boundMax ?? DEFAULT_MAX;
    cache ??= new WeakMap();
    let entry = cache.get(mesh);
    if (
        entry &&
        entry._version === version &&
        entry._worldVersion === worldVersion &&
        entry._matrices === matrices &&
        entry._count === count &&
        entry._localBounds[0] === min[0] &&
        entry._localBounds[1] === min[1] &&
        entry._localBounds[2] === min[2] &&
        entry._localBounds[3] === max[0] &&
        entry._localBounds[4] === max[1] &&
        entry._localBounds[5] === max[2]
    ) {
        return Number.isFinite(entry._bounds.min[0]) ? entry._bounds : null;
    }
    if (!entry) {
        entry = {
            _version: version,
            _worldVersion: worldVersion,
            _matrices: matrices,
            _count: count,
            _localBounds: [0, 0, 0, 0, 0, 0],
            _bounds: { min: [0, 0, 0], max: [0, 0, 0] },
        };
        cache.set(mesh, entry);
    }
    const bounds = entry._bounds;
    bounds.min.fill(Infinity);
    bounds.max.fill(-Infinity);
    const world = mesh.worldMatrix;
    for (let i = 0; i < count; i++) {
        const offset = i * 16;
        const linearSize = matrices
            ? Math.abs(matrices[offset]!) +
              Math.abs(matrices[offset + 1]!) +
              Math.abs(matrices[offset + 2]!) +
              Math.abs(matrices[offset + 4]!) +
              Math.abs(matrices[offset + 5]!) +
              Math.abs(matrices[offset + 6]!) +
              Math.abs(matrices[offset + 8]!) +
              Math.abs(matrices[offset + 9]!) +
              Math.abs(matrices[offset + 10]!)
            : 1;
        if (linearSize < 1e-9) {
            continue;
        }
        for (let axis = 0; axis < 3; axis++) {
            let center = world[12 + axis]!;
            let radius = 0;
            for (let column = 0; column < 3; column++) {
                let coefficient = world[column * 4 + axis]!;
                if (matrices) {
                    center += coefficient * matrices[offset + 12 + column]!;
                    coefficient = 0;
                    for (let inner = 0; inner < 3; inner++) {
                        coefficient += world[inner * 4 + axis]! * matrices[offset + column * 4 + inner]!;
                    }
                }
                center += coefficient * (min[column]! + max[column]!) * 0.5;
                radius += Math.abs(coefficient) * (max[column]! - min[column]!) * 0.5;
            }
            bounds.min[axis] = Math.min(bounds.min[axis]!, center - radius);
            bounds.max[axis] = Math.max(bounds.max[axis]!, center + radius);
        }
    }
    entry._version = version;
    entry._worldVersion = worldVersion;
    entry._matrices = matrices;
    entry._count = count;
    for (let axis = 0; axis < 3; axis++) {
        entry._localBounds[axis] = min[axis]!;
        entry._localBounds[axis + 3] = max[axis]!;
    }
    return Number.isFinite(bounds.min[0]) ? bounds : null;
}
