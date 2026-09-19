import { describe, expect, it } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { reconcileMaterialPlugins } from "../../../packages/babylon-lite/src/material/plugin/enable-material-plugins";
import { enablePbrMaterialPluginVertexData } from "../../../packages/babylon-lite/src/material/plugin/enable-pbr-material-plugin-vertex-data";
import type { MaterialPlugin } from "../../../packages/babylon-lite/src/material/plugin/material-plugin";
import { registerPbrVertexPlugins } from "../../../packages/babylon-lite/src/material/plugin/pbr-plugin-vertex-bridge";
import { buildPbrVertexPluginFragment } from "../../../packages/babylon-lite/src/material/plugin/pbr-plugin-vertex-data";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { PbrExt } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { addToScene, createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { ComposedShader } from "../../../packages/babylon-lite/src/shader/fragment-types";

function makeEngine(): EngineContext {
    const device = {
        createBuffer: (descriptor: GPUBufferDescriptor) => {
            const bytes = new ArrayBuffer(Number(descriptor.size));
            return { destroy: () => {}, getMappedRange: () => bytes, unmap: () => {} } as unknown as GPUBuffer;
        },
        createBindGroupLayout: (descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout,
        createBindGroup: (descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup,
        createPipelineLayout: (descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout,
        createShaderModule: (descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule,
        createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline,
        createSampler: (descriptor: GPUSamplerDescriptor) => descriptor as unknown as GPUSampler,
        createTexture: () => ({ createView: () => ({}), destroy: () => {} }) as unknown as GPUTexture,
        queue: { writeBuffer: () => {}, writeTexture: () => {} },
    } as unknown as GPUDevice;
    const engine = { _device: device, _disposables: [], format: "rgba8unorm" } as unknown as EngineContext;
    Object.assign(engine, { engine });
    return engine;
}

function makeMesh(material: Mesh["material"]): Mesh {
    const worldMatrix = new Float32Array(16);
    worldMatrix[0] = worldMatrix[5] = worldMatrix[10] = worldMatrix[15] = 1;
    return { material, worldMatrix, worldMatrixVersion: 1, receiveShadows: false, morphTargets: null, _gpu: {} } as unknown as Mesh;
}

const signature: RenderTargetSignature = { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth24plus", _sampleCount: 1 };

function shaders(pipeline: GPURenderPipeline): { vertex: string; fragment: string } {
    const descriptor = pipeline as unknown as GPURenderPipelineDescriptor;
    return {
        vertex: (descriptor.vertex.module as unknown as GPUShaderModuleDescriptor).code,
        fragment: (descriptor.fragment!.module as unknown as GPUShaderModuleDescriptor).code,
    };
}

describe("material plugin vertex data", () => {
    it("registers with the fragment id prefix used for PBR binding dispatch", () => {
        let extension: PbrExt | undefined;
        registerPbrVertexPlugins((value) => {
            extension = value;
        });
        expect(extension?.id).toBe("plugin");
    });

    it("composes custom varyings and vertex-visible resources", () => {
        const fragment = buildPbrVertexPluginFragment(
            [
                {
                    name: "vertex-plugin",
                    getVaryings: () => [{ name: "customValue", type: "vec3<f32>" }],
                    getUniforms: () => ({ ubo: [{ name: "customScale", type: "f32", visibility: "vertex" }] }),
                    getSamplers: () => [{ texture: "customTexture", sampler: "customSampler", visibility: "vertex-fragment" }],
                    getCustomCode: () => ({ CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: "color *= 0.5;" }),
                },
            ],
            1
        );

        expect(fragment._varyings).toEqual([{ _name: "customValue", _type: "vec3<f32>" }]);
        expect(fragment._pc).toBeTypeOf("function");
        expect(fragment._fragmentSlots?.AI).toBeUndefined();
        expect(fragment._fragmentSlots?.NI).toContain("color *= 0.5;");
        expect(fragment._bindings).toEqual([
            { _name: "customTexture", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: 3 },
            { _name: "customSampler", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: 3 },
        ]);

        const patched = fragment._pc!({
            _vertexWGSL: "@vertex fn mainVertex() {}",
            _fragmentWGSL: "",
            _meshBGLDescriptor: {
                entries: [
                    { binding: 0, visibility: 3, buffer: { type: "uniform" } },
                    { binding: 1, visibility: 2, buffer: { type: "uniform" } },
                ],
            },
            _shadowBGLDescriptor: null,
            _vertexBufferLayouts: [],
            _meshUboSpec: { _totalBytes: 0, _offsets: new Map(), _structBody: "" },
            _materialUboSpec: { _totalBytes: 16, _offsets: new Map([["customScale", 0]]), _structBody: "customScale:f32," },
            _fragmentKey: "plugin-1",
        } as unknown as ComposedShader);
        expect(patched._vertexWGSL).toContain("@group(1)@binding(1) var<uniform> material:MaterialUniforms;");
        expect((patched._meshBGLDescriptor.entries as GPUBindGroupLayoutEntry[])[1]!.visibility).toBe(3);
    });

    it("rejects varying types that cannot be emitted as interpolated stage IO", () => {
        expect(() =>
            buildPbrVertexPluginFragment(
                [
                    {
                        name: "integer-varying",
                        getVaryings: () => [{ name: "customId", type: "u32" as never }],
                    },
                ],
                1
            )
        ).toThrow(/varying type "u32" is unsupported/);
    });

    it("preserves the vertex-resource bridge when a live plugin is reconciled", async () => {
        const engine = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        let revision = 1;
        const plugin: MaterialPlugin = {
            name: "reconciled-vertex-plugin",
            getVaryings: () => [{ name: "customValue", type: "vec3<f32>" }],
            getUniforms: () => ({ ubo: [{ name: "customScale", type: "f32", visibility: "vertex" }] }),
            getCustomCode: (stage) =>
                stage === "vertex"
                    ? {
                          CUSTOM_VERTEX_MAIN_END: `out.customValue=vec3f(material.customScale);// revision ${revision}`,
                      }
                    : {
                          CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `color*=in.customValue;// revision ${revision}`,
                      },
        };
        const material = createPbrMaterial({ plugins: [plugin] });
        const mesh = makeMesh(material);
        addToScene(scene, mesh);
        scene._groups.set(material._buildGroup, [mesh]);
        enablePbrMaterialPluginVertexData();

        const result = await buildPbrRenderables(scene, [mesh], undefined);
        const first = shaders(result.renderables[0]!.bind(engine, signature).pipeline);
        expect(first.vertex).toContain("revision 1");
        expect(first.vertex).toContain("customValue");
        expect(first.vertex).toContain("var<uniform> material:MaterialUniforms");

        revision = 2;
        await reconcileMaterialPlugins(scene, material);
        const reconciled = shaders(result.rebuildSingle(scene, mesh).bind(engine, signature).pipeline);
        expect(reconciled.vertex).toContain("revision 2");
        expect(reconciled.vertex).toContain("customValue");
        expect(reconciled.vertex).toContain("var<uniform> material:MaterialUniforms");
        expect(reconciled.fragment).toContain("revision 2");
    });
});
