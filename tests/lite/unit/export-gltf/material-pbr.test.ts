import { describe, expect, it } from "vitest";
import { createFakeDevice, createMesh, createScene, createTexture, decodePng, expectClose, exportAndParse, readAccessor, readBufferView } from "./export-test-utils";
import type { ParsedGlb } from "./export-test-utils";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { createMaterialView } from "../../../../packages/babylon-lite/src/material/material-view";
import type { Material } from "../../../../packages/babylon-lite/src/material/material";
import { linearToSrgbByte, srgbByteToLinear } from "../../../../packages/babylon-lite/src/math/color";

const PIXELS = [128, 64, 32, 79, 16, 8, 4, 143];
const UVS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const TRANSFORM = { offset: [0.1, 0.2], scale: [2, 3], rotation: 0.5 };
const srgbGrid = (v: number): number => srgbByteToLinear(linearToSrgbByte(v));
const byteGrid = (v: number): number => Math.round(v * 255) / 255;
const tex = () => createTexture(2, 1, PIXELS, { wrapper: { uOffset: 0.1, vOffset: 0.2, uScale: 2, vScale: 3, uAng: 0.5 } });

async function run(props: Partial<PbrMaterialProps>, device = true) {
    const r = await exportAndParse(createScene({ meshes: [createMesh("m", { material: createPbrMaterial(props) })], ...(device ? { device: createFakeDevice().device } : {}) }));
    return { ...r, mat: r.json.materials[0] };
}

async function pixels(r: ParsedGlb, index: number): Promise<number[]> {
    return Array.from((await decodePng(readBufferView(r, r.json.images[r.json.textures[index].source].bufferView))).rgba);
}

