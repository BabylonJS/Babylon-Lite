import { describe, expect, it } from "vitest";
import { createFakeDevice, createMesh, createScene, createTexture, decodePng, exportAndParse, readBufferView } from "./export-test-utils";
import type { ParsedGlb } from "./export-test-utils";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { srgbByteToLinear } from "../../../../packages/babylon-lite/src/math/color";
import type { Mesh } from "../../../../packages/babylon-lite/src/mesh/mesh";

type State = "uv1" | "uv0" | "lost";
type Result = ParsedGlb & { mat: any };

const LOST_UV1 = /samples TEXCOORD_1 on a mesh whose second UV set is on the GPU only/;
const TT = "KHR_texture_transform";

function meshFor(material: Mesh["material"], state: State): Mesh {
    if (state === "uv1") {
        return createMesh("m", { material, uv2s: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]) });
    }
    if (state === "lost") {
        return createMesh("m", { material, gpuOnly: ["uv2"] });
    }
    return createMesh("m", { material });
}

async function run(props: Partial<PbrMaterialProps>, state: State = "uv0"): Promise<Result> {
    const glb = await exportAndParse(createScene({ meshes: [meshFor(createPbrMaterial(props), state)], device: createFakeDevice().device }));
    return { ...glb, mat: glb.json.materials?.[0] };
}

/** A 2x2 texture with distinct pixels per seed. */
function tex(seed: number, wrapper: Record<string, unknown> = {}) {
    return createTexture(2, 2, [seed, seed + 1, seed + 2, 255], { wrapper });
}

/** Stamped like the loader does: `_hasTx` plus a non-identity transform. */
const STAMPED = { _hasTx: true, uScale: 2, uOffset: 0.25 };
/** A non-identity transform without the `_hasTx` stamp. */
const UNSTAMPED = { uScale: 2, uOffset: 0.25 };
const STAMPED_RESULT = { offset: [0.25, 0], scale: [2, 1] };

function expectClose(actual: number[], expected: number[]): void {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((e, i) => expect(actual[i]).toBeCloseTo(e, 6));
}

function isUsed(r: Result, name: string): boolean {
    return (r.json.extensionsUsed ?? []).includes(name);
}

/** Asserts the extension is emitted: present on the material, listed in extensionsUsed, never required. */
function expectEmitted(r: Result, name: string): any {
    expect(r.mat.extensions?.[name]).toBeDefined();
    expect(isUsed(r, name)).toBe(true);
    expect(r.json.extensionsRequired).toBeUndefined();
    return r.mat.extensions[name];
}

function expectAbsent(r: Result, name: string): void {
    expect(r.mat.extensions?.[name]).toBeUndefined();
    expect(isUsed(r, name)).toBe(false);
    expect(r.json.extensionsRequired).toBeUndefined();
}

function transformOf(info: any): unknown {
    return info.extensions?.[TT];
}

describe("KHR_materials_unlit", () => {
    it("is emitted for _unlit materials", async () => {
        const r = await run({ _unlit: true });
        expect(expectEmitted(r, "KHR_materials_unlit")).toEqual({});
    });

    it("is absent when _unlit is false or unset", async () => {
        expectAbsent(await run({ _unlit: false }), "KHR_materials_unlit");
        expectAbsent(await run({}), "KHR_materials_unlit");
    });

    it("writes _unlitColor as baseColorFactor when the core factor was omitted", async () => {
        const r = await run({ _unlit: true, _unlitColor: [0.2, 0.4, 0.6] });
        expect(r.mat.pbrMetallicRoughness.baseColorFactor).toEqual([0.2, 0.4, 0.6, 1]);
    });

    it("multiplies a core baseColorFactor's RGB by _unlitColor", async () => {
        const r = await run({ _unlit: true, _unlitColor: [0.2, 0.4, 0.6], baseColorFactor: [0.5, 0.5, 0.5, 1] });
        expectClose(r.mat.pbrMetallicRoughness.baseColorFactor, [0.1, 0.2, 0.3, 1]);
    });

    it("multiplies the RGB of a factor produced by alpha and keeps the alpha", async () => {
        const r = await run({ _unlit: true, _unlitColor: [0.2, 0.4, 0.6], alpha: 0.5 });
        expectClose(r.mat.pbrMetallicRoughness.baseColorFactor, [0.2, 0.4, 0.6, 0.5]);
    });

    it("clamps the tinted factor to [0, 1]", async () => {
        const r = await run({ _unlit: true, _unlitColor: [2, 0.5, 1], baseColorFactor: [0.75, 0.5, 1, 1] });
        expectClose(r.mat.pbrMetallicRoughness.baseColorFactor, [1, 0.25, 1, 1]);
    });

    it("removes baseColorFactor when the tinted result is all ones", async () => {
        const r = await run({ _unlit: true, _unlitColor: [2, 2, 2], baseColorFactor: [0.5, 0.5, 0.5, 1] });
        expect(r.mat.pbrMetallicRoughness).toBeUndefined();
        expectEmitted(r, "KHR_materials_unlit");
    });

    it("omits a white _unlitColor", async () => {
        const r = await run({ _unlit: true, _unlitColor: [1, 1, 1] });
        expect(r.mat.pbrMetallicRoughness).toBeUndefined();
    });

    it("applies _unlitColor once a 1x1 base color folds to the omitted factor", async () => {
        const r = await run({ _unlit: true, _unlitColor: [0.2, 0.4, 0.6], baseColorTexture: createTexture(1, 1, [255, 255, 255, 255]) });
        expect(r.mat.pbrMetallicRoughness.baseColorFactor).toEqual([0.2, 0.4, 0.6, 1]);
        expect(r.json.images).toBeUndefined();
    });
});

