import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { MaterialView } from "../../../packages/babylon-lite/src/material/material";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { ShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { createShaderMaterial, setShaderFloat } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { createMaterialView } from "../../../packages/babylon-lite/src/material/material-view";
import { releaseMaterialViewGpu } from "../../../packages/babylon-lite/src/material/shader/shader-material-view-gpu";
import { clearShaderPipelineCache, enableShaderPipelineCache } from "../../../packages/babylon-lite/src/material/shader/shader-pipeline-cache";
import { buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { waitForGpuResourceRetirements, flushGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";

type TestBuffer = GPUBuffer & { bytes: Uint8Array; destroyed: number };
type TestMaterial = ShaderMaterial & { _shaderCustomUbo: TestBuffer | null; _shaderBindings: unknown };

function fixture() {
    let complete!: () => void;
    const fence = new Promise<void>((resolve) => {
        complete = resolve;
    });
    const buffers: TestBuffer[] = [];
    const device = {
        createBuffer({ label = "", size }: GPUBufferDescriptor) {
            const buffer = {
                label,
                size,
                bytes: new Uint8Array(size),
                destroyed: 0,
                destroy() {
                    this.destroyed++;
                },
            } as TestBuffer;
            buffers.push(buffer);
            return buffer;
        },
        createBindGroupLayout: (value: unknown) => value,
        createPipelineLayout: (value: unknown) => value,
        createBindGroup: (value: unknown) => value,
        createShaderModule: (value: unknown) => value,
        createRenderPipeline: (value: unknown) => value,
        queue: {
            onSubmittedWorkDone: vi.fn(() => fence),
            writeBuffer(buffer: TestBuffer, offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number) {
                const view = ArrayBuffer.isView(data);
                const unit = view && "BYTES_PER_ELEMENT" in data ? Number(data.BYTES_PER_ELEMENT) : 1;
                const raw = view ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
                buffer.bytes.set(raw.subarray(dataOffset * unit, size === undefined ? undefined : (dataOffset + size) * unit), offset);
            },
        },
    };
    const engine = { _device: device, canvas: { width: 1024, height: 800 } } as unknown as EngineContext;
    const scene = { surface: { engine }, camera: null, _meshDisposables: new Map(), _meshAuxDisposables: new Map() } as unknown as SceneContext;
    return { engine, scene, buffers, complete, device };
}

function source(transparent = false): TestMaterial {
    return createShaderMaterial({
        attributes: ["position"],
        needAlphaBlending: transparent,
        vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
        fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(shaderUniforms.tint); }`,
        uniforms: [{ name: "tint", type: "f32", defaultValue: 0.125 }],
    }) as TestMaterial;
}

function privateView(material: ShaderMaterial): TestMaterial {
    const view = createMaterialView(material, { features: 0 });
    Object.defineProperties(view, {
        _shaderCustomUbo: { value: null, writable: true },
        _shaderCustomData: { value: null, writable: true },
    });
    return view as unknown as TestMaterial;
}

function build(f: ReturnType<typeof fixture>, material: ShaderMaterial) {
    const mesh = initMeshTransform({
        material,
        _gpu: {
            positionBuffer: {} as GPUBuffer,
            normalBuffer: {} as GPUBuffer,
            uvBuffer: {} as GPUBuffer,
            indexBuffer: {} as GPUBuffer,
            indexCount: 3,
            indexFormat: "uint32",
        },
    });
    const renderable = buildShaderMaterialRenderables(f.scene, [mesh]).renderables[0]!;
    const bind = () => renderable.bind(f.scene.surface.engine, { _colorFormat: "rgba8unorm", _sampleCount: 1 });
    return { mesh, bind, binding: bind() };
}

const update = { targetWidth: 1024, targetHeight: 800 };
const tint = (buffer: TestBuffer) => new DataView(buffer.bytes.buffer).getFloat32(0, true);

describe("ShaderMaterial private view lifetime", () => {
    it("retires one of three views once behind the fence and preserves source and survivors", async () => {
        const f = fixture(),
            material = source();
        const views = [privateView(material), privateView(material), privateView(material)];
        enableShaderPipelineCache(
            f.engine,
            [material, ...views].map((m) => ({ material: m }))
        );
        const draws = [material, ...views].map((m) => build(f, m));
        const buffers = [material, ...views].map((m) => m._shaderCustomUbo!);
        const sharedBindings = material._shaderBindings;
        expect(views.map((v) => v._shaderBindings)).toEqual([sharedBindings, sharedBindings, sharedBindings]);
        expect(new Set(buffers).size).toBe(4);
        expect(buffers.map(tint)).toEqual([0.125, 0.125, 0.125, 0.125]);
        for (const dispose of f.scene._meshDisposables.get(draws[1]!.mesh)!) dispose();
        releaseMaterialViewGpu(f.engine, views[0]!);
        releaseMaterialViewGpu(f.engine, views[0]!);
        flushGpuResourceRetirements(f.engine);
        await Promise.resolve();
        expect(f.device.queue.onSubmittedWorkDone).toHaveBeenCalled();
        expect(buffers.map((b) => b.destroyed)).toEqual([0, 0, 0, 0]);
        setShaderFloat(material, "tint", 0.625);
        for (const i of [0, 2, 3]) draws[i]!.binding.update?.(update);
        expect(buffers.map(tint)).toEqual([0.625, 0.125, 0.625, 0.625]);
        f.complete();
        await waitForGpuResourceRetirements(f.engine);
        expect(buffers.map((b) => b.destroyed)).toEqual([0, 1, 0, 0]);
        expect([material, ...views].map((v) => v._shaderBindings)).toEqual([sharedBindings, sharedBindings, sharedBindings, sharedBindings]);
        releaseMaterialViewGpu(f.engine, views[0]!);
        await waitForGpuResourceRetirements(f.engine);
        expect(buffers.map((b) => b.destroyed)).toEqual([0, 1, 0, 0]);
    });

    it("does not retire a source or a view borrowing its source's buffer", async () => {
        const f = fixture(),
            material = source();
        build(f, material);
        const borrowed = createMaterialView(material, { features: 0 }) as unknown as TestMaterial;
        build(f, borrowed);
        const buffer = material._shaderCustomUbo!;
        expect(borrowed._shaderCustomUbo).toBe(buffer);
        expect(Object.hasOwn(borrowed, "_shaderCustomUbo")).toBe(false);
        releaseMaterialViewGpu(f.engine, material as unknown as MaterialView);
        releaseMaterialViewGpu(f.engine, borrowed);
        f.complete();
        await waitForGpuResourceRetirements(f.engine);
        expect(buffer.destroyed).toBe(0);
        expect(material._shaderCustomUbo).toBe(buffer);
        expect(borrowed._shaderCustomUbo).toBe(buffer);
    });

    it.each([false, true])("renews the bound custom buffer without a resource revision, transparent=%s", async (transparent) => {
        const f = fixture(),
            material = source(transparent),
            view = privateView(material);
        enableShaderPipelineCache(f.engine, [{ material }, { material: view }]);
        build(f, material);
        const draw = build(f, view),
            old = view._shaderCustomUbo!;
        expect(Object.hasOwn(view, "_shaderDevice")).toBe(true);
        expect(Object.hasOwn(view, "_shaderCacheGeneration")).toBe(true);
        const revision = view._resourceVersion;
        clearShaderPipelineCache();
        build(f, material);
        const rebound = draw.bind();
        rebound.update?.(update);
        const current = view._shaderCustomUbo!;
        expect(current).not.toBe(old);
        expect(tint(current)).toBe(0.125);
        expect(view._resourceVersion).toBe(revision);
        const pass = { setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {}, setBindGroup: vi.fn() };
        rebound.draw(pass as never, f.engine);
        const group = pass.setBindGroup.mock.calls[0]![1] as GPUBindGroupDescriptor;
        expect((Array.from(group.entries)[1]!.resource as GPUBufferBinding).buffer).toBe(current);
        expect(old.destroyed).toBe(0);
        f.complete();
        await waitForGpuResourceRetirements(f.engine);
        expect(old.destroyed).toBe(1);
        expect(current.destroyed).toBe(0);
    });

    it("retires on the allocating engine when another engine rebuilds the view", async () => {
        const oldEngine = fixture(),
            nextEngine = fixture(),
            material = source(),
            view = privateView(material);
        build(oldEngine, material);
        build(oldEngine, view);
        const old = view._shaderCustomUbo!;
        build(nextEngine, material);
        build(nextEngine, view);
        const current = view._shaderCustomUbo!;
        expect(current).not.toBe(old);
        nextEngine.complete();
        await waitForGpuResourceRetirements(nextEngine.engine);
        expect(old.destroyed).toBe(0);
        oldEngine.complete();
        await waitForGpuResourceRetirements(oldEngine.engine);
        expect(old.destroyed).toBe(1);
        expect(current.destroyed).toBe(0);
    });
});
