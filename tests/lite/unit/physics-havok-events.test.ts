import { describe, expect, it, vi } from "vitest";

import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { onPhysicsCollision } from "../../../packages/babylon-lite/src/physics/havok-collision";
import { ensureHavokEventContext } from "../../../packages/babylon-lite/src/physics/havok-events";
import {
    createHavokWorld,
    createPhysicsBody,
    disposePhysics,
    enableHavokThinInstancePhysics,
    PhysicsMotionType,
    removePhysicsBody,
} from "../../../packages/babylon-lite/src/physics/havok";

function makeScene(): SceneContext {
    return { _beforeRender: [] } as unknown as SceneContext;
}

function makeNode(): Mesh {
    return {
        position: { x: 0, y: 0, z: 0, set: vi.fn() },
        rotationQuaternion: { x: 0, y: 0, z: 0, w: 1, set: vi.fn() },
    } as unknown as Mesh;
}

function makeThinNode(count = 3): Mesh {
    const matrices = new Float32Array(count * 16);
    for (let index = 0; index < count; index++) {
        const offset = index * 16;
        matrices[offset] = matrices[offset + 5] = matrices[offset + 10] = matrices[offset + 15] = 1;
        matrices[offset + 12] = index;
    }
    return {
        ...makeNode(),
        _gpu: {},
        _cpuPositions: new Float32Array(),
        worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        worldMatrixVersion: 0,
        thinInstances: {
            matrices,
            count,
            _capacity: count,
            _version: 1,
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

function makeHknp() {
    let nextBodyId = 1;
    return {
        MotionType: { STATIC: 0, KINEMATIC: 1, DYNAMIC: 2 },
        Result: { RESULT_OK: 0 },
        EventType: {
            COLLISION_STARTED: { value: 1 },
            COLLISION_CONTINUED: { value: 2 },
            COLLISION_FINISHED: { value: 4 },
        },
        HEAPU8: new Uint8Array(1024),
        HP_World_Create: vi.fn(() => [0, ["world"]]),
        HP_World_SetGravity: vi.fn(),
        HP_World_AddBody: vi.fn(),
        HP_World_RemoveBody: vi.fn(),
        HP_World_Step: vi.fn(),
        HP_World_Release: vi.fn(),
        HP_World_GetCollisionEvents: vi.fn(() => [0, 0]),
        HP_World_GetNextCollisionEvent: vi.fn((_world: unknown, _address: number) => 0),
        HP_Body_Create: vi.fn(() => [0, [nextBodyId++]]),
        HP_Body_SetMotionType: vi.fn(),
        HP_Body_SetQTransform: vi.fn(),
        HP_Body_GetQTransform: vi.fn(() => [
            0,
            [
                [0, 0, 0],
                [0, 0, 0, 1],
            ],
        ]),
        HP_Body_Release: vi.fn(),
        HP_Shape_Release: vi.fn(),
        HP_QueryCollector_Release: vi.fn(),
    };
}

function step(scene: SceneContext): void {
    for (const callback of [...scene._beforeRender]) {
        callback(1000 / 60);
    }
}

function installCollisionStream(hknp: ReturnType<typeof makeHknp>, events: { type: number; bodyA: number; bodyB: number; pointX: number }[]): void {
    const addresses = events.map((_, index) => 16 + index * 160);
    const memory = new ArrayBuffer(16 + events.length * 160);
    for (let index = 0; index < events.length; index++) {
        const event = events[index]!;
        const address = addresses[index]!;
        const ints = new Int32Array(memory, address);
        const floats = new Float32Array(memory, address);
        ints[0] = event.type;
        ints[2] = event.bodyA;
        ints[18] = event.bodyB;
        floats[10] = event.pointX;
        floats[11] = 2;
        floats[12] = 3;
        floats[13] = 0;
        floats[14] = 1;
        floats[15] = 0;
        floats[26] = event.pointX;
        floats[27] = 2;
        floats[28] = 3;
        floats[34] = 4;
    }
    hknp.HEAPU8 = new Uint8Array(memory);
    hknp.HP_World_GetCollisionEvents.mockImplementation(() => [0, addresses[0] ?? 0]);
    hknp.HP_World_GetNextCollisionEvent.mockImplementation((_world, address) => {
        const index = addresses.indexOf(address);
        return index >= 0 ? (addresses[index + 1] ?? 0) : 0;
    });
}

describe("Havok body-aware event indexing", () => {
    it("resolves cached ordinary and first, middle, and last thin identities without scanning either body collection", async () => {
        const hknp = makeHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const thinBody = createPhysicsBody(world, makeThinNode(), PhysicsMotionType.STATIC);
        const ordinaryBody = createPhysicsBody(world, makeNode(), PhysicsMotionType.STATIC);
        const events = ensureHavokEventContext(world);
        const thinScan = vi.spyOn(world._thin!, "resolve").mockImplementation(() => {
            throw new Error("event resolution must not scan thin bodies");
        });
        const first = events.resolve(1);
        const middle = events.resolve(2);
        const last = events.resolve(3);
        const ordinary = events.resolve(4);

        expect(first).toEqual([thinBody, expect.any(Array), 0]);
        expect(middle).toEqual([thinBody, expect.any(Array), 1]);
        expect(last).toEqual([thinBody, expect.any(Array), 2]);
        expect(ordinary).toEqual([ordinaryBody, ordinaryBody._hkBody, 0]);
        expect(events.resolve(1)).toBe(first);
        expect(events.resolve(4)).toBe(ordinary);
        expect(events.resolve(999)).toBeNull();
        expect(thinScan).not.toHaveBeenCalled();
    });

    it("indexes bodies created after event enabling and isolates equal native IDs between worlds", () => {
        const firstWorld = createHavokWorld(makeScene(), makeHknp());
        const secondWorld = createHavokWorld(makeScene(), makeHknp());
        const firstEvents = ensureHavokEventContext(firstWorld);
        const secondEvents = ensureHavokEventContext(secondWorld);
        const firstBody = createPhysicsBody(firstWorld, makeNode(), PhysicsMotionType.STATIC);
        const secondBody = createPhysicsBody(secondWorld, makeNode(), PhysicsMotionType.STATIC);

        expect(firstEvents.resolve(1)).toEqual([firstBody, firstBody._hkBody, 0]);
        expect(secondEvents.resolve(1)).toEqual([secondBody, secondBody._hkBody, 0]);

        removePhysicsBody(firstWorld, firstBody);
        expect(firstEvents.resolve(1)).toBeNull();
        expect(secondEvents.resolve(1)?.[0]).toBe(secondBody);
    });

    it("drains every duplicate native event once and notifies every observer in native order", () => {
        const hknp = makeHknp();
        installCollisionStream(hknp, [
            { type: 1, bodyA: 1, bodyB: 2, pointX: 1 },
            { type: 2, bodyA: 1, bodyB: 2, pointX: 2 },
            { type: 2, bodyA: 1, bodyB: 2, pointX: 3 },
            { type: 4, bodyA: 1, bodyB: 2, pointX: 4 },
        ]);
        const scene = makeScene();
        const world = createHavokWorld(scene, hknp);
        createPhysicsBody(world, makeNode(), PhysicsMotionType.STATIC);
        createPhysicsBody(world, makeNode(), PhysicsMotionType.STATIC);
        const first: { type: string; point: { x: number } }[] = [];
        const second: { type: string; point: { x: number } }[] = [];
        onPhysicsCollision(world, (info) => first.push(info));
        onPhysicsCollision(world, (info) => second.push(info));

        step(scene);

        expect(hknp.HP_World_GetCollisionEvents).toHaveBeenCalledTimes(1);
        expect(hknp.HP_World_GetNextCollisionEvent).toHaveBeenCalledTimes(4);
        expect(first.map((info) => [info.type, info.point.x])).toEqual([
            ["STARTED", 1],
            ["CONTINUED", 2],
            ["CONTINUED", 3],
            ["FINISHED", 4],
        ]);
        expect(second.map((info) => [info.type, info.point.x])).toEqual(first.map((info) => [info.type, info.point.x]));
        expect(first[0]).not.toBe(first[1]);
        expect(first[0]!.point).toEqual({ x: 1, y: 2, z: 3 });
    });

    it("keeps removed identities through the current drain and replaces them after native ID reuse", () => {
        const hknp = makeHknp();
        const reusableIds: number[] = [];
        let nextId = 1;
        hknp.HP_Body_Create.mockImplementation(() => [0, [reusableIds.pop() ?? nextId++]]);
        hknp.HP_Body_Release.mockImplementation((handle) => {
            reusableIds.push(Number(handle[0]));
        });
        installCollisionStream(hknp, [
            { type: 1, bodyA: 1, bodyB: 2, pointX: 1 },
            { type: 2, bodyA: 1, bodyB: 2, pointX: 2 },
        ]);
        const scene = makeScene();
        const world = createHavokWorld(scene, hknp);
        const removed = createPhysicsBody(world, makeNode(), PhysicsMotionType.STATIC);
        createPhysicsBody(world, makeNode(), PhysicsMotionType.STATIC);
        const received: { collider: typeof removed }[] = [];
        onPhysicsCollision(world, (info) => {
            received.push(info);
            if (received.length === 1) {
                removePhysicsBody(world, removed);
                expect(hknp.HP_Body_Release).not.toHaveBeenCalled();
            }
        });

        step(scene);

        expect(received).toHaveLength(2);
        expect(received.every((info) => info.collider === removed)).toBe(true);
        expect(hknp.HP_Body_Release).toHaveBeenCalledWith(removed._hkBody);
        const replacement = createPhysicsBody(world, makeNode(), PhysicsMotionType.STATIC);
        expect(world._events!.resolve(1)).toEqual([replacement, replacement._hkBody, 0]);
    });

    it("stops native iteration safely when an observer disposes the world", () => {
        const hknp = makeHknp();
        installCollisionStream(hknp, [
            { type: 1, bodyA: 1, bodyB: 2, pointX: 1 },
            { type: 2, bodyA: 1, bodyB: 2, pointX: 2 },
        ]);
        const scene = makeScene();
        const world = createHavokWorld(scene, hknp);
        createPhysicsBody(world, makeNode(), PhysicsMotionType.STATIC);
        createPhysicsBody(world, makeNode(), PhysicsMotionType.STATIC);
        const received: { point: { x: number } }[] = [];
        onPhysicsCollision(world, (info) => {
            received.push(info);
            disposePhysics(world);
        });

        step(scene);

        expect(received).toHaveLength(1);
        expect(received[0]!.point.x).toBe(1);
        expect(hknp.HP_World_GetNextCollisionEvent).not.toHaveBeenCalled();
        expect(hknp.HP_World_Release).toHaveBeenCalledTimes(1);
    });
});
