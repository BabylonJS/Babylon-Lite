import { describe, expect, it, vi } from "vitest";

import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { CharacterCollisionObservable, PhysicsCharacterController } from "../../../packages/babylon-lite/src/physics/character-controller";
import { onPhysicsCollision, setPhysicsBodyCollisionEventsEnabled } from "../../../packages/babylon-lite/src/physics/havok-collision";
import { physicsRaycast } from "../../../packages/babylon-lite/src/physics/havok-queries";
import { onPhysicsTriggerBodies } from "../../../packages/babylon-lite/src/physics/havok-trigger";
import {
    applyPhysicsBodyImpulse,
    applyPhysicsImpulse,
    createHavokWorld,
    createPhysicsBody,
    disposePhysics,
    enableHavokThinInstancePhysics,
    getPhysicsBodyInstanceCount,
    PhysicsMotionType,
    PhysicsPrestepType,
    PhysicsShapeType,
    onPhysicsAfterStep,
    removePhysicsBody,
    setPhysicsBodyAngularVelocity,
    setPhysicsBodyLinearVelocity,
    setPhysicsBodyMass,
    setPhysicsBodyMotionType,
    setPhysicsBodyPrestepType,
    setPhysicsBodyShape,
    setPhysicsBodyTransform,
} from "../../../packages/babylon-lite/src/physics/havok";
import type { PhysicsBody, PhysicsShape } from "../../../packages/babylon-lite/src/physics/havok";

function makeMockHknp() {
    let nextBody = 1;
    const transforms = new Map<number, [number[], number[]]>();
    return {
        transforms,
        MotionType: { STATIC: 0, KINEMATIC: 1, DYNAMIC: 2 },
        Result: { RESULT_OK: 0 },
        HP_World_Create: vi.fn(() => [0, { id: "world" }]),
        HP_World_SetGravity: vi.fn(),
        HP_World_AddBody: vi.fn(),
        HP_World_RemoveBody: vi.fn(),
        HP_World_Step: vi.fn(),
        HP_World_Release: vi.fn(),
        HP_Body_Create: vi.fn(() => [0, [nextBody++]]),
        HP_Body_SetMotionType: vi.fn(),
        HP_Body_SetLinearVelocity: vi.fn(),
        HP_Body_SetAngularVelocity: vi.fn(),
        HP_Body_ApplyImpulse: vi.fn(),
        HP_Body_SetQTransform: vi.fn((body: number[], transform: [number[], number[]]) => {
            transforms.set(body[0]!, [transform[0].slice(), transform[1].slice()]);
        }),
        HP_Body_SetTargetQTransform: vi.fn(),
        HP_Body_GetQTransform: vi.fn((body: number[]) => [0, transforms.get(body[0]!)!]),
        HP_Shape_CreateBox: vi.fn(() => [0, ["shape"]]),
        HP_Body_SetShape: vi.fn(),
        HP_Body_GetShape: vi.fn(() => [0, ["shape"]]),
        HP_Shape_BuildMassProperties: vi.fn(() => [0, [[0, 0, 0], 1, [1, 1, 1], [0, 0, 0, 1]]]),
        HP_Body_SetMassProperties: vi.fn(),
        HP_Body_Release: vi.fn(),
        HP_Shape_Release: vi.fn(),
        HP_QueryCollector_Release: vi.fn(),
    };
}

function makeScene(): SceneContext {
    return { _beforeRender: [] } as unknown as SceneContext;
}

function makeThinMesh(): Mesh {
    const matrices = new Float32Array(32);
    matrices[0] = matrices[5] = matrices[10] = matrices[15] = 1;
    matrices[12] = -2;
    matrices[13] = 5;
    matrices[16] = matrices[21] = matrices[26] = matrices[31] = 1;
    matrices[28] = 3;
    matrices[29] = 8;
    return {
        _gpu: {},
        _cpuPositions: new Float32Array(),
        position: { x: 50, y: 60, z: 70, set: vi.fn() },
        rotationQuaternion: { x: 0, y: 0, z: 0, w: 1, set: vi.fn() },
        thinInstances: {
            matrices,
            count: 2,
            _capacity: 2,
            _version: 1,
            _gpuBuffer: null,
            _gpuBufferStorage: false,
            _gpuVersion: 0,
            _dirtyMin: 0,
            _dirtyMax: 2,
            _colorVersion: 0,
            _colorDirtyMin: 0,
            _colorDirtyMax: 0,
            _colorGpuBuffer: null,
            _colorGpuBufferStorage: false,
            _colorGpuVersion: 0,
            _gpuCullingEnabled: false,
        },
    } as unknown as Mesh;
}

