import { describe, expect, it, vi } from "vitest";

import { ArcRotateCamera, FreeCamera } from "../src/cameras/cameras";
import { NullEngine } from "../src/engine/engine";
import { Matrix } from "../src/math/matrix";
import { Quaternion } from "../src/math/quaternion";
import { Vector2, Vector3, Vector4 } from "../src/math/vector";
import { MeshBuilder, TransformNode } from "../src/meshes/meshes";
import type { Node } from "../src/node/node";
import { Scene } from "../src/scene/scene";

/** Babylon.js math, camera and scene helpers that compat had not implemented yet. */

function expectSameRotation(actual: Quaternion, expected: Quaternion): void {
    // q and -q are the same rotation.
    const dot = actual.x * expected.x + actual.y * expected.y + actual.z * expected.z + actual.w * expected.w;
    expect(Math.abs(dot)).toBeCloseTo(1, 6);
}

function nodeRotation(node: TransformNode): Quaternion {
    const q = node._node.rotationQuaternion;
    return new Quaternion(q.x, q.y, q.z, q.w);
}

/** The rows of `q`'s rotation matrix: the X, Y and Z axes the rotation maps the basis to. */
function rotatedAxes(q: Quaternion): [Vector3, Vector3, Vector3] {
    const m = q.toRotationMatrix(new Matrix()).m;
    return [new Vector3(m[0]!, m[1]!, m[2]!), new Vector3(m[4]!, m[5]!, m[6]!), new Vector3(m[8]!, m[9]!, m[10]!)];
}

/** A started headless scene that can create meshes (their GPU buffers go to a stub device). */
function startedScene(): Scene {
    const engine = new NullEngine();
    (engine._lite as unknown as { _device: GPUDevice })._device = {
        createBuffer: ({ size }: GPUBufferDescriptor) => {
            const mapped = new ArrayBuffer(Number(size));
            return { getMappedRange: () => mapped, unmap: () => undefined, destroy: () => undefined } as unknown as GPUBuffer;
        },
    } as unknown as GPUDevice;
    const scene = new Scene(engine);
    (scene as unknown as { _flushPendingAdds(): void })._flushPendingAdds();
    return scene;
}

describe("vector dot", () => {
    it("matches the static Dot on Vector2, Vector3 and Vector4", () => {
        expect(new Vector2(1, 2).dot(new Vector2(3, -4))).toBe(-5);
        expect(new Vector3(1, 2, 3).dot(new Vector3(-4, 5, 6))).toBe(Vector3.Dot(new Vector3(1, 2, 3), new Vector3(-4, 5, 6)));
        expect(new Vector4(1, 2, 3, 4).dot(new Vector4(5, 6, 7, 8))).toBe(70);
    });
});

describe("Quaternion.FromEulerVector", () => {
    it("reads pitch, yaw and roll from x, y and z, as FromEulerAngles", () => {
        const vec = new Vector3(0.3, 0.5, -0.2);
        const expected = Quaternion.FromEulerAngles(0.3, 0.5, -0.2);

        expect(Quaternion.FromEulerVector(vec).asArray()).toEqual(expected.asArray());
        const result = new Quaternion();
        expect(Quaternion.FromEulerVectorToRef(vec, result)).toBe(result);
        expect(result.asArray()).toEqual(expected.asArray());
    });

    it("RotationYawPitchRollToRef writes the rotation into the given quaternion", () => {
        const result = new Quaternion(9, 9, 9, 9);

        expect(Quaternion.RotationYawPitchRollToRef(Math.PI / 2, 0, 0, result)).toBe(result);

        const expected = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
        result.asArray().forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 6));
    });
});

