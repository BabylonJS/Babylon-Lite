import { describe, expect, it, vi } from "vitest";
import type { GLEngineContext, loadTexture2D as LoadTexture2D } from "@babylonjs/lite-gl";
import { createImageRenderer } from "../src/rendering/image-renderer.js";

const mocks = vi.hoisted(() => ({
    loadTexture2D: vi.fn<typeof LoadTexture2D>(() => ({ isReady: false }) as ReturnType<typeof LoadTexture2D>),
    createTexturedQuadRenderer: vi.fn(() => ({})),
}));

vi.mock("@babylonjs/lite-gl", () => ({
    disposeTexture: vi.fn(),
    loadTexture2D: mocks.loadTexture2D,
}));

vi.mock("../src/rendering/textured-quad.js", () => ({
    createTexturedQuadRenderer: mocks.createTexturedQuadRenderer,
}));

describe("image renderer errors", () => {
    it("forwards texture load failures", () => {
        const onError = vi.fn();
        createImageRenderer({} as GLEngineContext, [{ id: "image", width: 16, height: 16, src: "missing.png" }], onError);

        const callback = mocks.loadTexture2D.mock.calls[0]?.[4] as (error: Error) => void;
        callback(new Error("decode failed"));

        expect(onError).toHaveBeenCalledOnce();
    });
});
