import { describe, expect, it } from "vitest";
import { createFakeDevice, createMesh, createScene, createTexture, decodePng, expectClose, exportAndParse, readBufferView } from "./export-test-utils";
import type { ParsedGlb } from "./export-test-utils";
import { createStandardMaterial } from "../../../../packages/babylon-lite/src/material/standard/create-standard-material";
import type { StandardMaterialProps } from "../../../../packages/babylon-lite/src/material/standard/standard-material";
import { stdUvTransformExt } from "../../../../packages/babylon-lite/src/material/standard/fragments/std-uv-transform-fragment";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core";
import { srgbByteToLinear } from "../../../../packages/babylon-lite/src/math/color";

const TOP = [100, 150, 200, 255];
const BOTTOM = [10, 20, 30, 255];
const WRAPPER = { uScale: 2, vScale: 3, uOffset: 0.1, vOffset: 0.2, uAng: 0.5 };
const column = (invertY = false, wrapper = {}, format: GPUTextureFormat = "rgba8unorm") => createTexture(1, 2, [...TOP, ...BOTTOM], { invertY, wrapper, format });
const std = (props: Partial<StandardMaterialProps>) => Object.assign(createStandardMaterial(), props);

async function run(props: Partial<StandardMaterialProps>) {
    const r = await exportAndParse(createScene({ meshes: [createMesh("m", { material: std(props) })], device: createFakeDevice().device }));
    return { ...r, mat: r.json.materials[0] };
}

async function rows(r: ParsedGlb, info: { index: number }): Promise<number[][]> {
    const png = await decodePng(readBufferView(r, r.json.images[r.json.textures[info.index].source].bufferView));
    return [Array.from(png.rgba.subarray(0, 4)), Array.from(png.rgba.subarray(4, 8))];
}

