/** PointerDrag — Lite port of BJS PointerDragBehavior.
 *
 *  Each gizmo registers a "drag entry" with a per-canvas dispatcher.
 *  On pointer-down, the dispatcher GPU-picks the utility-layer scene; if a
 *  registered collider is hit, the matching gizmo's drag handlers fire and
 *  subsequent pointer-move/up events are routed to it.
 *
 *  Drag math:
 *   • If `dragAxis` is set (axis-drag mode): the drag plane contains `dragAxis`
 *     and is oriented to face the camera as much as possible.  Pointer-move
 *     positions are ray-cast against this plane; the world-space delta from the
 *     last drag point is projected onto `dragAxis` and fired as `delta`.
 *   • If `dragPlaneNormal` is set (plane mode): the drag plane has the given
 *     normal and passes through the initial hit point.  Pointer-move deltas
 *     are unprojected directly (full 3D delta on the plane). */

import type { SceneContext } from "../scene/scene-core.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Vec3 } from "../math/types.js";
import { createPickingRay } from "../picking/ray.js";
import { createGpuPicker, disposePicker, pickAsync } from "../picking/gpu-picker.js";
import type { GpuPicker } from "../picking/gpu-picker.js";
import { getViewProjectionMatrix, getCameraPosition } from "../camera/camera.js";
import { resolveCameraViewport } from "../camera/viewport.js";
import { rayPlaneIntersect, normalizeVec3Obj } from "./gizmo-math.js";
import { GizmoObservable } from "./gizmo-core.js";
import type { UtilityLayer } from "./utility-layer.js";

/** Event raised when a pointer drag begins on one of the registered colliders. */
export interface PointerDragStartEvent {
    /** World-space point where the ray intersected the drag plane on drag start. */
    dragPlanePoint: Vec3;
    /** Browser pointer event that triggered drag start. */
    pointerEvent: PointerEvent;
}

/** Event raised for each pointer move while a drag is active. */
export interface PointerDragMoveEvent {
    /** World-space delta from the previous drag-plane point.  For axis-drag this
     *  is already projected onto the drag axis (parallel to axis). */
    delta: Vec3;
    /** Current world-space point on the drag plane (post-projection). */
    dragPlanePoint: Vec3;
    /** Signed scalar distance projected onto the drag axis since drag start
     *  (axis-drag mode); for plane mode this is `delta.length()`. */
    dragDistance: number;
}

/** Event raised when the active pointer drag is released or cancelled. */
export interface PointerDragEndEvent {
    pointerEvent: PointerEvent | null;
}

/** Configuration for converting pointer movement into world-space drag deltas. */
export interface PointerDragOptions {
    /** Drag along a single world-space axis (unit vector). Mutually exclusive
     *  with `dragPlaneNormal`. */
    dragAxis?: Vec3;
    /** Drag inside a plane defined by this world-space normal.  Mutually
     *  exclusive with `dragAxis`. */
    dragPlaneNormal?: Vec3;
    /** When false, the dispatcher fires events but doesn't move the picked
     *  mesh.  Gizmos always set this to false and apply transforms to their
     *  attached node themselves. */
    moveAttached?: boolean;
    /** Optional override for the drag-plane anchor point (plane mode only).
     *  When it returns a point, the camera-facing drag plane passes through that
     *  point instead of the picked surface point, so the screen→world scale is
     *  taken at that depth.  The BoundingBoxGizmo body drag anchors at the
     *  bounding-box CENTRE (matching BJS, whose body `_dragMesh` sits at the box
     *  centroid) so the translation scale doesn't depend on where the press
     *  landed on the (inset, camera-facing) body surface. */
    getPlanePoint?: () => Vec3 | null;
}

