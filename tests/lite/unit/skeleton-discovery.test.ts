import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { GltfLoadCtx } from "../../../packages/babylon-lite/src/loader-gltf/gltf-feature";
import type { GltfMeshData } from "../../../packages/babylon-lite/src/loader-gltf/load-gltf";
import type { GltfMaterialData } from "../../../packages/babylon-lite/src/loader-gltf/gltf-material";
import { createIdentityMat4 } from "../../../packages/babylon-lite/src/math/create-identity-mat4";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh";
import { cloneTransformNode, createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import { createSkeleton } from "../../../packages/babylon-lite/src/skeleton/create-skeleton";

function fixture() {
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => ({
        getMappedRange: () => new ArrayBuffer(Number(descriptor.size)),
        unmap: vi.fn(),
    }));
    const engine = { _device: { createBuffer, createTexture: vi.fn(() => ({})), queue: { writeTexture: vi.fn() } } } as unknown as EngineContext;
    const primitive = { attributes: { JOINTS_0: 0, WEIGHTS_0: 1 } };
    const binary = new ArrayBuffer(24);
    new Float32Array(binary, 8).set([1, 0, 0, 0]);
    const ctx: GltfLoadCtx = {
        _engine: engine,
        _json: {
            nodes: [
                { mesh: 0, skin: 0 },
                { name: "outsideSkin", children: [2] },
                { name: "root", children: [3] },
                { name: "spacer", children: [4] },
                { name: "leaf" },
                { name: "otherRoot" },
                { mesh: 0, skin: 1 },
            ],
            meshes: [{ primitives: [primitive] }],
            skins: [{ joints: [4, 2, 5] }, { joints: [1] }],
            bufferViews: [
                { byteOffset: 0, byteLength: 8 },
                { byteOffset: 8, byteLength: 16 },
            ],
            accessors: [
                { bufferView: 0, componentType: 5123, count: 1, type: "VEC4" },
                { bufferView: 1, componentType: 5126, count: 1, type: "VEC4" },
            ],
        },
        _binChunk: new DataView(binary),
        _parentMap: new Map([
            [2, 1],
            [3, 2],
            [4, 3],
        ]),
        _worldMatrixCache: new Map(),
        _baseUrl: "",
        _matExts: [],
        _wrapTex: (texture) => texture,
    };
    const meshes = [0, 6].map((nodeIndex) => initMeshTransform({ name: `mesh${nodeIndex}`, _gpu: {} as MeshGPU }));
    const data = (nodeIndex: number): GltfMeshData => ({
        _positions: new Float32Array(3),
        _normals: new Float32Array(3),
        _tangents: null,
        _uvs: null,
        _uv2s: null,
        _colors: null,
        _indices: new Uint16Array([0]),
        _vertexCount: 1,
        _indexCount: 1,
        _material: {} as GltfMaterialData,
        _nodeIndex: nodeIndex,
        _primitive: primitive,
        _worldMatrix: createIdentityMat4(),
    });
    return { ctx, meshes, data };
}

describe("glTF skeleton discovery", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("resolves same-skin parents before returning handles and shares them with mesh clones", async () => {
        const { enableBoneControlForSkinnedAssets } = await import("../../../packages/babylon-lite/src/skeleton/bone-control-hooks");
        const { default: feature } = await import("../../../packages/babylon-lite/src/loader-gltf/gltf-feature-skeleton");
        const { getMeshSkeleton } = await import("../../../packages/babylon-lite/src/skeleton/bone-control");
        const { ctx, meshes, data } = fixture();
        enableBoneControlForSkinnedAssets();
        await feature.applyMesh!(data(0), meshes[0]!, ctx);
        await feature.applyMesh!(data(6), meshes[1]!, ctx);
        const container = await feature.applyAsset!(meshes, createTransformNode("asset"), ctx);
        const skeleton = container.skeletons![0]!;
        const [leaf, root, otherRoot] = skeleton.bones;

        expect(leaf!.parent).toBe(root);
        expect(root!.parent).toBeNull();
        expect(otherRoot!.parent).toBeNull();
        expect(container.skeletons![1]!.bones[0]!.parent).toBeNull();
        expect(getMeshSkeleton(meshes[0]!)).toBe(skeleton);
        expect(getMeshSkeleton(meshes[1]!)).toBe(container.skeletons![1]);
        const clone = cloneTransformNode(meshes[0]!);
        expect(getMeshSkeleton(clone as (typeof meshes)[number])).toBe(skeleton);
        expect(meshes[0]!.skeleton!._overrides).toBe(skeleton._overrides);

        const runtime = meshes[0]!.skeleton!;
        const rebuilt = createSkeleton(ctx._engine, runtime.joints, runtime.weights, runtime.boneCount, runtime.boneMatrices);
        expect(Object.hasOwn(rebuilt, "_skeleton")).toBe(false);
        Object.assign(runtime, rebuilt);
        expect(getMeshSkeleton(meshes[0]!)).toBe(skeleton);
        expect(getMeshSkeleton(clone as (typeof meshes)[number])).toBe(skeleton);
    });

    it("returns undefined for unskinned meshes and skins loaded without bone-control opt-in", async () => {
        const { default: feature } = await import("../../../packages/babylon-lite/src/loader-gltf/gltf-feature-skeleton");
        const { enableBoneControl, getMeshSkeleton } = await import("../../../packages/babylon-lite/src/skeleton/bone-control");
        const { ctx, meshes, data } = fixture();
        expect(getMeshSkeleton(meshes[0]!)).toBeUndefined();
        await feature.applyMesh!(data(0), meshes[0]!, ctx);
        expect(meshes[0]!.skeleton).toBeDefined();
        expect((await feature.applyAsset!(meshes, createTransformNode("asset"), ctx)).skeletons).toBeUndefined();
        expect(getMeshSkeleton(meshes[0]!)).toBeUndefined();
        enableBoneControl();
        expect(getMeshSkeleton(meshes[0]!)).toBeUndefined();
    });
});
