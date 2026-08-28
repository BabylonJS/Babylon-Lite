import { describe, expect, it, vi } from "vitest";

import {
    lockPhysicsBodyRotationAxes,
    setPhysicsBodyMass,
    setPhysicsBodyMassProperties,
    unlockPhysicsBodyRotationAxes,
    type PhysicsBody,
    type PhysicsWorld,
} from "../../../packages/babylon-lite/src/physics/havok";

function makeWorld(getMassProperties: ReturnType<typeof vi.fn>, shapeMassProperties?: unknown[]) {
    const setMassProperties = vi.fn();
    const world = {
        _hknp: {
            Result: { RESULT_OK: 7 },
            HP_Body_GetMassProperties: getMassProperties,
            HP_Body_SetMassProperties: setMassProperties,
            HP_Body_GetShape: vi.fn(() => [7, "shape"]),
            HP_Shape_BuildMassProperties: vi.fn(() => [7, shapeMassProperties?.map((value) => (Array.isArray(value) ? [...value] : value))]),
        },
    } as unknown as PhysicsWorld;
    const body = { _hkBody: "body", _shape: shapeMassProperties ? ({} as never) : undefined } as unknown as PhysicsBody;
    return { world, body, setMassProperties };
}

function inertiaTensor(inertia: number[], q: number[]): number[][] {
    const [x, y, z, w] = q;
    const rotation = [
        [1 - 2 * (y! * y! + z! * z!), 2 * (x! * y! - z! * w!), 2 * (x! * z! + y! * w!)],
        [2 * (x! * y! + z! * w!), 1 - 2 * (x! * x! + z! * z!), 2 * (y! * z! - x! * w!)],
        [2 * (x! * z! - y! * w!), 2 * (y! * z! + x! * w!), 1 - 2 * (x! * x! + y! * y!)],
    ];
    return rotation.map((row) => rotation.map((other) => row.reduce((sum, value, j) => sum + value * inertia[j]! * other[j]!, 0)));
}

