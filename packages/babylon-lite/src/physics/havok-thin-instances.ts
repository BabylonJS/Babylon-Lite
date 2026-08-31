import { mat4ComposeInto } from "../math/mat4-compose-into.js";
import { _quatFromRotationBasis } from "../math/quat-from-rotation-matrix.js";
import { flushThinInstances } from "../mesh/thin-instance.js";
import type { Mesh } from "../mesh/mesh.js";
import { PhysicsPrestepType } from "./havok.js";
import type { HavokThinInstanceContext, PhysicsBody, PhysicsBodyInstances, PhysicsMotionType, PhysicsWorld } from "./havok.js";

function thinInstanceTransform(matrices: Float32Array | Float64Array, index: number): [number[], number[]] {
    const offset = index * 16;
    const rotation = _quatFromRotationBasis(
        matrices[offset]!,
        matrices[offset + 4]!,
        matrices[offset + 8]!,
        matrices[offset + 1]!,
        matrices[offset + 5]!,
        matrices[offset + 9]!,
        matrices[offset + 2]!,
        matrices[offset + 6]!,
        matrices[offset + 10]!
    );
    return [
        [matrices[offset + 12]!, matrices[offset + 13]!, matrices[offset + 14]!],
        [rotation.x, rotation.y, rotation.z, rotation.w],
    ];
}

const instances: PhysicsBodyInstances = {
    count(body) {
        return body._hkBodies!.length;
    },
    forEach(body, cb) {
        for (let i = 0; i < body._hkBodies!.length; i++) {
            cb(body._hkBodies![i], i);
        }
    },
    find(body, nativeId) {
        for (let i = 0; i < body._hkBodies!.length; i++) {
            const handle = body._hkBodies![i];
            const handleId = handle[0];
            if (
                handleId === nativeId ||
                (typeof handleId === "bigint" && typeof nativeId === "number" && Number.isInteger(nativeId) && handleId === BigInt(nativeId)) ||
                (typeof handleId === "number" && Number.isInteger(handleId) && typeof nativeId === "bigint" && BigInt(handleId) === nativeId)
            ) {
                return { handle, index: i };
            }
        }
        return null;
    },
    syncFromHavok(hknp, body) {
        const mesh = body.node as Mesh;
        const thin = mesh.thinInstances!;
        for (let i = 0; i < body._hkBodies!.length; i++) {
            const transform = hknp.HP_Body_GetQTransform(body._hkBodies![i])[1];
            const position = transform[0];
            const rotation = transform[1];
            mat4ComposeInto(thin.matrices, i * 16, position[0], position[1], position[2], rotation[0], rotation[1], rotation[2], rotation[3], 1, 1, 1);
        }
        flushThinInstances(mesh);
    },
    syncToHavok(hknp, body) {
        const thin = (body.node as Mesh).thinInstances!;
        for (let i = 0; i < body._hkBodies!.length; i++) {
            hknp.HP_Body_SetQTransform(body._hkBodies![i], thinInstanceTransform(thin.matrices, i));
        }
    },
    setTransform(body, position, rotation) {
        const mesh = body.node as Mesh;
        const thin = mesh.thinInstances!;
        for (let i = 0; i < body._hkBodies!.length; i++) {
            mat4ComposeInto(thin.matrices, i * 16, position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w, 1, 1, 1);
        }
        flushThinInstances(mesh);
    },
};

function createBody(world: PhysicsWorld, node: Mesh, motionType: PhysicsMotionType, startsAsleep: boolean): PhysicsBody {
    if (world._fo) {
        throw new Error("Thin-instance physics bodies do not support floating-origin worlds.");
    }
    const thin = node.thinInstances;
    if (!thin?.count) {
        throw new Error("Thin-instance physics requires a non-empty matrix buffer before body creation.");
    }
    const hknp = world._hknp;
    const hkMotion = motionType === 0 ? hknp.MotionType.STATIC : motionType === 1 ? hknp.MotionType.KINEMATIC : hknp.MotionType.DYNAMIC;
    const handles = new Array<any>(thin.count);
    for (let i = 0; i < handles.length; i++) {
        const handle = hknp.HP_Body_Create()[1];
        handles[i] = handle;
        hknp.HP_Body_SetMotionType(handle, hkMotion);
        hknp.HP_World_AddBody(world._hkWorld, handle, startsAsleep);
        hknp.HP_Body_SetQTransform(handle, thinInstanceTransform(thin.matrices, i));
    }
    const body: PhysicsBody = {
        _hkBody: handles[0],
        _hkBodies: handles,
        _instances: instances,
        _shape: null,
        _preStep: false,
        _prestepType: PhysicsPrestepType.TELEPORT,
        _world: world,
        node,
        motionType,
    };
    world._bodies.push(body);
    return body;
}

/** @internal Lazily loaded thin-instance implementation installed by `enableHavokThinInstancePhysics`. */
export const havokThinInstanceContext: HavokThinInstanceContext = { createBody };
