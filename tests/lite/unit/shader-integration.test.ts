/**
 * Integration tests: compose real PBR/Standard fragments with real templates
 * and verify the output is structurally valid.
 */
import { describe, it, expect, vi } from "vitest";
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
import { createShadowOnlyFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/shadow-only-fragment";
import { createNormalMapFragment } from "../../../packages/babylon-lite/src/material/standard/fragments/normal-map-fragment";
import type { PbrTemplateConfig } from "../../../packages/babylon-lite/src/material/pbr/pbr-template";
import {
    clearStandardPipelineCache,
    composeStandardShader,
    getOrCreateStandardBindings,
    writeStandardUvTransformData,
} from "../../../packages/babylon-lite/src/material/standard/standard-pipeline";
import { createStandardFogFragment } from "../../../packages/babylon-lite/src/material/standard/std-fog-wgsl";
import { createStdCsmShadowFragment } from "../../../packages/babylon-lite/src/material/standard/fragments/std-csm-shadow-fragment";
import { HAS_SKELETON, HAS_SKELETON_8, VERTEX_ALPHA, STD_SCENE_FOG } from "../../../packages/babylon-lite/src/material/standard/standard-flags";
import { stdSkeletonExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-skeleton-fragment";
import { createStdVertexColorFragment } from "../../../packages/babylon-lite/src/material/standard/fragments/std-vertex-color-fragment";
import { composeStandardGeometryShader } from "../../../packages/babylon-lite/src/material/standard/standard-geometry-output-shader";
import { createStandardGeometrySkeletonVelocity } from "../../../packages/babylon-lite/src/material/standard/standard-geometry-skeleton-velocity";
import { GeometryTextureType } from "../../../packages/babylon-lite/src/frame-graph/geometry-types";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import { enableStandardSkeleton, enableStandardUvOffset } from "../../../packages/babylon-lite/src/material/standard/enable-standard-mesh-features";
import { _getStandardGeometrySkeletonVelocityFactory, preloadStandardGeometryFeatures } from "../../../packages/babylon-lite/src/material/standard/geometry-view";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";

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

    it("composes PBR + shadow-only (BC color/alpha override + FA final-alpha override)", () => {
        // The FA slot only exists in the template's alpha-blend branch, so shadow-only
        // requires _hasAlphaBlend (which its detect() forces via PBR_HAS_ALPHA_BLEND).
        const template = createPbrTemplate({ ...defaultPbrConfig, _hasAlphaBlend: true });
        const result = composeShader(template, [createShadowOnlyFragment()]);
        // BC slot overrides color/alpha with the shadow-only outputs.
        expect(result._fragmentWGSL).toContain("color = material.shadowOnlyColor;");
        expect(result._fragmentWGSL).toContain("material.shadowOnlyFalloff");
        // FA slot overrides finalAlpha after the luminance fold.
        expect(result._fragmentWGSL).toContain("finalAlpha = alpha * material.materialAlpha;");
        // The FA override must appear AFTER the luminanceOverAlpha accumulation so it
        // bypasses the environment/specular bleed into the shadow catcher's alpha.
        const foldIdx = result._fragmentWGSL.indexOf("luminanceOverAlpha*luminanceOverAlpha");
        const faIdx = result._fragmentWGSL.indexOf("finalAlpha = alpha * material.materialAlpha;");
        expect(foldIdx).toBeGreaterThanOrEqual(0);
        expect(faIdx).toBeGreaterThan(foldIdx);
        expect(result._materialUboSpec!._offsets.has("shadowOnlyColor")).toBe(true);
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
        expect(result._fragmentWGSL).not.toContain("calcFogFactor");
        expect(result._vertexWGSL).not.toContain("out.vf");
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

    it("composes Standard + bump without retaining fog", () => {
        const template = createStandardTemplate({
            _diffuse: true,
            _needsUV: true,
            _needsUV2: false,
        });
        const result = composeShader(template, [createNormalMapFragment()]);
        expect(result._fragmentWGSL).toContain("perturbNormal");
        expect(result._fragmentWGSL).not.toContain("calcFogFactor");
    });

    it("composes fog only with an explicit Standard scene context", () => {
        const result = composeStandardShader(0, 0, [], "", {
            _features: STD_SCENE_FOG,
            _fragments: [createStandardFogFragment()],
        });
        expect(result._vertexWGSL).toContain("out.vf");
        expect(result._fragmentWGSL).toContain("fn calcFogFactor");
        expect(result._fragmentWGSL).toContain("mix(scene.vFogColor.rgb, color.rgb, fog)");
    });

    it("keeps fog and non-fog Standard bindings separate on one device", () => {
        clearStandardPipelineCache();
        clearSceneBGLCache();
        const device = {
            createBindGroupLayout: (descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout,
            createPipelineLayout: (descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout,
            createShaderModule: (descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule,
        } as unknown as GPUDevice;
        const engine = { _device: device } as EngineContext;
        const noFog = getOrCreateStandardBindings(engine, 0, 0);
        const fog = getOrCreateStandardBindings(engine, 0, 0, [], "", "", null, {
            _features: STD_SCENE_FOG,
            _fragments: [createStandardFogFragment()],
        });
        expect(fog).not.toBe(noFog);
        expect(noFog._composed._fragmentWGSL).not.toContain("calcFogFactor");
        expect(fog._composed._fragmentWGSL).toContain("calcFogFactor");
        expect(noFog._sceneFeatures).toBe(0);
        expect(fog._sceneFeatures).toBe(STD_SCENE_FOG);
    });

    it("composes Standard CSM without depending on the fog-only varying", () => {
        const result = composeStandardShader(0, 0, [createStdCsmShadowFragment([{ lightIndex: 0 }])], "");
        expect(result._fragmentWGSL).toContain("(scene.view * vec4<f32>(input.vp, 1.0)).z");
        expect(result._fragmentWGSL).not.toContain("input.vf");
        expect(result._vertexWGSL).not.toContain("out.vf");
        expect(result._fragmentWGSL).not.toContain("calcFogFactor");
    });

    it("writes zero UV offsets when the global opt-in is enabled but a material has no offset", () => {
        enableStandardUvOffset();
        const material = createStandardMaterial();
        material.uvScale = [2, 3];
        const data = new Float32Array(4);
        writeStandardUvTransformData(data, material, false);
        expect([...data]).toEqual([2, 3, 0, 0]);
        writeStandardUvTransformData(data, material, true);
        expect([...data]).toEqual([2, -3, 0, 3]);
    });

    it("composes Standard skeletal deformation into geometry position, normal, and velocity state", () => {
        const features = HAS_SKELETON | HAS_SKELETON_8;
        const skeleton = stdSkeletonExt._frag(features, 0)!;
        const result = composeStandardGeometryShader(
            features,
            0,
            [skeleton],
            [GeometryTextureType.WORLD_POSITION, GeometryTextureType.WORLD_NORMAL, GeometryTextureType.LINEAR_VELOCITY]
        );
        expect(result._vertexWGSL).toContain("finalWorld = mesh.world * influence");
        expect(result._vertexWGSL).toContain("previousBoneSampler");
        expect(result._vertexWGSL).toContain("mesh.previousWorld * previousInfluence");
        expect(result._meshUboSpec._offsets.has("previousWorld")).toBe(true);
        expect(result._meshUboSpec._offsets.has("velocityEnabled")).toBe(true);
        expect(result._vertexBufferLayouts.some((layout) => (layout.attributes as readonly GPUVertexAttribute[]).some((attribute) => attribute.format === "uint32x4"))).toBe(true);
        expect(result._vertexWGSL).toContain("@group(1)@binding(2) var boneSampler");
        expect(result._vertexWGSL).toContain("@group(1)@binding(4) var previousBoneSampler");
        expect(result._meshBGLDescriptor.entries).toHaveLength(5);
    });

    it("binds Standard skeleton texture and joint buffers in composed layout order", () => {
        const boneView = {} as GPUTextureView;
        const joints = {} as GPUBuffer;
        const weights = {} as GPUBuffer;
        const joints1 = {} as GPUBuffer;
        const weights1 = {} as GPUBuffer;
        const mesh = {
            skeleton: {
                boneTexture: { createView: () => boneView },
                jointsBuffer: joints,
                weightsBuffer: weights,
                joints1Buffer: joints1,
                weights1Buffer: weights1,
            },
        };
        const entries: GPUBindGroupEntry[] = [];
        expect(stdSkeletonExt._bind!({} as never, entries, 2, mesh as never)).toBe(3);
        expect(entries).toEqual([{ binding: 2, resource: boneView }]);

        const calls: [number, GPUBuffer][] = [];
        const pass = {
            setVertexBuffer: (slot: number, buffer: GPUBuffer) => calls.push([slot, buffer]),
        } as unknown as GPURenderPassEncoder;
        expect(stdSkeletonExt._bindVertexBuffers!(mesh as never, pass, 2)).toBe(6);
        expect(calls).toEqual([
            [2, joints],
            [3, weights],
            [4, joints1],
            [5, weights1],
        ]);
    });

    it("double-buffers previous bones for Standard geometry velocity", () => {
        const textures = [{ destroy: vi.fn() }, { destroy: vi.fn() }] as unknown as [GPUTexture, GPUTexture];
        const writes: GPUTexture[] = [];
        let textureIndex = 0;
        const engine = {
            _device: {
                createTexture: () => textures[textureIndex++]!,
                queue: { writeTexture: ({ texture }: GPUImageCopyTexture) => writes.push(texture) },
            },
        } as unknown as EngineContext;
        const bindGroups = [{}, {}] as GPUBindGroup[];
        const state = createStandardGeometrySkeletonVelocity(
            engine,
            { boneCount: 2, boneMatrices: new Float32Array(32) } as never,
            (texture) => bindGroups[textures.indexOf(texture)]!
        );

        expect(state._bindGroup).toBe(bindGroups[0]);
        expect(writes).toEqual([textures[0], textures[1]]);
        expect(state._update()).toBe(bindGroups[0]);
        expect(writes.at(-1)).toBe(textures[1]);
        expect(state._update()).toBe(bindGroups[1]);
        expect(writes.at(-1)).toBe(textures[0]);
        state._dispose();
        expect(textures[0].destroy).toHaveBeenCalledOnce();
        expect(textures[1].destroy).toHaveBeenCalledOnce();
    });

    it("preloads skeletal geometry velocity only after the Standard skeleton opt-in", async () => {
        expect(_getStandardGeometrySkeletonVelocityFactory()).toBeNull();
        enableStandardSkeleton();
        await preloadStandardGeometryFeatures([{ skeleton: {} }] as never, true);
        expect(_getStandardGeometrySkeletonVelocityFactory()).toBe(createStandardGeometrySkeletonVelocity);
    });

    it("forward Standard vertex color: RGB is unconditional, alpha only under the VERTEXALPHA opt-in", () => {
        // Default: RGB applied, no vertex-alpha consumption.
        const rgbOnly = composeStandardShader(0, 0, [createStdVertexColorFragment(false, false)], "");
        expect(rgbOnly._fragmentWGSL).toContain("baseColor *= input.vColor.rgb");
        expect(rgbOnly._fragmentWGSL).not.toContain("alpha *= input.vColor.a");
        // Opt-in: alpha multiplied + vertex-alpha alpha test present.
        const withAlpha = composeStandardShader(VERTEX_ALPHA, 0, [createStdVertexColorFragment(false, true)], "");
        expect(withAlpha._fragmentWGSL).toContain("baseColor *= input.vColor.rgb");
        expect(withAlpha._fragmentWGSL).toContain("alpha *= input.vColor.a");
        expect(withAlpha._fragmentWGSL).toContain("input.vColor.a < mat.aCut");
    });

    it("applies RGB vertex color unconditionally but gates vertex alpha behind the VERTEXALPHA opt-in", () => {
        // Default (no vertex-alpha opt-in): RGB is applied, alpha is NOT consumed.
        const rgbOnly = composeStandardGeometryShader(0, 0, [createStdVertexColorFragment(false, false)], [GeometryTextureType.ALBEDO]);
        expect(rgbOnly._fragmentWGSL).toContain("baseColor *= input.vColor.rgb");
        expect(rgbOnly._fragmentWGSL).not.toContain("alpha *= input.vColor.a");

        // With the opt-in (VERTEXALPHA): alpha is multiplied and masked before geometry alpha testing.
        const withAlpha = composeStandardGeometryShader(VERTEX_ALPHA, 0, [createStdVertexColorFragment(false, true)], [GeometryTextureType.ALBEDO]);
        expect(withAlpha._fragmentWGSL).toContain("baseColor *= input.vColor.rgb");
        expect(withAlpha._fragmentWGSL).toContain("alpha *= input.vColor.a");
        expect(withAlpha._fragmentWGSL.indexOf("alpha *= input.vColor.a")).toBeLessThan(withAlpha._fragmentWGSL.indexOf("alpha > 0.4"));
    });
});
