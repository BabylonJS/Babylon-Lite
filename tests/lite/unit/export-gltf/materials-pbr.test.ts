import { describe, expect, it } from "vitest";
import { createFakeDevice, createMesh, createScene, createTexture, decodePng, exportAndParse, readBufferView } from "./export-test-utils";
import type { FakeTextureOptions, ParsedGlb } from "./export-test-utils";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { createMaterialView } from "../../../../packages/babylon-lite/src/material/material-view";
import type { Material } from "../../../../packages/babylon-lite/src/material/material";
import { srgbByteToLinear } from "../../../../packages/babylon-lite/src/math/color";
import type { Mesh } from "../../../../packages/babylon-lite/src/mesh/mesh";

type State = "uv1" | "uv0" | "lost";

const LOST_UV1 = /Material "[^"]*" samples TEXCOORD_1 on a mesh whose second UV set is on the GPU only/;

function meshFor(name: string, material: Mesh["material"], state: State): Mesh {
    if (state === "uv1") {
        return createMesh(name, { material, uv2s: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]) });
    }
    if (state === "lost") {
        return createMesh(name, { material, gpuOnly: ["uv2"] });
    }
    return createMesh(name, { material });
}

type Result = ParsedGlb & { mat: any };

async function run(material: Mesh["material"], options: { state?: State; device?: boolean } = {}): Promise<Result> {
    const scene = createScene({ meshes: [meshFor("m", material, options.state ?? "uv0")], ...(options.device === false ? {} : { device: createFakeDevice().device }) });
    const glb = await exportAndParse(scene);
    return { ...glb, mat: glb.json.materials?.[0] };
}

async function runStates(material: Mesh["material"], states: State[]): Promise<ParsedGlb> {
    const meshes = states.map((s, i) => meshFor(`m${i}`, material, s));
    return exportAndParse(createScene({ meshes, device: createFakeDevice().device }));
}

/** A texture with distinct pixels per seed, so images never dedupe by accident. */
function tex(seed: number, options: FakeTextureOptions = {}, w = 2, h = 2) {
    return createTexture(w, h, [seed, seed + 1, seed + 2, 255], options);
}

function primitiveMaterials(glb: ParsedGlb): (number | undefined)[] {
    return glb.json.meshes.flatMap((m: { primitives: { material?: number }[] }) => m.primitives.map((p) => p.material));
}

const close = (actual: number[], expected: number[], digits = 6): void => {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((e, i) => expect(actual[i]).toBeCloseTo(e, digits));
};

describe("PBR core: base color", () => {
    it("omits everything for a default material", async () => {
        const r = await run(createPbrMaterial());
        expect(r.mat).toEqual({});
        expect(r.json.textures).toBeUndefined();
        expect(r.warnings).toEqual([]);
    });

    it("writes baseColorFactor as [f.rgb, f.a * alpha]", async () => {
        const r = await run(createPbrMaterial({ baseColorFactor: [0.5, 0.25, 1, 0.8], alpha: 0.5 }));
        close(r.mat.pbrMetallicRoughness.baseColorFactor, [0.5, 0.25, 1, 0.4]);
        expect(r.mat.alphaMode).toBe("BLEND");
    });

    it("omits a factor that is approximately [1, 1, 1, 1]", async () => {
        const r = await run(createPbrMaterial({ baseColorFactor: [1, 1, 1 - 1e-9, 1] }));
        expect(r.mat.pbrMetallicRoughness).toBeUndefined();
    });

    it("folds a 1x1 rgba8unorm-srgb base color into the factor (sRGB decoded, alpha byte / 255)", async () => {
        const texture = createTexture(1, 1, [128, 64, 255, 128], { format: "rgba8unorm-srgb" });
        const r = await run(createPbrMaterial({ baseColorTexture: texture, baseColorFactor: [0.5, 1, 0.25, 0.5], alpha: 0.5 }));
        close(r.mat.pbrMetallicRoughness.baseColorFactor, [srgbByteToLinear(128) * 0.5, srgbByteToLinear(64), srgbByteToLinear(255) * 0.25, (128 / 255) * 0.5 * 0.5]);
        expect(r.mat.pbrMetallicRoughness.baseColorTexture).toBeUndefined();
        expect(r.json.images).toBeUndefined();
        expect(r.json.textures).toBeUndefined();
    });

    it("folds a 1x1 rgba8unorm base color as byte / 255", async () => {
        const texture = createTexture(1, 1, [128, 64, 255, 128], { format: "rgba8unorm" });
        const r = await run(createPbrMaterial({ baseColorTexture: texture, baseColorFactor: [0.5, 1, 0.25, 1] }));
        close(r.mat.pbrMetallicRoughness.baseColorFactor, [(128 / 255) * 0.5, 64 / 255, 0.25, 128 / 255]);
        expect(r.json.images).toBeUndefined();
    });

    it("exports a larger base color texture as an image and keeps the factor", async () => {
        const r = await run(createPbrMaterial({ baseColorTexture: tex(10), baseColorFactor: [0.5, 0.5, 0.5, 1] }));
        expect(r.mat.pbrMetallicRoughness.baseColorTexture).toEqual({ index: 0 });
        expect(r.mat.pbrMetallicRoughness.baseColorFactor).toEqual([0.5, 0.5, 0.5, 1]);
        expect(r.json.images).toHaveLength(1);
        expect(r.json.images[0].name).toBe("baseColorTexture");
    });
});

