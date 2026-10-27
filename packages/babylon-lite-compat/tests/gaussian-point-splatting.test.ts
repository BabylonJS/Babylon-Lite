import { beforeEach, describe, expect, it, vi } from "vitest";

const pointMocks = vi.hoisted(() => ({
    enable: vi.fn(),
    disable: vi.fn(),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        enableGaussianPointSplatting: pointMocks.enable,
        disableGaussianPointSplatting: pointMocks.disable,
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

        mesh.pointSplattingRenderScale = 2;
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
        expect(pointMocks.enable).toHaveBeenLastCalledWith(
            liteScene,
            lite,
            expect.objectContaining({ colorRenderMode: true, depthRenderMode: true })
        );

        mesh.pointSplattingScale = 2;
        mesh.pointSplattingRenderScale = 3;
        mesh.pointSplattingOcclusionCulling = false;
        expect(handle.pointScale).toBe(2);
        expect(handle.renderScale).toBe(3);
        expect(handle.occlusionCulling).toBe(false);
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
