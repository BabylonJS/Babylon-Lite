/** Axis scale gizmo — Lite port of BJS AxisScaleGizmo.
 *
 *  Geometry (mirrors BJS `_createGizmoMesh`):
 *    • Cube head: createBox at z=0.3 (after lookAt → world tip along dragAxis),
 *      scaled in place by 0.1 so a base size of 0.4 ends up ~0.04 units.
 *    • Tail cylinder: createCylinder height 0.275, diameter 0.005, tess 96, at
 *      z=0.275/2 to start from the gizmo origin.
 *    • Both rotated 90° on X so their +Z face aligns with the drag axis after
 *      the root's lookAtQuat(dragAxis).
 *    • Invisible 4×-thicker collider variant for picking.
 *
 *  Drag math (matches BJS AxisScaleGizmo): each frame we compute
 *  `dragStrength = dot(event.delta, dragAxis) / rootScaling.length()` and apply
 *  the per-axis multiplier `(1 + dragStrength * |dragAxis.component|)` to the
 *  attached node's local `scaling` vector. */

import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Vec3 } from "../math/types.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import { addToScene } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { createBox, createCylinder, createPolyhedron } from "../mesh/mesh-factories.js";
import { createGizmoMaterials, setMeshesMaterial, attachFollowTarget, GizmoObservable } from "./gizmo-core.js";
import type { GizmoMaterialSet } from "./gizmo-core.js";
import { directionToQuat, normalizeVec3Obj, quatMul, rotationQuatFromMatrix, transformDirectionByWorld } from "./gizmo-math.js";
import { createPointerDrag, registerPointerDrag } from "./pointer-drag.js";
import type { PointerDrag } from "./pointer-drag.js";
import type { UtilityLayer } from "./utility-layer.js";

/** Options for building a single-axis or uniform scale gizmo handle. */
export interface AxisScaleGizmoOptions {
    /** World-space drag axis (unit vector). Scaling is applied to the attached
     *  node's local `scaling` components proportional to each axis component. */
    dragAxis: Vec3;
    color?: [number, number, number];
    hoverColor?: [number, number, number];
    disableColor?: [number, number, number];
    /** Tube thickness multiplier (visible only; collider gets +4). */
    thickness?: number;
    /** Optional multiplier on the per-frame drag strength. Default 1. */
    sensitivity?: number;
    /** When true, scale uniformly on all 3 axes (matches BJS uniformScaling). */
    uniformScaling?: boolean;
}

/** A cube or octahedron handle that scales its attached node from pointer drag distance. */
export interface AxisScaleGizmo {
    readonly root: SceneNode;
    readonly drag: PointerDrag;
    readonly onScaleChanged: GizmoObservable<Vec3>;
    attachedNode: SceneNode | null;
    /** Local-coord mode: drag axis rotates with the attached node. */
    useLocalCoordinates: boolean;
    readonly materials: GizmoMaterialSet;
    /** @internal — rendered (visible) meshes whose material is swapped for
     *  hover / colored / disabled (excludes the invisible root + colliders). */
    _visibleMeshes: Mesh[];
    /** @internal */
    _meshes: Mesh[];
    /** @internal */
    _disposePointer: () => void;
    /** @internal */
    _disposeFollow: () => void;
}

/** Base `size` for the uniform-scale handle octahedron (vertices sit at
 *  ≈1.414×size along each axis).  Tuned to match BJS ScaleGizmo's central
 *  `CreatePolyhedron(type:1)` handle on screen. */
const UNIFORM_OCTAHEDRON_SIZE = 0.028;

/** Build the cube + line geometry for an axis-scale arrow.  When `centered`
 *  is true (uniform-scale handle), an octahedron sits at the gizmo origin and
 *  the tail is omitted — the handle becomes a centred grab widget at the gizmo
 *  root, matching BJS ScaleGizmo's central octahedron. */