describe("KHR_materials_emissive_strength", () => {
    it("emits the peak of an emissive color above 1", async () => {
        const r = await run({ _emissiveColor: [2, 1, 0.5] });
        expect(expectEmitted(r, "KHR_materials_emissive_strength")).toEqual({ emissiveStrength: 2 });
    });

    it("is absent at a peak of exactly 1, below 1 and for an unset color", async () => {
        expectAbsent(await run({ _emissiveColor: [1, 0.5, 0.5] }), "KHR_materials_emissive_strength");
        expectAbsent(await run({ _emissiveColor: [0.2, 0.1, 0] }), "KHR_materials_emissive_strength");
        expectAbsent(await run({}), "KHR_materials_emissive_strength");
    });
});

describe("KHR_materials_clearcoat", () => {
    it("is absent unless isEnabled", async () => {
        expectAbsent(await run({ _clearCoat: { isEnabled: false, intensity: 1 } }), "KHR_materials_clearcoat");
        expectAbsent(await run({}), "KHR_materials_clearcoat");
    });

    it("defaults to clearcoatFactor 1 and omits a zero roughness", async () => {
        const r = await run({ _clearCoat: { isEnabled: true, useF0Remap: false } });
        expect(expectEmitted(r, "KHR_materials_clearcoat")).toEqual({ clearcoatFactor: 1 });
    });

    it("writes intensity and roughness, omitting an intensity of 0", async () => {
        const r = await run({ _clearCoat: { isEnabled: true, intensity: 0.5, roughness: 0.2, useF0Remap: false } });
        expect(expectEmitted(r, "KHR_materials_clearcoat")).toEqual({ clearcoatFactor: 0.5, clearcoatRoughnessFactor: 0.2 });
        const r0 = await run({ _clearCoat: { isEnabled: true, intensity: 0, useF0Remap: false } });
        expect(expectEmitted(r0, "KHR_materials_clearcoat")).toEqual({});
    });

    it("exports the three textures, with the normal texture's scale when it is not 1", async () => {
        const r = await run({ _clearCoat: { isEnabled: true, useF0Remap: false, texture: tex(10), roughnessTexture: tex(20), bumpTexture: tex(30), bumpTextureScale: 2 } });
        const cc = expectEmitted(r, "KHR_materials_clearcoat");
        expect(cc.clearcoatTexture).toEqual({ index: 0 });
        expect(cc.clearcoatRoughnessTexture).toEqual({ index: 1 });
        expect(cc.clearcoatNormalTexture).toEqual({ index: 2, scale: 2 });
        const r1 = await run({ _clearCoat: { isEnabled: true, useF0Remap: false, bumpTexture: tex(30), bumpTextureScale: 1 } });
        expect(expectEmitted(r1, "KHR_materials_clearcoat").clearcoatNormalTexture).toEqual({ index: 0 });
    });

    it("warns about an index of refraction other than 1.5", async () => {
        const r = await run({ name: "coat", _clearCoat: { isEnabled: true, useF0Remap: false, indexOfRefraction: 1.4 } });
        expect(r.warnings).toContain('Material "coat" has a clearcoat index of refraction of 1.4, which KHR_materials_clearcoat cannot represent; exporting it as 1.5.');
    });

    it("warns about the F0 remap unless useF0Remap is false", async () => {
        const warning = 'Material "coat" remaps F0 under its clearcoat, which KHR_materials_clearcoat cannot represent; exporting without the remap.';
        expect((await run({ name: "coat", _clearCoat: { isEnabled: true } })).warnings).toContain(warning);
        expect((await run({ name: "coat", _clearCoat: { isEnabled: true, useF0Remap: true } })).warnings).toContain(warning);
        expect((await run({ name: "coat", _clearCoat: { isEnabled: true, useF0Remap: false } })).warnings).not.toContain(warning);
    });

    it("emits neither warning for useF0Remap false and an IOR of 1.5 (or unset)", async () => {
        expect((await run({ _clearCoat: { isEnabled: true, useF0Remap: false, indexOfRefraction: 1.5 } })).warnings).toEqual([]);
        expect((await run({ _clearCoat: { isEnabled: true, useF0Remap: false } })).warnings).toEqual([]);
    });

    describe("texture transform gate (any of the three _hasTx)", () => {
        it("transforms all three slots when any one texture is stamped", async () => {
            for (const stamped of ["texture", "roughnessTexture", "bumpTexture"] as const) {
                const textures = { texture: tex(10, UNSTAMPED), roughnessTexture: tex(20, UNSTAMPED), bumpTexture: tex(30, UNSTAMPED) };
                textures[stamped] = tex(40, STAMPED);
                const r = await run({ _clearCoat: { isEnabled: true, useF0Remap: false, ...textures } });
                const cc = expectEmitted(r, "KHR_materials_clearcoat");
                expect(transformOf(cc.clearcoatTexture)).toEqual(STAMPED_RESULT);
                expect(transformOf(cc.clearcoatRoughnessTexture)).toBeDefined();
                expect(transformOf(cc.clearcoatNormalTexture)).toBeDefined();
                expect(isUsed(r, TT)).toBe(true);
            }
        });

        it("transforms none when no texture is stamped, even with non-identity values", async () => {
            const r = await run({
                _clearCoat: { isEnabled: true, useF0Remap: false, texture: tex(10, UNSTAMPED), roughnessTexture: tex(20, UNSTAMPED), bumpTexture: tex(30, UNSTAMPED) },
            });
            const cc = expectEmitted(r, "KHR_materials_clearcoat");
            expect(cc.clearcoatTexture.extensions).toBeUndefined();
            expect(cc.clearcoatRoughnessTexture.extensions).toBeUndefined();
            expect(cc.clearcoatNormalTexture.extensions).toBeUndefined();
            expect(isUsed(r, TT)).toBe(false);
        });
    });
});

