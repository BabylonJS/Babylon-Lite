import { describe, expect, it, vi } from "vitest";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { _vis } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { enableShaderMaterialVisiblePacketUpdates } from "../../../packages/babylon-lite/src/material/shader/enable-shader-material-visible-packet-updates";
import { createShaderMaterial, setShaderFloat, setShaderStorageBuffer } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { buildShaderGroup, buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { initMeshTransform, type Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { createMeshFromData } from "../../../packages/babylon-lite/src/mesh/mesh-factories";
import { setThinInstances } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import { createStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";
import { getUniformCopyBatch } from "../../../packages/babylon-lite/src/render/uniform-copy-batch";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { setMeshVisible } from "../../../packages/babylon-lite/src/scene/scene";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";

function fixture(transparent = false, batched = false) {
    const writes: { buffer: GPUBuffer; data: Uint8Array }[] = [];
    const writeBuffer = vi.fn((buffer: GPUBuffer, _offset: number, data: AllowSharedBufferSource, offset = 0, size?: number) => {
        const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        writes.push({ buffer, data: view.slice(offset, size === undefined ? undefined : offset + size) });
    });
    const createBindGroup = vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup);
    const device = {
        limits: { maxBufferSize: 65536 },
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const data = new ArrayBuffer(descriptor.size);
            return { size: descriptor.size, label: descriptor.label, destroy: vi.fn(), getMappedRange: () => data, unmap: vi.fn() } as unknown as GPUBuffer;
        }),
        createBindGroupLayout: (descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout,
        createPipelineLayout: (descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout,
        createBindGroup,
        createShaderModule: (descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule,
        createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline,
        queue: { writeBuffer },
    } as unknown as GPUDevice;
    const copy = vi.fn();
    const engine = { _device: device, canvas: { width: 64, height: 64 }, _currentEncoder: { copyBufferToBuffer: copy } } as unknown as EngineContext;
    const material = createShaderMaterial({
        vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
        fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
        attributes: ["position"],
        uniforms: ["world", "cameraPosition", "screenSize", "alphaCutoff", { name: "amount", type: "f32" }],
        storageBuffers: [{ name: "values", type: "array<f32>" }],
        needAlphaBlending: transparent,
    });
    const storage = createStorageBuffer(engine, 16);
    setShaderStorageBuffer(material, "values", storage);
    const meshes = ["a", "b"].map((name) =>
        initMeshTransform({
            name,
            children: [],
            material,
            receiveShadows: false,
            _gpu: { positionBuffer: {} as GPUBuffer, normalBuffer: {} as GPUBuffer, uvBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexFormat: "uint32", indexCount: 3 },
        })
    );
    const scene = { surface: { engine }, camera: null, _meshDisposables: new Map() } as unknown as SceneContext;
    const signature = { _colorFormat: "rgba8unorm", _sampleCount: 1 } as RenderTargetSignature;
    const batch = batched ? getUniformCopyBatch(signature) : undefined;
    const result = buildShaderMaterialRenderables(scene, meshes, batch ? () => batch : undefined);
    const bindings = result.renderables.map((r) => r.bind(engine, signature));
    const pass = { setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), setBindGroup: vi.fn(), drawIndexed: vi.fn() } as unknown as GPURenderPassEncoder;
    const context = { targetWidth: 64, targetHeight: 64 };
    const update = () => bindings.forEach((binding) => binding.update?.(context));
    const clear = () => {
        writes.length = 0;
        writeBuffer.mockClear();
        createBindGroup.mockClear();
        copy.mockClear();
        batch?.reset();
    };
    const systemWrites = () => writes.filter((write) => write.buffer.label === "shader-system-ubo");
    update();
    clear();
    return { engine, scene, material, meshes, signature, result, bindings, pass, context, update, clear, writes, systemWrites, createBindGroup, batch, copy };
}

describe("ShaderMaterial visible packet update policy", () => {
    it("preserves default hidden packet updates", () => {
        const f = fixture();
        setMeshVisible(f.meshes[1]!, false);
        f.context.targetWidth = 128;
        f.update();
        expect(f.systemWrites()).toHaveLength(2);
    });

    it("defers grouped hidden work and restores all accumulated inputs before its first draw", () => {
        const f = fixture();
        enableShaderMaterialVisiblePacketUpdates(f.material);
        enableShaderMaterialVisiblePacketUpdates(f.material);
        expect(f.result.renderables).toHaveLength(1);
        expect(f.result.renderables[0]!.mesh).toBeUndefined();
        const hidden = f.meshes[1]!;
        setMeshVisible(hidden, false);
        const version = vi.spyOn(hidden, "worldMatrixVersion", "get");
        hidden.position.x = 7;
        const camera = createFreeCamera({ x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        f.scene.camera = camera;
        f.context.targetWidth = 128;
        setShaderFloat(f.material, "alphaCutoff", 0.75);
        setShaderFloat(f.material, "amount", 0.5);
        setShaderStorageBuffer(f.material, "values", createStorageBuffer(f.engine, 32));
        f.clear();
        f.update();
        expect(version).not.toHaveBeenCalled();
        expect(f.systemWrites()).toHaveLength(1);
        expect(f.createBindGroup).toHaveBeenCalledTimes(1);
        expect(f.writes.filter((w) => w.buffer.label === "shader-custom-ubo")).toHaveLength(1);
        expect(f.bindings[0]!.draw(f.pass, f.engine)).toBe(1);
        f.clear();
        f.update();
        expect(f.systemWrites()).toHaveLength(0);
        expect(f.createBindGroup).not.toHaveBeenCalled();
        const epoch = _vis;
        setMeshVisible(hidden, true);
        expect(_vis).toBe((epoch + 1) | 0);
        f.update();
        expect(f.systemWrites()).toHaveLength(1);
        expect(f.createBindGroup).toHaveBeenCalledTimes(1);
        const data = new Float32Array(f.systemWrites()[0]!.data.buffer);
        expect(data[12]).toBe(7);
        expect(Array.from(data)).toContain(128);
        expect(Array.from(data)).toContain(3);
        expect(Array.from(data)).toContain(0.75);
        expect(f.bindings[0]!.draw(f.pass, f.engine)).toBe(2);
        version.mockRestore();
    });

    it("keeps shared custom writes active even when every packet is hidden", () => {
        const f = fixture();
        enableShaderMaterialVisiblePacketUpdates(f.material);
        for (const mesh of f.meshes) {
            setMeshVisible(mesh, false);
        }
        setShaderFloat(f.material, "amount", 0.25);
        f.context.targetWidth = 128;
        f.update();
        expect(f.systemWrites()).toHaveLength(0);
        expect(f.writes).toHaveLength(1);
        expect(new Float32Array(f.writes[0]!.data.buffer)[0]).toBe(0.25);
        setMeshVisible(f.meshes[0]!, true);
        f.clear();
        f.update();
        expect(f.systemWrites()).toHaveLength(1);
        expect(f.writes).toHaveLength(1);
    });

    it("uses the alternate pass camera on restoration, then refreshes for the scene camera", () => {
        const f = fixture();
        enableShaderMaterialVisiblePacketUpdates(f.material);
        setMeshVisible(f.meshes[1]!, false);
        f.scene.camera = createFreeCamera({ x: 2, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        const alternate = createFreeCamera({ x: 9, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        const alternateContext = { ...f.context, _camera: alternate };
        f.bindings[0]!.update?.(alternateContext);
        f.clear();
        setMeshVisible(f.meshes[1]!, true);
        f.bindings[0]!.update?.(alternateContext);
        expect(f.systemWrites()).toHaveLength(1);
        expect(Array.from(new Float32Array(f.systemWrites()[0]!.data.buffer))).toContain(9);
        f.clear();
        f.update();
        expect(f.systemWrites()).toHaveLength(2);
        for (const write of f.systemWrites()) {
            expect(Array.from(new Float32Array(write.data.buffer))).toContain(2);
        }
    });

    it("queues exactly one visible system copy, then the hidden copy on restoration", () => {
        const f = fixture(false, true);
        enableShaderMaterialVisiblePacketUpdates(f.material);
        setMeshVisible(f.meshes[1]!, false);
        f.context.targetWidth = 128;
        f.update();
        f.batch!.flush(f.engine);
        expect(f.copy).toHaveBeenCalledTimes(1);
        expect(f.writes).toHaveLength(1);
        expect(f.writes[0]!.data.byteLength).toBe(f.copy.mock.calls[0]![4]);
        const visibleBytes = f.writes[0]!.data.byteLength;
        f.clear();
        setMeshVisible(f.meshes[1]!, true);
        f.update();
        f.batch!.flush(f.engine);
        expect(f.copy).toHaveBeenCalledTimes(1);
        expect(f.writes[0]!.data.byteLength).toBe(visibleBytes);
        expect(f.bindings[0]!.draw(f.pass, f.engine)).toBe(2);
    });

    it("retains transparent sort updates while deferring hidden system work", () => {
        const f = fixture(true);
        enableShaderMaterialVisiblePacketUpdates(f.material);
        setMeshVisible(f.meshes[1]!, false);
        f.meshes[1]!.position.z = 17;
        f.context.targetWidth = 128;
        f.update();
        expect(f.systemWrites()).toHaveLength(1);
        expect(f.result.renderables[1]!._worldCenter![2]).toBe(17);
        setMeshVisible(f.meshes[1]!, true);
        f.clear();
        f.update();
        expect(f.systemWrites()).toHaveLength(1);
        expect(f.bindings[1]!.draw(f.pass, f.engine)).toBe(1);
    });

    it("does not revive disposed or material-replaced packets and preserves override rebuild policy", () => {
        const f = fixture();
        enableShaderMaterialVisiblePacketUpdates(f.material);
        setMeshVisible(f.meshes[1]!, false);
        for (const dispose of f.scene._meshDisposables.get(f.meshes[1]!)!) {
            dispose();
        }
        f.context.targetWidth = 128;
        f.update();
        expect(f.systemWrites()).toHaveLength(1);
        f.meshes[0]!.material = createShaderMaterial({
            vertexSource: f.material.vertexSource,
            fragmentSource: f.material.fragmentSource,
            attributes: ["position"],
        });
        f.clear();
        f.context.targetWidth = 256;
        f.update();
        expect(f.systemWrites()).toHaveLength(0);
        expect(f.bindings[0]!.draw(f.pass, f.engine)).toBe(0);
        const mesh: Mesh = f.meshes[0]!;
        const rebuilt = f.result.rebuildSingle!(f.scene, mesh, f.material);
        const binding = rebuilt.bind(f.engine, f.signature);
        setMeshVisible(mesh, false);
        f.clear();
        binding.update?.(f.context);
        expect(f.systemWrites()).toHaveLength(0);
        setMeshVisible(mesh, true);
        binding.update?.(f.context);
        expect(f.systemWrites()).toHaveLength(1);
        expect(binding.draw(f.pass, f.engine)).toBe(1);
    });

    it("defers a hidden thin-instance packet while instance sync continues, then refreshes before the restored draw", async () => {
        const f = fixture();
        enableShaderMaterialVisiblePacketUpdates(f.material);
        const mesh = createMeshFromData(f.engine, "thin", new Float32Array(9), new Float32Array(9), new Uint32Array([0, 1, 2]));
        mesh.material = f.material;
        const matrices = (x: number) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, 0, 0, 1]);
        setThinInstances(mesh, matrices(1), 2);
        const built = await buildShaderGroup(f.scene, [mesh]);
        expect(built.renderables).toHaveLength(1);
        const binding = built.renderables[0]!.bind(f.engine, f.signature);
        const pass = { ...f.pass, drawIndexedIndirect: vi.fn() } as unknown as GPURenderPassEncoder;
        binding.update?.(f.context);
        f.clear();
        setMeshVisible(mesh, false);
        const version = vi.spyOn(mesh, "worldMatrixVersion", "get");
        mesh.position.x = 5;
        setThinInstances(mesh, matrices(2), 2);
        f.context.targetWidth = 128;
        binding.update?.(f.context);
        expect(version).not.toHaveBeenCalled();
        expect(f.systemWrites()).toHaveLength(0);
        expect(f.createBindGroup).not.toHaveBeenCalled();
        expect(f.writes.filter((w) => w.buffer.label === "thin-instance-matrices")).toHaveLength(1);
        f.clear();
        setMeshVisible(mesh, true);
        binding.update?.(f.context);
        expect(f.systemWrites()).toHaveLength(1);
        const data = new Float32Array(f.systemWrites()[0]!.data.buffer);
        expect(data[12]).toBe(5);
        expect(Array.from(data)).toContain(128);
        expect(binding.draw(pass, f.engine)).toBe(1);
        expect(f.pass.drawIndexed).toHaveBeenCalledWith(3, 2, 0, undefined);
        version.mockRestore();
    });

    it("lets material views inherit the source policy", async () => {
        const f = fixture();
        enableShaderMaterialVisiblePacketUpdates(f.material);
        const { createShaderNoColorMaterialView } = await import("../../../packages/babylon-lite/src/material/shader/no-color-view");
        const view = createShaderNoColorMaterialView(f.material) as unknown as typeof f.material;
        expect(view._deferPacketUpdate).toBe(f.material._deferPacketUpdate);
        const rebuilt = f.result.rebuildSingle!(f.scene, f.meshes[0]!, view).bind(f.engine, f.signature);
        setMeshVisible(f.meshes[0]!, false);
        f.clear();
        f.context.targetWidth = 128;
        rebuilt.update?.(f.context);
        expect(f.systemWrites()).toHaveLength(0);
    });
});
