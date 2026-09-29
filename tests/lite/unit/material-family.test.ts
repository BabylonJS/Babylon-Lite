import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { getMaterialFamily } from "../../../packages/babylon-lite/src/material/material-family";
import { getMaterialTextures } from "../../../packages/babylon-lite/src/material/material-textures";
import { createMaterialView, getMaterialSource, isMaterialView } from "../../../packages/babylon-lite/src/material/material-view";
import { isNodeMaterial, isPbrMaterial, isShaderMaterial, isStandardMaterial } from "../../../packages/babylon-lite/src/material/material-guards";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import { createShaderMaterial, setShaderTexture } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

function fakeMaterial(family?: string): Material {
    return {
        _buildGroup: { _materialFamily: family } as unknown as Material["_buildGroup"],
        _uboVersion: 0,
    } as Material;
}

function texture2d(seed: number): Texture2D {
    return {
        texture: { seed } as unknown as GPUTexture,
        view: { seed } as unknown as GPUTextureView,
        sampler: { seed } as unknown as GPUSampler,
        width: 1,
        height: 1,
        _sampleType: "float",
    };
}

describe("material family and source", () => {
    it("reports built-in, custom, and missing families", () => {
        expect(getMaterialFamily(fakeMaterial("pbr"))).toBe("pbr");
        expect(getMaterialFamily(fakeMaterial("standard"))).toBe("standard");
        expect(getMaterialFamily(fakeMaterial("shader"))).toBe("shader");
        expect(getMaterialFamily(fakeMaterial("node"))).toBe("node");
        expect(getMaterialFamily(fakeMaterial("custom"))).toBe("custom");
        expect(getMaterialFamily(fakeMaterial())).toBeUndefined();
        expect(getMaterialFamily({ name: "plain" } as Material)).toBeUndefined();
    });

    it("unwraps views and publicly identifies them", () => {
        const source = fakeMaterial("pbr");
        const view = createMaterialView(source, { features: 0 });

        expect(isMaterialView(source)).toBe(false);
        expect(isMaterialView(view)).toBe(true);
        expect(getMaterialSource(source)).toBe(source);
        expect(getMaterialSource(view)).toBe(source);
        expect(getMaterialFamily(view)).toBe("pbr");
    });

    it("keeps family guards narrow and view-aware", () => {
        const pbrView = createMaterialView(fakeMaterial("pbr"), { features: 0 });
        expect(isPbrMaterial(pbrView)).toBe(true);
        expect(isStandardMaterial(pbrView)).toBe(false);
        expect(isShaderMaterial(fakeMaterial("shader"))).toBe(true);
        expect(isNodeMaterial(fakeMaterial("node"))).toBe(true);
        expect(isPbrMaterial(fakeMaterial())).toBe(false);
    });
});

describe("getMaterialTextures", () => {
    const textures = Array.from({ length: 24 }, (_, index) => texture2d(index));

    it("preserves Standard slot order, duplicates, and cube exclusion", () => {
        const material = {
            ...fakeMaterial("standard"),
            diffuseTexture: textures[0],
            _emissiveTexture: textures[0],
            _bumpTexture: null,
            _specularTexture: textures[1],
            _ambientTexture: textures[2],
            _lightmapTexture: textures[3],
            _opacityTexture: textures[4],
            _reflectionTexture: textures[5],
            _reflectionCubeTexture: {},
        };

        expect(getMaterialTextures(material)).toEqual([textures[0], textures[0], textures[1], textures[2], textures[3], textures[4], textures[5]]);
    });

    it("preserves PBR core and optional-family order", () => {
        const material = {
            ...fakeMaterial("pbr"),
            baseColorTexture: textures[0],
            normalTexture: textures[1],
            ormTexture: textures[2],
            occlusionTexture: textures[3],
            emissiveTexture: textures[4],
            specGlossTexture: textures[5],
            lightmapTexture: textures[6],
            _metallicReflectanceTexture: textures[7],
            _reflectanceTexture: textures[8],
            _clearCoat: { texture: textures[9], roughnessTexture: textures[10], bumpTexture: textures[11] },
            _sheen: { isEnabled: true, texture: textures[12], roughnessTexture: textures[13] },
            _iridescence: { texture: textures[14], thicknessTexture: textures[15] },
            _anisotropy: { isEnabled: true, texture: textures[16] },
            _subsurface: {
                translucency: { colorTexture: textures[17], intensityTexture: textures[18] },
                thickness: { texture: textures[19] },
                refraction: { texture: textures[20] },
            },
            _transmissive: true,
        };

        expect(getMaterialTextures(material)).toEqual(textures.slice(0, 21));
    });

    it("uses Shader declaration order and Node own-property insertion order", () => {
        const shader = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex() -> @builtin(position) vec4f { return vec4f(); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(); }`,
            attributes: ["position"],
            samplers: ["zeta", "empty", "alpha"],
        });
        setShaderTexture(shader, "zeta", textures[0]!);
        setShaderTexture(shader, "alpha", textures[1]!);
        const node = {
            ...fakeMaterial("node"),
            inputs: {
                zeta: { type: "texture2d", texture: textures[0] },
                alpha: { type: "texture2d", texture: textures[1] },
                value: { type: "f32", value: 1 },
            },
        };
        Object.setPrototypeOf(node.inputs, { inherited: { type: "texture2d", texture: textures[2] } });

        expect(getMaterialTextures(shader)).toEqual([textures[0], textures[1]]);
        expect(getMaterialTextures(node)).toEqual([textures[0], textures[1]]);
    });

    it("unwraps material views and returns no textures for unknown families", () => {
        const source = { ...fakeMaterial("standard"), diffuseTexture: textures[0] };
        expect(getMaterialTextures(createMaterialView(source, { features: 0 }))).toEqual([textures[0]]);
        expect(getMaterialTextures(fakeMaterial("unknown"))).toEqual([]);
    });

    it("uses domain accessors without extension registries or private slot scans", () => {
        const source = readFileSync(resolve(__dirname, "../../../packages/babylon-lite/src/material/material-textures.ts"), "utf-8");

        expect(source).toMatch(/\bgetStandardEmissiveTexture\s*\(/);
        expect(source).toMatch(/\bgetPbrClearCoat\s*\(/);
        expect(source).toMatch(/\bgetShaderTexture\s*\(/);
        expect(source).not.toMatch(/_getStdTextureCollectors|_getPbrTextureCollectors|_getStdExts|_getPbrExts|_textureSlots/);
    });
});
