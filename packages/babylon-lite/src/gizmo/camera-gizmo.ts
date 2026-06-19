/** Camera gizmo — Lite port of BJS CameraGizmo.
 *
 *  Display-only gizmo (no pointer interaction).  Renders the BJS
 *  `_CreateCameraMesh` body (a box + 3 cylinders forming a stylised camera)
 *  at the attached `Camera`'s eye, oriented to match its view direction, plus
 *  an optional wireframe frustum sized by the camera's actual fov / near / far.
 *
 *  The camera body geometry is ported verbatim from BJS so the silhouette
 *  matches the reference; it is distance-scaled to keep a constant on-screen
 *  size while the frustum is drawn in literal world units. */

import type { EngineContext } from "../engine/engine.js";
import type { Camera } from "../camera/camera.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { Mat4 } from "../math/types.js";
import type { SceneContext } from "../scene/scene-core.js";
import { addToScene } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { createBox, createCylinder } from "../mesh/mesh-factories.js";
import { createTransformNode } from "../scene/transform-node.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import { attachFollowTarget } from "./gizmo-core.js";
import { quatFromBjsEuler } from "./gizmo-math.js";
import type { UtilityLayer } from "./utility-layer.js";

/** BJS `CameraGizmo._Scale` — applied to the camera body so it keeps a
 *  constant on-screen size (combined with per-frame distance scaling). */
const CAMERA_BODY_SCALE = 0.05;

/** Default camera-gizmo wireframe thickness in world units (independent of
 *  camera distance because the frustum geometry is in literal world space).
 *  Tuned (≈3× the original hairline) so the cylinder edges render at roughly
 *  the same on-screen width as the BJS reference's antialiased frustum lines —
 *  this minimises the scene-223 parity MAD (0.39 → 0.07 at this value). */
const FRUSTUM_EDGE_THICKNESS = 0.036;

/** Options for the display-only camera gizmo. */
export interface CameraGizmoOptions {
    /** RGB color for the camera body + frustum material.  Defaults to grey. */
    color?: [number, number, number];
    /** RGB color for the frustum wireframe edges (alias of `color` kept for
     *  backward compatibility with the previous tube-body variant). */
    frustumColor?: [number, number, number];
    /** Set to false to omit the frustum wireframe.  Defaults to true. */
    displayFrustum?: boolean;
    /** Set to false to omit the camera body mesh (box + cylinders). Default true. */
    displayBody?: boolean;
}

/** Display-only gizmo that visualizes an attached camera body and optional frustum. */
export interface CameraGizmo {
    /** Root node — the gizmo follows the attached camera's world translation
     *  and orientation each frame. */
    readonly root: SceneNode;
    /** Material shared by the body + frustum.  Mutate `diffuseColor` to recolor. */
    readonly material: StandardMaterialProps;
    /** Alias of `material` — kept for backward compatibility with callers
     *  that mutated `frustumMaterial` against the older variant. */
    readonly frustumMaterial: StandardMaterialProps;
    /** Currently attached camera — set via `attachCameraGizmoToCamera`. */
    attachedCamera: Camera | null;
    /** @internal */
    _meshes: SceneNode[];
    /** @internal */
    _frustumEdges: Mesh[];
    /** @internal — the distance-scaled outer body node (BJS camera-mesh root). */
    _bodyOuter: SceneNode | null;
    /** @internal */
    _disposeFollow: () => void;
}

/** Build the BJS `_CreateCameraMesh` body: a box (the camera housing) plus
 *  three cylinders (two reels + a lens).  Parented to `bodyMesh`, which the
 *  caller offsets / rotates / distance-scales.  Geometry numbers are copied
 *  verbatim from BJS. */
