import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_LIB_DIR, ensureLibBuilt } from "./bundler-harness";

beforeAll(ensureLibBuilt, 300_000);

function built(relativePath: string): string {
    return readFileSync(join(BUILD_LIB_DIR, relativePath), "utf8");
}

describe("shadow receiver algorithm isolation", () => {
    it.each(["material/standard/fragments/std-shadow-fragment.js", "material/pbr/fragments/pbr-shadow-fragment.js"])(
        "keeps fallback core and algorithm implementations out of %s",
        (modulePath) => {
            const code = built(modulePath);
            expect(code).toContain("shadow-fragment-builder.js");
            expect(code).not.toContain("shadow-fragment-core.js");
            expect(code).not.toContain("shadow-fragment-esm.js");
            expect(code).not.toContain("shadow-fragment-pcf.js");
            expect(code).not.toContain("computeShadowESM");
            expect(code).not.toContain("computeShadowPCF");
        }
    );
    it("loads each fallback algorithm through a separate dynamic edge", () => {
        const algorithms = built("shader/fragments/shadow-algorithms.js");
        expect(algorithms).toContain('import("./shadow-fragment-esm.js")');
        expect(algorithms).toContain('import("./shadow-fragment-pcf.js")');
    });

    it("prepares Node sampling without its combined entry or Standard/PBR assembly", () => {
        const material = built("material/node/node-material.js");
        const emitter = built("material/node/node-shadow-emitter.js");
        expect(material).toContain('import("./node-shadow-emitter.js")');
        expect(material).not.toContain('import("./node-shadow.js")');
        expect(emitter).toContain("shadow-algorithms.js");
        expect(emitter).not.toContain("shadow-fragment-builder.js");
        expect(emitter).not.toContain("computeShadowPCF");
        expect(emitter).not.toContain("computeShadowESM");
    });

    it("keeps ESM and PCF WGSL codegen in separate leaf modules", () => {
        const esm = built("shader/fragments/shadow-fragment-esm.js");
        const pcf = built("shader/fragments/shadow-fragment-pcf.js");
        expect(esm).toContain("computeShadowESM");
        expect(esm).not.toContain("computeShadowPCF");
        expect(pcf).toContain("computeShadowPCF");
        expect(pcf).not.toContain("computeShadowESM");
    });
});
