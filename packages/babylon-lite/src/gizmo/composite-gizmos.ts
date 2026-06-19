/** Composite Position / Rotation / Scale gizmos — Lite ports of BJS
 *  `PositionGizmo`, `RotationGizmo`, `ScaleGizmo`.
 *
 *  Each composite wraps several single-axis gizmos that we already ported and
 *  exposes a single `attachedNode` setter, a `useLocalCoordinates` flag, and
 *  dispose.  All sub-gizmos share the same `attachedNode` and propagate the
 *  coord-mode flag, mirroring BJS's `attachedNode` / `coordinatesMode`
 *  fan-out. */

import type { EngineContext } from "../engine/engine.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { Mesh } from "../mesh/mesh.js";
import type { PointerDrag } from "./pointer-drag.js";
import { setMeshesMaterial } from "./gizmo-core.js";
import type { GizmoMaterialSet } from "./gizmo-core.js";
import type { UtilityLayer } from "./utility-layer.js";
import { createAxisDragGizmo, attachAxisDragGizmoToNode, disposeAxisDragGizmo } from "./axis-drag-gizmo.js";
import type { AxisDragGizmo } from "./axis-drag-gizmo.js";
import { createPlaneDragGizmo, attachPlaneDragGizmoToNode, disposePlaneDragGizmo } from "./plane-drag-gizmo.js";
import type { PlaneDragGizmo } from "./plane-drag-gizmo.js";
import { createPlaneRotationGizmo, attachPlaneRotationGizmoToNode, disposePlaneRotationGizmo } from "./plane-rotation-gizmo.js";
import type { PlaneRotationGizmo } from "./plane-rotation-gizmo.js";
import { createAxisScaleGizmo, attachAxisScaleGizmoToNode, disposeAxisScaleGizmo } from "./axis-scale-gizmo.js";
import type { AxisScaleGizmo } from "./axis-scale-gizmo.js";

/** The minimal shape a composite needs from each sub-gizmo to coordinate the
 *  "grey out the other axes while one is dragged" affordance. */
interface DisableableSubGizmo {
    drag: PointerDrag;
    materials: GizmoMaterialSet;
    _visibleMeshes: Mesh[];
}

/** Wire BJS-style cross-axis disabling: while ANY sub-gizmo is being dragged,
 *  every OTHER sub-gizmo of the same composite switches to its (grey,
 *  semi-transparent) disabled material; on drag end they all restore.  Mirrors
 *  BJS `Gizmo.GizmoAxisPointerObserver`, which greys non-active axes on
 *  pointer-down and resets them on pointer-up.  The dispatcher suppresses hover
 *  picking while a drag is active, so the greyed state survives the whole drag
 *  without a stray hover event un-greying a sibling. */
function wireCrossAxisDisable(gizmos: DisableableSubGizmo[]): void {
    for (const g of gizmos) {
        g.drag.onDragStart.add(() => {
            for (const other of gizmos) {
                if (other !== g) {
                    setMeshesMaterial(other._visibleMeshes, other.materials.disabled);
                }
            }
        });
        g.drag.onDragEnd.add(() => {
            for (const other of gizmos) {
                if (other !== g) {
                    // Enabled siblings return to their colour; a disabled sibling
                    // stays greyed (matches BJS, where the disable material is
                    // permanent while `dragBehavior.enabled` is false).
                    setMeshesMaterial(other._visibleMeshes, other.drag.enabled ? other.materials.colored : other.materials.disabled);
                }
            }
        });
    }
}

// ─── PositionGizmo ───────────────────────────────────────────────────

/** Options for the composite position gizmo. */
export interface PositionGizmoOptions {
    /** When true, planar drag gizmos (XY/XZ/YZ) are created in addition to the
     *  3 axis arrows.  Default false — matches BJS where `planarGizmoEnabled`
     *  defaults to false and must be opted into. */
    planarEnabled?: boolean;
    /** Tube thickness multiplier for the axis arrows. */
    thickness?: number;
}

