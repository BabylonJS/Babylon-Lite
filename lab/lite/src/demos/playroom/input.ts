import { createPickingRay, getViewProjectionMatrix, physicsRaycast } from "babylon-lite";
import { applyPhysicsBodyInstanceImpulse } from "./physics-instances.js";
import { canPushBody } from "./physics.js";
import type { PlayroomEffects } from "./effects.js";
import { setChargeEffect } from "./effects.js";
import type { PlayroomState } from "./types.js";

export function isCameraMovementKey(code: string): boolean {
    return ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(code);
}

export function installFreeModeInput(state: PlayroomState, effects: PlayroomEffects): () => void {
    const cancel = (): void => {
        const pointerId = state.charge?.pointerId;
        state.charge = null;
        setChargeEffect(effects, false);
        if (pointerId !== undefined && state.canvas.hasPointerCapture(pointerId)) {
            state.canvas.releasePointerCapture(pointerId);
        }
    };
    state.cancelCharge = cancel;
    const down = (event: PointerEvent): void => {
        if (state.phase !== "free" || event.button !== 0 || (event.target as HTMLElement).closest(".playroom-ui")) {
            return;
        }
        const camera = state.scene.camera;
        if (!camera) {
            return;
        }
        const rect = state.canvas.getBoundingClientRect();
        const ray = createPickingRay(
            event.clientX - rect.left,
            event.clientY - rect.top,
            getViewProjectionMatrix(camera, state.canvas.width / state.canvas.height),
            rect.width,
            rect.height
        );
        if (!ray) {
            return;
        }
        const to = {
            x: ray.origin[0] + ray.direction[0] * 1000,
            y: ray.origin[1] + ray.direction[1] * 1000,
            z: ray.origin[2] + ray.direction[2] * 1000,
        };
        const hit = physicsRaycast(state.physics, { x: ray.origin[0], y: ray.origin[1], z: ray.origin[2] }, to);
        if (!hit.hasHit || !hit.body || !canPushBody(state.world, hit.body)) {
            return;
        }
        state.canvas.setPointerCapture(event.pointerId);
        state.charge = {
            pointerId: event.pointerId,
            body: hit.body,
            bodyIndex: hit.bodyIndex,
            point: hit.hitPoint,
            direction: { x: ray.direction[0], y: ray.direction[1], z: ray.direction[2] },
            startedAt: performance.now(),
        };
        setChargeEffect(effects, true, hit.hitPoint);
    };
    const up = (event: PointerEvent): void => {
        if (!state.charge || state.charge.pointerId !== event.pointerId) {
            return;
        }
        const charge = state.charge;
        const magnitude = 0.0008 * Math.min(3000, performance.now() - charge.startedAt);
        applyPhysicsBodyInstanceImpulse(
            state.physics,
            charge.body,
            charge.bodyIndex,
            { x: charge.direction.x * magnitude, y: charge.direction.y * magnitude, z: charge.direction.z * magnitude },
            charge.point
        );
        cancel();
    };
    const move = (event: PointerEvent): void => {
        if (state.charge && (event.movementX !== 0 || event.movementY !== 0)) {
            cancel();
        }
    };
    const keydown = (event: KeyboardEvent): void => {
        if (state.charge && isCameraMovementKey(event.code)) {
            cancel();
        }
    };
    state.canvas.addEventListener("pointerdown", down);
    state.canvas.addEventListener("pointerup", up);
    state.canvas.addEventListener("pointercancel", cancel);
    state.canvas.addEventListener("lostpointercapture", cancel);
    state.canvas.addEventListener("pointermove", move);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", keydown);
    return () => {
        cancel();
        state.cancelCharge = (): void => {};
        state.canvas.removeEventListener("pointerdown", down);
        state.canvas.removeEventListener("pointerup", up);
        state.canvas.removeEventListener("pointercancel", cancel);
        state.canvas.removeEventListener("lostpointercapture", cancel);
        state.canvas.removeEventListener("pointermove", move);
        window.removeEventListener("blur", cancel);
        window.removeEventListener("keydown", keydown);
    };
}
