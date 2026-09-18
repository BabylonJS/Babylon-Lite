import { composeMat4 } from "../math/compose-mat4.js";
import { composeMat4IntoBuffer } from "../math/compose-mat4-into-buffer.js";
import { _quatFromRotationBasis } from "../math/create-quat-from-rotation-mat4.js";
import { multiplyMat4IntoBuffer } from "../math/multiply-mat4-into-buffer.js";
import type { Mat4, Mat4Storage, Quat } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { flushThinInstances } from "../mesh/thin-instance.js";
import type { SceneNode } from "../scene/scene-node.js";
import { buildNativeMassProperties } from "./havok-mass-properties.js";
import { PhysicsMotionType, PhysicsPrestepType } from "./havok.js";
import type { HavokThinInstanceContext, PhysicsBody, PhysicsWorld } from "./havok.js";

type NativeTransform = [number[], number[]];
type ThinBodyState = [
    body: PhysicsBody,
    handles: any[],
    instanceHandles: any[],
    transform: NativeTransform,
    rotation: Quat,
    scales: Float64Array,
    matrixScratch: Float64Array,
    carrierInverse: Float64Array,
    carrierVersion: number,
    carrierIdentity: boolean,
    scaledShapes: Map<string, any>,
];

function isIdentity(matrix: Mat4): boolean {
    for (let index = 0; index < 16; index++) {
        if (matrix[index] !== (index % 5 === 0 ? 1 : 0)) {
            return false;
        }
    }
    return true;
}

function setCarrierInverse(carrier: Mat4, inverseStorage: Float64Array): void {
    const a00 = carrier[0]!;
    const a01 = carrier[1]!;
    const a02 = carrier[2]!;
    const a10 = carrier[4]!;
    const a11 = carrier[5]!;
    const a12 = carrier[6]!;
    const a20 = carrier[8]!;
    const a21 = carrier[9]!;
    const a22 = carrier[10]!;
    const c00 = a11 * a22 - a12 * a21;
    const c10 = a12 * a20 - a10 * a22;
    const c20 = a10 * a21 - a11 * a20;
    let determinant = a00 * c00 + a01 * c10 + a02 * c20;
    if (Math.abs(determinant) < 1e-10) {
        throw new Error("Thin-instance physics requires a nonsingular carrier world transform.");
    }
    determinant = 1 / determinant;
    inverseStorage[0] = c00 * determinant;
    inverseStorage[1] = (a02 * a21 - a01 * a22) * determinant;
    inverseStorage[2] = (a01 * a12 - a02 * a11) * determinant;
    inverseStorage[3] = 0;
    inverseStorage[4] = c10 * determinant;
    inverseStorage[5] = (a00 * a22 - a02 * a20) * determinant;
    inverseStorage[6] = (a02 * a10 - a00 * a12) * determinant;
    inverseStorage[7] = 0;
    inverseStorage[8] = c20 * determinant;
    inverseStorage[9] = (a01 * a20 - a00 * a21) * determinant;
    inverseStorage[10] = (a00 * a11 - a01 * a10) * determinant;
    inverseStorage[11] = 0;
    const x = carrier[12]!;
    const y = carrier[13]!;
    const z = carrier[14]!;
    inverseStorage[12] = -(inverseStorage[0]! * x + inverseStorage[4]! * y + inverseStorage[8]! * z);
    inverseStorage[13] = -(inverseStorage[1]! * x + inverseStorage[5]! * y + inverseStorage[9]! * z);
    inverseStorage[14] = -(inverseStorage[2]! * x + inverseStorage[6]! * y + inverseStorage[10]! * z);
    inverseStorage[15] = 1;
}

function updateCarrier(state: ThinBodyState): Mat4 {
    const mesh = state[0].node as Mesh;
    const carrier = mesh.worldMatrix;
    const version = mesh.worldMatrixVersion;
    if (version !== state[8]) {
        setCarrierInverse(carrier, state[7]);
        state[9] = isIdentity(carrier);
        state[8] = version;
    }
    return carrier;
}