/** Composite translation gizmo made from X/Y/Z axis arrows and optional planar handles. */
export interface PositionGizmo {
    readonly xGizmo: AxisDragGizmo;
    readonly yGizmo: AxisDragGizmo;
    readonly zGizmo: AxisDragGizmo;
    readonly xPlaneGizmo: PlaneDragGizmo | null;
    readonly yPlaneGizmo: PlaneDragGizmo | null;
    readonly zPlaneGizmo: PlaneDragGizmo | null;
    attachedNode: SceneNode | null;
}

/** Build a composite position gizmo.  Colors match BJS PositionGizmo
 *  defaults: half-saturation red / green / blue along X / Y / Z
 *  (`Color3.Red().scale(0.5)` etc.). */
export function createPositionGizmo(engine: EngineContext, layer: UtilityLayer, options: PositionGizmoOptions = {}): PositionGizmo {
    const thickness = options.thickness ?? 1;
    const planarEnabled = options.planarEnabled ?? false;
    const xGizmo = createAxisDragGizmo(engine, layer, { dragAxis: { x: 1, y: 0, z: 0 }, color: [0.5, 0, 0], thickness });
    const yGizmo = createAxisDragGizmo(engine, layer, { dragAxis: { x: 0, y: 1, z: 0 }, color: [0, 0.5, 0], thickness });
    const zGizmo = createAxisDragGizmo(engine, layer, { dragAxis: { x: 0, y: 0, z: 1 }, color: [0, 0, 0.5], thickness });
    const xPlaneGizmo = planarEnabled ? createPlaneDragGizmo(engine, layer, { dragPlaneNormal: { x: 1, y: 0, z: 0 }, color: [0.5, 0, 0] }) : null;
    const yPlaneGizmo = planarEnabled ? createPlaneDragGizmo(engine, layer, { dragPlaneNormal: { x: 0, y: 1, z: 0 }, color: [0, 0.5, 0] }) : null;
    const zPlaneGizmo = planarEnabled ? createPlaneDragGizmo(engine, layer, { dragPlaneNormal: { x: 0, y: 0, z: 1 }, color: [0, 0, 0.5] }) : null;
    wireCrossAxisDisable([xGizmo, yGizmo, zGizmo, ...(xPlaneGizmo ? [xPlaneGizmo] : []), ...(yPlaneGizmo ? [yPlaneGizmo] : []), ...(zPlaneGizmo ? [zPlaneGizmo] : [])]);
    return {
        xGizmo,
        yGizmo,
        zGizmo,
        xPlaneGizmo,
        yPlaneGizmo,
        zPlaneGizmo,
        attachedNode: null,
    };
}

/** Attach all position sub-gizmos to a node, or detach them with `null`. */
export function attachPositionGizmoToNode(gizmo: PositionGizmo, node: SceneNode | null): void {
    gizmo.attachedNode = node;
    attachAxisDragGizmoToNode(gizmo.xGizmo, node);
    attachAxisDragGizmoToNode(gizmo.yGizmo, node);
    attachAxisDragGizmoToNode(gizmo.zGizmo, node);
    if (gizmo.xPlaneGizmo) {
        attachPlaneDragGizmoToNode(gizmo.xPlaneGizmo, node);
    }
    if (gizmo.yPlaneGizmo) {
        attachPlaneDragGizmoToNode(gizmo.yPlaneGizmo, node);
    }
    if (gizmo.zPlaneGizmo) {
        attachPlaneDragGizmoToNode(gizmo.zPlaneGizmo, node);
    }
}

/** Toggle whether the position gizmo axes follow the attached node's rotation. */
export function setPositionGizmoLocalCoordinates(gizmo: PositionGizmo, useLocal: boolean): void {
    gizmo.xGizmo.useLocalCoordinates = useLocal;
    gizmo.yGizmo.useLocalCoordinates = useLocal;
    gizmo.zGizmo.useLocalCoordinates = useLocal;
    if (gizmo.xPlaneGizmo) {
        gizmo.xPlaneGizmo.useLocalCoordinates = useLocal;
    }
    if (gizmo.yPlaneGizmo) {
        gizmo.yPlaneGizmo.useLocalCoordinates = useLocal;
    }
    if (gizmo.zPlaneGizmo) {
        gizmo.zPlaneGizmo.useLocalCoordinates = useLocal;
    }
}