describe("Quaternion.RotationQuaternionFromAxis", () => {
    it("returns the rotation that maps the XYZ system onto the given axes", () => {
        // Babylon.js RotationY(π/2) and RotationX(π/2) rows.
        expectSameRotation(
            Quaternion.RotationQuaternionFromAxis(new Vector3(0, 0, -1), new Vector3(0, 1, 0), new Vector3(1, 0, 0)),
            Quaternion.RotationYawPitchRoll(Math.PI / 2, 0, 0)
        );
        expectSameRotation(
            Quaternion.RotationQuaternionFromAxis(new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, -1, 0)),
            Quaternion.RotationYawPitchRoll(0, Math.PI / 2, 0)
        );

        const q = Quaternion.RotationYawPitchRoll(0.3, 0.5, -0.2);
        expectSameRotation(Quaternion.RotationQuaternionFromAxis(...rotatedAxes(q)), q);
    });

    it("normalizes copies of the axes and leaves the axes themselves alone", () => {
        const q = Quaternion.RotationYawPitchRoll(0.3, 0.5, -0.2);
        const axes = rotatedAxes(q).map((axis) => axis.scale(3)) as [Vector3, Vector3, Vector3];
        const before = axes.map((axis) => axis.asArray());
        const ref = new Quaternion();

        expect(Quaternion.RotationQuaternionFromAxisToRef(axes[0], axes[1], axes[2], ref)).toBe(ref);

        expectSameRotation(ref, q);
        expect(axes.map((axis) => axis.asArray())).toEqual(before);
    });
});