function thinInstanceTransform(
    matrices: Mat4Storage,
    index: number,
    carrier: Mat4,
    carrierIdentity: boolean,
    matrixScratch: Mat4Storage,
    transform: NativeTransform,
    rotation: Quat,
    scales: Float64Array
): NativeTransform {
    const matrixOffset = index * 16;
    let source = matrices;
    let offset = matrixOffset;
    if (!carrierIdentity) {
        for (let i = 0; i < 16; i++) {
            matrixScratch[i] = carrier[i]!;
        }
        multiplyMat4IntoBuffer(matrixScratch, 0, matrixScratch, 0, matrices, matrixOffset);
        source = matrixScratch;
        offset = 0;
    }
    const storageUnitRoundoff = matrices instanceof Float32Array || carrier instanceof Float32Array ? 2 ** -23 : Number.EPSILON * 4;
    const sxMagnitude = Math.hypot(source[offset]!, source[offset + 1]!, source[offset + 2]!);
    const rawSyMagnitude = Math.hypot(source[offset + 4]!, source[offset + 5]!, source[offset + 6]!);
    const szMagnitude = Math.hypot(source[offset + 8]!, source[offset + 9]!, source[offset + 10]!);
    const sx = Math.abs(sxMagnitude - 1) <= storageUnitRoundoff ? 1 : sxMagnitude;
    const syMagnitude = Math.abs(rawSyMagnitude - 1) <= storageUnitRoundoff ? 1 : rawSyMagnitude;
    const sz = Math.abs(szMagnitude - 1) <= storageUnitRoundoff ? 1 : szMagnitude;
    const determinant =
        source[offset]! * (source[offset + 5]! * source[offset + 10]! - source[offset + 6]! * source[offset + 9]!) +
        source[offset + 1]! * (source[offset + 6]! * source[offset + 8]! - source[offset + 4]! * source[offset + 10]!) +
        source[offset + 2]! * (source[offset + 4]! * source[offset + 9]! - source[offset + 5]! * source[offset + 8]!);
    const sy = determinant < 0 ? -syMagnitude : syMagnitude;
    const scaleOffset = index * 3;
    scales[scaleOffset] = sx;
    scales[scaleOffset + 1] = sy;
    scales[scaleOffset + 2] = sz;
    const invSx = sx > 1e-8 ? 1 / sx : 0;
    const invSy = syMagnitude > 1e-8 ? 1 / sy : 0;
    const invSz = sz > 1e-8 ? 1 / sz : 0;
    _quatFromRotationBasis(
        source[offset]! * invSx,
        source[offset + 4]! * invSy,
        source[offset + 8]! * invSz,
        source[offset + 1]! * invSx,
        source[offset + 5]! * invSy,
        source[offset + 9]! * invSz,
        source[offset + 2]! * invSx,
        source[offset + 6]! * invSy,
        source[offset + 10]! * invSz,
        rotation
    );
    const invLength = 1 / Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w);
    const positionOut = transform[0];
    const rotationOut = transform[1];
    positionOut[0] = source[offset + 12]!;
    positionOut[1] = source[offset + 13]!;
    positionOut[2] = source[offset + 14]!;
    rotationOut[0] = rotation.x * invLength;
    rotationOut[1] = rotation.y * invLength;
    rotationOut[2] = rotation.z * invLength;
    rotationOut[3] = rotation.w * invLength;
    return transform;
}

function writeInstanceMatrix(state: ThinBodyState, matrices: Mat4Storage, index: number, position: number[], rotation: number[]): void {
    const scaleOffset = index * 3;
    composeMat4IntoBuffer(
        state[6],
        0,
        position[0]!,
        position[1]!,
        position[2]!,
        rotation[0]!,
        rotation[1]!,
        rotation[2]!,
        rotation[3]!,
        state[5][scaleOffset]!,
        state[5][scaleOffset + 1]!,
        state[5][scaleOffset + 2]!
    );
    if (state[9]) {
        matrices.set(state[6], index * 16);
    } else {
        multiplyMat4IntoBuffer(matrices, index * 16, state[7], 0, state[6], 0);
    }
    const offset = index * 16;
    for (let column = 0; column < 3; column++) {
        const columnOffset = offset + column * 4;
        const roundoff = Number.EPSILON * Math.hypot(matrices[columnOffset]!, matrices[columnOffset + 1]!, matrices[columnOffset + 2]!) * 8;
        for (let row = 0; row < 3; row++) {
            if (Math.abs(matrices[columnOffset + row]!) <= roundoff) {
                matrices[columnOffset + row] = 0;
            }
        }
        matrices[columnOffset + 3] = 0;
    }
}

function releaseScaledShapes(raw: any, state: ThinBodyState): void {
    for (const shape of state[10].values()) {
        raw.HP_Shape_Release(shape);
    }
    state[10].clear();
}

