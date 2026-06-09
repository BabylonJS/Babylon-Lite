/** Bounding-box gizmo — Lite port of BJS BoundingBoxGizmo.
 *
 *  Computes the axis-aligned bounding box of the attached node + all of its
 *  descendant meshes and renders:
 *    • 12 wireframe edges (thin cylinders since Lite has no line-system mesh)
 *    • 8 corner cubes — drag any corner to uniformly scale the attached node
 *    • 12 edge-midpoint anchors — drag tangentially to rotate around the
 *      edge's parallel axis
 *    • An invisible body-plane that drags the attached node in the camera plane
 *
 *  This is intentionally a minimal port — BJS supports per-axis factors,
 *  snap distances, scale pivots, near-grabbable hints, hover state, and a
 *  bag of additional controls.  Lite covers the essential UX (scale, rotate,
 *  translate) faithfully enough to drive a parity scene without porting
 *  every BJS knob. */

import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Vec3 } from "../math/types.js";
import { addToScene, onBeforeRender } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { createBox, createCylinder } from "../mesh/mesh-factories.js";
import { computeAabb } from "../math/compute-aabb.js";
import { mat4FromQuat } from "../math/mat4-from-quat.js";
import { mat4Multiply } from "../math/mat4-multiply.js";
import type { Mat4 } from "../math/types.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import { createPointerDrag, registerPointerDrag } from "./pointer-drag.js";
import type { UtilityLayer } from "./utility-layer.js";
import { GizmoObservable } from "./gizmo-core.js";
import {
    lookAtQuat,
    quatFromAxisAngle,
    quatMul,
    quatNormalize,
    rotateVec3ByQuat,
    rotationQuatFromMatrix,
    signedAngleAroundNormal,
    worldDeltaToLocal,
    worldRotationToLocal,
} from "./gizmo-math.js";

/** A rotation quaternion as a 4-tuple `[x, y, z, w]`. */
type Quat = readonly [number, number, number, number];

const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/** Rotate `p` by quaternion `q` (helper around rotateVec3ByQuat returning Vec3). */
function rotatePoint(q: Quat, p: Vec3): Vec3 {
    const [x, y, z] = rotateVec3ByQuat(q[0], q[1], q[2], q[3], p.x, p.y, p.z);
    return { x, y, z };
}

export interface BoundingBoxGizmoOptions {
    /** RGB colour for the wireframe + handle materials. Defaults to grey. */
    color?: [number, number, number];
    /** Edge wireframe thickness (world units before scaling). Default 0.06. */
    edgeThickness?: number;
    /** Side length of the 8 corner scale boxes (world units). Default 0.18. */
    scaleBoxSize?: number;
    /** Length of the 12 elongated edge rotation anchors (world units). Default
     *  0.16; thickness is length/4 (BJS 1.6:0.4 ratio). */
    rotationAnchorSize?: number;
}

export interface BoundingBoxGizmo {
    readonly root: SceneNode;
    /** Currently attached node — set via `attachBoundingBoxGizmoToNode`. */
    attachedNode: SceneNode | null;
    /** Fires when any drag (scale / rotate / translate) updates the attached node. */
    readonly onChanged: GizmoObservable<void>;
    /** Material used to render all gizmo geometry. */
    readonly material: StandardMaterialProps;
    /** @internal */
    _meshes: Mesh[];
    /** @internal */
    _disposers: (() => void)[];
    /** @internal — recompute the AABB and refresh handle positions. */
    _refresh: () => void;
    /** @internal — local bounding diagonal length captured at attach time.
     *  BJS uses `_boundingDimensions.length()` (the LOCAL, unscaled diag) as the
     *  denominator in the rotation-drag heuristic; capturing once at attach
     *  matches that. Updated again on (re)attach. */
    _initialBoundingDiag: number;
}

interface AabbBounds {
    min: Vec3;
    max: Vec3;
    centre: Vec3;
    size: Vec3;
}

const INFINITE_AABB: AabbBounds = {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 0, y: 0, z: 0 },
    centre: { x: 0, y: 0, z: 0 },
    size: { x: 0, y: 0, z: 0 },
};

/** Walk the SceneNode tree rooted at `root` and accumulate a world-space AABB
 *  covering every descendant mesh that exposes a CPU position buffer. */
/** Walk the SceneNode tree rooted at `root` and accumulate a world-space AABB
 *  covering every descendant mesh.  Supplements the public `.children` walk
 *  (which loaders / setParent do not always populate) with a parent-chain
 *  filter over `extraCandidates` so meshes added via `cube.parent = root`
 *  are still discovered. */
function computeBoundsRecursive(root: SceneNode, extraCandidates?: readonly Mesh[], preTransform?: Mat4): AabbBounds {
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    const isDescendantOfRoot = (node: SceneNode): boolean => {
        let p: SceneNode | null = node;
        while (p) {
            if (p === root) {
                return true;
            }
            p = (p as unknown as { parent?: SceneNode | null }).parent ?? null;
        }
        return false;
    };
    const visit = (node: SceneNode): void => {
        const probe = node as unknown as { _gpu?: unknown; _cpuPositions?: Float32Array; worldMatrix?: Readonly<Float32Array> };
        if (probe._gpu && probe._cpuPositions && probe.worldMatrix) {
            // When `preTransform` is supplied, fold it into the mesh's world
            // matrix so the AABB is computed in that rotated frame (used to get
            // the node's rotation-removed bounds for the OBB cage).
            const m = preTransform ? mat4Multiply(preTransform, probe.worldMatrix as unknown as Mat4) : (probe.worldMatrix as never);
            const aabb = computeAabb(probe._cpuPositions, m as never);
            if (Number.isFinite(aabb[0][0])) {
                if (aabb[0][0] < minX) {
                    minX = aabb[0][0];
                }
                if (aabb[0][1] < minY) {
                    minY = aabb[0][1];
                }
                if (aabb[0][2] < minZ) {
                    minZ = aabb[0][2];
                }
                if (aabb[1][0] > maxX) {
                    maxX = aabb[1][0];
                }
                if (aabb[1][1] > maxY) {
                    maxY = aabb[1][1];
                }
                if (aabb[1][2] > maxZ) {
                    maxZ = aabb[1][2];
                }
            }
        }
    };
    const stack: SceneNode[] = [root];
    const visited = new Set<SceneNode>();
    while (stack.length > 0) {
        const node = stack.pop()!;
        if (visited.has(node)) {
            continue;
        }
        visited.add(node);
        visit(node);
        if (node.children) {
            for (const c of node.children) {
                stack.push(c);
            }
        }
    }
    // Sweep the optional candidate list (typically `mainScene.meshes`) so
    // descendants attached via the `.parent` setter alone — without being
    // pushed into the public `.children` array — are still folded in.
    if (extraCandidates) {
        for (const m of extraCandidates) {
            if (visited.has(m)) {
                continue;
            }
            if (isDescendantOfRoot(m)) {
                visited.add(m);
                visit(m);
            }
        }
    }
    if (!Number.isFinite(minX)) {
        return INFINITE_AABB;
    }
    return {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
        centre: { x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5, z: (minZ + maxZ) * 0.5 },
        size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    };
}

