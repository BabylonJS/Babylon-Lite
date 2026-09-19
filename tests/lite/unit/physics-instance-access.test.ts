import { describe, expect, it, vi } from "vitest";

import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import {
    applyPhysicsBodyInstanceImpulse,
    applyPhysicsBodyImpulse,
    createHavokWorld,
    createPhysicsBody,
    enableHavokThinInstancePhysics,
    getPhysicsBodyInstanceLinearVelocityToRef,
    PhysicsMotionType,
    removePhysicsBody,
} from "../../../packages/babylon-lite/src/physics/havok";

function makeScene(): SceneContext {
    return { _beforeRender: [] } as unknown as SceneContext;
}

function makeMesh(count = 2): Mesh {
    const matrices = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) {
        matrices[i * 16] = matrices[i * 16 + 5] = matrices[i * 16 + 10] = matrices[i * 16 + 15] = 1;
    }
    return {
        position: { x: 0, y: 0, z: 0 },
        rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
        worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        worldMatrixVersion: 0,
        thinInstances: {
            matrices,
            count,
            _capacity: count,
            _version: 0,
            _gpuBuffer: null,
            _gpuBufferStorage: false,
            _gpuVersion: 0,
            _dirtyMin: 0,
            _dirtyMax: count,
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

function makeHavok() {
    let nextBody = 1;
    const velocities = new Map<number, number[]>();
    return {
        velocities,
        MotionType: { STATIC: 0, KINEMATIC: 1, DYNAMIC: 2 },
        HP_World_Create: vi.fn(() => [0, ["world"]]),
        HP_World_SetGravity: vi.fn(),
        HP_World_AddBody: vi.fn(),
        HP_World_RemoveBody: vi.fn(),
        HP_World_Release: vi.fn(),
        HP_Body_Create: vi.fn(() => [0, [nextBody++]]),
        HP_Body_SetMotionType: vi.fn(),
        HP_Body_SetQTransform: vi.fn(),
        HP_Body_GetQTransform: vi.fn(() => [
            0,
            [
                [0, 0, 0],
                [0, 0, 0, 1],
            ],
        ]),
        HP_Body_ApplyImpulse: vi.fn(),
        HP_Body_GetLinearVelocity: vi.fn((body: number[]) => [0, velocities.get(body[0]!) ?? [0, 0, 0]]),
        HP_Body_Release: vi.fn(),
    };
}

describe("indexed physics body access", () => {
    it("targets first and last thin instances without broadcasting", async () => {
        const hknp = makeHavok();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeMesh(3), PhysicsMotionType.DYNAMIC);

        applyPhysicsBodyInstanceImpulse(world, body, 0, { x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 });
        applyPhysicsBodyInstanceImpulse(world, body, 2, { x: 7, y: 8, z: 9 }, { x: 10, y: 11, z: 12 });

        expect(hknp.HP_Body_ApplyImpulse).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_ApplyImpulse.mock.calls.map((call) => call[0][0])).toEqual([1, 3]);
        expect(hknp.HP_Body_ApplyImpulse.mock.calls.map((call) => call[2])).toEqual([
            [1, 2, 3],
            [7, 8, 9],
        ]);

        hknp.HP_Body_ApplyImpulse.mockClear();
        applyPhysicsBodyImpulse(body, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        expect(hknp.HP_Body_ApplyImpulse).toHaveBeenCalledTimes(3);
    });

    it("reads independent velocities into caller-owned state", async () => {
        const hknp = makeHavok();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeMesh(), PhysicsMotionType.DYNAMIC);
        hknp.velocities.set(1, [1, 2, 3]);
        hknp.velocities.set(2, [4, 5, 6]);
        const result = { x: 0, y: 0, z: 0 };

        getPhysicsBodyInstanceLinearVelocityToRef(world, body, 1, result);

        expect(result).toEqual({ x: 4, y: 5, z: 6 });
        expect(hknp.HP_Body_GetLinearVelocity).toHaveBeenCalledWith(expect.objectContaining({ 0: 2 }));
    });

    it("supports ordinary index zero and rejects invalid ownership, indices, and lifetime", () => {
        const hknp = makeHavok();
        const world = createHavokWorld(makeScene(), hknp);
        const mesh = makeMesh();
        mesh.thinInstances = undefined;
        const body = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);
        const result = { x: 0, y: 0, z: 0 };

        applyPhysicsBodyInstanceImpulse(world, body, 0, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        getPhysicsBodyInstanceLinearVelocityToRef(world, body, 0, result);
        expect(hknp.HP_Body_ApplyImpulse).toHaveBeenCalledTimes(1);

        for (const index of [-1, 0.5, 1]) {
            expect(() => applyPhysicsBodyInstanceImpulse(world, body, index, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toThrow();
        }

        const foreign = createHavokWorld(makeScene(), makeHavok());
        expect(() => getPhysicsBodyInstanceLinearVelocityToRef(foreign, body, 0, result)).toThrow("does not belong");
        removePhysicsBody(world, body);
        expect(() => getPhysicsBodyInstanceLinearVelocityToRef(world, body, 0, result)).toThrow("removed");
    });
});