describe("KHR_materials_sheen", () => {
    it("is absent unless isEnabled", async () => {
        expectAbsent(await run({ _sheen: { isEnabled: false } }), "KHR_materials_sheen");
    });

    it("defaults to a white sheen color factor", async () => {
        const r = await run({ _sheen: { isEnabled: true } });
        expect(expectEmitted(r, "KHR_materials_sheen")).toEqual({ sheenColorFactor: [1, 1, 1] });
    });

    it("multiplies color by intensity and omits an all-zero color", async () => {
        const r = await run({ _sheen: { isEnabled: true, color: [0.5, 0.25, 1], intensity: 0.5, roughness: 0.3 } });
        expect(expectEmitted(r, "KHR_materials_sheen")).toEqual({ sheenColorFactor: [0.25, 0.125, 0.5], sheenRoughnessFactor: 0.3 });
        const zero = await run({ _sheen: { isEnabled: true, intensity: 0 } });
        expect(expectEmitted(zero, "KHR_materials_sheen")).toEqual({});
    });

    it("re-references the color texture as sheenRoughnessTexture for packed roughness", async () => {
        const r = await run({ _sheen: { isEnabled: true, texture: tex(10) } });
        const sheen = expectEmitted(r, "KHR_materials_sheen");
        expect(sheen.sheenColorTexture).toEqual({ index: 0 });
        expect(sheen.sheenRoughnessTexture).toEqual({ index: 0 });
        expect(r.json.images).toHaveLength(1);
        expect(r.json.textures).toHaveLength(1);
    });

    it("exports a separate roughness texture as its own image", async () => {
        const r = await run({ _sheen: { isEnabled: true, texture: tex(10), roughnessTexture: tex(20) } });
        const sheen = expectEmitted(r, "KHR_materials_sheen");
        expect(sheen.sheenColorTexture).toEqual({ index: 0 });
        expect(sheen.sheenRoughnessTexture).toEqual({ index: 1 });
        expect(r.json.images).toHaveLength(2);
    });

    it("exports the roughness slot alone from a color-less sheen with a roughness texture", async () => {
        const r = await run({ _sheen: { isEnabled: true, roughnessTexture: tex(20) } });
        const sheen = expectEmitted(r, "KHR_materials_sheen");
        expect(sheen.sheenColorTexture).toBeUndefined();
        expect(sheen.sheenRoughnessTexture).toEqual({ index: 0 });
    });

    describe("texture transform gate", () => {
        it("gates the color texture on its own _hasTx", async () => {
            const stamped = expectEmitted(await run({ _sheen: { isEnabled: true, texture: tex(10, STAMPED) } }), "KHR_materials_sheen");
            expect(transformOf(stamped.sheenColorTexture)).toEqual(STAMPED_RESULT);
            const plain = expectEmitted(await run({ _sheen: { isEnabled: true, texture: tex(10, UNSTAMPED) } }), "KHR_materials_sheen");
            expect(plain.sheenColorTexture.extensions).toBeUndefined();
        });

        it("transforms the packed roughness slot with the color texture's gate", async () => {
            const stamped = expectEmitted(await run({ _sheen: { isEnabled: true, texture: tex(10, STAMPED) } }), "KHR_materials_sheen");
            expect(transformOf(stamped.sheenRoughnessTexture)).toEqual(STAMPED_RESULT);
            const plain = expectEmitted(await run({ _sheen: { isEnabled: true, texture: tex(10, UNSTAMPED) } }), "KHR_materials_sheen");
            expect(plain.sheenRoughnessTexture.extensions).toBeUndefined();
        });

        it("always transforms a separate roughness texture", async () => {
            const r = await run({ _sheen: { isEnabled: true, texture: tex(10, UNSTAMPED), roughnessTexture: tex(20, UNSTAMPED) } });
            const sheen = expectEmitted(r, "KHR_materials_sheen");
            expect(sheen.sheenColorTexture.extensions).toBeUndefined();
            expect(transformOf(sheen.sheenRoughnessTexture)).toEqual({ offset: [0.25, 0], scale: [2, 1] });
        });
    });
});

