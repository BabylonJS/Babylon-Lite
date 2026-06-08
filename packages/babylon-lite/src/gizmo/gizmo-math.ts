/** Gizmo math helpers — ray/plane intersection, quaternion utilities, look-at quat.
 *  Pure functions, no allocations of typed arrays (use plain objects/tuples).
 *  Vector helpers (cross, dot, length, normalize) are reused from `../math/*`
 *  rather than re-inlined.  Bundle-neutral — module-init overhead of the four
 *  separate lite math files is offset by the smaller body here. */

import type { Vec3, Mat4 } from "../math/types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { crossVec3 } from "../math/cross-vec3.js";
import { dotVec3 } from "../math/dot-vec3.js";
import { lengthVec3 } from "../math/length-vec3.js";
import { normalizeVec3 } from "../math/normalize-vec3-object.js";
import { mat4Invert } from "../math/mat4-invert.js";

/** Re-exported under the gizmo namespace so call sites that already import a
 *  gizmo helper don't have to add a second import for the shared lite math. */
export { crossVec3, dotVec3, lengthVec3, normalizeVec3 };
/** @deprecated Use {@link normalizeVec3} from `math/normalize-vec3-object.js`.
 *  Kept as an alias so existing gizmo modules don't churn on the rename. */
export const normalizeVec3Obj = normalizeVec3;

/** Ray-plane intersection. Returns hit point or null if ray is parallel or behind origin.
 *  Plane is defined by a point on the plane and its normal. */
export function rayPlaneIntersect(rayOrigin: Vec3, rayDir: Vec3, planePoint: Vec3, planeNormal: Vec3): Vec3 | null {
    const denom = dotVec3(rayDir, planeNormal);
    if (Math.abs(denom) < 1e-6) {
        return null;
    }
    const ox = planePoint.x - rayOrigin.x;
    const oy = planePoint.y - rayOrigin.y;
    const oz = planePoint.z - rayOrigin.z;
    const t = (ox * planeNormal.x + oy * planeNormal.y + oz * planeNormal.z) / denom;
    if (t < 0) {
        return null;
    }
    return {
        x: rayOrigin.x + rayDir.x * t,
        y: rayOrigin.y + rayDir.y * t,
        z: rayOrigin.z + rayDir.z * t,
    };
}

