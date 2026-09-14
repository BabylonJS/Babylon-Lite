/** Set a node's parent while preserving its current world-space position.
 *  Equivalent to Babylon.js TransformNode.setParent().
 *
 *  Computes the child's current world matrix, sets the parent,
 *  then adjusts the child's local position so that its world position
 *  remains unchanged.
 *
 *  Standalone function for tree-shaking — only bundled when used. */

import type { Mesh } from "../mesh/mesh.js";
import type { LightBase } from "../light/types.js";
import type { ObservableVec3 } from "../math/observable-vec3.js";
import type { SceneNode } from "./scene-node.js";
import type { IWorldMatrixProvider } from "./parentable.js";
import { invertMat4 } from "../math/invert-mat4.js";
import { multiplyMat4 } from "../math/multiply-mat4.js";
import { decomposeMat4 } from "../math/decompose-mat4.js";
import type { Mat4 } from "../math/types.js";

/** SceneNodes expose a `children` array that traversal helpers walk. A foreign
 *  IWorldMatrixProvider may not, so probe structurally. */
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
 * The world transform is preserved exactly, mirrors included: `decomposeMat4` keeps a negative
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
 * Lights preserve their world-space position and direction; SceneNodes preserve
 * their complete TRS transform.
 * @param child - The entity to reparent (mesh, transform node, camera, or light).
 * @param parent - The new parent (any world-matrix provider), or `null` to detach to world space.
 */
export function setParent(child: Mesh, parent: IWorldMatrixProvider | null): void;
export function setParent(child: SceneNode, parent: IWorldMatrixProvider | null): void;
export function setParent(child: LightBase, parent: IWorldMatrixProvider | null): void;
export function setParent(child: SceneNode | LightBase, parent: IWorldMatrixProvider | null): void {
    // 1. Snapshot child's current world matrix
    const childWorld: Mat4 = child.worldMatrix;

    // 2. Set the parent and keep the `children` arrays in sync (only when the
    //    link actually changes, so we never duplicate or drop entries).
    if (child.parent !== parent && !isLight(child)) {
        const oldChildren = childrenOf(child.parent);
        if (oldChildren) {
            const i = oldChildren.indexOf(child);
            if (i >= 0) {
                oldChildren.splice(i, 1);
            }
        }
        const newChildren = childrenOf(parent);
        if (newChildren && newChildren.indexOf(child) < 0) {
            newChildren.push(child);
        }
    }
    child.parent = parent;

    // 3. If parent is null, the child's local = its old world transform
    if (!parent) {
        if (isLight(child)) {
            applyLightLocal(childWorld, child);
        } else {
            applyLocal(childWorld, child);
        }
        return;
    }

    // 4. Compute new local transform = inverse(parentWorld) * childWorld
    const parentWorld = parent.worldMatrix;
    const invParent = invertMat4(parentWorld);
    if (!invParent) {
        if (isLight(child)) {
            applyLightLocal(childWorld, child);
            return;
        }
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

    // 5. Decompose newLocal into the transform fields supported by the child
    const local = multiplyMat4(invParent, childWorld);
    if (isLight(child)) {
        applyLightLocal(local, child);
    } else {
        applyLocal(local, child);
    }
}

function isLight(node: SceneNode | LightBase): node is LightBase {
    return "lightType" in node;
}

/** Lights store only the local position/direction components that affect their
 *  rendered transform. Rebuild those fields instead of assuming SceneNode TRS. */
function applyLightLocal(m: Mat4, light: LightBase): void {
    const transform = light as LightBase & { position?: ObservableVec3; direction?: ObservableVec3 };
    transform.position?.set(m[12]!, m[13]!, m[14]!);
    if (transform.direction) {
        const length = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
        transform.direction.set(m[8]! / length, m[9]! / length, m[10]! / length);
    }
}

/** Decompose a local matrix and write it into a node's observable TRS. Writes the
 *  rotation as a quaternion directly (the source of truth) — avoids the lossy
 *  Euler round-trip near gimbal lock. */
function applyLocal(m: Mat4, node: SceneNode): void {
    const { translation, rotation, scale } = decomposeMat4(m);
    // A glTF `matrix` node reports `_localMatrix` as its local transform and ignores TRS, so the
    // writes below would be dropped. Hand control back to the TRS triple before writing — the
    // decomposition we just computed is exactly the matrix it replaces (glTF requires `matrix` to
    // be TRS-decomposable), so the node's transform is unchanged apart from the reparent itself.
    node._localMatrix = undefined;
    node.position.set(translation.x, translation.y, translation.z);
    node.rotationQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    node.scaling.set(scale.x, scale.y, scale.z);
}
