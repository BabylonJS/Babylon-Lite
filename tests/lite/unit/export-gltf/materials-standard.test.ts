import { describe, expect, it } from "vitest";
import { createFakeDevice, createMesh, createScene, createTexture, decodePng, exportAndParse, readBufferView } from "./export-test-utils";
import type { FakeTextureOptions, ParsedGlb } from "./export-test-utils";
import { createStandardMaterial } from "../../../../packages/babylon-lite/src/material/standard/create-standard-material";
import type { StandardMaterialProps } from "../../../../packages/babylon-lite/src/material/standard/standard-material";
import { specularPowerToRoughness } from "../../../../packages/babylon-lite/src/export-gltf/export-materials";
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

function std(props: Partial<StandardMaterialProps> = {}): StandardMaterialProps {
    return Object.assign(createStandardMaterial(), props);
}

async function run(material: StandardMaterialProps, state: State = "uv0"): Promise<Result> {
    const glb = await exportAndParse(createScene({ meshes: [meshFor("m", material, state)], device: createFakeDevice().device }));
    return { ...glb, mat: glb.json.materials?.[0] };
}

/** A 1x2 texture (width 1, height 2): row 0 is `top`, row 1 is `bottom`. */
function column(top: number[], bottom: number[], options: FakeTextureOptions = {}) {
    return createTexture(1, 2, [...top, ...bottom], options);
}

const TOP = [100, 150, 200, 255];
const BOTTOM = [10, 20, 30, 255];

async function imageRows(glb: ParsedGlb, imageIndex: number): Promise<number[][]> {
    const png = await decodePng(readBufferView(glb, glb.json.images[imageIndex].bufferView));
    return [Array.from(png.rgba.subarray(0, 4)), Array.from(png.rgba.subarray(4, 8))];
}

const STORAGE = [TOP, BOTTOM];
const REVERSED = [BOTTOM, TOP];

function close(actual: number[], expected: number[], digits = 6): void {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((e, i) => expect(actual[i]).toBeCloseTo(e, digits));
}

describe("Standard to metallic-roughness: factors", () => {
    it("writes baseColorFactor = [diffuse^2.2 * 0.5, alpha] and metallicFactor 0", async () => {
        const r = await run(std({ diffuseColor: [0.5, 0.25, 1], alpha: 0.8 }));
        const pmr = r.mat.pbrMetallicRoughness;
        close(pmr.baseColorFactor, [Math.pow(0.5, 2.2) * 0.5, Math.pow(0.25, 2.2) * 0.5, 0.5, 0.8]);
        expect(pmr.metallicFactor).toBe(0);
    });

    it("writes a default material's white diffuse as 0.5", async () => {
        const r = await run(std());
        expect(r.mat.pbrMetallicRoughness.baseColorFactor).toEqual([0.5, 0.5, 0.5, 1]);
    });

    it("maps specularPower 64 to roughness 0.328809", async () => {
        const r = await run(std({ specularPower: 64 }));
        expect(Math.abs(r.mat.pbrMetallicRoughness.roughnessFactor - 0.328809)).toBeLessThan(1e-6);
    });

    for (const power of [0, 256, 1024]) {
        it(`matches specularPowerToRoughness at specularPower ${power}`, async () => {
            const r = await run(std({ specularPower: power }));
            expect(r.mat.pbrMetallicRoughness.roughnessFactor ?? 1).toBeCloseTo(specularPowerToRoughness(power), 10);
        });
    }

    it("omits roughness at specularPower 0 (roughness 1)", async () => {
        const r = await run(std({ specularPower: 0 }));
        expect(specularPowerToRoughness(0)).toBe(1);
        expect(r.mat.pbrMetallicRoughness.roughnessFactor).toBeUndefined();
    });

    it("clamps specularPower above 1024 to 1024", async () => {
        const r = await run(std({ specularPower: 2000 }));
        const r1024 = await run(std({ specularPower: 1024 }));
        expect(r.mat.pbrMetallicRoughness.roughnessFactor).toBe(r1024.mat.pbrMetallicRoughness.roughnessFactor);
        expect(r.mat.pbrMetallicRoughness.roughnessFactor).toBeCloseTo(specularPowerToRoughness(1024), 10);
    });

    it("clamps a negative specularPower to 0", async () => {
        const r = await run(std({ specularPower: -5 }));
        expect(r.mat.pbrMetallicRoughness.roughnessFactor).toBeUndefined();
    });
});

