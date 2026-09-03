import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { ensureLibBuilt, LIB_ENTRY } from "./bundler-harness";

beforeAll(ensureLibBuilt, 300_000);

function emittedJavaScriptFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? emittedJavaScriptFiles(path) : entry.name.endsWith(".js") ? [path] : [];
    });
}

describe("tagged WGSL package output", () => {
    it("ships minified picking WGSL without the identity tag", () => {
        const code = readFileSync(resolve(dirname(LIB_ENTRY), "picking/picking-shader.js"), "utf8");

        expect(code).not.toContain("shader/wgsl.js");
        expect(code).not.toContain("wgsl`");
        expect(code).not.toContain("struct PickDiscardInput {");
        expect(code).toContain("struct PickDiscardInput{worldPos:vec3f");
        expect(code).toContain("${projection.regularBody} let wp=projectedWorld;");
    });

    it("removes the identity-tag import from every emitted module", () => {
        const libDirectory = dirname(LIB_ENTRY);
        const offenders = emittedJavaScriptFiles(libDirectory)
            .filter((file) => readFileSync(file, "utf8").includes("shader/wgsl.js"))
            .map((file) => relative(libDirectory, file));

        expect(offenders).toEqual([]);
    });
});