describe("PBR material export", () => {
    it.each<[string, Partial<PbrMaterialProps>, object, number]>([
        ["defaults", {}, {}, 0],
        ["small base factor", { baseColorFactor: [1, 1, 0.9995, 1] }, { pbrMetallicRoughness: { baseColorFactor: [1, 1, 0.9995, 1] } }, 0],
        ["base float noise", { baseColorFactor: [1, 1, 1 - 1e-12, 1] }, {}, 0],
        ["clamped base", { baseColorFactor: [2, -1, 0.5, 1] }, { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0.5, 1] } }, 1],
        ["clamped MR", { metallicFactor: 1.5, roughnessFactor: -0.5 }, { pbrMetallicRoughness: { roughnessFactor: 0 } }, 1],
        ["small emissive", { _emissiveColor: [0.0005, 0, 0] }, { emissiveFactor: [0.0005, 0, 0] }, 0],
        ["emissive float noise", { _emissiveColor: [1e-12, 0, 0] }, {}, 0],
    ])("preserves factors, omission tolerance and clamping: %s", async (_label, props, expected, warnings) => {
        const r = await run(props);
        expect(r.mat).toEqual(expected);
        expect(r.warnings).toHaveLength(warnings);
        if (warnings) {
            expect(r.warnings[0]).toContain("has factors outside [0, 1], which glTF cannot represent; exporting them clamped.");
        }
    });

    it.each<[Partial<PbrMaterialProps>, string | undefined, number | undefined]>([
        [{ alphaBlend: true }, "BLEND", undefined],
        [{ alpha: 0.5 }, "BLEND", undefined],
        [{ alphaBlend: true, _alphaCutOff: 0.3 }, "MASK", 0.3],
        [{ _alphaCutOff: 0.5 }, "MASK", undefined],
        [{}, undefined, undefined],
    ])("preserves alpha precedence and culling for %j", async (props, mode, cutoff) => {
        const r = await run({ baseColorFactor: [0.5, 0.25, 1, 0.8], metallicFactor: 0.25, roughnessFactor: 0.75, doubleSided: true, ...props });
        expect(r.mat.pbrMetallicRoughness).toEqual({ baseColorFactor: [0.5, 0.25, 1, 0.8 * (props.alpha ?? 1)], metallicFactor: 0.25, roughnessFactor: 0.75 });
        expect([r.mat.alphaMode, r.mat.alphaCutoff, r.mat.doubleSided]).toEqual([mode, cutoff, true]);
    });

    it.each<[GPUTextureFormat, boolean]>([
        ["rgba8unorm", false],
        ["rgba8unorm", true],
        ["rgba8unorm-srgb", true],
    ])("preserves sampled base/emissive colors and separates ORM bytes (%s, gamma %s)", async (format, gamma) => {
        const texture = createTexture(2, 1, PIXELS, { format });
        const r = await run({ baseColorTexture: texture, ormTexture: texture, emissiveTexture: texture, _gammaAlbedo: gamma });
        const mr = r.mat.pbrMetallicRoughness;
        const srgb = format.endsWith("-srgb");
        expect(await pixels(r, mr.baseColorTexture.index)).toEqual(PIXELS.map((v, i) => (i % 4 === 3 || srgb ? v : linearToSrgbByte(gamma ? (v / 255) ** 2.2 : v / 255))));
        expect(await pixels(r, r.mat.emissiveTexture.index)).toEqual(PIXELS.map((v, i) => (i % 4 === 3 || srgb ? v : linearToSrgbByte(v / 255))));
        expect(await pixels(r, mr.metallicRoughnessTexture.index)).toEqual(PIXELS.map((v, i) => (i % 4 === 3 || !srgb ? v : Math.round(srgbByteToLinear(v) * 255))));
        expect(mr.baseColorTexture.index).not.toBe(mr.metallicRoughnessTexture.index);
        expect(r.mat.occlusionTexture).toEqual(mr.metallicRoughnessTexture);
        expect(r.mat.emissiveFactor).toEqual([1, 1, 1]);
    });

    it.each<[GPUTextureFormat, boolean, "OPAQUE" | "MASK" | "BLEND"]>([
        ["rgba8unorm", false, "OPAQUE"],
        ["rgba8unorm", true, "MASK"],
        ["rgba8unorm", false, "MASK"],
        ["rgba8unorm-srgb", false, "BLEND"],
        ["rgba8unorm-srgb", true, "OPAQUE"],
    ])("folds base color onto a stable bake grid, preserving %s/gamma=%s/%s semantics", async (format, gamma, mode) => {
        const alphaProps = mode === "MASK" ? { _alphaCutOff: 0.5 } : mode === "BLEND" ? { alpha: 0.5 } : {};
        const factorAlpha = mode === "OPAQUE" ? 1 : 0.5;
        const r = await run({
            baseColorTexture: createTexture(1, 1, [128, 64, 255, 128], { format }),
            baseColorFactor: [0.5, 1, 0.25, factorAlpha],
            _gammaAlbedo: gamma,
            ...alphaProps,
        });
        const decode = (b: number) => (format.endsWith("-srgb") ? srgbByteToLinear(b) : gamma ? (b / 255) ** 2.2 : b / 255);
        const first = r.mat.pbrMetallicRoughness.baseColorFactor;
        expectClose(first, [srgbGrid(decode(128) * 0.5), srgbGrid(decode(64)), srgbGrid(0.25), factorAlpha * (alphaProps.alpha ?? 1) * (mode === "OPAQUE" ? 1 : 128 / 255)], 6);
        expect(r.mat.alphaMode).toBe(mode === "OPAQUE" ? undefined : mode);
        expect(r.json.images).toBeUndefined();
        // Reload bakes RGB into sRGB bytes and keeps the resolved alpha in the material.
        const bake = createTexture(1, 1, [...first.slice(0, 3).map(linearToSrgbByte), 255], { format: "rgba8unorm-srgb" });
        const reloaded = await run({ baseColorTexture: bake, ...alphaProps, alpha: first[3], alphaBlend: mode === "BLEND" });
        expect(reloaded.mat.pbrMetallicRoughness.baseColorFactor).toEqual(first);
    });

    it.each<[GPUTextureFormat, number, number, boolean]>([
        ["rgba8unorm", 255, 1, false],
        ["rgba8unorm-srgb", 255, 1, false],
        ["rgba8unorm", 200, 0.5, false],
        ["rgba8unorm", 200, 0, false],
        ["rgba8unorm", 200, 1, true],
    ])("folds ORM only when occlusion permits, with stable reload factors (%s R=%s strength=%s separate=%s)", async (format, red, strength, separate) => {
        const r = await run({
            ormTexture: createTexture(1, 1, [red, 128, 64, 255], { format }),
            metallicFactor: 0.5,
            roughnessFactor: 0.8,
            occlusionStrength: strength,
            occlusionTexture: separate ? tex() : undefined,
        });
        const mr = r.mat.pbrMetallicRoughness;
        if (red !== 255 && strength !== 0 && !separate) {
            expect(mr).toEqual({ metallicFactor: 0.5, roughnessFactor: 0.8, metallicRoughnessTexture: { index: 0 } });
            expect(r.mat.occlusionTexture).toEqual({ index: 0, strength });
            expect(await pixels(r, 0)).toEqual([red, 128, 64, 255]);
        } else {
            const decode = (b: number) => (format.endsWith("-srgb") ? srgbByteToLinear(b) : b / 255);
            expect(mr).toEqual({ metallicFactor: byteGrid(0.5 * decode(64)), roughnessFactor: byteGrid(0.8 * decode(128)) });
            expect(r.mat.occlusionTexture).toEqual(separate ? { index: 0 } : undefined);
            expect(r.json.images?.length ?? 0).toBe(separate ? 1 : 0);
            const bake = createTexture(1, 1, [255, Math.round(mr.roughnessFactor * 255), Math.round(mr.metallicFactor * 255), 255]);
            expect((await run({ ormTexture: bake })).mat.pbrMetallicRoughness).toEqual(mr);
        }
    });

    it.each<[keyof PbrMaterialProps, number, string]>([
        ["baseColorTexture", 1, "baseColorTexture"],
        ["ormTexture", 2, "metallicRoughnessTexture"],
        ["ormTexture", 2, "occlusionTexture"],
        ["normalTexture", 4, "normalTexture"],
        ["emissiveTexture", 8, "emissiveTexture"],
        ["occlusionTexture", 32, "occlusionTexture"],
    ])("preserves UV1 available/missing/lost variants and shared images for %s (%s, %s)", async (property, bit, output) => {
        const material = createPbrMaterial({ [property]: tex(), _uv2Mask: bit, _hasUvTx: true, normalTextureScale: 2, occlusionStrength: 0.6 });
        const meshes = [
            createMesh("uv1", { material, uv2s: UVS }),
            createMesh("uv0", { material }),
            createMesh("lost", { material, gpuOnly: ["uv2"] }),
            createMesh("again", { material, uv2s: UVS }),
        ];
        const r = await exportAndParse(createScene({ meshes, device: createFakeDevice().device }));
        const indices = r.json.meshes.map((m: any) => m.primitives[0].material);
        expect(r.json.materials).toHaveLength(3);
        expect(indices[3]).toBe(indices[0]);
        expect(r.json.images).toHaveLength(1);
        for (const [state, index] of indices.slice(0, 3).entries()) {
            const mat = r.json.materials[index];
            const info = mat.pbrMetallicRoughness?.[output] ?? mat[output];
            if (state === 2 || (bit === 32 && state === 1)) {
                expect(info).toBeUndefined();
            } else {
                expect(info.texCoord).toBe(state === 0 ? 1 : undefined);
                expect(info.extensions?.KHR_texture_transform).toEqual(bit === 32 ? undefined : { ...TRANSFORM, ...(state === 0 ? { texCoord: 1 } : {}) });
                if (output === "normalTexture") {
                    expect(info.scale).toBe(2);
                }
            }
        }
        expect(r.warnings.filter((w) => w.includes("samples TEXCOORD_1"))).toHaveLength(1);
    });

    it("preserves the ambient texture's UV0 transform", async () => {
        const r = await run({ occlusionTexture: tex(), _hasUvTx: true, occlusionStrength: 0.75 });
        expect(r.mat.occlusionTexture).toEqual({ index: 0, strength: 0.75, extensions: { KHR_texture_transform: TRANSFORM } });
    });

    it.each([0, 64])("shares materials across UV states without exported UV1 bits (%s)", async (mask) => {
        const material = createPbrMaterial({ baseColorTexture: tex(), _uv2Mask: mask });
        const r = await exportAndParse(
            createScene({ meshes: [createMesh("a", { material, uv2s: UVS }), createMesh("b", { material, gpuOnly: ["uv2"] })], device: createFakeDevice().device })
        );
        expect(r.json.materials).toHaveLength(1);
        expect(r.json.materials[0].pbrMetallicRoughness.baseColorTexture.extensions).toBeUndefined();
    });

    it.each([1, 2])("keeps factors and warns when a texture of size %s cannot be read", async (size) => {
        const texture = createTexture(size, size, PIXELS);
        const factors = { baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0.4, roughnessFactor: 0.6 } satisfies Partial<PbrMaterialProps>;
        const r = await run({ name: "x", baseColorTexture: texture, ormTexture: texture, ...factors }, false);
        expect(r.mat.pbrMetallicRoughness).toEqual(factors);
        expect(r.json.images).toBeUndefined();
        expect(r.warnings).toContain(
            size === 1
                ? '1×1 factor texture for material "x" is not readable on this engine; exporting its factors without the texture.'
                : 'Texture pixels for material "x" are not readable on this engine; exporting the material without that texture.'
        );
    });

    it("shares public material views, preserves name/extras, and warns for unsupported families", async () => {
        const source = createPbrMaterial({ name: "src", roughnessFactor: 0.3, metadata: { gltf: { extras: { tag: "a" } } } } as Partial<PbrMaterialProps>);
        const shader = { name: "shader", _buildGroup: { _materialFamily: "shader" }, _uboVersion: 0 } as unknown as Material;
        const meshes = [
            createMesh("view", { material: createMaterialView(source, { features: 0 }) }),
            createMesh("source", { material: source }),
            createMesh("shader", { material: shader }),
        ];
        const r = await exportAndParse(createScene({ meshes }));
        expect(r.json.materials).toEqual([{ name: "src", pbrMetallicRoughness: { roughnessFactor: 0.3 }, extras: { tag: "a" } }]);
        expect(r.json.meshes.map((m: any) => m.primitives[0].material)).toEqual([0, 0, undefined]);
        expect(r.warnings).toContain('Material "shader" of family "shader" is not mapped to glTF; exporting the primitive without a material.');
        const bad = await run({ name: "bad", metadata: { gltf: { extras: { big: BigInt(1) } } } } as unknown as Partial<PbrMaterialProps>);
        expect(bad.mat.extras).toBeUndefined();
        expect(bad.warnings).toContain('Extras of "bad" are not JSON-serializable; exporting without them.');
    });

    it("synthesizes zero UV0 by vertex count only for surviving textures, retaining authored UVs", async () => {
        const mesh = (name: string, props: Partial<PbrMaterialProps>) => createMesh(name, { uvs: null, material: createPbrMaterial(props) });
        const triangle = createMesh("triangle", {
            material: createPbrMaterial({ baseColorTexture: tex() }),
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            indices: new Uint32Array([0, 1, 2]),
            uvs: null,
        });
        const meshes = [
            mesh("base", { baseColorTexture: tex() }),
            mesh("normal", { normalTexture: tex() }),
            triangle,
            mesh("plain", {}),
            mesh("folded", { baseColorTexture: createTexture(1, 1, [128, 64, 255, 255]) }),
            createMesh("authored", { material: createPbrMaterial({ baseColorTexture: tex() }) }),
        ];
        const r = await exportAndParse(createScene({ meshes, device: createFakeDevice().device }));
        const uv = r.json.meshes.map((m: any) => m.primitives[0].attributes.TEXCOORD_0);
        expect(uv[1]).toBe(uv[0]);
        expect(r.json.accessors[uv[0]]).toMatchObject({ type: "VEC2", componentType: 5126, count: 4 });
        expect(readAccessor(r, uv[0])).toEqual(new Array(8).fill(0));
        expect(r.json.accessors[uv[2]].count).toBe(3);
        expect(uv.slice(3, 5)).toEqual([undefined, undefined]);
        expect(readAccessor(r, uv[5])).toEqual(Array.from(UVS));
    });
});
