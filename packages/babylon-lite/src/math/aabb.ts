/** Axis-aligned bounding box represented as `[min, max]` XYZ tuples. */
export type Aabb = [min: [number, number, number], max: [number, number, number]];
export { computeAabb } from "./compute-aabb.js";