describe("KHR_materials_iridescence", () => {
    it("is absent unless isEnabled", async () => {
        expectAbsent(await run({ _iridescence: { isEnabled: false } }), "KHR_materials_iridescence");
    });

    it("defaults to iridescenceFactor 1 and omits the default IOR and thickness range", async () => {
        const r = await run({ _iridescence: { isEnabled: true } });
        expect(expectEmitted(r, "KHR_materials_iridescence")).toEqual({ iridescenceFactor: 1 });
        const explicit = await run({ _iridescence: { isEnabled: true, indexOfRefraction: 1.3, minimumThickness: 100, maximumThickness: 400 } });
        expect(expectEmitted(explicit, "KHR_materials_iridescence")).toEqual({ iridescenceFactor: 1 });
    });

    it("writes non-default intensity, IOR and thickness range", async () => {
        const r = await run({ _iridescence: { isEnabled: true, intensity: 0.5, indexOfRefraction: 1.6, minimumThickness: 200, maximumThickness: 500 } });
        expect(expectEmitted(r, "KHR_materials_iridescence")).toEqual({
            iridescenceFactor: 0.5,
            iridescenceIor: 1.6,
            iridescenceThicknessMinimum: 200,
            iridescenceThicknessMaximum: 500,
        });
    });

    it("exports the intensity and thickness textures on texCoord 0", async () => {
        const r = await run({ _iridescence: { isEnabled: true, texture: tex(10), thicknessTexture: tex(20) } });
        const ir = expectEmitted(r, "KHR_materials_iridescence");
        expect(ir.iridescenceTexture).toEqual({ index: 0 });
        expect(ir.iridescenceThicknessTexture).toEqual({ index: 1 });
    });

    describe("a texture with _texCoord 1", () => {
        const make = (): Partial<PbrMaterialProps> => ({
            _iridescence: { isEnabled: true, texture: tex(10, { _texCoord: 1 }), thicknessTexture: tex(20, { _texCoord: 1 }) },
        });

        it("exports texCoord 1 in the uv1 state", async () => {
            const ir = expectEmitted(await run(make(), "uv1"), "KHR_materials_iridescence");
            expect(ir.iridescenceTexture.texCoord).toBe(1);
            expect(ir.iridescenceThicknessTexture.texCoord).toBe(1);
        });

        it("exports texCoord 0 in the uv0 state", async () => {
            const ir = expectEmitted(await run(make(), "uv0"), "KHR_materials_iridescence");
            expect(ir.iridescenceTexture).toEqual({ index: 0 });
            expect(ir.iridescenceThicknessTexture).toEqual({ index: 1 });
        });

        it("omits the textures and warns in the lost state", async () => {
            const r = await run(make(), "lost");
            const ir = expectEmitted(r, "KHR_materials_iridescence");
            expect(ir.iridescenceTexture).toBeUndefined();
            expect(ir.iridescenceThicknessTexture).toBeUndefined();
            expect(r.warnings.filter((w) => LOST_UV1.test(w))).toHaveLength(1);
        });
    });

    it("gates each texture's transform on its own _hasTx", async () => {
        const r = await run({ _iridescence: { isEnabled: true, texture: tex(10, STAMPED), thicknessTexture: tex(20, UNSTAMPED) } });
        const ir = expectEmitted(r, "KHR_materials_iridescence");
        expect(transformOf(ir.iridescenceTexture)).toEqual(STAMPED_RESULT);
        expect(ir.iridescenceThicknessTexture.extensions).toBeUndefined();
        const swapped = await run({ _iridescence: { isEnabled: true, texture: tex(10, UNSTAMPED), thicknessTexture: tex(20, STAMPED) } });
        const ir2 = expectEmitted(swapped, "KHR_materials_iridescence");
        expect(ir2.iridescenceTexture.extensions).toBeUndefined();
        expect(transformOf(ir2.iridescenceThicknessTexture)).toEqual(STAMPED_RESULT);
    });
});

describe("KHR_materials_anisotropy", () => {
    it("is absent unless isEnabled", async () => {
        expectAbsent(await run({ _anisotropy: { isEnabled: false } }), "KHR_materials_anisotropy");
    });

    it("defaults to strength 1 with no rotation", async () => {
        const r = await run({ _anisotropy: { isEnabled: true } });
        expect(expectEmitted(r, "KHR_materials_anisotropy")).toEqual({ anisotropyStrength: 1 });
    });

    it("omits a strength of 0", async () => {
        const r = await run({ _anisotropy: { isEnabled: true, intensity: 0 } });
        expect(expectEmitted(r, "KHR_materials_anisotropy")).toEqual({});
    });

    it("writes the rotation as atan2(direction.y, direction.x)", async () => {
        const cases: [[number, number], number][] = [
            [[0, 1], Math.PI / 2],
            [[1, 1], Math.PI / 4],
            [[-1, 0], Math.PI],
            [[0, -1], -Math.PI / 2],
        ];
        for (const [direction, rotation] of cases) {
            const r = await run({ _anisotropy: { isEnabled: true, intensity: 0.5, direction } });
            const an = expectEmitted(r, "KHR_materials_anisotropy");
            expect(an.anisotropyStrength).toBe(0.5);
            expect(an.anisotropyRotation).toBeCloseTo(rotation, 10);
        }
        const identity = await run({ _anisotropy: { isEnabled: true, direction: [1, 0] } });
        expect(expectEmitted(identity, "KHR_materials_anisotropy").anisotropyRotation).toBeUndefined();
    });

    it("always applies the texture's transform, with or without _hasTx", async () => {
        for (const wrapper of [STAMPED, UNSTAMPED]) {
            const r = await run({ _anisotropy: { isEnabled: true, texture: tex(10, wrapper) } });
            expect(transformOf(expectEmitted(r, "KHR_materials_anisotropy").anisotropyTexture)).toEqual(STAMPED_RESULT);
        }
    });
});

