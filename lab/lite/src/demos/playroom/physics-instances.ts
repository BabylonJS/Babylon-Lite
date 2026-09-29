import { flushThinInstances } from "babylon-lite";
import type { Mesh, PhysicsBody, PhysicsWorld, Vec3 } from "babylon-lite";

type NativeTransform = [number[], number[]];

interface ResetState {
    readonly transforms: Float64Array;
    readonly matrices: Float32Array;
    readonly carrier: Float64Array;
    readonly transformScratch: NativeTransform;
    readonly zeroVelocity: number[];
}

let resetStates: WeakMap<PhysicsBody, ResetState> | undefined;

function resolveBodyInstance(world: PhysicsWorld, body: PhysicsBody, instanceIndex: number): unknown {
    if (body._world !== world) {
        throw new Error("Physics body does not belong to this world.");
    }
    if (!world._bodies.includes(body)) {
        throw new Error("Physics body has been removed from this world.");
    }
    if (!Number.isInteger(instanceIndex) || instanceIndex < 0) {
        throw new RangeError("Physics body instance index must be a nonnegative integer.");
    }
    const count = world._thin?.count(body);
    if (count === undefined) {
        if (instanceIndex !== 0) {
            throw new RangeError("Ordinary physics bodies only have instance index 0.");
        }
        return body._hkBody;
    }
    const nativeBody = world._thin!.instance(body, instanceIndex);
    if (!nativeBody) {
        throw new RangeError(`Physics body instance index ${instanceIndex} is out of range (count: ${count}).`);
    }
    return nativeBody;
}

export function applyPhysicsBodyInstanceImpulse(world: PhysicsWorld, body: PhysicsBody, instanceIndex: number, impulse: Vec3, location: Vec3): void {
    const nativeBody = resolveBodyInstance(world, body, instanceIndex);
    world._hknp.HP_Body_ApplyImpulse(nativeBody, [location.x, location.y, location.z], [impulse.x, impulse.y, impulse.z]);
}

export function getPhysicsBodyInstanceLinearVelocityToRef(world: PhysicsWorld, body: PhysicsBody, instanceIndex: number, result: Vec3): void {
    const nativeBody = resolveBodyInstance(world, body, instanceIndex);
    const velocity = world._hknp.HP_Body_GetLinearVelocity(nativeBody)[1];
    result.x = velocity[0];
    result.y = velocity[1];
    result.z = velocity[2];
}

function validateThinBody(world: PhysicsWorld, body: PhysicsBody): number {
    if (body._world !== world || !world._bodies.includes(body)) {
        throw new Error("Physics body does not belong to this world.");
    }
    const count = world._thin?.count(body);
    if (count === undefined) {
        throw new Error("Thin-instance reset state requires a thin-instance physics body.");
    }
    return count;
}

export function capturePhysicsBodyInstanceResetState(world: PhysicsWorld, body: PhysicsBody): void {
    const count = validateThinBody(world, body);
    const mesh = body.node as Mesh;
    const transforms = new Float64Array(count * 7);
    for (let index = 0; index < count; index++) {
        const transform = world._hknp.HP_Body_GetQTransform(world._thin!.instance(body, index))[1] as NativeTransform;
        const offset = index * 7;
        transforms.set(transform[0], offset);
        transforms.set(transform[1], offset + 3);
    }
    (resetStates ??= new WeakMap()).set(body, {
        transforms,
        matrices: new Float32Array(mesh.thinInstances!.matrices),
        carrier: new Float64Array(mesh.worldMatrix),
        transformScratch: [
            [0, 0, 0],
            [0, 0, 0, 1],
        ],
        zeroVelocity: [0, 0, 0],
    });
}

export function resetPhysicsBodyInstances(world: PhysicsWorld, body: PhysicsBody): void {
    const count = validateThinBody(world, body);
    const state = resetStates?.get(body);
    if (!state) {
        throw new Error("Thin-instance reset state has not been captured.");
    }
    const mesh = body.node as Mesh;
    for (let index = 0; index < 16; index++) {
        if (mesh.worldMatrix[index] !== state.carrier[index]) {
            throw new Error("Thin-instance reset requires the carrier world transform to remain unchanged.");
        }
    }
    for (let index = 0; index < count; index++) {
        const offset = index * 7;
        const transform = state.transformScratch;
        transform[0][0] = state.transforms[offset]!;
        transform[0][1] = state.transforms[offset + 1]!;
        transform[0][2] = state.transforms[offset + 2]!;
        transform[1][0] = state.transforms[offset + 3]!;
        transform[1][1] = state.transforms[offset + 4]!;
        transform[1][2] = state.transforms[offset + 5]!;
        transform[1][3] = state.transforms[offset + 6]!;
        const nativeBody = world._thin!.instance(body, index);
        world._hknp.HP_Body_SetQTransform(nativeBody, transform);
        world._hknp.HP_Body_SetLinearVelocity(nativeBody, state.zeroVelocity);
        world._hknp.HP_Body_SetAngularVelocity(nativeBody, state.zeroVelocity);
        world._hknp.HP_Body_SetActivationState(nativeBody, world._hknp.ActivationState.INACTIVE);
    }
    mesh.thinInstances!.matrices.set(state.matrices);
    flushThinInstances(mesh);
}