function setInstanceShapes(raw: any, state: ThinBodyState, shape: any): any {
    const previousShapes = state[10];
    const scaledShapes = new Map<string, any>();
    let result;
    for (let index = 0; index < state[1].length; index++) {
        const scaleOffset = index * 3;
        const x = state[5][scaleOffset]!;
        const y = state[5][scaleOffset + 1]!;
        const z = state[5][scaleOffset + 2]!;
        let instanceShape = shape;
        if (x !== 1 || y !== 1 || z !== 1) {
            const key = `${x},${y},${z}`;
            instanceShape = scaledShapes.get(key);
            if (!instanceShape) {
                instanceShape = raw.HP_Shape_CreateContainer()[1];
                raw.HP_Shape_AddChild(instanceShape, shape, [
                    [0, 0, 0],
                    [0, 0, 0, 1],
                    [x, y, z],
                ]);
                scaledShapes.set(key, instanceShape);
            }
        }
        result = raw.HP_Body_SetShape(state[1][index], instanceShape);
    }
    state[10] = scaledShapes;
    for (const previousShape of previousShapes.values()) {
        raw.HP_Shape_Release(previousShape);
    }
    return result;
}

/** @internal Creates the stateful seam and Havok facade installed by `enableHavokThinInstancePhysics`. */
export function createHavokThinInstanceContext(world: PhysicsWorld): HavokThinInstanceContext {
    const raw = world._hknp;
    const hkWorld = world._hkWorld;
    const states = new Map<any, ThinBodyState>();
    const facade = Object.create(raw);

    for (const name of [
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

    facade.HP_Body_SetShape = (handle: any, shape: any): any => {
        const state = states.get(handle);
        return state ? setInstanceShapes(raw, state, shape) : raw.HP_Body_SetShape(handle, shape);
    };

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
        updateCarrier(state);
        for (let i = 0; i < state[1].length; i++) {
            writeInstanceMatrix(state, matrices, i, position, rotation);
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
        releaseScaledShapes(raw, state);
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

            const scales = new Float64Array(thin.count * 3);
            const matrixScratch = new Float64Array(16);
            const carrier = mesh.worldMatrix;
            const carrierIdentity = isIdentity(carrier);
            const inverseStorage = new Float64Array(16);
            setCarrierInverse(carrier, inverseStorage);
            for (let i = 0; i < handles.length; i++) {
                const handle = raw.HP_Body_Create()[1];
                handles[i] = handle;
                raw.HP_Body_SetMotionType(handle, hkMotion);
                raw.HP_World_AddBody(hkWorld, handle, startsAsleep);
                raw.HP_Body_SetQTransform(handle, thinInstanceTransform(thin.matrices, i, carrier, carrierIdentity, matrixScratch, transform, rotation, scales));
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
            states.set(handles[0], [
                body,
                handles,
                new Array<any>(handles.length),
                transform,
                rotation,
                scales,
                matrixScratch,
                inverseStorage,
                mesh.worldMatrixVersion,
                carrierIdentity,
                new Map<string, any>(),
            ]);
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
            updateCarrier(state);
            for (let i = 0; i < handles.length; i++) {
                const nativeTransform = raw.HP_Body_GetQTransform(handles[i])[1];
                writeInstanceMatrix(state, matrices, i, nativeTransform[0], nativeTransform[1]);
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
            const carrier = updateCarrier(state);
            for (let i = 0; i < state[1].length; i++) {
                raw.HP_Body_SetQTransform(state[1][i], thinInstanceTransform(matrices, i, carrier, state[9], state[6], state[3], state[4], state[5]));
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
        instance(body, index) {
            const state = states.get(body._hkBody);
            if (!state || index < 0 || index >= state[1].length) {
                return undefined;
            }
            const handle = state[1][index]!;
            return (state[2][index] ??= [handle[0]]);
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
            return composeMat4(p[0], p[1], p[2], q[0], q[1], q[2], q[3], 1, 1, 1);
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
        mass(body, properties, fallbackInertia) {
            const state = states.get(body._hkBody);
            if (!state) {
                return false;
            }
            const transform = body._massPropertiesTransform;
            let index = 0;
            for (const handle of state[1]) {
                const massProperties = buildNativeMassProperties(raw, handle, properties, fallbackInertia);
                transform?.(massProperties, index++);
                raw.HP_Body_SetMassProperties(handle, massProperties);
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