describe("Standard: texture slots and UV sets", () => {
    it("exports the diffuse texture as baseColorTexture on texCoord 0", async () => {
        const r = await run(std({ diffuseTexture: column(TOP, BOTTOM) }));
        expect(r.mat.pbrMetallicRoughness.baseColorTexture).toEqual({ index: 0 });
        expect(r.json.images[0].name).toBe("baseColorTexture");
    });

    it("exports diffuseCoordIndex 1 as texCoord 1 only in the uv1 state", async () => {
        const material = std({ diffuseTexture: column(TOP, BOTTOM), diffuseCoordIndex: 1 });
        const uv1 = await run(material, "uv1");
        expect(uv1.mat.pbrMetallicRoughness.baseColorTexture).toEqual({ index: 0, texCoord: 1 });
        const uv0 = await run(material, "uv0");
        expect(uv0.mat.pbrMetallicRoughness.baseColorTexture).toBeUndefined();
        expect(uv0.warnings.filter((w) => LOST_UV1.test(w))).toHaveLength(0);
        const lost = await run(material, "lost");
        expect(lost.mat.pbrMetallicRoughness.baseColorTexture).toBeUndefined();
        expect(lost.warnings.filter((w) => LOST_UV1.test(w))).toHaveLength(1);
    });

    it("exports the ambient texture as occlusionTexture, honoring ambientCoordIndex", async () => {
        const material = std({ _ambientTexture: column(TOP, BOTTOM), ambientCoordIndex: 1 });
        const uv1 = await run(material, "uv1");
        expect(uv1.mat.occlusionTexture).toEqual({ index: 0, texCoord: 1 });
        const uv0 = await run(material, "uv0");
        expect(uv0.mat.occlusionTexture).toBeUndefined();
    });

    it("exports an emissive texture on texCoord 0", async () => {
        const r = await run(std({ _emissiveTexture: column(TOP, BOTTOM) }));
        expect(r.mat.emissiveTexture).toEqual({ index: 0 });
    });

    it("emits one glTF material per UV state only when a slot selects UV1", async () => {
        const count = async (material: StandardMaterialProps): Promise<number> => {
            const glb = await exportAndParse(
                createScene({ meshes: [meshFor("a", material, "uv1"), meshFor("b", material, "uv0"), meshFor("c", material, "lost")], device: createFakeDevice().device })
            );
            return glb.json.materials.length;
        };
        expect(await count(std({ diffuseTexture: column(TOP, BOTTOM), diffuseCoordIndex: 1 }))).toBe(3);
        expect(await count(std({ _ambientTexture: column(TOP, BOTTOM), ambientCoordIndex: 1 }))).toBe(3);
        expect(await count(std({ diffuseTexture: column(TOP, BOTTOM) }))).toBe(1);
    });

    it("exports a bump texture as normalTexture with scale = bumpLevel when it is not 1", async () => {
        const r = await run(std({ _bumpTexture: column(TOP, BOTTOM), bumpLevel: 2 }));
        expect(r.mat.normalTexture).toEqual({ index: 0, scale: 2 });
        const r1 = await run(std({ _bumpTexture: column(TOP, BOTTOM), bumpLevel: 1 }));
        expect(r1.mat.normalTexture).toEqual({ index: 0 });
    });

    it("inverts the bump image's red channel", async () => {
        const r = await run(std({ _bumpTexture: column(TOP, BOTTOM) }));
        expect(await imageRows(r, 0)).toEqual([
            [255 - 100, 150, 200, 255],
            [255 - 10, 20, 30, 255],
        ]);
    });

    it("inverts red and green and reverses the rows for a flipped bump slot", async () => {
        const r = await run(std({ _bumpTexture: column(TOP, BOTTOM, { invertY: true }) }));
        expect(await imageRows(r, 0)).toEqual([
            [255 - 10, 255 - 20, 30, 255],
            [255 - 100, 255 - 150, 200, 255],
        ]);
    });

    it("does not invert channels of non-bump slots", async () => {
        const r = await run(std({ diffuseTexture: column(TOP, BOTTOM) }));
        expect(await imageRows(r, 0)).toEqual(STORAGE);
    });
});

