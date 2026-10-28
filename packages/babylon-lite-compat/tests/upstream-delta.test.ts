import { describe, expect, it } from "vitest";

import { NullEngine } from "../src/engine/engine";
import { Scene } from "../src/scene/scene";
import {
    GaussianSplattingGpuSorter,
    GetGaussianSplattingGpuSorterMaxSplatCount,
    _ClampGpuSortKeyBits,
    _DecodeGpuSortSogMean,
    _GetGpuSortPaddedCount,
} from "../src/meshes/gaussian-splatting-gpu-sorter";
import { Constants } from "../src/misc/engine-constants";
import { ChannelMask, DivideTexturesAsync, TextureColorSpace } from "../src/textures/texture-processing";
import { _IsHtmlInCanvasPolyfillInstalled } from "../src/unsupported/unsupported-apis";
import { Color4 } from "../src/math/color";

describe("Babylon.js upstream delta surfaces", () => {
    it("exposes the sampled-data-only texture creation flag", () => {
        expect(Constants.TEXTURE_CREATIONFLAG_SAMPLED_DATA_ONLY).toBe(2);
    });

    it("forwards deterministic GPU-sort helpers while reporting the unavailable runtime sorter", () => {
        const engine = new NullEngine();
        expect(GaussianSplattingGpuSorter.IsSupported(engine)).toBe(false);
        expect(GaussianSplattingGpuSorter.GetMaxSupportedSplatCount(engine)).toBeGreaterThan(0);
        expect(GetGaussianSplattingGpuSorterMaxSplatCount(engine)).toBeGreaterThan(0);
        expect(_ClampGpuSortKeyBits(2)).toBe(8);
        expect(_GetGpuSortPaddedCount(17)).toBe(32);
        expect(_DecodeGpuSortSogMean(0)).toBe(0);
    });

    it("processes constant texture operands and preserves runtime enums", async () => {
        expect(TextureColorSpace.SRGB).toBe(1);
        expect(ChannelMask.RGBA).toBe(0xf);
        const result = await DivideTexturesAsync(
            "divide",
            { texture: null, factor: new Color4(1, 0.5, 0.25, 1) },
            { texture: null, factor: new Color4(2, 0.25, 0.5, 0.5) },
            {} as never
        );
        expect(result.texture).toBeNull();
        expect(result.factor).toEqual(new Color4(0.5, 2, 0.5, 2));
        const rgb = await DivideTexturesAsync(
            "divide-rgb",
            { texture: null, factor: new Color4(1, 1, 1, 0.5) },
            { texture: null, factor: new Color4(1, 1, 1, 0.25) },
            {} as never,
            TextureColorSpace.Linear,
            ChannelMask.RGB
        );
        expect(rgb.factor).toEqual(new Color4(1, 1, 1, 1));
        await expect(DivideTexturesAsync("divide", { texture: {} as never }, { texture: null, factor: new Color4(1, 1, 1, 1) }, {} as never)).rejects.toThrow(
            /procedural texture processor/
        );
    });

    it("reports that compat never installed the unsupported HTML-in-canvas polyfill", () => {
        expect(_IsHtmlInCanvasPolyfillInstalled()).toBe(false);
    });

    it("surfaces stable named particle systems registered with the Lite scene", () => {
        const scene = new Scene(new NullEngine());
        const liteSystem = { name: "smoke", updateSpeed: 1, texture: null };
        (scene._lite as unknown as { _particleSystems: object[] })._particleSystems = [liteSystem];

        expect(scene.particleSystems).toHaveLength(1);
        expect(scene.particleSystems[0]!.name).toBe("smoke");
        expect(scene.particleSystems[0]).toBe(scene.particleSystems[0]);
        scene.particleSystems[0]!.dispose();
        expect(scene.particleSystems).toEqual([]);
    });
});
