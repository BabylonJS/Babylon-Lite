import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("published compat package", () => {
    it("requires the first Babylon Lite release with vector slerp support", () => {
        const packageJsonPath = fileURLToPath(new URL("../dist/package.json", import.meta.url));
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { peerDependencies?: Record<string, string> };

        expect(packageJson.peerDependencies?.["@babylonjs/lite"]).toBe(">=1.41.0");
    });
});
