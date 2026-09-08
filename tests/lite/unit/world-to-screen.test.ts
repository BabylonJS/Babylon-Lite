import { describe, expect, it } from "vitest";

import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import { getEffectiveAspectRatio, getViewMatrix, getViewProjectionMatrix } from "../../../packages/babylon-lite/src/camera/camera";
import { enableOrthographicCamera } from "../../../packages/babylon-lite/src/camera/orthographic";
import { resolveCameraViewport, type PixelViewport } from "../../../packages/babylon-lite/src/camera/viewport";
import {
    projectWorldToScreen,
    projectWorldToScreenToRef,
    type ScreenProjectionOptions,
    type ScreenProjectionResult,
} from "../../../packages/babylon-lite/src/camera/world-to-screen";

const BACKING_WIDTH = 800;
const BACKING_HEIGHT = 600;

function result(): ScreenProjectionResult {
    return {
        x: -1,
        y: -1,
        z: -1,
        cssX: -1,
        cssY: -1,
        clipW: -1,
        behindCamera: true,
        clipped: true,
        offscreen: true,
    };
}

function setup(viewport?: PixelViewport) {
    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
    const options: ScreenProjectionOptions = {
        viewport: viewport ?? { x: 0, y: 0, width: BACKING_WIDTH, height: BACKING_HEIGHT },
        backingWidth: BACKING_WIDTH,
        backingHeight: BACKING_HEIGHT,
        cssWidth: 400,
        cssHeight: 300,
    };
    const aspect = options.viewport.width / options.viewport.height;
    return {
        camera,
        options,
        project(point: { x: number; y: number; z: number }): ScreenProjectionResult {
            return projectWorldToScreen(point, getViewMatrix(camera), getViewProjectionMatrix(camera, aspect), options);
        },
    };
}

describe("world-to-screen projection", () => {
    it("maps a camera-forward point to canvas and CSS center", () => {
        const { project } = setup();

        expect(project({ x: 0, y: 0, z: 0 })).toMatchObject({
            x: 400,
            y: 300,
            cssX: 200,
            cssY: 150,
            behindCamera: false,
            clipped: false,
            offscreen: false,
        });
    });

    it("applies non-full backing-pixel viewport offsets before CSS scaling", () => {
        const { project } = setup({ x: 200, y: 150, width: 400, height: 300 });

        expect(project({ x: 0, y: 0, z: 0 })).toMatchObject({
            x: 400,
            y: 300,
            cssX: 200,
            cssY: 150,
        });
    });

    it("derives the active normalized camera viewport with existing public helpers", () => {
        const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 10, { x: 0, y: 0, z: 0 });
        camera.viewport = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
        const viewport = resolveCameraViewport(camera, BACKING_WIDTH, BACKING_HEIGHT);
        const aspect = getEffectiveAspectRatio(camera, BACKING_WIDTH, BACKING_HEIGHT);

        const projected = projectWorldToScreen({ x: 0, y: 0, z: 0 }, getViewMatrix(camera), getViewProjectionMatrix(camera, aspect), {
            viewport,
            backingWidth: BACKING_WIDTH,
            backingHeight: BACKING_HEIGHT,
        });

        expect(viewport).toEqual({ x: 200, y: 150, width: 400, height: 300 });
        expect(projected).toMatchObject({ x: 400, y: 300, cssX: 400, cssY: 300 });
    });

    it("identifies a perspective point behind the camera", () => {
        const { project } = setup();

        expect(project({ x: 0, y: 0, z: -20 })).toMatchObject({
            behindCamera: true,
            clipped: true,
            offscreen: true,
        });
    });

    it("identifies an orthographic point behind the camera despite clip W remaining one", () => {
        const { camera, options } = setup();
        enableOrthographicCamera(camera, { halfHeight: 5 });

        const projected = projectWorldToScreen({ x: 0, y: 0, z: -20 }, getViewMatrix(camera), getViewProjectionMatrix(camera, 4 / 3), options);

        expect(projected.clipW).toBe(1);
        expect(projected).toMatchObject({
            behindCamera: true,
            clipped: true,
            offscreen: true,
        });
    });

    it("retains extrapolated coordinates for finite XY-offscreen points", () => {
        const { project } = setup();
        const projected = project({ x: 100, y: 0, z: 0 });

        expect(projected.x).toBeGreaterThan(BACKING_WIDTH);
        expect(projected.cssX).toBeGreaterThan(400);
        expect(projected).toMatchObject({
            behindCamera: false,
            clipped: true,
            offscreen: true,
        });
    });

    it("distinguishes depth-only clipping from XY offscreen behavior", () => {
        const { project } = setup();
        const projected = project({ x: 0, y: 0, z: -9.95 });

        expect(projected.z).toBeGreaterThan(1);
        expect(projected).toMatchObject({
            behindCamera: false,
            clipped: true,
            offscreen: false,
        });
    });

    it("writes NaN coordinates and non-displayable flags when clip W is zero", () => {
        const { camera, options } = setup();
        const projected = projectWorldToScreen({ x: 0, y: 0, z: -10 }, getViewMatrix(camera), getViewProjectionMatrix(camera, 4 / 3), options);

        expect(projected.clipW).toBeCloseTo(0, 10);
        expect(projected.x).toBeNaN();
        expect(projected.y).toBeNaN();
        expect(projected.z).toBeNaN();
        expect(projected.cssX).toBeNaN();
        expect(projected.cssY).toBeNaN();
        expect(projected.clipped).toBe(true);
        expect(projected.offscreen).toBe(true);
    });

    it("reuses and fully overwrites the supplied result", () => {
        const { camera, options } = setup();
        const target = result();

        const returned = projectWorldToScreenToRef({ x: 0, y: 0, z: 0 }, getViewMatrix(camera), getViewProjectionMatrix(camera, 4 / 3), options, target);

        expect(returned).toBe(target);
        expect(target).toMatchObject({
            x: 400,
            y: 300,
            cssX: 200,
            cssY: 150,
            behindCamera: false,
            clipped: false,
            offscreen: false,
        });
    });

    it("rejects invalid backing, viewport, and partial CSS dimensions", () => {
        const { camera, options } = setup();
        const view = getViewMatrix(camera);
        const viewProjection = getViewProjectionMatrix(camera, 4 / 3);
        const point = { x: 0, y: 0, z: 0 };

        expect(() => projectWorldToScreen(point, view, viewProjection, { ...options, backingWidth: 0 })).toThrow(RangeError);
        expect(() => projectWorldToScreen(point, view, viewProjection, { ...options, viewport: { ...options.viewport, height: Number.NaN } })).toThrow(RangeError);
        expect(() => projectWorldToScreen(point, view, viewProjection, { ...options, cssHeight: undefined })).toThrow(RangeError);
    });
});
