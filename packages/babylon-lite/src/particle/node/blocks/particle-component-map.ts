import type { Vec2, Vec3, Color4 } from "../../../math/types.js";
import type { NpeValue } from "../npe-value.js";

/** Scratch values owned by one per-component NPE block, so its results never allocate. */
export interface NpeComponentScratch {
    readonly v2: Vec2;
    readonly v3: Vec3;
    readonly c4: Color4;
}

/** Create the scratch values for one per-component block. */
export function createComponentScratch(): NpeComponentScratch {
    return { v2: { x: 0, y: 0 }, v3: { x: 0, y: 0, z: 0 }, c4: { r: 0, g: 0, b: 0, a: 0 } };
}

/**
 * Apply `map` to every component of `value` with one shape dispatch, writing vectors and colours into `scratch`.
 * The components are read into locals before `readOperands(i)` evaluates the block's later inputs, which may share or
 * overwrite `value`'s scratch; the result is then written once. Scalars need no copy.
 */
export function mapComponents(value: NpeValue, map: (component: number) => number, scratch: NpeComponentScratch, readOperands?: (i: number) => void, i = 0): NpeValue {
    if (typeof value === "number") {
        readOperands?.(i);
        return map(value);
    }
    if ("r" in value) {
        const r = value.r;
        const g = value.g;
        const b = value.b;
        const a = value.a;
        readOperands?.(i);
        const color = scratch.c4;
        color.r = map(r);
        color.g = map(g);
        color.b = map(b);
        color.a = map(a);
        return color;
    }
    if ("z" in value) {
        const x = value.x;
        const y = value.y;
        const z = value.z;
        readOperands?.(i);
        const vector = scratch.v3;
        vector.x = map(x);
        vector.y = map(y);
        vector.z = map(z);
        return vector;
    }
    const x = value.x;
    const y = value.y;
    readOperands?.(i);
    const vector = scratch.v2;
    vector.x = map(x);
    vector.y = map(y);
    return vector;
}
