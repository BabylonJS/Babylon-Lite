import { describe, expect, it, vi } from "vitest";

import { getPhysicsTimestepMs } from "babylon-lite";
import type { SceneContext } from "babylon-lite";

import {
    HavokPlugin,
    PhysicsAggregate,
    PhysicsBody,
    PhysicsEngine,
    PhysicsShape,
    PhysicsShapeType,
    PhysicsMotionType,
    PhysicsPrestepType,
    PhysicsConstraintType,
} from "../src/physics/physics";
import type { TransformNode } from "../src/meshes/meshes";
import { Vector3 } from "../src/math/vector";
import type { Scene } from "../src/scene/scene";
import { LiteCompatError } from "../src/error";
import { Observable } from "../src/misc/observable";

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

function makeAggregateMockHknp() {
    return {
        ...makeMockHknp(),
        MotionType: { STATIC: 0, KINEMATIC: 1, DYNAMIC: 2 },
        MaterialCombine: { MINIMUM: 0, MAXIMUM: 1 },
        HP_Shape_CreateSphere: vi.fn(() => [0, { __shape: true }]),
        HP_Shape_CreateBox: vi.fn(() => [0, { __shape: true }]),
        HP_Shape_CreateCapsule: vi.fn(() => [0, { __shape: true }]),
        HP_Shape_CreateCylinder: vi.fn(() => [0, { __shape: true }]),
        HP_Shape_SetMaterial: vi.fn(),
        HP_Shape_SetTrigger: vi.fn(),
        HP_Shape_Release: vi.fn(),
        HP_Body_Create: vi.fn(() => [0, { __body: true }]),
        HP_Body_SetMotionType: () => undefined,
        HP_Body_SetQTransform: () => undefined,
        HP_Body_SetShape: () => undefined,
        HP_Body_GetLinearVelocity: () => [0, [4, 5, 6]],
        HP_Body_GetAngularVelocity: () => [0, [1, 2, 3]],
        HP_Body_Release: vi.fn(),
        HP_World_AddBody: () => undefined,
        HP_World_RemoveBody: () => undefined,
    };
}

