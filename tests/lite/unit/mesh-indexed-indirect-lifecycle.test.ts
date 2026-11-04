import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { _vis } from "../../../packages/babylon-lite/src/engine/engine";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { createMeshFromStorageBuffer } from "../../../packages/babylon-lite/src/mesh/mesh-from-storage";
import { setMeshIndexedIndirect } from "../../../packages/babylon-lite/src/mesh/mesh-indexed-indirect-borrow";
import { createStorageBuffer, disposeStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";
import { registerMeshScene } from "../../../packages/babylon-lite/src/scene/mesh-scene-registry";
import { processMaterialSwaps } from "../../../packages/babylon-lite/src/scene/scene-material-swap";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";
import { cloneTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";

function fixture() {
    const device = {
        createBuffer: vi.fn((d: GPUBufferDescriptor) => {
            const data = new ArrayBuffer(Number(d.size));
            return { size: d.size, destroy: vi.fn(), getMappedRange: () => data, unmap: vi.fn() };
        }),
        createBindGroupLayout: vi.fn(() => ({})),
        createPipelineLayout: vi.fn(() => ({})),
        createBindGroup: vi.fn(() => ({})),
        createShaderModule: vi.fn(() => ({})),
        createRenderPipeline: vi.fn(() => ({})),
        queue: { writeBuffer: vi.fn() },
        limits: { maxBufferSize: 1 << 24, maxVertexBufferArrayStride: 2048 },
    } as unknown as GPUDevice;
    const engine = { _device: device, canvas: { width: 64, height: 64 } } as unknown as EngineContext;
    const vertices = createStorageBuffer(engine, 48, { vertex: true });
    const indices = createStorageBuffer(engine, new Uint32Array([0, 1, 2]), { index: true });
    const args = createStorageBuffer(engine, 20, { writable: true, indirect: true });
    const material = createShaderMaterial({
        attributes: ["position"],
        vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
        fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
    });
    const meshes = [0, 1].map((index) => {
        const mesh = createMeshFromStorageBuffer(engine, `mesh${index}`, {
            storage: vertices,
            indices,
            indexFormat: "uint32",
            indexCount: 3,
            vertexCount: 3,
            arrayStride: 16,
        });
        mesh.material = material;
        return mesh;
    });
    const scene = {
        surface: { engine },
        camera: null,
        _meshDisposables: new Map(),
        _materialSwapQueue: [],
        _groups: new Map(),
        _renderables: [],
        _renderableVersion: 0,
        _materialEpoch: 0,
    } as unknown as SceneContext;
    for (const mesh of meshes) {
        registerMeshScene(scene, mesh);
    }
    const result = buildShaderMaterialRenderables(scene, meshes);
    scene._renderables = result.renderables;
    scene._groups.set(material._buildGroup, Object.assign(meshes.slice(), { r: result.rebuildSingle, o: result.renderables.slice() }));
    const signature = { _colorFormat: "rgba8unorm", _sampleCount: 1 } as RenderTargetSignature;
    const pass = { setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), setBindGroup: vi.fn(), drawIndexed: vi.fn(), drawIndexedIndirect: vi.fn() };
    const draw = () => scene._renderables.reduce((count, renderable) => count + renderable.bind(engine, signature).draw(pass as unknown as GPURenderPassEncoder, engine), 0);
    return { engine, vertices, indices, args, meshes, scene, pass, draw };
}

describe("indirect replacement and deferred resource drain", () => {
    it("replaces one merged packet without a duplicate draw or premature UBO/argument destruction", () => {
        const f = fixture();
        const oldDisposers = f.scene._meshDisposables.get(f.meshes[0]!)!;
        const buffers = vi.mocked(f.engine._device.createBuffer).mock.results.map((result) => result.value as GPUBuffer);
        const beforeEpoch = _vis;
        setMeshIndexedIndirect(f.meshes[0]!, f.args);
        expect(_vis).not.toBe(beforeEpoch);
        processMaterialSwaps(f.scene);
        expect(f.draw()).toBe(2);
        expect(f.pass.drawIndexed).toHaveBeenCalledTimes(1);
        expect(f.pass.drawIndexedIndirect).toHaveBeenCalledExactlyOnceWith(f.args._buffer, 0);
        for (const buffer of buffers) {
            expect(buffer.destroy).not.toHaveBeenCalled();
        }
        expect(f.engine._retirements).toHaveLength(1);
        disposeGpuResourceRetirements(f.engine);
        expect(f.args._destroyed).toBe(false);
        expect(f.scene._meshDisposables.get(f.meshes[0]!)).not.toBe(oldDisposers);
        f.pass.drawIndexed.mockClear();
        f.pass.drawIndexedIndirect.mockClear();
        expect(f.draw()).toBe(2);
        expect(f.pass.drawIndexedIndirect).toHaveBeenCalledOnce();
    });

    it.each(["vertices", "indices"] as const)("rejects a disposed borrowed %s source rather than submitting dead geometry", (name) => {
        const f = fixture();
        setMeshIndexedIndirect(f.meshes[0]!, f.args);
        processMaterialSwaps(f.scene);
        disposeStorageBuffer(f[name]);
        expect(() => f.draw()).toThrow(/disposed/);
        expect(f.pass.drawIndexedIndirect).not.toHaveBeenCalled();
    });

    it("rejects changing a bound material family atomically, but permits it after unbinding", () => {
        const f = fixture();
        const mesh = f.meshes[0]!;
        const previous = mesh.material;
        setMeshIndexedIndirect(mesh, f.args);
        const other = { _buildGroup: vi.fn() } as unknown as typeof previous;
        expect(() => {
            mesh.material = other;
        }).toThrow(/unbind/);
        expect(mesh.material).toBe(previous);
        setMeshIndexedIndirect(mesh, null);
        expect(() => {
            mesh.material = other;
        }).not.toThrow();
    });

    it("rejects borrow mutation during active recording without replacing a valid source", () => {
        const f = fixture();
        const mesh = f.meshes[0]!;
        setMeshIndexedIndirect(mesh, f.args);
        const previousEncoder = f.engine._currentEncoder;
        f.engine._currentEncoder = {} as GPUCommandEncoder;
        expect(() => setMeshIndexedIndirect(mesh, null)).toThrow(/encoder/);
        expect(() => setMeshIndexedIndirect(mesh, f.args)).toThrow(/encoder/);
        f.engine._currentEncoder = previousEncoder;
        processMaterialSwaps(f.scene);
        expect(f.draw()).toBe(2);
    });

    it("rejects an unsupported material changed before a borrowed clone's first scene registration", () => {
        const f = fixture();
        const clone = cloneTransformNode(f.meshes[0]!) as Mesh;
        setMeshIndexedIndirect(clone, f.args);
        clone.material = { _buildGroup: vi.fn() } as unknown as Mesh["material"];
        expect(() => registerMeshScene(f.scene, clone)).toThrow(/unbind/);
        setMeshIndexedIndirect(clone, null);
        expect(() => registerMeshScene(f.scene, clone)).not.toThrow();
    });
});