describe("TransformNode rotation", () => {
    it("reads a pre-rotated Lite node as Babylon.js Euler angles", () => {
        const liteNode = new TransformNode("source")._node;
        const quaternion = Quaternion.FromEulerAngles(0.3, 0.5, -0.2);
        liteNode.rotationQuaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
        const node = new TransformNode("wrapped", undefined, liteNode);

        expect(node.rotationQuaternion).toBeNull();
        expect(node.rotation.x).toBeCloseTo(0.3, 6);
        expect(node.rotation.y).toBeCloseTo(0.5, 6);
        expect(node.rotation.z).toBeCloseTo(-0.2, 6);
    });

    it("keeps the assigned Euler vector live and composes it with Babylon.js yaw-pitch-roll semantics", () => {
        const node = new TransformNode("node");
        const previous = node.rotation;
        const rotation = new Vector3(0.3, 0.5, -0.2);
        const expected = Quaternion.FromEulerAngles(0.3, 0.5, -0.2);

        node.rotation = rotation;

        expect(node.rotation).toBe(rotation);
        expectSameRotation(nodeRotation(node), expected);

        rotation.y += 0.1;
        expectSameRotation(nodeRotation(node), Quaternion.FromEulerAngles(0.3, 0.6, -0.2));

        previous.set(1, 1, 1);
        expectSameRotation(nodeRotation(node), Quaternion.FromEulerAngles(0.3, 0.6, -0.2));
    });

    it("resynchronizes a retained Euler vector after native quaternion writes", () => {
        const node = new TransformNode("node");
        const rotation = node.rotation;
        const native = Quaternion.FromEulerAngles(0.3, 0.5, -0.2);

        node._node.rotationQuaternion.set(native.x, native.y, native.z, native.w);
        rotation.y += 0.1;

        expect(node.rotation).toBe(rotation);
        expectSameRotation(nodeRotation(node), Quaternion.FromEulerAngles(0.3, 0.6, -0.2));
    });

    it("keeps the assigned quaternion live while Euler writes remain inactive", () => {
        const node = new TransformNode("node");
        const quaternion = Quaternion.FromEulerAngles(-0.4, 0.2, 0.7);

        node.rotation = new Vector3(0.1, 0.2, 0.3);
        node.rotationQuaternion = quaternion;

        expect(node.rotationQuaternion).toBe(quaternion);
        expect(node.rotation.asArray()).toEqual([0, 0, 0]);
        node.rotation.set(0.3, 0.5, 0);
        expectSameRotation(nodeRotation(node), quaternion);

        quaternion.set(0, 0, Math.SQRT1_2, Math.SQRT1_2);
        expect(nodeRotation(node).asArray()).toEqual(quaternion.asArray());

        node.rotationQuaternion = null;
        expectSameRotation(nodeRotation(node), Quaternion.FromEulerAngles(0.3, 0.5, 0));
    });

    it("resynchronizes an assigned quaternion after native writes", () => {
        const node = new TransformNode("node");
        const quaternion = Quaternion.Identity();
        const native = Quaternion.FromEulerAngles(0.3, 0.5, -0.2);
        node.rotationQuaternion = quaternion;

        node._node.rotationQuaternion.set(native.x, native.y, native.z, native.w);
        quaternion.z += 0.1;

        expect(node.rotationQuaternion).toBe(quaternion);
        expect(nodeRotation(node).asArray()).toEqual(quaternion.asArray());
    });

    it("clears rotationQuaternion when the rotation vector is assigned", () => {
        const node = new TransformNode("node");
        node.rotationQuaternion = Quaternion.FromEulerAngles(0.4, -0.2, 0.1);

        node.rotation = new Vector3(-0.3, 0.6, 0.2);

        expect(node.rotationQuaternion).toBeNull();
        expectSameRotation(nodeRotation(node), Quaternion.FromEulerAngles(-0.3, 0.6, 0.2));
    });

    it("keeps an explicit Euler assignment authoritative after a native write", () => {
        const node = new TransformNode("node");
        const native = Quaternion.FromEulerAngles(0.4, -0.2, 0.1);
        const rotation = new Vector3(-0.3, 0.6, 0.2);
        node._node.rotationQuaternion.set(native.x, native.y, native.z, native.w);

        node.rotation = rotation;

        expect(rotation.asArray()).toEqual([-0.3, 0.6, 0.2]);
        expectSameRotation(nodeRotation(node), Quaternion.FromEulerAngles(-0.3, 0.6, 0.2));
    });

    it("restores stored Euler edits when clearing quaternion mode after a native write", () => {
        const node = new TransformNode("node");
        const native = Quaternion.FromEulerAngles(0.4, -0.2, 0.1);
        node.rotationQuaternion = Quaternion.Identity();
        node.rotation.set(-0.3, 0.6, 0.2);
        node._node.rotationQuaternion.set(native.x, native.y, native.z, native.w);

        node.rotationQuaternion = null;

        expect(node.rotation.asArray()).toEqual([-0.3, 0.6, 0.2]);
        expectSameRotation(nodeRotation(node), Quaternion.FromEulerAngles(-0.3, 0.6, 0.2));
    });

    it("copies stored Euler edits when cloning quaternion mode", () => {
        const source = new TransformNode("source");
        source.rotationQuaternion = Quaternion.FromEulerAngles(0.4, -0.2, 0.1);
        source.rotation.set(0.3, 0.5, -0.2);
        const clone = new TransformNode("clone", undefined, source._node);

        clone._copyRotationMode(source);
        clone.rotationQuaternion = null;

        expectSameRotation(nodeRotation(clone), Quaternion.FromEulerAngles(0.3, 0.5, -0.2));
    });

    it("keeps shared Euler bindings active when one node replaces its vector", () => {
        const shared = new Vector3(0.1, 0.2, 0.3);
        const first = new TransformNode("first");
        const second = new TransformNode("second");
        first.rotation = shared;
        second.rotation = shared;

        first.rotation = new Vector3();
        shared.y = 0.6;

        expectSameRotation(nodeRotation(second), Quaternion.FromEulerAngles(0.1, 0.6, 0.3));
    });

    it("keeps shared quaternion bindings active when one node replaces its quaternion", () => {
        const shared = Quaternion.FromEulerAngles(0.1, 0.2, 0.3);
        const first = new TransformNode("first");
        const second = new TransformNode("second");
        first.rotationQuaternion = shared;
        second.rotationQuaternion = shared;

        first.rotationQuaternion = Quaternion.Identity();
        shared.y += 0.1;

        expect(nodeRotation(second).asArray()).toEqual(shared.asArray());
    });

    it("propagates native Euler readback to every node sharing the vector", () => {
        const shared = new Vector3(0.1, 0.2, 0.3);
        const first = new TransformNode("first");
        const second = new TransformNode("second");
        const native = Quaternion.FromEulerAngles(-0.3, 0.6, 0.2);
        first.rotation = shared;
        second.rotation = shared;
        first._node.rotationQuaternion.set(native.x, native.y, native.z, native.w);

        expect(first.rotation).toBe(shared);

        expectSameRotation(nodeRotation(second), native);
    });

    it("propagates native quaternion readback to every node sharing the quaternion", () => {
        const shared = Quaternion.Identity();
        const first = new TransformNode("first");
        const second = new TransformNode("second");
        const native = Quaternion.FromEulerAngles(-0.3, 0.6, 0.2);
        first.rotationQuaternion = shared;
        second.rotationQuaternion = shared;
        first._node.rotationQuaternion.set(native.x, native.y, native.z, native.w);

        expect(first.rotationQuaternion).toBe(shared);

        expectSameRotation(nodeRotation(second), native);
    });

    it("unbinds retained rotation values when disposed", () => {
        const rotation = new Vector3(0.1, 0.2, 0.3);
        const quaternion = Quaternion.FromEulerAngles(0.4, -0.2, 0.1);
        const node = new TransformNode("node");
        node.rotation = rotation;
        node.rotationQuaternion = quaternion;
        const before = nodeRotation(node);

        node.dispose();
        rotation.set(0.7, 0.8, 0.9);
        quaternion.set(0, 0, Math.SQRT1_2, Math.SQRT1_2);

        expectSameRotation(nodeRotation(node), before);
    });

    it("unbinds retained rotation values when the scene is disposed", () => {
        const scene = new Scene(new NullEngine());
        const rotation = new Vector3(0.1, 0.2, 0.3);
        const quaternion = Quaternion.FromEulerAngles(0.4, -0.2, 0.1);
        const node = new TransformNode("node", scene);
        node.rotation = rotation;
        node.rotationQuaternion = quaternion;
        const before = nodeRotation(node);

        scene.dispose();
        rotation.set(0.7, 0.8, 0.9);
        quaternion.set(0, 0, Math.SQRT1_2, Math.SQRT1_2);

        expectSameRotation(nodeRotation(node), before);
    });

    it("replaces the active quaternion when a bake resets rotation", () => {
        class BakeResetNode extends TransformNode {
            public resetAfterBake(): void {
                this._node.rotation.set(0, 0, 0);
                this._resetRotationAfterBake();
            }
        }
        const node = new BakeResetNode("node");
        const original = Quaternion.FromEulerAngles(0.4, -0.2, 0.1);
        node.rotationQuaternion = original;

        node.resetAfterBake();

        expect(node.rotationQuaternion).not.toBe(original);
        expect(node.rotationQuaternion?.asArray()).toEqual([0, 0, 0, 1]);
        expectSameRotation(original, Quaternion.FromEulerAngles(0.4, -0.2, 0.1));
    });
});

