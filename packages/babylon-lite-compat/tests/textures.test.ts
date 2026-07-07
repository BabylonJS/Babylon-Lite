import { describe, expect, it } from "vitest";

import { resolveKtxUrl, CubeTexture, HDRCubeTexture } from "../src/textures/textures";

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

/**
 * `HDRCubeTexture` is a lightweight environment handle (like `CubeTexture`): it
 * records the `.hdr` URL and requested face size, resolves a readiness signal on a
 * microtask, and carries the `_envLoaderKind: "hdr"` marker the `Scene` reads to
 * route the environment through Lite's native `loadHdrEnvironment` at engine start.
 */
describe("HDRCubeTexture", () => {
    it("records url + size and marks itself as an HDR-loader handle", () => {
        const tex = new HDRCubeTexture("https://h/room.hdr", null, 512);
        expect(tex.url).toBe("https://h/room.hdr");
        expect(tex.name).toBe("https://h/room.hdr");
        expect(tex.size).toBe(512);
        expect(tex._envLoaderKind).toBe("hdr");
    });

    it("defaults the face size to 256", () => {
        expect(new HDRCubeTexture("https://h/room.hdr").size).toBe(256);
    });

    it("fires onLoad + onLoadObservable and flips isReady on a microtask", async () => {
        let loaded = false;
        const tex = new HDRCubeTexture("https://h/room.hdr", null, 256, false, false, false, false, () => {
            loaded = true;
        });
        expect(tex.isReady()).toBe(false);
        const observed = await new Promise<HDRCubeTexture>((resolve) => tex.onLoadObservable.add(resolve));
        expect(observed).toBe(tex);
        expect(loaded).toBe(true);
        expect(tex.isReady()).toBe(true);
    });

    it("is distinct from the plain CubeTexture loader kind", () => {
        expect(new CubeTexture("https://h/env.env")._envLoaderKind).toBe("cube");
        expect(new HDRCubeTexture("https://h/room.hdr")._envLoaderKind).toBe("hdr");
    });
});