/** Build a single edge cylinder oriented from `a` to `b`.  Returned with no
 *  parent — caller can parent it or leave it in world space. */
function buildEdge(engine: EngineContext, utilityScene: SceneContext, material: StandardMaterialProps, thickness: number): { mesh: Mesh; place: (a: Vec3, b: Vec3) => void } {
    // Cylinder default axis is +Y; rotate to align with edge direction.
    const mesh = createCylinder(engine, { height: 1, diameterTop: thickness, diameterBottom: thickness, tessellation: 6 });
    mesh.material = material;
    mesh.pickable = false;
    addToScene(utilityScene, mesh);
    const place = (a: Vec3, b: Vec3): void => {
        const dx = b.x - a.x,
            dy = b.y - a.y,
            dz = b.z - a.z;
        const len = Math.hypot(dx, dy, dz);
        mesh.position.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
        // Scale only the Y dimension to the edge length; X/Z stay 1 so the
        // tube diameter remains as configured.  Guard against zero-length
        // edges (degenerate AABB) which would otherwise mark the cylinder
        // as invisible/zero-extent.
        const safeLen = Math.max(0.001, len);
        mesh.scaling.set(1, safeLen, 1);
        if (len < 1e-8) {
            mesh.rotationQuaternion.set(0, 0, 0, 1);
            return;
        }
        // Build a quaternion that rotates +Y onto (b-a).
        const dirX = dx / len,
            dirY = dy / len,
            dirZ = dz / len;
        const upDot = dirY;
        if (upDot > 0.9999999) {
            mesh.rotationQuaternion.set(0, 0, 0, 1);
            return;
        }
        if (upDot < -0.9999999) {
            mesh.rotationQuaternion.set(0, 0, 1, 0);
            return;
        }
        // axis = cross([0,1,0], dir) = (dirZ, 0, -dirX)
        const angle = Math.acos(upDot);
        const half = angle * 0.5;
        const s = Math.sin(half);
        const ax = dirZ,
            az = -dirX;
        const aLen = Math.hypot(ax, 0, az) || 1;
        mesh.rotationQuaternion.set((ax / aLen) * s, 0, (az / aLen) * s, Math.cos(half));
    };
    return { mesh, place };
}

/** Build a small cube handle at world position `p`. Returned with no parent. */
function buildHandle(engine: EngineContext, utilityScene: SceneContext, material: StandardMaterialProps, size: number): { mesh: Mesh; place: (p: Vec3, q: Quat) => void } {
    const mesh = createBox(engine, size);
    mesh.material = material;
    addToScene(utilityScene, mesh);
    const place = (p: Vec3, q: Quat): void => {
        mesh.position.set(p.x, p.y, p.z);
        mesh.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
    };
    return { mesh, place };
}

/** Build an elongated box rotation anchor for a bounding-box edge.  Mirrors BJS
 *  BoundingBoxGizmo's rotate anchors — a `1.6 × 0.4 × 0.4` box scaled by
 *  `rotationSphereSize` (0.1), i.e. a thin bar that runs ALONG the edge it sits
 *  on (a ~4:1 length:thickness ratio), not a cube.  `axis` is the world-space
 *  edge direction the bar is elongated along. */
function buildEdgeAnchor(
    engine: EngineContext,
    utilityScene: SceneContext,
    material: StandardMaterialProps,
    axis: Vec3,
    length: number,
    thickness: number
): { mesh: Mesh; place: (p: Vec3, q: Quat) => void } {
    const mesh = createBox(engine, 1);
    // Elongate along the dominant component of `axis`; thin on the other two.
    const ax = Math.abs(axis.x),
        ay = Math.abs(axis.y),
        az = Math.abs(axis.z);
    mesh.scaling.set(ax >= ay && ax >= az ? length : thickness, ay >= ax && ay >= az ? length : thickness, az >= ax && az >= ay ? length : thickness);
    mesh.material = material;
    addToScene(utilityScene, mesh);
    // `p` is the bar's WORLD position; `q` orients the bar so its long axis runs
    // along the (possibly rotated) edge.
    const place = (p: Vec3, q: Quat): void => {
        mesh.position.set(p.x, p.y, p.z);
        mesh.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
    };
    return { mesh, place };
}

/** Build a 3-box corner handle — three thin elongated boxes meeting at the
 *  origin, one along each principal axis.  Mimics BJS BoundingBoxGizmo
 *  corner geometry (`_createInnerBox` × 3).  Returns the union with a
 *  `place(p)` that positions all three at the corner together.  Only the
 *  first mesh is registered as the picker collider; the other two share its
 *  material and follow its position via parenting. */
