/** Plane rotation gizmo — Lite port of BJS PlaneRotationGizmo.
 *
 *  Geometry (mirrors BJS `_createGizmoMesh`):
 *    • Visible torus ring: diameter 0.6, thickness 0.005, tessellation 32.
 *    • Invisible collider torus: same diameter, thickness 0.03 (6× thicker).
 *    • Both rotated 90° on X so the ring plane is perpendicular to +Z.
 *    • Root oriented via `lookAtQuat(planeNormal)` and scaled 1/3.
 *
 *  Rotation math: each frame compute angle between
 *  `(lastDragPoint - nodeCenter)` and `(currentDragPoint - nodeCenter)`,
 *  measured around the plane normal (signed).  The quaternion of that angle
 *  is left-multiplied into the attached node's `rotationQuaternion`. */

import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { Vec3 } from "../math/types.js";
import type { ShaderMaterial } from "../material/shader/shader-material.js";
import { addToScene } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { createCylinder, createPlane, createTorus } from "../mesh/mesh-factories.js";
import { setShaderUniform } from "../material/shader/shader-material.js";
import { mat4Invert } from "../math/mat4-invert.js";
import { createGizmoMaterials, setMeshesMaterial, attachFollowTarget, GizmoObservable } from "./gizmo-core.js";
import type { GizmoMaterialSet } from "./gizmo-core.js";
import { lookAtQuat, normalizeVec3Obj, quatFromAxisAngle, quatMul, quatNormalize, signedAngleAroundNormal, transformDirectionByWorld, worldRotationToLocal } from "./gizmo-math.js";
import { createPointerDrag, registerPointerDrag } from "./pointer-drag.js";
import type { PointerDrag } from "./pointer-drag.js";
import type { UtilityLayer } from "./utility-layer.js";
import { createRotationSectorMaterial } from "./rotation-sector-material.js";

export interface PlaneRotationGizmoOptions {
    /** World-space rotation plane normal (unit vector). */
    planeNormal: Vec3;
    color?: [number, number, number];
    hoverColor?: [number, number, number];
    disableColor?: [number, number, number];
    /** Torus tessellation.  Default 32 (matches BJS). */
    tessellation?: number;
    /** Tube thickness multiplier.  Default 1. */
    thickness?: number;
    /** Colour of the rotation "camembert" sector visual shown while dragging.
     *  Defaults to the hover colour. */
    rotationColor?: [number, number, number];
}

export interface PlaneRotationGizmo {
    readonly root: SceneNode;
    readonly drag: PointerDrag;
    readonly onRotationChanged: GizmoObservable<[number, number, number, number]>;
    attachedNode: SceneNode | null;
    /** Local-coord mode: plane normal rotates with the attached node. */
    useLocalCoordinates: boolean;
    readonly materials: GizmoMaterialSet;
    /** ShaderMaterial driving the rotation-sector camembert visual.  Exposed so
     *  callers can change the colour at runtime. */
    readonly rotationDisplayMaterial: ShaderMaterial;
    /** @internal — rendered (visible) ring mesh whose material is swapped for
     *  hover / colored / disabled.  Excludes the collider + camembert plane. */
    _visibleMeshes: Mesh[];
    /** @internal */
    _meshes: Mesh[];
    /** @internal */
    _disposePointer: () => void;
    /** @internal */
    _disposeFollow: () => void;
}

