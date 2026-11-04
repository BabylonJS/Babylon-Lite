/**
 * CubeTexture brand — compile-time guard.
 *
 * `Texture2D` is structurally `{ texture, view, sampler, ... }`. Before `CubeTexture`
 * was branded, a plain 2D texture satisfied the cube reflection slot and only failed
 * later inside WebGPU, when a `2d` view was bound to a `texture_cube<f32>` binding.
 * These assertions keep that hole closed at compile time.
 */
import { describe, expect, it } from "vitest";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material.js";
import { setStandardReflectionCubeTexture } from "../../../packages/babylon-lite/src/material/standard/set-std-cube-reflection.js";
import type { CubeTexture } from "../../../packages/babylon-lite/src/texture/cube-texture.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";

describe("CubeTexture brand", () => {
    it("only accepts a loadCubeTexture result (compile-time)", () => {
        const mat = createStandardMaterial();

        const cube = { _texture: {} as GPUTexture, _view: {} as GPUTextureView, _sampler: {} as GPUSampler } as CubeTexture;
        setStandardReflectionCubeTexture(mat, cube); // ✅ branded
        expect(mat._reflectionCubeTexture).toBe(cube);

        const plain: Texture2D = { texture: {} as GPUTexture, view: {} as GPUTextureView, sampler: {} as GPUSampler, width: 8, height: 8 };
        // @ts-expect-error a Texture2D lacks the cube-texture brand and its internal members
        setStandardReflectionCubeTexture(mat, plain);

        // Clearing is still allowed.
        setStandardReflectionCubeTexture(mat, null);
        expect(mat._reflectionCubeTexture).toBeNull();
    });
});
