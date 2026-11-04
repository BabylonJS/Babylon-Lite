import { describe, expect, it } from "vitest";
import { createTransformNode } from "babylon-lite";

import { AbstractMesh, Mesh, TransformNode } from "../src/meshes/meshes";
import { Vector3 } from "../src/math/vector";

function createMesh(name: string, min: [number, number, number], max: [number, number, number], vertexCount = 1): Mesh {
    const lite = createTransformNode(name) as ReturnType<typeof createTransformNode> & {
        boundMin: [number, number, number];
        boundMax: [number, number, number];
        _cpuPositions: Float32Array;
    };
    lite.boundMin = min;
    lite.boundMax = max;
    lite._cpuPositions = new Float32Array(vertexCount * 3);
    return new Mesh(name, lite as never);
}

describe("Node.getHierarchyBoundingVectors", () => {
    it("includes a transformed mesh receiver in world space", () => {
        const mesh = createMesh("root", [-1, -1, -1], [1, 1, 1]);
        mesh.position = new Vector3(3, 4, 5);
        mesh.scaling = new Vector3(2, 1, 3);
        mesh.rotation = new Vector3(0, 0, Math.PI / 2);

        const bounds = mesh.getHierarchyBoundingVectors();

        expect(bounds.min.x).toBeCloseTo(2);
        expect(bounds.min.y).toBeCloseTo(2);
        expect(bounds.min.z).toBeCloseTo(2);
        expect(bounds.max.x).toBeCloseTo(4);
        expect(bounds.max.y).toBeCloseTo(6);
        expect(bounds.max.z).toBeCloseTo(8);
    });

    it("unions nested descendant bounds across parent transforms", () => {
        const root = new TransformNode("root");
        const group = new TransformNode("group");
        const left = createMesh("left", [-1, -1, -1], [1, 1, 1]);
        const right = createMesh("right", [0, 0, 0], [2, 2, 2]);
        group.parent = root;
        left.parent = group;
        right.parent = root;
        root.position = new Vector3(10, 0, 0);
        group.position = new Vector3(0, 2, 0);
        group.scaling = new Vector3(2, 1, 1);
        left.position = new Vector3(1, 0, 0);
        right.position = new Vector3(-4, 0, 0);

        const bounds = root.getHierarchyBoundingVectors();

        expect(bounds.min.asArray()).toEqual([6, 0, -1]);
        expect(bounds.max.asArray()).toEqual([14, 3, 2]);
    });

    it("excludes descendants when requested", () => {
        const root = createMesh("root", [-1, -1, -1], [1, 1, 1]);
        const child = createMesh("child", [-2, -2, -2], [2, 2, 2]);
        root.position = new Vector3(5, 0, 0);
        child.parent = root;
        child.position = new Vector3(10, 0, 0);

        const bounds = root.getHierarchyBoundingVectors(false);

        expect(bounds.min.asArray()).toEqual([4, -1, -1]);
        expect(bounds.max.asArray()).toEqual([6, 1, 1]);
    });

    it("filters descendants without filtering the mesh receiver", () => {
        const root = createMesh("root", [-1, -1, -1], [1, 1, 1]);
        const group = new TransformNode("group");
        const included = createMesh("included", [0, 0, 0], [2, 2, 2]);
        const excluded = createMesh("excluded", [-5, -5, -5], [5, 5, 5]);
        group.parent = root;
        included.parent = group;
        excluded.parent = root;
        included.position = new Vector3(4, 0, 0);
        const visited: string[] = [];

        const predicate = (mesh: AbstractMesh): boolean => {
            visited.push(mesh.name);
            return mesh === included;
        };
        const bounds = root.getHierarchyBoundingVectors(true, predicate);

        expect(visited).toEqual(["group", "included", "excluded"]);
        expect(bounds.min.asArray()).toEqual([-1, -1, -1]);
        expect(bounds.max.asArray()).toEqual([6, 2, 2]);
    });

    it("skips geometry-less descendants and preserves empty extrema", () => {
        const root = new TransformNode("root");
        const group = new TransformNode("group");
        const emptyMesh = createMesh("empty", [-100, -100, -100], [100, 100, 100], 0);
        group.parent = root;
        emptyMesh.parent = group;

        const bounds = root.getHierarchyBoundingVectors();

        expect(bounds.min.asArray()).toEqual([Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]);
        expect(bounds.max.asArray()).toEqual([-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE]);
    });
});