/** Pointer-drag behavior shared by gizmos and driven by the per-canvas dispatcher. */
export interface PointerDrag {
    readonly options: Readonly<PointerDragOptions>;
    enabled: boolean;
    /** @internal — set by `registerPointerDragGizmo`; the dispatcher uses this
     *  to know which gizmo's drag handlers to invoke. */
    _colliders: Mesh[];
    /** Fired once when a pointer-down lands on one of `_colliders`. */
    onDragStart: GizmoObservable<PointerDragStartEvent>;
    /** Fired on every pointer-move while a drag is active. */
    onDrag: GizmoObservable<PointerDragMoveEvent>;
    /** Fired once when the pointer is released. */
    onDragEnd: GizmoObservable<PointerDragEndEvent>;
    /** Fired when the pointer hovers over one of `_colliders` (no button pressed).
     *  Used by gizmos to swap to a hover-coloured material before any drag.
     *  Always fires AFTER a previous `onHoverEnd` for a different drag, so the
     *  receiver doesn't need to track which collider is currently hovered. */
    onHoverStart: GizmoObservable<void>;
    /** Fired when the pointer leaves a previously-hovered collider. */
    onHoverEnd: GizmoObservable<void>;
    /** True while a drag is in progress. */
    dragging: boolean;
    /** True while the pointer is hovering one of `_colliders` (no drag). */
    hovering: boolean;
}

/** Build a PointerDrag descriptor.  The drag is inert until `registerPointerDrag`
 *  is called against a utility layer with collider meshes assigned to it. */
export function createPointerDrag(options: PointerDragOptions): PointerDrag {
    return {
        options: { moveAttached: false, ...options },
        enabled: true,
        _colliders: [],
        onDragStart: new GizmoObservable<PointerDragStartEvent>(),
        onDrag: new GizmoObservable<PointerDragMoveEvent>(),
        onDragEnd: new GizmoObservable<PointerDragEndEvent>(),
        onHoverStart: new GizmoObservable<void>(),
        onHoverEnd: new GizmoObservable<void>(),
        dragging: false,
        hovering: false,
    };
}

// ─── Per-canvas dispatcher ─────────────────────────────────────────

interface ActiveDrag {
    drag: PointerDrag;
    /** World-space plane normal used for the active drag. */
    planeNormal: Vec3;
    /** World-space point on the drag plane (origin of plane). */
    planePoint: Vec3;
    /** Last drag-plane point reported (for delta computation). */
    lastPlanePoint: Vec3;
    /** Drag-plane point at drag start (for cumulative `dragDistance`). */
    startPlanePoint: Vec3;
    pointerId: number;
}

interface DispatcherState {
    layer: UtilityLayer;
    canvas: HTMLCanvasElement;
    picker: GpuPicker;
    drags: PointerDrag[];
    active: ActiveDrag | null;
    /** Currently hovered drag (if any).  Cleared on drag start or hover-end. */
    hovered: PointerDrag | null;
    /** Async pick token — if the latest pointer-move arrives before the
     *  previous pick resolves, the older result is discarded. */
    hoverToken: number;
    /** True while a pointer-down GPU pick is in flight (between the press and
     *  the async pick resolving).  Camera controls consult this so they defer
     *  starting an orbit until it's known whether the press hit a gizmo. */
    pickPending: boolean;
    cleanup: () => void;
}

// Lazy-init cache: at most one dispatcher per canvas.  All gizmos sharing a
// canvas MUST share a single utility layer — the dispatcher binds to the
// layer's scene/picker on first install, so a later registration with a
// different layer would silently use the wrong picker scene (the dispatcher
// warns when this happens, see `registerPointerDrag`).
let _dispatchers: WeakMap<HTMLCanvasElement, DispatcherState> | null = null;

function getDispatchers(): WeakMap<HTMLCanvasElement, DispatcherState> {
    if (!_dispatchers) {
        _dispatchers = new WeakMap();
    }
    return _dispatchers;
}

/** Register the drag's colliders + handlers with the per-canvas dispatcher for
 *  this utility layer.  Returns a function that unregisters the drag.  When the
 *  last drag for a canvas is unregistered, the dispatcher tears itself down
 *  (canvas listeners are detached, the GPU picker is disposed, the cache entry
 *  is removed) so disposing all gizmos doesn't leak listeners or GPU resources. */
