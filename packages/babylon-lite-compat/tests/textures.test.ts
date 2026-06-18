import { describe, expect, it } from "vitest";

import { resolveKtxUrl } from "../src/textures/textures";

/**
 * `resolveKtxUrl` recognises a pre-resolved compressed `.ktx` URL (the single
 * fully-qualified URL Babylon.js code hands `Texture` after selecting a format via
 * `engine.getCaps()`) and splits it into the `{ baseUrl, suffix }` pair Lite's
 * `loadKtxTexture2D` expects. The query string must survive onto the base URL.
 */
describe("resolveKtxUrl", () => {
    it("splits a compressed KTX URL into base image + format suffix", () => {
        expect(resolveKtxUrl("https://h/UVgrid-dxt.ktx")).toEqual({ baseUrl: "https://h/UVgrid.png", suffix: "-dxt.ktx" });
        expect(resolveKtxUrl("https://h/UVgrid-astc.ktx")).toEqual({ baseUrl: "https://h/UVgrid.png", suffix: "-astc.ktx" });
        expect(resolveKtxUrl("https://h/UVgrid-etc2.ktx")).toEqual({ baseUrl: "https://h/UVgrid.png", suffix: "-etc2.ktx" });
    });

    it("preserves a query string on the base URL (auth / cache-busting / signed URLs)", () => {
        expect(resolveKtxUrl("https://h/UVgrid-dxt.ktx?cache=1&sig=abc")).toEqual({
            baseUrl: "https://h/UVgrid.png?cache=1&sig=abc",
            suffix: "-dxt.ktx",
        });
    });

    it("returns null for non-compressed-KTX URLs", () => {
        expect(resolveKtxUrl("https://h/UVgrid.png")).toBeNull();
        expect(resolveKtxUrl("https://h/UVgrid.ktx")).toBeNull(); // no recognised format suffix
        expect(resolveKtxUrl("https://h/model.basis")).toBeNull();
    });
});
