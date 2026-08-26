import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { GeometryTextureType } from "../../../packages/babylon-lite/src/frame-graph/geometry-types";
import { MSH_HAS_UV2, MSH_HAS_VERTEX_COLOR } from "../../../packages/babylon-lite/src/material/mesh-features";
import {
    PBR2_HAS_REFLECTANCE_FACTORS,
    PBR2_HAS_UV2,
    PBR2_HAS_UV_TRANSFORM,
    PBR_HAS_EMISSIVE,
    PBR_HAS_EMISSIVE_COLOR,
    PBR_HAS_OCCLUSION,
} from "../../../packages/babylon-lite/src/material/pbr/pbr-flag-bits";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { bumpStdExt } from "../../../packages/babylon-lite/src/material/standard/fragments/normal-map-fragment";
import { stdAmbientExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-ambient-fragment";
import { stdEmissiveExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-emissive-fragment";
import { stdLightmapExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-lightmap-fragment";
import { stdOpacityExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-opacity-fragment";
import { stdSpecularExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-specular-fragment";
import { stdUvTransformExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-uv-transform-fragment";
import {
    HAS_AMBIENT_TEXTURE,
    HAS_BUMP_TEXTURE,
    HAS_DIFFUSE_TEXTURE,
    HAS_EMISSIVE_TEXTURE,
    HAS_LIGHTMAP_TEXTURE,
    HAS_OPACITY_TEXTURE,
    HAS_SPECULAR_TEXTURE,
    LIGHTMAP_FLIP_V,
} from "../../../packages/babylon-lite/src/material/standard/standard-flags";
import { composeStandardGeometryShader } from "../../../packages/babylon-lite/src/material/standard/standard-geometry-output-shader";
import type { StandardMaterialProps } from "../../../packages/babylon-lite/src/material/standard/standard-material";
import { composeStandardShader } from "../../../packages/babylon-lite/src/material/standard/standard-pipeline";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

describe("PBR UV transform detection", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("opts a hand-built material into UV transforms before build", async () => {
        const { enableMaterialUvTransform } = await import("../../../packages/babylon-lite/src/material/enable-material-uv-transform");
        const material = { _buildGroup: { _materialFamily: "pbr" } } as PbrMaterialProps;
        expect(enableMaterialUvTransform(material)).toBe(true);
        expect(material._hasUvTx).toBe(true);

        (material as PbrMaterialProps & { _renderFeatures: { features: number } })._renderFeatures = { features: 0 };
        expect(enableMaterialUvTransform(material)).toBe(false);
    });

    it("contributes PBR2_HAS_UV_TRANSFORM only once the opt-in registers the ext", async () => {
        const { _computePbrMaterialFeatures } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-material");
        const bare = { _hasUvTx: true } as PbrMaterialProps;
        expect(_computePbrMaterialFeatures(bare).features2 & PBR2_HAS_UV_TRANSFORM).toBe(0);

        const { enableMaterialUvTransform } = await import("../../../packages/babylon-lite/src/material/enable-material-uv-transform");
        const optedIn = { _buildGroup: { _materialFamily: "pbr" } } as PbrMaterialProps;
        enableMaterialUvTransform(optedIn);
        expect(_computePbrMaterialFeatures(optedIn).features2 & PBR2_HAS_UV_TRANSFORM).toBe(PBR2_HAS_UV_TRANSFORM);
    });
});

describe("StandardMaterial UV transform detection", () => {
    it("queues the StandardMaterial extension preload", async () => {
        const { enableMaterialUvTransform } = await import("../../../packages/babylon-lite/src/material/enable-material-uv-transform");
        const builder = { _materialFamily: "standard" as const };
        const material = { _buildGroup: builder } as StandardMaterialProps;
        expect(enableMaterialUvTransform(material)).toBe(true);
        expect(material._hasUvTx).toBe(true);
        await material._uvTxExt;
    });

    it("composes a transformed diffuse varying for StandardMaterial", () => {
        const features = HAS_DIFFUSE_TEXTURE | (1 << 23);
        const shader = composeStandardShader(features, 0, [stdUvTransformExt._frag(features)]);
        expect(shader._vertexWGSL).toContain("out.vu=stdTxfUV(uv");
        expect(shader._fragmentWGSL).toContain("textureSample(dT, dS, input.vu)");
        expect(shader._vertexWGSL).not.toContain("morphedPos");
    });

    it("orders the transform before texture fragments", () => {
        expect(stdUvTransformExt._id.localeCompare(stdSpecularExt._id)).toBeLessThan(0);
        expect(stdUvTransformExt._meshFeatures!(0, {} as StandardMaterialProps)).toBe(0);
        expect(stdUvTransformExt._meshFeatures!(0, { _hasUvTx: true } as StandardMaterialProps)).toBe(1 << 23);
    });

    it("uses the transformed specular UV in forward and geometry shaders", () => {
        const features = HAS_SPECULAR_TEXTURE | (1 << 23);
        const fragments = [stdUvTransformExt._frag(features), stdSpecularExt._frag(features)];
        const forward = composeStandardShader(features, 0, fragments);
        expect(forward._vertexWGSL).toContain("out.vs=stdTxfUV(uv");
        expect(forward._fragmentWGSL).toContain("textureSample(sT, sS, input.vs)");

        const geometry = composeStandardGeometryShader(features, 0, fragments, [GeometryTextureType.REFLECTIVITY]);
        expect(geometry._fragmentWGSL).toContain("textureSample(sT, sS, input.vs)");
    });

    it("post-composes independent UVs for every optional Standard texture channel", () => {
        const features =
            HAS_BUMP_TEXTURE | HAS_EMISSIVE_TEXTURE | HAS_SPECULAR_TEXTURE | HAS_AMBIENT_TEXTURE | HAS_LIGHTMAP_TEXTURE | LIGHTMAP_FLIP_V | HAS_OPACITY_TEXTURE | (1 << 23);
        const fragments = [
            stdUvTransformExt._frag(features),
            bumpStdExt._frag(features),
            stdAmbientExt._frag(features),
            stdEmissiveExt._frag(features),
            stdLightmapExt._frag(features),
            stdOpacityExt._frag(features),
            stdSpecularExt._frag(features),
        ];
        const shader = composeStandardShader(features, 0, fragments);
        expect(shader._fragmentWGSL).toContain("perturbNormal(input.vn, input.vp, input.vb, mat.bs)");
        expect(shader._fragmentWGSL).toContain("textureSample(eT, eS, input.ve)");
        expect(shader._fragmentWGSL).toContain("textureSample(sT, sS, input.vs)");
        expect(shader._fragmentWGSL).toContain("textureSample(aT, aS, input.va)");
        expect(shader._fragmentWGSL).toContain("textureSample(lT, lS, input.vl)");
        expect(shader._fragmentWGSL).toContain("textureSample(oT, oS, input.vo)");
    });

    it("applies invertY after texture rotation and preserves the lightmap flip sentinel", () => {
        let written: Float32Array | undefined;
        const engine = {
            _device: {
                createBuffer: () => ({}),
                queue: {
                    writeBuffer: (_buffer: GPUBuffer, _offset: number, source: ArrayBuffer, byteOffset: number, byteLength: number) => {
                        written = new Float32Array(source.slice(byteOffset, byteOffset + byteLength));
                    },
                },
            },
        } as unknown as EngineContext;
        const material = {
            uvScale: [1, 1],
            diffuseTexture: {
                uScale: 1.65,
                vScale: 1.15,
                uOffset: 0.17,
                vOffset: 0.11,
                uAng: 0.42,
                invertY: true,
            },
            _lightmapTexture: { uAng: Math.PI },
        } as StandardMaterialProps;

        stdUvTransformExt._bind!(material, [], 0, undefined, { surface: { engine } } as SceneContext);
        const c = Math.cos(0.42);
        const s = Math.sin(0.42);
        expect(written![2]).toBeCloseTo(s * 1.65);
        expect(written![3]).toBeCloseTo(-c * 1.15);
        expect(written![5]).toBeCloseTo(0.89);

        const lightmapOffset = 5 * 8;
        expect(Array.from(written!.slice(lightmapOffset, lightmapOffset + 6))).toEqual([1, 0, 0, -1, 0, 1]);
    });
});

describe("PBR emissive UV selection", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    /** Compose a PBR fragment through the real composer with the uv-transform and
     *  emissive-color exts registered. The material carries an emissive texture AND
     *  an emissive colour — the glTF shape for any emissiveFactor other than
     *  [1,1,1], and for KHR_materials_emissive_strength. */
    async function composeEmissive(features2: number, meshFeatures: number, uv2Mask: number): Promise<string> {
        const flags = await import("../../../packages/babylon-lite/src/material/pbr/pbr-flags");
        const { createPbrComposer } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-compose");
        const { createPbrTemplateExt } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-template-ext");
        flags._registerPbrExt((await import("../../../packages/babylon-lite/src/material/pbr/fragments/uv-transform-fragment")).pbrExt);
        flags._registerPbrExt((await import("../../../packages/babylon-lite/src/material/pbr/fragments/emissive-fragment")).pbrExt);

        const composePbr = createPbrComposer({
            _singleLightWGSL: "",
            _getSingleLightBlock: null,
            _multiLightWGSL: "",
            _multiLightLoop: "",
            _tm: undefined,
            _fogHelper: "",
            _fogBlock: "",
            _createPbrTemplateExt: createPbrTemplateExt,
            _flatNormalWgsl: "",
            _createPbrShadowFragment: null,
            _shadowLights: [],
            _createThinInstanceFragment: null,
        });
        return composePbr(PBR_HAS_EMISSIVE | PBR_HAS_EMISSIVE_COLOR, features2, meshFeatures, 0, 0, "", "", undefined, "", uv2Mask)._fragmentWGSL;
    }

    const cases: Array<[label: string, features2: number, meshFeatures: number, uv2Mask: number, expected: string]> = [
        ["through its KHR_texture_transform", PBR2_HAS_UV_TRANSFORM, 0, 0, "emissiveUV"],
        ["at UV1 when its texCoord is 1", PBR2_HAS_UV2, MSH_HAS_UV2, 8, "input.uv2"],
        ["at the raw UV when it carries neither", 0, 0, 0, "input.uv"],
    ];

    it.each(cases)("samples the emissive texture %s", async (_label, features2, meshFeatures, uv2Mask, expected) => {
        const wgsl = await composeEmissive(features2, meshFeatures, uv2Mask);
        expect(wgsl).toContain(`textureSample(emissiveTexture,emissiveSampler,${expected})`);
    });

    // A per-channel UV local the prelude declares but nothing samples at is the
    // signature of a slot that replaced a template line and re-derived its UV
    // wrongly — the defect this describe block covers.
    it("leaves no composed UV local unsampled", async () => {
        const wgsl = await composeEmissive(PBR2_HAS_UV_TRANSFORM | PBR2_HAS_UV2, MSH_HAS_UV2, 8);
        const declared = [...wgsl.matchAll(/let (\w+) = txfUV\(/g)].map((m) => m[1]!);
        const sampledAt = new Set([...wgsl.matchAll(/textureSample\([^,]+,[^,]+,\s*([^)]+)\)/g)].map((m) => m[1]!.trim()));
        expect(declared).toContain("emissiveUV");
        for (const name of declared) {
            expect(sampledAt, `${name} is declared but nothing samples at it`).toContain(name);
        }
    });
});

describe("PBR independent-occlusion UV transform", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    // Mirrors uv-transform-fragment.ts and pbr-template-ext.ts, which both define
    // it locally so non-UV-transform bundles carry none of it.
    const PBR2_OCCL_UV_SPLIT = 1 << 28;

    /** Compose a PBR fragment through the real composer with the uv-transform and
     *  reflectance exts registered. `MSH_HAS_VERTEX_COLOR` is what makes the
     *  template ext exist without the material carrying a UV transform of its own. */
    async function composeOcclusion(features2: number): Promise<string> {
        const flags = await import("../../../packages/babylon-lite/src/material/pbr/pbr-flags");
        const { createPbrComposer } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-compose");
        const { createPbrTemplateExt } = await import("../../../packages/babylon-lite/src/material/pbr/pbr-template-ext");
        flags._registerPbrExt((await import("../../../packages/babylon-lite/src/material/pbr/fragments/uv-transform-fragment")).pbrExt);
        flags._registerPbrExt((await import("../../../packages/babylon-lite/src/material/pbr/fragments/reflectance-fragment")).pbrExt);

        const composePbr = createPbrComposer({
            _singleLightWGSL: "",
            _getSingleLightBlock: null,
            _multiLightWGSL: "",
            _multiLightLoop: "",
            _tm: undefined,
            _fogHelper: "",
            _fogBlock: "",
            _createPbrTemplateExt: createPbrTemplateExt,
            _flatNormalWgsl: "",
            _createPbrShadowFragment: null,
            _shadowLights: [],
            _createThinInstanceFragment: null,
        });
        return composePbr(PBR_HAS_OCCLUSION, features2, MSH_HAS_VERTEX_COLOR, 0, 0, "", "", undefined, "", 0)._fragmentWGSL;
    }

    it("never references occlUV without declaring it", async () => {
        // The split bit is reachable without a UV transform: uv-transform-fragment's
        // `detect` sets it from `occlusionTexture` presence alone, and the ext registry
        // is global, so one material opting into transforms exposes the bit on every
        // material in the scene.
        const wgsl = await composeOcclusion(PBR2_OCCL_UV_SPLIT);
        if (wgsl.includes("occlUV")) {
            expect(wgsl).toMatch(/let occlUV\s*=/);
        }
    });

    it("samples occlusion at its own transformed UV when the reflectance ext owns the slot", async () => {
        const wgsl = await composeOcclusion(PBR2_HAS_REFLECTANCE_FACTORS | PBR2_HAS_UV_TRANSFORM | PBR2_OCCL_UV_SPLIT);
        expect(wgsl).toMatch(/let occlUV\s*=/);
        expect(wgsl).toContain("textureSample(ormTexture,ormSampler,occlUV)");
    });
});
