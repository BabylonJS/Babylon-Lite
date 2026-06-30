/**
 * Regression test: `@babylonjs/lite` must import in an environment with NO WebGPU
 * implementation (Node, Vitest/Jest, Next.js SSR). Before the fix, `gpu-flags.ts`
 * captured `globalThis.GPUShaderStage` (undefined in Node) and `shader-pipeline.ts`
 * dereferenced it at module top level (`SS.VERTEX | SS.FRAGMENT`), throwing
 * `TypeError: Cannot read properties of undefined (reading 'VERTEX')` on import.
 *
 * This project runs WITHOUT the `setup-webgpu-globals.ts` setup file (see
 * vitest.config.ts → "no-webgpu" project), so the WebGPU flag namespaces are
 * genuinely absent — matching a real Node consumer. The dynamic import must
 * resolve without throwing.
 */
import { beforeAll, describe, expect, it } from "vitest";

describe("@babylonjs/lite imports without WebGPU globals", () => {
    beforeAll(() => {
        // Strip any WebGPU flag namespaces a shared setup may have installed so the
        // import resolves in a genuinely WebGPU-free environment (Node/SSR/Jest).
        const g = globalThis as Record<string, unknown>;
        delete g.GPUShaderStage;
        delete g.GPUTextureUsage;
        delete g.GPUBufferUsage;
        delete g.GPUColorWrite;
    });

    it("has no WebGPU flag globals in this environment", () => {
        const g = globalThis as Record<string, unknown>;
        expect(g.GPUShaderStage).toBeUndefined();
        expect(g.GPUTextureUsage).toBeUndefined();
        expect(g.GPUBufferUsage).toBeUndefined();
        expect(g.GPUColorWrite).toBeUndefined();
    });

    it("imports the engine entry point without throwing", async () => {
        await expect(import("../../../packages/babylon-lite/src/index.js")).resolves.toBeDefined();
    });
});
