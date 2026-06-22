import type { ArcRotateCamera } from "./arc-rotate.js";
import type { SceneContext } from "../scene/scene.js";

/**
 * Optional hooks that let an {@link attachControl} caller defer pointer
 * gestures to an external interactor (typically a gizmo pointer-drag
 * dispatcher) so the camera doesn't orbit when the user is interacting with
 * something else on top of it.  All fields are optional; omit them to keep
 * the default behavior (the camera always handles its own pointer input).
 */
export interface AttachControlOptions {
    /** Optional predicate consulted on every pointer-down.  When it returns
     *  false the camera ignores that gesture (no rotate / pan).  Used to defer
     *  to gizmo interaction so pressing or dragging a gizmo doesn't also orbit
     *  the camera. */
    shouldHandlePointerDown?: (event: PointerEvent) => boolean;
    /** Optional predicate consulted on pointer-move while a camera drag is in
     *  progress.  When it returns true the camera ABORTS the current drag.
     *  Because gizmo picking is async, a press on a gizmo may not be known at
     *  pointer-down time (so the camera optimistically starts orbiting); once
     *  the gizmo drag is recognised a frame later this lets the gizmo reclaim
     *  the gesture and undo the (not-yet-applied) orbit. */
    isExternalDragActive?: () => boolean;
    /** Optional predicate consulted on pointer-move.  While it returns true the
     *  camera DEFERS its orbit (consumes the move without applying it) — used
     *  to wait out an in-flight async gizmo pick so a press that lands on a
     *  gizmo never produces a stray orbit, regardless of pick latency. */
    isExternalPickPending?: () => boolean;
}

/** Orbit limits for an {@link ArcRotateCamera}. Omit a field to leave that bound
 *  unbounded; pass an explicit `undefined` to clear a previously-set bound. */
export interface ArcRotateCameraLimits {
    /** Minimum alpha (orbit) angle, radians. */
    lowerAlphaLimit?: number;
    /** Maximum alpha (orbit) angle, radians. */
    upperAlphaLimit?: number;
    /** Minimum beta (elevation) angle, radians. */
    lowerBetaLimit?: number;
    /** Maximum beta (elevation) angle, radians. */
    upperBetaLimit?: number;
    /** Minimum radius (closest zoom). */
    lowerRadiusLimit?: number;
    /** Maximum radius (farthest zoom). */
    upperRadiusLimit?: number;
}

/**
 * Clamp a camera's alpha/beta/radius into its configured limits in place, zeroing
 * the matching inertial offset when a bound is hit so momentum can't keep driving
 * into the wall (the source of the overshoot-then-snap "jiggle"). A bound only
 * applies when it is explicitly set, so limit-free cameras are left untouched.
 */
function clampCameraToLimits(camera: ArcRotateCamera): void {
    if (camera.lowerRadiusLimit !== undefined && camera.radius < camera.lowerRadiusLimit) {
        camera.radius = camera.lowerRadiusLimit;
        camera.inertialRadiusOffset = 0;
    } else if (camera.upperRadiusLimit !== undefined && camera.radius > camera.upperRadiusLimit) {
        camera.radius = camera.upperRadiusLimit;
        camera.inertialRadiusOffset = 0;
    }

    if (camera.lowerBetaLimit !== undefined && camera.beta < camera.lowerBetaLimit) {
        camera.beta = camera.lowerBetaLimit;
        camera.inertialBetaOffset = 0;
    } else if (camera.upperBetaLimit !== undefined && camera.beta > camera.upperBetaLimit) {
        camera.beta = camera.upperBetaLimit;
        camera.inertialBetaOffset = 0;
    }

    if (camera.lowerAlphaLimit !== undefined && camera.alpha < camera.lowerAlphaLimit) {
        camera.alpha = camera.lowerAlphaLimit;
        camera.inertialAlphaOffset = 0;
    } else if (camera.upperAlphaLimit !== undefined && camera.alpha > camera.upperAlphaLimit) {
        camera.alpha = camera.upperAlphaLimit;
        camera.inertialAlphaOffset = 0;
    }
}

