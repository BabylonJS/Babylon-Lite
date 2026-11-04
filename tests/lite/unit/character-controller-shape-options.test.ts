import { describe, expect, it, vi } from "vitest";

import {
    getPhysicsCharacterControllerBody,
    PhysicsCharacterController,
    type PhysicsCharacterControllerOptions,
} from "../../../packages/babylon-lite/src/physics/character-controller";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types";
import type { PhysicsBody, PhysicsShape, PhysicsWorld } from "../../../packages/babylon-lite/src/physics/havok";

interface MutableController {
    _world: PhysicsWorld;
    _position: Vec3;
    _shape: PhysicsShape;
    _shapeOptions: PhysicsCharacterControllerOptions;
    _node: { position: { set: ReturnType<typeof vi.fn> } };
    _body: PhysicsBody;
    up: Vec3;
}

function makeController(): {
    cc: PhysicsCharacterController;
    createCapsule: ReturnType<typeof vi.fn>;
    setBodyShape: ReturnType<typeof vi.fn>;
    releaseShape: ReturnType<typeof vi.fn>;
    setNodePosition: ReturnType<typeof vi.fn>;
    oldShape: PhysicsShape;
    body: PhysicsBody;
} {
    const createCapsule = vi.fn(() => [0, "new-shape"]);
    const setBodyShape = vi.fn();
    const releaseShape = vi.fn();
    const setNodePosition = vi.fn();
    const oldShape = { _hkShape: "old-shape" } as unknown as PhysicsShape;
    const body = { _hkBody: "body", _shape: oldShape } as unknown as PhysicsBody;
    const world = {
        _hknp: {
            HP_Shape_CreateCapsule: createCapsule,
            HP_Body_SetShape: setBodyShape,
            HP_Shape_Release: releaseShape,
        },
    } as unknown as PhysicsWorld;

    const raw = Object.create(PhysicsCharacterController.prototype) as MutableController;
    raw._world = world;
    raw._position = { x: 1, y: 2, z: 3 };
    raw._shape = oldShape;
    raw._shapeOptions = { capsuleHeight: 1.8, capsuleRadius: 0.6 };
    raw._node = { position: { set: setNodePosition } };
    raw._body = body;
    raw.up = { x: 0, y: 1, z: 0 };

    return {
        cc: raw as unknown as PhysicsCharacterController,
        createCapsule,
        setBodyShape,
        releaseShape,
        setNodePosition,
        oldShape,
        body,
    };
}

describe("PhysicsCharacterController.setShapeOptions", () => {
    it("exposes its backing body for physics queries", () => {
        const { cc, body } = makeController();

        expect(cc.getBody()).toBe(body);
        expect(getPhysicsCharacterControllerBody(cc)).toBe(body);
    });

    it("rebuilds the capsule and preserves the world-space foot position by default", () => {
        const { cc, createCapsule, setBodyShape, releaseShape, setNodePosition, oldShape, body } = makeController();
        const options = { capsuleHeight: 1.2, capsuleRadius: 0.4 };

        cc.setShapeOptions(options);

        expect(cc.shapeOptions).toBe(options);
        expect(cc.getPosition()).toEqual({ x: 1, y: expect.closeTo(1.7), z: 3 });
        expect(setNodePosition).toHaveBeenCalledWith(1, expect.closeTo(1.7), 3);
        expect(createCapsule).toHaveBeenCalledWith([0, expect.closeTo(0.2), 0], [0, expect.closeTo(-0.2), 0], 0.4);
        expect(setBodyShape).toHaveBeenCalledWith("body", "new-shape");
        expect(body._shape?._hkShape).toBe("new-shape");
        expect(releaseShape).toHaveBeenCalledWith(oldShape._hkShape);
    });

    it("leaves the controller position unchanged when foot preservation is disabled", () => {
        const { cc, setNodePosition } = makeController();

        cc.setShapeOptions({ capsuleHeight: 1.2, capsuleRadius: 0.4 }, false);

        expect(cc.getPosition()).toEqual({ x: 1, y: 2, z: 3 });
        expect(setNodePosition).not.toHaveBeenCalled();
    });
});
