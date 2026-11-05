import { describe, expect, it } from "vitest";

import { createTransformNode } from "babylon-lite";

import { TransformNode } from "../src/meshes/meshes";
import { Quaternion } from "../src/math/quaternion";
import { Vector3 } from "../src/math/vector";

/** Compare orientations rather than quaternion signs (q and -q are equivalent). */
function expectRotation(node: TransformNode, expected: Quaternion): void {
    const actual = node._node.rotationQuaternion;
    const dot = Math.abs(actual.x * expected.x + actual.y * expected.y + actual.z * expected.z + actual.w * expected.w);
    expect(dot).toBeCloseTo(1, 6);
}

describe("TransformNode Babylon.js rotation parity", () => {
    it.each([
        [0, 0.7, 0],
        [0.3, 0, 0.4],
        [0.3, 0.5, 0],
        [Math.PI / 2, Math.PI / 2, 0],
        [-0.6, 0.8, -0.3],
    ])("uses yaw-pitch-roll for rotation = (%s, %s, %s)", (x, y, z) => {
        const node = new TransformNode("euler");
        node.rotation = new Vector3(x, y, z);
        expectRotation(node, Quaternion.FromEulerAngles(x, y, z));
    });

    it("keeps the same live Vector3 and converts component edits and inherited methods", () => {
        const node = new TransformNode("live");
        const rotation = node.rotation;
        expect(rotation).toBe(node.rotation);
        expect(rotation).toBeInstanceOf(Vector3);

        rotation.x = 0.3;
        rotation.y = 0.5;
        rotation.z = -0.2;
        expectRotation(node, Quaternion.FromEulerAngles(0.3, 0.5, -0.2));

        rotation.y += 0.25;
        expectRotation(node, Quaternion.FromEulerAngles(0.3, 0.75, -0.2));

        rotation.set(-0.25, 0.4, 0.6);
        expectRotation(node, Quaternion.FromEulerAngles(-0.25, 0.4, 0.6));
    });

    it("round-trips Babylon.js Euler angles, including after quaternion writes from Lite", () => {
        const node = new TransformNode("external");
        node.rotation = new Vector3(0.3, 0.5, -0.2);
        expect(node.rotation.asArray()).toEqual([0.3, 0.5, -0.2]);

        const external = Quaternion.FromEulerAngles(-0.4, 0.2, 0.7);
        node._node.rotationQuaternion.set(external.x, external.y, external.z, external.w);
        const angles = node.rotation;
        expect(angles.x).toBeCloseTo(-0.4, 6);
        expect(angles.y).toBeCloseTo(0.2, 6);
        expect(angles.z).toBeCloseTo(0.7, 6);

        angles.x += 0.1;
        expectRotation(node, Quaternion.FromEulerAngles(-0.3, 0.2, 0.7));
    });

    it("does not let rotation edits override an explicit rotationQuaternion", () => {
        const node = new TransformNode("quat-mode");
        node.rotation.set(0.1, 0.2, 0.3);
        const live = node.rotation;

        const explicit = Quaternion.FromEulerAngles(-0.6, 0.7, -0.2);
        node.rotationQuaternion = explicit;
        expect(node.rotationQuaternion).not.toBeNull();
        expectRotation(node, explicit);

        live.set(0.5, -0.4, 0.3);
        node.rotation = new Vector3(-0.3, 0.2, 0.8);
        expectRotation(node, explicit);

        node.rotationQuaternion = null;
        expect(node.rotationQuaternion).toBeNull();
        expectRotation(node, Quaternion.FromEulerAngles(-0.3, 0.2, 0.8));
    });

    it("keeps Euler state independent while the underlying quaternion is edited in quaternion mode", () => {
        const node = new TransformNode("independent");
        node.rotation = new Vector3(0.1, 0.2, 0.3);
        node.rotationQuaternion = Quaternion.Identity();

        const other = Quaternion.FromEulerAngles(0.8, 0.9, 0.1);
        node._node.rotationQuaternion.set(other.x, other.y, other.z, other.w);
        expect(node.rotation.asArray()).toEqual([0.1, 0.2, 0.3]);
        node.rotationQuaternion = null;
        expectRotation(node, Quaternion.FromEulerAngles(0.1, 0.2, 0.3));
    });

    it("derives Babylon.js Euler angles from a pre-rotated loaded Lite node", () => {
        const expected = Quaternion.FromEulerAngles(0.3, 0.5, 0);
        const lite = createTransformNode("loaded", 0, 0, 0, expected.x, expected.y, expected.z, expected.w);
        const node = new TransformNode("wrapped", undefined, lite);

        expect(node.rotation.x).toBeCloseTo(0.3, 6);
        expect(node.rotation.y).toBeCloseTo(0.5, 6);
        expect(node.rotation.z).toBeCloseTo(0, 6);
        expectRotation(node, expected);
    });
});
