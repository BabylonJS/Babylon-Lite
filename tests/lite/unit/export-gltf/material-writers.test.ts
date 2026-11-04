import { describe, expect, it } from "vitest";
import { createFakeDevice, createMesh, createScene, createTexture, decodePng, expectClose, exportAndParse, readBufferView } from "./export-test-utils";
import type { ParsedGlb } from "./export-test-utils";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { linearToSrgbByte, srgbByteToLinear } from "../../../../packages/babylon-lite/src/math/color";

const PIXELS = [128, 64, 32, 79, 16, 8, 4, 143];
const TRANSFORM = { offset: [0.25, 0], scale: [2, 1] };
const tex = () => createTexture(2, 1, PIXELS, { wrapper: { uOffset: 0.25, uScale: 2 } });

async function run(props: Partial<PbrMaterialProps>) {
    const r = await exportAndParse(createScene({ meshes: [createMesh("m", { material: createPbrMaterial(props) })], device: createFakeDevice().device }));
    return { ...r, mat: r.json.materials[0] };
}

function extension(r: Awaited<ReturnType<typeof run>>, name: string): any {
    const key = `KHR_materials_${name}`;
    expect(r.json.extensionsUsed).toContain(key);
    expect(r.json.extensionsRequired).toBeUndefined();
    expect(Object.keys(r.mat.extensions)).toEqual(r.json.extensionsUsed.filter((n: string) => n.startsWith("KHR_materials_")));
    return r.mat.extensions[key];
}

async function pixels(r: ParsedGlb, info: { index: number }): Promise<number[]> {
    return Array.from((await decodePng(readBufferView(r, r.json.images[r.json.textures[info.index].source].bufferView))).rgba);
}

