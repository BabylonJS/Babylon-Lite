import { describe, expect, it } from "vitest";

import { captureScreenshot } from "../../../packages/babylon-lite/src/engine/screenshot";
import { createCapturePreFrame, createCaptureService } from "../../../packages/babylon-lite/src/engine/screenshot-readback";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface";

interface ConfigureCall {
    usage?: number;
}

interface Harness {
    surface: SurfaceContext;
    configureCalls: ConfigureCall[];
}

function makeHarness(): Harness {
    const configureCalls: ConfigureCall[] = [];
    const device = {
        createBuffer: () => ({ destroy: () => undefined }) as unknown as GPUBuffer,
    } as unknown as GPUDevice;
    const surface = {
        engine: { _device: device },
        _context: {
            configure: (descriptor: GPUCanvasConfiguration) => configureCalls.push({ usage: descriptor.usage }),
        } as unknown as GPUCanvasContext,
        format: "bgra8unorm",
        _alphaMode: "opaque",
        scRT: { _colorTexture: {} as GPUTexture, _width: 4, _height: 4 },
    } as unknown as SurfaceContext;
    return { surface, configureCalls };
}

describe("screenshot swapchain COPY_SRC", () => {
    it("captureScreenshot queues a request without configuring the swapchain itself", () => {
        const { surface, configureCalls } = makeHarness();

        void captureScreenshot(surface);

        expect(surface._captureQueue).toHaveLength(1);
        expect(configureCalls).toHaveLength(0);
        expect(surface._swapchainCopySrc).toBeFalsy();
    });

    it("preFrame reconfigures with COPY_SRC on the first queued capture", () => {
        const { surface, configureCalls } = makeHarness();
        surface._captureQueue = [{ resolve: () => undefined, reject: () => undefined }];
        const preFrame = createCapturePreFrame();

        preFrame(surface);

        expect(surface._swapchainCopySrc).toBe(true);
        expect(configureCalls).toHaveLength(1);
        const usage = configureCalls[0]!.usage ?? 0;
        expect(usage & GPUTextureUsage.COPY_SRC).toBeTruthy();
        expect(usage & GPUTextureUsage.RENDER_ATTACHMENT).toBeTruthy();
        // The request stays queued for the readback hook to copy this same frame.
        expect(surface._captureQueue).toHaveLength(1);
    });

    it("preFrame then service copies into the same frame and clears the queue", () => {
        const { surface, configureCalls } = makeHarness();
        surface._captureQueue = [{ resolve: () => undefined, reject: () => undefined }];
        const preFrame = createCapturePreFrame();
        const service = createCaptureService();
        let copied = 0;
        const enc = { copyTextureToBuffer: () => copied++ } as unknown as GPUCommandEncoder;

        preFrame(surface);
        service(surface, enc);

        expect(configureCalls).toHaveLength(1);
        expect(copied).toBe(1);
        expect(surface._captureQueue).toBeUndefined();
    });

    it("service waits (no copy, request stays queued) until the swapchain is copyable", () => {
        const { surface } = makeHarness();
        surface._captureQueue = [{ resolve: () => undefined, reject: () => undefined }];
        let copied = 0;
        const enc = { copyTextureToBuffer: () => copied++ } as unknown as GPUCommandEncoder;
        const service = createCaptureService();

        service(surface, enc);

        expect(copied).toBe(0);
        expect(surface._captureQueue).toHaveLength(1);
    });

    it("copies and clears the queue once the swapchain is already copyable", () => {
        const { surface } = makeHarness();
        surface._swapchainCopySrc = true;
        surface._captureQueue = [{ resolve: () => undefined, reject: () => undefined }];
        let copied = 0;
        const enc = { copyTextureToBuffer: () => copied++ } as unknown as GPUCommandEncoder;
        const service = createCaptureService();

        service(surface, enc);

        expect(copied).toBe(1);
        expect(surface._captureQueue).toBeUndefined();
    });

    it("preFrame never reconfigures again on later frames", () => {
        const { surface, configureCalls } = makeHarness();
        surface._swapchainCopySrc = true;
        surface._captureQueue = [{ resolve: () => undefined, reject: () => undefined }];
        const preFrame = createCapturePreFrame();

        preFrame(surface);

        expect(configureCalls).toHaveLength(0);
    });
});
