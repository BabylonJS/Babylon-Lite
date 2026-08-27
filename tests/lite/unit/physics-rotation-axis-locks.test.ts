import { describe, expect, it, vi } from "vitest";

import { lockPhysicsBodyRotationAxes, type PhysicsBody, type PhysicsWorld } from "../../../packages/babylon-lite/src/physics/havok";

function makeWorld(getMassProperties: ReturnType<typeof vi.fn>) {
    const setMassProperties = vi.fn();
    const world = {
        _hknp: {
            Result: { RESULT_OK: 7 },
            HP_Body_GetMassProperties: getMassProperties,
            HP_Body_SetMassProperties: setMassProperties,
        },
    } as unknown as PhysicsWorld;
    const body = { _hkBody: "body" } as unknown as PhysicsBody;
    return { world, body, setMassProperties };
}

describe("physics body rotation axis locks", () => {
    it("zeros selected body-local inertia axes while preserving the other mass properties", () => {
        const sourceInertia = [4, 5, 6];
        const massProperties = [[1, 2, 3], 12, sourceInertia, [0.1, 0.2, 0.3, 0.9]];
        const getMassProperties = vi.fn(() => [7, massProperties]);
        const { world, body, setMassProperties } = makeWorld(getMassProperties);

        lockPhysicsBodyRotationAxes(world, body, ["x", "z"]);

        expect(getMassProperties).toHaveBeenCalledWith("body");
        expect(setMassProperties).toHaveBeenCalledWith("body", [[1, 2, 3], 12, [0, 5, 0], [0, 0, 0, 1]]);
        expect(sourceInertia).toEqual([4, 5, 6]);
    });

    it("does not query or update Havok when no axes are requested", () => {
        const getMassProperties = vi.fn();
        const { world, body, setMassProperties } = makeWorld(getMassProperties);

        lockPhysicsBodyRotationAxes(world, body, []);

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
        expect(setMassProperties).not.toHaveBeenCalled();
    });
});
