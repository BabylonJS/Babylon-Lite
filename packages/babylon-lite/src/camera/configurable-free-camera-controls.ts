import type { FreeCamera } from "./free-camera.js";
import type { SceneContext } from "../scene/scene.js";

/** Keyboard customization for {@link attachConfigurableFreeControl}. */
export interface FreeCameraControlOptions {
    /** Vertical-up key codes. Defaults to Space and PageUp. */
    upKeys?: readonly string[];
    /** Vertical-down key codes. Defaults to ShiftLeft, ShiftRight, and PageDown. */
    downKeys?: readonly string[];
    /** Held key codes that multiply movement speed. */
    fastKeys?: readonly string[];
    /** Movement-speed multiplier while a fast key is held. Defaults to 1. */
    fastMultiplier?: number;
}

/** Attach opt-in configurable keyboard and mouse controls to a free camera. */
export function attachConfigurableFreeControl(camera: FreeCamera, canvas: HTMLCanvasElement, scene?: SceneContext, options: FreeCameraControlOptions = {}): () => void {
    let directionX = 0;
    let directionY = 0;
    let directionZ = 0;
    let rotationX = 0;
    let rotationY = 0;
    let isDragging = false;
    let lastPointerX = 0;
    let lastPointerY = 0;
    const keys = new Set<string>();
    const upKeys = options.upKeys ?? ["Space", "PageUp"];
    const downKeys = options.downKeys ?? ["ShiftLeft", "ShiftRight", "PageDown"];
    const fastKeys = options.fastKeys ?? [];
    const fastMultiplier = options.fastMultiplier ?? 1;

    const hasAny = (codes: readonly string[]): boolean => {
        for (const code of codes) {
            if (keys.has(code)) {
                return true;
            }
        }
        return false;
    };

    function onPointerDown(event: PointerEvent): void {
        if (event.button === 0 || event.button === 1 || event.button === 2) {
            canvas.setPointerCapture(event.pointerId);
            isDragging = true;
            lastPointerX = event.clientX;
            lastPointerY = event.clientY;
        }
    }

    function onPointerMove(event: PointerEvent): void {
        if (!isDragging) {
            return;
        }
        const deltaX = event.clientX - lastPointerX;
        const deltaY = event.clientY - lastPointerY;
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
        rotationY += deltaX / camera.angularSensitivity;
        rotationX += deltaY / camera.angularSensitivity;
    }

    function onPointerUp(event: PointerEvent): void {
        canvas.releasePointerCapture(event.pointerId);
        isDragging = false;
    }

    function onContextMenu(event: Event): void {
        event.preventDefault();
    }

    function onKeyDown(event: KeyboardEvent): void {
        keys.add(event.code);
    }

    function onKeyUp(event: KeyboardEvent): void {
        keys.delete(event.code);
    }

    function update(deltaMs: number): void {
        const dt = Math.max(deltaMs, 1);
        const moveSpeed = camera.speed * (hasAny(fastKeys) ? fastMultiplier : 1) * Math.sqrt((dt * dt) / 100000);

        if (keys.has("KeyW") || keys.has("ArrowUp")) {
            directionZ += moveSpeed;
        }
        if (keys.has("KeyS") || keys.has("ArrowDown")) {
            directionZ -= moveSpeed;
        }
        if (keys.has("KeyA") || keys.has("ArrowLeft")) {
            directionX -= moveSpeed;
        }
        if (keys.has("KeyD") || keys.has("ArrowRight")) {
            directionX += moveSpeed;
        }
        if (hasAny(upKeys)) {
            directionY += moveSpeed;
        }
        if (hasAny(downKeys)) {
            directionY -= moveSpeed;
        }

        const hasMovement = directionX !== 0 || directionY !== 0 || directionZ !== 0;
        const hasRotation = rotationX !== 0 || rotationY !== 0;

        if (hasRotation) {
            camera._yaw += rotationY;
            camera._pitch -= rotationX;
            const maxPitch = Math.PI / 2 - 0.01;
            camera._pitch = Math.max(-maxPitch, Math.min(maxPitch, camera._pitch));
        }

        if (hasMovement) {
            const cosYaw = Math.cos(camera._yaw);
            const sinYaw = Math.sin(camera._yaw);
            const cosPitch = Math.cos(camera._pitch);
            const sinPitch = Math.sin(camera._pitch);
            camera.position.x += sinYaw * cosPitch * directionZ + cosYaw * directionX;
            camera.position.y += sinPitch * directionZ + directionY;
            camera.position.z += cosYaw * cosPitch * directionZ - sinYaw * directionX;
        }

        if (hasMovement || hasRotation) {
            const cosYaw = Math.cos(camera._yaw);
            const sinYaw = Math.sin(camera._yaw);
            const cosPitch = Math.cos(camera._pitch);
            camera.target.set(camera.position.x + sinYaw * cosPitch, camera.position.y + Math.sin(camera._pitch), camera.position.z + cosYaw * cosPitch);
        }

        const inertia = camera.inertia;
        const moveEpsilon = camera.speed * 0.001;
        const rotationEpsilon = camera.speed * 0.001;
        directionX *= inertia;
        directionY *= inertia;
        directionZ *= inertia;
        rotationX *= inertia;
        rotationY *= inertia;
        if (Math.abs(directionX) < moveEpsilon) {
            directionX = 0;
        }
        if (Math.abs(directionY) < moveEpsilon) {
            directionY = 0;
        }
        if (Math.abs(directionZ) < moveEpsilon) {
            directionZ = 0;
        }
        if (Math.abs(rotationX) < rotationEpsilon) {
            rotationX = 0;
        }
        if (Math.abs(rotationY) < rotationEpsilon) {
            rotationY = 0;
        }
    }

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
            const index = scene._beforeRender.indexOf(update);
            if (index >= 0) {
                scene._beforeRender.splice(index, 1);
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
