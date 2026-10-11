import type { UboSpec } from "../../shader/fragment-types.js";

export const WORLD = 1;
export const VIEW = 2;
export const PROJECTION = 4;
export const VIEW_PROJECTION = 8;
export const CAMERA_POSITION = 16;
export const SCREEN_SIZE = 32;
export const ALPHA_CUTOFF = 64;

const DEPENDENCIES: Readonly<Record<string, number>> = {
    world: WORLD,
    view: VIEW,
    projection: PROJECTION,
    viewProjection: VIEW_PROJECTION,
    worldView: WORLD | VIEW,
    worldViewProjection: WORLD | VIEW_PROJECTION,
    cameraPosition: CAMERA_POSITION,
    screenSize: SCREEN_SIZE,
    alphaCutoff: ALPHA_CUTOFF,
};

/** @internal Shared system-name classification and dependency metadata. */
export function shaderSystemDependency(name: string): number {
    return Object.hasOwn(DEPENDENCIES, name) ? DEPENDENCIES[name]! : 0;
}

/** @internal Dependencies of the declared system layout, including composed matrices. */
export function shaderSystemDependencies(spec: UboSpec): number {
    let dependencies = 0;
    for (const name of spec._offsets.keys()) {
        dependencies |= shaderSystemDependency(name);
    }
    return dependencies;
}
