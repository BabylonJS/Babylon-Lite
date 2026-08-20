import type { Vec3 } from "../math/types.js";
import type { PhysicsBody, PhysicsWorld } from "./havok.js";

/**
 * Get a body's current angular velocity (rad/s).
 */
export function getPhysicsBodyAngularVelocity(world: PhysicsWorld, body: PhysicsBody): Vec3 {
    const velocity = world._hknp.HP_Body_GetAngularVelocity(body._hkBody)[1];
    return { x: velocity[0], y: velocity[1], z: velocity[2] };
}
