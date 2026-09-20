import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("ShaderMaterial vertex support module isolation", () => {
    it("keeps the synchronous storage/format opt-in independent of lazy Shader implementation modules", () => {
        const vb = source("packages/babylon-lite/src/material/shader/shader-vb.ts");
        expect(vb).not.toMatch(/from "\.\/shader-(?:pipeline|renderable)\.js"/);
        expect(vb).toContain('from "./shader-vb-support.js"');
        expect(vb).not.toContain('from "../../mesh/mesh-indexed-draw.js"');
        expect(vb).not.toContain('from "../../mesh/mesh-indexed-indirect.js"');
        expect(vb).not.toContain("drawIndexed");
        expect(vb).not.toContain("_getVertexDefaultBuffer");
        expect(vb).not.toContain("_vertexDefaults");
    });

    it("imports split mesh operations directly from the thin-instance path", () => {
        const thin = source("packages/babylon-lite/src/material/shader/shader-thin-instance.ts");
        expect(thin).not.toContain('from "../../mesh/mesh-indexed-draw.js"');
        expect(thin).toContain("pass.drawIndexed(gpu.indexCount, ti.count, 0, gpu._baseVertex)");
        expect(thin).not.toContain('from "../../mesh/mesh-vertex-buffer-layout.js"');
        expect(thin).not.toContain('from "../../mesh/mesh-vertex-layout.js"');
        const renderable = source("packages/babylon-lite/src/material/shader/shader-renderable.ts");
        expect(renderable).toContain("pass.drawIndexed(gpu.indexCount, 1, 0, gpu._baseVertex)");
        expect(renderable).toContain("engine._getVertexDefaultBuffer?.(gpu)");
        expect(thin).toContain("vertexLayout?._vbs ?? bindings.vertexBuffers");
    });
});