function buildScaleArrow(
    engine: EngineContext,
    utilityScene: SceneContext,
    material: StandardMaterialProps,
    root: SceneNode,
    thickness: number,
    isCollider: boolean,
    centered: boolean
): Mesh[] {
    if (centered) {
        // Uniform-scale handle — an octahedron at the gizmo origin (no tail, no
        // z offset), mirroring BJS ScaleGizmo's central `CreatePolyhedron(type:1)`
        // octahedron.  Kept world-aligned (identity root rotation) by the caller.
        const head = createPolyhedron(engine, { type: 1, size: UNIFORM_OCTAHEDRON_SIZE * (1 + (thickness - 1) / 4) });
        head.material = material;
        head.position.set(0, 0, 0);
        head.parent = root;
        addToScene(utilityScene, head);
        if (isCollider) {
            head.visible = false;
        }
        return [head];
    }

    // Base box size 0.4 (BJS), then scaled in place by 0.1 → world tip ~0.04
    // after the gizmo's distance-based root scaling.
    const head = createBox(engine, 0.4 * (1 + (thickness - 1) / 4));
    head.scaling.set(0.1, 0.1, 0.1);
    head.material = material;
    head.rotation.set(Math.PI / 2, 0, 0);
    head.position.set(0, 0, 0.3);
    head.parent = root;
    addToScene(utilityScene, head);

    const tail = createCylinder(engine, {
        diameterTop: 0.005 * thickness,
        height: 0.275,
        diameterBottom: 0.005 * thickness,
        tessellation: 96,
    });
    tail.material = material;
    tail.rotation.set(Math.PI / 2, 0, 0);
    tail.position.set(0, 0, 0.275 / 2);
    tail.parent = root;
    addToScene(utilityScene, tail);

    if (isCollider) {
        head.visible = false;
        tail.visible = false;
    }
    return [head, tail];
}

/** Create an axis scale gizmo in the utility layer.
 * @param engine - Engine that owns the created meshes.
 * @param layer - Utility layer that renders and picks the gizmo.
 * @param options - Drag axis, scale mode, sensitivity, and material options.
 * @returns A detached scale gizmo ready to attach to a node.
 */
