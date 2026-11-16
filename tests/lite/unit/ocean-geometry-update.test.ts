import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Camera, Mesh } from "../../../packages/babylon-lite/src/index";

const mocks = vi.hoisted(() => {
    const meshes: Array<
        Mesh & {
            position: { set: ReturnType<typeof vi.fn> };
            rotation: { set: ReturnType<typeof vi.fn> };
            scaling: { set: ReturnType<typeof vi.fn> };
        }
    > = [];
    const vector = () => ({ set: vi.fn() });
    const createMesh = (name: string) => {
        const mesh = {
            name,
            position: vector(),
            rotation: vector(),
            scaling: vector(),
            receiveShadows: false,
        } as unknown as (typeof meshes)[number];
        meshes.push(mesh);
        return mesh;
    };
    return { meshes, createMesh };
});

vi.mock("../../../packages/babylon-lite/src/index.ts", () => ({
    addToScene: vi.fn(),
    cloneTransformNode: vi.fn((mesh: Mesh) => mocks.createMesh(`${mesh.name}-clone`)),
    createMeshFromData: vi.fn((_engine, name: string) => mocks.createMesh(name)),
    markMeshRenderableDirty: vi.fn(),
    resizeMeshGeometry: vi.fn(),
    resizeSharedMeshGeometry: vi.fn(),
    setMeshVisible: vi.fn(),
}));

import { createOceanClipmap } from "../../../lab/lite/src/demos/ocean/geometry";

function transformWriteCount(): number {
    let count = 0;
    for (const mesh of mocks.meshes) {
        count += mesh.position.set.mock.calls.length + mesh.rotation.set.mock.calls.length + mesh.scaling.set.mock.calls.length;
    }
    return count;
}

describe("Ocean clipmap updates", () => {
    beforeEach(() => {
        mocks.meshes.length = 0;
        vi.clearAllMocks();
    });

    it("skips transform writes until the camera or transform parameters change", () => {
        const materials = { close: {}, mid: {}, far: {} };
        const clipmap = createOceanClipmap({} as never, {} as never, materials as never, { vertexDensity: 1, clipLevels: 2 });
        const worldMatrix = new Float32Array(16);
        worldMatrix[13] = 4;
        const camera = { worldMatrix } as unknown as Camera;

        clipmap.update(camera);
        const initialWrites = transformWriteCount();
        expect(initialWrites).toBeGreaterThan(0);

        clipmap.update(camera);
        expect(transformWriteCount()).toBe(initialWrites);

        clipmap.setNoMaterialLod(false);
        clipmap.update(camera);
        const parameterWrites = transformWriteCount();
        expect(parameterWrites).toBeGreaterThan(initialWrites);

        worldMatrix[12] = 1;
        clipmap.update(camera);
        expect(transformWriteCount()).toBeGreaterThan(parameterWrites);
    });
});
