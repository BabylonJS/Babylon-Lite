import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { emitGraph, loadGraphEmitters } from "../../../packages/babylon-lite/src/material/node/node-emitter";
import { parseNodeMaterialFromSnippet } from "../../../packages/babylon-lite/src/material/node/node-material";
import { createNodeMorphFeature } from "../../../packages/babylon-lite/src/material/node/node-morph";
import { findBlockByClassName, parseNodeMaterialSource } from "../../../packages/babylon-lite/src/material/node/node-parser";
import { clearNodePipelineCache, compileNodePipeline } from "../../../packages/babylon-lite/src/material/node/node-pipeline";
import { loadBlockEmitter } from "../../../packages/babylon-lite/src/material/node/node-registry";
import type { BlockEmitter } from "../../../packages/babylon-lite/src/material/node/node-types";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";

const EXPECTED_MORPH_WGSL = `struct morphDeltasUniforms { d: array<f32> };
@group(1) @binding(4) var<storage, read> morphDeltas: morphDeltasUniforms;
struct morphUniforms { count: u32, vertexCount: u32, _p0: u32, _p1: u32, weights: array<f32> };
@group(1) @binding(5) var<storage, read> morph: morphUniforms;
fn nme_morphPosition(base: vec3<f32>, vi: u32) -> vec3<f32> {
    var acc = base;
    for (var i = 0u; i < morph.count; i = i + 1u) {
        let b = (i * morph.vertexCount + vi) * 6u;
        acc = acc + morph.weights[i] * vec3<f32>(morphDeltas.d[b], morphDeltas.d[b + 1u], morphDeltas.d[b + 2u]);
    }
    return acc;
}
fn nme_morphNormal(base: vec3<f32>, vi: u32) -> vec3<f32> {
    var acc = base;
    for (var i = 0u; i < morph.count; i = i + 1u) {
        let b = (i * morph.vertexCount + vi) * 6u;
        acc = acc + morph.weights[i] * vec3<f32>(morphDeltas.d[b + 3u], morphDeltas.d[b + 4u], morphDeltas.d[b + 5u]);
    }
    return acc;
}`;

function graphSource(morph: boolean): object {
    return {
        blocks: [
            { customType: "BABYLON.InputBlock", id: 1, name: "position", mode: 1, type: 0x8, inputs: [], outputs: [{ name: "output" }] },
            ...(morph
                ? [
                      {
                          customType: "BABYLON.MorphTargetsBlock",
                          id: 2,
                          name: "morph",
                          inputs: [{ name: "position", targetBlockId: 1, targetConnectionName: "output" }],
                          outputs: [{ name: "positionOutput" }],
                      },
                  ]
                : []),
            {
                customType: "BABYLON.VertexOutputBlock",
                id: 3,
                name: "vertex",
                inputs: [{ name: "vector", targetBlockId: morph ? 2 : 1, targetConnectionName: morph ? "positionOutput" : "output" }],
                outputs: [],
            },
            { customType: "BABYLON.InputBlock", id: 4, name: "color", mode: 0, type: 0x8, value: [1, 1, 1], inputs: [], outputs: [{ name: "output" }] },
            {
                customType: "BABYLON.FragmentOutputBlock",
                id: 5,
                name: "fragment",
                inputs: [{ name: "rgb", targetBlockId: 4, targetConnectionName: "output" }],
                outputs: [],
            },
        ],
        outputNodes: [3, 5],
    };
}

function engineFixture(): {
    engine: EngineContext;
    meshBgl: () => GPUBindGroupLayoutDescriptor;
} {
    const layouts: GPUBindGroupLayoutDescriptor[] = [];
    const device = {
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => {
            layouts.push(descriptor);
            return descriptor as unknown as GPUBindGroupLayout;
        }),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
    } as unknown as GPUDevice;
    return {
        engine: { _device: device, format: "rgba8unorm", msaaSamples: 1 } as unknown as EngineContext,
        meshBgl: () => layouts.find((layout) => layout.label === "node-mesh")!,
    };
}

async function emit(morph: boolean) {
    const graph = parseNodeMaterialSource(graphSource(morph));
    const emitters = await loadGraphEmitters(graph);
    const fragment = findBlockByClassName(graph, "FragmentOutputBlock")!;
    const vertex = findBlockByClassName(graph, "VertexOutputBlock")!;
    return emitGraph(graph, emitters, fragment.id, vertex.id);
}

