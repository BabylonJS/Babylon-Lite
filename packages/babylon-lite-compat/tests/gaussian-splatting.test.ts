import { describe, expect, it } from "vitest";

import { createTransformNode, getAccessibilityTag } from "babylon-lite";
import type { GaussianSplattingMesh as LiteGaussianSplattingMesh } from "babylon-lite";

import { GaussianSplattingMesh } from "../src/meshes/gaussian-splatting";
import type { Scene } from "../src/scene/scene";

function fakeLiteMesh(): LiteGaussianSplattingMesh {
    return createTransformNode("loaded") as unknown as LiteGaussianSplattingMesh;
}

/**
 * GPU-free surface checks for the Gaussian-Splatting wrapper. The actual splat
 * load needs a WebGPU device (exercised by the lab compat-parity scenes
 * 120/122/123/124); here we verify the pre-load class shape and Babylon.js
 * parity of the un-loaded handle.
 */
describe("GaussianSplattingMesh", () => {
    it("exposes mutable BJS GPU-sort preferences while Lite keeps its CPU worker fallback", () => {
        const gs = new GaussianSplattingMesh("splat");
        expect(GaussianSplattingMesh.UseGpuSort).toBe(false);
        expect(GaussianSplattingMesh.GpuSortMinFrameInterval).toBe(1);
        expect(gs.useGpuSort).toBeNull();
        gs.useGpuSort = true;
        GaussianSplattingMesh.UseGpuSort = true;
        expect(gs.useGpuSort).toBe(true);
        expect(GaussianSplattingMesh.UseGpuSort).toBe(true);
        gs.useGpuSort = null;
        GaussianSplattingMesh.UseGpuSort = false;
    });

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

    it("reports _canPostToWorker false while a Lite sort is in flight", () => {
        const gs = new GaussianSplattingMesh("splat");
        const state = gs as unknown as { _gs: { _orderPool: Uint32Array[] } };
        state._gs = { _orderPool: [new Uint32Array(1)] };
        expect(gs._canPostToWorker).toBe(false);
        state._gs._orderPool.push(new Uint32Array(1));
        expect(gs._canPostToWorker).toBe(true);
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

    it("exposes a null safeOrbitCameraLimits (BJS shape parity)", () => {
        const gs = new GaussianSplattingMesh("splat");
        expect(gs.safeOrbitCameraLimits).toBeNull();
        // Field is read/write for shape parity with @babylonjs/core.
        gs.safeOrbitCameraLimits = { radiusMin: 2, elevationMinMax: [-0.5, 0.5] };
        expect(gs.safeOrbitCameraLimits.radiusMin).toBe(2);
        expect(gs.safeOrbitCameraLimits.elevationMinMax).toEqual([-0.5, 0.5]);
    });

    it("attaches accessibility metadata to an imported splat rather than its placeholder", () => {
        const lite = fakeLiteMesh();
        const scene = { _registerMesh: () => undefined } as unknown as Scene;
        const gs = GaussianSplattingMesh._fromLite(lite, scene);

        gs.accessibilityTag = { description: "Imported cloud" };

        expect(getAccessibilityTag(lite)).toEqual({ description: "Imported cloud" });
        expect(getAccessibilityTag(gs._node)).toBeNull();
    });

    it("moves pre-load accessibility metadata from the placeholder to the adopted splat", () => {
        const gs = new GaussianSplattingMesh("splat");
        const lite = fakeLiteMesh();
        gs.accessibilityTag = { description: "Deferred cloud" };

        expect(getAccessibilityTag(gs._node)).toEqual({ description: "Deferred cloud" });

        gs._adopt(lite);

        expect(getAccessibilityTag(gs._node)).toBeNull();
        expect(getAccessibilityTag(lite)).toEqual({ description: "Deferred cloud" });
    });
});
