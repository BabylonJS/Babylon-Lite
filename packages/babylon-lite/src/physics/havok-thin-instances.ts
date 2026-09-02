import { mat4Compose } from "../math/mat4-compose.js";
import { mat4ComposeInto } from "../math/mat4-compose-into.js";
import { _quatFromRotationBasis } from "../math/quat-from-rotation-matrix.js";
import type { Quat } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { flushThinInstances } from "../mesh/thin-instance.js";
import type { SceneNode } from "../scene/scene-node.js";
import { PhysicsMotionType, PhysicsPrestepType } from "./havok.js";
import type { HavokThinInstanceContext, PhysicsBody, PhysicsWorld } from "./havok.js";

type NativeTransform = [number[], number[]];
type ThinBodyState = [PhysicsBody, any[], any[], NativeTransform, Quat];

function thinInstanceTransform(matrices: Float32Array | Float64Array, index: number, transform: NativeTransform, rotation: Quat): NativeTransform {
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
    _quatFromRotationBasis(
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

/** @internal Creates the stateful seam and Havok facade installed by `enableHavokThinInstancePhysics`. */
export function createHavokThinInstanceContext(world: PhysicsWorld): HavokThinInstanceContext {
    const raw = world._hknp;
    const hkWorld = world._hkWorld;
    const states = new Map<any, ThinBodyState>();
    const facade = Object.create(raw);

    for (const name of [
        "HP_Body_SetShape",
        "HP_Body_SetMassProperties",
        "HP_Body_ApplyImpulse",
        "HP_Body_SetLinearVelocity",
        "HP_Body_SetAngularVelocity",
        "HP_Body_SetMotionType",
        "HP_Body_SetTargetQTransform",
        "HP_Body_SetEventMask",
    ]) {
        facade[name] = (handle: any, ...args: any[]): any => {
            const state = states.get(handle);
            if (!state) {
                return raw[name](handle, ...args);
            }
            let result;
            for (const nativeHandle of state[1]) {
                result = raw[name](nativeHandle, ...args);
            }
            return result;
        };
    }

    facade.HP_Body_SetQTransform = (handle: any, transform: NativeTransform): any => {
        const state = states.get(handle);
        if (!state) {
            return raw.HP_Body_SetQTransform(handle, transform);
        }
        let result;
        for (const nativeHandle of state[1]) {
            result = raw.HP_Body_SetQTransform(nativeHandle, transform);
        }
        const mesh = state[0].node as Mesh;
        const matrices = mesh.thinInstances!.matrices;
        const position = transform[0];
        const rotation = transform[1];
        for (let i = 0; i < state[1].length; i++) {
            mat4ComposeInto(matrices, i * 16, position[0]!, position[1]!, position[2]!, rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!, 1, 1, 1);
        }
        flushThinInstances(mesh);
        return result;
    };

    facade.HP_World_RemoveBody = (nativeWorld: any, handle: any): any => {
        const state = states.get(handle);
        if (!state) {
            return raw.HP_World_RemoveBody(nativeWorld, handle);
        }
        let result;
        for (const nativeHandle of state[1]) {
            result = raw.HP_World_RemoveBody(nativeWorld, nativeHandle);
        }
        return result;
    };

    const release = (state: ThinBodyState): void => {
        if (!states.delete(state[1][0])) {
            return;
        }
        for (const handle of state[1]) {
            raw.HP_Body_Release(handle);
        }
    };

    facade.HP_Body_Release = (handle: any): any => {
        const state = states.get(handle);
        if (!state) {
            return raw.HP_Body_Release(handle);
        }
        release(state);
    };

    world._hknp = facade;

    const validate = (node: SceneNode): void => {
        const thin = (node as Mesh).thinInstances;
        if (!thin) {
            return;
        }
        if (world._fo) {
            throw new Error("Thin-instance physics bodies do not support floating-origin worlds.");
        }
        if (!thin.count) {
            throw new Error("Thin-instance physics requires a non-empty matrix buffer before body creation.");
        }
    };

    return {
        validate,
        create(node, motionType, startsAsleep) {
            const mesh = node as Mesh;
            const thin = mesh.thinInstances;
            if (!thin) {
                return undefined;
            }
            validate(node);
            const hkMotion =
                motionType === PhysicsMotionType.STATIC ? raw.MotionType.STATIC : motionType === PhysicsMotionType.ANIMATED ? raw.MotionType.KINEMATIC : raw.MotionType.DYNAMIC;
            const handles = new Array<any>(thin.count);
            const transform: NativeTransform = [
                [0, 0, 0],
                [0, 0, 0, 1],
            ];
            const rotation: Quat = { x: 0, y: 0, z: 0, w: 1 };
            for (let i = 0; i < handles.length; i++) {
                const handle = raw.HP_Body_Create()[1];
                handles[i] = handle;
                raw.HP_Body_SetMotionType(handle, hkMotion);
                raw.HP_World_AddBody(hkWorld, handle, startsAsleep);
                raw.HP_Body_SetQTransform(handle, thinInstanceTransform(thin.matrices, i, transform, rotation));
            }
            const body: PhysicsBody = {
                _hkBody: handles[0],
                _shape: null,
                _preStep: false,
                _prestepType: PhysicsPrestepType.TELEPORT,
                _world: world,
                node,
                motionType,
            };
            states.set(handles[0], [body, handles, new Array<any>(handles.length), transform, rotation]);
            return body;
        },
        from(body) {
            const state = states.get(body._hkBody);
            if (!state) {
                return false;
            }
            const mesh = body.node as Mesh;
            const matrices = mesh.thinInstances!.matrices;
            const handles = state[1];
            for (let i = 0; i < handles.length; i++) {
                const nativeTransform = raw.HP_Body_GetQTransform(handles[i])[1];
                const position = nativeTransform[0];
                const rotation = nativeTransform[1];
                mat4ComposeInto(matrices, i * 16, position[0], position[1], position[2], rotation[0], rotation[1], rotation[2], rotation[3], 1, 1, 1);
            }
            flushThinInstances(mesh);
            return true;
        },
        to(body) {
            const state = states.get(body._hkBody);
            if (!state) {
                return false;
            }
            const matrices = (body.node as Mesh).thinInstances!.matrices;
            for (let i = 0; i < state[1].length; i++) {
                raw.HP_Body_SetQTransform(state[1][i], thinInstanceTransform(matrices, i, state[3], state[4]));
            }
            return true;
        },
        target(body) {
            const state = states.get(body._hkBody);
            if (!state) {
                return false;
            }
            const p = body.node.position;
            const q = body.node.rotationQuaternion;
            const transform = state[3];
            transform[0][0] = p.x;
            transform[0][1] = p.y;
            transform[0][2] = p.z;
            transform[1][0] = q.x;
            transform[1][1] = q.y;
            transform[1][2] = q.z;
            transform[1][3] = q.w;
            for (const handle of state[1]) {
                raw.HP_Body_SetTargetQTransform(handle, transform);
            }
            return true;
        },
        count(body) {
            return states.get(body._hkBody)?.[1].length;
        },
        resolve(nativeId) {
            const id = Number(nativeId);
            for (const state of states.values()) {
                for (let i = 0; i < state[1].length; i++) {
                    const handle = state[1][i]!;
                    if (Number(handle[0]) === id) {
                        return [state[0], (state[2][i] ??= [handle[0]]), i];
                    }
                }
            }
            return null;
        },
        com(body, nativeBody, localCenter) {
            if (!states.has(body._hkBody)) {
                return undefined;
            }
            const transform = raw.HP_Body_GetQTransform(nativeBody)[1];
            const p = transform[0];
            const q = transform[1];
            const tx = 2 * (q[1] * localCenter[2] - q[2] * localCenter[1]);
            const ty = 2 * (q[2] * localCenter[0] - q[0] * localCenter[2]);
            const tz = 2 * (q[0] * localCenter[1] - q[1] * localCenter[0]);
            return {
                x: p[0] + localCenter[0] + q[3] * tx + q[1] * tz - q[2] * ty,
                y: p[1] + localCenter[1] + q[3] * ty + q[2] * tx - q[0] * tz,
                z: p[2] + localCenter[2] + q[3] * tz + q[0] * ty - q[1] * tx,
            };
        },
        matrix(body, nativeBody) {
            if (!states.has(body._hkBody)) {
                return undefined;
            }
            const transform = raw.HP_Body_GetQTransform(nativeBody)[1];
            const p = transform[0];
            const q = transform[1];
            return mat4Compose(p[0], p[1], p[2], q[0], q[1], q[2], q[3], 1, 1, 1);
        },
        impulse(body, impulse) {
            const state = states.get(body._hkBody);
            if (!state) {
                return false;
            }
            const value = [impulse.x, impulse.y, impulse.z];
            for (const handle of state[1]) {
                const position = raw.HP_Body_GetQTransform(handle)[1][0];
                raw.HP_Body_ApplyImpulse(handle, position, value);
            }
            return true;
        },
        dispose() {
            for (const state of states.values()) {
                release(state);
            }
        },
    };
}
