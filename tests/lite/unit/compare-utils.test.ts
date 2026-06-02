import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { Browser } from "@playwright/test";
import { captureGolden } from "../parity/compare-utils";

function makeBrowserSpy(): { browser: Browser; screenshotCalls: () => number } {
    let screenshotCount = 0;
    const page = {
        goto: async () => undefined,
        waitForFunction: async () => undefined,
        waitForTimeout: async () => undefined,
        addStyleTag: async () => undefined,
        locator: () => ({
            screenshot: async () => {
                screenshotCount++;
            },
        }),
        close: async () => undefined,
    };
    const context = {
        newPage: async () => page,
        close: async () => undefined,
    };
    const browser = {
        newContext: async () => context,
    } satisfies Partial<Browser>;

    return {
        browser: browser as Browser,
        screenshotCalls: () => screenshotCount,
    };
}

describe("captureGolden", () => {
    it("skips capture when a golden already exists", async () => {
        const goldenPath = path.resolve(__dirname, "../../../reference/lite/scene79-nme-modes/babylon-ref-golden.png");
        expect(fs.existsSync(goldenPath)).toBe(true);

        const spy = makeBrowserSpy();
        await captureGolden(spy.browser, { sceneId: 79 });

        expect(spy.screenshotCalls()).toBe(0);
    });

    it("recaptures when force is set, even if a golden already exists", async () => {
        const goldenPath = path.resolve(__dirname, "../../../reference/lite/scene79-nme-modes/babylon-ref-golden.png");
        expect(fs.existsSync(goldenPath)).toBe(true);

        const spy = makeBrowserSpy();
        const opts = { sceneId: 79, force: true };
        await captureGolden(spy.browser, opts);

        expect(spy.screenshotCalls()).toBe(1);
    });
});