describe("Node morph feature isolation", () => {
    it("keeps an actual static graph free of the optional morph compiler seam", async () => {
        const emitted = await emit(false);
        const fixture = engineFixture();

        const compile = compileNodePipeline(emitted.state, emitted.vertexWgsl, emitted.fragmentWgsl, {
            _engine: fixture.engine,
            _format: "rgba8unorm",
            _msaaSamples: 1,
        });

        expect(emitted.state.usesMorphTargets).toBe(false);
        expect(emitted.state._vertexFeature).toBeUndefined();
        expect(compile._bindVertexFeature).toBeUndefined();
        expect(compile._meshUboFloats).toBe(20);
        expect(compile._writeMeshFeature).toBeUndefined();
        expect(compile._wgsl).not.toContain("morphDeltas");
        expect(compile._wgsl).not.toContain("@builtin(vertex_index)");
        expect(compile._wgsl).not.toContain("    lc: u32,");
        expect(compile._wgsl).not.toContain("fn nli(");
        expect(compile._wgsl).not.toContain("var<uniform> nmeLights");
        expect(Array.from(fixture.meshBgl().entries, (entry) => entry.binding)).toEqual([0, 1]);
        clearNodePipelineCache();
    });

    it("installs the same feature seam through a caller-supplied block loader", async () => {
        const graph = parseNodeMaterialSource(graphSource(true));
        const blockLoader = vi.fn(loadBlockEmitter);
        const emitters = await loadGraphEmitters(graph, blockLoader);
        const fragment = findBlockByClassName(graph, "FragmentOutputBlock")!;
        const vertex = findBlockByClassName(graph, "VertexOutputBlock")!;

        const emitted = emitGraph(graph, emitters, fragment.id, vertex.id);

        expect(blockLoader).toHaveBeenCalledWith("MorphTargetsBlock");
        expect(emitted.state.usesMorphTargets).toBe(true);
        expect(emitted.state._vertexFeature).toBeTypeOf("function");
    });

    it("preserves flag-only custom emitter compatibility at the public parse boundary", async () => {
        const fixture = engineFixture();
        const customMorph: BlockEmitter = {
            className: "MorphTargetsBlock",
            stage: "vertex",
            emit(block, _outputName, stage, state, ctx) {
                state.usesMorphTargets = true;
                return ctx.resolve(block, "position", stage, state);
            },
        };
        const blockLoader = vi.fn(async (className: string): Promise<BlockEmitter> => {
            if (className === "MorphTargetsBlock") {
                return customMorph;
            }
            return loadBlockEmitter(className);
        });

        const material = await parseNodeMaterialFromSnippet(fixture.engine, "", {
            json: graphSource(true),
            blockLoader,
        });

        expect(blockLoader).toHaveBeenCalledWith("MorphTargetsBlock");
        expect(material._state.usesMorphTargets).toBe(true);
        expect(material._state._vertexFeature).toBe(createNodeMorphFeature);
        expect(material._compile._bindVertexFeature).toBeTypeOf("function");
        expect(material._compile._wgsl).toContain("morphDeltasUniforms");
        expect(material._compile._wgsl).toContain("@builtin(vertex_index) vertexIndex: u32");
        clearNodePipelineCache();
    });

    it("preserves morph binding order, WGSL, and vertex-index signature in color, no-color, and ESM variants", async () => {
        const emitted = await emit(true);
        const colorFixture = engineFixture();
        const depthFixture = engineFixture();
        const esmFixture = engineFixture();
        emitted.state.textures.push({ name: "albedo", kind: "texture2d", texture: null });
        emitted.state.usesEnv = true;
        emitted.state.shadowLights.push({ lightIndex: 0, shadowType: "pcf" });
        let envStart = -1;
        let shadowStart = -1;
        const emitEnv = (startBinding: number) => {
            envStart = startBinding;
            return {
                bindings: { _iblTexture: startBinding, _iblSampler: startBinding + 1, _brdfLUT: startBinding + 2, _brdfSampler: startBinding + 3 },
                wgslDecls: "ENV_DECLS",
                bglEntries: [
                    { binding: startBinding, visibility: 2, texture: { sampleType: "float" as const, viewDimension: "cube" as const } },
                    { binding: startBinding + 1, visibility: 2, sampler: { type: "filtering" as const } },
                    { binding: startBinding + 2, visibility: 2, texture: { sampleType: "float" as const, viewDimension: "2d" as const } },
                    { binding: startBinding + 3, visibility: 2, sampler: { type: "filtering" as const } },
                ],
                bindingCount: 4,
            };
        };
        const emitShadow = (_lights: Readonly<typeof emitted.state.shadowLights>, startBinding: number) => {
            shadowStart = startBinding;
            return {
                _bindings: [],
                _wgslDecls: "SHADOW_DECLS",
                _fragmentHelper: "",
                _vertexInject: "",
                _bglEntries: [{ binding: startBinding, visibility: 2, buffer: { type: "uniform" as const } }],
                _bindingCount: 1,
            };
        };

        const color = compileNodePipeline(emitted.state, emitted.vertexWgsl, emitted.fragmentWgsl, {
            _engine: colorFixture.engine,
            _format: "rgba8unorm",
            _msaaSamples: 1,
            _envEmitter: emitEnv,
            _shadowEmitter: emitShadow,
        });
        clearNodePipelineCache();
        const depth = compileNodePipeline(emitted.state, emitted.vertexWgsl, emitted.fragmentWgsl, {
            _engine: depthFixture.engine,
            _format: "rgba8unorm",
            _depthStencilFormat: "depth32float",
            _depthCompare: "less-equal",
            _msaaSamples: 1,
            _noColorOutput: true,
            _envEmitter: emitEnv,
            _shadowEmitter: emitShadow,
        });
        clearNodePipelineCache();
        const esm = compileNodePipeline(emitted.state, emitted.vertexWgsl, emitted.fragmentWgsl, {
            _engine: esmFixture.engine,
            _format: "rgba16float",
            _depthStencilFormat: "depth32float",
            _depthCompare: "less-equal",
            _msaaSamples: 1,
            _esmShadowOutput: true,
            _esmShadowDepthCode: "_NME_FRAG_OUTPUT_ = vec4<f32>(1.0);",
            _envEmitter: emitEnv,
            _shadowEmitter: emitShadow,
        });

        expect(emitted.state.usesMorphTargets).toBe(true);
        expect(emitted.state._vertexFeature).toBeTypeOf("function");
        const feature = emitted.state._vertexFeature!(4);
        expect(feature[0]).toBe(2);
        expect(feature[1]).toBe(EXPECTED_MORPH_WGSL);
        expect(feature[3]).toBe(", @builtin(vertex_index) vertexIndex: u32");
        expect(envStart).toBe(6);
        expect(shadowStart).toBe(10);
        for (const compile of [color, depth, esm]) {
            expect(compile._bindVertexFeature).toBeTypeOf("function");
            expect(compile._wgsl).toContain("@group(1) @binding(4) var<storage, read> morphDeltas");
            expect(compile._wgsl).toContain("@group(1) @binding(5) var<storage, read> morph");
            expect(compile._wgsl).toContain("fn nme_morphPosition");
            expect(compile._wgsl).toContain("fn vs_main(in: VertexIn, @builtin(vertex_index) vertexIndex: u32)");
            expect(compile._wgsl.indexOf("morphDeltasUniforms")).toBeLessThan(compile._wgsl.indexOf("ENV_DECLS"));
        }
        expect(Array.from(colorFixture.meshBgl().entries, (entry) => entry.binding)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(Array.from(depthFixture.meshBgl().entries, (entry) => entry.binding)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(Array.from(esmFixture.meshBgl().entries, (entry) => entry.binding)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        clearNodePipelineCache();
    });

    it("binds real morph buffers without allocating a fallback", () => {
        const feature = createNodeMorphFeature(4);
        const createBuffer = vi.fn();
        const engine = { _device: { createBuffer } } as unknown as EngineContext;
        const deltasBuffer = {} as GPUBuffer;
        const weightsBuffer = {} as GPUBuffer;
        const mesh = { morphTargets: { deltasBuffer, weightsBuffer } } as unknown as Mesh;
        const entries: GPUBindGroupEntry[] = [];

        feature[4](engine, mesh, entries);

        expect(createBuffer).not.toHaveBeenCalled();
        expect(entries).toEqual([
            { binding: 4, resource: { buffer: deltasBuffer } },
            { binding: 5, resource: { buffer: weightsBuffer } },
        ]);
    });

    it("reuses the zero-target fallback and releases the active device generation with the engine", () => {
        const buffers: Array<GPUBuffer & { destroy: ReturnType<typeof vi.fn> }> = [];
        const writeBuffer = vi.fn();
        const createBuffer = vi.fn(() => {
            const buffer = { destroy: vi.fn() } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> };
            buffers.push(buffer);
            return buffer;
        });
        const engine = { _device: { createBuffer, queue: { writeBuffer } } } as unknown as EngineContext;
        const feature = createNodeMorphFeature(6);
        const mesh = { morphTargets: null } as unknown as Mesh;
        const first: GPUBindGroupEntry[] = [];
        const second: GPUBindGroupEntry[] = [];

        feature[4](engine, mesh, first);
        feature[4](engine, mesh, second);

        expect(createBuffer).toHaveBeenCalledOnce();
        expect(createBuffer).toHaveBeenCalledWith(expect.objectContaining({ label: "node-morph-empty", size: 24 }));
        expect(first).toEqual(second);
        expect((first[0]!.resource as GPUBufferBinding).buffer).toBe((first[1]!.resource as GPUBufferBinding).buffer);
        expect(writeBuffer).toHaveBeenCalledOnce();
        const header = writeBuffer.mock.calls[0]![2] as Uint8Array;
        expect(new Uint32Array(header.buffer, header.byteOffset, 2)).toEqual(new Uint32Array([0, 1]));

        engine._disposeManagedResources!();
        expect(buffers.every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(true);
    });

    it("destroys the fallback buffer when initialization fails after allocation", () => {
        const buffers: Array<GPUBuffer & { destroy: ReturnType<typeof vi.fn> }> = [];
        const createBuffer = vi.fn(() => {
            const buffer = { destroy: vi.fn() } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> };
            buffers.push(buffer);
            return buffer;
        });
        const engine = {
            _device: {
                createBuffer,
                queue: {
                    writeBuffer: vi.fn(() => {
                        throw new Error("morph fallback upload failed");
                    }),
                },
            },
        } as unknown as EngineContext;
        const entries: GPUBindGroupEntry[] = [];

        expect(() => createNodeMorphFeature(2)[4](engine, { morphTargets: null } as unknown as Mesh, entries)).toThrow("morph fallback upload failed");
        expect(entries).toHaveLength(0);
        expect(buffers).toHaveLength(1);
        expect(buffers.every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(true);
        expect(engine._disposeManagedResources).toBeUndefined();
    });

    it("replaces and destroys a stale fallback generation after device change", () => {
        const firstBuffers: Array<GPUBuffer & { destroy: ReturnType<typeof vi.fn> }> = [];
        const secondBuffers: Array<GPUBuffer & { destroy: ReturnType<typeof vi.fn> }> = [];
        const makeDevice = (buffers: Array<GPUBuffer & { destroy: ReturnType<typeof vi.fn> }>) =>
            ({
                createBuffer: vi.fn(() => {
                    const buffer = { destroy: vi.fn() } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> };
                    buffers.push(buffer);
                    return buffer;
                }),
                queue: { writeBuffer: vi.fn() },
            }) as unknown as GPUDevice;
        const engine = { _device: makeDevice(firstBuffers) } as unknown as EngineContext;
        const bind = createNodeMorphFeature(2)[4];
        const mesh = { morphTargets: null } as unknown as Mesh;

        bind(engine, mesh, []);
        engine._device = makeDevice(secondBuffers);
        bind(engine, mesh, []);

        expect(firstBuffers.every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(true);
        expect(secondBuffers.every((buffer) => buffer.destroy.mock.calls.length === 0)).toBe(true);
        engine._disposeManagedResources!();
        expect(secondBuffers.every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(true);
    });

    it("reuses one managed-resource registration after teardown and recreation", () => {
        const buffers: Array<GPUBuffer & { destroy: ReturnType<typeof vi.fn> }> = [];
        const makeDevice = () =>
            ({
                createBuffer: vi.fn(() => {
                    const buffer = { destroy: vi.fn() } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> };
                    buffers.push(buffer);
                    return buffer;
                }),
                queue: { writeBuffer: vi.fn() },
            }) as unknown as GPUDevice;
        const engine = { _device: makeDevice() } as unknown as EngineContext;
        const bind = createNodeMorphFeature(2)[4];
        const mesh = { morphTargets: null } as unknown as Mesh;

        bind(engine, mesh, []);
        expect(engine._managedResourceDisposers).toHaveLength(1);
        engine._disposeManagedResources!();

        engine._device = makeDevice();
        bind(engine, mesh, []);
        expect(engine._managedResourceDisposers).toHaveLength(1);
        engine._disposeManagedResources!();

        expect(buffers.every((buffer) => buffer.destroy.mock.calls.length === 1)).toBe(true);
    });
});