describe("KHR_materials_ior", () => {
    it("is emitted only when the IOR is not 1.5", async () => {
        const r = await run({ _subsurface: { refraction: { indexOfRefraction: 1.33 } } });
        expect(expectEmitted(r, "KHR_materials_ior")).toEqual({ ior: 1.33 });
        expectAbsent(await run({ _subsurface: { refraction: { indexOfRefraction: 1.5 } } }), "KHR_materials_ior");
        expectAbsent(await run({ _subsurface: { refraction: {} } }), "KHR_materials_ior");
        expectAbsent(await run({}), "KHR_materials_ior");
    });

    it("omits an IOR within 1e-9 of 1.5 and keeps one that is merely close", async () => {
        expectAbsent(await run({ _subsurface: { refraction: { indexOfRefraction: 1.5 + 1e-10 } } }), "KHR_materials_ior");
        const r = await run({ _subsurface: { refraction: { indexOfRefraction: 1.5005 } } });
        expect(expectEmitted(r, "KHR_materials_ior")).toEqual({ ior: 1.5005 });
    });

    describe("from reflectance when no refraction IOR is set", () => {
        const iorOf = (reflectance: number): number => {
            const r = Math.sqrt(reflectance);
            return (1 + r) / (1 - r);
        };

        it("exports ior = (1 + sqrt(r)) / (1 - sqrt(r))", async () => {
            const r = await run({ reflectance: 0.2 });
            expect(expectEmitted(r, "KHR_materials_ior").ior).toBeCloseTo(iorOf(0.2), 9);
        });

        it("omits the extension at the 0.04 default, which is IOR 1.5", async () => {
            expectAbsent(await run({ reflectance: 0.04 }), "KHR_materials_ior");
        });

        it("clamps reflectance to 0.99", async () => {
            const r = await run({ reflectance: 5 });
            expect(expectEmitted(r, "KHR_materials_ior").ior).toBeCloseTo(iorOf(0.99), 9);
        });

        it("clamps a negative reflectance to 0, giving IOR 1", async () => {
            const r = await run({ reflectance: -1 });
            expect(expectEmitted(r, "KHR_materials_ior").ior).toBe(1);
        });

        it("prefers the refraction IOR over reflectance", async () => {
            const r = await run({ reflectance: 0.2, _subsurface: { refraction: { indexOfRefraction: 1.33 } } });
            expect(expectEmitted(r, "KHR_materials_ior")).toEqual({ ior: 1.33 });
        });

        it("is not derived for a spec-gloss material", async () => {
            expectAbsent(await run({ reflectance: 0.2, specGlossTexture: tex(10) }), "KHR_materials_ior");
        });
    });
});

describe("KHR_materials_specular", () => {
    it("emits specularFactor from _specularWeight", async () => {
        const r = await run({ _specularWeight: 0.5 });
        expect(expectEmitted(r, "KHR_materials_specular")).toEqual({ specularFactor: 0.5 });
    });

    it("falls back to _metallicF0Factor and prefers _specularWeight", async () => {
        const f0 = await run({ _metallicF0Factor: 0.3 });
        expect(expectEmitted(f0, "KHR_materials_specular")).toEqual({ specularFactor: 0.3 });
        const both = await run({ _metallicF0Factor: 0.3, _specularWeight: 0.7 });
        expect(expectEmitted(both, "KHR_materials_specular")).toEqual({ specularFactor: 0.7 });
    });

    it("emits nothing for an IOR-only material with _specularWeight 1", async () => {
        const r = await run({ _specularWeight: 1, _subsurface: { refraction: { indexOfRefraction: 1.33 } } });
        expectAbsent(r, "KHR_materials_specular");
        expect(expectEmitted(r, "KHR_materials_ior")).toEqual({ ior: 1.33 });
    });

    it("emits nothing at all defaults", async () => {
        expectAbsent(await run({ _specularWeight: 1, _metallicReflectanceColor: [1, 1, 1] }), "KHR_materials_specular");
    });

    it("writes the specular color factor, omitting white", async () => {
        const r = await run({ _metallicReflectanceColor: [1, 0.5, 0.25] });
        expect(expectEmitted(r, "KHR_materials_specular")).toEqual({ specularColorFactor: [1, 0.5, 0.25] });
        const both = await run({ _specularWeight: 0.5, _metallicReflectanceColor: [1, 1, 1] });
        expect(expectEmitted(both, "KHR_materials_specular")).toEqual({ specularFactor: 0.5 });
    });

    it("exports the specular and specular color textures", async () => {
        const r = await run({ _metallicReflectanceTexture: tex(10), _reflectanceTexture: tex(20) });
        const sp = expectEmitted(r, "KHR_materials_specular");
        expect(sp.specularTexture).toEqual({ index: 0 });
        expect(sp.specularColorTexture).toEqual({ index: 1 });
        expect(sp.specularFactor).toBeUndefined();
        expect(sp.specularColorFactor).toBeUndefined();
    });

    it("transforms both textures when either is stamped", async () => {
        const a = expectEmitted(await run({ _metallicReflectanceTexture: tex(10, STAMPED), _reflectanceTexture: tex(20, UNSTAMPED) }), "KHR_materials_specular");
        expect(transformOf(a.specularTexture)).toEqual(STAMPED_RESULT);
        expect(transformOf(a.specularColorTexture)).toEqual({ offset: [0.25, 0], scale: [2, 1] });
        const b = expectEmitted(await run({ _metallicReflectanceTexture: tex(10, UNSTAMPED), _reflectanceTexture: tex(20, STAMPED) }), "KHR_materials_specular");
        expect(transformOf(b.specularTexture)).toBeDefined();
        expect(transformOf(b.specularColorTexture)).toBeDefined();
    });

    it("transforms neither texture when neither is stamped", async () => {
        const r = await run({ _metallicReflectanceTexture: tex(10, UNSTAMPED), _reflectanceTexture: tex(20, UNSTAMPED) });
        const sp = expectEmitted(r, "KHR_materials_specular");
        expect(sp.specularTexture.extensions).toBeUndefined();
        expect(sp.specularColorTexture.extensions).toBeUndefined();
    });
});

