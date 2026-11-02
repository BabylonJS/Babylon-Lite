import { describe, expect, it, vi } from "vitest";

import { NullEngine } from "../src/engine/engine";
import { Matrix } from "../src/math/matrix";
import { MeshBuilder, VertexData } from "../src/meshes/meshes";
import type { Mesh } from "../src/meshes/meshes";
import { Scene } from "../src/scene/scene";

/**
 * `setVerticesData`, `setIndices` and `VertexData.applyToMesh` rewrite the existing GPU buffers (`updateMeshGeometry`)
 * when the counts and the attribute layout are unchanged, so the buffers and every recorded bundle stay valid. Any
 * layout change, and geometry shared with a clone, still goes through `resizeMeshGeometry`. These run on a started
 * headless scene whose stub device counts buffer creations and writes.
 */
function startedScene() {
    const engine = new NullEngine();
    const createBuffer = vi.fn(({ size }: GPUBufferDescriptor) => {
        const mapped = new ArrayBuffer(Number(size));
        return { size: Number(size), getMappedRange: () => mapped, unmap: () => undefined, destroy: vi.fn() } as unknown as GPUBuffer;
    });
    // Each write lands in a byte model of its buffer, so a test can read back what the GPU would hold.
    const contents = new Map<GPUBuffer, Uint8Array>();
    const writeBuffer = vi.fn((buffer: GPUBuffer, offset: number, data: ArrayBuffer, dataOffset = 0, size?: number) => {
        const bytes = contents.get(buffer) ?? new Uint8Array(buffer.size);
        contents.set(buffer, bytes);
        bytes.set(new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset), offset);
    });
    (engine._lite as unknown as { _device: GPUDevice })._device = { createBuffer, queue: { writeBuffer } } as unknown as GPUDevice;
    const scene = new Scene(engine);
    (scene as unknown as { _flushPendingAdds(): void })._flushPendingAdds();
    // Registered as a rendering scene is, so a bundle invalidation (`invalidateRenderBundles`) shows in its renderable version.
    const contexts = (engine._lite as unknown as { _renderingContexts: unknown[] })._renderingContexts;
    if (!contexts.includes(scene._lite)) {
        contexts.push(scene._lite);
    }
    const floats = (buffer: GPUBuffer, count: number): number[] => Array.from(new Float32Array(contents.get(buffer)!.buffer, 0, count));
    const uints = (buffer: GPUBuffer, count: number): number[] => Array.from(new Uint32Array(contents.get(buffer)!.buffer, 0, count));
    return { scene, createBuffer, writeBuffer, floats, uints };
}

const gpuOf = (mesh: Mesh) => mesh._lite._gpu;
const renderableVersion = (scene: Scene) => (scene._lite as unknown as { _renderableVersion: number })._renderableVersion;
// The caches that follow geometry edits (shadow casters, the CSM refit gate, culling) read this version.
const worldMatrixVersion = (mesh: Mesh) => (mesh._lite as unknown as { worldMatrixVersion: number }).worldMatrixVersion;

