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

describe("Matrix statics", () => {
    it("Invert returns a new inverse and leaves the source alone", () => {
        const source = Matrix.FromValues(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1);
        const before = Array.from(source.m);

        const inverse = Matrix.Invert(source);

        expect(inverse).not.toBe(source);
        expect(Array.from(source.m)).toEqual(before);
        expect(Array.from(inverse.m)).toEqual([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, -0.5, -1, -1.5, 1]);
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
