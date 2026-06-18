import { describe, expect, it } from "vitest";

import { GaussianSplattingMesh } from "../src/meshes/gaussian-splatting";

/**
 * GPU-free surface checks for the Gaussian-Splatting wrapper. The actual splat
 * load needs a WebGPU device (exercised by the lab compat-parity scenes
 * 120/122/123/124); here we verify the pre-load class shape and Babylon.js
 * parity of the un-loaded handle.
 */
describe("GaussianSplattingMesh", () => {
    it("reports the Babylon.js class name", () => {
        const gs = new GaussianSplattingMesh("splat");
        expect(gs.getClassName()).toBe("GaussianSplattingMesh");
    });

    it("exposes a null splatsData until loaded", () => {
        const gs = new GaussianSplattingMesh("splat");
        expect(gs.splatsData).toBeNull();
    });

    it("reports _canPostToWorker false until the first sort", () => {
        const gs = new GaussianSplattingMesh("splat");
        expect(gs._canPostToWorker).toBe(false);
    });

    it("buffers transforms set before load on its placeholder node", () => {
        const gs = new GaussianSplattingMesh("splat");
        gs.position.y = 1.7;
        expect(gs.position.y).toBeCloseTo(1.7, 6);
    });

    it("rejects loadFileAsync with no URL and no scene", async () => {
        const gs = new GaussianSplattingMesh("splat");
        await expect(gs.loadFileAsync()).rejects.toThrow(/no URL provided/);
    });

    it("updateData / bake are safe no-ops before load", () => {
        const gs = new GaussianSplattingMesh("splat");
        expect(() => gs.updateData(new ArrayBuffer(0))).not.toThrow();
        expect(() => gs.bakeCurrentTransformIntoVertices()).not.toThrow();
    });
});
