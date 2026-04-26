/**
 * Integration tests: compose real PBR/Standard fragments with real templates
 * and verify the output is structurally valid.
 */
import { describe, it, expect } from "vitest";
import { composeShader } from "../../packages/babylon-lite/src/shader/shader-composer";
import type { ShaderFragment } from "../../packages/babylon-lite/src/shader/fragment-types";
import { createPbrTemplate } from "../../packages/babylon-lite/src/material/pbr/pbr-template";
import { createStandardTemplate } from "../../packages/babylon-lite/src/material/standard/standard-template";
import { createEmissiveColorFragment } from "../../packages/babylon-lite/src/material/pbr/fragments/emissive-fragment";
import { createClearcoatFragment } from "../../packages/babylon-lite/src/material/pbr/fragments/clearcoat-fragment";
import { PBR_HAS_CLEARCOAT } from "../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { createSheenFragment } from "../../packages/babylon-lite/src/material/pbr/fragments/sheen-fragment";
import { createIblFragment } from "../../packages/babylon-lite/src/material/pbr/fragments/ibl-fragment";
import { createSkeletonFragment } from "../../packages/babylon-lite/src/material/pbr/fragments/skeleton-fragment";
import { createMorphFragment } from "../../packages/babylon-lite/src/material/pbr/fragments/morph-fragment";
import { createThinInstanceFragment } from "../../packages/babylon-lite/src/shader/fragments/thin-instance-fragment";
import { createPbrShadowFragment } from "../../packages/babylon-lite/src/material/pbr/fragments/pbr-shadow-fragment";
import { createNormalMapFragment } from "../../packages/babylon-lite/src/material/standard/fragments/normal-map-fragment";
import type { PbrLightConfig } from "../../packages/babylon-lite/src/material/pbr/pbr-template";

const hemisphericLight: PbrLightConfig = {
    sceneUboFields: [
        { name: "lightDirection", type: "vec3<f32>" },
        { name: "lightIntensity", type: "f32" },
        { name: "lightDiffuseColor", type: "vec3<f32>" },
        { name: "_pad1", type: "f32" },
        { name: "lightGroundColor", type: "vec3<f32>" },
    ],
    lightVectorCode: `let L = normalize(scene.lightDirection);\nlet NdotL = dot(N, L) * 0.5 + 0.5;\nlet lightAtten = 1.0;`,
    directDiffuseCode: `surfaceAlbedo * (1.0 / PI) * NdotL * lightColor * mesh.directIntensity;`,
    geometricAACode: "",
};

const defaultPbrConfig = {
    light: hemisphericLight,
    normalMode: "none" as const,
    hasEmissiveTexture: false,
    hasSpecGloss: false,
    hasDoubleSided: false,
    hasTonemap: false,
    hasAlphaBlend: false,
    hasSpecularAA: false,
    hasGammaAlbedo: false,
    hasMorph: false,
    hasOcclusion: false,
    hasSheenTexture: false,
    hasEmissiveColor: false,
    hasReflectanceExt: false,
    hasIbl: false,
    hasClearcoat: false,
    hasSheen: false,
};

// ── PBR Template Integration ────────────────────────────────────

