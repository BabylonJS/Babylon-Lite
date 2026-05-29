/** TransformNode — alias for SceneNode. A scene graph node with TRS, parent, and children.
 *
 *  TransformNode is now a pure type alias for SceneNode, giving all scene entities
 *  a common base. createTransformNode delegates to createSceneNode. */

import type { Mesh } from "../mesh/mesh.js";
import type { MeshInternal } from "../mesh/mesh.js";
import { initMeshTransform } from "../mesh/mesh.js";
import type { SceneNode } from "./scene-node.js";
import { createSceneNode } from "./scene-node.js";

export type { SceneNode } from "./scene-node.js";

/** TransformNode is a SceneNode — pure type alias, no extra fields. */
export type TransformNode = SceneNode;

/** Create a TransformNode (SceneNode) with TRS values and lazy world matrix.
 *  Parameters: name, position (px,py,pz), rotation quaternion (qx,qy,qz,qw), scaling (sx,sy,sz). */
export function createTransformNode(name: string, px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0, qw = 1, sx = 1, sy = 1, sz = 1): TransformNode {
    return createSceneNode(name, px, py, pz, qx, qy, qz, qw, sx, sy, sz);
}

/** Deep-clone a SceneNode tree. Meshes are shallow-cloned (shared GPU buffers).
 *  Lights, cameras, and other non-mesh/non-TN children are shallow-cloned. */
export function cloneTransformNode(src: SceneNode): SceneNode {
    const clone = createTransformNode(
        src.name + "_clone",
        src.position.x,
        src.position.y,
        src.position.z,
        src.rotationQuaternion.x,
        src.rotationQuaternion.y,
        src.rotationQuaternion.z,
        src.rotationQuaternion.w,
        src.scaling.x,
        src.scaling.y,
        src.scaling.z
    );
    for (const child of src.children) {
        if (!("_gpu" in child) && !("lightType" in child)) {
            const childClone = cloneTransformNode(child);
            childClone.parent = clone;
            clone.children.push(childClone);
        } else if ("_gpu" in child) {
            const mesh = child as unknown as Mesh;
            const mi = mesh as MeshInternal;
            const meshClone = {
                ...mesh,
                name: mesh.name + "_clone",
                _materialDirty: false,
                _gpu: { ...mi._gpu },
            } as unknown as MeshInternal;
            initMeshTransform(
                meshClone,
                mesh.position.x,
                mesh.position.y,
                mesh.position.z,
                mesh.rotation.x,
                mesh.rotation.y,
                mesh.rotation.z,
                mesh.scaling.x,
                mesh.scaling.y,
                mesh.scaling.z
            );
            meshClone.parent = clone;
            clone.children.push(meshClone);
        } else {
            // Lights, cameras, other node types — shallow clone with fresh children array
            const childClone = { ...(child as Record<string, unknown>), name: (child as SceneNode).name + "_clone", children: [] } as unknown as SceneNode;
            childClone.parent = clone;
            clone.children.push(childClone);
        }
    }
    return clone;
}