function makePhysicsNode(scene: Scene, overrides: Record<string, unknown> = {}): TransformNode {
    const onDisposeObservable = new Observable<TransformNode>();
    const node = {
        parent: null,
        physicsBody: null,
        onDisposeObservable,
        _node: {
            position: { x: 0, y: 0, z: 0 },
            rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
            scaling: { x: 1, y: 1, z: 1 },
            ...overrides,
        },
        getScene: () => scene,
        dispose: () => {
            onDisposeObservable.notifyObservers(node as unknown as TransformNode);
            onDisposeObservable.clear();
        },
    };
    return node as unknown as TransformNode;
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

    describe("PhysicsBody", () => {
        it("translates motion and prestep enums at the Lite boundary", () => {
            const plugin = new HavokPlugin(true, makeAggregateMockHknp());
            plugin._attachToLiteScene(makeScene());
            const physicsEngine = new PhysicsEngine(plugin, { x: 0, y: -9.81, z: 0 });
            const scene = { getPhysicsEngine: () => physicsEngine } as unknown as Scene;
            const node = makePhysicsNode(scene);
            const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);

            expect(body.getMotionType()).toBe(PhysicsMotionType.STATIC);
            body.setMotionType(PhysicsMotionType.ANIMATED);
            expect(body.getMotionType()).toBe(PhysicsMotionType.ANIMATED);
            body.setMotionType(PhysicsMotionType.DYNAMIC);
            expect(body.getMotionType()).toBe(PhysicsMotionType.DYNAMIC);

            body.setPrestepType(PhysicsPrestepType.DISABLED);
            expect(body.getPrestepType()).toBe(PhysicsPrestepType.DISABLED);
            body.setPrestepType(PhysicsPrestepType.TELEPORT);
            expect(body.getPrestepType()).toBe(PhysicsPrestepType.TELEPORT);
            body.setPrestepType(PhysicsPrestepType.ACTION);
            expect(body.getPrestepType()).toBe(PhysicsPrestepType.ACTION);

            body.disablePreStep = true;
            expect(body.getPrestepType()).toBe(PhysicsPrestepType.DISABLED);
            body.disablePreStep = false;
            expect(body.getPrestepType()).toBe(PhysicsPrestepType.TELEPORT);
            expect(() => {
                body.disableSync = true;
            }).toThrow(/always synchronizes dynamic bodies/);
            expect(() => {
                body.disableSync = false;
            }).not.toThrow();
        });

        it("rejects invalid motion and prestep enum values at the Lite boundary", () => {
            const plugin = new HavokPlugin(true, makeAggregateMockHknp());
            plugin._attachToLiteScene(makeScene());
            const physicsEngine = new PhysicsEngine(plugin, { x: 0, y: -9.81, z: 0 });
            const scene = { getPhysicsEngine: () => physicsEngine } as unknown as Scene;
            const node = makePhysicsNode(scene);
            const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);

            expect(() => body.setMotionType(99 as PhysicsMotionType)).toThrow("Invalid PhysicsMotionType value: 99");
            expect(() => body.setPrestepType(98 as PhysicsPrestepType)).toThrow("Invalid PhysicsPrestepType value: 98");

            (body._lite as unknown as { motionType: number }).motionType = 97;
            expect(() => body.getMotionType()).toThrow("Invalid Lite PhysicsMotionType value: 97");
            (body._lite as unknown as { _prestepType: number })._prestepType = 96;
            expect(() => body.getPrestepType()).toThrow("Invalid Lite PhysicsPrestepType value: 96");
        });

        it("reads velocities through Lite without allocating in to-ref methods", () => {
            const plugin = new HavokPlugin(true, makeAggregateMockHknp());
            plugin._attachToLiteScene(makeScene());
            const physicsEngine = new PhysicsEngine(plugin, { x: 0, y: -9.81, z: 0 });
            const scene = { getPhysicsEngine: () => physicsEngine } as unknown as Scene;
            const node = makePhysicsNode(scene);
            const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);

            expect(body.getLinearVelocity()).toEqual({ x: 4, y: 5, z: 6 });
            const allocatingLinearGetter = vi.spyOn(body, "getLinearVelocity");
            const linearResult = new Vector3();
            body.getLinearVelocityToRef(linearResult);
            expect(linearResult).toEqual({ x: 4, y: 5, z: 6 });
            expect(allocatingLinearGetter).not.toHaveBeenCalled();

            expect(body.getAngularVelocity()).toEqual({ x: 1, y: 2, z: 3 });
            const allocatingAngularGetter = vi.spyOn(body, "getAngularVelocity");
            const angularResult = new Vector3();
            body.getAngularVelocityToRef(angularResult);
            expect(angularResult).toEqual({ x: 1, y: 2, z: 3 });
            expect(allocatingAngularGetter).not.toHaveBeenCalled();
        });

        it("attaches to the TransformNode and is disposed with it", () => {
            const hknp = makeAggregateMockHknp();
            const plugin = new HavokPlugin(true, hknp);
            plugin._attachToLiteScene(makeScene());
            const scene = { getPhysicsEngine: () => new PhysicsEngine(plugin, Vector3.Zero()) } as unknown as Scene;
            const node = makePhysicsNode(scene);
            const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);

            expect(node.physicsBody).toBe(body);
            node.dispose();
            expect(node.physicsBody).toBeNull();
            expect(hknp.HP_Body_Release).toHaveBeenCalledOnce();
            expect(() => body.dispose()).not.toThrow();
        });

        it("fails before allocation for parented nodes and thin instances", () => {
            const hknp = makeAggregateMockHknp();
            const plugin = new HavokPlugin(true, hknp);
            plugin._attachToLiteScene(makeScene());
            const scene = { getPhysicsEngine: () => new PhysicsEngine(plugin, Vector3.Zero()) } as unknown as Scene;
            const parented = makePhysicsNode(scene);
            parented.parent = {} as TransformNode;
            const thin = makePhysicsNode(scene, { thinInstances: { count: 2 } });

            expect(() => new PhysicsBody(parented, PhysicsMotionType.STATIC, false, scene)).toThrow(/parented TransformNodes/);
            expect(() => new PhysicsBody(thin, PhysicsMotionType.STATIC, false, scene)).toThrow(/per-thin-instance/);
            expect(hknp.HP_Body_Create).not.toHaveBeenCalled();
        });
    });

    describe("PhysicsAggregate", () => {
        it("forwards aggregate construction and disposal to Babylon Lite", () => {
            const hknp = makeAggregateMockHknp();
            const plugin = new HavokPlugin(true, hknp);
            plugin._attachToLiteScene(makeScene());
            const physicsEngine = new PhysicsEngine(plugin, { x: 0, y: -9.81, z: 0 });
            const scene = { getPhysicsEngine: () => physicsEngine } as unknown as Scene;
            const node = makePhysicsNode(scene, {
                position: { x: 1, y: 2, z: 3 },
                boundMin: [-1, -1, -1],
                boundMax: [1, 1, 1],
            });

            const aggregate = new PhysicsAggregate(node, PhysicsShapeType.BOX, { mass: 0 }, scene);

            expect(aggregate.body.getClassName()).toBe("PhysicsBody");
            expect(aggregate.shape.getClassName()).toBe("PhysicsShape");
            expect(aggregate.body.shape).toBe(aggregate.shape);
            expect(aggregate.shape.type).toBe(PhysicsShapeType.BOX);
            expect(node.physicsBody).toBe(aggregate.body);
            node.dispose();
            expect(node.physicsBody).toBeNull();
            expect(hknp.HP_Body_Release).toHaveBeenCalledOnce();
            expect(hknp.HP_Shape_Release).toHaveBeenCalledOnce();
            expect(() => aggregate.dispose()).not.toThrow();
        });

        it("does not dispose a caller-owned shape", () => {
            const hknp = makeAggregateMockHknp();
            const plugin = new HavokPlugin(true, hknp);
            plugin._attachToLiteScene(makeScene());
            const physicsEngine = new PhysicsEngine(plugin, { x: 0, y: -9.81, z: 0 });
            const scene = { getPhysicsEngine: () => physicsEngine } as unknown as Scene;
            const node = makePhysicsNode(scene);
            const shape = new PhysicsShape({ type: PhysicsShapeType.BOX, parameters: { extents: { x: 1, y: 1, z: 1 } } }, scene);

            const aggregate = new PhysicsAggregate(node, shape, { mass: 0 }, scene);
            aggregate.dispose();

            expect(hknp.HP_Shape_Release).not.toHaveBeenCalled();
            shape.dispose();
            expect(hknp.HP_Shape_Release).toHaveBeenCalledOnce();
        });

        it("uses Babylon.js material defaults, preserves trigger state, and forwards static friction", () => {
            const hknp = makeAggregateMockHknp();
            const plugin = new HavokPlugin(true, hknp);
            plugin._attachToLiteScene(makeScene());
            const scene = { getPhysicsEngine: () => new PhysicsEngine(plugin, Vector3.Zero()) } as unknown as Scene;
            const shape = new PhysicsShape({ type: PhysicsShapeType.BOX, parameters: { extents: { x: 1, y: 1, z: 1 } } }, scene);

            shape.material = {};
            expect(hknp.HP_Shape_SetMaterial.mock.calls.at(-1)?.[1]).toEqual([0.5, 0.5, 0, 0, 1]);
            shape.isTrigger = true;
            hknp.HP_Shape_SetTrigger.mockClear();

            const aggregate = new PhysicsAggregate(makePhysicsNode(scene), shape, {
                mass: 0,
                friction: 0.4,
                staticFriction: 0.8,
                restitution: 0.1,
            });
            expect(hknp.HP_Shape_SetMaterial.mock.calls.at(-1)?.[1]).toEqual([0.8, 0.4, 0.1, 0, 1]);
            expect(hknp.HP_Shape_SetTrigger).not.toHaveBeenCalled();
            aggregate.dispose();
            shape.dispose();
        });

        it("matches Babylon.js scaled primitive aggregate sizing", () => {
            const hknp = makeAggregateMockHknp();
            const plugin = new HavokPlugin(true, hknp);
            plugin._attachToLiteScene(makeScene());
            const scene = { getPhysicsEngine: () => new PhysicsEngine(plugin, Vector3.Zero()) } as unknown as Scene;
            const bounds = {
                boundMin: [-1, -2, -3],
                boundMax: [3, 4, 5],
                scaling: { x: -2, y: 3, z: 0.5 },
            };

            new PhysicsAggregate(makePhysicsNode(scene, bounds), PhysicsShapeType.BOX, { mass: 0 });
            expect(hknp.HP_Shape_CreateBox).toHaveBeenLastCalledWith([2, 3, 0.5], [0, 0, 0, 1], [8, 18, 4]);

            new PhysicsAggregate(makePhysicsNode(scene, bounds), PhysicsShapeType.SPHERE, { mass: 0 });
            expect(hknp.HP_Shape_CreateSphere).toHaveBeenLastCalledWith([2, 3, 0.5], 9);

            new PhysicsAggregate(makePhysicsNode(scene, bounds), PhysicsShapeType.CAPSULE, { mass: 0 });
            expect(hknp.HP_Shape_CreateCapsule).toHaveBeenLastCalledWith([0, -2, 0], [0, 8, 0], 4);

            new PhysicsAggregate(makePhysicsNode(scene, bounds), PhysicsShapeType.CYLINDER, { mass: 0 });
            expect(hknp.HP_Shape_CreateCylinder).toHaveBeenLastCalledWith([0, -6, 0], [0, 12, 0], 4);
        });

        it("rejects an invalid shape enum value before calling Lite", () => {
            const plugin = new HavokPlugin(true, makeAggregateMockHknp());
            plugin._attachToLiteScene(makeScene());
            const physicsEngine = new PhysicsEngine(plugin, { x: 0, y: -9.81, z: 0 });
            const scene = { getPhysicsEngine: () => physicsEngine } as unknown as Scene;

            expect(() => new PhysicsShape({ type: 99 as PhysicsShapeType }, scene)).toThrow("Invalid PhysicsShapeType value: 99");

            const shape = new PhysicsShape({ type: PhysicsShapeType.BOX }, scene);
            (shape._lite as unknown as { _type: number })._type = 98;
            expect(() => shape.type).toThrow("Invalid Lite PhysicsShapeType value: 98");
        });
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