export function registerPointerDrag(layer: UtilityLayer, canvas: HTMLCanvasElement, drag: PointerDrag): () => void {
    const map = getDispatchers();
    let state = map.get(canvas);
    if (!state) {
        state = installDispatcher(layer, canvas);
        map.set(canvas, state);
    } else if (state.layer !== layer) {
        // Multiple utility layers on the same canvas isn't supported — the
        // dispatcher's picker is bound to the first layer's scene, so picks for
        // gizmos in `layer` would query the wrong scene.  Warn loudly but reuse
        // the existing dispatcher (the legacy behavior) instead of crashing.
        console.warn(
            "[babylon-lite] registerPointerDrag: a second UtilityLayer was used for the same canvas. " +
                "Only one utility layer per canvas is supported; the first layer's GPU picker will be reused."
        );
    }
    state.drags.push(drag);
    return () => {
        const i = state!.drags.indexOf(drag);
        if (i < 0) {
            return;
        }
        state!.drags.splice(i, 1);
        // If the disposed drag is the active one, end the drag cleanly so
        // observers + pointer capture release.  Without this the dispatcher
        // would keep `state.active` pointing at the now-orphan drag and ignore
        // the next pointer-up because the pointerId no longer matches anything.
        if (state!.active && state!.active.drag === drag) {
            const pointerId = state!.active.pointerId;
            drag.dragging = false;
            drag.onDragEnd.notify({ pointerEvent: null });
            if ("releasePointerCapture" in state!.canvas) {
                try {
                    state!.canvas.releasePointerCapture(pointerId);
                } catch {
                    // Non-fatal — pointer might already be released.
                }
            }
            state!.active = null;
            state!.pickPending = false;
        }
        if (state!.hovered === drag) {
            drag.hovering = false;
            drag.onHoverEnd.notify();
            state!.hovered = null;
        }
        // Tear down the dispatcher once nothing is left to handle.  Bumping
        // `hoverToken` invalidates any in-flight async hover pick so its
        // resolution path early-outs instead of touching the disposed picker.
        if (state!.drags.length === 0 && !state!.active) {
            state!.hoverToken++;
            state!.cleanup();
            disposePicker(state!.picker);
            map.delete(canvas);
        }
    };
}

function installDispatcher(layer: UtilityLayer, canvas: HTMLCanvasElement): DispatcherState {
    const picker = createGpuPicker(layer.scene);
    const state: DispatcherState = {
        layer,
        canvas,
        picker,
        drags: [],
        active: null,
        hovered: null,
        hoverToken: 0,
        pickPending: false,
        cleanup: () => undefined,
    };

    const onPointerDown = (event: PointerEvent): void => {
        if (state.active || event.button !== 0) {
            return;
        }
        // Mark a pick as in flight so camera controls defer starting an orbit
        // until we know whether this press hit a gizmo (the pick is async).
        state.pickPending = true;
        void handlePointerDown(state, event);
    };

    const onPointerMove = (event: PointerEvent): void => {
        if (state.active && event.pointerId === state.active.pointerId) {
            handlePointerMove(state, event);
            return;
        }
        // Idle pointer-move: GPU-pick to determine hover target so gizmos can
        // swap to their hover material before the user starts dragging.  Picks
        // are tagged with a monotonically-increasing token so a stale result
        // can't overwrite the latest hover decision.
        void handleHoverMove(state, event);
    };

    const onPointerUp = (event: PointerEvent): void => {
        if (!state.active || event.pointerId !== state.active.pointerId) {
            return;
        }
        handlePointerUp(state, event);
    };

    const onPointerLeave = (): void => {
        if (state.hovered) {
            state.hovered.hovering = false;
            state.hovered.onHoverEnd.notify();
            state.hovered = null;
        }
    };

    // Capture phase so we beat arc-rotate-controls (which uses bubble phase)
    // for events that hit a gizmo collider.
    canvas.addEventListener("pointerdown", onPointerDown, { capture: true });
    canvas.addEventListener("pointermove", onPointerMove, { capture: true });
    canvas.addEventListener("pointerup", onPointerUp, { capture: true });
    canvas.addEventListener("pointercancel", onPointerUp, { capture: true });
    canvas.addEventListener("pointerleave", onPointerLeave, { capture: true });

    state.cleanup = () => {
        canvas.removeEventListener("pointerdown", onPointerDown, { capture: true });
        canvas.removeEventListener("pointermove", onPointerMove, { capture: true });
        canvas.removeEventListener("pointerup", onPointerUp, { capture: true });
        canvas.removeEventListener("pointercancel", onPointerUp, { capture: true });
        canvas.removeEventListener("pointerleave", onPointerLeave, { capture: true });
    };

    return state;
}