export function createPlaneRotationGizmo(engine: EngineContext, layer: UtilityLayer, options: PlaneRotationGizmoOptions): PlaneRotationGizmo {
    const color = options.color ?? [0.5, 0.5, 0.5];
    const tessellation = options.tessellation ?? 32;
    const thickness = options.thickness ?? 1;
    const utilityScene = layer.scene;
    const materials = createGizmoMaterials(color, options.hoverColor, options.disableColor);

    const root = createCylinder(engine, { diameterTop: 0, diameterBottom: 0, height: 0, tessellation: 3 });
    root.material = materials.colored;
    root.visible = false;
    addToScene(utilityScene, root);

    const q = lookAtQuat(options.planeNormal);
    root.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
    root.scaling.set(1 / 3, 1 / 3, 1 / 3);

    const ring = createTorus(engine, { diameter: 0.6, thickness: 0.005 * thickness, tessellation });
    ring.material = materials.colored;
    ring.rotation.set(Math.PI / 2, 0, 0);
    ring.parent = root;
    addToScene(utilityScene, ring);

    const collider = createTorus(engine, { diameter: 0.6, thickness: 0.03 * thickness, tessellation });
    collider.material = materials.colored;
    collider.rotation.set(Math.PI / 2, 0, 0);
    collider.visible = false;
    collider.parent = root;
    addToScene(utilityScene, collider);

    // Rotation "camembert" display plane — a 0.6×0.6 quad parented to the
    // gizmo root, rotated 90° around Z so it sits in the rotation plane.
    // Initially hidden; toggled visible while a drag is in progress.  The
    // ShaderMaterial mirrors BJS's `_rotationShaderMaterial` GLSL sector
    // arc visual.
    const rotationColor = options.rotationColor ?? options.hoverColor ?? [1, 1, 0];
    const rotationDisplayMaterial = createRotationSectorMaterial(rotationColor);
    const rotationDisplayPlane = createPlane(engine, { size: 0.6 });
    rotationDisplayPlane.material = rotationDisplayMaterial;
    rotationDisplayPlane.rotation.set(0, 0, Math.PI / 2);
    rotationDisplayPlane.visible = false;
    // The camembert display plane is purely visual — it never participates in
    // gizmo picking.  Marking it non-pickable keeps it out of the GPU picker
    // pass so it doesn't shadow nearby gizmo colliders.
    rotationDisplayPlane.pickable = false;
    rotationDisplayPlane.parent = root;
    addToScene(utilityScene, rotationDisplayPlane);

    const drag = createPointerDrag({
        dragPlaneNormal: { x: options.planeNormal.x, y: options.planeNormal.y, z: options.planeNormal.z },
        moveAttached: false,
        // BJS-faithful drag-plane anchor — see axis-drag-gizmo.ts for rationale.
        getPlanePoint: () => ({ x: root.position.x, y: root.position.y, z: root.position.z }),
    });
    drag._colliders = [ring, collider];

    const onRotationChanged = new GizmoObservable<[number, number, number, number]>();
    // The world-space plane normal — mutated each frame when in local-coord mode.
    const planeNormal: Vec3 = { x: 0, y: 0, z: 0 };
    const initialNormal = normalizeVec3Obj(options.planeNormal);
    planeNormal.x = initialNormal.x;
    planeNormal.y = initialNormal.y;
    planeNormal.z = initialNormal.z;
    const localNormal: Vec3 = { x: initialNormal.x, y: initialNormal.y, z: initialNormal.z };
    let lastDragPoint: Vec3 | null = null;
    let cumulativeAngle = 0;
    // Mutable scratch tuple reused per uniform-set to avoid per-frame allocs.
    const anglesUniform: [number, number, number] = [0, 0, 1];

    const gizmo: PlaneRotationGizmo = {
        root,
        drag,
        onRotationChanged,
        attachedNode: null,
        useLocalCoordinates: false,
        materials,
        rotationDisplayMaterial,
        _visibleMeshes: [ring],
        _meshes: [root, ring, collider, rotationDisplayPlane],
        _disposePointer: () => undefined,
        _disposeFollow: () => undefined,
    };

    drag.onDragStart.add((event) => {
        lastDragPoint = { x: event.dragPlanePoint.x, y: event.dragPlanePoint.y, z: event.dragPlanePoint.z };
        cumulativeAngle = 0;
        setMeshesMaterial([ring], materials.hover);

        // Compute the initial angle in the display plane's local frame so the
        // camembert starts at the correct angle around the centre.
        const planeWorld = rotationDisplayPlane.worldMatrix;
        const invPlane = mat4Invert(planeWorld);
        if (invPlane) {
            const px = event.dragPlanePoint.x,
                py = event.dragPlanePoint.y,
                pz = event.dragPlanePoint.z;
            const lx = invPlane[0]! * px + invPlane[4]! * py + invPlane[8]! * pz + invPlane[12]!;
            const ly = invPlane[1]! * px + invPlane[5]! * py + invPlane[9]! * pz + invPlane[13]!;
            anglesUniform[0] = Math.atan2(ly, lx) + Math.PI;
        } else {
            anglesUniform[0] = 0;
        }
        anglesUniform[1] = 0;
        anglesUniform[2] = 1; // updateGizmoRotationToMatchAttachedMesh = true (default behaviour)
        setShaderUniform(rotationDisplayMaterial, "angles", anglesUniform);

        rotationDisplayPlane.visible = true;
    });
    drag.onDragEnd.add(() => {
        lastDragPoint = null;
        setMeshesMaterial([ring], materials.colored);
        rotationDisplayPlane.visible = false;
    });
    drag.onHoverStart.add(() => setMeshesMaterial([ring], materials.hover));
    drag.onHoverEnd.add(() => {
        if (!drag.dragging) {
            setMeshesMaterial([ring], materials.colored);
        }
    });

    drag.onDrag.add((event) => {
        const node = gizmo.attachedNode;
        if (!node || !lastDragPoint) {
            return;
        }
        // Centre of rotation = the node's WORLD position (not local).  For a
        // parented node, `node.position` is the position in the parent's frame
        // and doesn't match the actual world location of the cube.
        const wm = node.worldMatrix;
        const nx = wm[12]!,
            ny = wm[13]!,
            nz = wm[14]!;
        const a: Vec3 = { x: lastDragPoint.x - nx, y: lastDragPoint.y - ny, z: lastDragPoint.z - nz };
        const b: Vec3 = { x: event.dragPlanePoint.x - nx, y: event.dragPlanePoint.y - ny, z: event.dragPlanePoint.z - nz };
        const angle = signedAngleAroundNormal(a, b, planeNormal);
        if (Math.abs(angle) < 1e-7) {
            lastDragPoint = { x: event.dragPlanePoint.x, y: event.dragPlanePoint.y, z: event.dragPlanePoint.z };
            return;
        }
        // `dq` is a WORLD-space rotation around `planeNormal`.  For a parented
        // node we need the equivalent LOCAL rotation that, after the parent's
        // own world rotation is applied, produces the same world delta.
        const dq = quatFromAxisAngle(planeNormal.x, planeNormal.y, planeNormal.z, angle);
        const localDq = worldRotationToLocal(node, dq[0], dq[1], dq[2], dq[3]);
        const rq = node.rotationQuaternion;
        const out = quatNormalize(quatMul(localDq[0], localDq[1], localDq[2], localDq[3], rq.x, rq.y, rq.z, rq.w));
        rq.set(out[0], out[1], out[2], out[3]);
        onRotationChanged.notify(out);
        lastDragPoint = { x: event.dragPlanePoint.x, y: event.dragPlanePoint.y, z: event.dragPlanePoint.z };

        // Accumulate angle for the camembert visual.  BJS uses left-handed
        // coords by default (`useRightHandedSystem === false`), in which case
        // `_angles.y += angle` (positive sign).
        cumulativeAngle += angle;
        anglesUniform[1] = cumulativeAngle;
        setShaderUniform(rotationDisplayMaterial, "angles", anglesUniform);
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
                planeNormal.x = worldNormal.x;
                planeNormal.y = worldNormal.y;
                planeNormal.z = worldNormal.z;
                const n = drag.options.dragPlaneNormal;
                if (n) {
                    n.x = worldNormal.x;
                    n.y = worldNormal.y;
                    n.z = worldNormal.z;
                }
                const q = lookAtQuat(worldNormal);
                root.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
            } else if (planeNormal.x !== localNormal.x || planeNormal.y !== localNormal.y || planeNormal.z !== localNormal.z) {
                planeNormal.x = localNormal.x;
                planeNormal.y = localNormal.y;
                planeNormal.z = localNormal.z;
                const n = drag.options.dragPlaneNormal;
                if (n) {
                    n.x = localNormal.x;
                    n.y = localNormal.y;
                    n.z = localNormal.z;
                }
                const q = lookAtQuat(localNormal);
                root.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
            }
        }
    );

    return gizmo;
}

export function attachPlaneRotationGizmoToNode(gizmo: PlaneRotationGizmo, node: SceneNode | null): void {
    gizmo.attachedNode = node;
    gizmo.drag.enabled = node !== null;
}

export function disposePlaneRotationGizmo(gizmo: PlaneRotationGizmo, layer: UtilityLayer): void {
    gizmo._disposePointer();
    gizmo._disposeFollow();
    gizmo.onRotationChanged.clear();
    gizmo.drag.onDrag.clear();
    gizmo.drag.onDragStart.clear();
    gizmo.drag.onDragEnd.clear();
    for (const m of gizmo._meshes) {
        removeFromScene(layer.scene, m);
    }
    gizmo._meshes.length = 0;
}
