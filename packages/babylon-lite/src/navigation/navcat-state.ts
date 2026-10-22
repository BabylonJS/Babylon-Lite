import type { NavMesh } from "navcat";
import type { Vec3, Vec3Tuple } from "../math/types.js";
import type { NavcatFilter, NavcatManager } from "./navcat-types.js";

// Navcat reuses module-local query scratch arrays. Only this opt-in backend owns the guard.
let querying = false;

export function assertNavcatIdle(): void {
    if (querying) {
        throw new Error("Navcat query callbacks cannot run nested queries or mutate navigation");
    }
}

export function navcatMesh(manager: NavcatManager): NavMesh {
    if (manager._disposed || !manager._mesh) {
        throw new Error("Navcat manager is disposed");
    }
    return manager._mesh;
}

export function navcatQuery<T>(manager: NavcatManager, run: (mesh: NavMesh) => T): T {
    assertNavcatIdle();
    const mesh = navcatMesh(manager);
    querying = true;
    try {
        return run(mesh);
    } finally {
        querying = false;
    }
}

export function navcatVersion(manager: NavcatManager): number {
    assertNavcatIdle();
    navcatMesh(manager);
    return manager._meshVersion;
}

export function checkNavcatVersion(manager: NavcatManager, version: number): NavMesh {
    assertNavcatIdle();
    const mesh = navcatMesh(manager);
    if (manager._meshVersion !== version) {
        throw new Error("Navcat mesh was replaced during an asynchronous operation");
    }
    return mesh;
}

export function copyNavcatVector(value: Vec3, name: string, nonnegative = false): Vec3 {
    if (![value.x, value.y, value.z].every((n) => Number.isFinite(n) && (!nonnegative || n >= 0))) {
        throw new Error(`Navcat ${name} must have finite${nonnegative ? " nonnegative" : ""} components`);
    }
    return { x: value.x, y: value.y, z: value.z };
}

export function toNavcat(value: Vec3): Vec3Tuple {
    const v = copyNavcatVector(value, "position");
    return [v.x, v.y, -v.z];
}

export function fromNavcat(value: readonly number[]): Vec3 {
    return { x: value[0]!, y: value[1]!, z: -value[2]! || 0 };
}

export function navcatFlags(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        throw new Error("Navcat flags must be unsigned 16-bit integers");
    }
    return value;
}

export function copyNavcatFilter(filter: NavcatFilter | null | undefined): NavcatFilter {
    return { includeFlags: navcatFlags(filter?.includeFlags ?? 0xffff), excludeFlags: navcatFlags(filter?.excludeFlags ?? 0), pass: filter?.pass, cost: filter?.cost };
}