describe("Standard UV mapping: shared path (_hasUvTx unset)", () => {
    it("flips all UV0 slots when the diffuse texture has invertY", async () => {
        const r = await run(
            std({
                diffuseTexture: column(TOP, BOTTOM, { invertY: true }),
                _emissiveTexture: column(BOTTOM, TOP),
                uvScale: [2, 3],
                uvOffset: [0.1, 0.2],
            })
        );
        const base = r.mat.pbrMetallicRoughness.baseColorTexture;
        const emissive = r.mat.emissiveTexture;
        expect(await imageRows(r, r.json.textures[base.index].source)).toEqual(REVERSED);
        expect(await imageRows(r, r.json.textures[emissive.index].source)).toEqual([TOP, BOTTOM]);
        for (const info of [base, emissive]) {
            const t = info.extensions.KHR_texture_transform;
            expect(t.scale).toEqual([2, 3]);
            close(t.offset, [0.1, 1 - 3 - 0.2]);
            expect(t.rotation).toBeUndefined();
        }
        expect(r.json.extensionsUsed).toContain("KHR_texture_transform");
        expect(r.json.extensionsRequired).toBeUndefined();
    });

    it("does not flip, and keeps the offset as is, when the diffuse texture is not inverted", async () => {
        const r = await run(std({ diffuseTexture: column(TOP, BOTTOM, { invertY: false }), uvScale: [2, 3], uvOffset: [0.1, 0.2] }));
        const info = r.mat.pbrMetallicRoughness.baseColorTexture;
        expect(await imageRows(r, 0)).toEqual(STORAGE);
        expect(info.extensions.KHR_texture_transform).toEqual({ offset: [0.1, 0.2], scale: [2, 3] });
    });

    it("always applies uvOffset, even with the default scale", async () => {
        const r = await run(std({ diffuseTexture: column(TOP, BOTTOM), uvOffset: [0.3, 0.4] }));
        expect(r.mat.pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform).toEqual({ offset: [0.3, 0.4] });
    });

    it("writes no transform for the identity scale and offset", async () => {
        const r = await run(std({ diffuseTexture: column(TOP, BOTTOM) }));
        expect(r.mat.pbrMetallicRoughness.baseColorTexture.extensions).toBeUndefined();
        expect(r.json.extensionsUsed).toBeUndefined();
    });

    it("falls back to the opacity texture's invertY when there is no diffuse texture", async () => {
        const r = await run(std({ _opacityTexture: column(BOTTOM, TOP, { invertY: true }), _emissiveTexture: column(TOP, BOTTOM) }));
        expect(await imageRows(r, 0)).toEqual(REVERSED);
        expect(r.mat.alphaMode).toBe("BLEND");
    });

    it("falls back to the bump texture's invertY when there is neither diffuse nor opacity texture", async () => {
        const r = await run(std({ _bumpTexture: column(BOTTOM, TOP, { invertY: true }), _emissiveTexture: column(TOP, BOTTOM) }));
        const emissive = r.mat.emissiveTexture;
        expect(await imageRows(r, r.json.textures[emissive.index].source)).toEqual(REVERSED);
    });

    it("lets the diffuse texture's orientation win over the opacity and bump textures", async () => {
        const r = await run(
            std({
                diffuseTexture: column(TOP, BOTTOM, { invertY: false }),
                _opacityTexture: column(TOP, BOTTOM, { invertY: true }),
                _bumpTexture: column(TOP, BOTTOM, { invertY: true }),
                _emissiveTexture: column(TOP, BOTTOM),
            })
        );
        const emissive = r.mat.emissiveTexture;
        expect(await imageRows(r, r.json.textures[emissive.index].source)).toEqual(STORAGE);
    });

    it("does not flip or transform a UV1 slot", async () => {
        const r = await run(std({ diffuseTexture: column(TOP, BOTTOM, { invertY: true }), diffuseCoordIndex: 1, uvScale: [2, 2], uvOffset: [0.5, 0.5] }), "uv1");
        const info = r.mat.pbrMetallicRoughness.baseColorTexture;
        expect(info).toEqual({ index: 0, texCoord: 1 });
        expect(await imageRows(r, 0)).toEqual(STORAGE);
    });
});

