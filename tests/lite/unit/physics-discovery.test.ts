import { describe, expect, it, vi } from "vitest";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { PhysicsWorld } from "../../../packages/babylon-lite/src/physics/havok";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import {
    createHavokWorld,
    createPhysicsBody,
    disposePhysics,
    getPhysicsWorlds,
    getPhysicsBodies,
    PhysicsMotionType,
    removePhysicsBody,
} from "../../../packages/babylon-lite/src/physics/havok";

function makeScene(): SceneContext {
    return { _beforeRender: [], _disposables: [] } as unknown as SceneContext;
}

function makeHknp() {
    return {
        MotionType: { STATIC: 0 },
        HP_World_Create: vi.fn(() => [0, {}]),
        HP_World_SetGravity: vi.fn(),
        HP_World_AddBody: vi.fn(),
        HP_World_RemoveBody: vi.fn(),
        HP_World_Release: vi.fn(),
        HP_Body_Create: vi.fn(() => [0, {}]),
        HP_Body_SetMotionType: vi.fn(),
        HP_Body_SetQTransform: vi.fn(),
        HP_Body_Release: vi.fn(),
    };
}

describe("physics discovery", () => {
    it("does not install a list or cleanup on empty queries", () => {
        const scene = makeScene();
        const empty = getPhysicsWorlds(scene);
        expect(empty).toEqual([]);
        expect(scene).not.toHaveProperty("_physicsWorlds");
        expect(scene._disposables).toEqual([]);
        const world = createHavokWorld(scene, makeHknp());
        expect(getPhysicsWorlds(scene)).not.toBe(empty);
        expect(getPhysicsWorlds(scene)).toEqual([world]);
    });

    it("keeps live ordered lists isolated per scene and registers one cleanup", () => {
        const scene = makeScene();
        const other = makeScene();
        const hknp = makeHknp();
        const a = createHavokWorld(scene, hknp);
        const worlds = getPhysicsWorlds(scene);
        const b = createHavokWorld(scene, hknp);
        const c = createHavokWorld(scene, hknp);
        const foreign = createHavokWorld(other, hknp);
        expect(worlds).toBe(getPhysicsWorlds(scene));
        expect(worlds).toEqual([a, b, c]);
        expect(getPhysicsWorlds(other)).toEqual([foreign]);
        expect(scene._disposables).toHaveLength(1);
        disposePhysics(b);
        expect(worlds).toEqual([a, c]);
        expect(() => disposePhysics(b)).not.toThrow();
        expect(worlds).toEqual([a, c]);
        expect(hknp.HP_World_Release).toHaveBeenCalledTimes(1);
    });

    it("unregisters before floating-origin disposal", () => {
        const scene = makeScene();
        const world = createHavokWorld(scene, makeHknp());
        const dispose = vi.fn(() => expect(getPhysicsWorlds(scene)).toEqual([]));
        world._fo = { dispose } as unknown as NonNullable<PhysicsWorld["_fo"]>;
        disposePhysics(world);
        expect(dispose).toHaveBeenCalledWith(world);
    });

    it("clears discovery on scene disposal without releasing worlds or bodies", () => {
        const scene = makeScene();
        const hknp = makeHknp();
        const world = createHavokWorld(scene, hknp);
        const body = createPhysicsBody(world, createTransformNode("body"), PhysicsMotionType.STATIC);
        const worlds = getPhysicsWorlds(scene);
        for (const dispose of scene._disposables) {
            dispose();
        }
        scene._beforeRender.length = 0;
        expect(worlds).toEqual([]);
        expect(getPhysicsBodies(world)).toEqual([body]);
        expect(world._disposed).toBeFalsy();
        expect(hknp.HP_World_Release).not.toHaveBeenCalled();
        expect(() => disposePhysics(world)).not.toThrow();
    });

    it("tracks created bodies live through removal and world disposal", () => {
        const world = createHavokWorld(makeScene(), makeHknp());
        const bodies = getPhysicsBodies(world);
        const a = createPhysicsBody(world, createTransformNode("a"), PhysicsMotionType.STATIC);
        const b = createPhysicsBody(world, createTransformNode("b"), PhysicsMotionType.STATIC);
        expect(bodies).toBe(getPhysicsBodies(world));
        expect(bodies).toEqual([a, b]);
        removePhysicsBody(world, a);
        expect(bodies).toEqual([b]);
        disposePhysics(world);
        expect(bodies).toEqual([]);
    });
});
