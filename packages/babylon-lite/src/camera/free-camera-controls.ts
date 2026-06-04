import type { FreeCamera } from "./free-camera.js";
import type { SceneContext } from "../scene/scene.js";

/**
 * Attach keyboard + mouse controls to a FreeCamera.
 * Matches Babylon.js FreeCamera input behavior:
 * - Mouse drag or pointer-lock: look around (yaw/pitch)
 * - Arrow keys / WASD: move forward/back/strafe
 * - PageUp/PageDown or Space/Shift: move up/down
 * - Inertia: movement decays smoothly (camera.inertia, default 0.9)
 * - Frame-rate independent: uses deltaTime from render loop
 *
 * Camera stays plain data — this function reads/writes its properties.
 * Returns a cleanup function to remove all listeners and the beforeRender hook.
 */
export function attachFreeControl(camera: FreeCamera, canvas: HTMLCanvasElement, scene?: SceneContext): () => void {
    // ─── Accumulator state (like BJS cameraDirection / cameraRotation) ───
    let cdX = 0,
        cdY = 0,
        cdZ = 0; // camera direction accumulator (local space)
    let crX = 0,
        crY = 0; // camera rotation accumulator (pitch, yaw)

    let isDragging = false;
    let lastPX = 0;
    let lastPY = 0;
    const keys = new Set<string>();

    // ─── Mouse / pointer ─────────────────────────────────────────────────
    function onPointerDown(e: PointerEvent): void {
        if (e.button === 0 || e.button === 1 || e.button === 2) {
            canvas.setPointerCapture(e.pointerId);
            isDragging = true;
            lastPX = e.clientX;
            lastPY = e.clientY;
        }
    }

    function onPointerMove(e: PointerEvent): void {
        if (!isDragging) {
            return;
        }
        const dx = e.clientX - lastPX;
        const dy = e.clientY - lastPY;
        lastPX = e.clientX;
        lastPY = e.clientY;

        // Add to rotation accumulator (same as BJS: divide by angularSensitivity)
        crY += dx / camera.angularSensitivity;
        crX += dy / camera.angularSensitivity;
    }

    function onPointerUp(e: PointerEvent): void {
        canvas.releasePointerCapture(e.pointerId);
        isDragging = false;
    }

    function onContextMenu(e: Event): void {
        e.preventDefault();
    }

    // ─── Keyboard ────────────────────────────────────────────────────────
    function onKeyDown(e: KeyboardEvent): void {
        keys.add(e.code);
    }

    function onKeyUp(e: KeyboardEvent): void {
        keys.delete(e.code);
    }

    // ─── Per-frame update (receives deltaMs from engine render loop) ─────
    function update(deltaMs: number): void {
        // BJS speed formula: speed * sqrt(deltaTime / (fps * 100))
        // Simplified: fps ≈ 1000/deltaMs, so deltaTime/(fps*100) = deltaMs^2 / 100000
        const dt = Math.max(deltaMs, 1);
        const moveSpeed = camera.speed * Math.sqrt((dt * dt) / 100000);

        // Accumulate keyboard input into camera direction (local space)
        if (keys.has("KeyW") || keys.has("ArrowUp")) {
            cdZ += moveSpeed;
        }
        if (keys.has("KeyS") || keys.has("ArrowDown")) {
            cdZ -= moveSpeed;
        }
        if (keys.has("KeyA") || keys.has("ArrowLeft")) {
            cdX -= moveSpeed;
        }
        if (keys.has("KeyD") || keys.has("ArrowRight")) {
            cdX += moveSpeed;
        }
        if (keys.has("Space") || keys.has("PageUp")) {
            cdY += moveSpeed;
        }
        if (keys.has("ShiftLeft") || keys.has("ShiftRight") || keys.has("PageDown")) {
            cdY -= moveSpeed;
        }

        // Only apply movement/rotation if there's actual input to apply
        const hasMovement = cdX !== 0 || cdY !== 0 || cdZ !== 0;
        const hasRotation = crX !== 0 || crY !== 0;

        if (hasRotation) {
            camera._yaw += crY;
            camera._pitch -= crX;
            const maxPitch = Math.PI / 2 - 0.01;
            camera._pitch = Math.max(-maxPitch, Math.min(maxPitch, camera._pitch));
        }

        if (hasMovement) {
            // Transform local direction → world space using camera orientation
            const cosY = Math.cos(camera._yaw);
            const sinY = Math.sin(camera._yaw);
            const cosP = Math.cos(camera._pitch);
            const sinP = Math.sin(camera._pitch);
            // Forward/back moves in the camera's look direction (includes pitch)
            camera.position.x += sinY * cosP * cdZ + cosY * cdX;
            camera.position.y += sinP * cdZ + cdY;
            camera.position.z += cosY * cosP * cdZ - sinY * cdX;
        }

        // Update target from yaw/pitch only when camera moved or rotated
        if (hasMovement || hasRotation) {
            const cosY = Math.cos(camera._yaw);
            const sinY = Math.sin(camera._yaw);
            const cosP = Math.cos(camera._pitch);
            camera.target.set(camera.position.x + sinY * cosP, camera.position.y + Math.sin(camera._pitch), camera.position.z + cosY * cosP);
        }

        // Apply inertia (decay accumulators)
        const inertia = camera.inertia;
        const moveEpsilon = camera.speed * 0.001;
        const rotEpsilon = camera.speed * 0.001;
        cdX *= inertia;
        cdY *= inertia;
        cdZ *= inertia;
        crX *= inertia;
        crY *= inertia;
        // Clamp to zero when below epsilon
        if (Math.abs(cdX) < moveEpsilon) {
            cdX = 0;
        }
        if (Math.abs(cdY) < moveEpsilon) {
            cdY = 0;
        }
        if (Math.abs(cdZ) < moveEpsilon) {
            cdZ = 0;
        }
        if (Math.abs(crX) < rotEpsilon) {
            crX = 0;
        }
        if (Math.abs(crY) < rotEpsilon) {
            crY = 0;
        }
    }

    // ─── Register / cleanup ──────────────────────────────────────────────
    if (scene) {
        scene._beforeRender.push(update);
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("keyup", onKeyUp);
    if (!canvas.hasAttribute("tabindex")) {
        canvas.tabIndex = 0;
    }

    return () => {
        if (scene) {
            const idx = scene._beforeRender.indexOf(update);
            if (idx >= 0) {
                scene._beforeRender.splice(idx, 1);
            }
        }
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("contextmenu", onContextMenu);
        canvas.removeEventListener("keydown", onKeyDown);
        canvas.removeEventListener("keyup", onKeyUp);
    };
}
