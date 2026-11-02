import { describe, expect, it, vi } from "vitest";
import { createGeometryDeformationVelocity, geometryPreviousDeformation } from "../../../packages/babylon-lite/src/material/geometry-deformation-velocity.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { MSH_HAS_MORPH_TARGETS, MSH_HAS_SKELETON, MSH_HAS_SKELETON_8, MSH_HAS_THIN_INSTANCES } from "../../../packages/babylon-lite/src/material/mesh-features.js";
import type { ComposedShader } from "../../../packages/babylon-lite/src/shader/fragment-types.js";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl.js";

function fixture() {
    const textures: { destroy: ReturnType<typeof vi.fn> }[] = [],
        buffers: { destroy: ReturnType<typeof vi.fn> }[] = [];
    const writes: { target: unknown; values: Float32Array }[] = [];
    const device = {
        createTexture: vi.fn(() => {
            const texture = { destroy: vi.fn(), createView: () => ({}) };
            textures.push(texture);
            return texture;
        }),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const data = new ArrayBuffer(Number(descriptor.size)),
                buffer = { destroy: vi.fn(), getMappedRange: () => data, unmap: vi.fn() };
            buffers.push(buffer);
            return buffer;
        }),
        queue: {
            writeTexture: vi.fn((target: object, values: Float32Array) => writes.push({ target, values: values.slice() })),
            writeBuffer: vi.fn((target: unknown, _offset: number, values: Float32Array) => writes.push({ target, values: values.slice() })),
        },
    };
    const engine = { _device: device } as unknown as EngineContext;
    const skeleton = { boneCount: 1, boneMatrices: new Float32Array(16), _disposed: false };
    const morph = { count: 5, weights: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]), _disposed: false };
    const mesh = { skeleton, morphTargets: morph } as unknown as Mesh;
    return { engine, device, mesh, skeleton, morph, writes, textures, buffers };
}
describe("shared geometry deformation velocity", () => {
    it("keeps per-renderable previous poses for shared skin/morph sources without mutating them", () => {
        const f = fixture();
        const first = createGeometryDeformationVelocity(f.engine, f.mesh),
            second = createGeometryDeformationVelocity(f.engine, f.mesh);
        first._update(true);
        second._update(true);
        f.skeleton.boneMatrices[12] = 0.4;
        f.morph.weights[4] = 0.8;
        first._update(false);
        second._update(false);
        expect(f.writes.at(-4)!.values[12]).toBe(0);
        expect(f.writes.at(-2)!.values[12]).toBe(0);
        expect(f.writes.at(-3)!.values[4]).toBeCloseTo(0.5);
        expect(f.writes.at(-1)!.values[4]).toBeCloseTo(0.5);
        expect(f.skeleton.boneMatrices[12]).toBeCloseTo(0.4);
        const count = f.device.createTexture.mock.calls.length,
            bufferCount = f.device.createBuffer.mock.calls.length;
        first._update(false);
        expect(f.writes.at(-2)!.values[12]).toBeCloseTo(0.4);
        expect(f.writes.at(-1)!.values[4]).toBeCloseTo(0.8);
        expect(f.device.createTexture).toHaveBeenCalledTimes(count);
        expect(f.device.createBuffer).toHaveBeenCalledTimes(bufferCount);
        first._dispose();
        first._dispose();
        second._dispose();
        for (const resource of [...f.textures, ...f.buffers]) expect(resource.destroy).toHaveBeenCalledOnce();
    });
    it("initializes current pose neutrally after an excluded or hidden interval", () => {
        const f = fixture(),
            state = createGeometryDeformationVelocity(f.engine, f.mesh);
        state._update(true);
        f.skeleton.boneMatrices[12] = 0.9;
        f.morph.weights[0] = 0.7;
        state._update(true);
        expect(f.writes.at(-2)!.values[12]).toBeCloseTo(0.9);
        expect(f.writes.at(-1)!.values[0]).toBeCloseTo(0.7);
        const entries: GPUBindGroupEntry[] = [];
        expect(state._bind(entries, 4)).toBe(6);
        expect(entries.map((entry) => entry.binding)).toEqual([4, 5]);
        state._dispose();
        expect(() => state._update(false)).toThrow("disposed");
    });
    it("applies previous morph before previous skin, including all eight influences", () => {
        const fragment = geometryPreviousDeformation(MSH_HAS_SKELETON | MSH_HAS_SKELETON_8 | MSH_HAS_MORPH_TARGETS)!;
        expect(fragment.bindings.map((binding) => binding._name)).toEqual(["previousBoneSampler", "previousMorph"]);
        expect(fragment.code.indexOf("previousMorph.weights")).toBeLessThan(fragment.code.indexOf("previousInfluence"));
        expect(fragment.code).toContain("f32(joints1[3])");
        expect(fragment.code).not.toContain("finalWorld =");
        expect(geometryPreviousDeformation(0)).toBeNull();
        expect(geometryPreviousDeformation(MSH_HAS_SKELETON | MSH_HAS_THIN_INSTANCES)).toBeNull();
    });
    it("rejects replaced or malformed pose sources explicitly", () => {
        const f = fixture(),
            state = createGeometryDeformationVelocity(f.engine, f.mesh);
        Object.assign(f.mesh, { morphTargets: { ...f.morph } });
        expect(() => state._update(false)).toThrow("rebuild");
        state._dispose();
        expect(() => createGeometryDeformationVelocity(f.engine, {} as Mesh)).toThrow("requires");
        expect(() => createGeometryDeformationVelocity(f.engine, { skeleton: { boneCount: 2, boneMatrices: new Float32Array(16) } } as never)).toThrow("bone matrices");
    });
    it("does not bind previous bones when the material has not enabled skinning", () => {
        const f = fixture(),
            state = createGeometryDeformationVelocity(f.engine, f.mesh, false),
            entries: GPUBindGroupEntry[] = [];
        state._update(true);
        expect(f.textures).toHaveLength(0);
        expect(state._bind(entries, 0)).toBe(1);
        state._dispose();
    });
    it.each([false, true])("patches the extra previous-weight storage binding without altering current bindings (minified=%s)", (minified) => {
        let code = "@group(1)@binding(8) var<uniform> previousMorph:previousMorphUniforms;";
        if (minified) code = code.replaceAll(" ", "");
        const composed = {
            _vertexWGSL: wgsl`${code}`,
            _meshBGLDescriptor: {
                entries: [
                    { binding: 7, visibility: 1, buffer: { type: "read-only-storage" } },
                    { binding: 8, visibility: 1, buffer: { type: "uniform" } },
                ],
            },
        } as ComposedShader;
        const patched = geometryPreviousDeformation(MSH_HAS_MORPH_TARGETS)!.patch!(composed);
        expect(patched._vertexWGSL).toContain("var<storage, read> previousMorph:");
        expect(Array.from(patched._meshBGLDescriptor.entries).map((entry) => entry.buffer?.type)).toEqual(["read-only-storage", "read-only-storage"]);
    });
});