describe("Standard UV mapping: per-texture path (_hasUvTx)", () => {
    const wrapper = { uScale: 2, vScale: 3, uOffset: 0.1, vOffset: 0.2, uAng: 0.5 };

    it("composes rotation, scale and offset per texture and flips by each texture's own invertY", async () => {
        const S = [1.5, 2];
        const O = [0.3, 0.4];
        const r = await run(
            std({
                _hasUvTx: true,
                uvScale: [S[0]!, S[1]!],
                uvOffset: [O[0]!, O[1]!],
                diffuseTexture: column(TOP, BOTTOM, { invertY: true, wrapper }),
                _emissiveTexture: column(TOP, BOTTOM, { invertY: false, wrapper: { uScale: 1, vScale: 1, uOffset: 0, vOffset: 0, uAng: 0 } }),
            })
        );
        const c = Math.cos(0.5);
        const s = Math.sin(0.5);
        const expectedOffset = [c * 2 * O[0]! + s * 3 * O[1]! + 0.1, -s * 2 * O[0]! + c * 3 * O[1]! + 0.2];
        const base = r.mat.pbrMetallicRoughness.baseColorTexture;
        const t = base.extensions.KHR_texture_transform;
        expect(t.rotation).toBe(0.5);
        close(t.scale, [2 * 1.5, 3 * 2]);
        close(t.offset, expectedOffset);
        expect(await imageRows(r, r.json.textures[base.index].source)).toEqual(REVERSED);

        // Identity wrapper: only the material's uvScale / uvOffset apply, and no flip.
        const emissive = r.mat.emissiveTexture;
        expect(emissive.extensions.KHR_texture_transform).toEqual({ offset: O, scale: S });
        expect(await imageRows(r, r.json.textures[emissive.index].source)).toEqual(STORAGE);
    });

    it("does not let the diffuse texture's invertY flip the other slots", async () => {
        const r = await run(std({ _hasUvTx: true, diffuseTexture: column(TOP, BOTTOM, { invertY: true }), _emissiveTexture: column(TOP, BOTTOM) }));
        const emissive = r.mat.emissiveTexture;
        expect(await imageRows(r, r.json.textures[emissive.index].source)).toEqual(STORAGE);
    });

    it("omits the transform for an identity texture with the default material scale and offset", async () => {
        const r = await run(std({ _hasUvTx: true, diffuseTexture: column(TOP, BOTTOM) }));
        expect(r.mat.pbrMetallicRoughness.baseColorTexture.extensions).toBeUndefined();
    });

    it("applies the texture transform without uvScale / uvOffset on a UV1 slot", async () => {
        const r = await run(
            std({
                _hasUvTx: true,
                diffuseCoordIndex: 1,
                uvScale: [5, 5],
                uvOffset: [0.7, 0.7],
                diffuseTexture: column(TOP, BOTTOM, { invertY: true, wrapper }),
            }),
            "uv1"
        );
        const info = r.mat.pbrMetallicRoughness.baseColorTexture;
        expect(info.texCoord).toBe(1);
        expect(info.extensions.KHR_texture_transform).toEqual({ offset: [0.1, 0.2], scale: [2, 3], rotation: 0.5, texCoord: 1 });
        expect(await imageRows(r, 0)).toEqual(REVERSED);
    });
});

describe("Standard: emissive, alpha, culling, lighting", () => {
    it("writes an emissive texture alone with emissiveFactor [1, 1, 1]", async () => {
        const r = await run(std({ _emissiveTexture: column(TOP, BOTTOM) }));
        expect(r.mat.emissiveFactor).toEqual([1, 1, 1]);
    });

    it("writes a non-black emissiveColor as color^2.2, over an emissive texture too", async () => {
        const r = await run(std({ emissiveColor: [0.5, 0, 1], _emissiveTexture: column(TOP, BOTTOM) }));
        close(r.mat.emissiveFactor, [Math.pow(0.5, 2.2), 0, 1]);
        const none = await run(std());
        expect(none.mat.emissiveFactor).toBeUndefined();
    });

    it("maps alphaCutOff to MASK and writes alphaCutoff only when it is not 0.5", async () => {
        const r = await run(std({ alphaCutOff: 0.5 }));
        expect(r.mat.alphaMode).toBe("MASK");
        expect(r.mat.alphaCutoff).toBeUndefined();
        const r2 = await run(std({ alphaCutOff: 0.25, alpha: 0.5 }));
        expect(r2.mat.alphaMode).toBe("MASK");
        expect(r2.mat.alphaCutoff).toBe(0.25);
    });

    it("maps alpha < 1 or an opacity texture to BLEND", async () => {
        expect((await run(std({ alpha: 0.5 }))).mat.alphaMode).toBe("BLEND");
        expect((await run(std({ _opacityTexture: column(TOP, BOTTOM) }))).mat.alphaMode).toBe("BLEND");
        expect((await run(std())).mat.alphaMode).toBeUndefined();
    });

    it("maps backFaceCulling false to doubleSided", async () => {
        expect((await run(std({ backFaceCulling: false }))).mat.doubleSided).toBe(true);
        expect((await run(std({ backFaceCulling: true }))).mat.doubleSided).toBeUndefined();
    });

    it("maps disableLighting to KHR_materials_unlit", async () => {
        const r = await run(std({ disableLighting: true }));
        expect(r.mat.extensions).toEqual({ KHR_materials_unlit: {} });
        expect(r.json.extensionsUsed).toEqual(["KHR_materials_unlit"]);
        expect(r.json.extensionsRequired).toBeUndefined();
        const lit = await run(std());
        expect(lit.json.extensionsUsed).toBeUndefined();
    });

    it("writes the material name", async () => {
        expect((await run(std({ name: "wood" }))).mat.name).toBe("wood");
    });
});
