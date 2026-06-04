/**
 * Unit tests for createGridMaterial — verifies gridControl packing, blend
 * selection, WGSL composition toggles, and the opacity-texture resource path.
 */
import { describe, it, expect } from "vitest";
import { createGridMaterial } from "../../../packages/babylon-lite/src/material/grid/grid-material";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

function gridControl(mat: ReturnType<typeof createGridMaterial>): Float32Array {
    return mat._uniformValues.get("gridControl")!.value;
}

describe("createGridMaterial", () => {
    it("packs default options into gridControl = (gridRatio, round(major), minorVis, opacity)", () => {
        const mat = createGridMaterial();
        const gc = gridControl(mat);
        expect(Array.from(gc)).toEqual([1, 10, expect.closeTo(0.33, 5), 1]);
    });

    it("rounds majorUnitFrequency with Math.round and forwards ratio/opacity", () => {
        const mat = createGridMaterial({ gridRatio: 2.5, majorUnitFrequency: 7.6, minorUnitVisibility: 0.45, opacity: 0.6 });
        const gc = gridControl(mat);
        expect(gc[0]).toBeCloseTo(2.5, 5);
        expect(gc[1]).toBe(8);
        expect(gc[2]).toBeCloseTo(0.45, 5);
        expect(gc[3]).toBeCloseTo(0.6, 5);
    });

    it("applies default colors and visibility uniforms", () => {
        const mat = createGridMaterial();
        expect(Array.from(mat._uniformValues.get("mainColor")!.value)).toEqual([0, 0, 0]);
        expect(Array.from(mat._uniformValues.get("lineColor")!.value)).toEqual([0, expect.closeTo(0.5, 5), expect.closeTo(0.5, 5)]);
        expect(mat._uniformValues.get("visibility")!.value[0]).toBeCloseTo(1, 5);
    });

    it("declares the system + custom uniforms in object-space order", () => {
        const mat = createGridMaterial();
        const names = mat.uniformDecls.map((u) => u.name);
        expect(names).toEqual(["world", "view", "projection", "gridControl", "mainColor", "lineColor", "gridOffset", "visibility"]);
        expect(mat.attributes).toEqual(["position", "normal"]);
    });

    it("is opaque (no alpha blending) when opacity is 1 and no opacity texture", () => {
        const mat = createGridMaterial({ opacity: 1 });
        expect(mat.needAlphaBlending).toBe(false);
    });

    it("enables alpha blending (transparent path) when opacity < 1", () => {
        const mat = createGridMaterial({ opacity: 0.6 });
        expect(mat.needAlphaBlending).toBe(true);
        expect(mat.blendMode).toBe("alpha");
        // Transparent path computes opacity from the grid value.
        expect(mat.fragmentSource).toContain("opacity=clamp(grid,0.08,shaderUniforms.gridControl.w*grid);");
    });

    it("omits the transparent opacity computation when opaque", () => {
        const mat = createGridMaterial({ opacity: 1 });
        expect(mat.fragmentSource).not.toContain("opacity=clamp(grid");
    });

    it("composes the additive axis combine by default and max combine with useMaxLine", () => {
        const additive = createGridMaterial();
        expect(additive.fragmentSource).toContain("let grid=clamp(x+y+z,0.0,1.0);");
        const maxLine = createGridMaterial({ useMaxLine: true });
        expect(maxLine.fragmentSource).toContain("let grid=clamp(max(max(x,y),z),0.0,1.0);");
    });

    it("composes the cosine AA branch by default and the hard cutoff when antialias is false", () => {
        const aa = createGridMaterial();
        expect(aa.fragmentSource).toContain("return 0.5+0.5*cos(fr*PI);");
        expect(aa.fragmentSource).not.toContain("SQRT2/4.0");
        const hard = createGridMaterial({ antialias: false });
        expect(hard.fragmentSource).toContain("if(abs(fr)<SQRT2/4.0)");
        expect(hard.fragmentSource).not.toContain("cos(fr*PI)");
    });

    it("emits premultiply only on the transparent path", () => {
        const both = createGridMaterial({ opacity: 0.5, preMultiplyAlpha: true });
        expect(both.fragmentSource).toContain("rgb=rgb*opacity;");
        // preMultiplyAlpha with no transparency must NOT premultiply.
        const opaque = createGridMaterial({ opacity: 1, preMultiplyAlpha: true });
        expect(opaque.fragmentSource).not.toContain("rgb=rgb*opacity;");
    });

    it("declares the opacity sampler, uv attribute, and sampling line only when an opacity texture is supplied", () => {
        const fakeTexture = { _sampleType: "float" } as unknown as Texture2D;
        const mat = createGridMaterial({ opacityTexture: fakeTexture });
        expect(mat.needAlphaBlending).toBe(true);
        expect(mat.attributes).toEqual(["position", "normal", "uv"]);
        expect(mat.samplerDecls.map((s) => s.name)).toEqual(["opacitySampler"]);
        expect(mat.vertexSource).toContain("out.vUv=input.uv;");
        expect(mat.fragmentSource).toContain("textureSample(opacitySampler,opacitySamplerSampler,input.vUv).a");
        expect(mat._textureSlots.get("opacitySampler")!.current).toBe(fakeTexture);

        const noTex = createGridMaterial();
        expect(noTex.samplerDecls).toHaveLength(0);
        expect(noTex.fragmentSource).not.toContain("opacitySampler");
        expect(noTex.vertexSource).not.toContain("vUv");
    });

    it("respects backFaceCulling option (default true)", () => {
        expect(createGridMaterial().backFaceCulling).toBe(true);
        expect(createGridMaterial({ backFaceCulling: false }).backFaceCulling).toBe(false);
    });

    it("produces vertex WGSL that transforms object-space position with projection*view*world", () => {
        const mat = createGridMaterial();
        expect(mat.vertexSource).toContain("shaderSystem.projection*(shaderSystem.view*(shaderSystem.world*vec4<f32>(input.position,1.0)))");
        expect(mat.vertexSource).toContain("out.vPosition=input.position;");
        expect(mat.vertexSource).toContain("out.vNormal=input.normal;");
    });
});