function buildCornerHandle(
    engine: EngineContext,
    utilityScene: SceneContext,
    material: StandardMaterialProps,
    size: number,
    armLen: number,
    axisSigns: [number, number, number]
): { mesh: Mesh; meshes: Mesh[]; place: (p: Vec3, q: Quat) => void } {
    // Anchor "X" arm — the picker collider.  The two other arms (Y, Z) are
    // parented to this anchor so they move with it.
    const anchor = createBox(engine, 1);
    anchor.scaling.set(armLen, size, size);
    anchor.position.set((armLen * 0.5 - size * 0.5) * axisSigns[0], 0, 0);
    anchor.material = material;
    addToScene(utilityScene, anchor);

    const yArm = createBox(engine, 1);
    yArm.scaling.set(size, armLen, size);
    yArm.position.set(0, (armLen * 0.5 - size * 0.5) * axisSigns[1], 0);
    yArm.material = material;
    yArm.parent = anchor;
    addToScene(utilityScene, yArm);

    const zArm = createBox(engine, 1);
    zArm.scaling.set(size, size, armLen);
    zArm.position.set(0, 0, (armLen * 0.5 - size * 0.5) * axisSigns[2]);
    zArm.material = material;
    zArm.parent = anchor;
    addToScene(utilityScene, zArm);

    // The yArm/zArm positions above are in anchor-local space.  Since anchor's
    // scaling is (armLen, size, size), the arms get stretched by that scaling.
    // Reset arm scales accordingly so they don't inherit anchor's stretch:
    // we want each arm to have its OWN absolute scale, independent of anchor.
    // Easiest fix: don't parent the secondary arms — keep them as independent
    // siblings that follow the anchor's position in `place`.
    yArm.parent = null;
    zArm.parent = null;

    // Local-frame offset of each arm from the corner point (along its axis).
    const offX = (armLen * 0.5 - size * 0.5) * axisSigns[0];
    const offY = (armLen * 0.5 - size * 0.5) * axisSigns[1];
    const offZ = (armLen * 0.5 - size * 0.5) * axisSigns[2];
    // `p` is the corner's WORLD position; `q` is the OBB rotation.  Each arm's
    // offset is rotated by `q` and each arm box is oriented by `q` so the L
    // aligns with the (possibly rotated) bounding box.
    const place = (p: Vec3, q: Quat): void => {
        const oX = rotatePoint(q, { x: offX, y: 0, z: 0 });
        anchor.position.set(p.x + oX.x, p.y + oX.y, p.z + oX.z);
        anchor.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
        const oY = rotatePoint(q, { x: 0, y: offY, z: 0 });
        yArm.position.set(p.x + oY.x, p.y + oY.y, p.z + oY.z);
        yArm.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
        const oZ = rotatePoint(q, { x: 0, y: 0, z: offZ });
        zArm.position.set(p.x + oZ.x, p.y + oZ.y, p.z + oZ.z);
        zArm.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
    };
    return { mesh: anchor, meshes: [anchor, yArm, zArm], place };
}

/** Apply a uniform scale factor `f` to `node.scaling`. */
function applyUniformScale(node: SceneNode, f: number): void {
    const minScale = 1e-4;
    node.scaling.set(Math.max(minScale, node.scaling.x * f), Math.max(minScale, node.scaling.y * f), Math.max(minScale, node.scaling.z * f));
}

/** Scale a single local axis component of `node.scaling` by `f` (others kept). */
function applyAxisScale(node: SceneNode, comp: "x" | "y" | "z", f: number): void {
    const minScale = 1e-4;
    const sx = comp === "x" ? Math.max(minScale, node.scaling.x * f) : node.scaling.x;
    const sy = comp === "y" ? Math.max(minScale, node.scaling.y * f) : node.scaling.y;
    const sz = comp === "z" ? Math.max(minScale, node.scaling.z * f) : node.scaling.z;
    node.scaling.set(sx, sy, sz);
}

/** Rotate `node` by `angle` radians around world axis (ax, ay, az). */
function applyRotation(node: SceneNode, ax: number, ay: number, az: number, angle: number): void {
    const dq = quatFromAxisAngle(ax, ay, az, angle);
    const rq = node.rotationQuaternion;
    const out = quatNormalize(quatMul(dq[0], dq[1], dq[2], dq[3], rq.x, rq.y, rq.z, rq.w));
    rq.set(out[0], out[1], out[2], out[3]);
}