describe("Matrix statics", () => {
    it("Invert returns a new inverse and leaves the source alone", () => {
        const source = Matrix.FromValues(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1);
        const before = Array.from(source.m);

        const inverse = Matrix.Invert(source);

        expect(inverse).not.toBe(source);
        expect(Array.from(source.m)).toEqual(before);
        expect(Array.from(inverse.m)).toEqual([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, -0.5, -1, -1.5, 1]);
    });

    it.each([
        ["a zero matrix", () => Matrix.Zero()],
        ["a zero scale", () => Matrix.Scaling(0, 2, 3)],
    ])("inverting %s copies it, as Babylon.js does, and leaves it alone", (_name, create) => {
        const source = create();
        expect(source.determinant()).toBe(0);
        const before = Array.from(source.m);
        const result = Matrix.FromValues(9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9);

        expect(Array.from(Matrix.Invert(source).m)).toEqual(before);
        expect(source.invertToRef(result)).toBe(result);
        expect(Array.from(result.m)).toEqual(before);
        expect(Array.from(source.m)).toEqual(before);
        // In place, a singular matrix stays as it is.
        expect(Array.from(source.invert().m)).toEqual(before);
    });

    it("FromXYZAxesToRef writes the axes as the first three rows", () => {
        const result = Matrix.FromValues(9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9);

        expect(Matrix.FromXYZAxesToRef(new Vector3(1, 2, 3), new Vector3(4, 5, 6), new Vector3(7, 8, 9), result)).toBe(result);

        expect(Array.from(result.m)).toEqual([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 0, 0, 0, 1]);
    });
});

