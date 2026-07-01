/**
 * Physics world timestep tests.
 *
 * `createHavokWorld` seeds the world's fixed simulation step (`_fixedDeltaMs`, in milliseconds)
 * from the scene's `fixedDeltaMs`, so physics advances in lockstep with the scene's deterministic
 * clock. `_stepWorld` converts that to seconds for `HP_World_Step`, falling back to the real
 * per-frame delta when the world's step is `0` (frame-delta mode) — mirroring
 * `SceneContext.fixedDeltaMs` (`> 0 ? fixed : real`). {@link setPhysicsTimestepMs} /
 * {@link getPhysicsTimestepMs} let callers read and override the step after creation (with
 * seconds-based {@link setPhysicsTimestep} / {@link getPhysicsTimestep} retained for compatibility).
 *
 * These tests run against a minimal mock of the Havok (`hknp`) backend and a bare scene, so they
 * assert the timestep bookkeeping directly (in milliseconds) and the exact per-step value handed to
 * the native world (in seconds), without a real WASM module or WebGPU device.
 */
import { describe, expect, it, vi } from "vitest";

import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import {
    applyPhysicsBodyForce,
    createHavokWorld,
    getPhysicsTimestep,
    getPhysicsTimestepMs,
    setPhysicsTimestep,
    setPhysicsTimestepMs,
} from "../../../packages/babylon-lite/src/physics/havok";
import type { PhysicsBody } from "../../../packages/babylon-lite/src/physics/havok";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types";

/** A tiny mock of the Havok WASM interface — only what `createHavokWorld` / `_stepWorld` / force touch. */
function makeMockHknp() {
    return {
        HP_World_Create: vi.fn(() => [0, { __world: true }]),
        HP_World_SetGravity: vi.fn(),
        HP_World_Step: vi.fn(),
        HP_World_Release: vi.fn(),
        HP_Body_ApplyImpulse: vi.fn(),
    };
}

/** Minimal scene exposing what the physics code reads: `_beforeRender`, `fixedDeltaMs`, and the
 *  `surface.engine._currentDelta` used as the real per-frame delta fallback. */
function makeScene(fixedDeltaMs = 0, engineCurrentDelta = 0): SceneContext {
    return { _beforeRender: [], fixedDeltaMs, surface: { engine: { _currentDelta: engineCurrentDelta } } } as unknown as SceneContext;
}

/** Invoke every registered before-render callback with `deltaMs`, as the render loop would each frame. */
function stepFrame(scene: SceneContext, deltaMs: number): void {
    for (const cb of [...scene._beforeRender]) {
        cb(deltaMs);
    }
}

/** The seconds value handed to the native `HP_World_Step` on its most recent call. */
function lastStepSeconds(hknp: ReturnType<typeof makeMockHknp>): number {
    const calls = hknp.HP_World_Step.mock.calls;
    return calls[calls.length - 1]![1] as number;
}

