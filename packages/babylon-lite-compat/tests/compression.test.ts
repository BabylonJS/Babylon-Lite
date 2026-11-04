import { describe, expect, it } from "vitest";

import { MeshoptCompression } from "../src/meshes/compression";

/**
 * `MeshoptCompression` is a no-op compatibility shim: Babylon Lite's glTF loader
 * decodes `EXT_meshopt_compression` itself, so the only behaviour to verify is
 * that ported code can read/write the static `Configuration` and obtain the
 * `Default` singleton without error.
 */
describe("MeshoptCompression shim", () => {
    it("accepts a Configuration assignment (no-op) and reads it back", () => {
        MeshoptCompression.Configuration = { decoder: { url: "/meshopt_decoder.js" } };
        expect(MeshoptCompression.Configuration.decoder.url).toBe("/meshopt_decoder.js");
    });

    it("exposes a stable Default singleton", () => {
        const a = MeshoptCompression.Default;
        const b = MeshoptCompression.Default;
        expect(a).toBeInstanceOf(MeshoptCompression);
        expect(a).toBe(b);
    });
});