describe("compat geometry updates with an unchanged layout", () => {
    it("rewrites the existing buffers for setVerticesData of position, normal and uv", () => {
        const { scene, createBuffer, floats } = startedScene();
        const box = MeshBuilder.CreateBox("box", {}, scene);
        const gpu = gpuOf(box);
        const version = renderableVersion(scene);
        const matrixVersion = worldMatrixVersion(box);
        createBuffer.mockClear();

        const positions = box.getVerticesData("position")!.map((value) => value * 2);
        box.setVerticesData("position", positions);
        const normals = box.getVerticesData("normal")!.map((value) => -value);
        box.setVerticesData("normal", normals);
        const uvs = box.getVerticesData("uv")!.map((value) => 1 - value);
        box.setVerticesData("uv", uvs);

        expect(gpuOf(box)).toBe(gpu);
        expect(createBuffer).not.toHaveBeenCalled();
        expect(renderableVersion(scene)).toBe(version);
        expect(worldMatrixVersion(box)).toBeGreaterThan(matrixVersion);
        expect(floats(gpu.positionBuffer, positions.length)).toEqual(Array.from(positions));
        expect(floats(gpu.normalBuffer, normals.length)).toEqual(Array.from(normals));
        expect(floats(gpu.uvBuffer, uvs.length)).toEqual(Array.from(uvs));
        expect(Array.from(box.getVerticesData("uv")!)).toEqual(Array.from(uvs));
        expect(Array.from(box.getVerticesData("position")!)).toEqual(Array.from(positions));
        // Bounds follow the new positions, as they do on the resize path.
        expect(box._lite.boundMax).toEqual([1, 1, 1]);
    });

    it("rewrites the existing index buffer for setIndices with the same index count", () => {
        const { scene, createBuffer, uints } = startedScene();
        const box = MeshBuilder.CreateBox("box", {}, scene);
        const gpu = gpuOf(box);
        const version = renderableVersion(scene);
        createBuffer.mockClear();
        const flipped = Array.from(box.getIndices()!);
        for (let i = 0; i < flipped.length; i += 3) {
            [flipped[i + 1], flipped[i + 2]] = [flipped[i + 2]!, flipped[i + 1]!];
        }

        box.setIndices(flipped);

        expect(gpuOf(box)).toBe(gpu);
        expect(createBuffer).not.toHaveBeenCalled();
        expect(renderableVersion(scene)).toBe(version);
        expect(uints(gpu.indexBuffer, flipped.length)).toEqual(flipped);
        expect(Array.from(box.getIndices()!)).toEqual(flipped);
    });

    it("rewrites the existing buffers when applyToMesh brings the same layout", () => {
        const { scene, createBuffer, floats } = startedScene();
        const box = MeshBuilder.CreateBox("box", {}, scene);
        const gpu = gpuOf(box);
        const version = renderableVersion(scene);
        const data = new VertexData();
        data.positions = box.getVerticesData("position")!.map((value) => value * 3);
        data.normals = box.getVerticesData("normal")!;
        data.uvs = box.getVerticesData("uv")!;
        data.indices = box.getIndices()!;
        createBuffer.mockClear();

        data.applyToMesh(box);

        expect(gpuOf(box)).toBe(gpu);
        expect(createBuffer).not.toHaveBeenCalled();
        expect(renderableVersion(scene)).toBe(version);
        expect(floats(gpu.positionBuffer, data.positions.length)).toEqual(Array.from(data.positions));
        expect(box._lite.boundMax).toEqual([1.5, 1.5, 1.5]);
    });

    it("bakes a transform into the existing buffers, a mirroring one included", () => {
        const { scene, createBuffer, floats, uints } = startedScene();
        const box = MeshBuilder.CreateBox("box", {}, scene);
        const gpu = gpuOf(box);
        const version = renderableVersion(scene);
        const indices = Array.from(box.getIndices()!);
        createBuffer.mockClear();

        // A negative determinant also reverses the winding: a new index order with the same count.
        box.bakeTransformIntoVertices(Matrix.Scaling(-2, 1, 1));

        expect(gpuOf(box)).toBe(gpu);
        expect(createBuffer).not.toHaveBeenCalled();
        expect(renderableVersion(scene)).toBe(version);
        expect(box._lite.boundMax).toEqual([1, 0.5, 0.5]);
        const baked = Array.from(box.getIndices()!);
        expect(baked).not.toEqual(indices);
        expect(uints(gpu.indexBuffer, baked.length)).toEqual(baked);
        expect(floats(gpu.positionBuffer, 3)).toEqual(Array.from(box.getVerticesData("position")!.subarray(0, 3)));
    });
});

describe("compat geometry updates that still allocate new buffers", () => {
    it("resizes when the vertex count or the attribute layout changes", () => {
        const { scene, createBuffer } = startedScene();
        const box = MeshBuilder.CreateBox("box", {}, scene);
        const first = gpuOf(box);
        const version = renderableVersion(scene);

        // A uv2 channel the geometry was created without.
        box.setVerticesData("uv2", new Float32Array(box.getTotalVertices() * 2));
        const second = gpuOf(box);
        expect(second).not.toBe(first);
        expect(second.hasUv2).toBe(true);
        expect(renderableVersion(scene)).toBeGreaterThan(version);

        // Fewer vertices: the old index count no longer applies either.
        createBuffer.mockClear();
        box.setVerticesData("position", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
        box.setIndices([0, 1, 2]);
        expect(gpuOf(box)).not.toBe(second);
        expect(createBuffer).toHaveBeenCalled();
        expect(box.getTotalVertices()).toBe(3);
    });

    it("gives a clone its own buffers instead of writing into the geometry it shares", () => {
        const { scene, writeBuffer } = startedScene();
        const box = MeshBuilder.CreateBox("box", {}, scene);
        const clone = box.clone("clone") as Mesh;
        const shared = gpuOf(box);
        expect(gpuOf(clone)).toBe(shared);
        const originalUvs = Array.from(box.getVerticesData("uv")!);
        writeBuffer.mockClear();

        clone.setVerticesData(
            "uv",
            clone.getVerticesData("uv")!.map((value) => 1 - value)
        );

        expect(gpuOf(box)).toBe(shared);
        expect(gpuOf(clone)).not.toBe(shared);
        expect(writeBuffer.mock.calls.some(([buffer]) => buffer === shared.uvBuffer)).toBe(false);
        expect(Array.from(box.getVerticesData("uv")!)).toEqual(originalUvs);
    });
});