/** Dispose all sub-gizmos owned by the composite position gizmo. */
export function disposePositionGizmo(gizmo: PositionGizmo, layer: UtilityLayer): void {
    disposeAxisDragGizmo(gizmo.xGizmo, layer);
    disposeAxisDragGizmo(gizmo.yGizmo, layer);
    disposeAxisDragGizmo(gizmo.zGizmo, layer);
    if (gizmo.xPlaneGizmo) {
        disposePlaneDragGizmo(gizmo.xPlaneGizmo, layer);
    }
    if (gizmo.yPlaneGizmo) {
        disposePlaneDragGizmo(gizmo.yPlaneGizmo, layer);
    }
    if (gizmo.zPlaneGizmo) {
        disposePlaneDragGizmo(gizmo.zPlaneGizmo, layer);
    }
}

// ─── RotationGizmo ───────────────────────────────────────────────────

/** Options for the composite rotation gizmo. */
export interface RotationGizmoOptions {
    tessellation?: number;
    thickness?: number;
}

/** Composite rotation gizmo made from X/Y/Z plane rotation rings. */
export interface RotationGizmo {
    readonly xGizmo: PlaneRotationGizmo;
    readonly yGizmo: PlaneRotationGizmo;
    readonly zGizmo: PlaneRotationGizmo;
    attachedNode: SceneNode | null;
}

/** Create a composite rotation gizmo with one ring for each principal axis.
 * @param engine - Engine that owns the created meshes.
 * @param layer - Utility layer that renders and picks the rings.
 * @param options - Ring tessellation and thickness options.
 * @returns A detached rotation gizmo ready to attach to a node.
 */
export function createRotationGizmo(engine: EngineContext, layer: UtilityLayer, options: RotationGizmoOptions = {}): RotationGizmo {
    const tessellation = options.tessellation ?? 32;
    const thickness = options.thickness ?? 1;
    const xGizmo = createPlaneRotationGizmo(engine, layer, { planeNormal: { x: 1, y: 0, z: 0 }, color: [0.5, 0, 0], tessellation, thickness });
    const yGizmo = createPlaneRotationGizmo(engine, layer, { planeNormal: { x: 0, y: 1, z: 0 }, color: [0, 0.5, 0], tessellation, thickness });
    const zGizmo = createPlaneRotationGizmo(engine, layer, { planeNormal: { x: 0, y: 0, z: 1 }, color: [0, 0, 0.5], tessellation, thickness });
    wireCrossAxisDisable([xGizmo, yGizmo, zGizmo]);
    return { xGizmo, yGizmo, zGizmo, attachedNode: null };
}

/** Attach all rotation sub-gizmos to a node, or detach them with `null`. */
export function attachRotationGizmoToNode(gizmo: RotationGizmo, node: SceneNode | null): void {
    gizmo.attachedNode = node;
    attachPlaneRotationGizmoToNode(gizmo.xGizmo, node);
    attachPlaneRotationGizmoToNode(gizmo.yGizmo, node);
    attachPlaneRotationGizmoToNode(gizmo.zGizmo, node);
}

/** Toggle whether the rotation rings follow the attached node's rotation. */
export function setRotationGizmoLocalCoordinates(gizmo: RotationGizmo, useLocal: boolean): void {
    gizmo.xGizmo.useLocalCoordinates = useLocal;
    gizmo.yGizmo.useLocalCoordinates = useLocal;
    gizmo.zGizmo.useLocalCoordinates = useLocal;
}

/** Dispose all sub-gizmos owned by the composite rotation gizmo. */
export function disposeRotationGizmo(gizmo: RotationGizmo, layer: UtilityLayer): void {
    disposePlaneRotationGizmo(gizmo.xGizmo, layer);
    disposePlaneRotationGizmo(gizmo.yGizmo, layer);
    disposePlaneRotationGizmo(gizmo.zGizmo, layer);
}

// ─── ScaleGizmo ──────────────────────────────────────────────────────

