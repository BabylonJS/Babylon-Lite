import { expect, it, vi } from "vitest";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { loadProceduralSkyEnvironment } from "../../../packages/babylon-lite/src/loader-env/procedural-sky-environment";
import type * as EnvHelpers from "../../../packages/babylon-lite/src/loader-env/env-helpers";

const images = vi.hoisted(() => [] as ImageBitmap[]);
vi.mock("../../../packages/babylon-lite/src/loader-env/env-helpers.js", async (importOriginal) => ({
    ...(await importOriginal<typeof EnvHelpers>()),
    loadBrdfImage: async () => {
        const image = { close: vi.fn() } as unknown as ImageBitmap;
        images.push(image);
        return image;
    },
}));
vi.mock("../../../packages/babylon-lite/src/loader-env/rgbd-decode.js", () => {
    throw new Error("decoder import failed");
});

it("closes BRDF bitmaps and releases the scene reservation when the decoder import fails", async () => {
    const createTexture = vi.fn();
    const scene = { surface: { engine: { _device: { createTexture } } }, _disposables: [] } as unknown as SceneContext;
    const options = {
        sunDirection: [0.35, 0.82, 0.45] as const,
        luminance: 1,
        turbidity: 10,
        rayleigh: 2,
        mieCoefficient: 0.005,
        mieDirectionalG: 0.8,
        brdfUrl: "/brdf.png",
        _yield: async () => undefined,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
        await expect(loadProceduralSkyEnvironment(scene, options)).rejects.toThrow();
        expect(images).toHaveLength(attempt + 1);
        expect(images[attempt]!.close).toHaveBeenCalledOnce();
        expect(scene._disposables).toHaveLength(0);
        expect(scene._envTextures).toBeUndefined();
    }
    expect(createTexture).not.toHaveBeenCalled();
});
