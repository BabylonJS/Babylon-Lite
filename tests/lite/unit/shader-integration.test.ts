/**
 * Integration tests: compose real PBR/Standard fragments with real templates
 * and verify the output is structurally valid.
 */
import { describe, it, expect } from "vitest";
import { composeShader } from "../../../packages/babylon-lite/src/shader/shader-composer";
import type { ShaderFragment } from "../../../packages/babylon-lite/src/shader/fragment-types";
import { createPbrTemplate } from "../../../packages/babylon-lite/src/material/pbr/pbr-template";
import { createStandardTemplate } from "../../../packages/babylon-lite/src/material/standard/standard-template";
import { createEmissiveColorFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/emissive-fragment";
import { createClearcoatFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/clearcoat-fragment";
import { PBR_HAS_CLEARCOAT } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { createSheenFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/sheen-fragment";
import { createIblFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/ibl-fragment";
import { createSkeletonFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/skeleton-fragment";
import { createMorphFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/morph-fragment";
import { createThinInstanceFragment } from "../../../packages/babylon-lite/src/shader/fragments/thin-instance-fragment";
import { createPbrShadowFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/pbr-shadow-fragment";
import { createNormalMapFragment } from "../../../packages/babylon-lite/src/material/standard/fragments/normal-map-fragment";
import type { PbrTemplateConfig } from "../../../packages/babylon-lite/src/material/pbr/pbr-template";

const defaultPbrConfig: PbrTemplateConfig = {
    _normalMode: "none",
    _hasEmissiveTexture: false,
    _hasSpecGloss: false,
    _hasDoubleSided: false,
    _hasTonemap: false,
    _hasAlphaBlend: false,
    _hasSpecularAA: false,
    _hasGammaAlbedo: false,
    _hasMorph: false,
    _hasOcclusion: false,
    _hasEmissiveColor: false,
    _hasReflectanceExt: false,
    _hasIbl: false,
};

// ── PBR Template Integration ────────────────────────────────────

describe("PBR template + fragments integration", () => {
    it("composes minimal PBR (no extensions)", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig });
        const result = composeShader(template, []);
        expect(result._vertexWGSL).toContain("@vertex fn main");
        expect(result._vertexWGSL).toContain("struct SceneUniforms");
        expect(result._vertexWGSL).toContain("struct MeshUniforms");
        expect(result._vertexWGSL).toContain("var finalWorld = mesh.world;");
        expect(result._fragmentWGSL).toContain("@fragment fn main");
        expect(result._fragmentWGSL).toContain("distributionGGX");
        expect(result._fragmentWGSL).toContain("fresnelSchlick");
        expect(result._meshUboSpec._totalBytes).toBe(144); // world matrix + per-mesh light-selection data
        expect(result._materialUboSpec).toBeDefined();
    });

    it("composes PBR + emissive color", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig, _normalMode: "tangent", _hasTonemap: true, _hasEmissiveColor: true });
        const result = composeShader(template, [createEmissiveColorFragment(false)]);
        expect(result._fragmentWGSL).toContain("material.emissiveColor");
        expect(result._materialUboSpec!._offsets.has("emissiveColor")).toBe(true);
    });

    it("composes PBR emissive-color fallback when the emissive fragment is absent", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig, _normalMode: "tangent", _hasTonemap: true, _hasEmissiveColor: true });
        const result = composeShader(template, []);
        expect(result._fragmentWGSL).toContain("var emissive:vec3f;");
        expect(result._fragmentWGSL).toContain("directDiffuse+directSpecular+emissive");
        expect(result._materialUboSpec!._offsets.has("emissiveColor")).toBe(false);
    });

    it("composes PBR + clearcoat", () => {
        const template = createPbrTemplate({
            ...defaultPbrConfig,
            _normalMode: "tangent",
            _hasEmissiveTexture: true,
            _hasTonemap: true,
        });
        const result = composeShader(template, [createClearcoatFragment(PBR_HAS_CLEARCOAT, 0, false, false, false)!]);
        expect(result._fragmentWGSL).toContain("visibility_Kelemen");
        expect(result._fragmentWGSL).toContain("getR0RemappedForClearCoat");
        expect(result._fragmentWGSL).toContain("material.ccParams");
        expect(result._materialUboSpec!._offsets.has("ccParams")).toBe(true);
    });

    it("composes PBR + sheen", () => {
        const template = createPbrTemplate({
            ...defaultPbrConfig,
            _normalMode: "tangent",
            _hasEmissiveTexture: true,
            _hasTonemap: true,
        });
        const result = composeShader(template, [createSheenFragment(false, false)]);
        expect(result._fragmentWGSL).toContain("normalDistributionFunction_CharlieSheen");
        expect(result._fragmentWGSL).toContain("visibility_Ashikhmin");
        expect(result._fragmentWGSL).toContain("sheenColorFinal");
        expect(result._materialUboSpec!._offsets.has("sheenParams")).toBe(true);
    });

    it("composes PBR + IBL (env)", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig, _normalMode: "tangent", _hasTonemap: true, _hasSpecularAA: true, _hasIbl: true });
        const result = composeShader(template, [createIblFragment(true)]);
        expect(result._fragmentWGSL).toContain("environmentHorizonOcclusion");
        expect(result._fragmentWGSL).toContain("iblTexture");
        expect(result._fragmentWGSL).toContain("brdfLUT");
        expect(result._fragmentWGSL).toContain("vSphericalL00");
        // 4 IBL bindings in group 1
        expect((result._meshBGLDescriptor.entries as unknown as GPUBindGroupLayoutEntry[]).length).toBeGreaterThanOrEqual(5); // mesh UBO + base textures + 4 IBL
        // Scene UBO should include canonical SH coefficients
        expect(result._vertexWGSL).toContain("vSphericalL00");
    });

    it("composes PBR + skeleton (4-bone)", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig, _normalMode: "tangent" });
        const result = composeShader(template, [createSkeletonFragment(false)]);
        expect(result._vertexWGSL).toContain("readMatrixFromRawSampler");
        expect(result._vertexWGSL).toContain("finalWorld = mesh.world * influence");
        // Skeleton vertex binding (bone texture)
        expect((result._meshBGLDescriptor.entries as unknown as GPUBindGroupLayoutEntry[]).length).toBeGreaterThanOrEqual(2);
        // Should have extra vertex buffer layouts for joints/weights
        expect(result._vertexBufferLayouts.length).toBeGreaterThanOrEqual(5); // pos + normal + tangent + uv + joints + weights
    });

    it("composes PBR + skeleton (8-bone) with complete vertex buffer layouts", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig, _normalMode: "tangent" });
        const result = composeShader(template, [createSkeletonFragment(true)]);

        expect(result._vertexWGSL).toContain("joints1");
        expect(result._vertexWGSL).toContain("weights1");
        expect(result._vertexWGSL).not.toContain("undefined");
        expect(result._vertexBufferLayouts.every((layout) => layout.arrayStride !== undefined)).toBe(true);
        expect(
            result._vertexBufferLayouts.some((layout) =>
                (layout.attributes as unknown as GPUVertexAttribute[]).some((attribute: GPUVertexAttribute) => attribute.shaderLocation === 6 && attribute.format === "uint32x4")
            )
        ).toBe(true);
        expect(
            result._vertexBufferLayouts.some((layout) =>
                (layout.attributes as unknown as GPUVertexAttribute[]).some((attribute: GPUVertexAttribute) => attribute.shaderLocation === 7 && attribute.format === "float32x4")
            )
        ).toBe(true);
    });

    it("composes PBR + morph + skeleton", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig, _normalMode: "tangent", _hasMorph: true });
        const morph = createMorphFragment();
        const skeleton = createSkeletonFragment(false);
        const result = composeShader(template, [morph, skeleton]);
        expect(result._vertexWGSL).toContain("morphedPos");
        expect(result._vertexWGSL).toContain("morphedNorm");
        expect(result._vertexWGSL).toContain("readMatrixFromRawSampler");
        expect(result._fragmentKey).toBe("morph|skeleton");
    });

    it("composes PBR + thin instance + instance color", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig });
        const result = composeShader(template, [createThinInstanceFragment(true)]);
        expect(result._vertexWGSL).toContain("world0");
        expect(result._vertexWGSL).toContain("world1");
        expect(result._vertexWGSL).toContain("instanceWorld");
        expect(result._vertexWGSL).toContain("vInstanceColor");
        expect(result._fragmentWGSL).toContain("vInstanceColor");
        // Instance buffer layout
        const tiLayout = result._vertexBufferLayouts.find((l) => l.stepMode === "instance" && l.arrayStride === 64);
        expect(tiLayout).toBeDefined();
        expect((tiLayout!.attributes as unknown as GPUVertexAttribute[]).length).toBe(4); // world0-3
    });

    it("composes PBR + shadow", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig, _normalMode: "tangent" });
        const result = composeShader(template, [createPbrShadowFragment()]);
        expect(result._fragmentWGSL).toContain("computeShadowESM_0");
        expect(result._fragmentWGSL).toContain("@group(2)");
        expect(result._shadowBGLDescriptor).not.toBeNull();
        expect((result._shadowBGLDescriptor!.entries as unknown as GPUBindGroupLayoutEntry[]).length).toBe(3);
    });

    it("composes full PBR (IBL + clearcoat + sheen + emissive + shadow)", () => {
        const template = createPbrTemplate({
            ...defaultPbrConfig,
            _normalMode: "tangent",
            _hasEmissiveTexture: true,
            _hasTonemap: true,
            _hasSpecularAA: true,
            _hasEmissiveColor: true,
            _hasIbl: true,
        });
        const fragments: ShaderFragment[] = [
            createIblFragment(true),
            createClearcoatFragment(PBR_HAS_CLEARCOAT, 0, true, false, true)!,
            createSheenFragment(false, true),
            createEmissiveColorFragment(true),
            createPbrShadowFragment(),
        ];
        const result = composeShader(template, fragments);
        // All helpers present
        expect(result._fragmentWGSL).toContain("visibility_Kelemen");
        expect(result._fragmentWGSL).toContain("normalDistributionFunction_CharlieSheen");
        expect(result._fragmentWGSL).toContain("environmentHorizonOcclusion");
        expect(result._fragmentWGSL).toContain("computeShadowESM_0");
        // UBO has all extension fields (in materialUboSpec, not meshUboSpec — split UBOs)
        expect(result._materialUboSpec!._offsets.has("ccParams")).toBe(true);
        expect(result._materialUboSpec!._offsets.has("sheenParams")).toBe(true);
        expect(result._materialUboSpec!._offsets.has("emissiveColor")).toBe(true);
        // Fragment key is deterministic
        expect(result._fragmentKey).toContain("clearcoat");
        expect(result._fragmentKey).toContain("sheen");
        expect(result._fragmentKey).toContain("ibl");
    });
});