describe("KHR_materials_transmission", () => {
    it("is emitted for _transmissive materials with the refraction intensity", async () => {
        const r = await run({ _transmissive: true, _subsurface: { refraction: { intensity: 0.7 } } });
        expect(expectEmitted(r, "KHR_materials_transmission")).toEqual({ transmissionFactor: 0.7 });
    });

    it("omits a zero factor but still emits the extension", async () => {
        expect(expectEmitted(await run({ _transmissive: true }), "KHR_materials_transmission")).toEqual({});
        expect(expectEmitted(await run({ _transmissive: true, _subsurface: { refraction: { intensity: 0 } } }), "KHR_materials_transmission")).toEqual({});
    });

    it("is absent unless _transmissive is true", async () => {
        expectAbsent(await run({ _transmissive: false, _subsurface: { refraction: { intensity: 0.7 } } }), "KHR_materials_transmission");
        expectAbsent(await run({ _subsurface: { refraction: { intensity: 0.7 } } }), "KHR_materials_transmission");
    });

    it("exports the transmission texture and always applies its transform", async () => {
        for (const wrapper of [STAMPED, UNSTAMPED]) {
            const r = await run({ _transmissive: true, _subsurface: { refraction: { intensity: 1, texture: tex(10, wrapper) } } });
            const tr = expectEmitted(r, "KHR_materials_transmission");
            expect(tr.transmissionFactor).toBe(1);
            expect(transformOf(tr.transmissionTexture)).toEqual(STAMPED_RESULT);
        }
    });
});

describe("KHR_materials_volume", () => {
    it("is absent without a glTF-channel thickness or a thickness-less tint", async () => {
        expectAbsent(await run({ _subsurface: { thickness: { max: 2 } } }), "KHR_materials_volume");
        expectAbsent(await run({ _subsurface: { thickness: { max: 2 }, tint: { color: [0.5, 0.5, 0.5], atDistance: 2 } } }), "KHR_materials_volume");
        expectAbsent(await run({}), "KHR_materials_volume");
    });

    it("writes thicknessFactor from the thickness maximum", async () => {
        const r = await run({ _subsurface: { thickness: { useGlTFChannel: true, max: 2 } } });
        expect(expectEmitted(r, "KHR_materials_volume")).toEqual({ thicknessFactor: 2 });
    });

    it("defaults thicknessFactor to 1 and omits a zero maximum", async () => {
        const unset = await run({ _subsurface: { thickness: { useGlTFChannel: true } } });
        expect(expectEmitted(unset, "KHR_materials_volume")).toEqual({ thicknessFactor: 1 });
        const zero = await run({ _subsurface: { thickness: { useGlTFChannel: true, max: 0 } } });
        expect(expectEmitted(zero, "KHR_materials_volume")).toEqual({});
    });

    it("writes the attenuation color and distance of a real tint", async () => {
        const r = await run({ _subsurface: { thickness: { useGlTFChannel: true, max: 1 }, tint: { color: [0.5, 0.2, 0.1], atDistance: 3 } } });
        expect(expectEmitted(r, "KHR_materials_volume")).toEqual({ thicknessFactor: 1, attenuationColor: [0.5, 0.2, 0.1], attenuationDistance: 3 });
    });

    it("emits no attenuation for the synthesized no-absorption tint (white at distance 1)", async () => {
        for (const color of [[1, 1, 1] as [number, number, number], undefined]) {
            const r = await run({ _subsurface: { thickness: { useGlTFChannel: true, max: 2 }, tint: { color, atDistance: 1 } } });
            expect(expectEmitted(r, "KHR_materials_volume")).toEqual({ thicknessFactor: 2 });
        }
    });

    it("keeps attenuation for a colored tint at distance 1, and for white at another distance", async () => {
        const colored = await run({ _subsurface: { thickness: { useGlTFChannel: true, max: 2 }, tint: { color: [0.5, 1, 1], atDistance: 1 } } });
        expect(expectEmitted(colored, "KHR_materials_volume")).toEqual({ thicknessFactor: 2, attenuationColor: [0.5, 1, 1], attenuationDistance: 1 });
        const far = await run({ _subsurface: { thickness: { useGlTFChannel: true, max: 2 }, tint: { color: [1, 1, 1], atDistance: 5 } } });
        expect(expectEmitted(far, "KHR_materials_volume")).toEqual({ thicknessFactor: 2, attenuationDistance: 5 });
    });

    it("exports an attenuation-only volume for a tint without thickness", async () => {
        const r = await run({ _subsurface: { tint: { color: [0.5, 0.5, 0.25], atDistance: 2 } } });
        expect(expectEmitted(r, "KHR_materials_volume")).toEqual({ attenuationColor: [0.5, 0.5, 0.25], attenuationDistance: 2 });
    });

    it("exports the thickness texture, transformed only when the material is transmissive", async () => {
        const make = (transmissive: boolean): Partial<PbrMaterialProps> => ({
            _transmissive: transmissive,
            _subsurface: { thickness: { useGlTFChannel: true, max: 1, texture: tex(10, UNSTAMPED) } },
        });
        const on = expectEmitted(await run(make(true)), "KHR_materials_volume");
        expect(transformOf(on.thicknessTexture)).toEqual({ offset: [0.25, 0], scale: [2, 1] });
        const off = expectEmitted(await run(make(false)), "KHR_materials_volume");
        expect(off.thicknessTexture).toEqual({ index: 0 });
    });
});