describe("PBR core: metallic-roughness and occlusion", () => {
    it("omits metallic and roughness at 1 and writes other values", async () => {
        const r = await run(createPbrMaterial({ metallicFactor: 1, roughnessFactor: 1 }));
        expect(r.mat.pbrMetallicRoughness).toBeUndefined();
        const r2 = await run(createPbrMaterial({ metallicFactor: 0.25, roughnessFactor: 0.75 }));
        expect(r2.mat.pbrMetallicRoughness).toEqual({ metallicFactor: 0.25, roughnessFactor: 0.75 });
    });

    it("exports an ORM texture as metallicRoughnessTexture and occlusionTexture sharing one image and texture", async () => {
        const r = await run(createPbrMaterial({ ormTexture: tex(20) }));
        const mr = r.mat.pbrMetallicRoughness.metallicRoughnessTexture;
        expect(mr).toEqual({ index: 0 });
        expect(r.mat.occlusionTexture).toEqual({ index: 0 });
        expect(r.json.images).toHaveLength(1);
        expect(r.json.textures).toHaveLength(1);
    });

    it("folds a 1x1 ORM [255, g, b, 255] into metallic * b/255 and roughness * g/255 without an image", async () => {
        const orm = createTexture(1, 1, [255, 128, 64, 255]);
        const r = await run(createPbrMaterial({ ormTexture: orm, metallicFactor: 0.5, roughnessFactor: 0.8 }));
        expect(r.mat.pbrMetallicRoughness.metallicFactor).toBeCloseTo(0.5 * (64 / 255), 6);
        expect(r.mat.pbrMetallicRoughness.roughnessFactor).toBeCloseTo(0.8 * (128 / 255), 6);
        expect(r.mat.pbrMetallicRoughness.metallicRoughnessTexture).toBeUndefined();
        expect(r.mat.occlusionTexture).toBeUndefined();
        expect(r.json.images).toBeUndefined();
    });

    it("exports a 1x1 ORM with R != 255 as a 1x1 image used by both slots when occlusion reads it", async () => {
        const orm = createTexture(1, 1, [200, 128, 64, 255]);
        const r = await run(createPbrMaterial({ ormTexture: orm, metallicFactor: 0.5, roughnessFactor: 0.8 }));
        expect(r.mat.pbrMetallicRoughness.metallicRoughnessTexture).toEqual({ index: 0 });
        expect(r.mat.occlusionTexture).toEqual({ index: 0 });
        expect(r.mat.pbrMetallicRoughness.metallicFactor).toBe(0.5);
        expect(r.mat.pbrMetallicRoughness.roughnessFactor).toBe(0.8);
        expect(r.json.images).toHaveLength(1);
        const png = await decodePng(readBufferView(r, r.json.images[0].bufferView));
        expect([png.width, png.height]).toEqual([1, 1]);
        expect(Array.from(png.rgba)).toEqual([200, 128, 64, 255]);
    });

    it("folds a 1x1 ORM with R != 255 when occlusionStrength is 0, emitting no occlusion", async () => {
        const orm = createTexture(1, 1, [200, 128, 64, 255]);
        const r = await run(createPbrMaterial({ ormTexture: orm, occlusionStrength: 0 }));
        expect(r.mat.pbrMetallicRoughness.metallicFactor).toBeCloseTo(64 / 255, 6);
        expect(r.mat.pbrMetallicRoughness.roughnessFactor).toBeCloseTo(128 / 255, 6);
        expect(r.mat.pbrMetallicRoughness.metallicRoughnessTexture).toBeUndefined();
        expect(r.mat.occlusionTexture).toBeUndefined();
        expect(r.json.images).toBeUndefined();
    });

    it("folds a 1x1 ORM with R != 255 when a separate occlusion texture is set", async () => {
        const orm = createTexture(1, 1, [200, 128, 64, 255]);
        const r = await run(createPbrMaterial({ ormTexture: orm, occlusionTexture: tex(30) }));
        expect(r.mat.pbrMetallicRoughness.metallicRoughnessTexture).toBeUndefined();
        expect(r.mat.pbrMetallicRoughness.metallicFactor).toBeCloseTo(64 / 255, 6);
        expect(r.mat.occlusionTexture).toEqual({ index: 0 });
        expect(r.json.images).toHaveLength(1);
    });

    it("writes occlusionStrength as the occlusion strength", async () => {
        const r = await run(createPbrMaterial({ ormTexture: tex(20), occlusionStrength: 0.5 }));
        expect(r.mat.occlusionTexture).toEqual({ index: 0, strength: 0.5 });
    });

    it("omits occlusion entirely at strength 0", async () => {
        const r = await run(createPbrMaterial({ ormTexture: tex(20), occlusionStrength: 0, occlusionTexture: tex(40) }));
        expect(r.mat.occlusionTexture).toBeUndefined();
        expect(r.json.images).toHaveLength(1);
    });

    it("exports a separate UV0 occlusionTexture as its own image", async () => {
        const r = await run(createPbrMaterial({ ormTexture: tex(20), occlusionTexture: tex(40), occlusionStrength: 0.75 }));
        expect(r.json.images).toHaveLength(2);
        expect(r.mat.pbrMetallicRoughness.metallicRoughnessTexture.index).not.toBe(r.mat.occlusionTexture.index);
        expect(r.mat.occlusionTexture.strength).toBe(0.75);
        expect(r.mat.occlusionTexture.texCoord).toBeUndefined();
    });

    it("does not export an ORM as metallicRoughness for a spec-gloss material", async () => {
        const r = await run(createPbrMaterial({ ormTexture: tex(20), specGlossTexture: tex(50), metallicFactor: 0.5 }));
        expect(r.mat.pbrMetallicRoughness.metallicRoughnessTexture).toBeUndefined();
        expect(r.mat.occlusionTexture).toBeUndefined();
    });
});

