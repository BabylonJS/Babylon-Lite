import type * as Velocity from "./pbr-geometry-velocity.js";

/** @internal Explicitly installed velocity behavior; absent from ordinary geometry passes. */
export let pbrGeometryVelocity: typeof Velocity | null = null;

/** @internal Keep installation outside the geometry-view namespace imported by ordinary tasks. */
export function installPbrGeometryVelocity(velocity: typeof Velocity): void {
    pbrGeometryVelocity = velocity;
}
