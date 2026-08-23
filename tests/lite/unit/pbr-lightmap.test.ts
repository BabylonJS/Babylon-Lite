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

const PBR_HAS_LIGHTMAP = 1 << 13;
const PBR_LIGHTMAP_UV2 = 1 << 14;
const PBR_LIGHTMAP_SHADOWMAP = 1 << 16;
const PBR_LIGHTMAP_GAMMA = 1 << 18;
const PBR_LIGHTMAP_FLIP_V = 1 << 19;
const PBR2_HAS_UNLIT = 1 << 8;

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

        expect(detected.f).toBe(PBR_HAS_LIGHTMAP | PBR_LIGHTMAP_UV2 | PBR_LIGHTMAP_SHADOWMAP | PBR_LIGHTMAP_GAMMA | PBR_LIGHTMAP_FLIP_V);
        expect(detected.f2).toBe(PBR2_HAS_UV2);
    });

    it("falls back to UV0 when the mesh has no UV2 buffer", () => {
        const fragment = pbrExt.frag!({
            _features: PBR_HAS_LIGHTMAP | PBR_LIGHTMAP_UV2,
            _features2: PBR2_HAS_UV2,
            _meshFeatures: 0,
            _hasIbl: false,
            _hasAnyNormal: false,
            _hasSpecularAA: false,
        })!;

        expect(fragment._fragmentSlots!.NI).toContain("input.uv");
        expect(fragment._fragmentSlots!.NI).not.toContain("input.uv2");

        const uv2Fragment = pbrExt.frag!({
            _features: PBR_HAS_LIGHTMAP | PBR_LIGHTMAP_UV2,
            _features2: PBR2_HAS_UV2,
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
});