function buildCameraBodyMesh(engine: EngineContext, scene: SceneContext, material: StandardMaterialProps, bodyMesh: SceneNode): Mesh[] {
    const meshes: Mesh[] = [];
    const rotX = quatFromBjsEuler(Math.PI * 0.5, 0, 0);
    const rotZ = quatFromBjsEuler(0, 0, Math.PI * 0.5);

    // Housing — BJS CreateBox(width 1.0, height 0.8, depth 0.5).  Lite's
    // createBox is a unit cube, so scale to the BJS proportions.
    const box = createBox(engine, 1);
    box.scaling.set(1.0, 0.8, 0.5);
    box.material = material;
    box.pickable = false;
    box.parent = bodyMesh;
    addToScene(scene, box);
    meshes.push(box);

    const cyl1 = createCylinder(engine, { height: 0.5, diameterTop: 0.8, diameterBottom: 0.8, tessellation: 24 });
    cyl1.material = material;
    cyl1.pickable = false;
    cyl1.position.set(-0.6, 0.3, 0);
    cyl1.rotationQuaternion.set(rotX[0], rotX[1], rotX[2], rotX[3]);
    cyl1.parent = bodyMesh;
    addToScene(scene, cyl1);
    meshes.push(cyl1);

    const cyl2 = createCylinder(engine, { height: 0.5, diameterTop: 0.6, diameterBottom: 0.6, tessellation: 24 });
    cyl2.material = material;
    cyl2.pickable = false;
    cyl2.position.set(0.4, 0.5, 0);
    cyl2.rotationQuaternion.set(rotX[0], rotX[1], rotX[2], rotX[3]);
    cyl2.parent = bodyMesh;
    addToScene(scene, cyl2);
    meshes.push(cyl2);

    const cyl3 = createCylinder(engine, { height: 0.5, diameterTop: 0.5, diameterBottom: 0.5, tessellation: 24 });
    cyl3.material = material;
    cyl3.pickable = false;
    cyl3.position.set(0.6, 0, 0);
    cyl3.rotationQuaternion.set(rotZ[0], rotZ[1], rotZ[2], rotZ[3]);
    cyl3.parent = bodyMesh;
    addToScene(scene, cyl3);
    meshes.push(cyl3);

    return meshes;
}

/** Build a single edge cylinder oriented from `a` to `b` in `root`'s local
 *  space.  The cylinder is parented to `root` and positioned at the midpoint
 *  with +Y axis rotated onto the edge direction. */
function buildFrustumEdge(
    engine: EngineContext,
    utilityScene: import("../scene/scene-core.js").SceneContext,
    material: StandardMaterialProps,
    root: SceneNode,
    thickness: number,
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number }
): Mesh {
    const mesh = createCylinder(engine, { height: 1, diameterTop: thickness, diameterBottom: thickness, tessellation: 6 });
    mesh.material = material;
    mesh.pickable = false;
    mesh.parent = root;
    addToScene(utilityScene, mesh);
    const dx = b.x - a.x,
        dy = b.y - a.y,
        dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    mesh.position.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
    mesh.scaling.set(1, len, 1);
    const nx = dx / len,
        ny = dy / len,
        nz = dz / len;
    // Quaternion that rotates +Y onto (nx,ny,nz): axis = +Y × n, angle = acos(+Y · n).
    const cx = 1 * nz - 0 * ny;
    const cy = 0 * nx - 0 * nz;
    const cz = 0 * ny - 1 * nx;
    const cLen = Math.hypot(cx, cy, cz);
    const dot = 0 * nx + 1 * ny + 0 * nz;
    if (cLen < 1e-7) {
        if (dot > 0) {
            mesh.rotationQuaternion.set(0, 0, 0, 1);
        } else {
            mesh.rotationQuaternion.set(1, 0, 0, 0);
        }
    } else {
        const angle = Math.atan2(cLen, dot);
        const s = Math.sin(angle * 0.5);
        mesh.rotationQuaternion.set((cx / cLen) * s, (cy / cLen) * s, (cz / cLen) * s, Math.cos(angle * 0.5));
    }
    return mesh;
}

/** Build the 12 frustum-wireframe edges parented to `root`.  Geometry is
 *  computed in camera-local space (LH: camera looks down +Z, +Y up) to exactly
 *  reproduce BJS `_CreateCameraFrustum` + `setPivotMatrix(inv(projection))`.
 *
 *  BJS builds an NDC cube with z ∈ [-1, 1] and transforms it by the inverse
 *  projection.  Because the WebGPU/D3D projection uses z ∈ [0, 1], the cube's
 *  z = -1 ("near") corners do NOT map to the camera's near plane — they map to
 *  view-space z = far·near / (2·far − near).  Reproducing that here so the near
 *  rectangle has the same (smaller) size as the reference; the far corners
 *  (cube z = +1) map to the camera's actual far plane. */
function buildFrustumWireframe(
    engine: EngineContext,
    utilityScene: import("../scene/scene-core.js").SceneContext,
    material: StandardMaterialProps,
    root: SceneNode,
    fov: number,
    aspect: number,
    nearPlane: number,
    farPlane: number
): Mesh[] {
    const tanHalf = Math.tan(fov * 0.5);
    const nearP = Math.max(nearPlane, 1e-4);
    const far = Math.max(farPlane, nearP);
    // View-space depth of the NDC-cube z = -1 plane under a [0,1] projection.
    const near = (far * nearP) / (2 * far - nearP);
    // Perspective half-extents scale linearly with view-space depth.
    const nh = tanHalf * near;
    const nw = nh * aspect;
    const fh = tanHalf * far;
    const fw = fh * aspect;
    const corners = [
        { x: -nw, y: -nh, z: +near },
        { x: +nw, y: -nh, z: +near },
        { x: +nw, y: +nh, z: +near },
        { x: -nw, y: +nh, z: +near },
        { x: -fw, y: -fh, z: +far },
        { x: +fw, y: -fh, z: +far },
        { x: +fw, y: +fh, z: +far },
        { x: -fw, y: +fh, z: +far },
    ];
    const edgePairs: [number, number][] = [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
        [4, 5],
        [5, 6],
        [6, 7],
        [7, 4],
        [0, 4],
        [1, 5],
        [2, 6],
        [3, 7],
    ];
    const meshes: Mesh[] = [];
    for (const [i, j] of edgePairs) {
        meshes.push(buildFrustumEdge(engine, utilityScene, material, root, FRUSTUM_EDGE_THICKNESS, corners[i]!, corners[j]!));
    }
    return meshes;
}

