import type { SkeletonData } from "../animation/types.js";
import { invertMat4 } from "../math/invert-mat4.js";
import { multiplyMat4IntoBuffer } from "../math/multiply-mat4-into-buffer.js";
import type { Mat4Storage } from "../math/types.js";
import { retain } from "../resource/ref-count.js";
import { createSceneNodeFromMatrix } from "../scene/scene-node.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { UsdContext } from "./usd-context.js";
import type { UsdGeometry } from "./usd-geometry.js";
import { usdMatrix, usdParent } from "./usd-nodes.js";
import { USD_NONE, UsdOp, usdField, usdFloats, usdString, usdU16, usdUints } from "./usd-protocol.js";

function remapSkin<T extends Float32Array | Uint16Array>(stream: T, geometry: UsdGeometry): T {
    if (!geometry.vertexMap) {
        return stream;
    }
    const output = stream.slice(0, geometry.vertexMap.length * 4);
    for (let vertex = 0; vertex < geometry.vertexMap.length; vertex++) {
        const source = geometry.vertexMap[vertex]!;
        for (let influence = 0; influence < 4; influence++) {
            output[vertex * 4 + influence] = stream[source * 4 + influence]!;
        }
    }
    return output as T;
}

/** @internal Build authored rest hierarchies and bind-pose-correct Lite skins. */
export async function apply(context: UsdContext): Promise<void> {
    for (const record of context.records) {
        if (record.op !== UsdOp.Skeleton) {
            continue;
        }
        const id = usdField(record, 0);
        const count = usdField(record, 3);
        if (!count || context.rigs.has(id)) {
            throw new Error(`Invalid or duplicate USD skeleton ${id}`);
        }
        const raw = usdUints(context.data, usdField(record, 4), count * 6);
        const inverseBindMatrices = new Float32Array(count * 16);
        const bindMatrices = new Float32Array(count * 16);
        const joints: SceneNode[] = [];
        for (let index = 0; index < count; index++) {
            const parent = raw[index * 6]!;
            const boneId = raw[index * 6 + 1]!;
            if ((parent !== USD_NONE && parent >= index) || context.bones.has(boneId)) {
                throw new Error(`USD skeleton ${id} has an invalid parent or duplicate bone ID`);
            }
            const rest = usdFloats(context.data, raw[index * 6 + 4]!, 16);
            const bind = usdFloats(context.data, raw[index * 6 + 5]!, 16);
            if (!rest.every(Number.isFinite) || !bind.every(Number.isFinite)) {
                throw new Error(`USD skeleton ${id} has a non-finite joint transform`);
            }
            // Gf row-major row-vector bytes are already the equivalent Lite
            // column-major column-vector sequence; see usdMatrix().
            if (parent === USD_NONE) {
                bindMatrices.set(bind, index * 16);
            } else {
                multiplyMat4IntoBuffer(bindMatrices, index * 16, bindMatrices, parent * 16, bind, 0);
            }
            const inverseBind = invertMat4(usdMatrix(bindMatrices.subarray(index * 16, index * 16 + 16)));
            if (!inverseBind) {
                throw new Error(`USD skeleton ${id} has a singular bind transform`);
            }
            inverseBindMatrices.set(inverseBind, index * 16);
            const joint = createSceneNodeFromMatrix(usdString(context.data, raw[index * 6 + 2]!, raw[index * 6 + 3]!), usdMatrix(rest));
            if (parent !== USD_NONE) {
                usdParent(joint, joints[parent]!);
            }
            joints.push(joint);
            context.bones.set(boneId, joint);
        }
        context.rigs.set(id, { joints, inverseBindMatrices, skins: [] });
    }
    if (!context.rigs.size) {
        if (context.draws.some((draw) => draw.skeletonId !== USD_NONE)) {
            throw new Error("USD mesh references a missing skeleton");
        }
        return;
    }

    const { createSkeleton } = await import("../skeleton/create-skeleton.js");
    const cache = new Map<UsdGeometry, Map<number, SkeletonData>>();
    const scratch = new Float32Array(16);
    for (const draw of context.draws) {
        if (draw.skeletonId === USD_NONE) {
            continue;
        }
        const rig = context.rigs.get(draw.skeletonId);
        const record = draw.geometry.record;
        if (!rig || !record || !(usdField(record, 3) & 16) || usdField(record, 14) > 8) {
            throw new Error("Missing or unsupported USD mesh skin");
        }
        let skins = cache.get(draw.geometry);
        if (!skins) {
            skins = new Map();
            cache.set(draw.geometry, skins);
        }
        const shared = skins.get(draw.skeletonId);
        if (shared) {
            retain(shared);
            draw.mesh.skeleton = shared;
            continue;
        }
        const streamCount = usdField(record, 1) * 4;
        const joints = remapSkin(usdU16(context.data, usdField(record, 9), streamCount), draw.geometry);
        const weights = remapSkin(usdFloats(context.data, usdField(record, 10), streamCount), draw.geometry);
        const extra = !!(usdField(record, 3) & 32);
        const joints1 = extra ? remapSkin(usdU16(context.data, usdField(record, 11), streamCount), draw.geometry) : null;
        const weights1 = extra ? remapSkin(usdFloats(context.data, usdField(record, 12), streamCount), draw.geometry) : null;
        if (
            joints.some((joint) => joint >= rig.joints.length) ||
            joints1?.some((joint) => joint >= rig.joints.length) ||
            !weights.every((weight) => Number.isFinite(weight) && weight >= 0) ||
            weights1?.some((weight) => !Number.isFinite(weight) || weight < 0)
        ) {
            throw new Error("Invalid USD skin weights or joint indices");
        }
        const boneMatrices = new Float32Array(rig.joints.length * 16);
        for (let index = 0; index < rig.joints.length; index++) {
            // The extractor bakes geomBind into vertices and places the mesh
            // under its Skeleton prim, so joints and mesh vertices share this
            // object space. A glTF-style inverse(meshWorld) would cancel the
            // authored Skeleton prim transform.
            multiplyMat4IntoBuffer(scratch, 0, rig.joints[index]!.worldMatrix as unknown as Mat4Storage, 0, rig.inverseBindMatrices, index * 16);
            boneMatrices.set(scratch, index * 16);
        }
        const skin = createSkeleton(context.engine, joints, weights, rig.joints.length, boneMatrices, joints1, weights1);
        draw.mesh.skeleton = skin;
        rig.skins.push(skin);
        skins.set(draw.skeletonId, skin);
    }
}
