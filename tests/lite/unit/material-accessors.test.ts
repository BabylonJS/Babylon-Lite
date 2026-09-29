import { describe, expect, it } from "vitest";

import type { Material } from "../../../packages/babylon-lite/src/material/material";
import { createMaterialView } from "../../../packages/babylon-lite/src/material/material-view";
import { hasMaterialUvTransform } from "../../../packages/babylon-lite/src/material/material-uv-transform";
import {
    getPbrAlphaCutoff,
    getPbrAnisotropy,
    getPbrClearCoat,
    getPbrDispersion,
    getPbrEmissiveColor,
    getPbrIridescence,
    getPbrMetallicReflectance,
    getPbrSheen,
    getPbrSubsurface,
    getPbrTransmission,
    getPbrUnlit,
    getShadowOnly,
    isPbrGammaAlbedo,
    isPbrSkybox,
} from "../../../packages/babylon-lite/src/material/pbr/pbr-material-accessors";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { createShaderMaterial, getShaderTexture, getShaderUniform, setShaderTexture, setShaderUniform } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import {
    getStandardAmbientTexture,
    getStandardBumpTexture,
    getStandardEmissiveTexture,
    getStandardLightmapTexture,
    getStandardOpacityTexture,
    getStandardReflectionCubeTexture,
    getStandardReflectionTexture,
    getStandardSpecularTexture,
} from "../../../packages/babylon-lite/src/material/standard/standard-material-accessors";
import type { StandardMaterialProps } from "../../../packages/babylon-lite/src/material/standard/standard-material";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

function texture(seed: number): Texture2D {
    return {
        texture: { seed } as unknown as GPUTexture,
        view: { seed } as unknown as GPUTextureView,
        sampler: { seed } as unknown as GPUSampler,
        width: 1,
        height: 1,
    };
}

describe("Standard material accessors", () => {
    it("returns exact wrapper identities and preserves null versus absent slots", () => {
        const textures = Array.from({ length: 7 }, (_, index) => texture(index));
        const cube = {};
        const material = {
            _emissiveTexture: textures[0],
            _bumpTexture: null,
            _specularTexture: textures[1],
            _ambientTexture: textures[2],
            _lightmapTexture: textures[3],
            _opacityTexture: textures[4],
            _reflectionTexture: textures[5],
            _reflectionCubeTexture: cube,
        } as unknown as StandardMaterialProps;

        expect(getStandardEmissiveTexture(material)).toBe(textures[0]);
        expect(getStandardBumpTexture(material)).toBeNull();
        expect(getStandardSpecularTexture(material)).toBe(textures[1]);
        expect(getStandardAmbientTexture(material)).toBe(textures[2]);
        expect(getStandardLightmapTexture(material)).toBe(textures[3]);
        expect(getStandardOpacityTexture(material)).toBe(textures[4]);
        expect(getStandardReflectionTexture(material)).toBe(textures[5]);
        expect(getStandardReflectionCubeTexture(material)).toBe(cube);
        expect(getStandardEmissiveTexture({} as StandardMaterialProps)).toBeUndefined();
    });
});

