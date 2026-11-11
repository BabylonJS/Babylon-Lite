import { beforeEach, describe, expect, it, vi } from "vitest";

const liteMocks = vi.hoisted(() => ({
    isHtmlInCanvasPolyfillInstalled: vi.fn(),
    isHtmlInCanvasSupportedNatively: vi.fn(),
    installHtmlInCanvasPolyfill: vi.fn(),
    uninstallHtmlInCanvasPolyfill: vi.fn(),
}));

vi.mock("babylon-lite", () => liteMocks);

import { IsHtmlInCanvasSupportedNatively, _IsHtmlInCanvasPolyfillInstalled, InstallHtmlInCanvasPolyfill, UninstallHtmlInCanvasPolyfill } from "../src/textures/html-in-canvas";
import { Logger } from "../src/misc/misc-utils";

describe("IsHtmlInCanvasSupportedNatively", () => {
    beforeEach(() => {
        liteMocks.isHtmlInCanvasSupportedNatively.mockReset();
    });

    it("forwards the capability query to Babylon Lite", () => {
        liteMocks.isHtmlInCanvasSupportedNatively.mockReturnValue(true);

        expect(IsHtmlInCanvasSupportedNatively()).toBe(true);
        expect(liteMocks.isHtmlInCanvasSupportedNatively).toHaveBeenCalledOnce();
    });

    it("forwards installer lifecycle calls and options to Babylon Lite", async () => {
        const module = { installHtmlInCanvasPolyfill: vi.fn(), uninstallHtmlInCanvasPolyfill: vi.fn() };
        liteMocks.isHtmlInCanvasPolyfillInstalled.mockReturnValue(true);
        liteMocks.installHtmlInCanvasPolyfill.mockResolvedValue(true);
        const warn = vi.spyOn(Logger, "Warn").mockImplementation(() => undefined);

        expect(_IsHtmlInCanvasPolyfillInstalled()).toBe(true);
        await expect(InstallHtmlInCanvasPolyfill({ force: true, polyfillModule: module })).resolves.toBe(true);
        UninstallHtmlInCanvasPolyfill();

        expect(liteMocks.installHtmlInCanvasPolyfill).toHaveBeenCalledWith({ force: true, polyfillModule: module }, expect.any(Function));
        const warningForwarder = liteMocks.installHtmlInCanvasPolyfill.mock.calls[0]![1];
        warningForwarder("warning");
        expect(warn).toHaveBeenCalledWith("warning");
        expect(liteMocks.uninstallHtmlInCanvasPolyfill).toHaveBeenCalledOnce();
    });
});