/** Quaternion multiplication (Hamilton product). Returns a new quat. */
export function quatMul(ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number): [number, number, number, number] {
    return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** Quaternion normalize. Returns a new quat. */
export function quatNormalize(q: [number, number, number, number]): [number, number, number, number] {
    const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/** Quaternion from axis (unit) + angle (radians). */
export function quatFromAxisAngle(ax: number, ay: number, az: number, angle: number): [number, number, number, number] {
    // Normalize the axis so a non-unit axis still yields a valid unit rotation
    // quaternion — matches BJS `Quaternion.RotationAxis`, which calls
    // `axis.normalize()` first.  Callers such as `lookAtQuat` pass a cross
    // product whose length is `sin(angle)` (not 1), so skipping this produces a
    // quaternion that encodes the wrong rotation angle.
    const len = Math.sqrt(ax * ax + ay * ay + az * az);
    if (len < 1e-8) {
        return [0, 0, 0, 1];
    }
    const inv = 1 / len;
    const half = angle * 0.5;
    const s = Math.sin(half);
    return [ax * inv * s, ay * inv * s, az * inv * s, Math.cos(half)];
}

/** Babylon.js `Quaternion.RotationYawPitchRoll(yaw=ry, pitch=rx, roll=rz)` —
 *  the Euler→quaternion convention `Node.rotation` uses (rotation order
 *  Ry(yaw)·Rx(pitch)·Rz(roll)).  Needed when porting BJS gizmo meshes that set
 *  `node.rotation.{x,y,z}` directly. */
export function quatFromBjsEuler(rx: number, ry: number, rz: number): [number, number, number, number] {
    const hr = rz * 0.5,
        hp = rx * 0.5,
        hy = ry * 0.5;
    const sr = Math.sin(hr),
        cr = Math.cos(hr);
    const sp = Math.sin(hp),
        cp = Math.cos(hp);
    const sy = Math.sin(hy),
        cy = Math.cos(hy);
    return [cy * sp * cr + sy * cp * sr, sy * cp * cr - cy * sp * sr, cy * cp * sr - sy * sp * cr, cy * cp * cr + sy * sp * sr];
}

/** Rotate vector (vx,vy,vz) by unit quaternion (qx,qy,qz,qw). */
export function rotateVec3ByQuat(qx: number, qy: number, qz: number, qw: number, vx: number, vy: number, vz: number): [number, number, number] {
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

/** Babylon `TransformNode.setDirection(localAxis)` → quaternion.  Orients a
 *  node so its local +Z axis points along `dir`, using yaw + pitch only (NO
 *  roll about the direction axis).  This differs from {@link lookAtQuat} (a
 *  shortest-arc rotation) by the roll component — gizmo meshes whose geometry
 *  is not roll-symmetric (e.g. the directional-light arrows) require this exact
 *  convention to align with the BJS reference. */
export function directionToQuat(dir: Vec3): [number, number, number, number] {
    const yaw = -Math.atan2(dir.z, dir.x) + Math.PI / 2;
    const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
    const pitch = -Math.atan2(dir.y, len);
    return quatFromBjsEuler(pitch, yaw, 0);
}

/** Build a quaternion that rotates [0,0,1] (BJS forward axis +Z LH) onto the given
 *  direction. Matches BJS `Mesh.lookAt(target)` used by gizmos to orient the arrow
 *  along its drag axis. */
export function lookAtQuat(dir: Vec3): [number, number, number, number] {
    const len = lengthVec3(dir);
    if (len < 1e-8) {
        return [0, 0, 0, 1];
    }
    const fx = dir.x / len,
        fy = dir.y / len,
        fz = dir.z / len;
    const dot = fz; // dot([0,0,1], f)
    if (dot > 0.9999999) {
        return [0, 0, 0, 1];
    }
    if (dot < -0.9999999) {
        return [1, 0, 0, 0];
    }
    // axis = cross([0,0,1], f) = (-fy, fx, 0)
    const angle = Math.acos(dot);
    return quatNormalize(quatFromAxisAngle(-fy, fx, 0, angle));
}

/** Signed angle (radians) between two vectors `a` and `b` measured around `normal`
 *  (right-hand rule). Both vectors should be perpendicular to `normal`. */
export function signedAngleAroundNormal(a: Vec3, b: Vec3, normal: Vec3): number {
    const c = crossVec3(a, b);
    return Math.atan2(dotVec3(c, normal), dotVec3(a, b));
}

/** Transform a direction vector by a 4×4 world matrix's upper 3×3 (rotation +
 *  scale), then renormalize.  Used by gizmos in local-coord mode to recompute
 *  their world drag axis from the attached node's world rotation each frame.
 *
 *  Lite stores world matrices in column-major with elements arranged so that
 *  the COLUMNS represent world-space directions of each LOCAL axis (i.e. the
 *  matrix's column 0 is the world direction of the node's local +X).  To map
 *  a local direction `dir` onto its world equivalent we form the linear
 *  combination of the columns weighted by `dir`'s components — equivalent to
 *  `M * v` where M is read row-by-row but each "row" here picks one element
 *  from each column. */
export function transformDirectionByWorld(wm: Mat4, dir: Vec3): Vec3 {
    // Each "column" of the matrix (wm[0..2], wm[4..6], wm[8..10]) is the
    // world-space direction of the corresponding LOCAL axis (+X, +Y, +Z).
    const x = wm[0]! * dir.x + wm[4]! * dir.y + wm[8]! * dir.z;
    const y = wm[1]! * dir.x + wm[5]! * dir.y + wm[9]! * dir.z;
    const z = wm[2]! * dir.x + wm[6]! * dir.y + wm[10]! * dir.z;
    return normalizeVec3({ x, y, z });
}

/** Convert a world-space direction (e.g. drag delta) into the LOCAL frame of
 *  `node` so it can be added to `node.position`.  If the node has no parent,
 *  world and local coincide.  Otherwise the inverse of the parent's world
 *  matrix's upper-3×3 (rotation + scale) is applied — translation excluded
 *  because deltas are vectors, not points. */
export function worldDeltaToLocal(node: SceneNode, dx: number, dy: number, dz: number): Vec3 {
    const parent = (node as unknown as { parent?: { worldMatrix?: Readonly<Float32Array> } | null }).parent;
    if (!parent || !parent.worldMatrix) {
        return { x: dx, y: dy, z: dz };
    }
    const inv = mat4Invert(parent.worldMatrix as unknown as Mat4);
    if (!inv) {
        return { x: dx, y: dy, z: dz };
    }
    return {
        x: inv[0]! * dx + inv[4]! * dy + inv[8]! * dz,
        y: inv[1]! * dx + inv[5]! * dy + inv[9]! * dz,
        z: inv[2]! * dx + inv[6]! * dy + inv[10]! * dz,
    };
}

/** Extract a unit rotation quaternion from a 4×4 world matrix.  Removes scale
 *  by normalising each upper-3×3 column independently before applying the
 *  Shoemake quaternion-from-matrix conversion. */
export function rotationQuatFromMatrix(m: Mat4): [number, number, number, number] {
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

/** Convert a world-space rotation quaternion `dq` (e.g. rotation produced by a
 *  rotation-gizmo drag step) into the equivalent LOCAL rotation quaternion to
 *  left-multiply into `node.rotationQuaternion`.  If the node has no parent
 *  the world rotation IS the local rotation.  Otherwise we conjugate by the
 *  parent's world rotation:  `localDq = inv(parentQ) * dq * parentQ`. */
export function worldRotationToLocal(node: SceneNode, dqx: number, dqy: number, dqz: number, dqw: number): [number, number, number, number] {
    const parent = (node as unknown as { parent?: { worldMatrix?: Mat4 } | null }).parent;
    if (!parent || !parent.worldMatrix) {
        return [dqx, dqy, dqz, dqw];
    }
    const pq = rotationQuatFromMatrix(parent.worldMatrix);
    const invPq: [number, number, number, number] = [-pq[0], -pq[1], -pq[2], pq[3]];
    const tmp = quatMul(invPq[0], invPq[1], invPq[2], invPq[3], dqx, dqy, dqz, dqw);
    return quatMul(tmp[0], tmp[1], tmp[2], tmp[3], pq[0], pq[1], pq[2], pq[3]);
}