/** Build a display-only camera gizmo and attach it to the given utility
 *  layer.  Call `attachCameraGizmoToCamera` to bind a camera.
 *
 *  The gizmo has two independently-toggleable parts, both visible by default
 *  and parented to a root that follows the attached camera's world translation
 *  + orientation each frame:
 *
 *  - A camera **body** (`displayBody`, defaults to `true`) — a distance-scaled
 *    box + 3 cylinders ported from BJS `_CreateCameraMesh`, lit grey, sized
 *    so it stays a roughly constant size on screen.
 *  - A camera **frustum** (`displayFrustum`, defaults to `true`) — 12 thin
 *    cylinder edges forming a truncated-pyramid wireframe sized from the
 *    camera's fov / near / far (far clamped to 60× near), unlit white.
 *
 *  Set the matching option to `false` to display only one of them. */
export function createCameraGizmo(engine: EngineContext, layer: UtilityLayer, options: CameraGizmoOptions = {}): CameraGizmo {
    const bodyColor = options.color ?? [0.5, 0.5, 0.5];
    const frustumColor = options.frustumColor ?? [1, 1, 1];
    const displayFrustum = options.displayFrustum ?? true;
    const displayBody = options.displayBody ?? true;
    const utilityScene = layer.scene;

    // Lit grey material for the camera body — matches BJS CameraGizmo material
    // exactly (diffuse 0.5, specular 0.1, no emissive; shaded by the utility
    // layer's hemispheric light).
    const material = createStandardMaterial();
    material.diffuseColor = bodyColor;
    material.specularColor = [0.1, 0.1, 0.1];

    // Brighter unlit near-white material for the frustum wireframe so the cage
    // reads as bold solid lines on top of the scene (matches BJS LineSystem
    // frustum, which is unlit/emissive).
    const frustumMaterial = createStandardMaterial();
    frustumMaterial.diffuseColor = frustumColor;
    frustumMaterial.emissiveColor = [1, 1, 1];
    frustumMaterial.disableLighting = true;

    // Invisible root that owns the per-frame transform.  The frustum edges
    // live directly under it in literal world units (scaling stays 1); the
    // camera body lives under a distance-scaled child so it keeps a constant
    // on-screen size.
    const root = createTransformNode("cameraGizmoRoot", 0, 0, 0, 0, 0, 0, 1);
    addToScene(utilityScene, root);

    const gizmo: CameraGizmo = {
        root: root as unknown as SceneNode,
        material,
        frustumMaterial,
        attachedCamera: null,
        _meshes: [root as unknown as SceneNode],
        _frustumEdges: [],
        _bodyOuter: null,
        _disposeFollow: () => undefined,
    };

    // Camera body (BJS `_CreateCameraMesh` + `_update`).  BJS applies the
    // −90° Y rotation and the 0.05 scale on the OUTER root (`_cameraMesh`),
    // and the −0.9 X offset on the INNER `mesh`.  That transform ORDER places
    // the body so its lens tip sits at (just behind) the camera origin and the
    // body extends backward — putting the rotation on the inner node instead
    // would make the lens stick out in front.  So: bodyOuter ≡ outer root
    // (−90° Y + distance×0.05 scale); bodyMesh ≡ inner mesh (−0.9 X, no rot).
    if (displayBody) {
        const outerRot = quatFromBjsEuler(0, -Math.PI * 0.5, 0);
        const bodyOuter = createTransformNode("cameraBodyOuter", 0, 0, 0, outerRot[0], outerRot[1], outerRot[2], outerRot[3]);
        bodyOuter.parent = root as unknown as SceneNode;
        const bodyMesh = createTransformNode("cameraBodyMesh", -0.9, 0, 0, 0, 0, 0, 1);
        bodyMesh.parent = bodyOuter;
        const bodyMeshes = buildCameraBodyMesh(engine, utilityScene, material, bodyMesh);
        gizmo._bodyOuter = bodyOuter;
        gizmo._meshes.push(bodyOuter, bodyMesh, ...bodyMeshes);
    }

    // Frustum wireframe — built lazily from the attached camera on first
    // attach since the geometry depends on its fov + nearPlane + farPlane +
    // canvas aspect.  `displayFrustum: false` skips the wireframe entirely.
    const _ensureFrustum = (cam: Camera): void => {
        if (!displayFrustum || gizmo._frustumEdges.length > 0) {
            return;
        }
        const canvas = engine.canvas;
        const aspect = canvas.width > 0 && canvas.height > 0 ? canvas.width / canvas.height : 16 / 9;
        const fov = cam.fov ?? 0.8;
        const nearPlane = cam.nearPlane ?? 0.1;
        const farPlane = cam.farPlane ?? 100;
        const edges = buildFrustumWireframe(engine, utilityScene, frustumMaterial, root as unknown as SceneNode, fov, aspect, nearPlane, farPlane);
        gizmo._frustumEdges = edges;
        gizmo._meshes.push(...edges);
    };
    (gizmo as unknown as { _ensureFrustum: (cam: Camera) => void })._ensureFrustum = _ensureFrustum;

    // Per-frame: copy attached camera's world translation + rotation onto the
    // gizmo root.  Camera world matrices in Lite are camera-to-world, so the
    // translation is the eye position and the upper 3×3 is the camera basis.
    // Pass `null` scaleRatio so root stays at scale 1 (frustum is world units);
    // the body outer node is distance-scaled separately here.
    gizmo._disposeFollow = attachFollowTarget(
        utilityScene,
        root as unknown as SceneNode,
        () => (gizmo.attachedCamera ? cameraAsSceneNode(gizmo.attachedCamera) : null),
        null,
        (_target, wm) => {
            const [qx, qy, qz, qw] = quatFromMat4Upper3x3(wm);
            root.rotationQuaternion.set(qx, qy, qz, qw);
            // Distance-scale the camera body (BJS Gizmo distance scaling ×
            // CameraGizmo._Scale).
            if (gizmo._bodyOuter) {
                const cam = utilityScene.camera;
                let dist = CAMERA_BODY_SCALE;
                if (cam) {
                    const cw = cam.worldMatrix;
                    dist = Math.hypot(cw[12]! - wm[12]!, cw[13]! - wm[13]!, cw[14]! - wm[14]!) * CAMERA_BODY_SCALE;
                }
                gizmo._bodyOuter.scaling.set(dist, dist, dist);
            }
        }
    );

    return gizmo;
}

