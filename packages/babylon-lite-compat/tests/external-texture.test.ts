import { describe, expect, it } from "vitest";

import { ExternalTexture } from "../src/textures/external-texture";

describe("ExternalTexture", () => {
    it("wraps a caller-owned video with the exact BJS value-object surface", () => {
        const video = { readyState: 2, HAVE_CURRENT_DATA: 2 } as HTMLVideoElement;
        const texture = new ExternalTexture(video);

        expect(texture.getClassName()).toBe("ExternalTexture");
        expect(texture.underlyingResource).toBe(video);
        expect(texture.useMipMaps).toBe(false);
        expect(texture.type).toBe(16);
        expect(texture.format).toBe(0xffffffff);
        expect(texture.isReady()).toBe(true);
        expect(ExternalTexture.IsExternalTexture(texture)).toBe(true);
        expect(ExternalTexture.IsExternalTexture({ underlyingResource: video })).toBe(true);
        expect(ExternalTexture.IsExternalTexture({ underlyingResource: undefined })).toBe(false);
        expect(texture.dispose()).toBeUndefined();
    });
});