describe("PBR core: UV1 occlusion texture (_uv2Mask 32)", () => {
    const make = (extra: Partial<PbrMaterialProps> = {}): PbrMaterialProps =>
        createPbrMaterial({
            occlusionTexture: tex(60, { wrapper: { uScale: 2, uOffset: 0.5, _hasTx: true } }),
            _uv2Mask: 32,
            _hasUvTx: true,
            occlusionStrength: 0.6,
            ...extra,
        });

    it("exports texCoord 1 with no transform in the uv1 state", async () => {
        const r = await run(make(), { state: "uv1" });
        expect(r.mat.occlusionTexture).toEqual({ index: 0, texCoord: 1, strength: 0.6 });
        expect(r.json.extensionsUsed).toBeUndefined();
    });

    it("is absent in the uv0 state", async () => {
        const r = await run(make(), { state: "uv0" });
        expect(r.mat.occlusionTexture).toBeUndefined();
        expect(r.warnings).toEqual([]);
    });

    it("is absent and warns in the lost state", async () => {
        const r = await run(make(), { state: "lost" });
        expect(r.mat.occlusionTexture).toBeUndefined();
        expect(r.warnings.filter((w) => LOST_UV1.test(w))).toHaveLength(1);
    });
});

describe("PBR core: texture transforms", () => {
    const wrapper = { uScale: 2, vScale: 3, uOffset: 0.1, vOffset: 0.2, uAng: 0.5 };

    it("carries KHR_texture_transform on core slots only when _hasUvTx is true", async () => {
        const r = await run(
            createPbrMaterial({ baseColorTexture: tex(10, { wrapper }), normalTexture: tex(11, { wrapper }), emissiveTexture: tex(12, { wrapper }), _hasUvTx: true })
        );
        const expected = { offset: [0.1, 0.2], scale: [2, 3], rotation: 0.5 };
        expect(r.mat.pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform).toEqual(expected);
        expect(r.mat.normalTexture.extensions.KHR_texture_transform).toEqual(expected);
        expect(r.mat.emissiveTexture.extensions.KHR_texture_transform).toEqual(expected);
        expect(r.json.extensionsUsed).toContain("KHR_texture_transform");
        expect(r.json.extensionsRequired).toBeUndefined();
    });

    it("omits the transform when _hasUvTx is unset", async () => {
        const r = await run(createPbrMaterial({ baseColorTexture: tex(10, { wrapper }), ormTexture: tex(13, { wrapper }) }));
        expect(r.mat.pbrMetallicRoughness.baseColorTexture).toEqual({ index: 0 });
        expect(r.mat.pbrMetallicRoughness.metallicRoughnessTexture.extensions).toBeUndefined();
        expect(r.json.extensionsUsed).toBeUndefined();
    });

    it("omits components equal to their defaults and an identity transform entirely", async () => {
        const r = await run(createPbrMaterial({ baseColorTexture: tex(10, { wrapper: { uScale: 2 } }), normalTexture: tex(11, { wrapper: {} }), _hasUvTx: true }));
        expect(r.mat.pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform).toEqual({ scale: [2, 1] });
        expect(r.mat.normalTexture.extensions).toBeUndefined();
    });

    it("writes the transform on a transformed UV0 occlusion texture when _hasUvTx is set", async () => {
        const r = await run(createPbrMaterial({ occlusionTexture: tex(61, { wrapper }), _hasUvTx: true }));
        expect(r.mat.occlusionTexture.extensions.KHR_texture_transform).toEqual({ offset: [0.1, 0.2], scale: [2, 3], rotation: 0.5 });
    });

    it("writes texCoord inside the transform extension for a UV1 slot", async () => {
        const r = await run(createPbrMaterial({ baseColorTexture: tex(10, { wrapper: { uOffset: 0.25 } }), _uv2Mask: 1, _hasUvTx: true }), { state: "uv1" });
        expect(r.mat.pbrMetallicRoughness.baseColorTexture.texCoord).toBe(1);
        expect(r.mat.pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform).toEqual({ offset: [0.25, 0], texCoord: 1 });
    });
});

