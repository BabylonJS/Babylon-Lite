/** Axis drag gizmo — Lite port of BJS AxisDragGizmo.
 *
 *  Geometry (mirrors BJS `_CreateArrow`):
 *    • Arrow head: cylinder, diameterTop 0, height 0.075, diameterBottom 0.0375.
 *    • Arrow line: cylinder, diameter 0.005, height 0.275.
 *    • Both rotated 90° on X so the +Z face becomes the drag axis, then
 *      translated +0.3 (head) and +0.275/2 (line) along Z.
 *    • Whole group scaled 1/3 and oriented via `lookAtQuat(dragAxis)`.
 *    • A second invisible "collider" arrow built at 4× the tube thickness gives
 *      a generous pick region. */

import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { Vec3 } from "../math/types.js";
import { addToScene } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { createCylinder } from "../mesh/mesh-factories.js";
import { createGizmoMaterials, setMeshesMaterial, attachFollowTarget, GizmoObservable } from "./gizmo-core.js";
import type { GizmoMaterialSet } from "./gizmo-core.js";
import { lookAtQuat, transformDirectionByWorld, worldDeltaToLocal } from "./gizmo-math.js";
import { createPointerDrag, registerPointerDrag } from "./pointer-drag.js";
import type { PointerDrag } from "./pointer-drag.js";
import type { UtilityLayer } from "./utility-layer.js";

export interface AxisDragGizmoOptions {
    /** World-space drag axis (unit vector). */
    dragAxis: Vec3;
    /** Material color of the rendered arrow.  Defaults to grey. */
    color?: [number, number, number];
    /** Hover material colour (defaults to yellow). */
    hoverColor?: [number, number, number];
    /** Disabled-state material colour (defaults to grey, alpha 0.4). */
    disableColor?: [number, number, number];
    /** Multiplier applied to the rendered arrow's tube/cone thickness. */
    thickness?: number;
}

export interface AxisDragGizmo {
    /** The root node — gizmo follows its `attachedNode` by copying world translation. */
    readonly root: SceneNode;
    /** Drag behaviour driving the pointer interaction. */
    readonly drag: PointerDrag;
    /** Fired whenever a drag delta is applied to the attached node. */
    readonly onPositionChanged: GizmoObservable<Vec3>;
    /** Currently attached node — set via `attachAxisDragGizmoToNode`. */
    attachedNode: SceneNode | null;
    /** When true, the gizmo's drag axis is rotated each frame by the attached
     *  node's world rotation (local-coord mode).  When false (default), the
     *  drag axis stays world-aligned.  Mirrors BJS
     *  `updateGizmoRotationToMatchAttachedMesh`. */
    useLocalCoordinates: boolean;
    /** Material triplet (colored / hover / disabled).  Hover state is updated
     *  automatically during pointer-down on the collider. */
    readonly materials: GizmoMaterialSet;
    /** @internal — rendered (visible) meshes whose material is swapped for
     *  hover / colored / disabled.  Excludes the invisible root + colliders.
     *  A composite gizmo greys these out while a sibling axis is dragged. */
    _visibleMeshes: Mesh[];
    /** @internal — meshes to dispose. */
    _meshes: Mesh[];
    /** @internal — unregister pointer-drag dispatcher entry. */
    _disposePointer: () => void;
    /** @internal — unregister follow-target callback. */
    _disposeFollow: () => void;
}

/** Build the rendered arrow (cone + line) parented to `root`.  When
 *  `isCollider` is true, a thicker invisible version is built for picking. */
function buildArrow(
    engine: EngineContext,
    utilityScene: SceneContext,
    material: { material: AxisDragGizmo["materials"]["colored"] },
    root: SceneNode,
    thickness: number,
    isCollider: boolean
): Mesh[] {
    const cone = createCylinder(engine, {
        diameterTop: 0,
        height: 0.075,
        diameterBottom: 0.0375 * (1 + (thickness - 1) / 4),
        tessellation: 96,
    });
    cone.material = material.material;
    cone.rotation.set(Math.PI / 2, 0, 0);
    cone.position.set(0, 0, 0.3);
    cone.parent = root;
    addToScene(utilityScene, cone);

    const line = createCylinder(engine, {
        diameterTop: 0.005 * thickness,
        height: 0.275,
        diameterBottom: 0.005 * thickness,
        tessellation: 96,
    });
    line.material = material.material;
    line.rotation.set(Math.PI / 2, 0, 0);
    line.position.set(0, 0, 0.275 / 2);
    line.parent = root;
    addToScene(utilityScene, line);

    if (isCollider) {
        cone.visible = false;
        line.visible = false;
    }
    return [cone, line];
}

/** Build an axis-drag gizmo and attach it to the given utility layer.  Call
 *  `attachAxisDragGizmoToNode` to bind it to a node so it follows + drives it. */
