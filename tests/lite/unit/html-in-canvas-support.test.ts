import { afterEach, describe, expect, it, vi } from "vitest";

import {
    installHtmlInCanvasPolyfill,
    isHtmlInCanvasPolyfillInstalled,
    isHtmlInCanvasSupportedNatively,
    uninstallHtmlInCanvasPolyfill,
} from "../../../packages/babylon-lite/src/texture/html-in-canvas-support";
import {
    installHtmlInCanvasPolyfill as installFromPublicApi,
    isHtmlInCanvasSupportedNatively as queryFromPublicApi,
    uninstallHtmlInCanvasPolyfill as uninstallFromPublicApi,
} from "../../../packages/babylon-lite/src/index";

afterEach(() => {
    uninstallHtmlInCanvasPolyfill();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("HTML-in-Canvas support", () => {
    it("reports unavailable without a document", () => {
        vi.stubGlobal("document", undefined);

        expect(isHtmlInCanvasSupportedNatively()).toBe(false);
    });

    it("requires a function-valued captureElementImage capability", () => {
        const createElement = vi.fn(() => ({ captureElementImage: "present" }));
        vi.stubGlobal("document", { createElement });

        expect(isHtmlInCanvasSupportedNatively()).toBe(false);

        createElement.mockReturnValue({ captureElementImage: vi.fn() } as never);
        expect(isHtmlInCanvasSupportedNatively()).toBe(true);
    });

    it("installs, tracks, and uninstalls a supplied polyfill module", async () => {
        vi.stubGlobal("document", { createElement: () => ({}) });
        const install = vi.fn();
        const uninstall = vi.fn();

        await expect(
            installHtmlInCanvasPolyfill({ force: true, polyfillModule: { installHtmlInCanvasPolyfill: install, uninstallHtmlInCanvasPolyfill: uninstall } })
        ).resolves.toBe(true);
        expect(install).toHaveBeenCalledWith({ force: true });
        expect(isHtmlInCanvasPolyfillInstalled()).toBe(true);

        uninstallHtmlInCanvasPolyfill();
        expect(uninstall).toHaveBeenCalledOnce();
        expect(isHtmlInCanvasPolyfillInstalled()).toBe(false);
    });

    it("loads a runtime module specifier and routes diagnostics through the supplied warning hook", async () => {
        vi.stubGlobal("document", { createElement: () => ({}) });
        const warn = vi.fn();
        const moduleSpecifier = "data:text/javascript,export function installHtmlInCanvasPolyfill(){}";

        await expect(installHtmlInCanvasPolyfill({ force: true, moduleSpecifier }, warn)).resolves.toBe(true);
        expect(warn).not.toHaveBeenCalled();

        await expect(installHtmlInCanvasPolyfill({ force: true, polyfillModule: {} }, warn)).resolves.toBe(false);
        expect(warn).toHaveBeenCalledWith("HTML-in-Canvas: the polyfill module does not expose installHtmlInCanvasPolyfill; nothing was installed.");
    });

    it("exports the lifecycle through the Lite public barrel", () => {
        expect(queryFromPublicApi).toBe(isHtmlInCanvasSupportedNatively);
        expect(installFromPublicApi).toBe(installHtmlInCanvasPolyfill);
        expect(uninstallFromPublicApi).toBe(uninstallHtmlInCanvasPolyfill);
    });
});
