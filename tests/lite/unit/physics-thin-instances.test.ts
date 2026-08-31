import { describe, expect, it, vi } from "vitest";

import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { CharacterCollisionObservable, PhysicsCharacterController } from "../../../packages/babylon-lite/src/physics/character-controller";
import { onPhysicsCollision } from "../../../packages/babylon-lite/src/physics/havok-collision";
import {
    createHavokWorld,
    createPhysicsBody,
    disposePhysics,
    enableHavokThinInstancePhysics,
    getPhysicsBodyInstanceCount,
    PhysicsMotionType,
    PhysicsShapeType,
    setPhysicsBodyMass,
    setPhysicsBodyShape,
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
        HP_Body_SetQTransform: vi.fn((body: number[], transform: [number[], number[]]) => {
            transforms.set(body[0]!, transform);
        }),
        HP_Body_GetQTransform: vi.fn((body: number[]) => [0, transforms.get(body[0]!)!]),
        HP_Body_SetShape: vi.fn(),
        HP_Body_GetShape: vi.fn(() => [0, ["shape"]]),
        HP_Shape_BuildMassProperties: vi.fn(() => [0, [[0, 0, 0], 1, [1, 1, 1], [0, 0, 0, 1]]]),
        HP_Body_SetMassProperties: vi.fn(),
        HP_Body_Release: vi.fn(),
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

        expect(getPhysicsBodyInstanceCount(body)).toBe(2);
        expect(hknp.HP_Body_Create).toHaveBeenCalledTimes(2);
        expect(hknp.HP_World_AddBody).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_SetQTransform.mock.calls.map((call) => call[1])).toEqual([
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
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        const received = vi.fn();

        onPhysicsCollision(world, received);
        world._afterStep![0]!(1 / 60);

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
        interface MutableController {
            _manifold: unknown[];
            _velocity: { x: number; y: number; z: number };
            _world: typeof world;
            _findBody(id: unknown): { body: PhysicsBody; nativeBody: unknown; instanceIndex: number } | null;
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
                nativeBody: body._hkBodies![1],
                instanceIndex: 1,
                allowedPenetration: 0,
            },
        ];
        controller.characterStrength = 1;
        controller.characterMass = 1;
        controller.onTriggerCollisionObservable = new CharacterCollisionObservable();
        const collision = vi.fn();
        controller.onTriggerCollisionObservable.add(collision);

        expect(controller._findBody(body._hkBodies![1][0])).toEqual({ body, nativeBody: body._hkBodies![1], instanceIndex: 1 });
        expect(controller._getComWorld(body, body._hkBodies![0])).toEqual({ x: 3, y: 8, z: 0 });
        controller._resolveContacts(1 / 60, { x: 0, y: 0, z: 0 });

        expect(collision).toHaveBeenCalledWith(expect.objectContaining({ collider: body, colliderIndex: 1 }));
        expect(getLinearVelocity).toHaveBeenCalledWith(body._hkBodies![1]);
        expect(applyImpulse).toHaveBeenCalledWith(body._hkBodies![1], [3, 8, 0], expect.any(Array));
        expect(applyImpulse).not.toHaveBeenCalledWith(body._hkBodies![0], expect.anything(), expect.anything());
    });
});
