/** Plane drag gizmo — Lite port of BJS PlaneDragGizmo.
 *
 *  Geometry: a 0.1375 × 0.1375 double-sided plane parented to the root, root
 *  scaled 1/3 and oriented via `lookAtQuat(dragPlaneNormal)`. The drag plane
 *  uses the same normal so the cursor stays on the rendered card during a drag. */

import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { Vec3 } from "../math/types.js";
import { addToScene } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { createPlane, createCylinder } from "../mesh/mesh-factories.js";
import { createGizmoMaterials, setMeshesMaterial, attachFollowTarget, GizmoObservable } from "./gizmo-core.js";
import type { GizmoMaterialSet } from "./gizmo-core.js";
import { lookAtQuat, transformDirectionByWorld, worldDeltaToLocal } from "./gizmo-math.js";
import { createPointerDrag, registerPointerDrag } from "./pointer-drag.js";
import type { PointerDrag } from "./pointer-drag.js";
import type { UtilityLayer } from "./utility-layer.js";

export interface PlaneDragGizmoOptions {
    /** World-space drag plane normal (unit vector). */
    dragPlaneNormal: Vec3;
    color?: [number, number, number];
    hoverColor?: [number, number, number];
    disableColor?: [number, number, number];
}

export interface PlaneDragGizmo {
    readonly root: SceneNode;
    readonly drag: PointerDrag;
    readonly onPositionChanged: GizmoObservable<Vec3>;
    attachedNode: SceneNode | null;
    /** When true, the plane normal rotates with the attached node each frame
     *  (local-coord mode). When false, the normal stays world-aligned. */
    useLocalCoordinates: boolean;
    readonly materials: GizmoMaterialSet;
    /** @internal — rendered (visible) plane mesh whose material is swapped for
     *  hover / colored / disabled (excludes the invisible root). */
    _visibleMeshes: Mesh[];
    /** @internal */
    _meshes: Mesh[];
    /** @internal */
    _disposePointer: () => void;
    /** @internal */
    _disposeFollow: () => void;
}

export function createPlaneDragGizmo(engine: EngineContext, layer: UtilityLayer, options: PlaneDragGizmoOptions): PlaneDragGizmo {
    const color = options.color ?? [0.5, 0.5, 0.5];
    const utilityScene = layer.scene;
    const materials = createGizmoMaterials(color, options.hoverColor, options.disableColor);
    // Plane materials must be double-sided.
    materials.colored.backFaceCulling = false;
    materials.hover.backFaceCulling = false;
    materials.disabled.backFaceCulling = false;

    const root = createCylinder(engine, { diameterTop: 0, diameterBottom: 0, height: 0, tessellation: 3 });
    root.material = materials.colored;
    root.visible = false;
    addToScene(utilityScene, root);

    const q = lookAtQuat(options.dragPlaneNormal);
    root.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
    root.scaling.set(1 / 3, 1 / 3, 1 / 3);

    const plane = createPlane(engine, { size: 0.1375 });
    plane.material = materials.colored;
    // Flip the plane around local Y so its visible normal aligns with the
    // root's +Z, which in turn maps to `dragPlaneNormal` in world space.  Lite's
    // createPlane gives the quad a -Z normal; without this flip the visible
    // face would point away from the configured drag plane normal and render
    // unlit when viewed from the expected side.
    plane.rotation.set(0, Math.PI, 0);
    plane.parent = root;
    addToScene(utilityScene, plane);

    const drag = createPointerDrag({
        dragPlaneNormal: { x: options.dragPlaneNormal.x, y: options.dragPlaneNormal.y, z: options.dragPlaneNormal.z },
        moveAttached: false,
        // BJS-faithful drag-plane anchor — see axis-drag-gizmo.ts for rationale.
        getPlanePoint: () => ({ x: root.position.x, y: root.position.y, z: root.position.z }),
    });
    drag._colliders = [plane];

    const onPositionChanged = new GizmoObservable<Vec3>();
    const localNormal: Vec3 = { x: options.dragPlaneNormal.x, y: options.dragPlaneNormal.y, z: options.dragPlaneNormal.z };

    const gizmo: PlaneDragGizmo = {
        root,
        drag,
        onPositionChanged,
        attachedNode: null,
        useLocalCoordinates: false,
        materials,
        _visibleMeshes: [plane],
        _meshes: [root, plane],
        _disposePointer: () => undefined,
        _disposeFollow: () => undefined,
    };

    drag.onDrag.add((event) => {
        const node = gizmo.attachedNode;
        if (!node) {
            return;
        }
        const local = worldDeltaToLocal(node, event.delta.x, event.delta.y, event.delta.z);
        node.position.set(node.position.x + local.x, node.position.y + local.y, node.position.z + local.z);
        onPositionChanged.notify({ x: node.position.x, y: node.position.y, z: node.position.z });
    });
    drag.onDragStart.add(() => setMeshesMaterial([plane], materials.hover));
    drag.onDragEnd.add(() => setMeshesMaterial([plane], materials.colored));
    drag.onHoverStart.add(() => setMeshesMaterial([plane], materials.hover));
    drag.onHoverEnd.add(() => {
        if (!drag.dragging) {
            setMeshesMaterial([plane], materials.colored);
        }
    });

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
            if (gizmo.useLocalCoordinates) {
                const worldNormal = transformDirectionByWorld(wm, localNormal);
                const n = drag.options.dragPlaneNormal;
                if (n) {
                    n.x = worldNormal.x;
                    n.y = worldNormal.y;
                    n.z = worldNormal.z;
                }
                const q = lookAtQuat(worldNormal);
                root.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
            } else {
                const n = drag.options.dragPlaneNormal;
                if (n && (n.x !== localNormal.x || n.y !== localNormal.y || n.z !== localNormal.z)) {
                    n.x = localNormal.x;
                    n.y = localNormal.y;
                    n.z = localNormal.z;
                    const q = lookAtQuat(localNormal);
                    root.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
                }
            }
        }
    );

    return gizmo;
}

export function attachPlaneDragGizmoToNode(gizmo: PlaneDragGizmo, node: SceneNode | null): void {
    gizmo.attachedNode = node;
    gizmo.drag.enabled = node !== null;
}

export function disposePlaneDragGizmo(gizmo: PlaneDragGizmo, layer: UtilityLayer): void {
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
