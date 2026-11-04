import { describe, expect, it } from "vitest";

import { enableBentNormals } from "../../../packages/babylon-lite/src/material/pbr/fragments/bent-normal-fragment";
import { pbrExt as iblExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/ibl-fragment";
import { pbrExt as iridescenceExt } from "../../../packages/babylon-lite/src/material/pbr/fragments/iridescence-fragment";
import { createReflectanceFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/reflectance-fragment";
import { PBR2_HAS_BENT_NORMAL } from "../../../packages/babylon-lite/src/material/pbr/pbr-flag-bits";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { _PbrFragCtx } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags";
import { computeUboLayout } from "../../../packages/babylon-lite/src/shader/ubo-layout";

const tex = { view: {}, sampler: {} } as unknown as NonNullable<PbrMaterialProps["bentNormalTexture"]>;
const bentMat = { bentNormalTexture: tex, ormTexture: tex } as PbrMaterialProps;

function fragCtx(features2: number, hasAnyNormal: boolean): _PbrFragCtx {
    return { _hasIbl: true, _hasAnyNormal: hasAnyNormal, _features: 0, _features2: features2, _meshFeatures: 0 } as unknown as _PbrFragCtx;
}

describe("bent normals", () => {
    enableBentNormals();

    it("detects only lit, non-skybox materials with an AO texture", () => {
        const detect = iblExt.detect!;
        expect(detect(bentMat).f2).toBe(PBR2_HAS_BENT_NORMAL);
        expect(detect({ ...bentMat, ormTexture: undefined }).f2).toBe(0);
        expect(detect({ ...bentMat, unlit: true }).f2).toBe(0);
        expect(detect({ ...bentMat, skyboxMode: true }).f2).toBe(0);
        expect(detect({ ...bentMat, occlusionStrength: 0 }).f2).toBe(0);
    });

    it("does not share a features2 bit with iridescence", () => {
        const iriTex = { _hasTx: true, _texCoord: 1 };
        const { f2 } = iridescenceExt.detect!({ iridescence: { isEnabled: true, texture: iriTex, thicknessTexture: iriTex } } as unknown as PbrMaterialProps);
        expect(f2 & PBR2_HAS_BENT_NORMAL).toBe(0);
    });

    it("patches every IBL normal variant", () => {
        for (const hasAnyNormal of [false, true]) {
            const plain = iblExt.frag!(fragCtx(0, hasAnyNormal))!;
            const bent = iblExt.frag!(fragCtx(PBR2_HAS_BENT_NORMAL, hasAnyNormal))!;
            expect(plain._fragmentSlots!.AI).not.toContain("environmentBentNormalOcclusion(");
            expect(bent._fragmentSlots!.AI).toContain("environmentBentNormalOcclusion(");
            expect(bent._fragmentSlots!.AI).not.toContain("seo * eho");
            expect(bent._bindings!.slice(0, plain._bindings!.length)).toEqual(plain._bindings);
        }
    });

    it("keeps the reflectance UBO writer's 16-byte packing", () => {
        const bent = iblExt.frag!(fragCtx(PBR2_HAS_BENT_NORMAL, true))!;
        const reflectance = createReflectanceFragment(false, false, false);
        const { _offsets } = computeUboLayout([{ _name: "environmentIntensity", _type: "f32" }, ...bent._uboFields!, ...reflectance._uboFields!]);
        const occ = _offsets.get("occlusionStrength")!;
        expect(occ % 16).toBe(0);
        expect(_offsets.get("metallicReflectanceColor")).toBe(occ + 16);
    });
});