describe("PBR template + fragments integration", () => {
    it("composes minimal PBR (no extensions)", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig });
        const result = composeShader(template, []);
        expect(result.vertexWGSL).toContain("@vertex fn main");
        expect(result.vertexWGSL).toContain("struct SceneUniforms");
        expect(result.vertexWGSL).toContain("struct MeshUniforms");
        expect(result.vertexWGSL).toContain("var finalWorld = mesh.world;");
        expect(result.fragmentWGSL).toContain("@fragment fn main");
        expect(result.fragmentWGSL).toContain("distributionGGX");
        expect(result.fragmentWGSL).toContain("fresnelSchlick");
        expect(result.meshUboSpec.totalBytes).toBe(64); // world matrix only — uv transforms now per-texture on material UBO
        expect(result.materialUboSpec).toBeDefined();
    });

    it("composes PBR + emissive color", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig, normalMode: "tangent", hasTonemap: true, hasEmissiveColor: true });
        const result = composeShader(template, [createEmissiveColorFragment(false)]);
        expect(result.fragmentWGSL).toContain("material.emissiveColor");
        expect(result.materialUboSpec!.offsets.has("emissiveColor")).toBe(true);
    });

    it("composes PBR + clearcoat", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig, normalMode: "tangent", hasEmissiveTexture: true, hasTonemap: true, hasClearcoat: true });
        const result = composeShader(template, [createClearcoatFragment(PBR_HAS_CLEARCOAT, 0, false, false, false)!]);
        expect(result.fragmentWGSL).toContain("visibility_Kelemen");
        expect(result.fragmentWGSL).toContain("getR0RemappedForClearCoat");
        expect(result.fragmentWGSL).toContain("material.ccParams");
        expect(result.materialUboSpec!.offsets.has("ccParams")).toBe(true);
    });

    it("composes PBR + sheen", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig, normalMode: "tangent", hasEmissiveTexture: true, hasTonemap: true, hasSheen: true });
        const result = composeShader(template, [createSheenFragment(false, false)]);
        expect(result.fragmentWGSL).toContain("normalDistributionFunction_CharlieSheen");
        expect(result.fragmentWGSL).toContain("visibility_Ashikhmin");
        expect(result.fragmentWGSL).toContain("sheenColorFinal");
        expect(result.materialUboSpec!.offsets.has("sheenParams")).toBe(true);
    });

    it("composes PBR + IBL (env)", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig, normalMode: "tangent", hasTonemap: true, hasSpecularAA: true, hasIbl: true });
        const result = composeShader(template, [createIblFragment(true)]);
        expect(result.fragmentWGSL).toContain("environmentHorizonOcclusion");
        expect(result.fragmentWGSL).toContain("iblTexture");
        expect(result.fragmentWGSL).toContain("brdfLUT");
        expect(result.fragmentWGSL).toContain("vSphericalL00");
        // 4 IBL bindings in group 1
        expect(result.meshBGLDescriptor.entries.length).toBeGreaterThanOrEqual(5); // mesh UBO + base textures + 4 IBL
        // Scene UBO should include SH coefficients
        expect(result.sceneUboSpec.offsets.has("vSphericalL00")).toBe(true);
    });

    it("composes PBR + skeleton (4-bone)", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig, normalMode: "tangent" });
        const result = composeShader(template, [createSkeletonFragment(false)]);
        expect(result.vertexWGSL).toContain("readMatrixFromRawSampler");
        expect(result.vertexWGSL).toContain("finalWorld = mesh.world * influence");
        // Skeleton vertex binding (bone texture)
        expect(result.meshBGLDescriptor.entries.length).toBeGreaterThanOrEqual(2);
        // Should have extra vertex buffer layouts for joints/weights
        expect(result.vertexBufferLayouts.length).toBeGreaterThanOrEqual(5); // pos + normal + tangent + uv + joints + weights
    });

    it("composes PBR + morph + skeleton", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig, normalMode: "tangent", hasMorph: true });
        const morph = createMorphFragment();
        const skeleton = createSkeletonFragment(false);
        const result = composeShader(template, [morph, skeleton]);
        expect(result.vertexWGSL).toContain("morphedPos");
        expect(result.vertexWGSL).toContain("morphedNorm");
        expect(result.vertexWGSL).toContain("readMatrixFromRawSampler");
        expect(result.fragmentKey).toBe("morph|skeleton");
    });

    it("composes PBR + thin instance + instance color", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig });
        const result = composeShader(template, [createThinInstanceFragment(true)]);
        expect(result.vertexWGSL).toContain("world0");
        expect(result.vertexWGSL).toContain("world1");
        expect(result.vertexWGSL).toContain("instanceWorld");
        expect(result.vertexWGSL).toContain("vInstanceColor");
        expect(result.fragmentWGSL).toContain("vInstanceColor");
        // Instance buffer layout
        const tiLayout = result.vertexBufferLayouts.find((l) => l.stepMode === "instance" && l.arrayStride === 64);
        expect(tiLayout).toBeDefined();
        expect(tiLayout!.attributes.length).toBe(4); // world0-3
    });

    it("composes PBR + shadow", () => {
        const template = createPbrTemplate({ ...defaultPbrConfig, normalMode: "tangent" });
        const result = composeShader(template, [createPbrShadowFragment()]);
        expect(result.fragmentWGSL).toContain("computeShadowESM_0");
        expect(result.fragmentWGSL).toContain("@group(2)");
        expect(result.shadowBGLDescriptor).not.toBeNull();
        expect(result.shadowBGLDescriptor!.entries.length).toBe(3);
    });

    it("composes full PBR (IBL + clearcoat + sheen + emissive + shadow)", () => {
        const template = createPbrTemplate({
            ...defaultPbrConfig,
            normalMode: "tangent",
            hasEmissiveTexture: true,
            hasTonemap: true,
            hasSpecularAA: true,
            hasEmissiveColor: true,
            hasIbl: true,
            hasClearcoat: true,
            hasSheen: true,
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
        expect(result.fragmentWGSL).toContain("visibility_Kelemen");
        expect(result.fragmentWGSL).toContain("normalDistributionFunction_CharlieSheen");
        expect(result.fragmentWGSL).toContain("environmentHorizonOcclusion");
        expect(result.fragmentWGSL).toContain("computeShadowESM_0");
        // UBO has all extension fields (in materialUboSpec, not meshUboSpec — split UBOs)
        expect(result.materialUboSpec!.offsets.has("ccParams")).toBe(true);
        expect(result.materialUboSpec!.offsets.has("sheenParams")).toBe(true);
        expect(result.materialUboSpec!.offsets.has("emissiveColor")).toBe(true);
        // Fragment key is deterministic
        expect(result.fragmentKey).toContain("clearcoat");
        expect(result.fragmentKey).toContain("sheen");
        expect(result.fragmentKey).toContain("ibl");
    });
});

