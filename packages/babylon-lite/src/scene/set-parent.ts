/** Set a node's parent while preserving its current world-space position.
 *  Equivalent to Babylon.js TransformNode.setParent().
 *
 *  Computes the child's current world matrix, sets the parent,
 *  then adjusts the child's local position so that its world position
 *  remains unchanged.
 *
 *  Standalone function for tree-shaking — only bundled when used. */

import type { Mesh } from "../mesh/mesh.js";
import type { SceneNode } from "./scene-node.js";
import type { IWorldMatrixProvider } from "./parentable.js";
import { mat4Invert } from "../math/mat4-invert.js";
import { mat4Multiply } from "../math/mat4-multiply.js";
import { mat4Decompose } from "../math/mat4-decompose.js";
import type { Mat4 } from "../math/types.js";

/** Scene-graph nodes (mesh, transform node, camera, light) expose a `children`
 *  array that traversal helpers walk (`setMeshVisible` cascade, `cloneTransformNode`,
 *  camera AABB). A foreign `IWorldMatrixProvider` may not, so probe structurally. */
function childrenOf(node: IWorldMatrixProvider | null): SceneNode[] | null {
    const kids = (node as { children?: unknown } | null)?.children;
    return Array.isArray(kids) ? (kids as SceneNode[]) : null;
}

/**
 * Reparents `child` while preserving its current world-space transform, mirroring
 * Babylon.js `TransformNode.setParent()`. Also keeps the scene-graph `children`
 * arrays consistent: the child is removed from its previous parent's `children`
 * and appended to the new parent's, so traversal helpers see the new hierarchy.
 *
 * The world transform is preserved exactly, mirrors included: `mat4Decompose` keeps a negative
 * determinant (as a negative Y scale), and a node created from a raw matrix
 * (`createSceneNodeFromMatrix`, used for glTF `matrix` nodes) is switched to TRS so the new local
 * transform actually takes effect.
 *
 * Preservation is impossible when `parent`'s world matrix is singular — a collapsed axis has no
 * inverse, so no local transform can reproduce the child's world. In that case the child keeps the
 * parent link and its world *position* is copied into its local position, but its rotation and
 * scale are not compensated.
 *
 * `child.parent` links are only established by `addToScene`, so when reparenting a node from inside
 * a freshly loaded asset, add the container first — otherwise the child's "world" matrix is just
 * its local one and the reparent is computed against the wrong space.
 * @param child - The node to reparent (mesh, transform node, or any scene node).
 * @param parent - The new parent (any world-matrix provider), or `null` to detach to world space.
 */
export function setParent(child: Mesh, parent: IWorldMatrixProvider | null): void;
export function setParent(child: SceneNode, parent: IWorldMatrixProvider | null): void;
export function setParent(child: SceneNode, parent: IWorldMatrixProvider | null): void {
    // 1. Snapshot child's current world matrix
    const childWorld: Mat4 = child.worldMatrix;

    // 2. Set the parent and keep the `children` arrays in sync (only when the
    //    link actually changes, so we never duplicate or drop entries).
    if (child.parent !== parent) {
        const oldChildren = childrenOf(child.parent);
        if (oldChildren) {
            const i = oldChildren.indexOf(child);
            if (i >= 0) {
                oldChildren.splice(i, 1);
            }
        }
        child.parent = parent;
        const newChildren = childrenOf(parent);
        if (newChildren && newChildren.indexOf(child) < 0) {
            newChildren.push(child);
        }
    }

    // 3. If parent is null, the child's local = its old world transform
    if (!parent) {
        applyLocal(childWorld, child);
        return;
    }

    // 4. Compute new local transform = inverse(parentWorld) * childWorld
    const parentWorld = parent.worldMatrix;
    const invParent = mat4Invert(parentWorld);
    if (!invParent) {
        // Singular parent matrix: no local transform can reproduce the child's world, so this is a
        // best-effort fallback (documented above) rather than true preservation — copy the world
        // position and leave rotation/scale uncompensated. A matrix-backed node ignores TRS writes,
        // so seed its TRS from the matrix first or the position write is silently dropped.
        if (child._localMatrix) {
            applyLocal(child._localMatrix, child);
        }
        child.position.set(childWorld[12]!, childWorld[13]!, childWorld[14]!);
        return;
    }

    // 5. Decompose newLocal into position/rotation/scaling and apply
    applyLocal(mat4Multiply(invParent, childWorld), child);
}

/** Decompose a local matrix and write it into a node's observable TRS. Writes the
 *  rotation as a quaternion directly (the source of truth) — avoids the lossy
 *  Euler round-trip near gimbal lock. */
function applyLocal(m: Mat4, node: SceneNode): void {
    const { translation, rotation, scale } = mat4Decompose(m);
    // A glTF `matrix` node reports `_localMatrix` as its local transform and ignores TRS, so the
    // writes below would be dropped. Hand control back to the TRS triple before writing — the
    // decomposition we just computed is exactly the matrix it replaces (glTF requires `matrix` to
    // be TRS-decomposable), so the node's transform is unchanged apart from the reparent itself.
    node._localMatrix = undefined;
    node.position.set(translation.x, translation.y, translation.z);
    node.rotationQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    node.scaling.set(scale.x, scale.y, scale.z);
}
