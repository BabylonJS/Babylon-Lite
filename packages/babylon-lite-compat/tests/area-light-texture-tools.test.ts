import { beforeEach, describe, expect, it, vi } from "vitest";

const liteMocks = vi.hoisted(() => ({
    processAreaLightTexture: vi.fn(),
    releaseTexture: vi.fn(),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return { ...actual, ...liteMocks };
});

import type { Texture2D } from "babylon-lite";

import { AreaLightTextureTools } from "../src/lights/area-light-texture-tools";
import type { AbstractEngine } from "../src/engine/engine";
import { ShaderLanguage } from "../src/misc/engine-constants";
import { BaseTexture } from "../src/textures/textures";

class ReadyTexture extends BaseTexture {
    public constructor(texture?: Texture2D) {
        super();
        this._lite = texture;
    }

    public whenReadyAsync(): Promise<void> {
        return Promise.resolve();
    }
}

describe("AreaLightTextureTools", () => {
    beforeEach(() => {
        liteMocks.processAreaLightTexture.mockReset();
        liteMocks.releaseTexture.mockReset();
    });

    it("forwards processing to Lite and wraps the resulting texture", async () => {
        const engine = { _lite: { label: "engine" } } as unknown as AbstractEngine;
        const sourceHandle = { width: 4, height: 4 } as Texture2D;
        const processedHandle = { width: 1024, height: 1024 } as Texture2D;
        liteMocks.processAreaLightTexture.mockResolvedValue(processedHandle);
        const tools = new AreaLightTextureTools(engine);

        expect(tools.shaderLanguage).toBe(ShaderLanguage.GLSL);
        expect(tools.isReady()).toBe(false);
        const processed = await tools.processAsync(new ReadyTexture(sourceHandle));

        expect(tools.shaderLanguage).toBe(ShaderLanguage.WGSL);
        expect(tools.isReady()).toBe(true);
        expect(liteMocks.processAreaLightTexture).toHaveBeenCalledWith(engine._lite, sourceHandle);
        expect(processed?._lite).toBe(processedHandle);
        if (!processed) {
            throw new Error("Expected a processed area-light texture.");
        }
        await expect(processed.whenReadyAsync()).resolves.toBeUndefined();
        processed.dispose();
        processed.dispose();
        expect(liteMocks.releaseTexture).toHaveBeenCalledTimes(1);
        expect(liteMocks.releaseTexture).toHaveBeenCalledWith(processedHandle);
        expect(processed._lite).toBeUndefined();
    });

    it("returns null when the source has no Lite texture handle", async () => {
        const tools = new AreaLightTextureTools({ _lite: {} } as unknown as AbstractEngine);

        await expect(tools.processAsync(new ReadyTexture())).resolves.toBeNull();
        expect(liteMocks.processAreaLightTexture).not.toHaveBeenCalled();
    });
});
