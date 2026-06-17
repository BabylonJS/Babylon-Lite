import type { GeospatialCamera } from "./geospatial-camera.js";
import { computeLocalBasis, computeYawPitchFromLookAt } from "./geospatial-camera.js";
import { clampZoomDistance, GEO_EPSILON } from "./geospatial-limits.js";
import { getViewProjectionMatrix } from "./camera.js";
import { createPickingRay } from "../picking/ray.js";
import { mat4Invert } from "../math/mat4-invert.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Vec3, Mat4, Mat4Storage } from "../math/types.js";
import { REFERENCE_FRAME_RATE, integrateInertialVelocity, computePanSpeedMultiplier, computeZoomSpeedMultiplier } from "./geospatial-movement.js";

/** Options for {@link attachGeospatialControls}. */
export interface GeospatialControlOptions {
    /** When true, zooming moves toward the point under the cursor; otherwise along the look vector. Default true. */
    zoomToCursor?: boolean;
    /** Enable simple sphere collision so the camera cannot dip below the surface. Default false. */
    checkCollisions?: boolean;
}

interface PickResult {
    hit: boolean;
    point: Vec3 | null;
    ray: { origin: Vec3; direction: Vec3 } | null;
}

/**
 * Attach orbit / pan / zoom controls to a {@link GeospatialCamera}, matching
 * Babylon.js `GeospatialCamera` interactions:
 *  - Left-drag: pan (the cursor stays anchored to the globe surface).
 *  - Middle/right-drag: rotate (yaw + pitch / tilt).
 *  - Wheel: zoom (toward the cursor by default).
 *  - Touch: single-finger drag = pan; two-finger pinch = zoom toward the centroid,
 *    promoting to a pan once the centroid drifts ≥ 20 px.
 *  - Keyboard: arrows = pan, Ctrl+arrows = tilt (pitch/yaw), +/- = zoom along the look vector.
 *
 * Movement uses Babylon.js's framerate-independent physics model (velocity +
 * inertial decay). Globe picking is analytic ray-sphere against the planet
 * sphere (origin-centred, radius = `limits.planetRadius`) — no mesh picking
 * subsystem is required. Inertia is integrated once per frame from the scene's
 * render loop (`scene._beforeRender`).
 *
 * Returns a disposer that removes all listeners and the per-frame hook.
 */