async function handleHoverMove(state: DispatcherState, event: PointerEvent): Promise<void> {
    const token = ++state.hoverToken;
    const info = await pickAsync(state.picker, event.offsetX, event.offsetY);
    if (token !== state.hoverToken || state.active) {
        return;
    }
    const drag = info.hit && info.pickedMesh ? findDragForMesh(state.drags, info.pickedMesh as Mesh) : null;
    const next = drag && drag.enabled ? drag : null;
    if (next === state.hovered) {
        return;
    }
    if (state.hovered) {
        state.hovered.hovering = false;
        state.hovered.onHoverEnd.notify();
    }
    state.hovered = next;
    if (next) {
        next.hovering = true;
        next.onHoverStart.notify();
    }
}

async function handlePointerDown(state: DispatcherState, event: PointerEvent): Promise<void> {
    let info;
    try {
        info = await pickAsync(state.picker, event.offsetX, event.offsetY);
    } finally {
        // The pick has resolved (or threw) — camera controls may stop deferring.
        state.pickPending = false;
    }
    if (!info.hit || !info.pickedMesh) {
        return;
    }
    // Find the drag whose collider list contains the picked mesh.
    const drag = findDragForMesh(state.drags, info.pickedMesh as Mesh);
    if (!drag || !drag.enabled) {
        return;
    }

    // Stop the camera controls from grabbing this gesture.
    event.stopImmediatePropagation();
    event.preventDefault();
    if ("setPointerCapture" in state.canvas) {
        try {
            state.canvas.setPointerCapture(event.pointerId);
        } catch {
            // Pointer capture is best-effort — failure is non-fatal.
        }
    }

    const hitPoint = info.pickedPoint ? { x: info.pickedPoint[0], y: info.pickedPoint[1], z: info.pickedPoint[2] } : null;
    const planeNormal = pickDragPlaneNormal(drag, state.layer.scene, hitPoint);
    // Plane-mode drags may anchor the plane at a caller-supplied point (e.g. the
    // gizmo's world centre) instead of the picked surface point, so the
    // screen→world scale is taken at the correct depth (see `getPlanePoint`).
    const overridePoint = drag.options.getPlanePoint?.();
    const planePoint = overridePoint ?? hitPoint ?? { x: 0, y: 0, z: 0 };
    // The initial drag-plane point is where the pointer-DOWN ray meets the drag
    // plane.  Without an override this is just the picked surface point; with an
    // override (which only sets the plane DEPTH) we must re-cast the down ray
    // onto the deeper plane, else the first move's delta carries the offset
    // between the override anchor and the press location (a one-off jump).
    let startPoint = hitPoint ?? planePoint;
    if (overridePoint) {
        const downRay = canvasRayFromPointer(state.layer.scene, state.canvas, event.offsetX, event.offsetY);
        const hit = downRay ? rayPlaneIntersect(downRay.origin, downRay.dir, planePoint, planeNormal) : null;
        startPoint = hit ?? planePoint;
    }

    // Clear any hover state — the active drag handler owns the visual now.
    if (state.hovered) {
        state.hovered.hovering = false;
        state.hovered.onHoverEnd.notify();
        state.hovered = null;
    }

    state.active = {
        drag,
        planeNormal,
        planePoint,
        lastPlanePoint: { x: startPoint.x, y: startPoint.y, z: startPoint.z },
        startPlanePoint: { x: startPoint.x, y: startPoint.y, z: startPoint.z },
        pointerId: event.pointerId,
    };
    drag.dragging = true;
    drag.onDragStart.notify({ dragPlanePoint: startPoint, pointerEvent: event });
}