describe("PBR core: UV1-selected slots", () => {
    const slots: { name: string; bit: number; props: () => Partial<PbrMaterialProps>; read: (mat: any) => any }[] = [
        { name: "baseColor", bit: 1, props: () => ({ baseColorTexture: tex(10) }), read: (m) => m.pbrMetallicRoughness?.baseColorTexture },
        { name: "metallicRoughness", bit: 2, props: () => ({ ormTexture: tex(20) }), read: (m) => m.pbrMetallicRoughness?.metallicRoughnessTexture },
        { name: "occlusion from ORM", bit: 2, props: () => ({ ormTexture: tex(20) }), read: (m) => m.occlusionTexture },
        { name: "normal", bit: 4, props: () => ({ normalTexture: tex(30) }), read: (m) => m.normalTexture },
        { name: "emissive", bit: 8, props: () => ({ emissiveTexture: tex(40), _emissiveColor: [1, 1, 1] }), read: (m) => m.emissiveTexture },
    ];

    for (const slot of slots) {
        describe(`${slot.name} (bit ${slot.bit})`, () => {
            const make = (): PbrMaterialProps => createPbrMaterial({ ...slot.props(), _uv2Mask: slot.bit });

            it("exports texCoord 1 in the uv1 state", async () => {
                const r = await run(make(), { state: "uv1" });
                expect(slot.read(r.mat).texCoord).toBe(1);
            });

            it("exports texCoord 0 in the uv0 state", async () => {
                const r = await run(make(), { state: "uv0" });
                expect(slot.read(r.mat)).toBeDefined();
                expect(slot.read(r.mat).texCoord).toBeUndefined();
                expect(r.warnings).toEqual([]);
            });

            it("is omitted with a warning in the lost state", async () => {
                const r = await run(make(), { state: "lost" });
                expect(slot.read(r.mat)).toBeUndefined();
                expect(r.warnings.filter((w) => LOST_UV1.test(w))).toHaveLength(1);
            });
        });
    }

    it("does not select UV1 for the lightmap bit (64)", async () => {
        const r = await runStates(createPbrMaterial({ baseColorTexture: tex(10), _uv2Mask: 64 }), ["uv1", "uv0", "lost"]);
        expect(r.json.materials).toHaveLength(1);
    });
});

