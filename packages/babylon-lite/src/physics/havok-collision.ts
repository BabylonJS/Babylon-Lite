/**
 * Havok Physics V2 collision-event reporting for Babylon Lite.
 *
 * Kept in a standalone module so the collision-event path adds bytes only to scenes
 * that actually import {@link setPhysicsBodyCollisionEventsEnabled} or
 * {@link onPhysicsCollision}. The per-frame `_stepWorld` core in `havok.ts` intentionally
 * does NOT reference this code, so ordinary physics scenes pay zero for it.
 *
 * Enable events on the bodies you care about, then register a callback. Events are produced
 * by the Havok step, so the callback reads them via the existing post-step hook and fires
 * once per collision event:
 *
 * ```ts
 *   const agg = createPhysicsAggregate(world, sphere, PhysicsShapeType.SPHERE, { mass: 1 });
 *   setPhysicsBodyCollisionEventsEnabled(world, agg.body, true);
 *   onPhysicsCollision(world, (info) => {
 *       console.log(info.type, info.point, info.impulse);
 *   });
 * ```
 */

import type { Vec3 } from "../math/types.js";
import { onPhysicsAfterStep } from "./havok.js";
import type { PhysicsBody, PhysicsWorld } from "./havok.js";

/** A single collision event reported by Havok after a physics step. */
export interface PhysicsCollisionInfo {
    /** Phase of the contact: a new contact, an ongoing contact, or a contact that just ended. */
    type: "STARTED" | "CONTINUED" | "FINISHED";
    /** World-space contact point (closest point on the first body). */
    point: Vec3;
    /** World-space contact normal at the contact point. */
    normal: Vec3;
    /** Magnitude of the impulse applied to resolve the contact (0 for `FINISHED`). */
    impulse: number;
}

/**
 * Enable or disable collision-event reporting for a single body by setting its Havok event mask.
 *
 * Only bodies with events enabled contribute to the stream read by {@link onPhysicsCollision};
 * a collision is reported when at least one of the two touching bodies has events enabled.
 * @param world - The physics world owning the body.
 * @param body - The body to toggle collision events on.
 * @param enabled - `true` to report STARTED/CONTINUED/FINISHED events, `false` to silence the body.
 */
export function setPhysicsBodyCollisionEventsEnabled(world: PhysicsWorld, body: PhysicsBody, enabled: boolean): void {
    const hknp = world._hknp;
    const mask = hknp.EventType.COLLISION_STARTED.value | hknp.EventType.COLLISION_CONTINUED.value | hknp.EventType.COLLISION_FINISHED.value;
    hknp.HP_Body_SetEventMask(body._hkBody, enabled ? mask : 0);
}

/**
 * Register a callback invoked once per collision event after each physics step.
 *
 * The events are produced by the Havok world step, so they are drained via the post-step hook
 * ({@link onPhysicsAfterStep}). Enable events on the participating bodies first with
 * {@link setPhysicsBodyCollisionEventsEnabled}, otherwise the stream is empty.
 * @param world - The physics world to listen on.
 * @param cb - Callback invoked with each {@link PhysicsCollisionInfo} as it is read.
 */
export function onPhysicsCollision(world: PhysicsWorld, cb: (info: PhysicsCollisionInfo) => void): void {
    const hknp = world._hknp;
    const startedValue = hknp.EventType.COLLISION_STARTED.value;
    const continuedValue = hknp.EventType.COLLISION_CONTINUED.value;

    onPhysicsAfterStep(world, () => {
        let addr = hknp.HP_World_GetCollisionEvents(world._hkWorld)[1];
        while (addr) {
            const intBuf = new Int32Array(hknp.HEAPU8.buffer, addr);
            const floatBuf = new Float32Array(hknp.HEAPU8.buffer, addr);
            const type = intBuf[0];
            const offA = 2;
            const offB = 18;
            const info: PhysicsCollisionInfo = {
                type: type === startedValue ? "STARTED" : type === continuedValue ? "CONTINUED" : "FINISHED",
                point: { x: floatBuf[offA + 8]!, y: floatBuf[offA + 9]!, z: floatBuf[offA + 10]! },
                normal: { x: floatBuf[offA + 11]!, y: floatBuf[offA + 12]!, z: floatBuf[offA + 13]! },
                impulse: floatBuf[offB + 13 + 3]!,
            };
            cb(info);
            addr = hknp.HP_World_GetNextCollisionEvent(world._hkWorld, addr);
        }
    });
}