function handlePointerMove(state: DispatcherState, event: PointerEvent): void {
    const active = state.active!;
    // BJS-faithful: when the drag exposes a `getPlanePoint` callback, refresh
    // the drag plane's anchor every move so it tracks the attached node as the
    // gizmo drives it (BJS `_updateDragPlanePosition` overrides plane.position
    // with `attachedNode.getAbsolutePosition()` per move, default
    // `updateDragPlane = true`).  Keeps the screen-to-world ratio anchored at
    // the node's depth — without this, Lite anchored the plane at the picked
    // surface point (e.g. an off-centre corner), and a deeper picked plane
    // inflated the per-tick world delta vs. BJS.
    const livePlanePoint = active.drag.options.getPlanePoint?.();
    if (livePlanePoint) {
        active.planePoint = { x: livePlanePoint.x, y: livePlanePoint.y, z: livePlanePoint.z };
    }
    const ray = canvasRayFromPointer(state.layer.scene, state.canvas, event.offsetX, event.offsetY);
    if (!ray) {
        return;
    }
    const hit = rayPlaneIntersect(ray.origin, ray.dir, active.planePoint, active.planeNormal);
    if (!hit) {
        return;
    }

    let delta: Vec3 = {
        x: hit.x - active.lastPlanePoint.x,
        y: hit.y - active.lastPlanePoint.y,
        z: hit.z - active.lastPlanePoint.z,
    };
    let dragDistance: number;
    const axis = active.drag.options.dragAxis;
    if (axis) {
        // Project the delta onto the drag axis.
        const proj = delta.x * axis.x + delta.y * axis.y + delta.z * axis.z;
        delta = { x: axis.x * proj, y: axis.y * proj, z: axis.z * proj };
        const totalDelta = {
            x: hit.x - active.startPlanePoint.x,
            y: hit.y - active.startPlanePoint.y,
            z: hit.z - active.startPlanePoint.z,
        };
        dragDistance = totalDelta.x * axis.x + totalDelta.y * axis.y + totalDelta.z * axis.z;
    } else {
        dragDistance = Math.hypot(delta.x, delta.y, delta.z);
    }

    active.lastPlanePoint = { x: hit.x, y: hit.y, z: hit.z };
    active.drag.onDrag.notify({ delta, dragPlanePoint: hit, dragDistance });

    // BJS-faithful: with `updateDragPlane = true` (BJS default), the drag plane
    // is refreshed AFTER the pick using the just-computed hit as the new
    // reference point for the normal.  For axis mode this re-faces the plane
    // toward the camera as it / the gizmo moves; for plane mode the normal is
    // fixed (configured `dragPlaneNormal`) so we leave it alone.
    if (active.drag.options.dragAxis) {
        active.planeNormal = pickDragPlaneNormal(active.drag, state.layer.scene, hit);
    }
}

function handlePointerUp(state: DispatcherState, event: PointerEvent): void {
    const active = state.active!;
    active.drag.dragging = false;
    active.drag.onDragEnd.notify({ pointerEvent: event });
    state.active = null;
    if ("releasePointerCapture" in state.canvas) {
        try {
            state.canvas.releasePointerCapture(event.pointerId);
        } catch {
            // Non-fatal — pointer might already be released by the browser.
        }
    }
}

function findDragForMesh(drags: PointerDrag[], mesh: Mesh): PointerDrag | null {
    for (const d of drags) {
        if (d._colliders.includes(mesh)) {
            return d;
        }
    }
    return null;
}

/** Returns true when the gizmo dispatcher for `canvas` currently has a pointer
 *  hovering one of its colliders or an active drag in progress.  Camera
 *  controls consult this on pointer-down so orbiting doesn't start when the
 *  press lands on (or drags) a gizmo. */
export function isGizmoInteracting(canvas: HTMLCanvasElement): boolean {
    const state = _dispatchers?.get(canvas);
    if (!state) {
        return false;
    }
    return state.hovered !== null || state.active !== null;
}

