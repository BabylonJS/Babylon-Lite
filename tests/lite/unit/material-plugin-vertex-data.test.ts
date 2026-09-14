import { describe, expect, it } from "vitest";
import { buildPluginFragment } from "../../../packages/babylon-lite/src/material/plugin/plugin-bridge-shared";

describe("material plugin vertex data", () => {
    it("composes custom varyings and vertex-visible resources", () => {
        const fragment = buildPluginFragment(
            [
                {
                    name: "vertex-plugin",
                    getVaryings: () => [{ name: "customValue", type: "vec3<f32>" }],
                    getUniforms: () => ({ ubo: [{ name: "customScale", type: "f32", visibility: "vertex" }] }),
                    getSamplers: () => [{ texture: "customTexture", sampler: "customSampler", visibility: "vertex-fragment" }],
                    getCustomCode: () => ({ CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: "color *= 0.5;" }),
                },
            ],
            1,
            false
        )._fragment;

        expect(fragment._varyings).toEqual([{ _name: "customValue", _type: "vec3<f32>" }]);
        expect(fragment._materialUboVertexVisible).toBe(true);
        expect(fragment._fragmentSlots?.AI).toBeUndefined();
        expect(fragment._fragmentSlots?.NI).toContain("color *= 0.5;");
        expect(fragment._bindings).toEqual([
            { _name: "customTexture", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: 3 },
            { _name: "customSampler", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: 3 },
        ]);
    });

    it("makes the Standard plugin UBO visible and declared in the vertex stage", () => {
        const built = buildPluginFragment(
            [
                {
                    name: "standard-vertex-plugin",
                    getUniforms: () => ({ ubo: [{ name: "customScale", type: "f32", visibility: "vertex" }] }),
                    getCustomCode: () => ({ CUSTOM_VERTEX_MAIN_BEGIN: "let scaled = pluginUbo.customScale;" }),
                },
            ],
            1,
            true
        );

        expect(built._fragment._bindings?.[0]).toMatchObject({ _name: "pluginUbo", _visibility: 3 });
        expect(built._fragment._vertexHelperFunctions).toContain("struct pluginUboUniforms");
    });

    it("rejects varying types that cannot be emitted as interpolated stage IO", () => {
        expect(() =>
            buildPluginFragment(
                [
                    {
                        name: "integer-varying",
                        getVaryings: () => [{ name: "customId", type: "u32" as never }],
                    },
                ],
                1,
                false
            )
        ).toThrow(/varying type "u32" is unsupported/);
    });
});
