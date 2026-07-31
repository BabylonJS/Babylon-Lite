import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadEnvironmentMock } = vi.hoisted(() => ({
    loadEnvironmentMock: vi.fn<() => Promise<void>>(),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        loadEnvironment: loadEnvironmentMock,
    };
});

import { NullEngine } from "../src/engine/engine";
import { Scene } from "../src/scene/scene";
import { BRDF_LUT_DATA_URL } from "../src/scene/brdf-lut-data";

describe("compat scene environment", () => {
    beforeEach(() => {
        loadEnvironmentMock.mockReset();
        loadEnvironmentMock.mockResolvedValue();
    });

    // Babylon.js resolves the BRDF LUT from an embedded Base64 texture, so ported apps
    // must not need to serve a `/brdf-lut.png` asset (a missing one is answered with a
    // 200 HTML page by SPA dev servers, which then fails to decode).
    it("uses the embedded BRDF LUT rather than fetching a URL", async () => {
        const scene = new Scene(new NullEngine());
        scene.createDefaultEnvironment({ createSkybox: false, createGround: false });

        await scene._loadPendingEnvironment();

        expect(loadEnvironmentMock).toHaveBeenCalledWith(
            scene._lite,
            "https://assets.babylonjs.com/environments/environmentSpecular.env",
            expect.objectContaining({ brdfUrl: BRDF_LUT_DATA_URL })
        );
    });

    it("uses the embedded BRDF LUT when only environmentTexture is assigned", async () => {
        const scene = new Scene(new NullEngine());
        scene.environmentTexture = { url: "https://example.com/env.env" } as never;

        await scene._loadPendingEnvironment();

        expect(loadEnvironmentMock).toHaveBeenCalledWith(scene._lite, "https://example.com/env.env", expect.objectContaining({ brdfUrl: BRDF_LUT_DATA_URL }));
    });

    // Babylon.js lets apps swap the LUT via `scene.environmentBRDFTexture`; that is the
    // supported override, rather than a Lite-specific option on createDefaultEnvironment.
    it("honours an environmentBRDFTexture override", async () => {
        const scene = new Scene(new NullEngine());
        scene.createDefaultEnvironment({ createSkybox: false, createGround: false });
        scene.environmentBRDFTexture = { name: "https://assets.babylonjs.com/environments/correlatedMSBRDF_RGBD.png" } as never;

        await scene._loadPendingEnvironment();

        expect(loadEnvironmentMock).toHaveBeenCalledWith(
            scene._lite,
            "https://assets.babylonjs.com/environments/environmentSpecular.env",
            expect.objectContaining({ brdfUrl: "https://assets.babylonjs.com/environments/correlatedMSBRDF_RGBD.png" })
        );
    });

    it("falls back to the built-in LUT, with a warning, for a DDS BRDF texture", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const scene = new Scene(new NullEngine());
        scene.createDefaultEnvironment({ createSkybox: false, createGround: false });
        scene.environmentBRDFTexture = { name: "https://assets.babylonjs.com/environments/correlatedMSBRDF.dds" } as never;

        await scene._loadPendingEnvironment();

        expect(warn).toHaveBeenCalledWith(expect.stringContaining("cannot read DDS"));
        expect(loadEnvironmentMock).toHaveBeenCalledWith(scene._lite, expect.any(String), expect.objectContaining({ brdfUrl: BRDF_LUT_DATA_URL }));
        warn.mockRestore();
    });

    it("detects a DDS BRDF texture through a query string", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const scene = new Scene(new NullEngine());
        scene.createDefaultEnvironment({ createSkybox: false, createGround: false });
        scene.environmentBRDFTexture = { name: "https://cdn.example.com/correlatedMSBRDF.dds?v=2#lut" } as never;

        await scene._loadPendingEnvironment();

        expect(warn).toHaveBeenCalledWith(expect.stringContaining("cannot read DDS"));
        expect(loadEnvironmentMock).toHaveBeenCalledWith(scene._lite, expect.any(String), expect.objectContaining({ brdfUrl: BRDF_LUT_DATA_URL }));
        warn.mockRestore();
    });

    // A procedural texture (`RawTexture`, `DynamicTexture`) has no source URL, and its empty
    // `name` would otherwise resolve to a fetch of the page itself.
    it("falls back to the built-in LUT, with a warning, for a texture with no source URL", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const scene = new Scene(new NullEngine());
        scene.createDefaultEnvironment({ createSkybox: false, createGround: false });
        scene.environmentBRDFTexture = { name: "  ", getClassName: () => "RawTexture" } as never;

        await scene._loadPendingEnvironment();

        expect(warn).toHaveBeenCalledWith(expect.stringContaining("RawTexture has no source URL"));
        expect(loadEnvironmentMock).toHaveBeenCalledWith(scene._lite, expect.any(String), expect.objectContaining({ brdfUrl: BRDF_LUT_DATA_URL }));
        warn.mockRestore();
    });

    it("defaults environmentBRDFTexture to null", () => {
        expect(new Scene(new NullEngine()).environmentBRDFTexture).toBeNull();
    });
});
