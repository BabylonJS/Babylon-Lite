import { describe, expect, it } from "vitest";

import { createBentNormalFragment, enableBentNormals } from "../../../packages/babylon-lite/src/material/pbr/fragments/bent-normal-fragment";
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

    it("applies back-face orientation exactly once per tangent-frame path", () => {
        const flip = "if(!frontFacing){bentNormalW=-bentNormalW;}";
        // Vertex TBN is unflipped by the template, so the bent normal is negated on back faces.
        expect(createBentNormalFragment(true, true)._fragmentSlots!.AC).toContain(flip);
        // The cotangent frame uses the already-flipped N_geom with negated UVs: no second flip.
        const cot = createBentNormalFragment(false, true)._fragmentSlots!.AC!;
        expect(cot).not.toContain(flip);
        expect(cot).toContain("select(-input.uv,input.uv,frontFacing)");
        for (const reuseTbn of [false, true]) {
            expect(createBentNormalFragment(reuseTbn, false)._fragmentSlots!.AC).not.toContain("frontFacing");
        }

        // Back face: BJS frames from the unflipped normal n with -uv, then negates the result.
        // Lite frames from -n with -uv. Both must give T0*x + B0*y - n*z.
        type V = [number, number, number];
        const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const add = (a: V, b: V, s = 1, t = 1): V => [a[0] * s + b[0] * t, a[1] * s + b[1] * t, a[2] * s + b[2] * t];
        const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
        const dp1: V = [0.3, -0.1, 0.05];
        const dp2: V = [0.02, 0.4, -0.07];
        const n: V = [0.1, 0.2, 0.97];
        const duv1: [number, number] = [-0.2, -0.05];
        const duv2: [number, number] = [0.03, -0.3];
        const bent: V = [0.2, -0.3, 0.9];
        const frame = (nrm: V): V => {
            const dp2p = cross(dp2, nrm);
            const dp1p = cross(nrm, dp1);
            const t = add(dp2p, dp1p, duv1[0], duv2[0]);
            const b = scale(add(dp2p, dp1p, duv1[1], duv2[1]), -1);
            return add(add(t, b, bent[0], bent[1]), nrm, 1, bent[2]);
        };
        const bjs = scale(frame(n), -1);
        const lite = frame(scale(n, -1));
        lite.forEach((c, i) => expect(c).toBeCloseTo(bjs[i]!, 12));
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
