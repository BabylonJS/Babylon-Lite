/**
 * Character-controller timestep-selection tests.
 *
 * `PhysicsCharacterController.moveWithCollisions` converts a requested displacement into a velocity
 * by dividing by the step duration. That duration follows the same delta contract as the rest of the
 * engine: the world's fixed step when set, otherwise the owning scene's current per-frame delta
 * (`scene.fixedDeltaMs`, else the engine's real `_currentDelta`). When no delta is available yet
 * (e.g. the first frame) the move is skipped.
 *
 * These tests exercise only that selection: the controller is built via `Object.create` (bypassing
 * the Havok-heavy constructor) and its collide-and-slide integrator is stubbed, so the assertions
 * read `_lastInvDeltaTime` (`1 / deltaSeconds`) — the value moveWithCollisions derives from the step.
 */
import { describe, expect, it, vi } from "vitest";

import { PhysicsCharacterController } from "../../../packages/babylon-lite/src/physics/character-controller";
import type { PhysicsWorld } from "../../../packages/babylon-lite/src/physics/havok";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types";

/** The private fields `moveWithCollisions` reads/writes, plus the integrator we stub out. */
interface MutableController {
    _world: PhysicsWorld;
    _frameId: number;
    _velocity: Vec3;
    _lastVelocity: Vec3;
    _lastDisplacement: Vec3;
    _lastInvDeltaTime: number;
    _integrateManifolds: (deltaTime: number, gravity: Vec3) => void;
}

/** A world stub exposing only what the timestep selection reads. */
function makeWorld(fixedDeltaMs: number, sceneFixedDeltaMs: number, engineCurrentDelta: number): PhysicsWorld {
    const scene = { fixedDeltaMs: sceneFixedDeltaMs, surface: { engine: { _currentDelta: engineCurrentDelta } } };
    return { _fixedDeltaMs: fixedDeltaMs, _scene: scene } as unknown as PhysicsWorld;
}

/** Build a controller without the Havok constructor and stub the collide-and-slide integrator. */
function makeController(world: PhysicsWorld): { cc: PhysicsCharacterController; integrate: ReturnType<typeof vi.fn> } {
    const integrate = vi.fn();
    const raw = Object.create(PhysicsCharacterController.prototype) as MutableController;
    raw._world = world;
    raw._frameId = 0;
    raw._velocity = { x: 0, y: 0, z: 0 };
    raw._lastVelocity = { x: 0, y: 0, z: 0 };
    raw._lastDisplacement = { x: 0, y: 0, z: 0 };
    raw._lastInvDeltaTime = 60;
    raw._integrateManifolds = integrate;
    return { cc: raw as unknown as PhysicsCharacterController, integrate };
}

const UNIT_X: Vec3 = { x: 1, y: 0, z: 0 };

describe("character controller timestep selection", () => {
    it("uses the world's fixed step when set", () => {
        const { cc, integrate } = makeController(makeWorld(1000 / 30, 1000 / 60, 999));
        cc.moveWithCollisions(UNIT_X);
        // 1000/30 ms → 1/30 s → invDeltaTime 30. Scene / engine deltas are ignored.
        expect(integrate).toHaveBeenCalledWith(1 / 30, expect.anything());
        expect((cc as unknown as MutableController)._lastInvDeltaTime).toBeCloseTo(30, 10);
    });

    it("falls back to the scene's fixedDeltaMs when the world step is 0", () => {
        const { cc } = makeController(makeWorld(0, 1000 / 60, 999));
        cc.moveWithCollisions(UNIT_X);
        // world step 0 → use scene.fixedDeltaMs (1000/60 ms → 1/60 s → invDeltaTime 60).
        expect((cc as unknown as MutableController)._lastInvDeltaTime).toBeCloseTo(60, 10);
    });

    it("falls back to the engine's real frame delta when world and scene fixed steps are 0", () => {
        const { cc } = makeController(makeWorld(0, 0, 20));
        cc.moveWithCollisions(UNIT_X);
        // both fixed steps 0 → use engine._currentDelta (20 ms → 0.02 s → invDeltaTime 50).
        expect((cc as unknown as MutableController)._lastInvDeltaTime).toBeCloseTo(50, 10);
    });

    it("skips the move when no delta is available yet (first frame)", () => {
        const { cc, integrate } = makeController(makeWorld(0, 0, 0));
        cc.moveWithCollisions(UNIT_X);
        // Nothing to integrate against: guard returns before touching the integrator or frame id.
        expect(integrate).not.toHaveBeenCalled();
        expect((cc as unknown as MutableController)._frameId).toBe(0);
    });
});