describe("physics body rotation axis locks", () => {
    it("converts a rotated principal inertia frame before locking body-local axes", () => {
        const sourceInertia = [4, 5, 6];
        const massProperties = [[1, 2, 3], 12, sourceInertia, [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)]];
        const getMassProperties = vi.fn(() => [7, massProperties]);
        const { world, body, setMassProperties } = makeWorld(getMassProperties);

        lockPhysicsBodyRotationAxes(world, body, ["x"]);

        expect(getMassProperties).toHaveBeenCalledWith("body");
        expect(setMassProperties).toHaveBeenCalledWith("body", [[1, 2, 3], 12, [0, expect.closeTo(4.5), 6], [0, 0, 0, 1]]);
        expect(sourceInertia).toEqual([4, 5, 6]);
    });

    it.each([
        ["x", 0, 1, 2],
        ["y", 1, 0, 2],
        ["z", 2, 0, 1],
    ] as const)("preserves free-plane inertia coupling for a single %s-axis lock", (axis, lockedAxis, freeAxisA, freeAxisB) => {
        const orientation = [0.2, 0.3, 0.1, Math.sqrt(0.86)];
        const inertia = [4, 8, 16];
        const getMassProperties = vi.fn(() => [7, [[0, 0, 0], 1, inertia, orientation]]);
        const { world, body, setMassProperties } = makeWorld(getMassProperties);

        lockPhysicsBodyRotationAxes(world, body, [axis]);

        const locked = setMassProperties.mock.calls[0]![1];
        const sourceTensor = inertiaTensor(inertia, orientation);
        const lockedTensor = inertiaTensor(locked[2], locked[3]);
        expect(lockedTensor[lockedAxis]).toEqual([expect.closeTo(0), expect.closeTo(0), expect.closeTo(0)]);
        expect(lockedTensor[freeAxisA]![freeAxisA]).toBeCloseTo(sourceTensor[freeAxisA]![freeAxisA]!);
        expect(lockedTensor[freeAxisA]![freeAxisB]).toBeCloseTo(sourceTensor[freeAxisA]![freeAxisB]!);
        expect(lockedTensor[freeAxisB]![freeAxisA]).toBeCloseTo(sourceTensor[freeAxisB]![freeAxisA]!);
        expect(lockedTensor[freeAxisB]![freeAxisB]).toBeCloseTo(sourceTensor[freeAxisB]![freeAxisB]!);
    });

    it("accumulates and reapplies active locks when mass properties are rebuilt", () => {
        const orientation = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
        const getMassProperties = vi.fn(() => [7, [[1, 2, 3], 12, [4, 8, 16], orientation]]);
        const { world, body, setMassProperties } = makeWorld(getMassProperties, [[4, 5, 6], 9, [4, 8, 16], orientation]);

        lockPhysicsBodyRotationAxes(world, body, ["x"]);
        lockPhysicsBodyRotationAxes(world, body, ["z"]);
        setMassProperties.mockClear();

        setPhysicsBodyMass(world, body, 12);
        expect(setMassProperties).toHaveBeenLastCalledWith("body", [[4, 5, 6], 12, [0, expect.closeTo(6), 0], [0, 0, 0, 1]]);

        setPhysicsBodyMassProperties(world, body, { centerOfMass: { x: 7, y: 8, z: 9 } });
        expect(setMassProperties).toHaveBeenLastCalledWith("body", [[7, 8, 9], 9, [0, expect.closeTo(6), 0], [0, 0, 0, 1]]);

        unlockPhysicsBodyRotationAxes(world, body, ["x"]);
        expect(body._rotationLockMask).toBe(4);

        unlockPhysicsBodyRotationAxes(world, body, ["z"]);
        expect(setMassProperties).toHaveBeenLastCalledWith("body", [[7, 8, 9], 9, [4, 8, 16], orientation]);
        expect(body._rotationLockMask).toBeUndefined();
        expect(body._massPropertiesTransform).toBeUndefined();
    });

    it("does not query or update Havok when no axes are requested", () => {
        const getMassProperties = vi.fn();
        const { world, body, setMassProperties } = makeWorld(getMassProperties);

        lockPhysicsBodyRotationAxes(world, body, []);

        expect(getMassProperties).not.toHaveBeenCalled();
        expect(setMassProperties).not.toHaveBeenCalled();
    });

    it("does not query or update Havok when requested axes are already locked", () => {
        const getMassProperties = vi.fn(() => [7, [[0, 0, 0], 1, [1, 2, 3], [0, 0, 0, 1]]]);
        const { world, body, setMassProperties } = makeWorld(getMassProperties);

        lockPhysicsBodyRotationAxes(world, body, ["x", "z"]);
        getMassProperties.mockClear();
        setMassProperties.mockClear();

        lockPhysicsBodyRotationAxes(world, body, ["x"]);

        expect(getMassProperties).not.toHaveBeenCalled();
        expect(setMassProperties).not.toHaveBeenCalled();
    });

    it("does not update Havok when unlocking an axis that is not locked", () => {
        const getMassProperties = vi.fn();
        const { world, body, setMassProperties } = makeWorld(getMassProperties);

        unlockPhysicsBodyRotationAxes(world, body, ["x"]);

        expect(getMassProperties).not.toHaveBeenCalled();
        expect(setMassProperties).not.toHaveBeenCalled();
    });

    it("reports a failed Havok mass-properties read", () => {
        const getMassProperties = vi.fn(() => [3, null]);
        const { world, body, setMassProperties } = makeWorld(getMassProperties);

        expect(() => lockPhysicsBodyRotationAxes(world, body, ["y"])).toThrow("Failed to read physics body mass properties.");
        expect(setMassProperties).not.toHaveBeenCalled();
    });

    it("rejects an unknown axis supplied by untyped JavaScript", () => {
        const getMassProperties = vi.fn(() => [7, [[0, 0, 0], 1, [1, 2, 3], [0, 0, 0, 1]]]);
        const { world, body, setMassProperties } = makeWorld(getMassProperties);

        expect(() => lockPhysicsBodyRotationAxes(world, body, ["w" as never])).toThrow('Unknown physics rotation axis "w".');
        expect(getMassProperties).not.toHaveBeenCalled();
        expect(setMassProperties).not.toHaveBeenCalled();
    });
});
