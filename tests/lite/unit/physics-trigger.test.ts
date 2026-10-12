import { describe, expect, it, vi } from "vitest";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { createHavokWorld, onPhysicsAfterStep, type PhysicsBody, type PhysicsWorld } from "../../../packages/babylon-lite/src/physics/havok";
import { onPhysicsTrigger, onPhysicsTriggerBodies } from "../../../packages/babylon-lite/src/physics/havok-trigger";

function makeWorld(events: ReadonlyArray<{ type: number; bodyA: number; bodyB: number }>, bodies: PhysicsBody[] = []) {
    const memory = new ArrayBuffer(256);
    const addresses = events.map((event, index) => {
        const address = 16 + index * 32;
        const data = new Int32Array(memory, address, 8);
        data[0] = event.type;
        data[2] = event.bodyA;
        data[6] = event.bodyB;
        return address;
    });
    const next = new Map(addresses.map((address, index) => [address, addresses[index + 1] ?? 0]));
    return {
        _hknp: {
            HEAPU8: new Uint8Array(memory),
            HP_World_GetTriggerEvents: vi.fn(() => [0, addresses[0] ?? 0]),
            HP_World_GetNextTriggerEvent: vi.fn((_world, address: number) => next.get(address) ?? 0),
        },
        _hkWorld: {},
        _bodies: bodies,
        _afterStep: [],
    } as unknown as PhysicsWorld;
}

describe("Havok trigger events", () => {
    it("reports entered and exited events, skips unknown events, and supports disposal", () => {
        const world = makeWorld([
            { type: 8, bodyA: 1, bodyB: 2 },
            { type: 99, bodyA: 3, bodyB: 4 },
            { type: 16, bodyA: 5, bodyB: 6 },
        ]);
        const received = vi.fn();

        const dispose = onPhysicsTrigger(world, received);
        world._afterStep![0]!(1 / 60);

        expect(received.mock.calls.map(([event]) => event)).toEqual([{ type: "ENTERED" }, { type: "EXITED" }]);
        dispose();
        dispose();
        expect(world._afterStep).toHaveLength(0);
    });

    it("resolves participating bodies and returns null for bodies no longer tracked", () => {
        const bodyA = { _hkBody: [101n] } as PhysicsBody;
        const bodyB = { _hkBody: [202] } as PhysicsBody;
        const world = makeWorld(
            [
                { type: 8, bodyA: 101, bodyB: 202 },
                { type: 16, bodyA: 101, bodyB: 303 },
            ],
            [bodyA, bodyB]
        );
        const received = vi.fn();

        onPhysicsTriggerBodies(world, received);
        world._afterStep![0]!(1 / 60);

        expect(received.mock.calls.map(([event]) => event)).toEqual([
            { type: "ENTERED", bodyA, bodyAIndex: 0, bodyB, bodyBIndex: 0 },
            { type: "EXITED", bodyA, bodyAIndex: 0, bodyB: null, bodyBIndex: -1 },
        ]);
    });

    it("does not skip later after-step callbacks when a trigger subscription disposes itself", () => {
        const triggerWorld = makeWorld([{ type: 8, bodyA: 1, bodyB: 2 }]);
        const hknp = Object.assign(triggerWorld._hknp, {
            HP_World_Create: vi.fn(() => [0, {}]),
            HP_World_SetGravity: vi.fn(),
            HP_World_Step: vi.fn(),
        });
        const scene = { _beforeRender: [], fixedDeltaMs: 0, surface: { engine: { _currentDelta: 16 } } } as unknown as SceneContext;
        const world = createHavokWorld(scene, hknp);
        const calls: string[] = [];
        let dispose = (): void => undefined;
        dispose = onPhysicsTrigger(world, () => {
            calls.push("trigger");
            dispose();
        });
        onPhysicsAfterStep(world, () => calls.push("other"));

        scene._beforeRender[0]!(16);

        expect(calls).toEqual(["trigger", "other"]);
        expect(world._afterStep).toHaveLength(1);
    });
});