describe("PBR core: one glTF material per (material, UV state)", () => {
    it("shares one glTF material across UV states when no slot selects UV1", async () => {
        const r = await runStates(createPbrMaterial({ baseColorTexture: tex(10) }), ["uv1", "uv0", "lost", "uv0"]);
        expect(r.json.materials).toHaveLength(1);
        expect(primitiveMaterials(r)).toEqual([0, 0, 0, 0]);
    });

    it("emits one glTF material per UV state when a slot selects UV1", async () => {
        const r = await runStates(createPbrMaterial({ baseColorTexture: tex(10), _uv2Mask: 1 }), ["uv1", "uv0", "lost", "uv1"]);
        expect(r.json.materials).toHaveLength(3);
        const used = primitiveMaterials(r);
        expect(new Set(used).size).toBe(3);
        expect(used[0]).toBe(used[3]);
    });

    it("treats an iridescence texture on texCoord 1 as selecting UV1", async () => {
        const material = createPbrMaterial({ _iridescence: { isEnabled: true, texture: tex(10, { wrapper: { _texCoord: 1 } }) } });
        const r = await runStates(material, ["uv1", "uv0"]);
        expect(r.json.materials).toHaveLength(2);
    });

    it("shares the images across the per-state materials", async () => {
        const r = await runStates(createPbrMaterial({ baseColorTexture: tex(10), _uv2Mask: 1 }), ["uv1", "uv0"]);
        expect(r.json.images).toHaveLength(1);
        expect(r.json.textures).toHaveLength(1);
    });
});

describe("PBR core: normal, emissive, alpha, culling", () => {
    it("writes normalTextureScale as normalTexture.scale and omits it at 1", async () => {
        const r = await run(createPbrMaterial({ normalTexture: tex(30), normalTextureScale: 2 }));
        expect(r.mat.normalTexture).toEqual({ index: 0, scale: 2 });
        const r2 = await run(createPbrMaterial({ normalTexture: tex(30), normalTextureScale: 1 }));
        expect(r2.mat.normalTexture).toEqual({ index: 0 });
    });

    it("writes an emissive color <= 1 as the factor", async () => {
        const r = await run(createPbrMaterial({ _emissiveColor: [0.5, 0.25, 1] }));
        expect(r.mat.emissiveFactor).toEqual([0.5, 0.25, 1]);
        expect(r.mat.extensions).toBeUndefined();
        expect(r.json.extensionsUsed).toBeUndefined();
    });

    it("normalizes an emissive color > 1 and emits KHR_materials_emissive_strength with the peak", async () => {
        const r = await run(createPbrMaterial({ _emissiveColor: [4, 2, 1] }));
        close(r.mat.emissiveFactor, [1, 0.5, 0.25]);
        expect(r.mat.extensions.KHR_materials_emissive_strength).toEqual({ emissiveStrength: 4 });
        expect(r.json.extensionsUsed).toContain("KHR_materials_emissive_strength");
    });

    it("defaults the emissive factor to [1, 1, 1] for an unset color with an emissive texture", async () => {
        const r = await run(createPbrMaterial({ emissiveTexture: tex(40) }));
        expect(r.mat.emissiveFactor).toEqual([1, 1, 1]);
        expect(r.mat.emissiveTexture).toEqual({ index: 0 });
    });

    it("omits a black emissive color", async () => {
        const r = await run(createPbrMaterial({ _emissiveColor: [0, 0, 0] }));
        expect(r.mat.emissiveFactor).toBeUndefined();
    });

    it("maps _alphaCutOff to MASK and writes alphaCutoff only when it is not 0.5", async () => {
        const r = await run(createPbrMaterial({ _alphaCutOff: 0.5 }));
        expect(r.mat.alphaMode).toBe("MASK");
        expect(r.mat.alphaCutoff).toBeUndefined();
        const r2 = await run(createPbrMaterial({ _alphaCutOff: 0.3 }));
        expect(r2.mat.alphaMode).toBe("MASK");
        expect(r2.mat.alphaCutoff).toBe(0.3);
    });

    it("maps alphaBlend or alpha < 1 to BLEND, and lets MASK win", async () => {
        expect((await run(createPbrMaterial({ alphaBlend: true }))).mat.alphaMode).toBe("BLEND");
        expect((await run(createPbrMaterial({ alpha: 0.9 }))).mat.alphaMode).toBe("BLEND");
        expect((await run(createPbrMaterial({ alphaBlend: true, _alphaCutOff: 0.4 }))).mat.alphaMode).toBe("MASK");
        expect((await run(createPbrMaterial({ alphaBlend: false, alpha: 1 }))).mat.alphaMode).toBeUndefined();
    });

    it("writes doubleSided only when true", async () => {
        expect((await run(createPbrMaterial({ doubleSided: true }))).mat.doubleSided).toBe(true);
        expect((await run(createPbrMaterial({ doubleSided: false }))).mat.doubleSided).toBeUndefined();
    });
});