/** Attach the camera gizmo to a camera, or detach it with `null`.
 * The frustum wireframe is built lazily the first time a camera is attached.
 */
export function attachCameraGizmoToCamera(gizmo: CameraGizmo, camera: Camera | null): void {
    gizmo.attachedCamera = camera;
    if (camera) {
        const ensure = (gizmo as unknown as { _ensureFrustum?: (cam: Camera) => void })._ensureFrustum;
        if (ensure) {
            ensure(camera);
        }
    }
}

/** Dispose all meshes and follow callbacks owned by the camera gizmo. */
export function disposeCameraGizmo(gizmo: CameraGizmo, layer: UtilityLayer): void {
    gizmo._disposeFollow();
    for (const m of gizmo._meshes) {
        if ("_gpu" in (m as unknown as Record<string, unknown>)) {
            removeFromScene(layer.scene, m as unknown as Mesh);
        } else {
            (m as unknown as { parent: SceneNode | null }).parent = null;
        }
    }
    gizmo._meshes.length = 0;
}

// ─── Internal helpers ─────────────────────────────────────────────────

/** Adapt a `Camera` to look like a `SceneNode` for `attachFollowTarget`.
 *  Cameras don't expose `position`/`rotationQuaternion`/`scaling` as
 *  observable vec3s, but `attachFollowTarget` only reads `.worldMatrix`. */
function cameraAsSceneNode(cam: Camera): SceneNode {
    return cam as unknown as SceneNode;
}

/** Extract the rotation quaternion from the upper-left 3×3 of a 4×4 world
 *  matrix.  Removes per-axis scale by normalizing each column. */
function quatFromMat4Upper3x3(m: Mat4): [number, number, number, number] {
    const sx = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
    const sy = Math.hypot(m[4]!, m[5]!, m[6]!) || 1;
    const sz = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
    const m00 = m[0]! / sx,
        m01 = m[4]! / sy,
        m02 = m[8]! / sz;
    const m10 = m[1]! / sx,
        m11 = m[5]! / sy,
        m12 = m[9]! / sz;
    const m20 = m[2]! / sx,
        m21 = m[6]! / sy,
        m22 = m[10]! / sz;
    // Standard Shoemake quaternion-from-matrix.
    const trace = m00 + m11 + m22;
    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1);
        return [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
    }
    if (m00 > m11 && m00 > m22) {
        const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
        return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    }
    if (m11 > m22) {
        const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
        return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
    }
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}
