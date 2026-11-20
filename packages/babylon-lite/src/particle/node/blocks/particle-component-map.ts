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
 * Apply `map` to every component of `value`, writing vectors and colours into `scratch`. `value` may already be
 * that scratch: a block copies its operand first (`map` = identity) so reading later inputs cannot overwrite it,
 * then transforms the copy in place.
 */
export function mapComponents(value: NpeValue, map: (component: number) => number, scratch: NpeComponentScratch): NpeValue {
    if (typeof value === "number") {
        return map(value);
    }
    if ("r" in value) {
        const color = scratch.c4;
        color.r = map(value.r);
        color.g = map(value.g);
        color.b = map(value.b);
        color.a = map(value.a);
        return color;
    }
    if ("z" in value) {
        const vector = scratch.v3;
        vector.x = map(value.x);
        vector.y = map(value.y);
        vector.z = map(value.z);
        return vector;
    }
    const vector = scratch.v2;
    vector.x = map(value.x);
    vector.y = map(value.y);
    return vector;
}

/** Identity component map used to copy an operand into block-owned scratch. */
export const copyComponent = (component: number): number => component;
