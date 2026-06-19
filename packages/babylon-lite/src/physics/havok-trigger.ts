/**
 * Havok Physics V2 trigger-volume reporting for Babylon Lite.
 *
 * Kept in a standalone module so the trigger path adds bytes only to scenes that actually
 * import {@link setPhysicsShapeIsTrigger} or {@link onPhysicsTrigger}. The per-frame
 * `_stepWorld` core in `havok.ts` intentionally does NOT reference this code, so ordinary
 * physics scenes pay zero for it.
 *
 * Unlike collision events (which require a per-body event mask), trigger volumes only need
 * the shape flagged as a trigger and the trigger body present in the world. Flag the shape,
 * register a callback, and trigger events are drained via the existing post-step hook once
 * per event:
 *
 * ```ts
 *   const triggerShape = createPhysicsShape(world, { type: PhysicsShapeType.SPHERE, parameters: { radius: 2 } });
 *   setPhysicsShapeIsTrigger(world, triggerShape, true);
 *   const triggerNode = createTransformNode("trigger", 0, 0, 0);
 *   const triggerBody = createPhysicsBody(world, triggerNode, PhysicsMotionType.STATIC);
 *   setPhysicsBodyShape(world, triggerBody, triggerShape);
 *   onPhysicsTrigger(world, (info) => {
 *       console.log(info.type); // "ENTERED" when a body enters, "EXITED" when it leaves
 *   });
 * ```
 */

import { onPhysicsAfterStep } from "./havok.js";
import type { PhysicsShape, PhysicsWorld } from "./havok.js";

/** A single trigger-volume event reported by Havok after a physics step. */
export interface PhysicsTriggerInfo {
    /** `ENTERED` when a body enters the trigger volume, `EXITED` when it leaves. */
    type: "ENTERED" | "EXITED";
}

/**
 * Flag a collision shape as a trigger volume (or clear the flag).
 *
 * A trigger shape detects overlaps and reports {@link PhysicsTriggerInfo} events but does
 * not produce a physical collision response — bodies pass through it. Attach the flagged
 * shape to a body in the world, then listen with {@link onPhysicsTrigger}.
 * @param world - The physics world owning the shape.
 * @param shape - The collision shape to flag.
 * @param isTrigger - `true` to make the shape a trigger volume, `false` for a solid shape.
 */
export function setPhysicsShapeIsTrigger(world: PhysicsWorld, shape: PhysicsShape, isTrigger: boolean): void {
    world._hknp.HP_Shape_SetTrigger(shape._hkShape, isTrigger);
}

/**
 * Register a callback invoked once per trigger event after each physics step.
 *
 * The events are produced by the Havok world step, so they are drained via the post-step
 * hook ({@link onPhysicsAfterStep}). Flag the participating shape with
 * {@link setPhysicsShapeIsTrigger} first, otherwise the stream is empty.
 * @param world - The physics world to listen on.
 * @param cb - Callback invoked with each {@link PhysicsTriggerInfo} as it is read.
 */
export function onPhysicsTrigger(world: PhysicsWorld, cb: (info: PhysicsTriggerInfo) => void): void {
    const hknp = world._hknp;
    // Native Havok trigger event types: 8 = ENTERED, 16 = EXITED. The Havok `EventType` enum
    // only enumerates the collision types, so the trigger values are matched literally (mirroring
    // Babylon.js' `_nativeTriggerCollisionValueToCollisionType`). Unknown values are skipped.
    const TRIGGER_ENTERED = 8;
    const TRIGGER_EXITED = 16;

    onPhysicsAfterStep(world, () => {
        let addr = hknp.HP_World_GetTriggerEvents(world._hkWorld)[1];
        while (addr) {
            const intBuf = new Int32Array(hknp.HEAPU8.buffer, addr);
            const type = intBuf[0];
            if (type === TRIGGER_ENTERED) {
                cb({ type: "ENTERED" });
            } else if (type === TRIGGER_EXITED) {
                cb({ type: "EXITED" });
            }
            addr = hknp.HP_World_GetNextTriggerEvent(world._hkWorld, addr);
        }
    });
}