describe("PBR material accessors", () => {
    it("returns undefined for absent optional families", () => {
        const material = {} as PbrMaterialProps;
        expect(getPbrAlphaCutoff(material)).toBeUndefined();
        expect(getPbrEmissiveColor(material)).toBeUndefined();
        expect(getPbrMetallicReflectance(material)).toBeUndefined();
        expect(getPbrClearCoat(material)).toBeUndefined();
        expect(getPbrSheen(material)).toBeUndefined();
        expect(getPbrIridescence(material)).toBeUndefined();
        expect(getPbrAnisotropy(material)).toBeUndefined();
        expect(getPbrSubsurface(material)).toBeUndefined();
        expect(getPbrTransmission(material)).toBeUndefined();
        expect(getPbrDispersion(material)).toBeUndefined();
        expect(getPbrUnlit(material)).toBeUndefined();
        expect(getShadowOnly(material)).toBeUndefined();
        expect(isPbrGammaAlbedo(material)).toBe(false);
        expect(isPbrSkybox(material)).toBe(false);
    });

    it("returns stored family objects and tuples by identity", () => {
        const textures = Array.from({ length: 12 }, (_, index) => texture(index));
        const material = {
            _alphaCutOff: 0.4,
            _emissiveColor: [0.1, 0.2, 0.3],
            _metallicReflectanceColor: [0.2, 0.3, 0.4],
            _metallicReflectanceTexture: textures[0],
            _reflectanceTexture: textures[1],
            _metallicF0Factor: 0.7,
            _specularWeight: 0.8,
            _useOnlyMetallicFromMetallicReflectanceTexture: true,
            _clearCoat: { isEnabled: true, texture: textures[2], roughness: 0.2 },
            _sheen: { isEnabled: true, color: [0.3, 0.4, 0.5], texture: textures[3] },
            _iridescence: { isEnabled: true, texture: textures[4] },
            _anisotropy: { isEnabled: true, direction: [0.5, 0.6], texture: textures[5] },
            _subsurface: {
                translucency: {
                    color: [0.6, 0.7, 0.8],
                    diffusionDistance: [1, 2, 3],
                    colorTexture: textures[6],
                    intensityTexture: textures[7],
                },
                scattering: { diffusionDistance: [4, 5, 6], metersPerUnit: 0.5 },
                thickness: { texture: textures[8], min: 0.1, max: 0.9 },
                tint: { color: [0.8, 0.7, 0.6], atDistance: 2 },
                refraction: { texture: textures[9], intensity: 0.75, dispersion: 0.2 },
            },
            _transmissive: true,
        } as unknown as PbrMaterialProps;

        const emissive = getPbrEmissiveColor(material)!;
        const reflectance = getPbrMetallicReflectance(material)!;
        const clearCoat = getPbrClearCoat(material)!;
        const sheen = getPbrSheen(material)!;
        const iridescence = getPbrIridescence(material)!;
        const anisotropy = getPbrAnisotropy(material)!;
        const subsurface = getPbrSubsurface(material)!;
        const transmission = getPbrTransmission(material)!;

        expect(getPbrAlphaCutoff(material)).toBe(0.4);
        expect(emissive).toBe(material._emissiveColor);
        expect(reflectance.color).toBe(material._metallicReflectanceColor);
        expect(reflectance.texture).toBe(textures[0]);
        expect(reflectance.reflectanceTexture).toBe(textures[1]);
        expect(clearCoat).toBe(material._clearCoat);
        expect(clearCoat.texture).toBe(textures[2]);
        expect(sheen).toBe(material._sheen);
        expect(sheen.texture).toBe(textures[3]);
        expect(iridescence).toBe(material._iridescence);
        expect(iridescence.texture).toBe(textures[4]);
        expect(anisotropy).toBe(material._anisotropy);
        expect(anisotropy.direction).toBe(material._anisotropy?.direction);
        expect(anisotropy.texture).toBe(textures[5]);
        expect(subsurface).toBe(material._subsurface);
        expect(subsurface.translucency).toBe(material._subsurface?.translucency);
        expect(subsurface.translucency?.color).toBe(material._subsurface?.translucency?.color);
        expect(subsurface.scattering).toBe(material._subsurface?.scattering);
        expect(subsurface.thickness).toBe(material._subsurface?.thickness);
        expect(subsurface.tint).toBe(material._subsurface?.tint);
        expect(subsurface.refraction).toBe(material._subsurface?.refraction);
        expect(subsurface.translucency?.colorTexture).toBe(textures[6]);
        expect(transmission).toBe(material._subsurface?.refraction);
        expect(transmission.texture).toBe(textures[9]);
        expect(getPbrDispersion(material)).toBe(0.2);
        expect(getPbrClearCoat(material)).toBe(clearCoat);
        expect(getPbrSubsurface(material)).toBe(subsurface);
        expect(getPbrTransmission(material)).toBe(transmission);
    });

    it("reuses readonly active-mode defaults and preserves stored color tuples", () => {
        const active = {
            _unlit: true,
            _gammaAlbedo: true,
            _skyboxMode: true,
            _shadowOnly: true,
        } as PbrMaterialProps;
        const unlit = getPbrUnlit(active)!;
        const shadowOnly = getShadowOnly(active)!;

        expect(unlit).toEqual([1, 1, 1]);
        expect(shadowOnly).toEqual({ color: [0, 0, 0], opacity: 1, falloff: 1 });
        expect(getPbrUnlit(active)).toBe(unlit);
        expect(getShadowOnly(active)).toBe(shadowOnly);
        expect(isPbrGammaAlbedo(active)).toBe(true);
        expect(isPbrSkybox(active)).toBe(true);

        const unlitColor: [number, number, number] = [0.2, 0.3, 0.4];
        const shadowColor: [number, number, number] = [0.4, 0.3, 0.2];
        const configured = {
            _unlit: true,
            _unlitColor: unlitColor,
            _shadowOnly: true,
            _shadowOnlyColor: shadowColor,
        } as PbrMaterialProps;
        expect(getPbrUnlit(configured)).toBe(unlitColor);
        expect(getShadowOnly(configured)?.color).toBe(shadowColor);
    });
});

describe("Shader material accessors", () => {
    it("validates declarations and returns stored uniform and texture identities", () => {
        const material = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex() -> @builtin(position) vec4f { return vec4f(); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(); }`,
            attributes: ["position"],
            uniforms: [
                { name: "scalar", type: "f32", defaultValue: 2 },
                { name: "color", type: "vec3<f32>", defaultValue: [1, 2, 3] },
            ],
            samplers: ["colorMap"],
        });
        const colorMap = texture(1);
        setShaderUniform(material, "color", [4, 5, 6]);
        setShaderTexture(material, "colorMap", colorMap);

        expect(getShaderUniform(material, "scalar")).toBe(2);
        const color = getShaderUniform(material, "color");
        expect(color).toEqual(new Float32Array([4, 5, 6]));
        expect(color).toBeInstanceOf(Float32Array);
        if (typeof color === "number") {
            throw new Error("Expected a vector uniform to return a Float32Array.");
        }
        const colorArray: Float32Array = color;
        expect(colorArray.subarray(1)).toEqual(new Float32Array([5, 6]));
        expect(color).toBe(material._uniformValues.get("color")?.value);
        expect(getShaderUniform(material, "color")).toBe(color);
        expect(getShaderTexture(material, "colorMap")).toBe(colorMap);

        expect(() => getShaderUniform(material, "missing")).toThrow('uniform "missing" was not declared');
        expect(() => getShaderTexture(material, "missing")).toThrow('sampler "missing" was not declared');
    });
});

describe("material UV transform capability", () => {
    it("reads source opt-in state through material views", () => {
        const disabled = { _uboVersion: 0 } as Material;
        const enabled = { _uboVersion: 0, _hasUvTx: true } as unknown as Material;
        expect(hasMaterialUvTransform(disabled)).toBe(false);
        expect(hasMaterialUvTransform(enabled)).toBe(true);
        expect(hasMaterialUvTransform(createMaterialView(enabled, { features: 0 }))).toBe(true);
    });
});
