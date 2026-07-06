import { describe, expect, it } from "vitest";

import { getPhysicsTimestepMs } from "babylon-lite";
import type { SceneContext } from "babylon-lite";

import { HavokPlugin, PhysicsEngine, PhysicsShapeType, PhysicsMotionType, PhysicsPrestepType, PhysicsConstraintType } from "../src/physics/physics";
import { LiteCompatError } from "../src/error";

// A minimal non-function, non-undefined stand-in for the awaited Havok module.
const fakeHknp = {};

/** A tiny mock of the Havok WASM interface — only what `createHavokWorld` / `_stepWorld` touch. */
function makeMockHknp() {
    const calls: number[] = [];
    return {
        HP_World_Create: () => [0, { __world: true }],
        HP_World_SetGravity: () => undefined,
        HP_World_Step: (_world: unknown, dt: number) => calls.push(dt),
        HP_World_Release: () => undefined,
        /** Seconds handed to the most recent `HP_World_Step` (undefined if never stepped). */
        lastStepSeconds: () => calls[calls.length - 1],
    };
}

/** Minimal scene exposing what the physics step reads: `_beforeRender`, `fixedDeltaMs`, real-delta fallback. */
function makeScene(fixedDeltaMs = 0, engineCurrentDelta = 0): SceneContext {
    return { _beforeRender: [], fixedDeltaMs, surface: { engine: { _currentDelta: engineCurrentDelta } } } as unknown as SceneContext;
}

/** Invoke every registered before-render callback with `deltaMs`, as the render loop would each frame. */
function stepFrame(scene: SceneContext, deltaMs: number): void {
    for (const cb of [...(scene as unknown as { _beforeRender: ((d: number) => void)[] })._beforeRender]) {
        cb(deltaMs);
    }
}

describe("HavokPlugin", () => {
    it("matches the Babylon.js plugin shape", () => {
        const plugin = new HavokPlugin(true, fakeHknp);
        expect(plugin.name).toBe("HavokPlugin");
        expect(plugin.getPluginVersion()).toBe(2);
        expect(plugin.isSupported()).toBe(true);
        expect(plugin._hknp).toBe(fakeHknp);
        expect(plugin.world).toBeNull();
    });

    it("reports unsupported for a still-pending Havok factory or missing module", () => {
        expect(new HavokPlugin(true, () => undefined).isSupported()).toBe(false);
        expect(new HavokPlugin(true).isSupported()).toBe(false);
    });

    it("proxies the fixed timestep getter/setter", () => {
        const plugin = new HavokPlugin(true, fakeHknp);
        expect(plugin.getTimeStep()).toBeCloseTo(1 / 60);
        plugin.setTimeStep(1 / 120);
        expect(plugin.getTimeStep()).toBeCloseTo(1 / 120);
    });

    describe("useDeltaForWorldStep timestep policy (issue #332)", () => {
        it("leaves the world in native frame-delta mode when enabled, so it advances by the elapsed frame time", () => {
            const hknp = makeMockHknp();
            const plugin = new HavokPlugin(true, hknp);
            const scene = makeScene();
            plugin._attachToLiteScene(scene);

            // Delta stepping = no world-level fixed step; Lite steps by the live per-frame delta.
            expect(getPhysicsTimestepMs(plugin.world!)).toBe(0);

            stepFrame(scene, 1000 / 60);
            expect(hknp.lastStepSeconds()).toBeCloseTo(1 / 60, 10);
            stepFrame(scene, 1000 / 144);
            expect(hknp.lastStepSeconds()).toBeCloseTo(1 / 144, 10);
            // A long stall is clamped by Lite's tunnelling ceiling (100ms).
            stepFrame(scene, 5000);
            expect(hknp.lastStepSeconds()).toBeCloseTo(0.1, 10);
        });

        it("does not disable native delta stepping when setTimeStep is called in delta mode", () => {
            const hknp = makeMockHknp();
            const plugin = new HavokPlugin(true, hknp);
            const scene = makeScene();
            plugin._attachToLiteScene(scene);

            // Babylon.js keeps delta stepping active; setTimeStep only records the fallback fixed step.
            plugin.setTimeStep(1 / 90);
            expect(plugin.getTimeStep()).toBeCloseTo(1 / 90);
            expect(getPhysicsTimestepMs(plugin.world!)).toBe(0);

            stepFrame(scene, 1000 / 144);
            expect(hknp.lastStepSeconds()).toBeCloseTo(1 / 144, 10);
        });

        it("pins the world to the fixed timestep when disabled", () => {
            const hknp = makeMockHknp();
            const plugin = new HavokPlugin(false, hknp);
            const scene = makeScene(1000 / 60);
            plugin._attachToLiteScene(scene);

            // Fixed stepping = the world uses _fixedTimeStep regardless of the frame delta.
            expect(getPhysicsTimestepMs(plugin.world!)).toBeCloseTo(1000 / 60, 10);
            stepFrame(scene, 1000 / 144);
            expect(hknp.lastStepSeconds()).toBeCloseTo(1 / 60, 10);

            // A later setTimeStep re-pins the world's fixed step.
            plugin.setTimeStep(1 / 90);
            expect(getPhysicsTimestepMs(plugin.world!)).toBeCloseTo(1000 / 90, 10);
            stepFrame(scene, 1000 / 144);
            expect(hknp.lastStepSeconds()).toBeCloseTo(1 / 90, 10);
        });
    });

    it("throws on manual executeStep (Lite drives stepping)", () => {
        const plugin = new HavokPlugin(true, fakeHknp);
        expect(() => plugin.executeStep()).toThrow(LiteCompatError);
        expect(() => plugin.executeStep()).toThrow(/executeStep/);
    });

    it("setGravity/setTimeStep/dispose are safe before attach", () => {
        const plugin = new HavokPlugin(true, fakeHknp);
        expect(() => plugin.setGravity({ x: 0, y: -9.81, z: 0 })).not.toThrow();
        expect(() => plugin.setTimeStep(1 / 50)).not.toThrow();
        expect(() => plugin.dispose()).not.toThrow();
        expect(plugin.world).toBeNull();
    });
});

