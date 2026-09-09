import { describe, expect, it } from "vitest";

import {
    createHierarchyInstancePool,
    addHierarchyInstance,
    removeHierarchyInstance,
    setHierarchyInstanceCount,
    setHierarchyInstanceMatrix,
} from "../../../packages/babylon-lite/src";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import { composeMat4 } from "../../../packages/babylon-lite/src/math/compose-mat4";
import { createIdentityMat4 } from "../../../packages/babylon-lite/src/math/create-identity-mat4";
import { multiplyMat4 } from "../../../packages/babylon-lite/src/math/multiply-mat4";
import { createTranslationMat4 } from "../../../packages/babylon-lite/src/math/create-translation-mat4";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";

function makeMesh(name: string): Mesh {
    const mesh = initMeshTransform({
        name,
        material: {} as Mesh["material"],
        receiveShadows: false,
        _gpu: {} as Mesh["_gpu"],
    });
    return mesh;
}

function readMatrix(data: Float32Array, index: number): Mat4 {
    return data.slice(index * 16, index * 16 + 16) as unknown as Mat4;
}

function expectMatrixClose(actual: Mat4, expected: Mat4): void {
    for (let i = 0; i < 16; i++) {
        expect(actual[i]).toBeCloseTo(expected[i]!, 5);
    }
}

describe("hierarchy instance pool", () => {
    it("initializes descendant meshes as zero-count thin-instanced render carriers", () => {
        const root = createTransformNode("root");
        const mesh = makeMesh("leaf");
        root.children.push(mesh);

        const pool = createHierarchyInstancePool(root, 4);

        expect(pool.root).toBe(root);
        expect(pool.count).toBe(0);
        expect(pool.capacity).toBe(4);
        expect(pool.meshes).toEqual([mesh]);
        expect(mesh.parent).toBe(root);
        expect(mesh.thinInstances?.count).toBe(0);
        expect(mesh.thinInstances?._capacity).toBe(4);
    });

    it("expands one root instance matrix into each child mesh's local hierarchy space", () => {
        const root = createTransformNode("root");
        const child = createTransformNode("child", 2, 0, 0);
        const mesh = makeMesh("leaf");
        mesh.position.set(0, 1, 0);
        root.children.push(child);
        child.children.push(mesh);

        const pool = createHierarchyInstancePool(root, 2);
        const angle = Math.PI / 2;
        const rootInstance = composeMat4(5, 0, 0, 0, 0, Math.sin(angle / 2), Math.cos(angle / 2), 1, 1, 1);

        const index = addHierarchyInstance(pool, rootInstance);

        expect(index).toBe(0);
        expect(pool.count).toBe(1);
        const perMeshMatrix = readMatrix(mesh.thinInstances!.matrices as Float32Array, 0);
        const actualFinalWorld = multiplyMat4(mesh.worldMatrix, perMeshMatrix);
        const expectedFinalWorld = multiplyMat4(rootInstance, mesh.worldMatrix);
        expectMatrixClose(actualFinalWorld, expectedFinalWorld);
    });

    it("composes the instance matrix with a flipped glTF-style root instead of replacing it", () => {
        // `loadGltf()` roots carry the RH→LH conversion as scaling (-1, 1, 1).
        const root = createTransformNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        const mesh = makeMesh("leaf");
        mesh.position.set(2, 0, 0);
        root.children.push(mesh);

        const pool = createHierarchyInstancePool(root, 2);
        const templateWorld = readMatrix(mesh.worldMatrix as unknown as Float32Array, 0);

        addHierarchyInstance(pool, createIdentityMat4());
        const identityWorld = multiplyMat4(mesh.worldMatrix, readMatrix(mesh.thinInstances!.matrices as Float32Array, 0));
        expectMatrixClose(identityWorld, templateWorld);

        const offset = createTranslationMat4(5, 0, 0);
        addHierarchyInstance(pool, offset);
        const offsetWorld = multiplyMat4(mesh.worldMatrix, readMatrix(mesh.thinInstances!.matrices as Float32Array, 1));
        expectMatrixClose(offsetWorld, multiplyMat4(offset, templateWorld));
    });

    it("updates and swap-removes logical hierarchy instance slots across meshes", () => {
        const root = createTransformNode("root");
        const mesh = makeMesh("leaf");
        root.children.push(mesh);
        const pool = createHierarchyInstancePool(root, 3);

        addHierarchyInstance(pool, createTranslationMat4(1, 0, 0));
        addHierarchyInstance(pool, createTranslationMat4(2, 0, 0));
        addHierarchyInstance(pool, createTranslationMat4(3, 0, 0));

        setHierarchyInstanceMatrix(pool, 0, createTranslationMat4(9, 0, 0));
        expect(readMatrix(mesh.thinInstances!.matrices as Float32Array, 0)[12]).toBeCloseTo(9);

        removeHierarchyInstance(pool, 1);
        expect(pool.count).toBe(2);
        expect(mesh.thinInstances?.count).toBe(2);
        expect(readMatrix(mesh.thinInstances!.matrices as Float32Array, 1)[12]).toBeCloseTo(3);

        setHierarchyInstanceCount(pool, 0);
        expect(pool.count).toBe(0);
        expect(mesh.thinInstances?.count).toBe(0);
    });

    it("rejects invalid counts and indices", () => {
        const root = createTransformNode("root");
        const mesh = makeMesh("leaf");
        root.children.push(mesh);
        const pool = createHierarchyInstancePool(root, 1);

        expect(() => setHierarchyInstanceCount(pool, 2)).toThrow("within pool capacity");
        expect(() => removeHierarchyInstance(pool, 0)).toThrow("active hierarchy instance");

        addHierarchyInstance(pool, createTranslationMat4(0, 0, 0));
        expect(() => addHierarchyInstance(pool, createTranslationMat4(1, 0, 0))).toThrow("exceeded pool capacity");
        expect(() => setHierarchyInstanceMatrix(pool, 1, createTranslationMat4(1, 0, 0))).toThrow("active hierarchy instance");
    });
});