export function attachGeospatialControls(camera: GeospatialCamera, canvas: HTMLCanvasElement, scene: SceneContext, options?: GeospatialControlOptions): () => void {
    const zoomToCursor = options?.zoomToCursor ?? true;
    const checkCollisions = options?.checkCollisions ?? false;

    // ── Speed / inertia (Babylon GeospatialCameraMovement defaults) ──
    const speed = 1;
    const panSpeed = 1;
    const rotationXSpeed = Math.PI / 500;
    const rotationYSpeed = Math.PI / 500;
    const zoomSpeed = 2;
    const panInertia = 0;
    const rotationInertia = 0;
    const zoomInertia = 0.9;

    // ── Accumulated input (reset each frame) ──
    const panAccumulated: Vec3 = { x: 0, y: 0, z: 0 };
    const rotationAccumulated = { x: 0, y: 0 }; // x = pitch pixels, y = yaw pixels
    let zoomAccumulated = 0;
    let activeInput = false;

    // ── Velocities (for inertia) ──
    const panVelocity: Vec3 = { x: 0, y: 0, z: 0 };
    const rotationVelocity = { x: 0, y: 0 };
    let zoomVelocity = 0;
    let prevFrameTimeMs = 0;

    // ── Per-frame multipliers ──
    let panSpeedMultiplier = 1;
    let zoomSpeedMultiplier = 1;

    // ── Per-frame computed deltas ──
    const panDelta: Vec3 = { x: 0, y: 0, z: 0 };
    const rotationDelta = { x: 0, y: 0 };
    let zoomDelta = 0;
    let computedZoomPickPoint: Vec3 | null = null;

    // ── Drag (pan) state ──
    let hitPointRadius: number | undefined;
    const dragPlaneNormal: Vec3 = { x: 0, y: 0, z: 0 };
    const dragPlaneOriginEcef: Vec3 = { x: 0, y: 0, z: 0 };
    const dragPlaneHitPointLocal: Vec3 = { x: 0, y: 0, z: 0 };
    const previousDragPlaneHitPointLocal: Vec3 = { x: 0, y: 0, z: 0 };

    // ── Pointer state ──
    let pointerX = 0;
    let pointerY = 0;
    let mode: "none" | "pan" | "rotate" = "none";
    let lastX = 0;
    let lastY = 0;
    const keysDown = new Set<string>();

    // ── Touch (pinch) state ──
    const activeTouches = new Map<number, { x: number; y: number }>();
    let pinchPrevDist = 0;
    let pinchStartCentroidX = 0;
    let pinchStartCentroidY = 0;
    let pinchPanning = false;
    const PINCH_PAN_THRESHOLD = 20; // px of centroid translation before a pinch also pans
    const PINCH_ZOOM_SCALE = 0.05; // pixels of finger-spread → zoom-accumulator units

    function rectSize(): { width: number; height: number } {
        const r = canvas.getBoundingClientRect();
        return { width: r.width || canvas.width, height: r.height || canvas.height };
    }

    function toCanvas(e: PointerEvent | WheelEvent): void {
        const r = canvas.getBoundingClientRect();
        pointerX = e.clientX - r.left;
        pointerY = e.clientY - r.top;
    }

    // ── Picking (analytic ray-sphere against the planet) ──

    function screenRay(x: number, y: number): { origin: Vec3; direction: Vec3 } | null {
        const { width, height } = rectSize();
        const vp = getViewProjectionMatrix(camera, width / height);
        const ray = createPickingRay(x, y, vp, width, height);
        if (!ray) {
            return null;
        }
        return { origin: { x: ray.origin[0], y: ray.origin[1], z: ray.origin[2] }, direction: { x: ray.direction[0], y: ray.direction[1], z: ray.direction[2] } };
    }

    /** Nearest positive intersection of a ray with the planet sphere (centre origin). */
    function intersectPlanet(origin: Vec3, dir: Vec3): Vec3 | null {
        const r = camera.limits.planetRadius;
        const b = 2 * (origin.x * dir.x + origin.y * dir.y + origin.z * dir.z);
        const c = origin.x * origin.x + origin.y * origin.y + origin.z * origin.z - r * r;
        const disc = b * b - 4 * c;
        if (disc < 0) {
            return null;
        }
        const sq = Math.sqrt(disc);
        let t = (-b - sq) / 2;
        if (t < 0) {
            t = (-b + sq) / 2;
        }
        if (t < 0) {
            return null;
        }
        return { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
    }

    function pickScreen(x: number, y: number): PickResult {
        const ray = screenRay(x, y);
        if (!ray) {
            return { hit: false, point: null, ray: null };
        }
        const point = intersectPlanet(ray.origin, ray.direction);
        return { hit: !!point, point, ray };
    }

    function pickAlongVector(dir: Vec3): Vec3 | null {
        return intersectPlanet(camera.position, dir);
    }

    // ── Pan (drag-plane) math ──

    function recalcDragPlaneHitPoint(radius: number, ray: { origin: Vec3; direction: Vec3 }, localToEcef: Mat4Storage): void {
        const posLen = Math.max(1e-5, Math.hypot(camera.position.x, camera.position.y, camera.position.z));
        const s = radius / posLen;
        dragPlaneOriginEcef.x = camera.position.x * s;
        dragPlaneOriginEcef.y = camera.position.y * s;
        dragPlaneOriginEcef.z = camera.position.z * s;

        const east: Vec3 = { x: 0, y: 0, z: 0 };
        const north: Vec3 = { x: 0, y: 0, z: 0 };
        computeLocalBasis(dragPlaneOriginEcef, east, north, dragPlaneNormal);

        // localToEcef = columns [east, north, up] + translation origin.
        localToEcef[0] = east.x;
        localToEcef[1] = east.y;
        localToEcef[2] = east.z;
        localToEcef[3] = 0;
        localToEcef[4] = north.x;
        localToEcef[5] = north.y;
        localToEcef[6] = north.z;
        localToEcef[7] = 0;
        localToEcef[8] = dragPlaneNormal.x;
        localToEcef[9] = dragPlaneNormal.y;
        localToEcef[10] = dragPlaneNormal.z;
        localToEcef[11] = 0;
        localToEcef[12] = dragPlaneOriginEcef.x;
        localToEcef[13] = dragPlaneOriginEcef.y;
        localToEcef[14] = dragPlaneOriginEcef.z;
        localToEcef[15] = 1;

        const ecefToLocal = mat4Invert(localToEcef as unknown as Mat4);
        if (!ecefToLocal) {
            return;
        }

        // Plane: normal·P + d = 0, d = -normal·origin.
        const d = -(dragPlaneNormal.x * dragPlaneOriginEcef.x + dragPlaneNormal.y * dragPlaneOriginEcef.y + dragPlaneNormal.z * dragPlaneOriginEcef.z);
        const denom = dragPlaneNormal.x * ray.direction.x + dragPlaneNormal.y * ray.direction.y + dragPlaneNormal.z * ray.direction.z;
        if (Math.abs(denom) > 1e-9) {
            const t = -(dragPlaneNormal.x * ray.origin.x + dragPlaneNormal.y * ray.origin.y + dragPlaneNormal.z * ray.origin.z + d) / denom;
            if (t >= 0) {
                const hx = ray.origin.x + ray.direction.x * t;
                const hy = ray.origin.y + ray.direction.y * t;
                const hz = ray.origin.z + ray.direction.z * t;
                transformCoordinates(hx, hy, hz, ecefToLocal as unknown as Mat4Storage, dragPlaneHitPointLocal);
            }
        }
    }

    function startDrag(x: number, y: number): void {
        const pick = pickScreen(x, y);
        if (pick.point && pick.ray) {
            hitPointRadius = Math.hypot(pick.point.x, pick.point.y, pick.point.z);
            const tmp = scratchMat;
            recalcDragPlaneHitPoint(hitPointRadius, pick.ray, tmp);
            previousDragPlaneHitPointLocal.x = dragPlaneHitPointLocal.x;
            previousDragPlaneHitPointLocal.y = dragPlaneHitPointLocal.y;
            previousDragPlaneHitPointLocal.z = dragPlaneHitPointLocal.z;
        } else {
            hitPointRadius = undefined;
        }
    }

    function handleDrag(x: number, y: number): void {
        if (hitPointRadius === undefined) {
            return;
        }
        const ray = screenRay(x, y);
        if (!ray) {
            return;
        }
        const localToEcef = scratchMat;
        recalcDragPlaneHitPoint(hitPointRadius, ray, localToEcef);

        let dx = dragPlaneHitPointLocal.x - previousDragPlaneHitPointLocal.x;
        let dy = dragPlaneHitPointLocal.y - previousDragPlaneHitPointLocal.y;
        let dz = dragPlaneHitPointLocal.z - previousDragPlaneHitPointLocal.z;

        // Clamp to avoid huge jumps when the camera is nearly parallel to the plane.
        const maxDelta = hitPointRadius * 0.1;
        const len = Math.hypot(dx, dy, dz);
        if (len > maxDelta) {
            const k = maxDelta / len;
            dx *= k;
            dy *= k;
            dz *= k;
        }

        previousDragPlaneHitPointLocal.x = dragPlaneHitPointLocal.x;
        previousDragPlaneHitPointLocal.y = dragPlaneHitPointLocal.y;
        previousDragPlaneHitPointLocal.z = dragPlaneHitPointLocal.z;

        // delta (local) → ECEF normal transform.
        const ex = dx * localToEcef[0]! + dy * localToEcef[4]! + dz * localToEcef[8]!;
        const ey = dx * localToEcef[1]! + dy * localToEcef[5]! + dz * localToEcef[9]!;
        const ez = dx * localToEcef[2]! + dy * localToEcef[6]! + dz * localToEcef[10]!;

        dragPlaneOriginEcef.x += ex;
        dragPlaneOriginEcef.y += ey;
        dragPlaneOriginEcef.z += ez;

        panAccumulated.x -= ex;
        panAccumulated.y -= ey;
        panAccumulated.z -= ez;
    }

    function stopDrag(): void {
        hitPointRadius = undefined;
    }

    const scratchMat = new Float32Array(16) as unknown as Mat4Storage;

    // ── Zoom input ──

    function handleZoom(delta: number, toCursor: boolean): void {
        if (delta === 0) {
            return;
        }
        zoomAccumulated += delta;
        const pick = pickScreen(pointerX, pointerY);
        if (toCursor && pick.hit && pick.point && zoomToCursor) {
            computedZoomPickPoint = pick.point;
        } else {
            computedZoomPickPoint = pickAlongVector(camera._lookAt);
        }
    }

    // ── Apply per-frame deltas to the camera ──

    function applyGeocentricTranslation(): void {
        const cx = camera.center.x + panDelta.x;
        const cy = camera.center.y + panDelta.y;
        const cz = camera.center.z + panDelta.z;
        // Re-project onto the sphere of the same magnitude as the current centre.
        const len = Math.hypot(cx, cy, cz) || 1;
        const target = Math.hypot(camera.center.x, camera.center.y, camera.center.z);
        const k = target / len;
        camera._setOrientation(camera.yaw, camera.pitch, camera.radius, { x: cx * k, y: cy * k, z: cz * k });
    }

    function applyGeocentricRotation(): void {
        if (rotationDelta.x === 0 && rotationDelta.y === 0) {
            return;
        }
        const pitch = rotationDelta.x !== 0 ? clampNum(camera.pitch + rotationDelta.x, 0, 0.5 * Math.PI - GEO_EPSILON) : camera.pitch;
        const yaw = rotationDelta.y !== 0 ? camera.yaw + rotationDelta.y : camera.yaw;
        camera._setOrientation(yaw, pitch, camera.radius, camera.center);
    }

    function centerAndRadiusFromZoomToPoint(target: Vec3, distance: number, out: Vec3): number {
        const limits = camera.limits;
        const dx = target.x - camera.position.x;
        const dy = target.y - camera.position.y;
        const dz = target.z - camera.position.z;
        const distToTarget = Math.hypot(dx, dy, dz);
        if (distToTarget < limits.radiusMin) {
            out.x = camera.center.x;
            out.y = camera.center.y;
            out.z = camera.center.z;
            return clampNum(camera.radius - distance, limits.radiusMin, limits.radiusMax);
        }
        const s = distance / distToTarget;
        const npx = camera.position.x + dx * s;
        const npy = camera.position.y + dy * s;
        const npz = camera.position.z + dz * s;
        const projected = dx * s * camera._lookAt.x + dy * s * camera._lookAt.y + dz * s * camera._lookAt.z;
        const newRadius = clampNum(camera.radius - projected, limits.radiusMin, limits.radiusMax);
        out.x = npx + camera._lookAt.x * newRadius;
        out.y = npy + camera._lookAt.y * newRadius;
        out.z = npz + camera._lookAt.z * newRadius;
        return newRadius;
    }

    const zoomCenterScratch: Vec3 = { x: 0, y: 0, z: 0 };

    function applyZoom(): void {
        const limits = camera.limits;
        const distToTarget = computedZoomPickPoint ? dist(camera.position, computedZoomPickPoint) : undefined;
        const clamped = clampZoomDistance(limits, zoomDelta, camera.radius, distToTarget);
        if (Math.abs(clamped) < GEO_EPSILON) {
            return;
        }
        if (computedZoomPickPoint) {
            const newRadius = centerAndRadiusFromZoomToPoint(computedZoomPickPoint, clamped, zoomCenterScratch);
            camera._setOrientation(camera.yaw, camera.pitch, newRadius, zoomCenterScratch);
        } else {
            const newRadius = clampNum(camera.radius - clamped, limits.radiusMin, limits.radiusMax);
            camera._setOrientation(camera.yaw, camera.pitch, newRadius, camera.center);
        }
    }

    let wasCenterMovingLastFrame = false;

    function recalculateCenter(isCenterMoving: boolean): void {
        const shouldRecalc = wasCenterMovingLastFrame && !isCenterMoving;
        wasCenterMovingLastFrame = isCenterMoving;
        if (!shouldRecalc) {
            return;
        }
        const picked = pickAlongVector(camera._lookAt);
        if (!picked) {
            return;
        }
        const invLen = 1 / (Math.hypot(picked.x, picked.y, picked.z) || 1);
        const dot = camera._lookAt.x * -picked.x * invLen + camera._lookAt.y * -picked.y * invLen + camera._lookAt.z * -picked.z * invLen;
        if (dot <= 0) {
            return;
        }
        const newRadius = dist(camera.position, picked);
        if (newRadius <= GEO_EPSILON) {
            return;
        }
        const yp = { x: 0, y: 0 };
        computeYawPitchFromLookAt(camera._lookAt, picked, camera.yaw, yp);
        camera._setOrientation(yp.x, yp.y, newRadius, picked);
    }

    function applyCollision(): void {
        if (!checkCollisions) {
            return;
        }
        const minDist = camera.limits.planetRadius + camera.limits.radiusMin;
        const posLen = Math.hypot(camera.position.x, camera.position.y, camera.position.z);
        if (posLen >= minDist || posLen < 1e-6) {
            return;
        }
        const lift = minDist - posLen;
        const inv = 1 / posLen;
        const ox = camera.position.x * inv * lift;
        const oy = camera.position.y * inv * lift;
        const oz = camera.position.z * inv * lift;
        // Lift the whole rig: offset the centre, position follows from setOrientation.
        camera._setOrientation(camera.yaw, camera.pitch, camera.radius, { x: camera.center.x + ox, y: camera.center.y + oy, z: camera.center.z + oz });
    }

    // ── Framerate-independent physics ──

    function effectiveDeltaMs(dt: number): number {
        if (dt > 0) {
            return dt;
        }
        if (prevFrameTimeMs > 0) {
            return prevFrameTimeMs;
        }
        return 1000 / REFERENCE_FRAME_RATE;
    }

    function nextVelocity(vel: number, pixelDelta: number, inertia: number, dt: number): number {
        return integrateInertialVelocity(vel, pixelDelta, inertia, effectiveDeltaMs(dt), activeInput);
    }

    function isDragging(): boolean {
        return hitPointRadius !== undefined;
    }

    function computeFrameDeltas(dt: number): void {
        // Pan dampening near the poles and with altitude.
        const center = camera.center;
        if (panAccumulated.x !== 0 || panAccumulated.y !== 0 || panAccumulated.z !== 0) {
            panSpeedMultiplier = computePanSpeedMultiplier(center, camera.position);
        } else {
            panSpeedMultiplier = 1;
        }

        // Zoom speed scales with distance to target; suppressed while dragging/rotating.
        if (isDragging() || rotationAccumulated.x !== 0 || rotationAccumulated.y !== 0) {
            zoomSpeedMultiplier = 0;
            zoomVelocity = 0;
        } else {
            const target = computedZoomPickPoint ? dist(camera.position, computedZoomPickPoint) : dist(camera.position, center);
            zoomSpeedMultiplier = computeZoomSpeedMultiplier(target);
        }

        const eff = effectiveDeltaMs(dt);

        panVelocity.x = nextVelocity(panVelocity.x, panAccumulated.x, panInertia, dt);
        panVelocity.y = nextVelocity(panVelocity.y, panAccumulated.y, panInertia, dt);
        panVelocity.z = nextVelocity(panVelocity.z, panAccumulated.z, panInertia, dt);
        const panScale = speed * panSpeed * panSpeedMultiplier * eff;
        panDelta.x = panVelocity.x * panScale;
        panDelta.y = panVelocity.y * panScale;
        panDelta.z = panVelocity.z * panScale;

        rotationVelocity.x = nextVelocity(rotationVelocity.x, rotationAccumulated.x, rotationInertia, dt);
        rotationVelocity.y = nextVelocity(rotationVelocity.y, rotationAccumulated.y, rotationInertia, dt);
        rotationDelta.x = rotationVelocity.x * speed * rotationXSpeed * eff;
        rotationDelta.y = rotationVelocity.y * speed * rotationYSpeed * eff;

        zoomVelocity = nextVelocity(zoomVelocity, zoomAccumulated, zoomInertia, dt);
        zoomDelta = zoomVelocity * (speed * zoomSpeed * zoomSpeedMultiplier) * eff;

        if (dt > 0) {
            prevFrameTimeMs = dt;
        }
        zoomAccumulated = 0;
        panAccumulated.x = panAccumulated.y = panAccumulated.z = 0;
        rotationAccumulated.x = rotationAccumulated.y = 0;
        activeInput = false;
    }

    // ── Per-frame loop ──

    function onBeforeRenderTick(deltaMs: number): void {
        // Keyboard injects accumulated input before physics.
        pollKeyboard();

        const hasInput =
            panAccumulated.x !== 0 || panAccumulated.y !== 0 || panAccumulated.z !== 0 || rotationAccumulated.x !== 0 || rotationAccumulated.y !== 0 || zoomAccumulated !== 0;
        if (hasInput && camera._cancelFly) {
            camera._cancelFly();
        }

        computeFrameDeltas(deltaMs);

        let isCenterMoving = false;
        if (panDelta.x !== 0 || panDelta.y !== 0 || panDelta.z !== 0) {
            applyGeocentricTranslation();
            isCenterMoving = true;
        }
        if (rotationDelta.x !== 0 || rotationDelta.y !== 0) {
            applyGeocentricRotation();
        }
        if (Math.abs(zoomDelta) > GEO_EPSILON) {
            applyZoom();
            isCenterMoving = true;
        }
        recalculateCenter(isCenterMoving);
        applyCollision();
    }

    // ── Keyboard ──

    function pollKeyboard(): void {
        if (keysDown.size === 0) {
            return;
        }
        activeInput = true;
        const rotateStep = 6; // pixels-equivalent per frame
        const zoomStep = 4;
        const panStep = camera.radius * 0.0015;
        const ctrl = keysDown.has("ControlLeft") || keysDown.has("ControlRight");

        // +/- : zoom along the look vector (no zoom-to-point pick).
        if (keysDown.has("Equal") || keysDown.has("NumpadAdd")) {
            zoomAccumulated += zoomStep;
            computedZoomPickPoint = null;
        }
        if (keysDown.has("Minus") || keysDown.has("NumpadSubtract")) {
            zoomAccumulated -= zoomStep;
            computedZoomPickPoint = null;
        }

        if (ctrl) {
            // Ctrl + arrows: tilt (pitch) and yaw, matching Babylon.js.
            if (keysDown.has("ArrowLeft")) {
                rotationAccumulated.y -= rotateStep;
            }
            if (keysDown.has("ArrowRight")) {
                rotationAccumulated.y += rotateStep;
            }
            if (keysDown.has("ArrowUp")) {
                rotationAccumulated.x += rotateStep;
            }
            if (keysDown.has("ArrowDown")) {
                rotationAccumulated.x -= rotateStep;
            }
            return;
        }

        // Arrows: pan (a drag from the canvas centre). Move the centre along the
        // local tangent basis; Up = north, Right = east.
        const east: Vec3 = { x: 0, y: 0, z: 0 };
        const north: Vec3 = { x: 0, y: 0, z: 0 };
        const up: Vec3 = { x: 0, y: 0, z: 0 };
        let dn = 0;
        let de = 0;
        if (keysDown.has("ArrowUp")) {
            dn += 1;
        }
        if (keysDown.has("ArrowDown")) {
            dn -= 1;
        }
        if (keysDown.has("ArrowRight")) {
            de += 1;
        }
        if (keysDown.has("ArrowLeft")) {
            de -= 1;
        }
        if (dn !== 0 || de !== 0) {
            computeLocalBasis(camera.center, east, north, up);
            panAccumulated.x += (north.x * dn + east.x * de) * panStep;
            panAccumulated.y += (north.y * dn + east.y * de) * panStep;
            panAccumulated.z += (north.z * dn + east.z * de) * panStep;
        }
    }

    // ── DOM listeners ──

    function onPointerDown(e: PointerEvent): void {
        canvas.setPointerCapture(e.pointerId);
        toCanvas(e);
        lastX = e.clientX;
        lastY = e.clientY;
        if (e.button === 0) {
            mode = "pan";
            startDrag(pointerX, pointerY);
        } else {
            mode = "rotate";
        }
    }

    function onPointerMove(e: PointerEvent): void {
        toCanvas(e);
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        // While two fingers are down the gesture is a pinch (handled by the touch
        // listeners); suppress the pointer-driven pan/rotate the first finger would
        // otherwise trigger. lastX/Y above stay current so the remaining finger
        // doesn't jump when one lifts.
        if (activeTouches.size >= 2) {
            return;
        }
        if (mode === "none") {
            return;
        }
        activeInput = true;
        if (mode === "pan") {
            handleDrag(pointerX, pointerY);
        } else if (mode === "rotate") {
            rotationAccumulated.y += dx; // yaw
            rotationAccumulated.x += dy; // pitch
        }
    }

    function onPointerUp(e: PointerEvent): void {
        canvas.releasePointerCapture(e.pointerId);
        if (mode === "pan") {
            stopDrag();
        }
        mode = "none";
    }

    function onWheel(e: WheelEvent): void {
        e.preventDefault();
        toCanvas(e);
        handleZoom(-Math.sign(e.deltaY), true);
    }

    function onContextMenu(e: Event): void {
        e.preventDefault();
    }

    function onKeyDown(e: KeyboardEvent): void {
        keysDown.add(e.code);
    }

    function onKeyUp(e: KeyboardEvent): void {
        keysDown.delete(e.code);
    }

    // ── Touch (two-finger pinch = zoom toward centroid; ≥20 px centroid drift = pan) ──

    function firstTwoTouches(): [{ x: number; y: number }, { x: number; y: number }] {
        const it = activeTouches.values();
        const a = it.next().value as { x: number; y: number };
        const b = it.next().value as { x: number; y: number };
        return [a, b];
    }

    function onTouchStart(e: TouchEvent): void {
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i]!;
            activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
        }
        if (activeTouches.size >= 2) {
            // A second finger landed: this is a pinch, not a single-finger pan.
            // Cancel any in-progress pointer drag and stop the browser hijacking
            // the gesture as a page zoom (iOS ignores touch-action for pinch).
            e.preventDefault();
            if (mode === "pan") {
                stopDrag();
            }
            mode = "none";
            const [p0, p1] = firstTwoTouches();
            pinchPrevDist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
            pinchStartCentroidX = (p0.x + p1.x) / 2;
            pinchStartCentroidY = (p0.y + p1.y) / 2;
            pinchPanning = false;
        }
    }

    function onTouchMove(e: TouchEvent): void {
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i]!;
            if (activeTouches.has(t.identifier)) {
                activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
            }
        }
        if (activeTouches.size < 2) {
            return;
        }
        e.preventDefault();
        activeInput = true;
        const [p0, p1] = firstTwoTouches();
        const dist2 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        const centroidClientX = (p0.x + p1.x) / 2;
        const centroidClientY = (p0.y + p1.y) / 2;
        const rect = canvas.getBoundingClientRect();
        pointerX = centroidClientX - rect.left;
        pointerY = centroidClientY - rect.top;

        const centroidDrift = Math.hypot(centroidClientX - pinchStartCentroidX, centroidClientY - pinchStartCentroidY);
        if (!pinchPanning && centroidDrift > PINCH_PAN_THRESHOLD) {
            pinchPanning = true;
            startDrag(pointerX, pointerY);
        }

        if (pinchPanning) {
            // Pan dominates: drag the globe under the centroid (zoom is suppressed
            // while dragging, mirroring the mid-drag zoom lockout).
            handleDrag(pointerX, pointerY);
        } else if (pinchPrevDist > 0) {
            // Zoom toward the centroid: finger-spread Δpx feeds the zoom accumulator.
            const dDist = dist2 - pinchPrevDist;
            if (dDist !== 0) {
                zoomAccumulated += dDist * PINCH_ZOOM_SCALE;
                const pick = pickScreen(pointerX, pointerY);
                computedZoomPickPoint = pick.hit && pick.point && zoomToCursor ? pick.point : pickAlongVector(camera._lookAt);
            }
        }
        pinchPrevDist = dist2;
    }

    function onTouchEnd(e: TouchEvent): void {
        for (let i = 0; i < e.changedTouches.length; i++) {
            activeTouches.delete(e.changedTouches[i]!.identifier);
        }
        if (activeTouches.size < 2) {
            if (pinchPanning) {
                stopDrag();
                pinchPanning = false;
            }
            pinchPrevDist = 0;
        }
        // One finger remains: re-anchor lastX/Y so its pointer drag doesn't jump.
        if (activeTouches.size === 1) {
            const p = activeTouches.values().next().value as { x: number; y: number };
            lastX = p.x;
            lastY = p.y;
        }
    }

    // iOS Safari fires non-standard gesture* events and still page-zooms even with
    // touch-action:none; swallow them so the pinch stays with the camera.
    function onGesture(e: Event): void {
        e.preventDefault();
    }

    scene._beforeRender.push(onBeforeRenderTick);

    const listeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [
        [canvas, "pointerdown", onPointerDown as EventListener],
        [canvas, "pointermove", onPointerMove as EventListener],
        [canvas, "pointerup", onPointerUp as EventListener],
        [canvas, "wheel", onWheel as EventListener, { passive: false }],
        [canvas, "contextmenu", onContextMenu as EventListener],
        [canvas, "touchstart", onTouchStart as EventListener, { passive: false }],
        [canvas, "touchmove", onTouchMove as EventListener, { passive: false }],
        [canvas, "touchend", onTouchEnd as EventListener],
        [canvas, "gesturestart", onGesture as EventListener, { passive: false }],
        [canvas, "gesturechange", onGesture as EventListener, { passive: false }],
        [canvas, "gestureend", onGesture as EventListener, { passive: false }],
        [window, "keydown", onKeyDown as EventListener],
        [window, "keyup", onKeyUp as EventListener],
    ];
    for (const [t, ev, h, opts] of listeners) {
        t.addEventListener(ev, h, opts);
    }

    return () => {
        const idx = scene._beforeRender.indexOf(onBeforeRenderTick);
        if (idx >= 0) {
            scene._beforeRender.splice(idx, 1);
        }
        for (const [t, ev, h] of listeners) {
            t.removeEventListener(ev, h);
        }
    };
}

// ── shared helpers ──

function clampNum(v: number, min: number, max: number): number {
    return v < min ? min : v > max ? max : v;
}

function dist(a: Vec3, b: Vec3): number {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Transform a point by a Mat4 (row-vector × column-major matrix, with w divide). */
function transformCoordinates(x: number, y: number, z: number, m: Mat4Storage, out: Vec3): void {
    const rx = x * m[0]! + y * m[4]! + z * m[8]! + m[12]!;
    const ry = x * m[1]! + y * m[5]! + z * m[9]! + m[13]!;
    const rz = x * m[2]! + y * m[6]! + z * m[10]! + m[14]!;
    const rw = x * m[3]! + y * m[7]! + z * m[11]! + m[15]!;
    const inv = rw !== 0 ? 1 / rw : 1;
    out.x = rx * inv;
    out.y = ry * inv;
    out.z = rz * inv;
}
