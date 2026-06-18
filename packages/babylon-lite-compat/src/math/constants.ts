/** Babylon.js-compatible spatial constants (`Axis`, `Space`). */

import { Vector3 } from "./vector.js";

// Lazily-cached axis singletons: stable identity (matching Babylon.js, where
// `Axis.X/Y/Z` are shared constants) and no allocation until first accessed.
let _axisX: Vector3 | undefined;
let _axisY: Vector3 | undefined;
let _axisZ: Vector3 | undefined;

export const Axis = {
    get X(): Vector3 {
        return (_axisX ??= new Vector3(1, 0, 0));
    },
    get Y(): Vector3 {
        return (_axisY ??= new Vector3(0, 1, 0));
    },
    get Z(): Vector3 {
        return (_axisZ ??= new Vector3(0, 0, 1));
    },
};

export enum Space {
    LOCAL = 0,
    WORLD = 1,
    BONE = 2,
}
