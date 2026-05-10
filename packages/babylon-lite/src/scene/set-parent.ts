/** Set a mesh's parent while preserving its current world-space position.
 *  Equivalent to Babylon.js TransformNode.setParent().
 *
 *  Computes the child's current world matrix, sets the parent,
 *  then adjusts the child's local position so that its world position
 *  remains unchanged.
 *
 *  Standalone function for tree-shaking — only bundled when used. */

import type { Mesh } from "../mesh/mesh.js";
import type { IWorldMatrixProvider } from "./parentable.js";
import { mat4Invert } from "../math/mat4-invert.js";
import { mat4Multiply } from "../math/mat4-multiply.js";
import type { Mat4 } from "../math/types.js";

export function setParent(child: Mesh, parent: IWorldMatrixProvider | null): void {
    // 1. Snapshot child's current world matrix
    const childWorld: Mat4 = child.worldMatrix;

    // 2. Set the parent
    child.parent = parent;

    // 3. If parent is null, the child's local = its old world transform
    if (!parent) {
        decomposeInto(childWorld, child);
        return;
    }

    // 4. Compute new local transform = inverse(parentWorld) * childWorld
    const parentWorld = parent.worldMatrix;
    const invParent = mat4Invert(parentWorld);
    if (!invParent) {
        // Singular parent matrix — just set position from world
        child.position.set(childWorld[12]!, childWorld[13]!, childWorld[14]!);
        return;
    }

    const newLocal = mat4Multiply(invParent, childWorld);

    // 5. Decompose newLocal into position/rotation/scaling and apply
    decomposeInto(newLocal, child);
}

/** Extract position, rotation (Euler XYZ), and scale from a 4×4 matrix
 *  and write them into a mesh's observable properties. */
function decomposeInto(m: Mat4, mesh: Mesh): void {
    // Position = translation column
    mesh.position.set(m[12]!, m[13]!, m[14]!);

    // Column scale lengths
    const sx = Math.sqrt(m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!);
    const sy = Math.sqrt(m[4]! * m[4]! + m[5]! * m[5]! + m[6]! * m[6]!);
    const sz = Math.sqrt(m[8]! * m[8]! + m[9]! * m[9]! + m[10]! * m[10]!);

    if (sx > 1e-6 && sy > 1e-6 && sz > 1e-6) {
        // Normalized rotation matrix columns
        const r00 = m[0]! / sx,
            r01 = m[4]! / sy,
            r02 = m[8]! / sz;
        const r10 = m[1]! / sx,
            r11 = m[5]! / sy,
            r12 = m[9]! / sz;
        const r22 = m[10]! / sz;

        // Euler XYZ (matching BJS decompose convention)
        const ry = Math.asin(Math.max(-1, Math.min(1, r02)));
        let rx: number, rz: number;
        if (Math.abs(r02) < 0.9999) {
            rx = Math.atan2(-r12, r22);
            rz = Math.atan2(-r01, r00);
        } else {
            rx = Math.atan2(r10, r11);
            rz = 0;
        }
        mesh.rotation.set(rx, ry, rz);
        mesh.scaling.set(sx, sy, sz);
    }
}
