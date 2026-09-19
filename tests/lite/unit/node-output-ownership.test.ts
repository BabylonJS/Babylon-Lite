import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createBuildState } from "../../../packages/babylon-lite/src/material/node/node-emitter";
import { createNodeEsmShadowMaterialView } from "../../../packages/babylon-lite/src/material/node/esm-shadow-view";
import { createNodeNoColorMaterialView } from "../../../packages/babylon-lite/src/material/node/no-color-view";
import type { NodeMaterial } from "../../../packages/babylon-lite/src/material/node/node-material";
import { compileNodePipeline } from "../../../packages/babylon-lite/src/material/node/node-pipeline";
import { buildNodeMeshRenderables } from "../../../packages/babylon-lite/src/material/node/node-renderable";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

const modes = ["color", "depth", "esm", "depth-over-esm", "esm-over-depth"] as const;

function fixture(extended: boolean) {
    const pipelines: GPURenderPipelineDescriptor[] = [];
    const device = {
        createBindGroupLayout: vi.fn((d: GPUBindGroupLayoutDescriptor) => d),
        createPipelineLayout: vi.fn((d: GPUPipelineLayoutDescriptor) => d),
        createShaderModule: vi.fn((d: GPUShaderModuleDescriptor) => d),
        createRenderPipeline: vi.fn((d: GPURenderPipelineDescriptor) => {
            pipelines.push(d);
            return d;
        }),
        createBuffer: vi.fn((d: GPUBufferDescriptor) => ({ ...d, destroy: vi.fn() })),
        createBindGroup: vi.fn((d: GPUBindGroupDescriptor) => d),
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    const engine = { _device: device, format: "rgba8unorm", msaaSamples: 4 } as unknown as EngineContext;
    const state = createBuildState();
    state.vertexAttributes.push({ _name: "position", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: 12 });
    state.usesFragDepth = extended;
    if (extended) {
        state.shadowLights.push({ lightIndex: 0, shadowType: "pcf" });
        state.nodeUboFields.push({ _name: "alpha", _type: "f32" });
    }
    const vertex = "_NME_VTX_OUTPUT_ = meshU.world * vec4<f32>(in.position, 1.0);";
    const fragment = extended
        ? "if (nodeU.alpha < 0.4) { discard; }\n_NME_FRAG_DEPTH_ = in.position.z;\n_NME_FRAG_OUTPUT_ = vec4<f32>(1.0);"
        : "_NME_FRAG_OUTPUT_ = vec4<f32>(1.0);";
    const compile = compileNodePipeline(state, vertex, fragment, {
        _engine: engine,
        _format: engine.format,
        _msaaSamples: 4,
        _alphaMode: extended ? 2 : 0,
        _backFaceCulling: !extended,
    });
    const material = {
        _compile: compile,
        _state: state,
        _graph: { backFaceCulling: !extended },
        _vertexBody: vertex,
        _fragmentBody: fragment,
        _vertexAttrNames: ["position"],
        _renderFeatures: { features: 0 },
        _needsAlphaBlending: extended,
        _uniformValues: new Map(),
        _uboDirty: false,
        _shadowGenerators: [],
    } as unknown as NodeMaterial;
    const mesh = {
        material,
        children: [],
        worldMatrix: new Float32Array(16),
        worldMatrixVersion: 0,
        _gpu: { positionBuffer: {}, indexBuffer: {}, indexCount: 3, indexFormat: "uint32" },
    } as unknown as Mesh;
    const scene = { surface: { engine }, lights: [], _disposables: [] } as unknown as SceneContext;
    return { engine, scene, mesh, material, pipelines };
}

describe("Node output ownership", () => {
    for (const extended of [false, true]) {
        it.each(modes)(`preserves cold synchronous %s output (extended=${extended})`, (mode) => {
            const { engine, scene, mesh, material, pipelines } = fixture(extended);
            const shadowBuffer = { label: "shadow-params" } as GPUBuffer;
            const esm = () => createNodeEsmShadowMaterialView(material, shadowBuffer);
            const depth = () => createNodeNoColorMaterialView(material);
            const view =
                mode === "color"
                    ? material
                    : mode === "depth"
                      ? depth()
                      : mode === "esm"
                        ? esm()
                        : mode === "depth-over-esm"
                          ? createNodeNoColorMaterialView(esm() as unknown as NodeMaterial)
                          : createNodeEsmShadowMaterialView(depth() as unknown as NodeMaterial, shadowBuffer);
            const owned = { _lifetimeDisposers: [] as (() => void)[] };
            const result = buildNodeMeshRenderables(scene, [mesh], view, owned);
            const binding = result.renderables[0]!.bind(engine, { _sampleCount: 4, _colorFormat: engine.format });
            const descriptor = pipelines.at(-1)!;
            const shader = vi.mocked(engine._device.createShaderModule).mock.calls.at(-1)![0].code;
            const groups = vi.mocked(engine._device.createBindGroup).mock.calls.map(([d]) => d);
            const observation = JSON.stringify({ descriptor, groups, transparent: !!result.renderables[0]!.isTransparent }, (_key, value: unknown) =>
                typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value
            );
            if (mode === "color" && extended) {
                expect(descriptor.fragment!.targets[0]!.blend?.alpha).toEqual({ srcFactor: "one", dstFactor: "one", operation: "add" });
            }
            // Lock the pre-extraction WGSL, descriptors and binding order, not just source spelling.
            expect(createHash("sha256").update(observation).digest("hex")).toMatchSnapshot();
            expect(binding.pipeline).toBe(descriptor);
            expect(shader).toContain("_NME_FRAG_OUTPUT_");
            if (extended) {
                expect(shader).toContain("discard;");
            }
            expect(descriptor.fragment?.targets).toHaveLength(mode.includes("depth") ? 0 : 1);
            expect(descriptor.depthStencil?.depthCompare).toBe(mode === "color" ? "greater-equal" : "less-equal");
            expect(descriptor.multisample?.count).toBe(mode === "color" ? 4 : 1);
            expect(result.renderables[0]!.isTransparent === true).toBe(mode === "color" && extended);
            const count = pipelines.length;
            buildNodeMeshRenderables(scene, [mesh], view, owned);
            expect(pipelines).toHaveLength(count);
            expect(scene._disposables).toHaveLength(0);
            owned._lifetimeDisposers.forEach((dispose) => dispose());
        });
    }
});