export function createAxisDragGizmo(engine: EngineContext, layer: UtilityLayer, options: AxisDragGizmoOptions): AxisDragGizmo {
    const color = options.color ?? [0.5, 0.5, 0.5];
    const thickness = options.thickness ?? 1;
    const utilityScene = layer.scene;

    const materials = createGizmoMaterials(color, options.hoverColor, options.disableColor);

    // Root node — built from a tiny invisible mesh so it has full SceneNode
    // semantics (children, position, world matrix) and can be tracked by the
    // scene's `meshes` array for dispatching child transforms.
    const root = createCylinder(engine, { diameterTop: 0, diameterBottom: 0, height: 0, tessellation: 3 });
    root.material = materials.colored;
    root.visible = false;
    addToScene(utilityScene, root);

    // Orient root so its +Z points along the configured drag axis.
    const q = lookAtQuat(options.dragAxis);
    root.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
    root.scaling.set(1 / 3, 1 / 3, 1 / 3);

    const visibleMeshes = buildArrow(engine, utilityScene, { material: materials.colored }, root, thickness, false);
    const colliderMeshes = buildArrow(engine, utilityScene, { material: materials.colored }, root, thickness + 4, true);

    const drag = createPointerDrag({
        dragAxis: { x: options.dragAxis.x, y: options.dragAxis.y, z: options.dragAxis.z },
        moveAttached: false,
        // BJS-faithful drag-plane anchor: pass through the attached node's
        // world position (BJS `_updateDragPlanePosition` overrides
        // `dragPlane.position` with `attachedNode.getAbsolutePosition()`).
        // `root.position` is set every frame by `attachFollowTarget` to the
        // attached node's world translation, so it IS the live world anchor.
        // Without this the plane sits at the picked surface point — a deeper
        // picked plane (e.g. the off-centre arrowhead) inflated the per-tick
        // world delta vs. BJS.
        getPlanePoint: () => ({ x: root.position.x, y: root.position.y, z: root.position.z }),
    });
    // Both visible and invisible arrow parts trigger the drag — clicking
    // anywhere on the rendered arrow should start the interaction even when
    // the picker happens to hit the visible mesh before the larger invisible
    // collider (front-most depth wins).
    drag._colliders = [...visibleMeshes, ...colliderMeshes];

    const onPositionChanged = new GizmoObservable<Vec3>();
    // Capture the original (local-frame) axis — used in local-coord mode to
    // recompute the world axis each frame from the attached node's rotation.
    const localAxis: Vec3 = { x: options.dragAxis.x, y: options.dragAxis.y, z: options.dragAxis.z };

    const gizmo: AxisDragGizmo = {
        root,
        drag,
        onPositionChanged,
        attachedNode: null,
        useLocalCoordinates: false,
        materials,
        _visibleMeshes: visibleMeshes,
        _meshes: [root, ...visibleMeshes, ...colliderMeshes],
        _disposePointer: () => undefined,
        _disposeFollow: () => undefined,
    };

    drag.onDrag.add((event) => {
        const node = gizmo.attachedNode;
        if (!node) {
            return;
        }
        // event.delta is in world space; convert to the node's local frame so
        // the position update works correctly under parented nodes whose
        // parent has non-identity rotation / scale.
        const local = worldDeltaToLocal(node, event.delta.x, event.delta.y, event.delta.z);
        node.position.set(node.position.x + local.x, node.position.y + local.y, node.position.z + local.z);
        onPositionChanged.notify({ x: node.position.x, y: node.position.y, z: node.position.z });
    });

    drag.onDragStart.add(() => setMeshesMaterial(visibleMeshes, materials.hover));
    drag.onDragEnd.add(() => setMeshesMaterial(visibleMeshes, materials.colored));
    drag.onHoverStart.add(() => setMeshesMaterial(visibleMeshes, materials.hover));
    drag.onHoverEnd.add(() => {
        // Don't drop hover colour if a drag is currently in progress; the
        // drag-end callback owns the restoration.
        if (!drag.dragging) {
            setMeshesMaterial(visibleMeshes, materials.colored);
        }
    });

    // Pointer-drag dispatcher must be attached to a DOM canvas.
    const canvas = engine.canvas;
    if ("setAttribute" in canvas) {
        gizmo._disposePointer = registerPointerDrag(layer, canvas, drag);
    }

    gizmo._disposeFollow = attachFollowTarget(
        utilityScene,
        root,
        () => gizmo.attachedNode,
        1 / 3,
        (_target, wm) => {
            // Local-coord mode: rotate the drag axis by the attached node's world
            // rotation each frame, then re-orient the gizmo root to match.
            if (gizmo.useLocalCoordinates) {
                const worldAxis = transformDirectionByWorld(wm, localAxis);
                const dragAxis = drag.options.dragAxis;
                if (dragAxis) {
                    dragAxis.x = worldAxis.x;
                    dragAxis.y = worldAxis.y;
                    dragAxis.z = worldAxis.z;
                }
                const q = lookAtQuat(worldAxis);
                root.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
            } else {
                const dragAxis = drag.options.dragAxis;
                if (dragAxis && (dragAxis.x !== localAxis.x || dragAxis.y !== localAxis.y || dragAxis.z !== localAxis.z)) {
                    dragAxis.x = localAxis.x;
                    dragAxis.y = localAxis.y;
                    dragAxis.z = localAxis.z;
                    const q = lookAtQuat(localAxis);
                    root.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
                }
            }
        }
    );

    return gizmo;
}

/** Bind the gizmo to a node — the gizmo follows the node's world translation
 *  and applies drag deltas to its `position`. */
export function attachAxisDragGizmoToNode(gizmo: AxisDragGizmo, node: SceneNode | null): void {
    gizmo.attachedNode = node;
    gizmo.drag.enabled = node !== null;
}

/** Dispose the gizmo: remove meshes, unregister pointer-drag, drop materials. */
export function disposeAxisDragGizmo(gizmo: AxisDragGizmo, layer: UtilityLayer): void {
    gizmo._disposePointer();
    gizmo._disposeFollow();
    gizmo.onPositionChanged.clear();
    gizmo.drag.onDrag.clear();
    gizmo.drag.onDragStart.clear();
    gizmo.drag.onDragEnd.clear();
    for (const m of gizmo._meshes) {
        removeFromScene(layer.scene, m);
    }
    gizmo._meshes.length = 0;
}
