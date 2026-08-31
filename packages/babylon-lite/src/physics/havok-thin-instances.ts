import { mat4ComposeInto } from "../math/mat4-compose-into.js";
import { flushThinInstances } from "../mesh/thin-instance.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Quat } from "../math/types.js";
import { PhysicsPrestepType } from "./havok.js";
import type { HavokThinInstanceContext, PhysicsBody, PhysicsBodyInstances, PhysicsMotionType, PhysicsWorld } from "./havok.js";

function quatFromRotationBasisToRef(m11: number, m12: number, m13: number, m21: number, m22: number, m23: number, m31: number, m32: number, m33: number, out: Quat): void {
    const trace = m11 + m22 + m33;
    let s: number;
    if (trace > 0) {
        s = 0.5 / Math.sqrt(trace + 1);
        out.x = (m32 - m23) * s;
        out.y = (m13 - m31) * s;
        out.z = (m21 - m12) * s;
        out.w = 0.25 / s;
    } else if (m11 > m22 && m11 > m33) {
        s = 2 * Math.sqrt(1 + m11 - m22 - m33);
        out.x = 0.25 * s;
        out.y = (m12 + m21) / s;
        out.z = (m13 + m31) / s;
        out.w = (m32 - m23) / s;
    } else if (m22 > m33) {
        s = 2 * Math.sqrt(1 + m22 - m11 - m33);
        out.x = (m12 + m21) / s;
        out.y = 0.25 * s;
        out.z = (m23 + m32) / s;
        out.w = (m13 - m31) / s;
    } else {
        s = 2 * Math.sqrt(1 + m33 - m11 - m22);
        out.x = (m13 + m31) / s;
        out.y = (m23 + m32) / s;
        out.z = 0.25 * s;
        out.w = (m21 - m12) / s;
    }
}

function thinInstanceTransform(matrices: Float32Array | Float64Array, index: number, transform: [number[], number[]], rotation: Quat): [number[], number[]] {
    const offset = index * 16;
    const sx = Math.hypot(matrices[offset]!, matrices[offset + 1]!, matrices[offset + 2]!);
    const syMagnitude = Math.hypot(matrices[offset + 4]!, matrices[offset + 5]!, matrices[offset + 6]!);
    const sz = Math.hypot(matrices[offset + 8]!, matrices[offset + 9]!, matrices[offset + 10]!);
    const determinant =
        matrices[offset]! * (matrices[offset + 5]! * matrices[offset + 10]! - matrices[offset + 6]! * matrices[offset + 9]!) +
        matrices[offset + 1]! * (matrices[offset + 6]! * matrices[offset + 8]! - matrices[offset + 4]! * matrices[offset + 10]!) +
        matrices[offset + 2]! * (matrices[offset + 4]! * matrices[offset + 9]! - matrices[offset + 5]! * matrices[offset + 8]!);
    const sy = determinant < 0 ? -syMagnitude : syMagnitude;
    const invSx = sx > 1e-8 ? 1 / sx : 0;
    const invSy = syMagnitude > 1e-8 ? 1 / sy : 0;
    const invSz = sz > 1e-8 ? 1 / sz : 0;
    quatFromRotationBasisToRef(
        matrices[offset]! * invSx,
        matrices[offset + 4]! * invSy,
        matrices[offset + 8]! * invSz,
        matrices[offset + 1]! * invSx,
        matrices[offset + 5]! * invSy,
        matrices[offset + 9]! * invSz,
        matrices[offset + 2]! * invSx,
        matrices[offset + 6]! * invSy,
        matrices[offset + 10]! * invSz,
        rotation
    );
    const invLength = 1 / Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w);
    const positionOut = transform[0];
    const rotationOut = transform[1];
    positionOut[0] = matrices[offset + 12]!;
    positionOut[1] = matrices[offset + 13]!;
    positionOut[2] = matrices[offset + 14]!;
    rotationOut[0] = rotation.x * invLength;
    rotationOut[1] = rotation.y * invLength;
    rotationOut[2] = rotation.z * invLength;
    rotationOut[3] = rotation.w * invLength;
    return transform;
}

const instances: PhysicsBodyInstances = {
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
            hknp.HP_Body_SetQTransform(body._hkBodies![i], thinInstanceTransform(thin.matrices, i, body._instanceTransform!, body._instanceRotation!));
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

function validate(world: PhysicsWorld, node: Mesh): void {
    if (world._fo) {
        throw new Error("Thin-instance physics bodies do not support floating-origin worlds.");
    }
    if (!node.thinInstances?.count) {
        throw new Error("Thin-instance physics requires a non-empty matrix buffer before body creation.");
    }
}

function createBody(world: PhysicsWorld, node: Mesh, motionType: PhysicsMotionType, startsAsleep: boolean): PhysicsBody {
    validate(world, node);
    const thin = node.thinInstances!;
    const hknp = world._hknp;
    const hkMotion = motionType === 0 ? hknp.MotionType.STATIC : motionType === 1 ? hknp.MotionType.KINEMATIC : hknp.MotionType.DYNAMIC;
    const handles = new Array<any>(thin.count);
    const transform: [number[], number[]] = [
        [0, 0, 0],
        [0, 0, 0, 1],
    ];
    const rotation: Quat = { x: 0, y: 0, z: 0, w: 1 };
    for (let i = 0; i < handles.length; i++) {
        const handle = hknp.HP_Body_Create()[1];
        handles[i] = handle;
        hknp.HP_Body_SetMotionType(handle, hkMotion);
        hknp.HP_World_AddBody(world._hkWorld, handle, startsAsleep);
        hknp.HP_Body_SetQTransform(handle, thinInstanceTransform(thin.matrices, i, transform, rotation));
    }
    const body: PhysicsBody = {
        _hkBody: handles[0],
        _hkBodies: handles,
        _instances: instances,
        _instanceTransform: transform,
        _instanceRotation: rotation,
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
export const havokThinInstanceContext: HavokThinInstanceContext = { validate, createBody };