describe("KHR_materials_dispersion", () => {
    const volume = { useGlTFChannel: true, max: 1 };

    it("writes dispersion = 20 / refraction.dispersion", async () => {
        const r = await run({ _subsurface: { thickness: volume, refraction: { dispersion: 4 } } });
        expect(expectEmitted(r, "KHR_materials_dispersion")).toEqual({ dispersion: 5 });
        const r2 = await run({ _subsurface: { thickness: volume, refraction: { dispersion: 40 } } });
        expect(expectEmitted(r2, "KHR_materials_dispersion")).toEqual({ dispersion: 0.5 });
    });

    it("is absent without volume thickness, with zero dispersion or without refraction", async () => {
        expectAbsent(await run({ _subsurface: { refraction: { dispersion: 4 } } }), "KHR_materials_dispersion");
        expectAbsent(await run({ _subsurface: { thickness: volume, refraction: { dispersion: 0 } } }), "KHR_materials_dispersion");
        expectAbsent(await run({ _subsurface: { thickness: volume, refraction: {} } }), "KHR_materials_dispersion");
        expectAbsent(await run({ _subsurface: { thickness: volume } }), "KHR_materials_dispersion");
    });
});

describe("KHR_materials_diffuse_transmission", () => {
    const marker = { min: 0, max: 0 };

    it("is emitted only with the zero-thickness marker", async () => {
        const r = await run({ _subsurface: { translucency: { intensity: 0.5 }, thickness: marker } });
        expect(expectEmitted(r, "KHR_materials_diffuse_transmission")).toEqual({ diffuseTransmissionFactor: 0.5 });
        expectAbsent(await run({ _subsurface: { translucency: { intensity: 0.5 } } }), "KHR_materials_diffuse_transmission");
        expectAbsent(await run({ _subsurface: { translucency: { intensity: 0.5 }, thickness: { min: 0, max: 1 } } }), "KHR_materials_diffuse_transmission");
        expectAbsent(await run({ _subsurface: { translucency: { intensity: 0.5 }, thickness: { max: 0 } } }), "KHR_materials_diffuse_transmission");
        expectAbsent(await run({ _subsurface: { thickness: marker } }), "KHR_materials_diffuse_transmission");
    });

    it("does not also emit volume for the marker thickness", async () => {
        const r = await run({ _subsurface: { translucency: {}, thickness: marker } });
        expectAbsent(r, "KHR_materials_volume");
    });

    it("defaults the factor to 1 and omits a zero factor", async () => {
        expect(expectEmitted(await run({ _subsurface: { translucency: {}, thickness: marker } }), "KHR_materials_diffuse_transmission")).toEqual({ diffuseTransmissionFactor: 1 });
        expect(expectEmitted(await run({ _subsurface: { translucency: { intensity: 0 }, thickness: marker } }), "KHR_materials_diffuse_transmission")).toEqual({});
    });

    it("writes the color factor, omitting white", async () => {
        const r = await run({ _subsurface: { translucency: { color: [0.5, 0.25, 1] }, thickness: marker } });
        expect(expectEmitted(r, "KHR_materials_diffuse_transmission")).toEqual({ diffuseTransmissionFactor: 1, diffuseTransmissionColorFactor: [0.5, 0.25, 1] });
        const white = await run({ _subsurface: { translucency: { color: [1, 1, 1] }, thickness: marker } });
        expect(expectEmitted(white, "KHR_materials_diffuse_transmission").diffuseTransmissionColorFactor).toBeUndefined();
    });

    it("exports the intensity and color textures", async () => {
        const r = await run({ _subsurface: { translucency: { intensityTexture: tex(10), colorTexture: tex(20) }, thickness: marker } });
        const dt = expectEmitted(r, "KHR_materials_diffuse_transmission");
        expect(dt.diffuseTransmissionTexture).toEqual({ index: 0 });
        expect(dt.diffuseTransmissionColorTexture).toEqual({ index: 1 });
    });

    it("transforms both textures when either is stamped, and neither otherwise", async () => {
        const a = expectEmitted(
            await run({ _subsurface: { translucency: { intensityTexture: tex(10, STAMPED), colorTexture: tex(20, UNSTAMPED) }, thickness: marker } }),
            "KHR_materials_diffuse_transmission"
        );
        expect(transformOf(a.diffuseTransmissionTexture)).toBeDefined();
        expect(transformOf(a.diffuseTransmissionColorTexture)).toBeDefined();
        const b = expectEmitted(
            await run({ _subsurface: { translucency: { intensityTexture: tex(10, UNSTAMPED), colorTexture: tex(20, STAMPED) }, thickness: marker } }),
            "KHR_materials_diffuse_transmission"
        );
        expect(transformOf(b.diffuseTransmissionTexture)).toBeDefined();
        expect(transformOf(b.diffuseTransmissionColorTexture)).toBeDefined();
        const none = expectEmitted(
            await run({ _subsurface: { translucency: { intensityTexture: tex(10, UNSTAMPED), colorTexture: tex(20, UNSTAMPED) }, thickness: marker } }),
            "KHR_materials_diffuse_transmission"
        );
        expect(none.diffuseTransmissionTexture.extensions).toBeUndefined();
        expect(none.diffuseTransmissionColorTexture.extensions).toBeUndefined();
    });
});