/** Returns true when the gizmo dispatcher for `canvas` has an ACTIVE drag in
 *  progress (a collider was pressed and is being dragged).  Unlike
 *  {@link isGizmoInteracting} this ignores mere hover, so camera controls can
 *  abort an optimistically-started orbit once a gizmo drag (recognised a frame
 *  after pointer-down, since picking is async) reclaims the gesture — without
 *  aborting a legitimate orbit when the cursor merely passes over a gizmo. */
export function isGizmoDragging(canvas: HTMLCanvasElement): boolean {
    const state = _dispatchers?.get(canvas);
    return state ? state.active !== null : false;
}

/** Returns true while the gizmo dispatcher for `canvas` has a pointer-down GPU
 *  pick still in flight.  Camera controls consult this to DEFER (not yet apply)
 *  an orbit until the pick resolves, so a press that lands on a gizmo never
 *  produces a stray orbit even if the async pick is slow. */
export function isGizmoPickPending(canvas: HTMLCanvasElement): boolean {
    const state = _dispatchers?.get(canvas);
    return state ? state.pickPending : false;
}

/** Compute the world-space plane normal used for a drag.  For plane mode it's
 *  the configured `dragPlaneNormal`.  For axis mode it's the plane that
 *  contains `dragAxis` and faces the camera most directly. */
function pickDragPlaneNormal(drag: PointerDrag, scene: SceneContext, hitPoint: Vec3 | null): Vec3 {
    const planeNormal = drag.options.dragPlaneNormal;
    if (planeNormal) {
        return normalizeVec3Obj(planeNormal);
    }
    const axis = drag.options.dragAxis!;
    const cam = scene.camera;
    if (!cam) {
        return normalizeVec3Obj({ x: -axis.y, y: axis.x, z: 0 });
    }
    const camPos = getCameraPosition(cam);
    const ref = hitPoint ?? { x: 0, y: 0, z: 0 };
    // Direction from the hit point to the camera, then remove the axis-aligned
    // component to get a vector inside the drag plane.
    const dx = camPos.x - ref.x,
        dy = camPos.y - ref.y,
        dz = camPos.z - ref.z;
    const dotAxis = dx * axis.x + dy * axis.y + dz * axis.z;
    let nx = dx - axis.x * dotAxis;
    let ny = dy - axis.y * dotAxis;
    let nz = dz - axis.z * dotAxis;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-6) {
        // Camera direction collinear with axis — pick an arbitrary perpendicular.
        return normalizeVec3Obj({ x: -axis.y, y: axis.x, z: 0 });
    }
    nx /= len;
    ny /= len;
    nz /= len;
    return { x: nx, y: ny, z: nz };
}

interface CanvasRay {
    origin: Vec3;
    dir: Vec3;
}

/** Build a world-space ray from CSS canvas coordinates against the scene camera. */
function canvasRayFromPointer(scene: SceneContext, canvas: HTMLCanvasElement, cssX: number, cssY: number): CanvasRay | null {
    const cam = scene.camera;
    if (!cam) {
        return null;
    }
    const backingWidth = canvas.width;
    const backingHeight = canvas.height;
    const clientWidth = canvas.clientWidth || backingWidth;
    const clientHeight = canvas.clientHeight || backingHeight;
    const viewport = resolveCameraViewport(cam, backingWidth, backingHeight);
    const scaleX = backingWidth / clientWidth;
    const scaleY = backingHeight / clientHeight;
    const px = cssX * scaleX - viewport.x;
    const py = cssY * scaleY - viewport.y;
    const w = viewport.width;
    const h = viewport.height;
    if (w === 0 || h === 0) {
        return null;
    }
    const aspect = w / h;
    const vp = getViewProjectionMatrix(cam, aspect);
    const ray = createPickingRay(px, py, vp, w, h);
    if (!ray) {
        return null;
    }
    return {
        origin: { x: ray.origin[0], y: ray.origin[1], z: ray.origin[2] },
        dir: { x: ray.direction[0], y: ray.direction[1], z: ray.direction[2] },
    };
}
