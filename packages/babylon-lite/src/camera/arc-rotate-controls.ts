import type { ArcRotateCamera } from "./arc-rotate.js";
import type { SceneContext, SceneContextInternal } from "../scene/scene.js";

/**
 * Attach orbit/zoom/pan controls to an ArcRotateCamera.
 * Matches Babylon.js ArcRotateCameraPointersInput behavior with inertia:
 * - Left-drag: rotate (alpha/beta) with momentum
 * - Right-drag: pan (shift target) with momentum
 * - Wheel: zoom (radius) with momentum
 * - Pinch: zoom (touch, direct — no inertia)
 *
 * Input handlers accumulate into the camera's inertial offset properties.
 * Inertia is applied each frame via scene._beforeRender (single RAF loop).
 *
 * Camera stays plain data — this function reads/writes its properties.
 * Returns a cleanup function to remove all listeners and the beforeRender hook.
 */
export function attachControl(camera: ArcRotateCamera, canvas: HTMLCanvasElement, scene?: SceneContext): () => void {
    const angularSensibility = 1000; // Babylon default
    const panningSensibility = 50; // Babylon default (pixels per unit)
    const wheelPrecision = 3; // Babylon default

    const ROTATION_EPSILON = 0.001;
    const RADIUS_EPSILON = 0.001;
    const PANNING_EPSILON = 0.0001;

    let isDragging = false;
    let isPanning = false;
    let lastX = 0;
    let lastY = 0;
    let animFrameId = 0;

    // Touch state for pinch-zoom
    const activeTouches = new Map<number, { x: number; y: number }>();
    let pinchStartDist = 0;
    let pinchStartRadius = 0;

    function onPointerDown(e: PointerEvent): void {
        canvas.setPointerCapture(e.pointerId);
        lastX = e.clientX;
        lastY = e.clientY;

        if (e.button === 0) {
            isDragging = true;
            isPanning = false;
        } else if (e.button === 2) {
            isDragging = false;
            isPanning = true;
        }
    }

    function onPointerMove(e: PointerEvent): void {
        if (!isDragging && !isPanning) {
            return;
        }

        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;

        if (isDragging) {
            camera.inertialAlphaOffset -= dx / angularSensibility;
            camera.inertialBetaOffset -= dy / angularSensibility;
        }

        if (isPanning) {
            camera.inertialPanningX += -dx / panningSensibility;
            camera.inertialPanningY += dy / panningSensibility;
        }
    }

    function onPointerUp(e: PointerEvent): void {
        canvas.releasePointerCapture(e.pointerId);
        isDragging = false;
        isPanning = false;
    }

    function onWheel(e: WheelEvent): void {
        e.preventDefault();
        // Scale by current radius for logarithmic zoom feel
        camera.inertialRadiusOffset -= (e.deltaY * camera.radius) / (wheelPrecision * 1000);
    }

    function onContextMenu(e: Event): void {
        e.preventDefault();
    }

    function onTouchStart(e: TouchEvent): void {
        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i]!;
            activeTouches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
        }
        if (activeTouches.size === 2) {
            const iter = activeTouches.values();
            const p0 = iter.next().value!;
            const p1 = iter.next().value!;
            pinchStartDist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
            pinchStartRadius = camera.radius;
        }
    }

    function onTouchMove(e: TouchEvent): void {
        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i]!;
            activeTouches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
        }
        if (activeTouches.size === 2) {
            const iter = activeTouches.values();
            const p0 = iter.next().value!;
            const p1 = iter.next().value!;
            const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
            if (pinchStartDist > 0) {
                camera.radius = pinchStartRadius * (pinchStartDist / dist);
                camera.radius = Math.max(0.01, camera.radius);
            }
        }
    }

    function onTouchEnd(e: TouchEvent): void {
        for (let i = 0; i < e.changedTouches.length; i++) {
            activeTouches.delete(e.changedTouches[i]!.identifier);
        }
    }

    /** Per-frame: apply inertial offsets to camera properties and decay them. */
    function applyInertia(): void {
        // --- Rotation inertia ---
        if (camera.inertialAlphaOffset !== 0 || camera.inertialBetaOffset !== 0) {
            camera.alpha += camera.inertialAlphaOffset;
            camera.beta += camera.inertialBetaOffset;

            const eps = 0.01;
            camera.beta = Math.max(eps, Math.min(Math.PI - eps, camera.beta));

            camera.inertialAlphaOffset *= camera.inertia;
            camera.inertialBetaOffset *= camera.inertia;

            if (Math.abs(camera.inertialAlphaOffset) < ROTATION_EPSILON) {
                camera.inertialAlphaOffset = 0;
            }
            if (Math.abs(camera.inertialBetaOffset) < ROTATION_EPSILON) {
                camera.inertialBetaOffset = 0;
            }
        }

        // --- Zoom inertia ---
        if (camera.inertialRadiusOffset !== 0) {
            camera.radius -= camera.inertialRadiusOffset;
            camera.radius = Math.max(0.01, camera.radius);

            camera.inertialRadiusOffset *= camera.inertia;

            if (Math.abs(camera.inertialRadiusOffset) < RADIUS_EPSILON) {
                camera.inertialRadiusOffset = 0;
            }
        }

        // --- Panning inertia ---
        if (camera.inertialPanningX !== 0 || camera.inertialPanningY !== 0) {
            const cosA = Math.cos(camera.alpha);
            const sinA = Math.sin(camera.alpha);
            const rightX = -sinA;
            const rightZ = cosA;
            const panScale = camera.radius * 0.001;

            // Mutate in-place via ObservableVec3 — avoids object allocation per frame.
            // Individual setters each call onDirty (just version++), but that's cheaper than reallocating.
            camera.target.x += rightX * camera.inertialPanningX * panScale;
            camera.target.y += camera.inertialPanningY * panScale;
            camera.target.z += rightZ * camera.inertialPanningX * panScale;

            camera.inertialPanningX *= camera.panningInertia;
            camera.inertialPanningY *= camera.panningInertia;

            if (Math.abs(camera.inertialPanningX) < PANNING_EPSILON) {
                camera.inertialPanningX = 0;
            }
            if (Math.abs(camera.inertialPanningY) < PANNING_EPSILON) {
                camera.inertialPanningY = 0;
            }
        }

        // Only self-reschedule in fallback mode (own RAF loop)
        if (!scene) {
            animFrameId = requestAnimationFrame(applyInertia);
        }
    }

    if (scene) {
        // Hook into the engine's render loop — single RAF chain
        (scene as SceneContextInternal)._beforeRender.push(applyInertia);
    } else {
        // Fallback: own RAF loop (for callers that don't pass scene)
        animFrameId = requestAnimationFrame(applyInertia);
    }

    const listeners: [string, EventListener, AddEventListenerOptions?][] = [
        ["pointerdown", onPointerDown as EventListener],
        ["pointermove", onPointerMove as EventListener],
        ["pointerup", onPointerUp as EventListener],
        ["wheel", onWheel as EventListener, { passive: false }],
        ["contextmenu", onContextMenu as EventListener],
        ["touchstart", onTouchStart as EventListener, { passive: true }],
        ["touchmove", onTouchMove as EventListener, { passive: true }],
        ["touchend", onTouchEnd as EventListener],
    ];
    for (const [ev, h, opts] of listeners) {
        canvas.addEventListener(ev, h, opts);
    }

    return () => {
        if (animFrameId) {
            cancelAnimationFrame(animFrameId);
        }
        if (scene) {
            const idx = (scene as SceneContextInternal)._beforeRender.indexOf(applyInertia);
            if (idx >= 0) {
                (scene as SceneContextInternal)._beforeRender.splice(idx, 1);
            }
        }
        for (const [ev, h] of listeners) {
            canvas.removeEventListener(ev, h);
        }
    };
}