describe("KHR_materials_pbrSpecularGlossiness", () => {
    const NAME = "KHR_materials_pbrSpecularGlossiness";

    it("is absent without a specGlossTexture", async () => {
        expectAbsent(await run({ baseColorFactor: [0.5, 0.5, 0.5, 1] }), NAME);
    });

    it("writes the texture and takes diffuseFactor from the resolved core factor", async () => {
        const r = await run({ specGlossTexture: tex(10), baseColorFactor: [0.5, 0.25, 1, 0.8], baseColorTexture: tex(20) });
        const sg = expectEmitted(r, NAME);
        expect(sg.specularGlossinessTexture).toEqual({ index: 1 });
        expect(sg.diffuseTexture).toEqual({ index: 0 });
        expect(sg.diffuseFactor).toEqual([0.5, 0.25, 1, 0.8]);
        expect(sg.specularFactor).toBeUndefined();
        expect(sg.glossinessFactor).toBeUndefined();
        expect(r.mat.pbrMetallicRoughness.baseColorFactor).toEqual([0.5, 0.25, 1, 0.8]);
    });

    it("omits diffuseFactor when the core factor is omitted", async () => {
        const sg = expectEmitted(await run({ specGlossTexture: tex(10) }), NAME);
        expect(sg.diffuseFactor).toBeUndefined();
        expect(sg.specularGlossinessTexture).toEqual({ index: 0 });
    });

    it("takes diffuseFactor from a folded 1x1 base color and emits no diffuseTexture", async () => {
        const texel = createTexture(1, 1, [128, 64, 255, 255], { format: "rgba8unorm-srgb" });
        const r = await run({ specGlossTexture: tex(10), baseColorTexture: texel, baseColorFactor: [1, 0.5, 1, 1] });
        const sg = expectEmitted(r, NAME);
        expect(sg.diffuseTexture).toBeUndefined();
        const expected = [srgbByteToLinear(128), srgbByteToLinear(64) * 0.5, srgbByteToLinear(255), 1];
        sg.diffuseFactor.forEach((v: number, i: number) => expect(v).toBeCloseTo(expected[i]!, 6));
        expect(r.mat.pbrMetallicRoughness.baseColorTexture).toBeUndefined();
        expect(r.json.images).toHaveLength(1);
        expect(sg.diffuseFactor).toEqual(r.mat.pbrMetallicRoughness.baseColorFactor);
    });

    it("writes no metallicRoughnessTexture but exports occlusion from the ORM texture on the core", async () => {
        const r = await run({ specGlossTexture: tex(10), ormTexture: tex(30), metallicFactor: 0.5 });
        expectEmitted(r, NAME);
        expect(r.mat.pbrMetallicRoughness.metallicRoughnessTexture).toBeUndefined();
        expect(r.mat.pbrMetallicRoughness.metallicFactor).toBe(0.5);
        expect(r.mat.occlusionTexture).toBeDefined();
        expect(r.mat.occlusionTexture.index).not.toBe(expectEmitted(r, NAME).specularGlossinessTexture.index);
        expect(r.json.images).toHaveLength(2);
    });

    it("exports the specular-glossiness texture on texCoord 1 for a UV1 slot", async () => {
        const make = (): Partial<PbrMaterialProps> => ({ specGlossTexture: tex(10), baseColorTexture: tex(20), _uv2Mask: 16 | 1 });
        const sg = expectEmitted(await run(make(), "uv1"), NAME);
        expect(sg.specularGlossinessTexture.texCoord).toBe(1);
        expect(sg.diffuseTexture.texCoord).toBe(1);
        const lost = await run(make(), "lost");
        const sgLost = expectEmitted(lost, NAME);
        expect(sgLost.specularGlossinessTexture).toBeUndefined();
        expect(sgLost.diffuseTexture).toBeUndefined();
        expect(lost.warnings.filter((w) => LOST_UV1.test(w))).toHaveLength(1);
    });

    it("exports the specular-glossiness texture bytes verbatim", async () => {
        const r = await run({ specGlossTexture: createTexture(2, 1, [1, 2, 3, 4, 5, 6, 7, 8]) });
        const png = await decodePng(readBufferView(r, r.json.images[0].bufferView));
        expect(Array.from(png.rgba)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });
});

describe("extension bookkeeping", () => {
    it("lists every emitted material extension in extensionsUsed and none in extensionsRequired", async () => {
        const r = await run({
            _unlit: true,
            _emissiveColor: [2, 1, 1],
            _clearCoat: { isEnabled: true, useF0Remap: false },
            _sheen: { isEnabled: true },
            _iridescence: { isEnabled: true },
            _anisotropy: { isEnabled: true },
            _specularWeight: 0.5,
            _transmissive: true,
            _subsurface: { thickness: { useGlTFChannel: true, max: 1 }, refraction: { indexOfRefraction: 1.4, dispersion: 10 } },
        });
        expect(r.json.extensionsUsed).toEqual([
            "KHR_materials_unlit",
            "KHR_materials_emissive_strength",
            "KHR_materials_clearcoat",
            "KHR_materials_sheen",
            "KHR_materials_iridescence",
            "KHR_materials_anisotropy",
            "KHR_materials_ior",
            "KHR_materials_specular",
            "KHR_materials_transmission",
            "KHR_materials_volume",
            "KHR_materials_dispersion",
        ]);
        expect(r.json.extensionsRequired).toBeUndefined();
        expect(Object.keys(r.mat.extensions)).toEqual(r.json.extensionsUsed);
    });
});