function stepFrame(scene: SceneContext): void {
    for (const cb of [...scene._beforeRender]) {
        cb(1000 / 60);
    }
}

describe("thin-instance physics bodies", () => {
    it("creates one native body per matrix and ignores the carrier mesh transform", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);

        expect(world._hknp).not.toBe(hknp);
        expect(Object.getPrototypeOf(world._hknp)).toBe(hknp);
        expect(getPhysicsBodyInstanceCount(body)).toBe(2);
        expect(hknp.HP_Body_Create).toHaveBeenCalledTimes(2);
        expect(hknp.HP_World_AddBody).toHaveBeenCalledTimes(2);
        expect(Array.from(hknp.transforms.values())).toEqual([
            [
                [-2, 5, 0],
                [0, 0, 0, 1],
            ],
            [
                [3, 8, 0],
                [0, 0, 0, 1],
            ],
        ]);
    });

    it("rejects an empty thin-instance buffer instead of creating an ordinary body", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const mesh = makeThinMesh();
        mesh.thinInstances!.count = 0;

        expect(() => createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC)).toThrow("non-empty matrix buffer");
        expect(hknp.HP_Body_Create).not.toHaveBeenCalled();
    });

    it("removes positive and mirrored scale before extracting native body rotations", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const mesh = makeThinMesh();
        const matrices = mesh.thinInstances!.matrices;
        matrices[0] = 0;
        matrices[1] = 2;
        matrices[4] = -2;
        matrices[5] = 0;
        matrices[10] = 2;
        matrices[16] = -2;
        matrices[21] = 2;
        matrices[26] = 2;

        createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);

        const scaledRotation = hknp.transforms.get(1)![1];
        expect(scaledRotation[0]).toBeCloseTo(0);
        expect(scaledRotation[1]).toBeCloseTo(0);
        expect(scaledRotation[2]).toBeCloseTo(Math.SQRT1_2);
        expect(scaledRotation[3]).toBeCloseTo(Math.SQRT1_2);
        const mirroredRotation = hknp.transforms.get(2)![1];
        expect(mirroredRotation[0]).toBeCloseTo(0);
        expect(mirroredRotation[1]).toBeCloseTo(0);
        expect(mirroredRotation[2]).toBeCloseTo(1);
        expect(mirroredRotation[3]).toBeCloseTo(0);
    });

    it("activates thin detection only after explicit enable and validates in the installed seam", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        const mesh = makeThinMesh();

        const ordinary = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);
        expect(getPhysicsBodyInstanceCount(ordinary)).toBe(1);

        await enableHavokThinInstancePhysics(world);
        mesh.thinInstances!.count = 0;
        expect(() => createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC)).toThrow("non-empty matrix buffer");

        mesh.thinInstances!.count = 2;
        Object.assign(world, { _fo: {} });
        expect(() => createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC)).toThrow("floating-origin worlds");
    });

    it("keeps one thin context across concurrent enable calls", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        const firstEnable = enableHavokThinInstancePhysics(world);
        const secondEnable = enableHavokThinInstancePhysics(world);

        await firstEnable;
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        await secondEnable;

        expect(getPhysicsBodyInstanceCount(body)).toBe(2);
        expect(world._thin!.resolve(2)?.[0]).toBe(body);
    });

    it("reuses one transform payload across animated thin-instance prestep synchronization", async () => {
        const hknp = makeMockHknp();
        const scene = makeScene();
        const mesh = makeThinMesh();
        const world = createHavokWorld(scene, hknp);
        await enableHavokThinInstancePhysics(world);
        createPhysicsBody(world, mesh, PhysicsMotionType.ANIMATED);
        mesh.thinInstances!.matrices[12] = 4;
        mesh.thinInstances!.matrices[28] = 9;
        for (const offset of [0, 16]) {
            mesh.thinInstances!.matrices[offset] = 0;
            mesh.thinInstances!.matrices[offset + 1] = 1;
            mesh.thinInstances!.matrices[offset + 4] = -1;
            mesh.thinInstances!.matrices[offset + 5] = 0;
        }

        stepFrame(scene);

        expect(hknp.HP_Body_SetQTransform.mock.calls[2]![1]).toBe(hknp.HP_Body_SetQTransform.mock.calls[3]![1]);
        expect(hknp.HP_Body_SetQTransform.mock.calls[2]![1][1][2]).toBeCloseTo(Math.SQRT1_2);
        expect(hknp.HP_Body_SetQTransform.mock.calls[2]![1][1][3]).toBeCloseTo(Math.SQRT1_2);
        expect(hknp.transforms.get(1)![0][0]).toBe(4);
        expect(hknp.transforms.get(2)![0][0]).toBe(9);
    });

    it("uses the carrier target for ACTION prestep without allocating per instance", async () => {
        const hknp = makeMockHknp();
        const scene = makeScene();
        const mesh = makeThinMesh();
        const world = createHavokWorld(scene, hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, mesh, PhysicsMotionType.ANIMATED);
        setPhysicsBodyPrestepType(body, PhysicsPrestepType.ACTION);

        stepFrame(scene);

        expect(hknp.HP_Body_SetTargetQTransform).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_SetTargetQTransform.mock.calls[0]![1]).toBe(hknp.HP_Body_SetTargetQTransform.mock.calls[1]![1]);
        expect(hknp.HP_Body_SetTargetQTransform.mock.calls[0]![1]).toEqual([
            [50, 60, 70],
            [0, 0, 0, 1],
        ]);
    });

    it("propagates a shared shape and mass to every native instance", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        const shape = { _hkShape: ["shape"], _type: PhysicsShapeType.BOX } as PhysicsShape;

        setPhysicsBodyShape(world, body, shape);
        setPhysicsBodyMass(world, body, 2);

        expect(hknp.HP_Body_SetShape).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_SetMassProperties).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_SetMassProperties.mock.calls.map((call) => call[1][1])).toEqual([2, 2]);
    });

    it("fans direct body controls only for a thin primary handle", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        hknp.HP_Body_SetMotionType.mockClear();

        applyPhysicsBodyImpulse(body, { x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 });
        setPhysicsBodyLinearVelocity(world, body, { x: 7, y: 8, z: 9 });
        setPhysicsBodyAngularVelocity(world, body, { x: 10, y: 11, z: 12 });
        setPhysicsBodyMotionType(world, body, PhysicsMotionType.ANIMATED);

        expect(hknp.HP_Body_ApplyImpulse).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_SetLinearVelocity).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_SetAngularVelocity).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_SetMotionType).toHaveBeenCalledTimes(2);

        const instanceHandle = world._thin!.resolve(1)![1];
        hknp.HP_Body_ApplyImpulse.mockClear();
        world._hknp.HP_Body_ApplyImpulse(instanceHandle, [4, 5, 6], [1, 2, 3]);
        expect(hknp.HP_Body_ApplyImpulse).toHaveBeenCalledTimes(1);
        expect(hknp.HP_Body_ApplyImpulse).toHaveBeenCalledWith(instanceHandle, [4, 5, 6], [1, 2, 3]);
    });

    it("applies an implicit-point impulse at each instance position", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        hknp.HP_Body_ApplyImpulse.mockClear();

        applyPhysicsImpulse(world, body, { x: 1, y: 2, z: 3 });

        expect(hknp.HP_Body_ApplyImpulse.mock.calls.map((call) => call[1])).toEqual([
            [-2, 5, 0],
            [3, 8, 0],
        ]);
    });

    it("fans a public transform through the facade and flushes every thin matrix", async () => {
        const hknp = makeMockHknp();
        const mesh = makeThinMesh();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);

        setPhysicsBodyTransform(world, body, { x: 7, y: 8, z: 9 }, { x: 0, y: 0, z: 0, w: 1 });

        expect(hknp.transforms.get(1)![0]).toEqual([7, 8, 9]);
        expect(hknp.transforms.get(2)![0]).toEqual([7, 8, 9]);
        expect(Array.from(mesh.thinInstances!.matrices.slice(12, 15))).toEqual([7, 8, 9]);
        expect(Array.from(mesh.thinInstances!.matrices.slice(28, 31))).toEqual([7, 8, 9]);
        expect(mesh.thinInstances!._version).toBe(2);
    });

    it("writes every simulated transform back to the matrix slab once per step", async () => {
        const hknp = makeMockHknp();
        const scene = makeScene();
        const mesh = makeThinMesh();
        const world = createHavokWorld(scene, hknp);
        await enableHavokThinInstancePhysics(world);
        createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);
        hknp.transforms.set(1, [
            [1, 2, 3],
            [0, 0, 0, 1],
        ]);
        hknp.transforms.set(2, [
            [4, 5, 6],
            [0, 0, 0, 1],
        ]);

        stepFrame(scene);

        expect(Array.from(mesh.thinInstances!.matrices.slice(12, 15))).toEqual([1, 2, 3]);
        expect(Array.from(mesh.thinInstances!.matrices.slice(28, 31))).toEqual([4, 5, 6]);
        expect(mesh.thinInstances!._version).toBe(2);
        expect(mesh.thinInstances!._dirtyMin).toBe(0);
        expect(mesh.thinInstances!._dirtyMax).toBe(2);
        expect(mesh.position.set).not.toHaveBeenCalled();
    });

    it("removes and releases every native instance during disposal", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);

        disposePhysics(world);

        expect(hknp.HP_World_RemoveBody).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_Release).toHaveBeenCalledTimes(2);
    });

    it("removes and releases thin instances immediately outside after-step draining", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);

        removePhysicsBody(world, body);

        expect(hknp.HP_World_RemoveBody).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_Release).toHaveBeenCalledTimes(2);
        expect(world._thin!.resolve(1)).toBeNull();
        expect(world._thin!.resolve(2)).toBeNull();
    });

    it("reports Babylon.js-compatible collider indices for native collision events", async () => {
        const hknp = makeMockHknp();
        const memory = new ArrayBuffer(256);
        const address = 16;
        const ints = new Int32Array(memory, address);
        const floats = new Float32Array(memory, address);
        ints[0] = 1;
        ints[2] = 2;
        ints[18] = 1;
        floats[10] = 3;
        floats[11] = 8;
        floats[12] = 0;
        floats[13] = 1;
        floats[14] = 0;
        floats[15] = 0;
        floats[26] = 2.75;
        floats[27] = 8;
        floats[28] = 0;
        floats[34] = 4.5;
        const setEventMask = vi.fn();
        Object.assign(hknp, {
            HEAPU8: new Uint8Array(memory),
            EventType: {
                COLLISION_STARTED: { value: 1 },
                COLLISION_CONTINUED: { value: 2 },
                COLLISION_FINISHED: { value: 4 },
            },
            HP_World_GetCollisionEvents: vi.fn(() => [0, address]),
            HP_World_GetNextCollisionEvent: vi.fn(() => 0),
            HP_Body_SetEventMask: setEventMask,
        });

        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        const received = vi.fn();

        setPhysicsBodyCollisionEventsEnabled(world, body, true);
        onPhysicsCollision(world, received);
        world._afterStep![0]!(1 / 60);

        expect(setEventMask).toHaveBeenCalledTimes(2);
        expect(received).toHaveBeenCalledWith({
            collider: body,
            colliderIndex: 1,
            collidedAgainst: body,
            collidedAgainstIndex: 0,
            type: "STARTED",
            point: { x: 3, y: 8, z: 0 },
            normal: { x: 1, y: 0, z: 0 },
            impulse: 4.5,
            distance: -0.25,
        });
    });

    it("reports thin-instance indices from trigger events", async () => {
        const hknp = makeMockHknp();
        const memory = new ArrayBuffer(64);
        const address = 16;
        const event = new Int32Array(memory, address);
        event[0] = 8;
        event[2] = 2;
        event[6] = 1;
        Object.assign(hknp, {
            HEAPU8: new Uint8Array(memory),
            HP_World_GetTriggerEvents: vi.fn(() => [0, address]),
            HP_World_GetNextTriggerEvent: vi.fn(() => 0),
        });
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.STATIC);
        const received = vi.fn();

        onPhysicsTriggerBodies(world, received);
        world._afterStep![0]!(1 / 60);

        expect(received).toHaveBeenCalledWith({ type: "ENTERED", bodyA: body, bodyAIndex: 1, bodyB: body, bodyBIndex: 0 });
    });

    it("reports collisions when a participant is removed before event draining", async () => {
        const hknp = makeMockHknp();
        const releasedIds: number[] = [];
        let nextBodyId = 1;
        hknp.HP_Body_Create.mockImplementation(() => [0, [releasedIds.pop() ?? nextBodyId++]]);
        hknp.HP_Body_Release.mockImplementation((handle: number[]) => {
            releasedIds.push(handle[0]!);
        });
        const memory = new ArrayBuffer(256);
        const address = 16;
        const ints = new Int32Array(memory, address);
        ints[0] = 1;
        ints[2] = 2;
        ints[18] = 1;
        Object.assign(hknp, {
            HEAPU8: new Uint8Array(memory),
            EventType: {
                COLLISION_STARTED: { value: 1 },
                COLLISION_CONTINUED: { value: 2 },
                COLLISION_FINISHED: { value: 4 },
            },
            HP_World_GetCollisionEvents: vi.fn(() => [0, address]),
            HP_World_GetNextCollisionEvent: vi.fn(() => 0),
        });
        const scene = makeScene();
        const world = createHavokWorld(scene, hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        const received = vi.fn();
        onPhysicsAfterStep(world, () => {
            removePhysicsBody(world, body);
            expect(hknp.HP_Body_Release).not.toHaveBeenCalled();
            createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        });
        onPhysicsCollision(world, received);

        stepFrame(scene);

        expect(received).toHaveBeenCalledWith(expect.objectContaining({ collider: body, colliderIndex: 1, collidedAgainst: body, collidedAgainstIndex: 0 }));
        expect(world._thin!.resolve(3)?.[2]).toBe(0);
        expect(world._thin!.resolve(4)?.[2]).toBe(1);
        expect(hknp.HP_Body_Release).toHaveBeenCalledTimes(2);
        const reusedBody = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        expect(world._thin!.resolve(2)).toEqual([reusedBody, expect.any(Array), 0]);
        expect(world._thin!.resolve(1)).toEqual([reusedBody, expect.any(Array), 1]);
    });

    it("reports the thin-instance index from a raycast hit", async () => {
        const hknp = makeMockHknp();
        Object.assign(hknp, {
            HP_QueryCollector_Create: vi.fn(() => [0, ["collector"]]),
            HP_World_CastRayWithCollector: vi.fn(),
            HP_QueryCollector_GetNumHits: vi.fn(() => [0, 1]),
            HP_QueryCollector_GetCastRayResult: vi.fn(() => [0, [0.5, [[2], null, null, [0, 4, 0], [0, 1, 0], -1]]]),
        });
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.STATIC);

        const result = physicsRaycast(world, { x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 0 });

        expect(result.body).toBe(body);
        expect(result.bodyIndex).toBe(1);
    });

    it("applies character-controller impulses to the struck native instance", async () => {
        const hknp = makeMockHknp();
        const getLinearVelocity = vi.fn(() => [0, [-1, 0, 0]]);
        const applyImpulse = vi.fn();
        Object.assign(hknp, {
            HP_Body_GetMassProperties: vi.fn(() => [0, [[0, 0, 0], 2]]),
            HP_Body_GetQTransform: vi.fn(() => [
                0,
                [
                    [3, 8, 0],
                    [0, 0, 0, 1],
                ],
            ]),
            HP_Body_GetAngularVelocity: vi.fn(() => [0, [0, 0, 0]]),
            HP_Body_GetLinearVelocity: getLinearVelocity,
            HP_Body_ApplyImpulse: applyImpulse,
        });
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        const firstHandle = world._thin!.resolve(1)![1];
        const secondHandle = world._thin!.resolve(2)![1];
        expect(firstHandle).not.toBe(body._hkBody);
        expect(world._thin!.resolve(1)![1]).toBe(firstHandle);
        interface MutableController {
            _manifold: unknown[];
            _velocity: { x: number; y: number; z: number };
            _world: typeof world;
            _findBody(id: unknown, contact: { nativeBody: unknown; instanceIndex: number }): PhysicsBody | null;
            _getComWorld(body: PhysicsBody, nativeBody: unknown): { x: number; y: number; z: number };
            _resolveContacts(deltaTime: number, gravity: { x: number; y: number; z: number }): void;
            characterStrength: number;
            characterMass: number;
            onTriggerCollisionObservable: CharacterCollisionObservable;
        }
        const controller = Object.create(PhysicsCharacterController.prototype) as MutableController;
        controller._world = world;
        controller._velocity = { x: 0, y: 0, z: 0 };
        controller._manifold = [
            {
                position: { x: 3, y: 8, z: 0 },
                normal: { x: 1, y: 0, z: 0 },
                distance: 0,
                fraction: 0,
                body,
                nativeBody: firstHandle,
                instanceIndex: 0,
                allowedPenetration: 0,
            },
        ];
        controller.characterStrength = 1;
        controller.characterMass = 1;
        controller.onTriggerCollisionObservable = new CharacterCollisionObservable();
        const collision = vi.fn();
        controller.onTriggerCollisionObservable.add(collision);

        const resolvedFirst = { nativeBody: null, instanceIndex: -1 };
        expect(controller._findBody(firstHandle[0], resolvedFirst)).toBe(body);
        expect(resolvedFirst).toEqual({ nativeBody: firstHandle, instanceIndex: 0 });
        const resolvedSecond = { nativeBody: null, instanceIndex: -1 };
        expect(controller._findBody(secondHandle[0], resolvedSecond)).toBe(body);
        expect(resolvedSecond).toEqual({ nativeBody: secondHandle, instanceIndex: 1 });
        expect(controller._getComWorld(body, firstHandle)).toEqual({ x: 3, y: 8, z: 0 });
        controller._resolveContacts(1 / 60, { x: 0, y: 0, z: 0 });

        expect(collision).toHaveBeenCalledWith(expect.objectContaining({ collider: body, colliderIndex: 0 }));
        expect(getLinearVelocity).toHaveBeenCalledWith(firstHandle);
        expect(applyImpulse).toHaveBeenCalledTimes(1);
        expect(applyImpulse).toHaveBeenCalledWith(firstHandle, [3, 8, 0], expect.any(Array));
        expect(applyImpulse).not.toHaveBeenCalledWith(secondHandle, expect.anything(), expect.anything());
    });

    it("drops tracked instance handles and contacts on controller disposal", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.ANIMATED);
        const instanceHandle = world._thin!.resolve(2)![1] as object;
        interface DisposableController {
            _world: typeof world;
            _body: PhysicsBody;
            _shape: PhysicsShape;
            _startCollector: unknown;
            _castCollector: unknown;
            _bodyTracking: WeakMap<object, { prev: number[]; frameId: number }>;
            _manifold: unknown[];
            dispose(): void;
        }
        const controller = Object.create(PhysicsCharacterController.prototype) as DisposableController;
        controller._world = world;
        controller._body = body;
        controller._shape = { _hkShape: ["shape"], _type: PhysicsShapeType.CAPSULE };
        controller._startCollector = ["start"];
        controller._castCollector = ["cast"];
        controller._bodyTracking = new WeakMap([[instanceHandle, { prev: new Array(16), frameId: 1 }]]);
        controller._manifold = [{ body, nativeBody: instanceHandle }];

        controller.dispose();

        expect(controller._bodyTracking.has(instanceHandle)).toBe(false);
        expect(controller._manifold).toHaveLength(0);
    });
});