describe("material extension writers", () => {
    it.each<[string, Partial<PbrMaterialProps>, object]>([
        ["emissive_strength", { _emissiveColor: [4, 2, 1] }, { emissiveStrength: 4 }],
        ["clearcoat", { _clearCoat: { isEnabled: true, intensity: 0.5, roughness: 0.2, useF0Remap: false } }, { clearcoatFactor: 0.5, clearcoatRoughnessFactor: 0.2 }],
        ["sheen", { _sheen: { isEnabled: true, color: [0.5, 0.25, 1], intensity: 0.5, roughness: 0.3 } }, { sheenColorFactor: [0.25, 0.125, 0.5], sheenRoughnessFactor: 0.3 }],
        [
            "iridescence",
            { _iridescence: { isEnabled: true, intensity: 0.5, indexOfRefraction: 1.6, minimumThickness: 200, maximumThickness: 500 } },
            { iridescenceFactor: 0.5, iridescenceIor: 1.6, iridescenceThicknessMinimum: 200, iridescenceThicknessMaximum: 500 },
        ],
        [
            "anisotropy",
            { _anisotropy: { isEnabled: true, intensity: 0.5, direction: [0, -1], texture: tex() } },
            { anisotropyStrength: 0.5, anisotropyRotation: -Math.PI / 2, anisotropyTexture: { index: 0, extensions: { KHR_texture_transform: TRANSFORM } } },
        ],
        ["specular", { _metallicF0Factor: 0.3 }, { specularFactor: 0.3 }],
        ["specular", { _specularWeight: 0.7, _metallicF0Factor: 0.3, _metallicReflectanceColor: [1, 0.5, 0.25] }, { specularFactor: 0.7, specularColorFactor: [1, 0.5, 0.25] }],
        [
            "transmission",
            { _transmissive: true, _subsurface: { refraction: { intensity: 0.7, texture: tex() } } },
            { transmissionFactor: 0.7, transmissionTexture: { index: 0, extensions: { KHR_texture_transform: TRANSFORM } } },
        ],
        [
            "volume",
            { _subsurface: { thickness: { useGlTFChannel: true, max: 2 }, tint: { color: [0.5, 0.2, 0.1], atDistance: 3 } } },
            { thicknessFactor: 2, attenuationColor: [0.5, 0.2, 0.1], attenuationDistance: 3 },
        ],
        ["volume", { _subsurface: { thickness: { useGlTFChannel: true, max: 2 }, tint: { color: [1, 1, 1], atDistance: 1 } } }, { thicknessFactor: 2 }],
        ["volume", { _subsurface: { tint: { color: [0.5, 0.5, 0.25], atDistance: 2 } } }, { attenuationColor: [0.5, 0.5, 0.25], attenuationDistance: 2 }],
        ["dispersion", { _subsurface: { thickness: { useGlTFChannel: true, max: 1 }, refraction: { dispersion: 4 } } }, { dispersion: 5 }],
        [
            "diffuse_transmission",
            { _subsurface: { translucency: { intensity: 0.5, color: [0.5, 0.25, 1] }, thickness: { min: 0, max: 0 } } },
            { diffuseTransmissionFactor: 0.5, diffuseTransmissionColorFactor: [0.5, 0.25, 1] },
        ],
    ])("exports %s factors/textures and extension bookkeeping", async (name, props, expected) => {
        const r = await run(props);
        expect(extension(r, name)).toEqual(expected);
        if (name === "emissive_strength") {
            expect(r.mat.emissiveFactor).toEqual([1, 0.5, 0.25]);
        }
    });

    it.each<NonNullable<PbrMaterialProps["_subsurface"]>>([
        { thickness: { min: 0, max: 2 }, translucency: { intensity: 0.5 } },
        { refraction: { dispersion: 4 } },
        { thickness: { max: 1 }, refraction: { dispersion: 0 } },
        { thickness: { max: 1 }, refraction: {} },
    ])("omits disabled extensions and rejects non-glTF subsurface markers (%j)", async (_subsurface) => {
        const r = await run({
            _unlit: false,
            _clearCoat: { isEnabled: false },
            _sheen: { isEnabled: false },
            _iridescence: { isEnabled: false },
            _anisotropy: { isEnabled: false },
            _transmissive: false,
            _subsurface,
        });
        expect(r.mat.extensions).toBeUndefined();
        expect(r.json.extensionsUsed).toBeUndefined();
    });

    it.each<[Partial<PbrMaterialProps>, number[] | undefined]>([
        [{}, [0.2, 0.4, 0.6, 1]],
        [{ baseColorFactor: [0.5, 0.5, 0.5, 1] }, [0.1, 0.2, 0.3, 1]],
        [{ alpha: 0.5 }, [0.2, 0.4, 0.6, 0.5]],
        [{ _unlitColor: [2, 0.5, 1], baseColorFactor: [0.75, 0.5, 1, 1] }, [1, 0.25, 1, 1]],
        [{ _unlitColor: [2, 2, 2], baseColorFactor: [0.5, 0.5, 0.5, 1] }, undefined],
        [{ baseColorTexture: createTexture(1, 1, [255, 255, 255, 255]) }, [0.2, 0.4, 0.6, 1]],
    ])("applies unlit tint after folds, preserving alpha, clamping and omission (%j)", async (props, expected) => {
        const r = await run({ _unlit: true, _unlitColor: [0.2, 0.4, 0.6], ...props });
        expect(r.mat.pbrMetallicRoughness?.baseColorFactor).toEqual(expected);
        expect(extension(r, "unlit")).toEqual({});
        expect(r.json.images).toBeUndefined();
    });

    it.each<[Partial<PbrMaterialProps>, number | undefined]>([
        [{ reflectance: 0.2 }, (1 + Math.sqrt(0.2)) / (1 - Math.sqrt(0.2))],
        [{ reflectance: 5 }, (1 + Math.sqrt(0.99)) / (1 - Math.sqrt(0.99))],
        [{ reflectance: -1 }, 1],
        [{ reflectance: 0.04 }, undefined],
        [{ reflectance: 0.2, _subsurface: { refraction: { indexOfRefraction: 1.33 } } }, 1.33],
        [{ _subsurface: { refraction: { indexOfRefraction: 1.5 + 1e-10 } } }, undefined],
        [{ _subsurface: { refraction: { indexOfRefraction: 1.5005 } } }, 1.5005],
        [{ reflectance: 0.2, specGlossTexture: tex() }, undefined],
    ])("preserves IOR derivation, bounds, precedence and tight omission (%j)", async (props, expected) => {
        const r = await run(props);
        if (expected === undefined) {
            expect(r.mat.extensions?.KHR_materials_ior).toBeUndefined();
            expect(r.json.extensionsUsed ?? []).not.toContain("KHR_materials_ior");
        } else {
            expect(extension(r, "ior").ior).toBeCloseTo(expected, 9);
        }
    });

    it.each([undefined, true, false])("warns for unsupported clearcoat IOR and F0 remap (%s)", async (useF0Remap) => {
        const r = await run({ name: "coat", _clearCoat: { isEnabled: true, indexOfRefraction: 1.4, useF0Remap } });
        expect(r.warnings).toContain('Material "coat" has a clearcoat index of refraction of 1.4, which KHR_materials_clearcoat cannot represent; exporting it as 1.5.');
        expect(r.warnings.some((w) => w.includes("remaps F0 under its clearcoat"))).toBe(useF0Remap !== false);
    });

    it("exports all clearcoat texture slots and normal scale", async () => {
        const _clearCoat = { isEnabled: true, texture: tex(), roughnessTexture: tex(), bumpTexture: tex(), bumpTextureScale: 2, useF0Remap: false };
        const r = await run({ _clearCoat });
        expect(extension(r, "clearcoat")).toMatchObject({
            clearcoatTexture: { index: 0 },
            clearcoatRoughnessTexture: { index: 0 },
            clearcoatNormalTexture: { index: 0, scale: 2 },
        });
    });

    it.each([false, true])("encodes sheen RGB and preserves packed roughness alpha (albedo scaling: %s)", async (albedoScaling) => {
        const texture = createTexture(2, 1, PIXELS, { wrapper: { _hasTx: true, uScale: 2, uOffset: 0.25 } });
        const r = await run({ _sheen: { isEnabled: true, albedoScaling, texture } });
        const sheen = extension(r, "sheen");
        expect(sheen.sheenRoughnessTexture).toEqual(sheen.sheenColorTexture);
        expect(sheen.sheenColorTexture.extensions.KHR_texture_transform).toEqual(TRANSFORM);
        expect(r.json.images).toHaveLength(1);
        expect(await pixels(r, sheen.sheenColorTexture)).toEqual(PIXELS.map((v, i) => (i % 4 === 3 ? v : linearToSrgbByte(albedoScaling ? v / 255 : (v / 255) ** 2.2))));
    });

    it("uses a separate sheen roughness texture rather than the color alpha when supplied", async () => {
        const roughnessTexture = createTexture(2, 1, [20, 30, 40, 50], { wrapper: { uScale: 2 } });
        const r = await run({ _sheen: { isEnabled: true, texture: tex(), roughnessTexture } });
        const sheen = extension(r, "sheen");
        expect(sheen.sheenRoughnessTexture.index).not.toBe(sheen.sheenColorTexture.index);
        expect(sheen.sheenRoughnessTexture.extensions.KHR_texture_transform).toEqual({ scale: [2, 1] });
        expect(r.json.images).toHaveLength(2);
    });

    it.each<[GPUTextureFormat, number[]]>([
        ["rgba8unorm-srgb", PIXELS],
        ["rgba8unorm", PIXELS.map((v, i) => (i % 4 === 3 ? v : linearToSrgbByte(v / 255)))],
    ])("encodes iridescence intensity and thickness textures for the loader's sRGB upload (%s)", async (format, expected) => {
        const texture = createTexture(2, 1, PIXELS, { format });
        const r = await run({ _iridescence: { isEnabled: true, texture, thicknessTexture: texture } });
        const ir = extension(r, "iridescence");
        expect(ir.iridescenceTexture).toEqual(ir.iridescenceThicknessTexture);
        expect(r.json.images).toHaveLength(1);
        expect(await pixels(r, ir.iridescenceTexture)).toEqual(expected);
    });

    it("preserves iridescence-only UV1 available/missing/lost material variants", async () => {
        const texture = createTexture(2, 1, PIXELS, { wrapper: { _texCoord: 1, _hasTx: true, uScale: 2 } });
        const material = createPbrMaterial({ _iridescence: { isEnabled: true, texture, thicknessTexture: texture } });
        const meshes = [createMesh("uv1", { material, uv2s: new Float32Array(8) }), createMesh("uv0", { material }), createMesh("lost", { material, gpuOnly: ["uv2"] })];
        const r = await exportAndParse(createScene({ meshes, device: createFakeDevice().device }));
        expect(r.json.materials).toHaveLength(3);
        for (const [i, mat] of r.json.materials.entries()) {
            const ir = mat.extensions.KHR_materials_iridescence;
            for (const slot of ["iridescenceTexture", "iridescenceThicknessTexture"]) {
                expect(ir[slot]).toEqual(
                    i === 2
                        ? undefined
                        : { index: 0, ...(i === 0 ? { texCoord: 1 } : {}), extensions: { KHR_texture_transform: { scale: [2, 1], ...(i === 0 ? { texCoord: 1 } : {}) } } }
                );
            }
        }
        expect(r.json.images).toHaveLength(1);
        expect(r.warnings.filter((w) => w.includes("samples TEXCOORD_1"))).toHaveLength(1);
    });

    it.each(["rgba8unorm", "rgba8unorm-srgb"] as const)("preserves diffuse-transmission color and shares alpha-only specular/intensity images from %s", async (format) => {
        const texture = createTexture(2, 1, PIXELS, { format });
        const r = await run({
            _metallicReflectanceTexture: texture,
            _reflectanceTexture: texture,
            _subsurface: { translucency: { intensityTexture: texture, colorTexture: texture }, thickness: { min: 0, max: 0 } },
        });
        const dt = extension(r, "diffuse_transmission");
        const sp = extension(r, "specular");
        expect(sp.specularTexture.index).toBe(dt.diffuseTransmissionTexture.index);
        expect(sp.specularColorTexture.index).toBe(sp.specularTexture.index);
        expect(await pixels(r, dt.diffuseTransmissionTexture)).toEqual(PIXELS);
        expect(await pixels(r, dt.diffuseTransmissionColorTexture)).toEqual(PIXELS.map((v, i) => (i % 4 === 3 || format.endsWith("-srgb") ? v : linearToSrgbByte(v / 255))));
        expect(r.json.images).toHaveLength(format.endsWith("-srgb") ? 1 : 2);
        expect(r.mat.extensions.KHR_materials_volume).toBeUndefined();
    });

    it.each(["rgba8unorm", "rgba8unorm-srgb"] as const)("preserves specular-glossiness sampled RGB and gloss alpha from %s", async (format) => {
        const r = await run({ specGlossTexture: createTexture(2, 1, PIXELS, { format }) });
        expect(await pixels(r, extension(r, "pbrSpecularGlossiness").specularGlossinessTexture)).toEqual(
            PIXELS.map((v, i) => (i % 4 === 3 || format.endsWith("-srgb") ? v : linearToSrgbByte(v / 255)))
        );
    });

    it("resolves spec-gloss diffuse factors after a base-color fold and retains ORM occlusion without metallic-roughness", async () => {
        const r = await run({
            specGlossTexture: tex(),
            baseColorTexture: createTexture(1, 1, [128, 64, 255, 255], { format: "rgba8unorm-srgb" }),
            baseColorFactor: [1, 0.5, 1, 1],
            ormTexture: tex(),
            metallicFactor: 0.5,
        });
        const sg = extension(r, "pbrSpecularGlossiness");
        expectClose(sg.diffuseFactor, [srgbByteToLinear(128), srgbByteToLinear(linearToSrgbByte(srgbByteToLinear(64) * 0.5)), 1, 1], 6);
        expect(sg.diffuseFactor).toEqual(r.mat.pbrMetallicRoughness.baseColorFactor);
        expect(sg.diffuseTexture).toBeUndefined();
        expect(r.mat.pbrMetallicRoughness.metallicRoughnessTexture).toBeUndefined();
        expect(r.mat.pbrMetallicRoughness.metallicFactor).toBe(0.5);
        expect(r.mat.occlusionTexture.index).not.toBe(sg.specularGlossinessTexture.index);
        expect(r.json.images).toHaveLength(2);
    });

    it.each(["uv1", "uv0", "lost"] as const)("preserves spec-gloss diffuse texture/factor and UV1 slots in %s state", async (state) => {
        const material = createPbrMaterial({ specGlossTexture: tex(), baseColorTexture: tex(), baseColorFactor: [0.5, 0.25, 1, 0.8], _uv2Mask: 17 });
        const mesh = createMesh("m", { material, uv2s: state === "uv1" ? new Float32Array(8) : undefined, gpuOnly: state === "lost" ? ["uv2"] : [] });
        const r = await exportAndParse(createScene({ meshes: [mesh], device: createFakeDevice().device }));
        const sg = r.json.materials[0].extensions.KHR_materials_pbrSpecularGlossiness;
        expect(sg.diffuseFactor).toEqual([0.5, 0.25, 1, 0.8]);
        for (const info of [sg.diffuseTexture, sg.specularGlossinessTexture]) {
            expect(info).toEqual(state === "lost" ? undefined : { index: 0, ...(state === "uv1" ? { texCoord: 1 } : {}) });
        }
        expect(r.warnings.filter((w) => w.includes("samples TEXCOORD_1"))).toHaveLength(state === "lost" ? 1 : 0);
    });
});
