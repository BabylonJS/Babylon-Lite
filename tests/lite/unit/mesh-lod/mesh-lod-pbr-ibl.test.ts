import { describe, expect, it } from "vitest";
import { composeMeshLoDWgsl, meshLoDShaderKey, type MeshLoDShaderFeatures } from "../../../../packages/babylon-lite/src/material/pbr/pbr-mesh-lod-compose";

const lit: MeshLoDShaderFeatures = {
    hasNormalMap: false,
    hasEmissiveTexture: false,
    hasIbl: false,
    doubleSided: false,
    unlit: false,
};

describe("MeshLoD material IBL", () => {
    it("binds the environment LUT and prefiltered cubemap only for the lit environment variant", () => {
        const withEnvironment = composeMeshLoDWgsl({ ...lit, hasIbl: true });
        const withoutEnvironment = composeMeshLoDWgsl(lit);
        const unlit = composeMeshLoDWgsl({ ...lit, hasIbl: true, unlit: true });

        expect(meshLoDShaderKey({ ...lit, hasIbl: true })).not.toBe(meshLoDShaderKey(lit));
        expect(withEnvironment).toContain("@binding(12) var brdfLUT: texture_2d<f32>");
        expect(withEnvironment).toContain("@binding(14) var iblTexture: texture_cube<f32>");
        expect(withEnvironment).toContain("textureSample(brdfLUT, brdfSampler_, vec2<f32>(NdotV, roughness))");
        expect(withEnvironment).toContain("textureSampleLevel(iblTexture, iblSampler, R");
        expect(withEnvironment).toContain("scene.vImageInfos.z");
        expect(withEnvironment).not.toContain("shIrradiance(R)");
        expect(withoutEnvironment).not.toContain("@binding(12)");
        expect(withoutEnvironment).not.toContain("textureSampleLevel(iblTexture");
        expect(unlit).not.toContain("@binding(12)");
    });

    it("uses the ordinary PBR specular reflectance, occlusion and energy conservation terms", () => {
        const shader = composeMeshLoDWgsl({ ...lit, hasIbl: true, hasNormalMap: true });

        expect(shader).toContain("(colorF90 - colorF0) * environmentBrdf.x + colorF0 * environmentBrdf.y");
        expect(shader).toContain("environmentHorizonOcclusion(-V, N, Ngeom)");
        expect(shader).toContain("getEnergyConservationFactor(colorF0, max(environmentBrdf.y, 0.001))");
        expect(shader).toContain("directSpecular * energyConservation");
    });
});
