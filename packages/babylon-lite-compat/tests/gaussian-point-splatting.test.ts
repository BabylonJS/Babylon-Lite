import { beforeEach, describe, expect, it, vi } from "vitest";

const pointMocks = vi.hoisted(() => ({
    enable: vi.fn(),
    disable: vi.fn(),
    loadSplat: vi.fn(),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        enableGaussianPointSplatting: pointMocks.enable,
        disableGaussianPointSplatting: pointMocks.disable,
        loadSplat: pointMocks.loadSplat,
    };
});

import { createTransformNode } from "babylon-lite";
import type { GaussianPointSplatting, GaussianSplattingMesh as LiteGaussianSplattingMesh } from "babylon-lite";

import { GaussianSplattingMesh } from "../src/meshes/gaussian-splatting";
import type { Scene } from "../src/scene/scene";

describe("GaussianSplattingMesh point mode", () => {
    const liteScene = {};
    let handle: GaussianPointSplatting;

    beforeEach(() => {
        pointMocks.enable.mockReset();
        pointMocks.disable.mockReset();
        pointMocks.loadSplat.mockReset();
        handle = {
            colorRenderMode: true,
            depthRenderMode: false,
            depthVisualization: "none",
            pointScale: 1,
            renderScale: "auto",
            occlusionCulling: false,
            maxAccumFrames: 255,
            temporalReprojection: false,
            progress: null,
        } as GaussianPointSplatting;
        pointMocks.enable.mockReturnValue(handle);
    });

    it("forwards BJS point-mode options to Lite and keeps live option updates", () => {
        const lite = createTransformNode("cloud") as unknown as LiteGaussianSplattingMesh;
        const scene = { _lite: liteScene, _registerMesh: () => undefined } as unknown as Scene;
        const mesh = GaussianSplattingMesh._fromLite(lite, scene);

        mesh.pointSplattingRenderScale = 0.5;
        mesh.pointSplattingOcclusionCulling = true;
        mesh.pointSplattingScale = 1.5;
        mesh.pointSplattingRenderMode = true;

        expect(pointMocks.enable).toHaveBeenCalledWith(liteScene, lite, {
            colorRenderMode: true,
            depthRenderMode: false,
            pointScale: 1.5,
            renderScale: 2,
            occlusionCulling: true,
        });

        mesh.pointSplattingDepthRenderMode = true;
        expect(pointMocks.enable).toHaveBeenLastCalledWith(liteScene, lite, expect.objectContaining({ colorRenderMode: true, depthRenderMode: true }));

        mesh.pointSplattingScale = 2;
        mesh.pointSplattingRenderScale = 0.25;
        mesh.pointSplattingOcclusionCulling = false;
        expect(handle.pointScale).toBe(2);
        expect(handle.renderScale).toBe(4);
        expect(mesh.pointSplattingRenderScale).toBe(0.25);
        expect(handle.occlusionCulling).toBe(false);
    });

    it("accepts only render scales that Lite can represent exactly", () => {
        const lite = createTransformNode("cloud") as unknown as LiteGaussianSplattingMesh;
        const scene = { _lite: liteScene, _registerMesh: () => undefined } as unknown as Scene;
        const mesh = GaussianSplattingMesh._fromLite(lite, scene);

        mesh.pointSplattingRenderScale = 1;
        mesh.pointSplattingRenderMode = true;
        expect(pointMocks.enable).toHaveBeenLastCalledWith(liteScene, lite, expect.objectContaining({ renderScale: 1 }));

        mesh.pointSplattingRenderScale = 0.125;
        expect(handle.renderScale).toBe(8);

        expect(() => {
            mesh.pointSplattingRenderScale = 0.75;
        }).toThrow(RangeError);
        expect(mesh.pointSplattingRenderScale).toBe(0.125);
        expect(handle.renderScale).toBe(8);

        expect(() => {
            mesh.pointSplattingRenderScale = 0.1;
        }).toThrow(RangeError);
        expect(() => {
            mesh.pointSplattingRenderScale = 2;
        }).toThrow(RangeError);
    });

    it("rejects an unrepresentable render scale before initialization", () => {
        const lite = createTransformNode("cloud") as unknown as LiteGaussianSplattingMesh;
        const scene = { _lite: liteScene, _registerMesh: () => undefined } as unknown as Scene;
        const mesh = GaussianSplattingMesh._fromLite(lite, scene);

        expect(() => {
            mesh.pointSplattingRenderScale = 0.75;
        }).toThrow(/reciprocal of an integer from 1 through 8/);
        expect(mesh.pointSplattingRenderScale).toBe("auto");
        expect(pointMocks.enable).not.toHaveBeenCalled();
    });

    it("disables Lite point rendering once both BJS modes are off", () => {
        const lite = createTransformNode("cloud") as unknown as LiteGaussianSplattingMesh;
        const scene = { _lite: liteScene, _registerMesh: () => undefined } as unknown as Scene;
        const mesh = GaussianSplattingMesh._fromLite(lite, scene);

        mesh.pointSplattingRenderMode = true;
        mesh.pointSplattingDepthRenderMode = true;
        mesh.pointSplattingRenderMode = false;
        expect(pointMocks.disable).not.toHaveBeenCalled();

        mesh.pointSplattingDepthRenderMode = false;
        expect(pointMocks.disable).toHaveBeenCalledWith(liteScene, handle);
    });

    it("releases the previous renderer when repeated loading adopts a new splat", async () => {
        const firstLite = createTransformNode("first") as unknown as LiteGaussianSplattingMesh;
        const secondLite = createTransformNode("second") as unknown as LiteGaussianSplattingMesh;
        const firstHandle = { ...handle } as GaussianPointSplatting;
        const secondHandle = { ...handle } as GaussianPointSplatting;
        pointMocks.loadSplat.mockResolvedValueOnce(firstLite).mockResolvedValueOnce(secondLite);
        pointMocks.enable.mockReturnValueOnce(firstHandle).mockReturnValueOnce(secondHandle);
        const scene = { _lite: liteScene, _registerMesh: () => undefined } as unknown as Scene;
        const mesh = new GaussianSplattingMesh("cloud", null, scene);
        mesh.pointSplattingRenderMode = true;

        await mesh.loadFileAsync("first.splat");
        await mesh.loadFileAsync("second.splat");

        expect(pointMocks.disable).toHaveBeenCalledWith(liteScene, firstHandle);
        mesh.pointSplattingRenderMode = false;
        expect(pointMocks.disable).toHaveBeenLastCalledWith(liteScene, secondHandle);
    });

    it("disposes the current renderer after repeated loading", async () => {
        const firstLite = createTransformNode("first") as unknown as LiteGaussianSplattingMesh;
        const secondLite = createTransformNode("second") as unknown as LiteGaussianSplattingMesh;
        const firstHandle = { ...handle } as GaussianPointSplatting;
        const secondHandle = { ...handle } as GaussianPointSplatting;
        pointMocks.loadSplat.mockResolvedValueOnce(firstLite).mockResolvedValueOnce(secondLite);
        pointMocks.enable.mockReturnValueOnce(firstHandle).mockReturnValueOnce(secondHandle);
        const scene = { _lite: liteScene, _registerMesh: () => undefined, _unregisterNode: () => undefined } as unknown as Scene;
        const mesh = new GaussianSplattingMesh("cloud", null, scene);
        mesh.pointSplattingRenderMode = true;

        await mesh.loadFileAsync("first.splat");
        await mesh.loadFileAsync("second.splat");
        mesh.dispose();

        expect(pointMocks.disable).toHaveBeenNthCalledWith(1, liteScene, firstHandle);
        expect(pointMocks.disable).toHaveBeenNthCalledWith(2, liteScene, secondHandle);
    });

    it("maps Lite progress to the exact Babylon.js public shape", () => {
        const lite = createTransformNode("cloud") as unknown as LiteGaussianSplattingMesh;
        const scene = { _lite: liteScene, _registerMesh: () => undefined } as unknown as Scene;
        const mesh = GaussianSplattingMesh._fromLite(lite, scene);
        handle = {
            ...handle,
            progress: {
                renderedFrameCount: 17,
                accumulatedSamples: 4,
                accumulationVersion: 3,
                pixelCycleLength: 4,
            },
        } as GaussianPointSplatting;
        pointMocks.enable.mockReturnValue(handle);

        mesh.pointSplattingRenderMode = true;

        expect(mesh.pointSplattingProgress).toEqual({
            renderedFrameCount: 17,
            accumulationVersion: 3,
            pixelCycleLength: 4,
        });
    });
});
