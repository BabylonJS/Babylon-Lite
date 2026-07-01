/**
 * Physics world dispose / no-leak tests.
 *
 * `createHavokWorld` registers a per-frame step callback on `scene._beforeRender`,
 * and feature modules (e.g. `onPhysicsCollision`) register collision-event drains on
 * `world._afterStep`. Both read the native Havok world, so `disposePhysics` MUST tear
 * them down *before* releasing the world — otherwise a still-registered callback keeps
 * a reference to (and steps) a freed world, which is both a leak and a use-after-free
 * in the Havok WASM heap.
 *
 * These tests run against a minimal mock of the Havok (`hknp`) backend and a bare
 * scene, so they exercise the registration/teardown bookkeeping directly without a
 * real WASM module or WebGPU device. They assert that after dispose:
 *   - the per-frame step callback is removed from the scene,
 *   - the collision / after-step callbacks are cleared,
 *   - stepping the scene again never calls back into the released native world,
 *   - the native world is released exactly once and bodies are cleared,
 *   - the world holds no lingering teardown closures (`_stopStep`).
 */
import { describe, expect, it, vi } from "vitest";

import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { createHavokWorld, disposePhysics } from "../../../packages/babylon-lite/src/physics/havok";
import { onPhysicsCollision, setPhysicsBodyCollisionEventsEnabled } from "../../../packages/babylon-lite/src/physics/havok-collision";
import type { PhysicsBody, PhysicsWorld } from "../../../packages/babylon-lite/src/physics/havok";

/** A tiny mock of the Havok WASM interface, tracking every native world call as a spy. */
function makeMockHknp() {
    return {
        HP_World_Create: vi.fn(() => [0, { __world: true }]),
        HP_World_SetGravity: vi.fn(),
        HP_World_Step: vi.fn(),
        HP_World_RemoveBody: vi.fn(),
        HP_Body_Release: vi.fn(),
        HP_World_Release: vi.fn(),
        HP_Body_SetEventMask: vi.fn(),
        // Collision drain reads events from the native world each step; return "no events".
        HP_World_GetCollisionEvents: vi.fn(() => [0, 0]),
        HP_World_GetNextCollisionEvent: vi.fn(() => 0),
        EventType: {
            COLLISION_STARTED: { value: 1 },
            COLLISION_CONTINUED: { value: 2 },
            COLLISION_FINISHED: { value: 4 },
        },
    };
}

/** Minimal scene exposing only what `createHavokWorld` touches: the `_beforeRender` list. */
function makeScene(): SceneContext {
    return { _beforeRender: [] } as unknown as SceneContext;
}

/** Invoke every registered before-render callback, as the render loop would each frame. */
function stepFrame(scene: SceneContext, deltaMs = 16): void {
    for (const cb of [...scene._beforeRender]) {
        cb(deltaMs);
    }
}

describe("physics world dispose", () => {
    it("registers a per-frame step on creation and removes it on dispose", () => {
        const hknp = makeMockHknp();
        const scene = makeScene();

        expect(scene._beforeRender).toHaveLength(0);
        const world = createHavokWorld(scene, hknp);
        expect(scene._beforeRender).toHaveLength(1);
        expect(world._stopStep).toBeTypeOf("function");

        disposePhysics(world);

        expect(scene._beforeRender).toHaveLength(0);
        expect(world._stopStep).toBeUndefined();
    });

    it("clears collision / after-step callbacks on dispose", () => {
        const hknp = makeMockHknp();
        const scene = makeScene();
        const world = createHavokWorld(scene, hknp);

        const body = { _hkBody: { __body: true } } as unknown as PhysicsBody;
        setPhysicsBodyCollisionEventsEnabled(world, body, true);
        onPhysicsCollision(world, () => {});
        expect(world._afterStep).toHaveLength(1);

        disposePhysics(world);

        expect(world._afterStep).toBeUndefined();
    });

    it("never steps or reads the native world after dispose (no use-after-free)", () => {
        const hknp = makeMockHknp();
        const scene = makeScene();
        const world = createHavokWorld(scene, hknp);
        onPhysicsCollision(world, () => {});

        // While alive, stepping drives the native step and the collision drain.
        stepFrame(scene);
        expect(hknp.HP_World_Step).toHaveBeenCalledTimes(1);
        expect(hknp.HP_World_GetCollisionEvents).toHaveBeenCalledTimes(1);

        disposePhysics(world);
        hknp.HP_World_Step.mockClear();
        hknp.HP_World_GetCollisionEvents.mockClear();

        // After dispose the scene has no physics callbacks left, so a frame must not
        // touch the released world in any way.
        stepFrame(scene);
        expect(hknp.HP_World_Step).not.toHaveBeenCalled();
        expect(hknp.HP_World_GetCollisionEvents).not.toHaveBeenCalled();
    });

    it("releases the native world once and clears all bodies on dispose", () => {
        const hknp = makeMockHknp();
        const scene = makeScene();
        const world = createHavokWorld(scene, hknp);

        const bodyA = { _hkBody: { id: "a" } } as unknown as PhysicsBody;
        const bodyB = { _hkBody: { id: "b" } } as unknown as PhysicsBody;
        (world._bodies as PhysicsBody[]).push(bodyA, bodyB);

        disposePhysics(world);

        expect(hknp.HP_World_Release).toHaveBeenCalledTimes(1);
        expect(hknp.HP_Body_Release).toHaveBeenCalledTimes(2);
        expect(world._bodies).toHaveLength(0);
    });

    it("leaves no lingering references on the world after dispose", () => {
        const hknp = makeMockHknp();
        const scene = makeScene();
        const world: PhysicsWorld = createHavokWorld(scene, hknp);
        onPhysicsCollision(world, () => {});

        disposePhysics(world);

        expect(world._stopStep).toBeUndefined();
        expect(world._afterStep).toBeUndefined();
        expect(world._bodies).toHaveLength(0);
        expect(scene._beforeRender).toHaveLength(0);
    });
});
