import { afterEach, describe, expect, it, vi } from "vitest";
import { getMeshoptDecoder } from "../../../packages/babylon-lite/src/loader-gltf/meshopt-decode";

describe("meshopt decoder loading", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("loads the decoder from the Babylon CDN by default", async () => {
        const script = {
            src: "",
            onload: null as (() => void) | null,
            onerror: null as (() => void) | null,
            remove: vi.fn(),
        };
        const decoder = {
            ready: Promise.resolve(),
            decodeGltfBuffer: vi.fn(),
        };

        vi.stubGlobal("document", {
            createElement: vi.fn(() => script),
            head: {
                appendChild: vi.fn(() => {
                    vi.stubGlobal("MeshoptDecoder", decoder);
                    script.onload?.();
                }),
            },
        });

        await getMeshoptDecoder();

        expect(script.src).toBe("https://cdn.babylonjs.com/meshopt_decoder.js");
    });
});
