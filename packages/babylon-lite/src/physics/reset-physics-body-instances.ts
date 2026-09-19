import type { PhysicsBody, PhysicsWorld } from "./havok.js";
import { _thinInstanceTransform } from "./havok-thin-instances.js";
import type { Mat4, Quat } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { flushThinInstances } from "../mesh/thin-instance.js";

type NativeTransform = [number[], number[]];
type ResetState = [transforms: Float64Array, matrices: Float32Array, carrier: Float64Array, transformScratch: NativeTransform, zeroVelocity: number[]];

let resetStates: WeakMap<PhysicsBody, ResetState> | undefined;

function states(): WeakMap<PhysicsBody, ResetState> {
    return (resetStates ??= new WeakMap());
}

function validateThinBody(world: PhysicsWorld, body: PhysicsBody): void {
    if (body._world !== world || !world._bodies.includes(body)) {
        throw new Error("Physics body does not belong to this world.");
    }
    if (world._thin?.count(body) === undefined) {
        throw new Error("Thin-instance reset state requires a thin-instance physics body.");
    }
}

function isIdentity(matrix: Mat4): boolean {
    for (let index = 0; index < 16; index++) {
        if (matrix[index] !== (index % 5 === 0 ? 1 : 0)) {
            return false;
        }
    }
    return true;
}

/** Replace a thin body's reset checkpoint with its current local matrices and carrier transform. */
export function capturePhysicsBodyInstanceResetState(world: PhysicsWorld, body: PhysicsBody): void {
    validateThinBody(world, body);
    const thin = world._thin!;
    const count = thin.count(body)!;
    const mesh = body.node as Mesh;
    const matrices = new Float32Array(mesh.thinInstances!.matrices);
    const carrier = new Float64Array(mesh.worldMatrix);
    const transforms = new Float64Array(count * 7);
    const matrixScratch = new Float64Array(16);
    const transform: NativeTransform = [
        [0, 0, 0],
        [0, 0, 0, 1],
    ];
    const rotation: Quat = { x: 0, y: 0, z: 0, w: 1 };
    const scales = new Float64Array(count * 3);
    const carrierIdentity = isIdentity(carrier as unknown as Mat4);
    for (let index = 0; index < count; index++) {
        _thinInstanceTransform(matrices, index, carrier as unknown as Mat4, carrierIdentity, matrixScratch, transform, rotation, scales);
        const offset = index * 7;
        transforms.set(transform[0], offset);
        transforms.set(transform[1], offset + 3);
    }
    states().set(body, [transforms, matrices, carrier, transform, [0, 0, 0]]);
}

/**
 * Restore every native body represented by a thin-instance physics body to its
 * captured reset transform. Existing native bodies and the mesh's CPU/GPU matrix
 * storage are retained; linear and angular velocities are cleared and the
 * restored bodies are put to sleep.
 */
export function resetPhysicsBodyInstances(world: PhysicsWorld, body: PhysicsBody): void {
    validateThinBody(world, body);
    const state = states().get(body);
    if (!state) {
        throw new Error("Thin-instance reset state has not been captured.");
    }
    const thin = world._thin!;
    const native = thin.resetNative;
    const mesh = body.node as Mesh;
    for (let index = 0; index < 16; index++) {
        if (mesh.worldMatrix[index] !== state[2][index]) {
            throw new Error("Thin-instance reset requires the carrier world transform to remain unchanged.");
        }
    }
    const initial = state[0];
    const transform = state[3];
    const velocity = state[4];
    const count = thin.count(body)!;
    for (let index = 0; index < count; index++) {
        const offset = index * 7;
        transform[0][0] = initial[offset]!;
        transform[0][1] = initial[offset + 1]!;
        transform[0][2] = initial[offset + 2]!;
        transform[1][0] = initial[offset + 3]!;
        transform[1][1] = initial[offset + 4]!;
        transform[1][2] = initial[offset + 5]!;
        transform[1][3] = initial[offset + 6]!;
        const handle = thin.instance(body, index);
        native.HP_Body_SetQTransform(handle, transform);
        native.HP_Body_SetLinearVelocity(handle, velocity);
        native.HP_Body_SetAngularVelocity(handle, velocity);
        native.HP_Body_SetActivationState(handle, native.ActivationState.INACTIVE);
    }
    mesh.thinInstances!.matrices.set(state[1]);
    flushThinInstances(mesh);
}