describe("physics world timestep", () => {
    it("seeds the world's fixed delta from the scene's fixedDeltaMs", () => {
        const hknp = makeMockHknp();
        const scene = makeScene(1000 / 60);

        const world = createHavokWorld(scene, hknp);

        // The accessor reports the scene's step (in milliseconds).
        expect(getPhysicsTimestepMs(world)).toBe(1000 / 60);
    });

    it("steps the native world at the scene's fixed delta (converted to seconds)", () => {
        const hknp = makeMockHknp();
        const scene = makeScene(1000 / 60);
        createHavokWorld(scene, hknp);

        // The scene feeds its fixed delta to before-render callbacks; a mismatched frame delta
        // must be ignored because the world has a fixed step configured.
        stepFrame(scene, 1000 / 60);

        expect(hknp.HP_World_Step).toHaveBeenCalledTimes(1);
        expect(lastStepSeconds(hknp)).toBeCloseTo(1 / 60, 10);
    });

    it("falls back to the real frame delta when the scene's fixedDeltaMs is 0", () => {
        const hknp = makeMockHknp();
        const scene = makeScene(0);
        const world = createHavokWorld(scene, hknp);

        expect(getPhysicsTimestepMs(world)).toBe(0);

        // With no fixed step, the world advances by whatever per-frame delta it is given.
        stepFrame(scene, 20);

        expect(lastStepSeconds(hknp)).toBeCloseTo(20 / 1000, 10);
    });

    it("can be overridden via setPhysicsTimestepMs after creation", () => {
        const hknp = makeMockHknp();
        const scene = makeScene(1000 / 60);
        const world = createHavokWorld(scene, hknp);

        // Override the scene-seeded step with a coarser 30 fps step.
        setPhysicsTimestepMs(world, 1000 / 30);
        expect(getPhysicsTimestepMs(world)).toBe(1000 / 30);

        // Even though the frame is driven with the scene's 1/60 delta, the world uses its override.
        stepFrame(scene, 1000 / 60);
        expect(lastStepSeconds(hknp)).toBeCloseTo(1 / 30, 10);
    });

    it("exposes a seconds-based accessor (setPhysicsTimestep / getPhysicsTimestep)", () => {
        const hknp = makeMockHknp();
        const scene = makeScene(1000 / 60);
        const world = createHavokWorld(scene, hknp);

        // The seconds API writes the same underlying millisecond step…
        setPhysicsTimestep(world, 1 / 30);
        expect(getPhysicsTimestep(world)).toBeCloseTo(1 / 30, 10); // seconds view
        expect(getPhysicsTimestepMs(world)).toBeCloseTo(1000 / 30, 10); // milliseconds view

        // …and drives the native step identically to the millisecond API.
        stepFrame(scene, 1000 / 60);
        expect(lastStepSeconds(hknp)).toBeCloseTo(1 / 30, 10);
    });

    it("uses the frame delta once the override is cleared back to 0", () => {
        const hknp = makeMockHknp();
        const scene = makeScene(1000 / 60);
        const world = createHavokWorld(scene, hknp);

        setPhysicsTimestepMs(world, 0);
        expect(getPhysicsTimestepMs(world)).toBe(0);

        stepFrame(scene, 25);
        expect(lastStepSeconds(hknp)).toBeCloseTo(25 / 1000, 10);
    });

    it("never steps the native world on a non-finite or non-positive delta", () => {
        const hknp = makeMockHknp();
        const scene = makeScene(0); // frame-delta mode, so the passed delta is used verbatim
        createHavokWorld(scene, hknp);

        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -16]) {
            stepFrame(scene, bad);
        }

        // A NaN dt would poison every body's integration; guard rejects it (and 0 / negative) up front.
        expect(hknp.HP_World_Step).not.toHaveBeenCalled();
    });

    it("clamps an overly large frame delta to the 100ms tunnelling ceiling", () => {
        const hknp = makeMockHknp();
        const scene = makeScene(0);
        createHavokWorld(scene, hknp);

        // A 2-second stall (backgrounded tab / GC pause) must not hand Havok a 2s step.
        stepFrame(scene, 2000);

        expect(lastStepSeconds(hknp)).toBeCloseTo(0.1, 10);
    });
});

describe("applyPhysicsBodyForce timestep selection", () => {
    const FORCE: Vec3 = { x: 10, y: 0, z: 0 };
    const AT: Vec3 = { x: 0, y: 0, z: 0 };

    /** The impulse X component handed to the native `HP_Body_ApplyImpulse` on its most recent call. */
    function lastImpulseX(hknp: ReturnType<typeof makeMockHknp>): number {
        const calls = hknp.HP_Body_ApplyImpulse.mock.calls;
        return (calls[calls.length - 1]![2] as number[])[0]!;
    }

    it("converts force with the world's fixed step (impulse = force × dt)", () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(1000 / 60), hknp);
        const body = { _hkBody: { __body: true }, _world: world } as unknown as PhysicsBody;

        applyPhysicsBodyForce(world, body, FORCE, AT);

        // dt = (1000/60 ms)/1000 = 1/60 s → impulse.x = 10 × 1/60.
        expect(lastImpulseX(hknp)).toBeCloseTo(10 / 60, 10);
    });

    it("falls back to the scene's fixedDeltaMs when the world step is 0", () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(1000 / 30), hknp);
        const body = { _hkBody: { __body: true }, _world: world } as unknown as PhysicsBody;

        setPhysicsTimestepMs(world, 0);
        applyPhysicsBodyForce(world, body, FORCE, AT);

        // world step 0 → scene.fixedDeltaMs (1000/30 ms → 1/30 s) → impulse.x = 10 × 1/30.
        expect(lastImpulseX(hknp)).toBeCloseTo(10 / 30, 10);
    });

    it("falls back to the engine's real frame delta when world and scene fixed steps are 0", () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(0, 20), hknp);
        const body = { _hkBody: { __body: true }, _world: world } as unknown as PhysicsBody;

        applyPhysicsBodyForce(world, body, FORCE, AT);

        // both fixed steps 0 → engine._currentDelta (20 ms → 0.02 s) → impulse.x = 10 × 0.02.
        expect(lastImpulseX(hknp)).toBeCloseTo(10 * 0.02, 10);
    });
});