/** Options for the composite scale gizmo. */
export interface ScaleGizmoOptions {
    thickness?: number;
}

/** Composite scale gizmo made from X/Y/Z axis handles and a central uniform handle. */
export interface ScaleGizmo {
    readonly xGizmo: AxisScaleGizmo;
    readonly yGizmo: AxisScaleGizmo;
    readonly zGizmo: AxisScaleGizmo;
    /** Central uniform-scale gizmo (single arrow with uniformScaling = true). */
    readonly uniformScaleGizmo: AxisScaleGizmo;
    attachedNode: SceneNode | null;
}

/** Create a composite scale gizmo with per-axis handles and a uniform centre handle.
 * @param engine - Engine that owns the created meshes.
 * @param layer - Utility layer that renders and picks the handles.
 * @param options - Shared scale-handle thickness options.
 * @returns A detached scale gizmo ready to attach to a node.
 */
export function createScaleGizmo(engine: EngineContext, layer: UtilityLayer, options: ScaleGizmoOptions = {}): ScaleGizmo {
    const thickness = options.thickness ?? 1;
    const xGizmo = createAxisScaleGizmo(engine, layer, { dragAxis: { x: 1, y: 0, z: 0 }, color: [0.5, 0, 0], thickness });
    const yGizmo = createAxisScaleGizmo(engine, layer, { dragAxis: { x: 0, y: 1, z: 0 }, color: [0, 0.5, 0], thickness });
    const zGizmo = createAxisScaleGizmo(engine, layer, { dragAxis: { x: 0, y: 0, z: 1 }, color: [0, 0, 0.5], thickness });
    const uniformScaleGizmo = createAxisScaleGizmo(engine, layer, {
        dragAxis: { x: 0, y: 1, z: 0 },
        // BJS uses Color3.Gray().scale(0.5) = (0.25, 0.25, 0.25) for the central
        // uniform-scale handle; combined with the utility-layer hemispheric light
        // (intensity 2, gray ground) this renders as ~light gray, not white.
        color: [0.25, 0.25, 0.25],
        uniformScaling: true,
    });
    // The scale gizmo doesn't support world-coords mode in BJS — always local.
    // We default it on so users get matching behaviour without explicit setup.
    xGizmo.useLocalCoordinates = true;
    yGizmo.useLocalCoordinates = true;
    zGizmo.useLocalCoordinates = true;
    wireCrossAxisDisable([xGizmo, yGizmo, zGizmo, uniformScaleGizmo]);
    return { xGizmo, yGizmo, zGizmo, uniformScaleGizmo, attachedNode: null };
}

/** Attach all scale sub-gizmos to a node, or detach them with `null`. */
export function attachScaleGizmoToNode(gizmo: ScaleGizmo, node: SceneNode | null): void {
    gizmo.attachedNode = node;
    attachAxisScaleGizmoToNode(gizmo.xGizmo, node);
    attachAxisScaleGizmoToNode(gizmo.yGizmo, node);
    attachAxisScaleGizmoToNode(gizmo.zGizmo, node);
    attachAxisScaleGizmoToNode(gizmo.uniformScaleGizmo, node);
}

/** Toggle local-coord mode on the per-axis scale arrows.  The uniform-scale
 *  gizmo (centre) is always uniform so it ignores the flag. */
export function setScaleGizmoLocalCoordinates(gizmo: ScaleGizmo, useLocal: boolean): void {
    gizmo.xGizmo.useLocalCoordinates = useLocal;
    gizmo.yGizmo.useLocalCoordinates = useLocal;
    gizmo.zGizmo.useLocalCoordinates = useLocal;
}

/** Dispose all sub-gizmos owned by the composite scale gizmo. */
export function disposeScaleGizmo(gizmo: ScaleGizmo, layer: UtilityLayer): void {
    disposeAxisScaleGizmo(gizmo.xGizmo, layer);
    disposeAxisScaleGizmo(gizmo.yGizmo, layer);
    disposeAxisScaleGizmo(gizmo.zGizmo, layer);
    disposeAxisScaleGizmo(gizmo.uniformScaleGizmo, layer);
}