export function createAxisScaleGizmo(engine: EngineContext, layer: UtilityLayer, options: AxisScaleGizmoOptions): AxisScaleGizmo {
    const color = options.color ?? [0.5, 0.5, 0.5];
    const thickness = options.thickness ?? 1;
    const sensitivity = options.sensitivity ?? 1;
    const uniformScaling = options.uniformScaling ?? false;
    const localAxis = normalizeVec3Obj(options.dragAxis);
    // The world-space drag axis — mutated each frame in local-coord mode.
    const dragAxis: Vec3 = { x: localAxis.x, y: localAxis.y, z: localAxis.z };
    const utilityScene = layer.scene;

    const materials = createGizmoMaterials(color, options.hoverColor, options.disableColor);

    const root = createCylinder(engine, { diameterTop: 0, diameterBottom: 0, height: 0, tessellation: 3 });
    root.material = materials.colored;
    root.visible = false;
    addToScene(utilityScene, root);

    // Baked local-frame orientation of the gizmo's +Z onto its drag axis,
    // roll-zero (BJS `lookAt(dragAxis)` convention).  In local-coord mode the
    // rendered root orientation is `Q_node ∘ qBake` — i.e. the node's world
    // rotation applied ON TOP of this fixed local orientation, exactly like BJS
    // which bakes the axis lookAt once then sets the gizmo root rotation to the
    // attached node's quaternion.  Recomputing a world-frame lookAt each frame
    // instead would give the (non-roll-symmetric) scale cube a different roll
    // than the reference whenever the node is rotated.
    const qBake = directionToQuat(localAxis);
    // The uniform-scale (central octahedron) handle stays world-aligned, matching
    // BJS where its custom mesh has `updateGizmoRotationToMatchAttachedMesh=false`
    // and no axis lookAt.  The per-axis arrows orient their +Z onto the drag axis.
    if (uniformScaling) {
        root.rotationQuaternion.set(0, 0, 0, 1);
    } else {
        root.rotationQuaternion.set(qBake[0], qBake[1], qBake[2], qBake[3]);
    }
    root.scaling.set(1 / 3, 1 / 3, 1 / 3);

    const visibleMeshes = buildScaleArrow(engine, utilityScene, materials.colored, root, thickness, false, uniformScaling);
    const colliderMeshes = buildScaleArrow(engine, utilityScene, materials.colored, root, thickness + 4, true, uniformScaling);

    const drag = createPointerDrag({
        dragAxis: { x: dragAxis.x, y: dragAxis.y, z: dragAxis.z },
        moveAttached: false,
        // BJS-faithful drag-plane anchor — see axis-drag-gizmo.ts for rationale.
        getPlanePoint: () => ({ x: root.position.x, y: root.position.y, z: root.position.z }),
    });
    drag._colliders = [...visibleMeshes, ...colliderMeshes];

    const onScaleChanged = new GizmoObservable<Vec3>();

    const gizmo: AxisScaleGizmo = {
        root,
        drag,
        onScaleChanged,
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
        // Per-frame drag strength: project the per-frame world delta onto the
        // (world-space) drag axis, normalised by the gizmo root's current
        // world scale length so sensitivity is camera-distance-invariant.
        const sx = root.scaling.x,
            sy = root.scaling.y,
            sz = root.scaling.z;
        const rootLen = Math.hypot(sx, sy, sz) || 1;
        const dotDelta = event.delta.x * dragAxis.x + event.delta.y * dragAxis.y + event.delta.z * dragAxis.z;
        const dragStrength = (sensitivity * dotDelta) / rootLen;

        if (uniformScaling) {
            const m = 1 + dragStrength * 0.57735;
            node.scaling.set(node.scaling.x * m, node.scaling.y * m, node.scaling.z * m);
        } else {
            // Apply along the LOCAL axis components so scaling X, Y, Z stay
            // tied to the node's own local axes.  Using `dragAxis` (the world
            // axis) here would mix scales when the node is rotated.
            const mx = 1 + dragStrength * Math.abs(localAxis.x);
            const my = 1 + dragStrength * Math.abs(localAxis.y);
            const mz = 1 + dragStrength * Math.abs(localAxis.z);
            node.scaling.set(node.scaling.x * mx, node.scaling.y * my, node.scaling.z * mz);
        }
        onScaleChanged.notify({ x: node.scaling.x, y: node.scaling.y, z: node.scaling.z });
    });

    drag.onDragStart.add(() => setMeshesMaterial(visibleMeshes, materials.hover));
    drag.onDragEnd.add(() => setMeshesMaterial(visibleMeshes, materials.colored));
    drag.onHoverStart.add(() => setMeshesMaterial(visibleMeshes, materials.hover));
    drag.onHoverEnd.add(() => {
        if (!drag.dragging) {
            setMeshesMaterial(visibleMeshes, materials.colored);
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
                const worldAxis = transformDirectionByWorld(wm, localAxis);
                dragAxis.x = worldAxis.x;
                dragAxis.y = worldAxis.y;
                dragAxis.z = worldAxis.z;
                const dragOpt = drag.options.dragAxis;
                if (dragOpt) {
                    dragOpt.x = worldAxis.x;
                    dragOpt.y = worldAxis.y;
                    dragOpt.z = worldAxis.z;
                }
                // Render orientation = node world rotation ∘ baked local lookAt,
                // so the scale cube's roll tracks the node exactly as in BJS.
                const qNode = rotationQuatFromMatrix(wm);
                const qr = quatMul(qNode[0], qNode[1], qNode[2], qNode[3], qBake[0], qBake[1], qBake[2], qBake[3]);
                root.rotationQuaternion.set(qr[0], qr[1], qr[2], qr[3]);
            } else if (dragAxis.x !== localAxis.x || dragAxis.y !== localAxis.y || dragAxis.z !== localAxis.z) {
                dragAxis.x = localAxis.x;
                dragAxis.y = localAxis.y;
                dragAxis.z = localAxis.z;
                const dragOpt = drag.options.dragAxis;
                if (dragOpt) {
                    dragOpt.x = localAxis.x;
                    dragOpt.y = localAxis.y;
                    dragOpt.z = localAxis.z;
                }
                root.rotationQuaternion.set(qBake[0], qBake[1], qBake[2], qBake[3]);
            }
        }
    );

    return gizmo;
}

/** Attach the axis scale gizmo to a scene node, or detach it with `null`. */
export function attachAxisScaleGizmoToNode(gizmo: AxisScaleGizmo, node: SceneNode | null): void {
    gizmo.attachedNode = node;
    gizmo.drag.enabled = node !== null;
}

/** Dispose the axis scale gizmo meshes, observers, and pointer-drag registration. */
export function disposeAxisScaleGizmo(gizmo: AxisScaleGizmo, layer: UtilityLayer): void {
    gizmo._disposePointer();
    gizmo._disposeFollow();
    gizmo.onScaleChanged.clear();
    gizmo.drag.onDrag.clear();
    gizmo.drag.onDragStart.clear();
    gizmo.drag.onDragEnd.clear();
    for (const m of gizmo._meshes) {
        removeFromScene(layer.scene, m);
    }
    gizmo._meshes.length = 0;
}
