import { describe, expect, it } from "vitest";
import { diffRuntimeChunks, logicalRuntimeChunkName } from "../../../scripts/bundle-manifest-chunks";

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
});
