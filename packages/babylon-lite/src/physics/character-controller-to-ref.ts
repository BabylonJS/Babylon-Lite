import type { Vec3 } from "../math/types.js";
import type { PhysicsCharacterController } from "./character-controller.js";

/**
 * Compute character movement into an existing vector.
 * @returns False when forward and up cannot form a movement frame.
 */
export function calculatePhysicsCharacterMovementToRef(
    controller: PhysicsCharacterController,
    deltaTime: number,
    forwardWorld: Vec3,
    surfaceNormal: Vec3,
    currentVelocity: Vec3,
    surfaceVelocity: Vec3,
    desiredVelocity: Vec3,
    upWorld: Vec3,
    result: Vec3
): boolean {
    const crossX = forwardWorld.y * upWorld.z - forwardWorld.z * upWorld.y;
    const crossY = forwardWorld.z * upWorld.x - forwardWorld.x * upWorld.z;
    const crossZ = forwardWorld.x * upWorld.y - forwardWorld.y * upWorld.x;
    if (crossX * crossX + crossY * crossY + crossZ * crossZ < 1e-5) {
        return false;
    }
    const value = controller.calculateMovement(deltaTime, forwardWorld, surfaceNormal, currentVelocity, surfaceVelocity, desiredVelocity, upWorld);
    result.x = value.x;
    result.y = value.y;
    result.z = value.z;
    return true;
}
