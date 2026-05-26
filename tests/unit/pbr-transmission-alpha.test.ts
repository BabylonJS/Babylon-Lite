import { describe, expect, it } from "vitest";
import type { Texture2D } from "../../packages/babylon-lite/src/texture/texture-2d";
import type { PbrMaterialProps } from "../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { EngineContextInternal } from "../../packages/babylon-lite/src/engine/engine";
import type { _PbrBindCtx } from "../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { _computePbrMaterialFeatures } from "../../packages/babylon-lite/src/material/pbr/pbr-material";
import { PBR_HAS_ALPHA_BLEND, PBR_HAS_ALPHA_TEST, PBR2_HAS_REFRACTION, PBR2_HAS_REFRACTION_MAP, PBR2_HAS_VOLUME } from "../../packages/babylon-lite/src/material/pbr/pbr-flag-bits";
import { refractionRttExt } from "../../packages/babylon-lite/src/material/pbr/fragments/refraction-rtt-fragment";

const dummyTexture = {} as Texture2D;
const refractionMapTexture = { view: { id: "map-view" } as GPUTextureView, sampler: { id: "map-sampler" } as GPUSampler } as Texture2D;

describe("PBR transmission and alpha feature detection", () => {
    it("marks glTF alpha MASK materials for alpha test without enabling blending", () => {
        const features = _computePbrMaterialFeatures({
            alpha: 0.75,
            alphaCutOff: 0.5,
        } as PbrMaterialProps);

        expect(features.features & PBR_HAS_ALPHA_TEST).toBe(PBR_HAS_ALPHA_TEST);
        expect(features.features & PBR_HAS_ALPHA_BLEND).toBe(0);
    });

    it("marks transmission refraction maps when a transmission texture is present", () => {
        const detected = refractionRttExt.detect?.({
            transmissive: true,
            subsurface: {
                refraction: {
                    intensity: 1,
                    texture: dummyTexture,
                },
            },
        } as PbrMaterialProps);

        expect(detected!.f2 & PBR2_HAS_REFRACTION).toBe(PBR2_HAS_REFRACTION);
        expect(detected!.f2 & PBR2_HAS_REFRACTION_MAP).toBe(PBR2_HAS_REFRACTION_MAP);
    });

    it("keeps BJS albedo tint and scales volume thickness by world scale", () => {
        const fragment = refractionRttExt.frag?.({
            _features: 0,
            _features2: PBR2_HAS_REFRACTION | PBR2_HAS_VOLUME,
            _meshFeatures: 0,
            _hasIbl: true,
            _hasAnyNormal: false,
            _hasSpecularAA: false,
        });

        const code = fragment?._fragmentSlots?.AI ?? "";
        expect(code).toContain("let ts=max(length(mesh.world[0].xyz)");
        expect(code).toContain("let th=material.refractionParams.z*ts");
        expect(code).toContain("let fr=er*surfaceAlbedo*(ri*ab)");
    });

    it("binds refraction maps with wrap/wrap/wrap anisotropic sampling", () => {
        const samplers: GPUSamplerDescriptor[] = [];
        const engine = {
            device: {
                createSampler: (descriptor: GPUSamplerDescriptor) => {
                    samplers.push(descriptor);
                    return descriptor as unknown as GPUSampler;
                },
            },
        } as EngineContextInternal;
        const entries: GPUBindGroupEntry[] = [];

        refractionRttExt.bind!(
            {
                _engine: engine,
                _features: 0,
                _features2: PBR2_HAS_REFRACTION | PBR2_HAS_REFRACTION_MAP,
                _meshFeatures: 0,
                _material: {
                    subsurface: {
                        refraction: {
                            texture: refractionMapTexture,
                        },
                    },
                },
                _refractionTexture: dummyTexture,
            } as _PbrBindCtx,
            entries,
            0
        );

        expect(entries[3]!.resource).toEqual({
            magFilter: "linear",
            minFilter: "linear",
            mipmapFilter: "linear",
            addressModeU: "repeat",
            addressModeV: "repeat",
            addressModeW: "repeat",
            maxAnisotropy: 4,
        });
        expect(samplers).toHaveLength(1);
    });
});