describe("PBR core: null engine", () => {
    it("folds 1x1 textures from the props alone and warns", async () => {
        const material = createPbrMaterial({
            name: "x",
            baseColorTexture: createTexture(1, 1, [10, 20, 30, 255]),
            baseColorFactor: [0.5, 0.5, 0.5, 1],
            ormTexture: createTexture(1, 1, [255, 128, 64, 255]),
            metallicFactor: 0.4,
            roughnessFactor: 0.6,
        });
        const r = await run(material, { device: false });
        expect(r.mat.pbrMetallicRoughness).toEqual({ baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0.4, roughnessFactor: 0.6 });
        expect(r.mat.occlusionTexture).toBeUndefined();
        expect(r.warnings).toContain('1×1 factor texture for material "x" is not readable on this engine; exporting its factors without the texture.');
    });

    it("omits larger textures with the unreadable-texture warning", async () => {
        const r = await run(createPbrMaterial({ name: "x", baseColorTexture: tex(10) }), { device: false });
        expect(r.mat.pbrMetallicRoughness).toBeUndefined();
        expect(r.warnings).toContain('Texture pixels for material "x" are not readable on this engine; exporting the material without that texture.');
    });
});

describe("material dispatch", () => {
    it("does not map a material of family shader and warns", async () => {
        const shader = { name: "x", _buildGroup: { _materialFamily: "shader" }, _uboVersion: 0 } as unknown as Material;
        const r = await run(shader);
        expect(r.json.materials).toBeUndefined();
        expect(r.json.meshes[0].primitives[0].material).toBeUndefined();
        expect(r.warnings).toContain('Material "x" of family "shader" is not mapped to glTF; exporting the primitive without a material.');
    });

    it("exports a MaterialView through its source's props and shares the source's glTF material", async () => {
        const source = createPbrMaterial({ name: "src", baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0.2 });
        const view = Object.create(source, { source: { value: source, enumerable: true }, _renderFeatures: { value: { features: 0 }, enumerable: true } }) as Material;
        const r = await exportAndParse(createScene({ meshes: [createMesh("a", { material: view }), createMesh("b", { material: source })], device: createFakeDevice().device }));
        expect(r.json.materials).toHaveLength(1);
        expect(r.json.materials[0].name).toBe("src");
        expect(r.json.materials[0].pbrMetallicRoughness).toEqual({ baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0.2 });
        expect(primitiveMaterials(r)).toEqual([0, 0]);
    });

    it("accepts a view built by createMaterialView", async () => {
        const source = createPbrMaterial({ name: "src", roughnessFactor: 0.3 });
        const view = createMaterialView(source, { features: 0 });
        const r = await run(view);
        expect(r.mat.pbrMetallicRoughness.roughnessFactor).toBe(0.3);
    });
});

describe("material name and extras", () => {
    it("writes the material name and omits it when unset", async () => {
        expect((await run(createPbrMaterial({ name: "gold" }))).mat.name).toBe("gold");
        expect((await run(createPbrMaterial())).mat.name).toBeUndefined();
    });

    it("writes JSON extras from metadata.gltf.extras", async () => {
        const material = createPbrMaterial({ name: "gold", metadata: { gltf: { extras: { tag: "a", n: [1, 2] } } } } as Partial<PbrMaterialProps>);
        const r = await run(material);
        expect(r.mat.extras).toEqual({ tag: "a", n: [1, 2] });
    });

    it("drops non-serializable extras with a warning", async () => {
        const material = createPbrMaterial({ name: "bad", metadata: { gltf: { extras: { big: BigInt(1) } } } } as unknown as Partial<PbrMaterialProps>);
        const r = await run(material);
        expect(r.mat.extras).toBeUndefined();
        expect(r.warnings).toContain('Extras of "bad" are not JSON-serializable; exporting without them.');
    });
});
