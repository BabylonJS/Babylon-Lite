import { describe, expect, it } from "vitest";

import { HavokPlugin, PhysicsEngine, PhysicsShapeType, PhysicsMotionType, PhysicsPrestepType, PhysicsConstraintType } from "../src/physics/physics";
import { LiteCompatError } from "../src/error";

// A minimal non-function, non-undefined stand-in for the awaited Havok module.
const fakeHknp = {};

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
        it("advances by the elapsed frame time, clamped to 0.1s, when enabled", () => {
            const plugin = new HavokPlugin(true, fakeHknp);
            // 60 Hz frame
            expect(plugin._computeTimestep(1000 / 60)).toBeCloseTo(1 / 60);
            // 120 Hz frame → half the simulated slice per frame (twice as many frames)
            expect(plugin._computeTimestep(1000 / 120)).toBeCloseTo(1 / 120);
            // 144 Hz frame
            expect(plugin._computeTimestep(1000 / 144)).toBeCloseTo(1 / 144);
            // 30 FPS frame → double the slice
            expect(plugin._computeTimestep(1000 / 30)).toBeCloseTo(1 / 30);
            // Long stall is clamped to 100ms
            expect(plugin._computeTimestep(5000)).toBeCloseTo(0.1);
            // Non-positive delta falls back to the fixed step
            expect(plugin._computeTimestep(0)).toBeCloseTo(1 / 60);
            expect(plugin._computeTimestep(-5)).toBeCloseTo(1 / 60);
        });

        it("always uses the fixed timestep when disabled", () => {
            const plugin = new HavokPlugin(false, fakeHknp);
            expect(plugin._computeTimestep(1000 / 60)).toBeCloseTo(1 / 60);
            expect(plugin._computeTimestep(1000 / 144)).toBeCloseTo(1 / 60);
            expect(plugin._computeTimestep(5000)).toBeCloseTo(1 / 60);
            plugin.setTimeStep(1 / 90);
            expect(plugin._computeTimestep(1000 / 144)).toBeCloseTo(1 / 90);
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
