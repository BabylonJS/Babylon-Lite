import type { PhysicsWorld } from "./havok.js";
import { createHavokThinInstanceContext } from "./havok-thin-instances.js";

/**
 * Enable Havok rigid bodies for meshes with thin-instance matrices synchronously.
 *
 * Use this variant when an adapter must preserve a synchronous setup contract.
 * Native Lite applications should normally prefer {@link enableHavokThinInstancePhysics},
 * which loads the implementation on demand.
 */
export function enableHavokThinInstancePhysicsSync(world: PhysicsWorld): void {
    world._thin ??= createHavokThinInstanceContext(world);
}
