import { describe, expect, it } from "vitest";

import { enableBentNormals } from "../../../packages/babylon-lite/src/material/pbr/fragments/bent-normal-fragment";
import { pbrExt as iblExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/ibl-fragment";
import { pbrExt as lightmapExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/lightmap-fragment";
import { createReflectanceFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/reflectance-fragment";
import * as flagBits from "../../../packages/babylon-lite/src/material/pbr/pbr-flag-bits";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { _PbrFragCtx } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { computeUboLayout } from "../../../packages/babylon-lite/src/shader/ubo-layout";

const tex = { view: {}, sampler: {} } as unknown as NonNullable<PbrMaterialProps["bentNormalTexture"]>;
const bentMat = { bentNormalTexture: tex, ormTexture: tex } as PbrMaterialProps;

function fragCtx(features: number, hasAnyNormal: boolean): _PbrFragCtx {
    return { _hasIbl: true, _hasAnyNormal: hasAnyNormal, _features: features, _features2: 0, _meshFeatures: 0 } as unknown as _PbrFragCtx;
}

describe("bent normals", () => {
    enableBentNormals();
    const BENT = iblExt.detect!(bentMat).f;

    it("detects only lit, non-skybox materials with an AO texture", () => {
        const detect = iblExt.detect!;
        expect(BENT).not.toBe(0);
        expect(BENT & (BENT - 1)).toBe(0);
        expect(detect(bentMat).f2).toBe(0);
        expect(detect({ ...bentMat, ormTexture: undefined }).f).toBe(0);
        expect(detect({ ...bentMat, _unlit: true }).f).toBe(0);
        expect(detect({ ...bentMat, _skyboxMode: true }).f).toBe(0);
        expect(detect({ ...bentMat, occlusionStrength: 0 }).f).toBe(0);
    });

    it("uses a material features bit no other feature claims", () => {
        // PBR_HAS_ENV / PBR_HAS_TONEMAP / PBR_HAS_FOG are sceneFeatures-only bits.
        const sceneOnly = new Set(["PBR_HAS_ENV", "PBR_HAS_TONEMAP", "PBR_HAS_FOG"]);
        for (const [name, bit] of Object.entries(flagBits)) {
            if (name.startsWith("PBR_") && !sceneOnly.has(name)) {
                expect(bit & BENT, name).toBe(0);
            }
        }
        // Lightmap claims extension-local `features` bits; set them all.
        const lmTex = { invertY: true } as unknown as PbrMaterialProps["lightmapTexture"];
        const { f } = lightmapExt.detect!({ lightmapTexture: lmTex, useLightmapAsShadowmap: true, gammaLightmap: true } as PbrMaterialProps);
        expect(f & BENT).toBe(0);
    });

    it("patches every IBL normal variant", () => {
        for (const hasAnyNormal of [false, true]) {
            const plain = iblExt.frag!(fragCtx(0, hasAnyNormal))!;
            const bent = iblExt.frag!(fragCtx(BENT, hasAnyNormal))!;
            expect(plain._fragmentSlots!.AI).not.toContain("environmentBentNormalOcclusion(");
            expect(bent._fragmentSlots!.AI).toContain("environmentBentNormalOcclusion(");
            expect(bent._fragmentSlots!.AI).not.toContain("seo * eho");
            expect(bent._bindings!.slice(0, plain._bindings!.length)).toEqual(plain._bindings);
        }
    });

    it("keeps the reflectance UBO writer's 16-byte packing", () => {
        const bent = iblExt.frag!(fragCtx(BENT, true))!;
        const reflectance = createReflectanceFragment(false, false, false);
        const { _offsets } = computeUboLayout([{ _name: "environmentIntensity", _type: "f32" }, ...bent._uboFields!, ...reflectance._uboFields!]);
        const occ = _offsets.get("occlusionStrength")!;
        expect(occ % 16).toBe(0);
        expect(_offsets.get("metallicReflectanceColor")).toBe(occ + 16);
    });
});
