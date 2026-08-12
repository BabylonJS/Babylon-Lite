import { describe, expect, it } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { GeometryTextureType } from "../../../packages/babylon-lite/src/frame-graph/geometry-types";
import { enableMaterialUvTransform } from "../../../packages/babylon-lite/src/material/enable-material-uv-transform";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { StandardMaterialProps } from "../../../packages/babylon-lite/src/material/standard/standard-material";
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
import { composeStandardShader } from "../../../packages/babylon-lite/src/material/standard/standard-pipeline";
import { bumpStdExt } from "../../../packages/babylon-lite/src/material/standard/fragments/normal-map-fragment";
import { stdAmbientExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-ambient-fragment";
import { stdEmissiveExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-emissive-fragment";
import { stdLightmapExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-lightmap-fragment";
import { stdOpacityExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-opacity-fragment";
import { stdUvTransformExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-uv-transform-fragment";
import { stdSpecularExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-specular-fragment";

describe("material UV transform detection", () => {
    it("opts a hand-built material into UV transforms before build", () => {
        const material = { _buildGroup: { _materialFamily: "pbr" } } as PbrMaterialProps;
        expect(enableMaterialUvTransform(material)).toBe(true);
        expect(material._hasUvTx).toBe(true);

        (material as PbrMaterialProps & { _renderFeatures: { features: number } })._renderFeatures = { features: 0 };
        expect(enableMaterialUvTransform(material)).toBe(false);
    });

    it("queues the StandardMaterial extension preload", async () => {
        const previous = Promise.resolve();
        const builder = { _materialFamily: "standard" as const, _preload: previous };
        const material = { _buildGroup: builder } as StandardMaterialProps;
        expect(enableMaterialUvTransform(material)).toBe(true);
        expect(material._hasUvTx).toBe(true);
        expect(builder._preload).not.toBe(previous);
        await material._uvTxExt;
        await builder._preload;
        expect(builder._preload).toBeUndefined();
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
            lightmapTexture: { uAng: Math.PI },
        } as StandardMaterialProps;

        stdUvTransformExt._bind!(material, [], 0, undefined, engine);
        const c = Math.cos(0.42);
        const s = Math.sin(0.42);
        expect(written![2]).toBeCloseTo(s * 1.65);
        expect(written![3]).toBeCloseTo(-c * 1.15);
        expect(written![5]).toBeCloseTo(0.89);

        const lightmapOffset = 5 * 8;
        expect(Array.from(written!.slice(lightmapOffset, lightmapOffset + 6))).toEqual([1, 0, 0, -1, 0, 1]);
    });
});