export function createBoundingBoxGizmo(engine: EngineContext, layer: UtilityLayer, options: BoundingBoxGizmoOptions = {}): BoundingBoxGizmo {
    const color = options.color ?? [0.8, 0.8, 0.8];
    const edgeThickness = options.edgeThickness ?? 0.02;
    const scaleBoxSize = options.scaleBoxSize ?? 0.04;
    // Corner L-arm length — BJS uses a 1.6×0.4×0.4 bar scaled by 0.1 → 0.16
    // long × 0.04 thick (a 4:1 ratio).  Match that so the corner resize handles
    // aren't oversized relative to the reference.
    const cornerArmLen = scaleBoxSize * 4;
    // Rotation edge anchors are elongated bars (BJS rotate anchors): `length`
    // along the edge, `thickness` (length/4, matching BJS 1.6:0.4) on the other
    // two axes.
    const rotationAnchorLength = options.rotationAnchorSize ?? 0.16;
    const rotationAnchorThickness = rotationAnchorLength / 4;
    // Face-centre single-axis scale cubes — BJS uses a unit box scaled by
    // scaleBoxSize (0.1), so they read noticeably larger than the thin corner
    // arms.  Match that size.
    const faceBoxSize = 0.1;
    const utilityScene = layer.scene;
    const canvas = engine.canvas;
    const onChanged = new GizmoObservable<void>();

    // Unlit material so gizmo geometry keeps its configured colour in the
    // dim utility scene.
    const material = createStandardMaterial();
    material.diffuseColor = color;
    material.emissiveColor = [1, 1, 1];
    material.disableLighting = true;

    // Hover material — same configuration as `material` but yellow.  Swapped
    // in via the dispatcher's hover callbacks so the handle the user is about
    // to grab lights up before any drag begins.
    const hoverMaterial = createStandardMaterial();
    hoverMaterial.diffuseColor = [1, 1, 0];
    hoverMaterial.emissiveColor = [1, 1, 1];
    hoverMaterial.disableLighting = true;

    // Invisible root — keeps a SceneNode anchor for the gizmo even though
    // each handle/edge is positioned directly in world space (no per-handle
    // parenting so re-positioning per frame is a single mesh.position.set
    // per handle without parent-world-matrix recomputation).
    const root = createCylinder(engine, { diameterTop: 0, diameterBottom: 0, height: 0, tessellation: 3 });
    root.material = material;
    root.visible = false;
    root.pickable = false;
    addToScene(utilityScene, root);

    // ── Build 12 wireframe edges + their `place` callbacks ──
    const edges: { mesh: Mesh; place: (a: Vec3, b: Vec3) => void }[] = [];
    for (let i = 0; i < 12; i++) {
        const e = buildEdge(engine, utilityScene, material, edgeThickness);
        e.mesh.name = `bbox-edge${i}`;
        edges.push(e);
    }

    // ── 8 corner handles (scale) — each corner is 3 thin orthogonal boxes ──
    // The signs encode which octant the corner sits in.  `axisSigns` tells
    // each corner which direction its arms extend INWARD toward the bbox
    // centre.  The picker collider is the X-arm; the other two arms render
    // alongside without participating in picking.
    const corners: { mesh: Mesh; meshes: Mesh[]; place: (p: Vec3, q: Quat) => void }[] = [];
    for (let i = 0; i < 8; i++) {
        // Bit→axis mapping MUST match the placement loop in `layout`, which
        // iterates x (outer) → y → z (inner), so corner `i` sits at:
        //   X = max iff (i & 4), Y = max iff (i & 2), Z = max iff (i & 1).
        const sx = i & 4 ? +1 : -1;
        const sy = i & 2 ? +1 : -1;
        const sz = i & 1 ? +1 : -1;
        // Arms extend FROM the corner TOWARD the bbox centre, i.e. opposite
        // to the corner's octant sign.
        const c = buildCornerHandle(engine, utilityScene, material, scaleBoxSize, cornerArmLen, [-sx, -sy, -sz]);
        c.mesh.name = `bbox-corner${i}`;
        c.meshes[1]!.name = `bbox-corner${i}-y`;
        c.meshes[2]!.name = `bbox-corner${i}-z`;
        c.meshes[1]!.pickable = false;
        c.meshes[2]!.pickable = false;
        corners.push(c);
    }

    // ── 12 edge-midpoint handles (rotation), one per edge index ──
    const rotators: { mesh: Mesh; place: (p: Vec3, q: Quat) => void; axis: Vec3; localAxis: Vec3 }[] = [];
    // Axis perpendicular to each edge — matches BJS layout: first 4 rotate
    // around X (edges parallel to X), next 4 around Y, last 4 around Z.
    const rotationAxes: Vec3[] = [
        // 4 edges parallel to X → rotate around X
        { x: 1, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        // 4 edges parallel to Y → rotate around Y
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 1, z: 0 },
        // 4 edges parallel to Z → rotate around Z
        { x: 0, y: 0, z: 1 },
        { x: 0, y: 0, z: 1 },
        { x: 0, y: 0, z: 1 },
        { x: 0, y: 0, z: 1 },
    ];
    for (let i = 0; i < 12; i++) {
        const h = buildEdgeAnchor(engine, utilityScene, material, rotationAxes[i]!, rotationAnchorLength, rotationAnchorThickness);
        h.mesh.name = `bbox-rot${i}`;
        // `axis` is the CURRENT world rotation axis (updated each layout to
        // Q·localAxis); `localAxis` is the un-rotated box axis.
        rotators.push({ mesh: h.mesh, place: h.place, axis: { x: rotationAxes[i]!.x, y: rotationAxes[i]!.y, z: rotationAxes[i]!.z }, localAxis: rotationAxes[i]! });
    }

    // ── 6 face-centre handles (single-axis scale) ──
    // Each sits at the centre of a box face; dragging it scales the attached
    // node along that face's normal ONLY (non-uniform), anchored at the
    // opposite face.  Mirrors BJS BoundingBoxGizmo's `zeroAxisCount === 2`
    // scale boxes.  Order: +X, -X, +Y, -Y, +Z, -Z so each pairs with `i ^ 1`.
    const faceDefs: { axis: Vec3; comp: "x" | "y" | "z" }[] = [
        { axis: { x: 1, y: 0, z: 0 }, comp: "x" },
        { axis: { x: -1, y: 0, z: 0 }, comp: "x" },
        { axis: { x: 0, y: 1, z: 0 }, comp: "y" },
        { axis: { x: 0, y: -1, z: 0 }, comp: "y" },
        { axis: { x: 0, y: 0, z: 1 }, comp: "z" },
        { axis: { x: 0, y: 0, z: -1 }, comp: "z" },
    ];
    const faces: { mesh: Mesh; place: (p: Vec3, q: Quat) => void; axis: Vec3; comp: "x" | "y" | "z" }[] = [];
    for (let i = 0; i < 6; i++) {
        const h = buildHandle(engine, utilityScene, material, faceBoxSize);
        h.mesh.name = `bbox-face${i}`;
        faces.push({ mesh: h.mesh, place: h.place, axis: faceDefs[i]!.axis, comp: faceDefs[i]!.comp });
    }

    // ── Invisible body box (translate handle) ──
    // A fully transparent large box covering the box volume — picks anywhere
    // inside the bounding box to start a camera-plane translate drag.  alpha=0
    // makes it render nothing in the colour pass, while the GPU picker (a
    // separate ID pass that ignores alpha/visibility, only honouring
    // `pickable`) still hits it.
    const bodyMaterial = createStandardMaterial();
    bodyMaterial.diffuseColor = color;
    bodyMaterial.alpha = 0;
    bodyMaterial.disableLighting = true;
    const body = createBox(engine, 1);
    body.name = "bbox-body";
    body.material = bodyMaterial;
    addToScene(utilityScene, body);

    const gizmo: BoundingBoxGizmo = {
        root,
        attachedNode: null,
        onChanged,
        material,
        _meshes: [root, ...edges.map((e) => e.mesh), ...corners.flatMap((c) => c.meshes), ...rotators.map((r) => r.mesh), ...faces.map((f) => f.mesh), body],
        _disposers: [],
        _refresh: () => undefined,
        _initialBoundingDiag: 1,
    };

    // ── Layout helper: position all edges + handles for the current OBB ──
    // `b` is the bounding box in the node's ROTATION-REMOVED frame (axis-aligned
    // there); `q` is the node's world rotation.  Each handle's frame position is
    // rotated by `q` into world space, and handle meshes are oriented by `q`, so
    // the whole cage follows the attached node's rotation (an OBB, not an AABB).
    let worldCenter: Vec3 = { x: 0, y: 0, z: 0 };
    const layout = (b: AabbBounds, q: Quat): void => {
        const toWorld = (fp: Vec3): Vec3 => rotatePoint(q, fp);
        worldCenter = toWorld(b.centre);
        const xs = [b.min.x, b.max.x];
        const ys = [b.min.y, b.max.y];
        const zs = [b.min.z, b.max.z];
        // 12 edges of the box.  Order: 4 X-parallel, 4 Y-parallel, 4 Z-parallel
        // — matches the rotators' axis assignment.
        let ei = 0;
        let ri = 0;
        for (const y of ys) {
            for (const z of zs) {
                edges[ei]!.place(toWorld({ x: xs[0]!, y, z }), toWorld({ x: xs[1]!, y, z }));
                rotators[ri]!.place(toWorld({ x: (xs[0]! + xs[1]!) * 0.5, y, z }), q);
                ei++;
                ri++;
            }
        }
        for (const x of xs) {
            for (const z of zs) {
                edges[ei]!.place(toWorld({ x, y: ys[0]!, z }), toWorld({ x, y: ys[1]!, z }));
                rotators[ri]!.place(toWorld({ x, y: (ys[0]! + ys[1]!) * 0.5, z }), q);
                ei++;
                ri++;
            }
        }
        for (const x of xs) {
            for (const y of ys) {
                edges[ei]!.place(toWorld({ x, y, z: zs[0]! }), toWorld({ x, y, z: zs[1]! }));
                rotators[ri]!.place(toWorld({ x, y, z: (zs[0]! + zs[1]!) * 0.5 }), q);
                ei++;
                ri++;
            }
        }
        // Update each rotator's CURRENT world rotation axis (Q·localAxis) so the
        // rotation drag rotates around the box's own axis even when rotated.
        for (const r of rotators) {
            const wa = rotatePoint(q, r.localAxis);
            r.axis.x = wa.x;
            r.axis.y = wa.y;
            r.axis.z = wa.z;
        }
        // 8 corners
        let ci = 0;
        for (const x of xs) {
            for (const y of ys) {
                for (const z of zs) {
                    corners[ci]!.place(toWorld({ x, y, z }), q);
                    ci++;
                }
            }
        }
        // 6 face centres — placed at the middle of each box face.
        const cx = b.centre.x,
            cy = b.centre.y,
            cz = b.centre.z;
        faces[0]!.place(toWorld({ x: b.max.x, y: cy, z: cz }), q);
        faces[1]!.place(toWorld({ x: b.min.x, y: cy, z: cz }), q);
        faces[2]!.place(toWorld({ x: cx, y: b.max.y, z: cz }), q);
        faces[3]!.place(toWorld({ x: cx, y: b.min.y, z: cz }), q);
        faces[4]!.place(toWorld({ x: cx, y: cy, z: b.max.z }), q);
        faces[5]!.place(toWorld({ x: cx, y: cy, z: b.min.z }), q);
        // Body box — fills the box (rotated by `q`) but inset by the face-box
        // size so the surface handles (especially the face-centre scale boxes,
        // which sit flush on each face) poke out in front of it and stay
        // pickable by the GPU picker.
        const inset = faceBoxSize;
        body.position.set(worldCenter.x, worldCenter.y, worldCenter.z);
        body.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
        body.scaling.set(Math.max(0.001, b.size.x - inset), Math.max(0.001, b.size.y - inset), Math.max(0.001, b.size.z - inset));
    };

    // ── Refresh: recompute the rotation-removed bounds + rotation, re-layout ──
    const refresh = (): void => {
        const node = gizmo.attachedNode;
        if (!node) {
            (gizmo as unknown as { _aabb: AabbBounds })._aabb = INFINITE_AABB;
            layout(INFINITE_AABB, IDENTITY_QUAT);
            return;
        }
        // Node world rotation (scale removed) and its inverse rotation matrix.
        const q = rotationQuatFromMatrix(node.worldMatrix);
        const rInv = mat4FromQuat(-q[0], -q[1], -q[2], q[3]);
        // Bounds in the rotation-removed frame so the cage is a tight OBB.
        // Fall back to walking the main scene's meshes so descendants attached
        // via the `.parent` setter alone (not pushed into `.children`) are
        // still discovered.
        const bounds = computeBoundsRecursive(node, layer.mainScene.meshes, rInv);
        (gizmo as unknown as { _aabb: AabbBounds })._aabb = bounds;
        layout(bounds, q);
    };
    gizmo._refresh = refresh;

    // Per-frame refresh — handles cases where the attached node moves outside
    // of a gizmo-driven drag (animation, external code).  Cheap when nothing
    // has moved because computeAabb just walks the descendants.
    onBeforeRender(utilityScene, refresh);

    // ── Drag wiring: each corner → scale; each edge midpoint → rotate;
    //    body box → translate. ──

    // Translate drag (body box).  Drag plane: a camera-facing (screen-parallel)
    // plane, matching BJS's default PointerDragBehavior for the body.  The body
    // is fully transparent and does NOT get a hover indicator — only the
    // rendered handles (edges, corner arms, rotation anchors) tint on hover.
    const translateDrag = createPointerDrag({
        dragPlaneNormal: { x: 0, y: 0, z: 1 },
        moveAttached: false,
        // Anchor the camera-facing drag plane at the bounding-box CENTRE (the
        // body box is kept positioned there each refresh) rather than the picked
        // body-surface point.  BJS's body drag plane sits at the box centroid, so
        // matching that depth makes the screen→world translation scale agree with
        // the reference (pressing the near, camera-facing face of the inset body
        // would otherwise anchor the plane ~one box-half closer to the camera and
        // the group would translate short).
        getPlanePoint: () => ({ x: body.position.x, y: body.position.y, z: body.position.z }),
    });
    translateDrag._colliders = [body];
    // Keep the drag plane normal aligned with the camera's forward axis every
    // frame.  This MUST run per-frame (not in onDragStart): the pointer-drag
    // dispatcher captures the plane normal at pointer-DOWN, which fires before
    // onDragStart, so a drag-start-only update would be applied too late and the
    // body would drag in a stale world-aligned plane instead of relative to the
    // camera.
    onBeforeRender(utilityScene, () => {
        const cam = utilityScene.camera;
        if (!cam) {
            return;
        }
        const cw = cam.worldMatrix;
        const n = translateDrag.options.dragPlaneNormal;
        if (n) {
            n.x = cw[8]!;
            n.y = cw[9]!;
            n.z = cw[10]!;
        }
    });
    translateDrag.onDrag.add((event) => {
        const node = gizmo.attachedNode;
        if (!node) {
            return;
        }
        const local = worldDeltaToLocal(node, event.delta.x, event.delta.y, event.delta.z);
        node.position.set(node.position.x + local.x, node.position.y + local.y, node.position.z + local.z);
        onChanged.notify();
    });
    if ("setAttribute" in canvas) {
        gizmo._disposers.push(registerPointerDrag(layer, canvas, translateDrag));
    }

    // Optional hover for edges (just visual feedback that you're near the
    // wireframe — no drag handler is attached to edges).
    for (const e of edges) {
        const edgeDrag = createPointerDrag({ dragAxis: { x: 0, y: 1, z: 0 }, moveAttached: false });
        edgeDrag._colliders = [e.mesh];
        // Disabled drag — edges only support hover feedback.  The drag
        // dispatcher still fires hover callbacks for disabled drags as long
        // as the pick succeeds; we keep the registered entry so the picker
        // associates the edge mesh with this drag.
        edgeDrag.onHoverStart.add(() => {
            e.mesh.material = hoverMaterial;
        });
        edgeDrag.onHoverEnd.add(() => {
            e.mesh.material = material;
        });
        // No onDragStart/Drag/End handlers — clicking an edge does nothing.
        if ("setAttribute" in canvas) {
            gizmo._disposers.push(registerPointerDrag(layer, canvas, edgeDrag));
        }
    }

    // Corner drags — uniform scale about the OPPOSITE corner as pivot.
    // Each corner pairs with the diagonally-opposite corner (XOR 0b111).
    for (let i = 0; i < 8; i++) {
        const corner = corners[i]!;
        const oppositeCorner = corners[i ^ 0b111]!;
        const drag = createPointerDrag({
            dragAxis: { x: 1, y: 0, z: 0 },
            moveAttached: false,
            // BJS-faithful drag-plane anchor at the bbox centre (BJS
            // `_updateDragPlanePosition` overrides plane.position with
            // `attachedNode.getAbsolutePosition()` per move).  Without this,
            // Lite anchored the plane at the picked corner — a deeper picked
            // plane inflated the per-tick world delta vs. BJS, causing the
            // corner-scale drag to over-shoot by ~14% for the same screen drag.
            getPlanePoint: () => ({ x: worldCenter.x, y: worldCenter.y, z: worldCenter.z }),
        });
        drag._colliders = [corner.mesh];
        let scaleAxis: Vec3 = { x: 1, y: 0, z: 0 };
        let dragSizeRef = 1;
        let pivotWorld: Vec3 = { x: 0, y: 0, z: 0 };
        const swapCorner = (mat: StandardMaterialProps): void => {
            for (const m of corner.meshes) {
                m.material = mat;
            }
        };
        drag.onHoverStart.add(() => {
            swapCorner(hoverMaterial);
        });
        drag.onHoverEnd.add(() => {
            if (!drag.dragging) {
                swapCorner(material);
            }
        });
        drag.onDragStart.add(() => {
            swapCorner(hoverMaterial);
            // Capture diagonal axis + pivot at drag start so subsequent drag
            // deltas project onto a stable direction even as the bbox grows.
            const cx = corner.mesh.position.x - oppositeCorner.mesh.position.x;
            const cy = corner.mesh.position.y - oppositeCorner.mesh.position.y;
            const cz = corner.mesh.position.z - oppositeCorner.mesh.position.z;
            const len = Math.hypot(cx, cy, cz) || 1;
            scaleAxis = { x: cx / len, y: cy / len, z: cz / len };
            dragSizeRef = len;
            pivotWorld = { x: oppositeCorner.mesh.position.x, y: oppositeCorner.mesh.position.y, z: oppositeCorner.mesh.position.z };
            const opt = drag.options.dragAxis;
            if (opt) {
                opt.x = scaleAxis.x;
                opt.y = scaleAxis.y;
                opt.z = scaleAxis.z;
            }
        });
        drag.onDragEnd.add(() => {
            swapCorner(material);
        });
        drag.onDrag.add((event) => {
            const node = gizmo.attachedNode;
            if (!node) {
                return;
            }
            const signed = event.delta.x * scaleAxis.x + event.delta.y * scaleAxis.y + event.delta.z * scaleAxis.z;
            // BJS-faithful corner scale (BoundingBoxGizmo._createScaleBox):
            //
            //   relativeDragDistance = (event.dragDistance / _boundingDimensions.length())
            //                        * _anchorMesh.scaling.length()
            //   newScale = startScale + totalRelativeDragDistance  (additive per-axis)
            //
            // For uniform scaling (sx == sy == sz == s) this integrates to
            // `s = s₀ * exp(scaleLen · D / boundingLen)` where scaleLen = √3·s
            // (always, since the scaling stays uniform).  Lite applies the same
            // factor multiplicatively per tick: `f = 1 + (signed · √3) / diag`
            // → product over ticks → `s * exp(√3·D/diag)`.  Matches BJS.
            //
            // The previous Lite formula used `1 + 2·signed/dragSizeRef` (where
            // dragSizeRef was the WORLD bbox diag at drag start) which made
            // Lite ~2.6× more sensitive than BJS for the same screen drag.
            const denom = gizmo._initialBoundingDiag > 1e-7 ? gizmo._initialBoundingDiag : dragSizeRef;
            const f = 1 + (signed * Math.sqrt(3)) / denom;
            // Translate the pivot into node-relative coordinates, scale, then
            // translate node so the diagonally-opposite corner stays anchored.
            const wm = node.worldMatrix;
            const nodeWx = wm[12]!,
                nodeWy = wm[13]!,
                nodeWz = wm[14]!;
            const rx = pivotWorld.x - nodeWx;
            const ry = pivotWorld.y - nodeWy;
            const rz = pivotWorld.z - nodeWz;
            applyUniformScale(node, f);
            const dx = (1 - f) * rx;
            const dy = (1 - f) * ry;
            const dz = (1 - f) * rz;
            const local = worldDeltaToLocal(node, dx, dy, dz);
            node.position.set(node.position.x + local.x, node.position.y + local.y, node.position.z + local.z);
            onChanged.notify();
        });
        if ("setAttribute" in canvas) {
            gizmo._disposers.push(registerPointerDrag(layer, canvas, drag));
        }
    }

    // Face-centre drags — scale a SINGLE local axis, anchored at the opposite
    // face.  Each face pairs with its opposite via `i ^ 1` (+/- of same axis).
    for (let i = 0; i < 6; i++) {
        const face = faces[i]!;
        const oppFace = faces[i ^ 1]!;
        const drag = createPointerDrag({
            dragAxis: { x: face.axis.x, y: face.axis.y, z: face.axis.z },
            moveAttached: false,
            // BJS-faithful drag-plane anchor — see corner-scale drag above.
            getPlanePoint: () => ({ x: worldCenter.x, y: worldCenter.y, z: worldCenter.z }),
        });
        drag._colliders = [face.mesh];
        let axisDir: Vec3 = { x: face.axis.x, y: face.axis.y, z: face.axis.z };
        let dragSizeRef = 1;
        let pivotWorld: Vec3 = { x: 0, y: 0, z: 0 };
        drag.onHoverStart.add(() => {
            face.mesh.material = hoverMaterial;
        });
        drag.onHoverEnd.add(() => {
            if (!drag.dragging) {
                face.mesh.material = material;
            }
        });
        drag.onDragStart.add(() => {
            face.mesh.material = hoverMaterial;
            // Capture the world-space face normal + opposite-face pivot at drag
            // start so deltas project onto a stable axis as the bbox grows.
            const dx = face.mesh.position.x - oppFace.mesh.position.x;
            const dy = face.mesh.position.y - oppFace.mesh.position.y;
            const dz = face.mesh.position.z - oppFace.mesh.position.z;
            const len = Math.hypot(dx, dy, dz) || 1;
            axisDir = { x: dx / len, y: dy / len, z: dz / len };
            dragSizeRef = len;
            pivotWorld = { x: oppFace.mesh.position.x, y: oppFace.mesh.position.y, z: oppFace.mesh.position.z };
            const opt = drag.options.dragAxis;
            if (opt) {
                opt.x = axisDir.x;
                opt.y = axisDir.y;
                opt.z = axisDir.z;
            }
        });
        drag.onDragEnd.add(() => {
            face.mesh.material = material;
        });
        drag.onDrag.add((event) => {
            const node = gizmo.attachedNode;
            if (!node) {
                return;
            }
            const signed = event.delta.x * axisDir.x + event.delta.y * axisDir.y + event.delta.z * axisDir.z;
            // Move the dragged face by `signed` while the opposite face (at
            // distance dragSizeRef) stays put → scale factor along the axis.
            const f = 1 + signed / dragSizeRef;
            applyAxisScale(node, face.comp, f);
            // Anchor the opposite face: shift the node so the pivot's component
            // along the drag axis is preserved after the single-axis scale.
            const wm = node.worldMatrix;
            const rA = (pivotWorld.x - wm[12]!) * axisDir.x + (pivotWorld.y - wm[13]!) * axisDir.y + (pivotWorld.z - wm[14]!) * axisDir.z;
            const shift = (1 - f) * rA;
            const local = worldDeltaToLocal(node, shift * axisDir.x, shift * axisDir.y, shift * axisDir.z);
            node.position.set(node.position.x + local.x, node.position.y + local.y, node.position.z + local.z);
            onChanged.notify();
        });
        if ("setAttribute" in canvas) {
            gizmo._disposers.push(registerPointerDrag(layer, canvas, drag));
        }
    }

    // world space.  Mirrors BJS BoundingBoxGizmo's intermediate-transform
    // approach (attach mesh to a transform at bbox centre, rotate it, detach)
    // by computing the equivalent local-frame rotation + position offset
    // directly: the node's position is rotated around bbox centre by the
    // world delta `dq`, and its local rotation is updated via
    // `worldRotationToLocal(dq) * node.rotationQuaternion`.
    for (let i = 0; i < 12; i++) {
        const r = rotators[i]!;
        // Bind the drag plane normal to the live `r.axis` object so it always
        // reflects the rotator's CURRENT world axis (layout updates r.axis to
        // Q·localAxis each frame).  The dispatcher reads this at pointer-down,
        // so the drag plane stays correct even when the box is rotated.
        const drag = createPointerDrag({
            dragPlaneNormal: r.axis,
            moveAttached: false,
            // BJS-faithful drag-plane anchor — see corner-scale drag above.
            getPlanePoint: () => ({ x: worldCenter.x, y: worldCenter.y, z: worldCenter.z }),
        });
        drag._colliders = [r.mesh];
        let lastPoint: Vec3 | null = null;
        drag.onHoverStart.add(() => {
            r.mesh.material = hoverMaterial;
        });
        drag.onHoverEnd.add(() => {
            if (!drag.dragging) {
                r.mesh.material = material;
            }
        });
        drag.onDragStart.add((event) => {
            r.mesh.material = hoverMaterial;
            lastPoint = { x: event.dragPlanePoint.x, y: event.dragPlanePoint.y, z: event.dragPlanePoint.z };
        });
        drag.onDragEnd.add(() => {
            r.mesh.material = material;
            lastPoint = null;
        });
        drag.onDrag.add((event) => {
            const node = gizmo.attachedNode;
            if (!node || !lastPoint) {
                return;
            }
            // BJS-faithful rotation-amount heuristic
            // (BoundingBoxGizmo._createRotationAnchor):
            //
            //   projectDist = sign * |event.delta|
            //   projectDist = (projectDist / _boundingDimensions.length())
            //               * _anchorMesh.scaling.length()
            //   angle (radians) = projectDist
            //
            // The denominator is the LOCAL (unscaled) bbox diag captured at
            // attach (`_initialBoundingDiag`); the multiplier is the attached
            // node's current scaling length, so larger meshes rotate more for
            // the same screen drag.  Sign comes from the geometric direction
            // around the axis (we use `signedAngleAroundNormal` for that
            // since it's already plumbed in).
            const c = worldCenter;
            const a: Vec3 = { x: lastPoint.x - c.x, y: lastPoint.y - c.y, z: lastPoint.z - c.z };
            const b: Vec3 = { x: event.dragPlanePoint.x - c.x, y: event.dragPlanePoint.y - c.y, z: event.dragPlanePoint.z - c.z };
            const signedGeoAngle = signedAngleAroundNormal(a, b, r.axis);
            const dxw0 = event.dragPlanePoint.x - lastPoint.x;
            const dyw0 = event.dragPlanePoint.y - lastPoint.y;
            const dzw0 = event.dragPlanePoint.z - lastPoint.z;
            const deltaLen = Math.hypot(dxw0, dyw0, dzw0);
            if (deltaLen < 1e-7 || Math.abs(signedGeoAngle) < 1e-7) {
                lastPoint = { x: event.dragPlanePoint.x, y: event.dragPlanePoint.y, z: event.dragPlanePoint.z };
                return;
            }
            const denom = gizmo._initialBoundingDiag > 1e-7 ? gizmo._initialBoundingDiag : 1;
            const nodeScaleLen = Math.hypot(node.scaling.x, node.scaling.y, node.scaling.z);
            const sign = signedGeoAngle < 0 ? -1 : 1;
            const angle = (sign * deltaLen * nodeScaleLen) / denom;
            // 1. World-space rotation `dq` around the bbox centre `c`.
            const dq = quatFromAxisAngle(r.axis.x, r.axis.y, r.axis.z, angle);
            // 2. Rotate node's world position around `c`.  This is the
            //    intermediate-transform trick distilled: the equivalent of
            //    parenting the node to a transform at `c`, rotating that
            //    transform, then detaching — the net effect on the node is
            //    a position rotation around `c` plus the rotation itself.
            const wm = node.worldMatrix;
            const nodeWx = wm[12]!,
                nodeWy = wm[13]!,
                nodeWz = wm[14]!;
            const vx = nodeWx - c.x;
            const vy = nodeWy - c.y;
            const vz = nodeWz - c.z;
            // Rotate v by dq: v' = q * (0,v) * q^-1.  Standard quat-rotate.
            const [qx, qy, qz, qw] = dq;
            const tx = 2 * (qy * vz - qz * vy);
            const ty = 2 * (qz * vx - qx * vz);
            const tz = 2 * (qx * vy - qy * vx);
            const newVx = vx + qw * tx + (qy * tz - qz * ty);
            const newVy = vy + qw * ty + (qz * tx - qx * tz);
            const newVz = vz + qw * tz + (qx * ty - qy * tx);
            // Position shift in world space.
            const dxw = newVx - vx;
            const dyw = newVy - vy;
            const dzw = newVz - vz;
            const localDelta = worldDeltaToLocal(node, dxw, dyw, dzw);
            node.position.set(node.position.x + localDelta.x, node.position.y + localDelta.y, node.position.z + localDelta.z);
            // 3. Apply the world rotation `dq` to the node — converted into
            //    the node's local frame via the parent-conjugation trick.
            const localDq = worldRotationToLocal(node, dq[0], dq[1], dq[2], dq[3]);
            const rq = node.rotationQuaternion;
            const out = quatNormalize(quatMul(localDq[0], localDq[1], localDq[2], localDq[3], rq.x, rq.y, rq.z, rq.w));
            rq.set(out[0], out[1], out[2], out[3]);
            onChanged.notify();
            lastPoint = { x: event.dragPlanePoint.x, y: event.dragPlanePoint.y, z: event.dragPlanePoint.z };
        });
        if ("setAttribute" in canvas) {
            gizmo._disposers.push(registerPointerDrag(layer, canvas, drag));
        }
    }

    // Suppress unused-import warnings — `lookAtQuat` and `applyRotation` are
    // reserved for future variants of the gizmo.
    void lookAtQuat;
    void applyRotation;

    return gizmo;
}