describe("Standard material export", () => {
    it.each<[StandardMaterialProps["diffuseColor"], number]>([
        [[1, 1, 1], 1],
        [[0.5, 0.25, 1], 0.8],
    ])("should convert Babylon standard material to metallic roughness (%j, alpha %s)", async (diffuseColor, alpha) => {
        const r = await run({ name: "wood", diffuseColor, alpha, specularPower: 64 });
        expectClose(r.mat.pbrMetallicRoughness.baseColorFactor, [...diffuseColor!.map((v) => v ** 2.2 * 0.5), alpha], 6);
        expect(r.mat.pbrMetallicRoughness.metallicFactor).toBe(0);
        expect(Math.abs(r.mat.pbrMetallicRoughness.roughnessFactor - 0.328809)).toBeLessThan(1e-6);
        expect(r.mat.name).toBe("wood");
    });

    it("clamps specular power to its supported range", async () => {
        expect((await run({ specularPower: -5 })).mat.pbrMetallicRoughness.roughnessFactor).toBeUndefined();
        expect((await run({ specularPower: 2000 })).mat.pbrMetallicRoughness).toEqual((await run({ specularPower: 1024 })).mat.pbrMetallicRoughness);
    });

    it.each<[boolean, boolean, GPUTextureFormat]>([
        [false, false, "rgba8unorm"],
        [false, false, "rgba8unorm-srgb"],
        [true, false, "rgba8unorm"],
        [true, true, "rgba8unorm"],
    ])("preserves Standard image bytes and bump frame (bump=%s flip=%s format=%s)", async (bump, flip, format) => {
        const r = await run({ [bump ? "_bumpTexture" : "diffuseTexture"]: column(flip, {}, format), bumpLevel: 2 });
        const info = bump ? r.mat.normalTexture : r.mat.pbrMetallicRoughness.baseColorTexture;
        const expected = (flip ? [BOTTOM, TOP] : [TOP, BOTTOM]).map((pixel) =>
            pixel.map((v, i) => (bump && (i === 0 || (flip && i === 1)) ? 255 - v : format.endsWith("-srgb") && i < 3 ? Math.round(srgbByteToLinear(v) * 255) : v))
        );
        expect(await rows(r, info)).toEqual(expected);
        expect(info).toEqual(bump ? { index: 0, scale: 2 } : { index: 0 });
    });

    it.each<[string, Partial<StandardMaterialProps>, boolean, object]>([
        ["diffuse wins", { diffuseTexture: column(false), _opacityTexture: column(true), _bumpTexture: column(true) }, false, { offset: [0.1, 0.2], scale: [2, 3] }],
        ["diffuse flips all", { diffuseTexture: column(true) }, true, { offset: [0.1, -2.2], scale: [2, 3] }],
        ["opacity fallback", { _opacityTexture: column(true) }, true, { offset: [0.1, -2.2], scale: [2, 3] }],
        ["bump fallback", { _bumpTexture: column(true) }, true, { offset: [0.1, -2.2], scale: [2, 3] }],
        ["offset only", { uvScale: [1, 1] }, false, { offset: [0.1, 0.2] }],
    ])("preserves shared-path UV orientation and transforms: %s", async (_label, props, flipped, transform) => {
        const r = await run({ uvScale: [2, 3], uvOffset: [0.1, 0.2], _emissiveTexture: column(), ...props });
        expect(await rows(r, r.mat.emissiveTexture)).toEqual(flipped ? [BOTTOM, TOP] : [TOP, BOTTOM]);
        expect(r.mat.emissiveTexture.extensions.KHR_texture_transform).toEqual(transform);
        expect(r.json.extensionsUsed).toContain("KHR_texture_transform");
        expect(r.json.extensionsRequired).toBeUndefined();
    });

    it.each([false, true])("reproduces the shader UV matrix and per-texture orientation under the Khronos rotation convention (flip=%s)", async (invertY) => {
        let uniform: Float32Array | undefined;
        const engine = {
            _device: {
                createBuffer: () => ({}),
                queue: {
                    writeBuffer: (_buffer: GPUBuffer, _offset: number, source: ArrayBuffer, byteOffset: number, byteLength: number) => {
                        uniform = new Float32Array(source.slice(byteOffset, byteOffset + byteLength));
                    },
                },
            },
        } as unknown as EngineContext;
        const props: Partial<StandardMaterialProps> = {
            _hasUvTx: true,
            uvScale: [1.5, 2],
            uvOffset: [0.3, 0.4],
            diffuseTexture: column(invertY, WRAPPER),
            _emissiveTexture: column(),
        };
        stdUvTransformExt._bind!(std(props), [], 0, undefined, { surface: { engine } } as SceneContext);
        const r = await run(props);
        const base = r.mat.pbrMetallicRoughness.baseColorTexture;
        const { offset, scale, rotation } = base.extensions.KHR_texture_transform;
        const c = Math.cos(0.5);
        const s = Math.sin(0.5);
        expect(rotation).toBe(0.5);
        expect(scale).toEqual([3, 6]);
        expectClose(offset, [c * 2 * 0.3 + s * 3 * 0.4 + 0.1, -s * 2 * 0.3 + c * 3 * 0.4 + 0.2], 6);
        // Khronos uses rotation columns (cos, -sin), (sin, cos).
        const sign = invertY ? -1 : 1;
        expectClose(
            Array.from(uniform!.subarray(0, 6)),
            [c * scale[0], s * scale[1], -sign * s * scale[0], sign * c * scale[1], offset[0], invertY ? 1 - offset[1] : offset[1]],
            6
        );
        expect(await rows(r, base)).toEqual(invertY ? [BOTTOM, TOP] : [TOP, BOTTOM]);
        expect(await rows(r, r.mat.emissiveTexture)).toEqual([TOP, BOTTOM]);
        expect(r.mat.emissiveTexture.extensions.KHR_texture_transform).toEqual({ offset: [0.3, 0.4], scale: [1.5, 2] });
    });

    it.each([false, true])("preserves UV1 available/missing/lost variants and UV1 transform semantics (per-texture=%s)", async (perTexture) => {
        const material = std({
            _hasUvTx: perTexture,
            diffuseTexture: column(true, WRAPPER),
            _ambientTexture: column(true, WRAPPER),
            diffuseCoordIndex: 1,
            ambientCoordIndex: 1,
            uvScale: [5, 5],
            uvOffset: [0.7, 0.7],
        });
        const meshes = [createMesh("uv1", { material, uv2s: new Float32Array(8) }), createMesh("uv0", { material }), createMesh("lost", { material, gpuOnly: ["uv2"] })];
        const r = await exportAndParse(createScene({ meshes, device: createFakeDevice().device }));
        expect(r.json.materials).toHaveLength(3);
        for (const info of [r.json.materials[0].pbrMetallicRoughness.baseColorTexture, r.json.materials[0].occlusionTexture]) {
            expect(info.texCoord).toBe(1);
            expect(info.extensions?.KHR_texture_transform).toEqual(perTexture ? { offset: [0.1, 0.2], scale: [2, 3], rotation: 0.5, texCoord: 1 } : undefined);
            expect(await rows(r, info)).toEqual(perTexture ? [BOTTOM, TOP] : [TOP, BOTTOM]);
        }
        for (const mat of r.json.materials.slice(1)) {
            expect(mat.pbrMetallicRoughness.baseColorTexture).toBeUndefined();
            expect(mat.occlusionTexture).toBeUndefined();
        }
        expect(r.warnings.filter((w) => w.includes("samples TEXCOORD_1"))).toHaveLength(1);
    });

    it.each<[Partial<StandardMaterialProps>, string | undefined, number | undefined, number]>([
        [{ alphaCutOff: 0.5, diffuseTexture: column() }, "MASK", undefined, 0],
        [{ alphaCutOff: 0.25, diffuseTexture: column() }, "MASK", 0.25, 0],
        [{ alphaCutOff: 0.25 }, undefined, undefined, 0],
        [{ alphaCutOff: 0.25, alpha: 0.5 }, "BLEND", undefined, 0],
        [{ alphaCutOff: 0.25, alpha: 0.5, diffuseTexture: column() }, "BLEND", undefined, 1],
        [{ alphaCutOff: 0.25, _opacityTexture: column(), diffuseTexture: column() }, "BLEND", undefined, 1],
        [{ disableLighting: true, alphaCutOff: 0.3, diffuseTexture: column() }, "MASK", 0.3, 0],
        [{ disableLighting: true, alpha: 0.5, diffuseTexture: column() }, "BLEND", undefined, 0],
    ])("preserves Standard alpha-test/blend precedence for %j", async (props, mode, cutoff, warnings) => {
        const r = await run({ backFaceCulling: false, ...props });
        expect([r.mat.alphaMode, r.mat.alphaCutoff, r.mat.doubleSided]).toEqual([mode, cutoff, true]);
        expect(r.warnings).toEqual(warnings ? [expect.stringContaining("both alpha-tests and blends")] : []);
    });

    it.each<[Partial<StandardMaterialProps>, number[]]>([
        [{ emissiveColor: [1, 0.5, 0.25], diffuseColor: [0.5, 1, 1], alpha: 0.8 }, [0.5 ** 2.2, 0.5 ** 2.2, 0.25 ** 2.2, 0.8]],
        [{ emissiveColor: [4, 2, 1], diffuseColor: [1, 0.25, 1] }, [1, 0.5 ** 2.2, 1, 1]],
        [{}, [0, 0, 0, 1]],
    ])("exports unlit clamp(emissive * diffuse)^2.2 without metallic/roughness for %j", async (props, expected) => {
        const r = await run({ disableLighting: true, ...props });
        expect(Object.keys(r.mat.pbrMetallicRoughness)).toEqual(["baseColorFactor"]);
        expectClose(r.mat.pbrMetallicRoughness.baseColorFactor, expected, 6);
        expect(r.mat.emissiveFactor).toBeUndefined();
        expect(r.mat.extensions).toEqual({ KHR_materials_unlit: {} });
        expect(r.warnings).toEqual([]);
    });

    it("keeps only diffuse textures for unlit materials and warns about emissive textures", async () => {
        const r = await run({ disableLighting: true, diffuseTexture: column(), _bumpTexture: column(), _ambientTexture: column(), _emissiveTexture: column() });
        expect(r.mat.pbrMetallicRoughness.baseColorTexture).toEqual({ index: 0 });
        expect([r.mat.normalTexture, r.mat.occlusionTexture, r.mat.emissiveTexture, r.mat.emissiveFactor]).toEqual([undefined, undefined, undefined, undefined]);
        expect(r.json.images).toHaveLength(1);
        expect(r.warnings).toEqual([expect.stringContaining("unlit with an emissive texture")]);
    });

    it.each<[StandardMaterialProps["emissiveColor"] | undefined, number[], number]>([
        [undefined, [1, 1, 1], 0],
        [[0.5, 0, 1], [0.5 ** 2.2, 0, 1], 0],
        [[2, 0.5, 0], [1, 0.5 ** 2.2, 0], 1],
    ])("preserves Standard emissive factors and clamps HDR with a warning (%j)", async (emissiveColor, expected, warnings) => {
        const r = await run({ name: "glow", emissiveColor, _emissiveTexture: column() });
        expectClose(r.mat.emissiveFactor, expected, 6);
        expect(r.warnings).toEqual(warnings ? ['Material "glow" has factors outside [0, 1], which glTF cannot represent; exporting them clamped.'] : []);
    });
});
