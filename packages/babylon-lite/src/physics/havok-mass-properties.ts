import type { PhysicsMassProperties } from "./havok.js";

export type NativeMassProperties = [centerOfMass: number[], mass: number, inertia: number[], inertiaOrientation: number[]];

export function buildNativeMassProperties(raw: any, handle: any, properties: PhysicsMassProperties, fallbackInertia = 1): NativeMassProperties {
    const ok = raw.Result?.RESULT_OK ?? 0;
    const shape = raw.HP_Body_GetShape(handle);
    const shapeMass = shape[0] === ok ? raw.HP_Shape_BuildMassProperties(shape[1]) : null;
    const result: NativeMassProperties = shapeMass?.[0] === ok ? shapeMass[1] : [[0, 0, 0], 1, [fallbackInertia, fallbackInertia, fallbackInertia], [0, 0, 0, 1]];
    const { centerOfMass, mass, inertia, inertiaOrientation } = properties;
    if (centerOfMass) {
        result[0] = [centerOfMass.x, centerOfMass.y, centerOfMass.z];
    }
    if (mass !== undefined) {
        result[1] = mass;
    }
    if (inertia) {
        result[2] = [inertia.x, inertia.y, inertia.z];
    }
    if (inertiaOrientation) {
        result[3] = [inertiaOrientation.x, inertiaOrientation.y, inertiaOrientation.z, inertiaOrientation.w];
    }
    return result;
}