describe("PhysicsEngine", () => {
    it("exposes the active plugin, gravity, version and timestep", () => {
        const plugin = new HavokPlugin(true, fakeHknp);
        const engine = new PhysicsEngine(plugin, { x: 0, y: -9.81, z: 0 });
        expect(engine.getPhysicsPlugin()).toBe(plugin);
        expect(engine.getPluginVersion()).toBe(2);
        expect(engine.gravity.y).toBeCloseTo(-9.81);
        engine.setGravity({ x: 0, y: -3.7, z: 0 });
        expect(engine.gravity.y).toBeCloseTo(-3.7);
        engine.setTimeStep(1 / 120);
        expect(engine.getTimeStep()).toBeCloseTo(1 / 120);
        expect(() => engine.dispose()).not.toThrow();
    });
});

describe("Physics enums match Babylon.js values", () => {
    it("PhysicsShapeType", () => {
        expect(PhysicsShapeType.SPHERE).toBe(0);
        expect(PhysicsShapeType.CAPSULE).toBe(1);
        expect(PhysicsShapeType.CYLINDER).toBe(2);
        expect(PhysicsShapeType.BOX).toBe(3);
        expect(PhysicsShapeType.CONVEX_HULL).toBe(4);
        expect(PhysicsShapeType.CONTAINER).toBe(5);
        expect(PhysicsShapeType.MESH).toBe(6);
        expect(PhysicsShapeType.HEIGHTFIELD).toBe(7);
    });

    it("PhysicsMotionType", () => {
        expect(PhysicsMotionType.STATIC).toBe(0);
        expect(PhysicsMotionType.ANIMATED).toBe(1);
        expect(PhysicsMotionType.DYNAMIC).toBe(2);
    });

    it("PhysicsPrestepType", () => {
        expect(PhysicsPrestepType.DISABLED).toBe(0);
        expect(PhysicsPrestepType.TELEPORT).toBe(1);
        expect(PhysicsPrestepType.ACTION).toBe(2);
    });

    it("PhysicsConstraintType", () => {
        expect(PhysicsConstraintType.BALL_AND_SOCKET).toBe(1);
        expect(PhysicsConstraintType.SIX_DOF).toBe(7);
    });
});
