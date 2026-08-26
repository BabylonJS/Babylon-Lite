import { describe, expect, it } from "vitest";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { setPbrLightmap } from "../../../packages/babylon-lite/src/material/pbr/enable-pbr-lightmap";
import { createLightmapFragment, pbrExt, writeLightmapUBO } from "../../../packages/babylon-lite/src/material/pbr/fragments/lightmap-fragment";
import { PBR2_HAS_UV2 } from "../../../packages/babylon-lite/src/material/pbr/pbr-flag-bits";
import { MSH_HAS_UV2 } from "../../../packages/babylon-lite/src/material/mesh-features";
import { composeShader } from "../../../packages/babylon-lite/src/shader/shader-composer";
import { createPbrTemplate, type PbrTemplateConfig } from "../../../packages/babylon-lite/src/material/pbr/pbr-template";
import { createUnlitFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/unlit-fragment";
import { createIblFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/ibl-fragment";
import { createSheenFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/sheen-fragment";
import { makeRefractionRttExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/refraction-rtt-fragment";
import { createSubsurfaceFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/subsurface-fragment";
import { pbrExt as sheenPbrExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/sheen-fragment";
import { _registerPbrExt, type PbrExt } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { _computePbrMaterialFeatures } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { createPbrComposer } from "../../../packages/babylon-lite/src/material/pbr/pbr-compose";
import { createPbrTemplateExt } from "../../../packages/babylon-lite/src/material/pbr/pbr-template-ext";

const PBR_HAS_CLUSTERED_LIGHTS = 1 << 13;
const PBR_HAS_CLUSTERED_SPOTS = 1 << 14;
const PBR_LIGHTMAP_SHADOWMAP = 1 << 16;
const PBR_LIGHTMAP_GAMMA = 1 << 18;
const PBR_LIGHTMAP_FLIP_V = 1 << 19;
const PBR_HAS_SHEEN = 1 << 22;
const PBR_HAS_LIGHTMAP = 1 << 24;
const PBR_HAS_SUBSURFACE = 1 << 27;
const PBR2_HAS_REFRACTION = 1 << 4;
const PBR2_HAS_UNLIT = 1 << 8;
const PBR2_LIGHTMAP_UV2 = 1 << 29;
const PBR2_HAS_SHEEN_ROUGH_TEX = 1 << 31;

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

const texture = {
    view: { id: "lightmap-view" } as unknown as GPUTextureView,
    sampler: { id: "lightmap-sampler" } as unknown as GPUSampler,
    uAng: Math.PI,
} as Texture2D;

describe("PBR lightmap extension", () => {
    it("sets material state and owns only its UV2 mask bit", () => {
        const material = { _uv2Mask: 1 | 32 } as PbrMaterialProps;

        setPbrLightmap(material, texture, { coordIndex: 1, level: 3.2, useAsShadowmap: true, gamma: true });

        expect(material).toMatchObject({
            lightmapTexture: texture,
            lightmapLevel: 3.2,
            lightmapCoordIndex: 1,
            useLightmapAsShadowmap: true,
            gammaLightmap: true,
            _uv2Mask: 1 | 32 | 64,
        });

        setPbrLightmap(material, texture, { coordIndex: 0 });
        expect(material._uv2Mask).toBe(1 | 32);
    });

    it("detects every shader variant without colliding with shared feature bits", () => {
        const detected = pbrExt.detect!({
            lightmapTexture: texture,
            lightmapCoordIndex: 1,
            useLightmapAsShadowmap: true,
            gammaLightmap: true,
        } satisfies Partial<PbrMaterialProps>);

        expect(detected.f).toBe(PBR_HAS_LIGHTMAP | PBR_LIGHTMAP_SHADOWMAP | PBR_LIGHTMAP_GAMMA | PBR_LIGHTMAP_FLIP_V);
        expect(detected.f & (PBR_HAS_CLUSTERED_LIGHTS | PBR_HAS_CLUSTERED_SPOTS)).toBe(0);
        expect(detected.f2).toBe(PBR2_HAS_UV2 | PBR2_LIGHTMAP_UV2);
    });

    it("keeps lightmap UV2 distinct from the sheen roughness-texture variant", () => {
        const detected = sheenPbrExt.detect!({
            _sheen: { isEnabled: true, roughnessTexture: texture },
        } satisfies Partial<PbrMaterialProps>);

        expect(detected.f2 & PBR2_LIGHTMAP_UV2).toBe(0);
        expect(detected.f2 & PBR2_HAS_SHEEN_ROUGH_TEX).toBe(PBR2_HAS_SHEEN_ROUGH_TEX);
    });

    it("combines codec orientation with the Babylon.js lightmap rotation sentinel", () => {
        const codecTexture = { ...texture, invertY: true };
        const noRotation = pbrExt.detect!({ lightmapTexture: { ...codecTexture, uAng: 0 } } satisfies Partial<PbrMaterialProps>);
        const rotated = pbrExt.detect!({ lightmapTexture: codecTexture } satisfies Partial<PbrMaterialProps>);

        expect(noRotation.f & PBR_LIGHTMAP_FLIP_V).toBe(PBR_LIGHTMAP_FLIP_V);
        expect(rotated.f & PBR_LIGHTMAP_FLIP_V).toBe(0);
    });

    it("falls back to UV0 when the mesh has no UV2 buffer", () => {
        const fragment = pbrExt.frag!({
            _features: PBR_HAS_LIGHTMAP,
            _features2: PBR2_HAS_UV2 | PBR2_LIGHTMAP_UV2,
            _meshFeatures: 0,
            _hasIbl: false,
            _hasAnyNormal: false,
            _hasSpecularAA: false,
        })!;

        expect(fragment._fragmentSlots!.NI).toContain("input.uv");
        expect(fragment._fragmentSlots!.NI).not.toContain("input.uv2");

        const uv2Fragment = pbrExt.frag!({
            _features: PBR_HAS_LIGHTMAP,
            _features2: PBR2_HAS_UV2 | PBR2_LIGHTMAP_UV2,
            _meshFeatures: MSH_HAS_UV2,
            _hasIbl: false,
            _hasAnyNormal: false,
            _hasSpecularAA: false,
        })!;
        expect(uv2Fragment._fragmentSlots!.NI).toContain("input.uv2");
    });

    it("composes additive and shadowmap shaders with the expected UBO and bindings", () => {
        const base = composeShader(createPbrTemplate(defaultPbrConfig), []);
        const additive = composeShader(createPbrTemplate(defaultPbrConfig), [createLightmapFragment(false, false, true, true)]);
        expect(additive._fragmentWGSL).toContain("color+=pow(textureSample(lmTexture,lmSampler,vec2<f32>(input.uv.x,1.0-input.uv.y)).rgb,vec3<f32>(2.2))*material.lmLvl;");
        expect(additive._materialUboSpec!._offsets.has("lmLvl")).toBe(true);
        expect(additive._meshBGLDescriptor.entries).toHaveLength(base._meshBGLDescriptor.entries.length + 2);

        const shadowmap = composeShader(createPbrTemplate(defaultPbrConfig), [createLightmapFragment(false, true, false, false)]);
        expect(shadowmap._fragmentWGSL).toContain("color=(color-emissive)*(textureSample(lmTexture,lmSampler,input.uv).rgb*material.lmLvl)+emissive;");
    });

    it("orders lightmap after unlit and adds emissive only after lightmap composition", () => {
        const lightmap = createLightmapFragment(false, true, false, false, true);
        const composed = composeShader(createPbrTemplate(defaultPbrConfig), [lightmap, createUnlitFragment(false)]);
        const unlitIndex = composed._fragmentWGSL.indexOf("color = baseColor * material.unlitColor;");
        const lightmapIndex = composed._fragmentWGSL.indexOf("color=color*(textureSample(lmTexture,lmSampler,input.uv).rgb*material.lmLvl)+emissive;");

        expect(unlitIndex).toBeGreaterThanOrEqual(0);
        expect(lightmapIndex).toBeGreaterThan(unlitIndex);

        const fragment = pbrExt.frag!({
            _features: PBR_HAS_LIGHTMAP | PBR_LIGHTMAP_SHADOWMAP,
            _features2: PBR2_HAS_UNLIT,
            _meshFeatures: 0,
            _hasIbl: false,
            _hasAnyNormal: false,
            _hasSpecularAA: false,
        })!;
        expect(fragment._dependencies).toEqual(["unlit"]);
    });

    it("orders lightmap after IBL final-color reconstruction", () => {
        const ctx = {
            _features: PBR_HAS_LIGHTMAP | PBR_HAS_SHEEN,
            _features2: PBR2_HAS_REFRACTION,
            _meshFeatures: 0,
            _hasIbl: true,
            _hasAnyNormal: false,
            _hasSpecularAA: false,
        };
        const lightmap = pbrExt.frag!(ctx)!;
        const refraction = makeRefractionRttExt().frag!(ctx)!;
        const composed = composeShader(createPbrTemplate({ ...defaultPbrConfig, _hasIbl: true }), [
            lightmap,
            createIblFragment(false),
            createSheenFragment(false, true),
            refraction,
        ]);
        const refractionIndex = composed._fragmentWGSL.indexOf("color=finalIrradiance*ro");
        const sheenIndex = composed._fragmentWGSL.indexOf("color = finalIrradiance");
        const lightmapIndex = composed._fragmentWGSL.indexOf("color+=textureSample(lmTexture,lmSampler,input.uv).rgb*material.lmLvl;");

        expect(lightmap._dependencies).toEqual(["sheen", "refraction"]);
        expect(refractionIndex).toBeGreaterThanOrEqual(0);
        expect(sheenIndex).toBeGreaterThanOrEqual(0);
        expect(lightmapIndex).toBeGreaterThan(refractionIndex);
        expect(lightmapIndex).toBeGreaterThan(sheenIndex);
    });

    it("orders shadow lightmaps after non-IBL subsurface translucency", () => {
        const lightmap = pbrExt.frag!({
            _features: PBR_HAS_LIGHTMAP | PBR_LIGHTMAP_SHADOWMAP | PBR_HAS_SUBSURFACE,
            _features2: 0,
            _meshFeatures: 0,
            _hasIbl: false,
            _hasAnyNormal: false,
            _hasSpecularAA: false,
        })!;
        const composed = composeShader(createPbrTemplate(defaultPbrConfig), [lightmap, createSubsurfaceFragment(false, false, false, false, false, false)]);
        const subsurfaceIndex = composed._fragmentWGSL.indexOf("color += translucencyDirect;");
        const lightmapIndex = composed._fragmentWGSL.indexOf("color=(color-emissive)*(textureSample(lmTexture,lmSampler,input.uv).rgb*material.lmLvl)+emissive;");

        expect(lightmap._dependencies).toEqual(["subsurface"]);
        expect(subsurfaceIndex).toBeGreaterThanOrEqual(0);
        expect(lightmapIndex).toBeGreaterThan(subsurfaceIndex);
    });

    it("writes level, binds the texture pair, and enumerates the resource", () => {
        const material = { lightmapTexture: texture, lightmapLevel: 2.5 } as PbrMaterialProps;
        const data = new Float32Array(4);
        writeLightmapUBO(data, material, new Map([["lmLvl", 4]]));
        expect(data[1]).toBe(2.5);

        const entries: GPUBindGroupEntry[] = [];
        expect(pbrExt.bind!({ _material: material } as never, entries, 7)).toBe(9);
        expect(entries).toEqual([
            { binding: 7, resource: texture.view },
            { binding: 8, resource: texture.sampler },
        ]);

        const textures: Texture2D[] = [];
        pbrExt.textures!(material, textures);
        expect(textures).toEqual([texture]);
    });

    it("keeps clustered point, clustered spot, and lightmap shader/cache variants independent", () => {
        type ClusteredTestMaterial = PbrMaterialProps & {
            _clusteredLightState?: { _hasSpots?: boolean };
        };

        const makeClusteredExt = (id: string, gate: number, spots: boolean, contribution: string): PbrExt => ({
            id,
            phase: "fragment",
            detect(mat) {
                const state = (mat as ClusteredTestMaterial)._clusteredLightState;
                const active = spots ? state?._hasSpots === true : !!state && state._hasSpots !== true;
                return active ? { f: gate, f2: 0 } : { f: 0, f2: 0 };
            },
            frag(ctx) {
                if ((ctx._features & gate) === 0) {
                    return null;
                }
                return {
                    _id: id,
                    _fragmentSlots: {
                        BL: `directDiffuse+=vec3<f32>(${contribution});`,
                    },
                };
            },
        });

        const pointExt = makeClusteredExt("clustered-lights-test", PBR_HAS_CLUSTERED_LIGHTS, false, "0.125");
        const spotExt = makeClusteredExt("clustered-spot-lights-test", PBR_HAS_CLUSTERED_SPOTS, true, "0.25");
        _registerPbrExt(pointExt);
        _registerPbrExt(spotExt);
        _registerPbrExt(pbrExt);

        const composePbr = createPbrComposer({
            _singleLightWGSL: "",
            _getSingleLightBlock: null,
            _multiLightWGSL: "",
            _multiLightLoop: "",
            _tm: undefined,
            _fogHelper: "",
            _fogBlock: "",
            _createPbrTemplateExt: createPbrTemplateExt,
            _flatNormalWgsl: "",
            _createPbrShadowFragment: null,
            _shadowLights: [],
            _createThinInstanceFragment: null,
        });
        const detect = (spots: boolean | undefined, lightmap: boolean) => {
            const material = {
                occlusionStrength: 0,
                ...(spots === undefined ? {} : { _clusteredLightState: { _hasSpots: spots } }),
            } as ClusteredTestMaterial;
            if (lightmap) {
                setPbrLightmap(material, texture, { coordIndex: 1 });
            }
            return { material, ..._computePbrMaterialFeatures(material) };
        };
        const compose = (variant: ReturnType<typeof detect>) =>
            composePbr(variant.features, variant.features2, MSH_HAS_UV2, 0, 0, "", "", undefined, "", variant.material._uv2Mask ?? 0);

        const pointOnly = detect(false, false);
        const lightmapOnly = detect(undefined, true);
        const pointLightmap = detect(false, true);
        const spotLightmap = detect(true, true);

        expect(pointOnly.features & PBR_HAS_CLUSTERED_LIGHTS).toBe(PBR_HAS_CLUSTERED_LIGHTS);
        expect(pointOnly.features & (PBR_HAS_CLUSTERED_SPOTS | PBR_HAS_LIGHTMAP)).toBe(0);
        expect(lightmapOnly.features & PBR_HAS_LIGHTMAP).toBe(PBR_HAS_LIGHTMAP);
        expect(lightmapOnly.features & (PBR_HAS_CLUSTERED_LIGHTS | PBR_HAS_CLUSTERED_SPOTS)).toBe(0);
        expect(lightmapOnly.features2 & PBR2_LIGHTMAP_UV2).toBe(PBR2_LIGHTMAP_UV2);
        expect(pointLightmap.features & (PBR_HAS_CLUSTERED_LIGHTS | PBR_HAS_LIGHTMAP)).toBe(PBR_HAS_CLUSTERED_LIGHTS | PBR_HAS_LIGHTMAP);
        expect(spotLightmap.features & (PBR_HAS_CLUSTERED_SPOTS | PBR_HAS_LIGHTMAP)).toBe(PBR_HAS_CLUSTERED_SPOTS | PBR_HAS_LIGHTMAP);

        const pointOnlyShader = compose(pointOnly);
        const pointLightmapShader = compose(pointLightmap);
        const spotLightmapShader = compose(spotLightmap);

        expect(pointOnlyShader._fragmentWGSL).toContain("directDiffuse+=vec3<f32>(0.125);");
        expect(pointOnlyShader._fragmentWGSL).not.toContain("lmTexture");
        expect(pointLightmapShader._fragmentWGSL).toContain("directDiffuse+=vec3<f32>(0.125);");
        expect(pointLightmapShader._fragmentWGSL).not.toContain("directDiffuse+=vec3<f32>(0.25);");
        expect(pointLightmapShader._fragmentWGSL).toContain("textureSample(lmTexture,lmSampler,vec2<f32>(input.uv2.x,1.0-input.uv2.y))");
        expect(spotLightmapShader._fragmentWGSL).toContain("directDiffuse+=vec3<f32>(0.25);");
        expect(spotLightmapShader._fragmentWGSL).not.toContain("directDiffuse+=vec3<f32>(0.125);");
        expect(spotLightmapShader._fragmentWGSL).toContain("textureSample(lmTexture,lmSampler,vec2<f32>(input.uv2.x,1.0-input.uv2.y))");
        expect(compose(pointLightmap)).toBe(pointLightmapShader);
        expect(pointOnlyShader).not.toBe(pointLightmapShader);
        expect(pointLightmapShader).not.toBe(spotLightmapShader);
    });
});