// ── Standard Template Integration ───────────────────────────────

describe("Standard template + fragments integration", () => {
    it("composes minimal Standard (no textures)", () => {
        const template = createStandardTemplate({
            _needsUV: false,
            _needsUV2: false,
        });
        const result = composeShader(template, []);
        expect(result._vertexWGSL).toContain("@vertex fn main");
        expect(result._vertexWGSL).toContain("var finalWorld = mesh.world;");
        expect(result._fragmentWGSL).toContain("@fragment fn main");
        expect(result._fragmentWGSL).toContain("calcFogFactor");
    });

    it("composes Standard + diffuse texture", () => {
        const template = createStandardTemplate({
            _diffuse: true,
            _needsUV: true,
            _needsUV2: false,
        });
        const result = composeShader(template, []);
        expect(result._fragmentWGSL).toContain("@group(1)@binding(2) var dT:texture_2d<f32>");
        expect(result._fragmentWGSL).toContain("@group(1)@binding(3) var dS:sampler");
        expect(result._fragmentWGSL).toContain("textureSample(dT, dS, input.vu)");
        expect(result._vertexWGSL).toContain("uv");
    });

    it("composes Standard + thin instances", () => {
        const template = createStandardTemplate({
            _diffuse: true,
            _needsUV: true,
            _needsUV2: false,
        });
        const result = composeShader(template, [createThinInstanceFragment(true)]);
        expect(result._vertexWGSL).toContain("instanceWorld");
        expect(result._vertexWGSL).toContain("vInstanceColor");
        expect(result._fragmentWGSL).toContain("vInstanceColor");
    });

    it("composes Standard + bump + fog", () => {
        const template = createStandardTemplate({
            _diffuse: true,
            _needsUV: true,
            _needsUV2: false,
        });
        const result = composeShader(template, [createNormalMapFragment()]);
        expect(result._fragmentWGSL).toContain("perturbNormal");
        expect(result._fragmentWGSL).toContain("calcFogFactor");
    });
});