// ── Standard Template Integration ───────────────────────────────

describe("Standard template + fragments integration", () => {
    it("composes minimal Standard (no textures)", () => {
        const template = createStandardTemplate({
            textures: {},
            needsUV: false,
            needsUV2: false,
            hasShadow: false,
        });
        const result = composeShader(template, []);
        expect(result.vertexWGSL).toContain("@vertex fn main");
        expect(result.vertexWGSL).toContain("var finalWorld = mesh.world;");
        expect(result.fragmentWGSL).toContain("@fragment fn main");
        expect(result.fragmentWGSL).toContain("calcFogFactor");
    });

    it("composes Standard + diffuse texture", () => {
        const template = createStandardTemplate({
            textures: { diffuse: true },
            needsUV: true,
            needsUV2: false,
            hasShadow: false,
        });
        const result = composeShader(template, []);
        expect(result.fragmentWGSL).toContain("diffuseTexture");
        expect(result.vertexWGSL).toContain("uv");
    });

    it("composes Standard + thin instances", () => {
        const template = createStandardTemplate({
            textures: { diffuse: true },
            needsUV: true,
            needsUV2: false,
            hasShadow: false,
        });
        const result = composeShader(template, [createThinInstanceFragment(true)]);
        expect(result.vertexWGSL).toContain("instanceWorld");
        expect(result.vertexWGSL).toContain("vInstanceColor");
        expect(result.fragmentWGSL).toContain("vInstanceColor");
    });

    it("composes Standard + bump + fog", () => {
        const template = createStandardTemplate({
            textures: { diffuse: true, bump: true },
            needsUV: true,
            needsUV2: false,
            hasShadow: false,
        });
        const result = composeShader(template, [createNormalMapFragment()]);
        expect(result.fragmentWGSL).toContain("perturbNormal");
        expect(result.fragmentWGSL).toContain("calcFogFactor");
    });
});
