import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { createMeshFromStorageBuffer } from "../../../packages/babylon-lite/src/mesh/mesh-from-storage";
import { getMeshIndexedDrawInfo, setMeshIndexedIndirect } from "../../../packages/babylon-lite/src/mesh/mesh-indexed-indirect-borrow";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { createStorageBuffer, disposeStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";
import { rebuildCpuStorageBuffers } from "../../../packages/babylon-lite/src/resource/storage-buffer-recovery";
import { registerMeshScene, unregisterMeshScene } from "../../../packages/babylon-lite/src/scene/mesh-scene-registry";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { cloneTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";

function fixture(transparent = false) {
    const device = {
        createBuffer: vi.fn((d: GPUBufferDescriptor) => {
            const data = new ArrayBuffer(Number(d.size));
            return { size: d.size, usage: d.usage, destroy: vi.fn(), getMappedRange: () => data, unmap: vi.fn() };
        }),
        createBindGroupLayout: vi.fn((d) => d),
        createPipelineLayout: vi.fn((d) => d),
        createBindGroup: vi.fn((d) => d),
        createShaderModule: vi.fn((d) => d),
        createRenderPipeline: vi.fn((d) => d),
        queue: { writeBuffer: vi.fn() },
        limits: { maxBufferSize: 1 << 24, maxVertexBufferArrayStride: 2048 },
    } as unknown as GPUDevice;
    const engine = { _device: device, canvas: { width: 64, height: 64 } } as unknown as EngineContext;
    const vertices = createStorageBuffer(engine, 160, { vertex: true, writable: true });
    const indices = createStorageBuffer(engine, new Uint32Array([0, 1, 2, 0, 2, 1]), { index: true });
    const args = createStorageBuffer(engine, new Uint32Array([99, 3, 2, 1, 0xffffffff, 0]), { indirect: true, writable: true });
    const mesh = createMeshFromStorageBuffer(engine, "indirect", {
        storage: vertices,
        indices,
        indexFormat: "uint32",
        indexCount: 6,
        vertexCount: 3,
        arrayStride: 16,
        baseVertex: 2,
    });
    mesh._gpu._firstIndex = 1;
    mesh.material = createShaderMaterial({
        attributes: ["position"],
        vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
        fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
        needAlphaBlending: transparent,
    });
    const scene = {
        surface: { engine },
        camera: null,
        _meshDisposables: new Map(),
        _materialSwapQueue: [],
    } as unknown as SceneContext;
    const pass = { setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), setBindGroup: vi.fn(), drawIndexed: vi.fn(), drawIndexedIndirect: vi.fn() };
    const bind = (m = mesh) => buildShaderMaterialRenderables(scene, [m]).renderables[0]!.bind(engine, { _colorFormat: "rgba8unorm", _sampleCount: 1 } as RenderTargetSignature);
    const draw = (m = mesh) => bind(m).draw(pass as unknown as GPURenderPassEncoder, engine);
    return { engine, vertices, indices, args, mesh, scene, pass, bind, draw };
}

describe("plain storage mesh indexed indirect borrowing", () => {
    it.each([false, true])("uses the exact GPU ABI range without overwriting any word (transparent=%s)", (transparent) => {
        const f = fixture(transparent);
        setMeshIndexedIndirect(f.mesh, f.args, 4);
        f.engine._device.queue.writeBuffer = vi.fn();
        f.draw();
        expect(f.pass.drawIndexedIndirect).toHaveBeenCalledExactlyOnceWith(f.args._buffer, 4);
        expect(f.pass.drawIndexed).not.toHaveBeenCalled();
        for (const [target] of vi.mocked(f.engine._device.queue.writeBuffer).mock.calls) {
            expect(target).not.toBe(f.args._buffer);
        }
        expect(f.mesh._gpu.indexCount).toBe(6);
        expect(f.mesh._gpu._firstIndex).toBe(1);
        expect(f.mesh._gpu._baseVertex).toBe(2);
        expect(getMeshIndexedDrawInfo(f.mesh)).toEqual({ mode: "indirect", indexCapacity: 6, indexCount: null, instanceCount: null });
    });

    it("keeps the default CPU draw and restores it on unbind", () => {
        const f = fixture();
        f.draw();
        expect(f.pass.drawIndexed).toHaveBeenLastCalledWith(6, 1, 1, 2);
        setMeshIndexedIndirect(f.mesh, f.args, 4);
        setMeshIndexedIndirect(f.mesh, null);
        f.draw();
        expect(f.pass.drawIndexed).toHaveBeenCalledTimes(2);
        expect(getMeshIndexedDrawInfo(f.mesh)).toEqual({ mode: "direct", indexCapacity: 6, indexCount: 6, instanceCount: 1 });
    });

    it.each([-4, 2, 8, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid offsets (%s) without changing the borrow", (offset) => {
        const f = fixture();
        setMeshIndexedIndirect(f.mesh, f.args, 4);
        expect(() => setMeshIndexedIndirect(f.mesh, f.args, offset)).toThrow(/offset|Offset|capacity/);
        f.draw();
        expect(f.pass.drawIndexedIndirect).toHaveBeenLastCalledWith(f.args._buffer, 4);
    });

    it("requires twenty bytes, INDIRECT usage, live identity, and the same device/engine", () => {
        const f = fixture();
        const small = createStorageBuffer(f.engine, 16, { indirect: true });
        expect(() => setMeshIndexedIndirect(f.mesh, small)).toThrow(/capacity/);
        const ordinary = createStorageBuffer(f.engine, 24);
        expect(() => setMeshIndexedIndirect(f.mesh, ordinary)).toThrow(/indirect: true/);
        expect(() => setMeshIndexedIndirect(f.mesh, { ...f.args })).toThrow(/registered|disposed/);
        const other = fixture();
        expect(() => setMeshIndexedIndirect(f.mesh, other.args)).toThrow(/engine|storage-backed/);
        disposeStorageBuffer(f.args);
        expect(() => setMeshIndexedIndirect(f.mesh, f.args)).toThrow(/disposed|live/);
    });

    it("invalidates every subscribed scene on replace/unbind, not on GPU content changes or identical binding", () => {
        const f = fixture();
        const second = { ...f.scene, _materialSwapQueue: [] } as SceneContext;
        registerMeshScene(f.scene, f.mesh);
        registerMeshScene(second, f.mesh);
        setMeshIndexedIndirect(f.mesh, f.args, 4);
        expect(f.scene._materialSwapQueue).toEqual([f.mesh]);
        expect(second._materialSwapQueue).toEqual([f.mesh]);
        f.scene._materialSwapQueue.length = second._materialSwapQueue.length = 0;
        setMeshIndexedIndirect(f.mesh, f.args, 4);
        expect(f.scene._materialSwapQueue).toEqual([]);
        setMeshIndexedIndirect(f.mesh, null);
        expect(f.scene._materialSwapQueue).toEqual([f.mesh]);
        expect(second._materialSwapQueue).toEqual([f.mesh]);
    });

    it("rechecks disposed arguments during update before a cached bundle can execute", () => {
        const f = fixture();
        setMeshIndexedIndirect(f.mesh, f.args, 4);
        const binding = f.bind();
        disposeStorageBuffer(f.args);
        expect(() => binding.update?.({ targetWidth: 64, targetHeight: 64 })).toThrow(/disposed|live/);
        expect(() => binding.draw(f.pass as unknown as GPURenderPassEncoder, f.engine)).toThrow(/disposed|live/);
        expect(f.pass.drawIndexed).not.toHaveBeenCalled();
        expect(f.pass.drawIndexedIndirect).not.toHaveBeenCalled();
        setMeshIndexedIndirect(f.mesh, null);
        expect(() => f.draw()).not.toThrow();
    });

    it("keeps caller ownership across clone, detach, replacement, and retirement", () => {
        const f = fixture();
        setMeshIndexedIndirect(f.mesh, f.args, 4);
        const clone = cloneTransformNode(f.mesh) as Mesh;
        expect(getMeshIndexedDrawInfo(clone).mode).toBe("direct");
        setMeshIndexedIndirect(clone, f.args, 4);
        registerMeshScene(f.scene, f.mesh);
        expect(unregisterMeshScene(f.scene, f.mesh)).toBe(true);
        f.draw();
        disposeMeshGpu(f.mesh);
        expect(() => setMeshIndexedIndirect(f.mesh, null)).toThrow(/disposed/);
        expect(f.args._destroyed).toBe(false);
        f.draw(clone);
        setMeshIndexedIndirect(clone, null);
        disposeMeshGpu(clone);
        expect(f.args._destroyed).toBe(false);
        disposeStorageBuffer(f.args);
        expect(f.args._destroyed).toBe(true);
    });

    it("rejects device changes even when the engine identity is unchanged; GPU-role data has no recovery shadow", () => {
        const f = fixture();
        const plain = createStorageBuffer(f.engine, new Uint32Array([42]));
        setMeshIndexedIndirect(f.mesh, f.args, 4);
        expect(f.args._data).toBeNull();
        f.engine._device = fixture().engine._device;
        rebuildCpuStorageBuffers(f.engine);
        expect(plain._buffer).not.toBeNull();
        expect(f.args._buffer).toBeNull();
        expect(() => f.draw()).toThrow(/device|recreat/i);
        expect(() => setMeshIndexedIndirect(f.mesh, f.args, 4)).toThrow(/device|recreat/i);
        const replacement = createStorageBuffer(f.engine, 24, { writable: true, indirect: true });
        expect(() => setMeshIndexedIndirect(f.mesh, replacement, 4)).toThrow(/device|recreat/i);
    });

    it("rejects non-storage geometry, instancing, and non-Shader materials", () => {
        const f = fixture();
        const ordinary = { ...f.mesh, _gpu: { ...f.mesh._gpu, _ownsVertexBuffers: true } } as Mesh;
        expect(() => setMeshIndexedIndirect(ordinary, f.args, 4)).toThrow(/storage-backed/);
        f.mesh.thinInstances = {} as NonNullable<Mesh["thinInstances"]>;
        expect(() => setMeshIndexedIndirect(f.mesh, f.args, 4)).toThrow(/thin|plain/);
        f.mesh.thinInstances = undefined;
        f.mesh.material = { _buildGroup: vi.fn() } as unknown as Mesh["material"];
        expect(() => setMeshIndexedIndirect(f.mesh, f.args, 4)).toThrow(/ShaderMaterial/);
    });
});
