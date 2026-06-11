import { describe, expect, it } from "vitest";

import { captureScreenshot } from "../../../packages/babylon-lite/src/engine/screenshot";
import { createCaptureService } from "../../../packages/babylon-lite/src/engine/screenshot-readback";
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

const encoder = { copyTextureToBuffer: () => undefined } as unknown as GPUCommandEncoder;

describe("screenshot swapchain COPY_SRC", () => {
    it("captureScreenshot queues a request without configuring the swapchain itself", () => {
        const { surface, configureCalls } = makeHarness();

        void captureScreenshot(surface);

        expect(surface._captureQueue).toHaveLength(1);
        expect(configureCalls).toHaveLength(0);
        expect(surface._swapchainCopySrc).toBeFalsy();
    });

    it("first serviced frame reconfigures with COPY_SRC and defers the copy", () => {
        const { surface, configureCalls } = makeHarness();
        surface._captureQueue = [{ resolve: () => undefined, reject: () => undefined }];
        const service = createCaptureService();

        service(surface, encoder);

        expect(surface._swapchainCopySrc).toBe(true);
        expect(configureCalls).toHaveLength(1);
        const usage = configureCalls[0]!.usage ?? 0;
        expect(usage & GPUTextureUsage.COPY_SRC).toBeTruthy();
        expect(usage & GPUTextureUsage.RENDER_ATTACHMENT).toBeTruthy();
        // Copy deferred — the request is still queued for the next frame.
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

    it("never reconfigures again on later frames", () => {
        const { surface, configureCalls } = makeHarness();
        surface._swapchainCopySrc = true;
        surface._captureQueue = [{ resolve: () => undefined, reject: () => undefined }];
        const service = createCaptureService();

        service(surface, encoder);

        expect(configureCalls).toHaveLength(0);
    });
});
