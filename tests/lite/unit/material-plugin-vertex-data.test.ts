import { describe, expect, it } from "vitest";
import { registerPbrVertexPlugins } from "../../../packages/babylon-lite/src/material/plugin/pbr-plugin-vertex-bridge";
import { buildPbrVertexPluginFragment } from "../../../packages/babylon-lite/src/material/plugin/pbr-plugin-vertex-data";
import type { PbrExt } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags";
import type { ComposedShader } from "../../../packages/babylon-lite/src/shader/fragment-types";

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
});