/**
 * Configure orbit/zoom limits on an ArcRotateCamera. This is fully opt-in and
 * self-contained: cameras that never call it pay zero cost and bundle no clamping
 * code (the camera's scalar setters call an undefined hook).
 *
 * What it does:
 *  1. Stores the provided bounds on the camera and clamps the current pose into
 *     range right away (inertia zeroed), so enabling limits never causes a jump.
 *  2. Installs a self-clamp hook on the camera (`_clampToLimits`). The
 *     alpha/beta/radius setters invoke it on every mutation, so any caller —
 *     pinch direct-write, inertial overshoot, auto-rotate — is snapped back to
 *     the wall in the same statement that pushed past it. The camera is therefore
 *     never observably out of bounds at any point a per-frame callback reads it
 *     (e.g. a camera-pinned skybox), eliminating both the overshoot-then-snap
 *     jiggle and the one-frame clip "blink" of a deferred per-frame clamp.
 *
 * Only the fields present on `limits` are written, so calls compose; pass a field
 * as `undefined` to remove that bound. Returns a disposer that removes the
 * self-clamp hook.
 *
 * The optional `scene` parameter is accepted for backward compatibility and is
 * unused — enforcement no longer needs a per-frame scene hook.
 */
export function setCameraLimits(camera: ArcRotateCamera, limits: ArcRotateCameraLimits, scene?: SceneContext): () => void {
    void scene; // accepted for backward compatibility; no per-frame scene hook is needed anymore
    if ("lowerAlphaLimit" in limits) {
        camera.lowerAlphaLimit = limits.lowerAlphaLimit;
    }
    if ("upperAlphaLimit" in limits) {
        camera.upperAlphaLimit = limits.upperAlphaLimit;
    }
    if ("lowerBetaLimit" in limits) {
        camera.lowerBetaLimit = limits.lowerBetaLimit;
    }
    if ("upperBetaLimit" in limits) {
        camera.upperBetaLimit = limits.upperBetaLimit;
    }
    if ("lowerRadiusLimit" in limits) {
        camera.lowerRadiusLimit = limits.lowerRadiusLimit;
    }
    if ("upperRadiusLimit" in limits) {
        camera.upperRadiusLimit = limits.upperRadiusLimit;
    }
    // Install the self-clamp hook the camera's setters call on every move, then
    // clamp the current pose once. The hook reference lives only on the limits
    // path, so cameras that never call setCameraLimits pull none of
    // clampCameraToLimits into their bundle. Re-entrancy is bounded: clamping a
    // value writes it to exactly the bound, and the re-triggered hook finds it
    // already in range and stops.
    const enforce = (): void => clampCameraToLimits(camera);
    camera._clampToLimits = enforce;
    enforce();

    return () => {
        if (camera._clampToLimits === enforce) {
            camera._clampToLimits = undefined;
        }
    };
}

/**
 * Attach orbit/zoom/pan controls to an ArcRotateCamera.
 * Matches Babylon.js ArcRotateCameraPointersInput behavior with inertia:
 * - Left-drag: rotate (alpha/beta) with momentum
 * - Right-drag: pan (shift target) with momentum
 * - Wheel: zoom (radius) with momentum
 * - Pinch: zoom (touch, direct — no inertia)
 *
 * Input handlers accumulate into the camera's inertial offset properties.
 * Inertia is applied each frame via scene._beforeRender (the engine's render
 * loop); a scene is required for inertia, there is no standalone rAF fallback.
 *
 * Orbit/zoom limits are entirely opt-in via {@link setCameraLimits}; the camera
 * self-clamps in its setters, so this loop carries no limit code.
 *
 * Camera stays plain data — this function reads/writes its properties.
 * Returns a cleanup function to remove all listeners and the beforeRender hook.
 */
