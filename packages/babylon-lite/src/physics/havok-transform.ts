import type { Vec3, Quat } from "../math/types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { invertMat4 } from "../math/invert-mat4.js";
import { decomposeMat4 } from "../math/decompose-mat4.js";
import { transformCoordinatesToRef } from "../math/mat4-transform.js";
import { addVec3 } from "../math/add-vec3.js";
import { multiplyQuat } from "../math/multiply-quat.js";

export function nodeToHavokTransform(node: SceneNode): [[number, number, number], [number, number, number, number]] {
    let p: Vec3;
    let q: Quat;
    if (node.parent) {
        const wm = node.parent.worldMatrix;
        const { translation, rotation } = decomposeMat4(wm);
        p = addVec3(translation, node.position);
        q = multiplyQuat(rotation, node.rotationQuaternion);
    } else {
        p = node.position;
        q = node.rotationQuaternion;
    }
    return [
        [p.x, p.y, p.z],
        [q.x, q.y, q.z, q.w],
    ];
}

export function havokTransformToNode(transform: readonly [readonly [number, number, number], readonly [number, number, number, number]], node: SceneNode): void {
    const pos = transform[0]; // [x, y, z]
    const rot = transform[1]; // [x, y, z, w]
    if (node.parent) {
        const iwm = invertMat4(node.parent.worldMatrix);
        if (!iwm) {
            console.warn("Havok: node world matrix is singular, skipping body→node sync", node);
            return; // singular world matrix, skip sync
        }
        const { rotation } = decomposeMat4(iwm);
        transformCoordinatesToRef(pos[0], pos[1], pos[2], iwm, node.position);
        const q = multiplyQuat(rotation, { x: rot[0], y: rot[1], z: rot[2], w: rot[3] });
        node.rotationQuaternion.set(q.x, q.y, q.z, q.w);
    } else {
        node.position.set(pos[0], pos[1], pos[2]);
        node.rotationQuaternion.set(rot[0], rot[1], rot[2], rot[3]);
    }
}
