import { describe, it, expect, vi, afterEach } from "vitest";

import { isWebXrPresent, isWebGpuXrSupported, isXrSessionSupported } from "../../../../packages/babylon-lite/src/xr/xr-support";

describe("xr-support feature detection", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("isWebXrPresent reflects navigator.xr", () => {
        vi.stubGlobal("navigator", {});
        expect(isWebXrPresent()).toBe(false);
        vi.stubGlobal("navigator", { xr: {} });
        expect(isWebXrPresent()).toBe(true);
    });

    it("isWebGpuXrSupported reflects the draft XRGPUBinding global", () => {
        vi.stubGlobal("XRGPUBinding", undefined);
        expect(isWebGpuXrSupported()).toBe(false);
        vi.stubGlobal("XRGPUBinding", class {});
        expect(isWebGpuXrSupported()).toBe(true);
    });

    it("isXrSessionSupported returns false when WebXR is absent", async () => {
        vi.stubGlobal("navigator", {});
        vi.stubGlobal("XRGPUBinding", class {});
        expect(await isXrSessionSupported("immersive-vr")).toBe(false);
    });

    it("isXrSessionSupported returns false when the WebGPU binding is absent", async () => {
        vi.stubGlobal("navigator", { xr: { isSessionSupported: async () => true } });
        vi.stubGlobal("XRGPUBinding", undefined);
        expect(await isXrSessionSupported("immersive-vr")).toBe(false);
    });

    it("isXrSessionSupported defers to navigator.xr.isSessionSupported when both present", async () => {
        vi.stubGlobal("XRGPUBinding", class {});
        vi.stubGlobal("navigator", { xr: { isSessionSupported: async (m: string) => m === "immersive-vr" } });
        expect(await isXrSessionSupported("immersive-vr")).toBe(true);
        expect(await isXrSessionSupported("immersive-ar")).toBe(false);
    });

    it("isXrSessionSupported never throws (returns false on rejection)", async () => {
        vi.stubGlobal("XRGPUBinding", class {});
        vi.stubGlobal("navigator", {
            xr: {
                isSessionSupported: async () => {
                    throw new Error("boom");
                },
            },
        });
        expect(await isXrSessionSupported("immersive-vr")).toBe(false);
    });
});