export function attachControl(camera: ArcRotateCamera, canvas: HTMLCanvasElement, scene?: SceneContext, options?: AttachControlOptions): () => void {
    const angularSensibility = camera.angularSensibility ?? 1000; // Babylon default; HIGHER = slower orbit
    const panningSensibility = camera.panningSensibility ?? 50; // Babylon default (pixels per unit); LOWER = faster pan
    const wheelPrecision = camera.wheelPrecision ?? 3; // Babylon default; HIGHER = slower zoom

    const ROTATION_EPSILON = 0.001;
    const RADIUS_EPSILON = 0.001;
    const PANNING_EPSILON = 0.0001;

    let isDragging = false;
    let isPanning = false;
    let lastX = 0;
    let lastY = 0;

    // Touch state for pinch-zoom
    const activeTouches = new Map<number, { x: number; y: number }>();
    let pinchStartDist = 0;
    let pinchStartRadius = 0;

    function onPointerDown(e: PointerEvent): void {
        // Defer to gizmo interaction (or any other guard) when requested — the
        // camera shouldn't orbit when the press lands on a gizmo.
        if (options?.shouldHandlePointerDown && !options.shouldHandlePointerDown(e)) {
            return;
        }
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
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;

        // While two (or more) fingers are down the gesture is a pinch: the touch
        // handler drives zoom, so suppress the pointer-driven rotate/pan that the
        // first finger would otherwise trigger (they'd fight each other). lastX/Y
        // are still tracked above so the remaining finger doesn't jump on release.
        if (activeTouches.size >= 2) {
            return;
        }

        if (!isDragging && !isPanning) {
            return;
        }

        // A gizmo drag was recognised (asynchronously) after we optimistically
        // started orbiting — abort and discard any pending inertial offset so
        // the camera doesn't move on top of the gizmo interaction.
        if (options?.isExternalDragActive?.()) {
            isDragging = false;
            isPanning = false;
            camera.inertialAlphaOffset = 0;
            camera.inertialBetaOffset = 0;
            camera.inertialPanningX = 0;
            camera.inertialPanningY = 0;
            return;
        }
        // A gizmo pointer-down pick is still in flight — defer (consume this
        // move without orbiting) until we know whether the press hit a gizmo.
        // lastX/Y are already advanced above so no delta is applied once it
        // resolves.
        if (options?.isExternalPickPending?.()) {
            return;
        }

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
        if (activeTouches.size >= 2) {
            // A second finger landed: this is a pinch, not a rotate. Cancel any
            // in-progress pointer rotate/pan so the gesture only zooms, and stop
            // the browser from hijacking the two-finger gesture as a page zoom
            // (iOS Safari ignores touch-action:none for pinch-zoom).
            isDragging = false;
            isPanning = false;
            const iter = activeTouches.values();
            const p0 = iter.next().value!;
            const p1 = iter.next().value!;
            pinchStartDist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
            pinchStartRadius = camera.radius;
            e.preventDefault();
        }
    }

    function onTouchMove(e: TouchEvent): void {
        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i]!;
            activeTouches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
        }
        if (activeTouches.size >= 2) {
            // Prevent the browser's native pinch-to-zoom (page zoom on iOS) so the
            // gesture drives the camera radius instead.
            e.preventDefault();
            const iter = activeTouches.values();
            const p0 = iter.next().value!;
            const p1 = iter.next().value!;
            const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
            if (pinchStartDist > 0 && dist > 0) {
                // Direct write — the camera's radius setter self-clamps to any
                // configured orbit limits, so no transient out-of-bounds value
                // is ever visible to a per-frame reader.
                camera.radius = pinchStartRadius * (pinchStartDist / dist);
                camera.radius = Math.max(0.01, camera.radius);
            }
        }
    }

    function onTouchEnd(e: TouchEvent): void {
        for (let i = 0; i < e.changedTouches.length; i++) {
            activeTouches.delete(e.changedTouches[i]!.identifier);
        }
        // Returning to a single finger: reseat the rotate origin on the remaining
        // touch so it doesn't jump, and end the pinch.
        if (activeTouches.size === 1) {
            const p = activeTouches.values().next().value!;
            lastX = p.x;
            lastY = p.y;
        }
        if (activeTouches.size < 2) {
            pinchStartDist = 0;
        }
    }

    // iOS Safari fires non-standard gesture* events for pinch and still zooms the
    // page even with touch-action:none; preventing them keeps the gesture for the
    // camera. (No-op on browsers that don't emit these events.)
    function onGesture(e: Event): void {
        e.preventDefault();
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
    }

    // Inertia is integrated once per frame from the scene's render loop. Callers
    // always supply a scene; without one the camera is simply static (no inertia),
    // matching free-camera-controls — there is no standalone rAF fallback.
    if (scene) {
        scene._beforeRender.push(applyInertia);
    }

    const listeners: [string, EventListener, AddEventListenerOptions?][] = [
        ["pointerdown", onPointerDown as EventListener],
        ["pointermove", onPointerMove as EventListener],
        ["pointerup", onPointerUp as EventListener],
        ["wheel", onWheel as EventListener, { passive: false }],
        ["contextmenu", onContextMenu as EventListener],
        ["touchstart", onTouchStart as EventListener, { passive: false }],
        ["touchmove", onTouchMove as EventListener, { passive: false }],
        ["touchend", onTouchEnd as EventListener],
        ["gesturestart", onGesture as EventListener, { passive: false }],
        ["gesturechange", onGesture as EventListener, { passive: false }],
        ["gestureend", onGesture as EventListener, { passive: false }],
    ];
    for (const [ev, h, opts] of listeners) {
        canvas.addEventListener(ev, h, opts);
    }

    return () => {
        if (scene) {
            const idx = scene._beforeRender.indexOf(applyInertia);
            if (idx >= 0) {
                scene._beforeRender.splice(idx, 1);
            }
        }
        for (const [ev, h] of listeners) {
            canvas.removeEventListener(ev, h);
        }
    };
}
