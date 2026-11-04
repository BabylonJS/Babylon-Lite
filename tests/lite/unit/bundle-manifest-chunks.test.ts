import { describe, expect, it } from "vitest";
import { diffGzipSize, diffRuntimeChunks, logicalRuntimeChunkName, rawByteDriftExceedsTolerance } from "../../../scripts/bundle-manifest-chunks";

describe("bundle manifest chunk identity", () => {
    it("ignores content-hash and ordering changes", () => {
        expect(
            diffRuntimeChunks(
                ["scene1-pbr-renderable-B314CqCv.js", "scene1.js", "scene1-wgsl-helpers-BgB2AJrF.js"],
                ["scene1-wgsl-helpers-CyYlkaX-.js", "scene1.js", "scene1-pbr-renderable-DtVfKexo.js"]
            )
        ).toBeNull();
    });

    it("reports logical runtime feature changes", () => {
        expect(diffRuntimeChunks(["scene280.js"], ["scene280.js", "scene280-npe-flow-map-runtime-DxH2I5sr.js"])).toBe("+scene280-npe-flow-map-runtime.js");
    });

    it("leaves unhashed entry names unchanged", () => {
        expect(logicalRuntimeChunkName("scene280.js")).toBe("scene280.js");
    });

    it("ignores one-KB gzip drift but reports larger movement", () => {
        expect(diffGzipSize(39.4, 39.5)).toBeNull();
        expect(diffGzipSize(39.4, 41.5)).toBe("committed gzip=39KB → rebuilt gzip=42KB");
    });

    it("ignores at most ten bytes of minifier drift", () => {
        expect(rawByteDriftExceedsTolerance(1000, 990)).toBe(false);
        expect(rawByteDriftExceedsTolerance(1000, 1010)).toBe(false);
        expect(rawByteDriftExceedsTolerance(1000, 1011)).toBe(true);
    });
});