export function attachBoundingBoxGizmoToNode(gizmo: BoundingBoxGizmo, node: SceneNode | null): void {
    gizmo.attachedNode = node;
    gizmo._refresh();
    // Snapshot the LOCAL (pre-scale) bounding-box diagonal length now.  Lite's
    // `_aabb` is computed in the rotation-removed frame and therefore reflects
    // the current scale; dividing by `node.scaling` gives the local size that
    // matches BJS's `_boundingDimensions`.  This is the denominator used by the
    // BJS rotation-amount heuristic.
    const aabb = (gizmo as unknown as { _aabb: AabbBounds })._aabb;
    if (node && aabb && Number.isFinite(aabb.size.x)) {
        const sx = node.scaling.x !== 0 ? aabb.size.x / Math.abs(node.scaling.x) : aabb.size.x;
        const sy = node.scaling.y !== 0 ? aabb.size.y / Math.abs(node.scaling.y) : aabb.size.y;
        const sz = node.scaling.z !== 0 ? aabb.size.z / Math.abs(node.scaling.z) : aabb.size.z;
        const diag = Math.hypot(sx, sy, sz);
        gizmo._initialBoundingDiag = diag > 1e-7 ? diag : 1;
    } else {
        gizmo._initialBoundingDiag = 1;
    }
}

export function disposeBoundingBoxGizmo(gizmo: BoundingBoxGizmo, layer: UtilityLayer): void {
    for (const d of gizmo._disposers) {
        d();
    }
    gizmo._disposers.length = 0;
    gizmo.onChanged.clear();
    for (const m of gizmo._meshes) {
        removeFromScene(layer.scene, m);
    }
    gizmo._meshes.length = 0;
}