describe("Camera.getDirection", () => {
    it("turns a local axis into the camera's world direction", () => {
        const scene = new Scene(new NullEngine());
        // At alpha 0, beta π/2 the arc-rotate camera sits on +X and looks back at the origin.
        const arc = new ArcRotateCamera("arc", 0, Math.PI / 2, 10, Vector3.Zero(), scene);
        const free = new FreeCamera("free", new Vector3(0, 0, 0), scene);
        free.setTarget(new Vector3(0, 0, -5));

        const forward = arc.getDirection(new Vector3(0, 0, 1));
        expect(forward.x).toBeCloseTo(-1, 6);
        expect(forward.y).toBeCloseTo(0, 6);
        expect(forward.z).toBeCloseTo(0, 6);

        const result = new Vector3();
        free.getDirectionToRef(new Vector3(0, 0, 1), result);
        expect(result.x).toBeCloseTo(0, 6);
        expect(result.y).toBeCloseTo(0, 6);
        expect(result.z).toBeCloseTo(-1, 6);
        // A direction: the camera's translation does not enter it.
        free.position = new Vector3(4, 5, 6);
        free.setTarget(new Vector3(4, 5, 1));
        free.getDirectionToRef(new Vector3(0, 0, 2), result);
        expect(result.z).toBeCloseTo(-2, 6);
        expect(result.x).toBeCloseTo(0, 6);
    });

    it("reads the camera's world matrix without building a view matrix, and takes the axis as its result", () => {
        const scene = new Scene(new NullEngine());
        const free = new FreeCamera("free", new Vector3(4, 5, 6), scene);
        // Off every axis, so each output component mixes all three input ones.
        free.setTarget(new Vector3(5, 7, 9));
        const expected = free.getDirection(new Vector3(1, 2, 3));
        const fromArray = vi.spyOn(Matrix, "FromArray");
        const axis = new Vector3(1, 2, 3);

        free.getDirectionToRef(axis, axis);

        expect(fromArray).not.toHaveBeenCalled();
        fromArray.mockRestore();
        expect(axis.x).toBeCloseTo(expected.x, 6);
        expect(axis.y).toBeCloseTo(expected.y, 6);
        expect(axis.z).toBeCloseTo(expected.z, 6);
        expect(Math.abs(expected.x) > 0.1 && Math.abs(expected.y) > 0.1 && Math.abs(expected.z) > 0.1).toBe(true);
    });
});

describe("TransformNode.getChildTransformNodes", () => {
    it("returns descendant transform nodes and meshes, calling the predicate on every descendant", () => {
        const scene = startedScene();
        const root = new TransformNode("root", scene);
        const pivot = new TransformNode("pivot", scene);
        pivot.parent = root;
        const box = MeshBuilder.CreateBox("box", {}, scene);
        box.parent = pivot;
        const leaf = new TransformNode("leaf", scene);
        leaf.parent = box;

        expect(root.getChildTransformNodes().map((node) => node.name)).toEqual(["pivot", "box", "leaf"]);
        expect(root.getChildTransformNodes(true).map((node) => node.name)).toEqual(["pivot"]);

        const predicate = vi.fn((node: Node) => node.name !== "box");
        expect(root.getChildTransformNodes(false, predicate).map((node) => node.name)).toEqual(["pivot", "leaf"]);
        expect(predicate.mock.calls.map(([node]) => node.name)).toEqual(["pivot", "box", "leaf"]);
    });
});

describe("Scene.getMeshByUniqueId", () => {
    it("finds a scene mesh by its uniqueId, and nothing else", () => {
        const scene = startedScene();
        const box = MeshBuilder.CreateBox("box", {}, scene);
        const node = new TransformNode("node", scene);

        expect(scene.getMeshByUniqueId(box.uniqueId)).toBe(box);
        expect(scene.getMeshByUniqueId(node.uniqueId)).toBeNull();
        expect(scene.getMeshByUniqueId(-1)).toBeNull();
    });
});
