import { afterEach, describe, expect, it, vi } from "vitest";

import { loadBrdfImage } from "../../../packages/babylon-lite/src/loader-env/env-helpers";

describe("loadBrdfImage", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("reports a clear error when an SPA fallback returns HTML for the BRDF LUT", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }))
        );

        await expect(loadBrdfImage("/brdf-lut.png")).rejects.toThrow(/BRDF LUT '\/brdf-lut\.png' is not an image \(200 text\/html/);
    });

    it("reports a clear error when the BRDF LUT is missing outright", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("not found", { status: 404, headers: { "content-type": "text/plain" } }))
        );

        await expect(loadBrdfImage("/brdf-lut.png")).rejects.toThrow(/BRDF LUT '\/brdf-lut\.png' is not an image \(404 /);
    });

    it("allows image data served with a generic binary content type", async () => {
        const image = {} as ImageBitmap;
        const createImageBitmapMock = vi.fn(async () => image);
        vi.stubGlobal("createImageBitmap", createImageBitmapMock);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "application/octet-stream" } }))
        );

        await expect(loadBrdfImage("https://cdn.example.com/brdf.png")).resolves.toBe(image);
        expect(createImageBitmapMock).toHaveBeenCalledOnce();
    });
});
