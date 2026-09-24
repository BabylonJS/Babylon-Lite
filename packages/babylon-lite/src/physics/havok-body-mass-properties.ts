import type { PhysicsBody, PhysicsMassProperties, PhysicsWorld } from "./havok.js";
import { buildNativeMassProperties } from "./havok-mass-properties.js";

/**
 * Sets a body's mass properties, preserving Havok's shape-derived values for omitted fields and
 * reapplying active rotation-axis locks.
 * @param world - The physics world.
 * @param body - The body to update.
 * @param properties - Mass-property overrides.
 */
export function setPhysicsBodyMassProperties(world: PhysicsWorld, body: PhysicsBody, properties: PhysicsMassProperties): void {
    if (world._thin?.mass(body, properties)) {
        return;
    }
    const massProperties = buildNativeMassProperties(world._hknp, body._hkBody, properties);
    body._massPropertiesTransform?.(massProperties);
    world._hknp.HP_Body_SetMassProperties(body._hkBody, massProperties);
}
