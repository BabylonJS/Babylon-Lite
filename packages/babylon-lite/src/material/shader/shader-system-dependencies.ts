import type { UboSpec } from "../../shader/fragment-types.js";

export const WORLD = 1;
export const VIEW = 2;
export const PROJECTION = 4;
export const VIEW_PROJECTION = 8;
export const CAMERA_POSITION = 16;
export const SCREEN_SIZE = 32;
export const ALPHA_CUTOFF = 64;
/** Every dependency on the active camera's transform or projection. */
export const CAMERA = VIEW | PROJECTION | VIEW_PROJECTION | CAMERA_POSITION;

// Null prototype: inherited keys such as "constructor" must not classify as system uniforms.
const DEPENDENCIES = {
    __proto__: null,
    world: WORLD,
    view: VIEW,
    projection: PROJECTION,
    viewProjection: VIEW_PROJECTION,
    worldView: WORLD | VIEW,
    worldViewProjection: WORLD | VIEW_PROJECTION,
    cameraPosition: CAMERA_POSITION,
    screenSize: SCREEN_SIZE,
    alphaCutoff: ALPHA_CUTOFF,
} as unknown as Readonly<Record<string, number | undefined>>;

/** @internal Dependency bits of one system uniform name; 0 for any non-system name. */
export function shaderSystemDependency(name: string): number {
    return DEPENDENCIES[name] ?? 0;
}

/** @internal Dependencies of the declared system layout, including composed matrices. */
export function shaderSystemDependencies(spec: UboSpec): number {
    let dependencies = 0;
    for (const name of spec._offsets.keys()) {
        dependencies |= shaderSystemDependency(name);
    }
    return dependencies;
}
